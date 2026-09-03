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
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.floor_part import FloorPrintStopReason
from backend.app.models.print_log import PrintLogEntry
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
    # Canonical Production code when this finished job maps unambiguously to
    # one configured part. Used by Harvest to choose sticker vs KNB/BUT bin.
    part_code: str | None = None


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
    recent_stopped_print: RecentStoppedPrint | None


@dataclass(frozen=True)
class RecentStoppedPrint:
    """The latest stopped or failed run still recent enough to classify."""

    print_log_id: int
    archive_id: int | None
    print_name: str | None
    part_code: str | None
    status: str
    stopped_at: datetime
    reason_code: str | None = None
    reason_text: str | None = None


@dataclass(frozen=True)
class FloorStopReasonRecord:
    """One operator-classified stopped print for the Part history feed."""

    id: int
    printer_id: int
    printer_name: str | None
    archive_id: int | None
    print_name: str | None
    part_code: str | None
    reason_code: str
    reason_text: str | None
    stopped_at: datetime


FLOOR_STOP_REASON_CODES = (
    "first_layer_issue",
    "warping",
    "layer_lines",
    "filament_issue",
    "other",
)
# Human labels for Stats 2 / print-log (match floor UI English fallbacks).
# Storage still uses the snake_case codes above; only the display string changes.
_FLOOR_STOP_REASON_LABELS = {
    "first_layer_issue": "First layer issue",
    "warping": "Warping",
    "layer_lines": "Layer lines",
    "filament_issue": "Filament issue",
    "other": "Other",
}
RECENT_STOP_LOOKBACK = timedelta(hours=6)
# PrintLogEntry.failure_reason / PrintArchive.failure_reason column width.
_FAILURE_REASON_MAX_LEN = 100


def format_floor_stop_reason(reason_code: str | None, reason_text: str | None = None) -> str:
    """Human-readable label for Stats 2 / print-log mirroring.

    Known scanner codes map to floor UI labels. ``other`` with free text keeps
    the operator's wording. Unknown codes stay as-is (may be auto-derived).
    """
    code = reason_code.strip() if isinstance(reason_code, str) and reason_code.strip() else ""
    text = reason_text.strip() if isinstance(reason_text, str) and reason_text.strip() else ""
    if not code:
        return "Unclassified"
    if code == "other" and text:
        return text[:_FAILURE_REASON_MAX_LEN]
    label = _FLOOR_STOP_REASON_LABELS.get(code, code)
    return label[:_FAILURE_REASON_MAX_LEN]


async def _mirror_floor_stop_reason_to_print_log(
    db: AsyncSession,
    print_log_id: int,
    reason_code: str,
    reason_text: str | None,
) -> None:
    """Copy the operator scanner reason onto PrintLogEntry (and archive if linked).

    Stats 2 prefers FloorPrintStopReason when present; mirroring keeps Failure
    Analysis / print-log views in sync and backfills empty auto-derived reasons.
    Re-classifying also clears a prior Part-history discard so the run counts
    again in Stats 2.
    """
    entry = await db.get(PrintLogEntry, print_log_id)
    if entry is None:
        return
    label = format_floor_stop_reason(reason_code, reason_text)
    entry.failure_reason = label
    entry.failure_dismissed_at = None
    if entry.archive_id is not None:
        archive = await db.get(PrintArchive, entry.archive_id)
        if archive is not None:
            archive.failure_reason = label


async def _clear_mirrored_floor_stop_reason(db: AsyncSession, print_log_id: int) -> None:
    """Undo scanner mirroring and mark the run excluded from Stats 2 failures."""
    entry = await db.get(PrintLogEntry, print_log_id)
    if entry is None:
        return
    entry.failure_reason = None
    entry.failure_dismissed_at = datetime.now()
    if entry.archive_id is not None:
        archive = await db.get(PrintArchive, entry.archive_id)
        if archive is not None:
            archive.failure_reason = None


async def get_printer(db: AsyncSession, printer_id: int) -> Printer | None:
    result = await db.execute(select(Printer).where(Printer.id == printer_id))
    return result.scalar_one_or_none()


async def _floor_part_code_for_archive(db: AsyncSession, archive_id: int | None) -> str | None:
    """Resolve a production code, falling back to an unambiguous title code."""
    from backend.app.services.floor_parts import _part_code_for_archive, _section_part_for_archive

    production_code = await _part_code_for_archive(db, archive_id)
    if production_code is not None:
        return production_code
    section_code, _ = await _section_part_for_archive(db, archive_id)
    return section_code


async def get_recent_stopped_print(db: AsyncSession, printer_id: int) -> RecentStoppedPrint | None:
    """Find a just-stopped or failed run that can still be classified at the printer."""
    cutoff = datetime.now() - RECENT_STOP_LOOKBACK
    result = await db.execute(
        select(PrintLogEntry)
        .where(
            PrintLogEntry.printer_id == printer_id,
            PrintLogEntry.status.in_(("stopped", "cancelled", "failed")),
            PrintLogEntry.created_at >= cutoff,
        )
        .order_by(PrintLogEntry.created_at.desc(), PrintLogEntry.id.desc())
        .limit(1)
    )
    entry = result.scalars().first()
    if entry is None:
        return None

    # A newer print supersedes the stop prompt. The operator should only be
    # asked to classify the most recent run, never an older failure after a
    # new job has already started (or finished).
    latest_result = await db.execute(
        select(PrintLogEntry)
        .where(PrintLogEntry.printer_id == printer_id)
        .order_by(PrintLogEntry.created_at.desc(), PrintLogEntry.id.desc())
        .limit(1)
    )
    latest_entry = latest_result.scalars().first()
    if latest_entry is not None and (
        latest_entry.created_at > entry.created_at
        or (latest_entry.created_at == entry.created_at and latest_entry.id > entry.id)
    ):
        return None

    recorded = await db.scalar(select(FloorPrintStopReason).where(FloorPrintStopReason.print_log_id == entry.id))
    return RecentStoppedPrint(
        print_log_id=entry.id,
        archive_id=entry.archive_id,
        print_name=entry.print_name,
        part_code=recorded.part_code if recorded else await _floor_part_code_for_archive(db, entry.archive_id),
        status=entry.status,
        stopped_at=entry.completed_at or entry.created_at,
        reason_code=recorded.reason_code if recorded else None,
        reason_text=recorded.reason_text if recorded else None,
    )


def _normalize_floor_stop_reason(reason_code: str, reason_text: str | None) -> tuple[str, str | None]:
    if reason_code not in FLOOR_STOP_REASON_CODES:
        raise ValueError(f"Unknown floor stop reason: {reason_code!r}")
    normalized_text = reason_text.strip() if reason_text and reason_text.strip() else None
    if reason_code == "other" and not normalized_text:
        raise ValueError("reason_text is required for the other floor stop reason")
    return reason_code, normalized_text


async def record_floor_stop_reason(
    db: AsyncSession,
    printer_id: int,
    reason_code: str,
    reason_text: str | None = None,
) -> RecentStoppedPrint:
    """Persist a classification for the printer's latest recent stoppage or failure."""
    reason_code, normalized_text = _normalize_floor_stop_reason(reason_code, reason_text)

    recent = await get_recent_stopped_print(db, printer_id)
    if recent is None:
        raise LookupError("No recent stopped or failed print found for this printer")
    if recent.reason_code is not None:
        return recent

    record = FloorPrintStopReason(
        print_log_id=recent.print_log_id,
        printer_id=printer_id,
        archive_id=recent.archive_id,
        print_name=recent.print_name,
        part_code=await _floor_part_code_for_archive(db, recent.archive_id),
        reason_code=reason_code,
        reason_text=normalized_text,
        stopped_at=recent.stopped_at,
    )
    db.add(record)
    await db.flush()
    await _mirror_floor_stop_reason_to_print_log(db, recent.print_log_id, reason_code, normalized_text)
    return RecentStoppedPrint(
        print_log_id=recent.print_log_id,
        archive_id=recent.archive_id,
        print_name=recent.print_name,
        part_code=record.part_code,
        status=recent.status,
        stopped_at=recent.stopped_at,
        reason_code=record.reason_code,
        reason_text=record.reason_text,
    )


async def record_plate_print_failure(
    db: AsyncSession,
    archive_id: int,
    reason_code: str,
    reason_text: str | None = None,
) -> RecentStoppedPrint:
    """Classify a completed unlabeled plate as failed and hide it from the backlog.

    Used when a job finished successfully but the parts are scrap — operators
    report the failure without labeling stickers. Writes ``FloorPrintStopReason``
    (same failure log as stopped/cancelled/failed runs), dismisses the plate
    from the unlabeled linking backlog, and clears ``awaiting_plate_clear``.
    """
    from backend.app.models.floor_bin import FloorBinBatch
    from backend.app.services.floor_parts import dismiss_build_plate, has_labeled_parts_for_archive

    reason_code, normalized_text = _normalize_floor_stop_reason(reason_code, reason_text)

    archive = await db.get(PrintArchive, archive_id)
    if archive is None or archive.status != "completed":
        raise LookupError("Completed build plate not found")
    if archive.printer_id is None:
        raise LookupError("Completed build plate has no printer")
    if await has_labeled_parts_for_archive(db, archive_id):
        raise ValueError("Build plate already has labeled parts")
    bin_batch = await db.scalar(select(FloorBinBatch.id).where(FloorBinBatch.archive_id == archive_id).limit(1))
    if bin_batch is not None:
        raise ValueError("Build plate already has a bin harvest")

    log_entry = (
        (
            await db.execute(
                select(PrintLogEntry)
                .where(PrintLogEntry.archive_id == archive_id)
                .order_by(PrintLogEntry.created_at.desc(), PrintLogEntry.id.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    if log_entry is None:
        raise LookupError("No print log entry found for this build plate")

    existing = await db.scalar(select(FloorPrintStopReason).where(FloorPrintStopReason.print_log_id == log_entry.id))
    if existing is not None:
        await dismiss_build_plate(db, archive_id)
        result = RecentStoppedPrint(
            print_log_id=existing.print_log_id,
            archive_id=existing.archive_id,
            print_name=existing.print_name,
            part_code=existing.part_code,
            status="failed",
            stopped_at=existing.stopped_at,
            reason_code=existing.reason_code,
            reason_text=existing.reason_text,
        )
    else:
        print_name = archive.print_name or archive.filename
        stopped_at = archive.completed_at or log_entry.completed_at or log_entry.created_at
        record = FloorPrintStopReason(
            print_log_id=log_entry.id,
            printer_id=archive.printer_id,
            archive_id=archive.id,
            print_name=print_name,
            part_code=await _floor_part_code_for_archive(db, archive.id),
            reason_code=reason_code,
            reason_text=normalized_text,
            stopped_at=stopped_at,
        )
        db.add(record)
        await db.flush()
        await _mirror_floor_stop_reason_to_print_log(db, log_entry.id, reason_code, normalized_text)
        await dismiss_build_plate(db, archive_id)
        result = RecentStoppedPrint(
            print_log_id=record.print_log_id,
            archive_id=record.archive_id,
            print_name=record.print_name,
            part_code=record.part_code,
            status="failed",
            stopped_at=record.stopped_at,
            reason_code=record.reason_code,
            reason_text=record.reason_text,
        )

    # Clear awaiting_plate_clear so the bed is not stuck after scrap
    # (same flag the office Clear Bed action releases).
    try:
        from backend.app.services.plate_turnaround import record_plate_clear_confirmed
        from backend.app.services.printer_manager import printer_manager

        printer_manager.set_awaiting_plate_clear(archive.printer_id, False)
        await record_plate_clear_confirmed(archive.printer_id)
    except Exception:
        logger.exception(
            "Failed to clear awaiting_plate_clear after plate failure for printer %s",
            archive.printer_id,
        )

    return result


async def record_printer_plate_failure(
    db: AsyncSession,
    printer_id: int,
    reason_code: str,
    reason_text: str | None = None,
) -> RecentStoppedPrint:
    """Classify the printer's latest finished unlabeled plate as failed.

    Clears ``awaiting_plate_clear`` via ``record_plate_print_failure``.
    """
    last = await get_last_finished_print(db, printer_id)
    if last is None:
        raise LookupError("No finished print found for this printer")
    if last.has_labeled_parts:
        raise ValueError("Build plate already has labeled parts")

    return await record_plate_print_failure(db, last.archive_id, reason_code, reason_text)


async def list_floor_stop_reasons(db: AsyncSession, limit: int = 20) -> list[FloorStopReasonRecord]:
    """Newest operator-classified print failures for the Part history page."""
    rows = (
        await db.execute(
            select(FloorPrintStopReason, Printer.name)
            .outerjoin(Printer, Printer.id == FloorPrintStopReason.printer_id)
            .order_by(FloorPrintStopReason.stopped_at.desc(), FloorPrintStopReason.id.desc())
            .limit(limit)
        )
    ).all()
    return [
        FloorStopReasonRecord(
            id=record.id,
            printer_id=record.printer_id,
            printer_name=printer_name,
            archive_id=record.archive_id,
            print_name=record.print_name,
            part_code=record.part_code,
            reason_code=record.reason_code,
            reason_text=record.reason_text,
            stopped_at=record.stopped_at,
        )
        for record, printer_name in rows
    ]


async def update_floor_stop_reason(
    db: AsyncSession,
    reason_id: int,
    reason_code: str,
    reason_text: str | None = None,
) -> FloorStopReasonRecord | None:
    """Update an operator-classified stop/failure reason from Part history."""
    if reason_code not in FLOOR_STOP_REASON_CODES:
        raise ValueError(f"Unknown floor stop reason: {reason_code!r}")
    normalized_text = reason_text.strip() if reason_text and reason_text.strip() else None
    if reason_code == "other" and not normalized_text:
        raise ValueError("reason_text is required for the other floor stop reason")

    record = await db.get(FloorPrintStopReason, reason_id)
    if record is None:
        return None
    record.reason_code = reason_code
    record.reason_text = normalized_text
    await db.flush()
    await _mirror_floor_stop_reason_to_print_log(db, record.print_log_id, reason_code, normalized_text)
    row = (
        await db.execute(
            select(FloorPrintStopReason, Printer.name)
            .outerjoin(Printer, Printer.id == FloorPrintStopReason.printer_id)
            .where(FloorPrintStopReason.id == reason_id)
        )
    ).one()
    updated, printer_name = row
    return FloorStopReasonRecord(
        id=updated.id,
        printer_id=updated.printer_id,
        printer_name=printer_name,
        archive_id=updated.archive_id,
        print_name=updated.print_name,
        part_code=updated.part_code,
        reason_code=updated.reason_code,
        reason_text=updated.reason_text,
        stopped_at=updated.stopped_at,
    )


async def delete_floor_stop_reason(db: AsyncSession, reason_id: int) -> bool:
    """Remove an operator-classified stop/failure reason.

    Also excludes the underlying print-log run from Stats 2 quality / reliability
    failure counts (Part history discard = not a tracked failure anymore).
    """
    record = await db.get(FloorPrintStopReason, reason_id)
    if record is None:
        return False
    print_log_id = record.print_log_id
    await db.delete(record)
    await db.flush()
    await _clear_mirrored_floor_stop_reason(db, print_log_id)
    await db.flush()
    return True


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

    return _archive_summary(
        archive,
        has_labeled_parts=await has_labeled_parts_for_archive(db, archive.id),
        part_code=await _floor_part_code_for_archive(db, archive.id),
    )


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
    return _archive_summary(archive, part_code=await _floor_part_code_for_archive(db, archive.id))


def _archive_summary(
    archive: PrintArchive,
    *,
    has_labeled_parts: bool = False,
    part_code: str | None = None,
) -> LastPrint:
    return LastPrint(
        archive_id=archive.id,
        print_name=archive.print_name or archive.filename,
        completed_at=archive.completed_at,
        quantity=archive.quantity or 1,
        has_labeled_parts=has_labeled_parts,
        part_code=part_code,
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

    live = get_live_status(printer_id)
    recent_stopped_print = await get_recent_stopped_print(db, printer_id)
    if live is not None and live.state.upper() in {"RUNNING", "PREPARE", "SLICING"}:
        recent_stopped_print = None

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
        live=live,
        recent_stopped_print=recent_stopped_print,
    )


__all__ = [
    "PRINTER_PREFIX",
    "printer_payload",
    "printer_id_for_payload",
    "LastPrint",
    "LiveStatus",
    "PrinterInfo",
    "RecentStoppedPrint",
    "FloorStopReasonRecord",
    "FLOOR_STOP_REASON_CODES",
    "format_floor_stop_reason",
    "get_live_status",
    "get_printer",
    "get_recent_stopped_print",
    "record_floor_stop_reason",
    "record_plate_print_failure",
    "record_printer_plate_failure",
    "list_floor_stop_reasons",
    "update_floor_stop_reason",
    "delete_floor_stop_reason",
    "list_printers_for_labels",
    "get_last_finished_print",
    "get_archive_summary",
    "get_printer_info",
]
