"""Printer codes and the printer info page (docs/floor-plan.md §5.6, §7).

Two concerns, sharing the one thing that must not drift — the exact `BBP-`
payload a printer's QR encodes:

- **Payload identity.** ``BBP-{printer_id}``, per §4. The database id rather
  than the serial: ids are short, which matters for QR density on a 40 mm
  label, and they are what every other route already keys on. The cost is
  that deleting and re-adding a printer issues a new id, orphaning any label
  already stuck to the machine — a re-print, not data loss, and rare enough
  to be the right trade.
- **The info page.** What an operator sees when they scan a printer with no
  station open: what this machine is doing, and whether it needs anything.

Nothing here computes maintenance or hours itself. Both come from the
existing maintenance routes, deliberately: ``get_printer_total_hours``
counts RUNNING time only (excluding paused time, #1521), and reproducing
that rule would give the floor a second, quietly different number from the
one the maintenance page shows.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.printer import Printer

logger = logging.getLogger(__name__)

# Prefix for every printer QR (§4). The scan router keys off this to tell a
# printer scan apart from station (`BBS-`) and part (`BBD-`) codes.
PRINTER_PREFIX = "BBP-"


def printer_payload(printer_id: int) -> str:
    """The exact string this printer's QR encodes."""
    return f"{PRINTER_PREFIX}{printer_id}"


def printer_id_for_payload(payload: str) -> int | None:
    """Resolve a scanned string to a printer id, or ``None`` if it isn't one.

    Tolerates surrounding whitespace for the same reason station lookup does:
    a pistol's configured suffix can append it, and a stray space must not
    turn a good label into an unknown code.
    """
    value = payload.strip()
    if not value.startswith(PRINTER_PREFIX):
        return None
    raw = value[len(PRINTER_PREFIX) :]
    # Reject anything that is not a plain positive integer. `BBP-12x` and
    # `BBP--1` are damaged scans, not printers, and guessing at them risks
    # opening the wrong machine.
    if not raw.isdigit():
        return None
    parsed = int(raw)
    return parsed if parsed > 0 else None


@dataclass(frozen=True)
class LiveStatus:
    """What the machine is doing right now, from the MQTT connection.

    Separate from the database fields because it is *live* and may be
    unavailable: a printer that is off, unplugged or unreachable simply has
    no client, and saying "not connected" is more honest than implying idle.
    """

    connected: bool
    # Raw gcode state — RUNNING / IDLE / PAUSE / FINISH / FAILED / PREPARE /
    # SLICING, or "unknown" before the first MQTT message lands. Passed
    # through rather than mapped to friendlier words here, so the floor shows
    # the same vocabulary as the rest of the app.
    state: str
    current_print: str | None
    progress: float
    remaining_minutes: int
    layer_num: int
    total_layers: int


@dataclass(frozen=True)
class LastPrint:
    """The printer's most recent finished job — the harvest candidate."""

    archive_id: int
    print_name: str | None
    completed_at: datetime | None
    quantity: int
    # Whether any part sticker has been linked to this job yet. Filled in by
    # `get_last_finished_print` from `floor_labeled_parts` (phase 8); defaults
    # to False here so `get_archive_summary`'s callers, which already know
    # the part in question and would discard the field, don't pay for the
    # query (see that function's docstring).
    has_labeled_parts: bool = False


@dataclass(frozen=True)
class PrinterInfo:
    """Everything the info page shows about one printer (§5.6)."""

    id: int
    name: str
    model: str | None
    location: str | None
    serial_number: str
    payload: str
    is_active: bool
    # True when a finished job is sitting on the bed waiting to be cleared —
    # which is exactly "there is something here to harvest".
    awaiting_plate_clear: bool
    total_print_hours: float
    last_print: LastPrint | None
    maintenance_due_count: int
    maintenance_warning_count: int
    # None when the printer has no MQTT client at all — never connected this
    # run, or removed. Distinct from `connected: False`, which means we know
    # about it and it is unreachable.
    live: LiveStatus | None


async def get_printer(db: AsyncSession, printer_id: int) -> Printer | None:
    result = await db.execute(select(Printer).where(Printer.id == printer_id))
    return result.scalar_one_or_none()


async def list_printers_for_labels(db: AsyncSession) -> list[Printer]:
    """Printers offered in the Codes page's Printer-labels tab.

    Inactive printers are included: a machine temporarily disabled in the app
    is still physically on the floor and still wants a label on it. Ordered
    by name so the printed sheet matches the on-screen list.
    """
    result = await db.execute(select(Printer).order_by(Printer.name))
    return list(result.scalars())


async def get_last_finished_print(db: AsyncSession, printer_id: int) -> LastPrint | None:
    """The printer's most recent completed archive, or None.

    Ordered by ``completed_at`` rather than ``id``: archives can be written
    out of order (a backfill, a late cloud sync), and the operator standing
    at the machine means the job that finished last, not the row inserted
    last.
    """
    result = await db.execute(
        select(PrintArchive)
        .where(
            PrintArchive.printer_id == printer_id,
            PrintArchive.status == "completed",
        )
        .order_by(PrintArchive.completed_at.desc().nullslast(), PrintArchive.id.desc())
        .limit(1)
    )
    archive = result.scalars().first()
    if archive is None:
        return None

    # Deferred import: `floor_parts` imports this module for printer/archive
    # resolution, so a module-level import here would be circular. Mirrors
    # the deferred imports below for the maintenance overview and live MQTT
    # status, for the same reason.
    from backend.app.services.floor_parts import has_labeled_parts_for_archive

    return _archive_summary(archive, has_labeled_parts=await has_labeled_parts_for_archive(db, archive.id))


async def get_archive_summary(db: AsyncSession, archive_id: int) -> LastPrint | None:
    """The summary fields for one specific archive, by id.

    Distinct from :func:`get_last_finished_print`, which asks "what is this
    printer's *latest* finished job right now". Phase 8 needs this instead
    when it displays a plate that was bound earlier (closing a harvest plate,
    or showing an already-labeled part's link): the archive that was bound at
    scan time, not whatever happens to be latest by the time the response is
    built. In practice these can never disagree while a harvest plate is open
    (§5.4: a printer cannot finish a second job while `awaiting_plate_clear`
    is true), but reaching for the specific row rather than re-deriving
    "latest" keeps that true by construction instead of by the docs.

    ``has_labeled_parts`` is left at its default (False) here rather than
    queried: every phase 8 caller of this function already knows the part in
    question (that is why it is asking), so the field would be discarded —
    querying it anyway would cost a scan-time round trip for nothing on the
    harvest screen's hot path.
    """
    result = await db.execute(select(PrintArchive).where(PrintArchive.id == archive_id))
    archive = result.scalar_one_or_none()
    if archive is None:
        return None
    return _archive_summary(archive)


def _archive_summary(archive: PrintArchive, *, has_labeled_parts: bool = False) -> LastPrint:
    return LastPrint(
        archive_id=archive.id,
        print_name=archive.print_name or archive.filename,
        completed_at=archive.completed_at,
        quantity=archive.quantity or 1,
        has_labeled_parts=has_labeled_parts,
    )


def get_live_status(printer_id: int) -> LiveStatus | None:
    """Current MQTT state for a printer, or None if it has no client.

    Never raises: an operator scanning a printer to see its last job should
    not get an error page because the MQTT layer is unhappy. A missing live
    status degrades the panel, it does not break it.
    """
    try:
        from backend.app.services.printer_manager import printer_manager

        state = printer_manager.get_status(printer_id)
        if state is None:
            return None
        return LiveStatus(
            connected=bool(state.connected),
            state=state.state or "unknown",
            # subtask_name is the human job name where the firmware provides
            # one; current_print is the raw file. Prefer the readable one.
            current_print=state.subtask_name or state.current_print,
            progress=float(state.progress or 0.0),
            # Minutes, straight from the firmware's `mc_remaining_time`. Named
            # explicitly here because the field name does not say so, and
            # every other consumer treats it as minutes (QueueTimelineView
            # multiplies by 60_000 for ms; CameraWall calls it remainingMin).
            remaining_minutes=int(state.remaining_time or 0),
            layer_num=int(state.layer_num or 0),
            total_layers=int(state.total_layers or 0),
        )
    except Exception:
        logger.warning("Live status unavailable for printer %s", printer_id, exc_info=True)
        return None


async def get_printer_info(db: AsyncSession, printer_id: int) -> PrinterInfo | None:
    """Compose the info page for one printer (§5.6).

    Hours and maintenance counts are read through the maintenance routes so
    the floor and the maintenance page can never disagree.
    """
    printer = await get_printer(db, printer_id)
    if printer is None:
        return None

    # Imported here rather than at module scope: the maintenance route module
    # imports service modules of its own, and a top-level import would make
    # the two mutually dependent at import time.
    from backend.app.api.routes.maintenance import (
        _get_printer_maintenance_internal,
        get_printer_total_hours,
    )

    total_hours = await get_printer_total_hours(db, printer_id)

    due_count = 0
    warning_count = 0
    try:
        overview = await _get_printer_maintenance_internal(printer_id, db, commit=False)
        # Both counts come straight off the overview rather than being
        # recomputed here — the "within 10% of interval" warning rule lives in
        # one place, and a second copy would drift the first time it changed.
        due_count = overview.due_count
        warning_count = overview.warning_count
    except Exception:
        # Maintenance is supplementary here. An operator scanning a printer to
        # see its last job should not get an error page because the
        # maintenance overview failed to build.
        logger.warning("Maintenance overview failed for printer %s", printer_id, exc_info=True)

    return PrinterInfo(
        id=printer.id,
        name=printer.name,
        model=printer.model,
        location=printer.location,
        serial_number=printer.serial_number,
        payload=printer_payload(printer.id),
        is_active=printer.is_active,
        awaiting_plate_clear=printer.awaiting_plate_clear,
        total_print_hours=total_hours,
        last_print=await get_last_finished_print(db, printer_id),
        maintenance_due_count=due_count,
        maintenance_warning_count=warning_count,
        live=get_live_status(printer_id),
    )


__all__ = [
    "PRINTER_PREFIX",
    "printer_payload",
    "printer_id_for_payload",
    "LastPrint",
    "LiveStatus",
    "PrinterInfo",
    "get_live_status",
    "get_printer",
    "list_printers_for_labels",
    "get_last_finished_print",
    "get_archive_summary",
    "get_printer_info",
]
