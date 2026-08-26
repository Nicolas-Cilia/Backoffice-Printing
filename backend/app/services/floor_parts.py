"""Labeled parts: sticker codes, harvest binding, and part-scan resolution.

Phase 8 of ``docs/floor-plan.md`` (§5.4 Harvest, §5.6 printer scan, §7 part
identity/record, §9 mis-scans). Three concerns share this module because
they share the one table they all read and write — ``floor_labeled_parts``:

- **Sticker identity.** ``BBD-{6 digits}``, per §7.1. Normalize = strip +
  uppercase; validate = exactly that shape. Mirrors ``floor_printers``'s
  ``printer_id_for_payload`` in spirit — tolerate a pistol's stray
  whitespace, refuse anything else outright.
- **The harvest lock's two entry points.** §5.4 is explicit that both are
  first-class: scanning the Harvest station then a printer, or scanning a
  printer straight from idle and then a part. Both have to resolve a
  printer's archive **once, at bind time**, and land on the same result —
  that resolution lives here, once, so the two entry points cannot drift.
- **Part-scan resolution.** The state machine in §9's mis-scan table:
  malformed codes, already-enrolled stickers (job link is immutable — never
  relink), no session, no plate, no job found, and the wrong-station case
  where harvest silently ignores a code rather than writing against it.

What lives in ``floor_sessions.py`` instead: the actual session-row mechanics
(open/close/switch, the floor-wide lock, the race-safe insert). This module
calls into that one for all of it — see ``floor_sessions.bind_plate`` and
``claim_exclusive_station`` — rather than duplicating the partial-unique-index
+ ``IntegrityError`` handling that already lives there and is exercised by
phase 1b's tests.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.floor_part import FloorDismissedBuildPlate, FloorLabeledPart, FloorPartEvent
from backend.app.models.floor_session import FloorStationSession
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services.floor_codes import station_for_slug
from backend.app.services.floor_printers import (
    LastPrint,
    get_archive_summary,
    get_last_finished_print,
    get_printer,
    printer_id_for_payload,
)
from backend.app.services.floor_sessions import (
    ScanResult,
    bind_plate,
    claim_exclusive_station,
    get_open_session_for_device,
    get_open_session_for_station,
)

logger = logging.getLogger(__name__)

# Prefix for every part sticker's payload (§4). Bought roll, not printed —
# unlike station/printer QRs, these do not come from this app's own label
# renderer.
PART_PREFIX = "BBD-"
_CODE_DIGIT_LEN = 6

# The Harvest station's slug in the catalog (`floor_codes.FLOOR_STATIONS`).
# Not re-derived from a payload anywhere in this module — harvest is reached
# here either via an existing session's `station_slug` or by opening it
# directly (entry #2), never by parsing a `BBS-harvest` scan, so there is no
# payload to resolve it from in the first place.
HARVEST_STATION_SLUG = "harvest"

# Fit Check and Sanding are locations, not stations (§5.4a/§5.4b) — nothing
# ever opens a session for them (`floor_codes.FloorStation.category ==
# "location"`, enforced in the `/floor/session/scan` route). These slugs are
# only used to label which location a scan-part-then-location flow landed
# on; there is no session to key them against.
FIT_CHECK_LOCATION_SLUG = "fit-check"
SANDING_LOCATION_SLUG = "sanding"


# ── Sticker codes (§7.1) ──────────────────────────────────────────────────


def normalize_sticker_code(raw: str) -> str:
    """Strip + uppercase, per §7.2's data model note. Applied before both
    validation and lookup so a pistol's stray whitespace or case never turns
    an enrolled sticker into a fresh one."""
    return raw.strip().upper()


def parse_sticker_code(payload: str) -> str | None:
    """Validate + normalize a `BBD-` payload, or ``None`` if malformed (§7.1).

    Exactly `BBD-` followed by 6 digits — `BBD-000000` through `BBD-999999`.
    Anything else (wrong prefix, wrong digit count, non-digit characters) is
    a mis-scan (§9): the caller returns `invalid_code` and writes nothing,
    the same "error flash, no state change" contract as an unknown station
    or printer code.
    """
    code = normalize_sticker_code(payload)
    if not code.startswith(PART_PREFIX):
        return None
    digits = code[len(PART_PREFIX) :]
    if len(digits) != _CODE_DIGIT_LEN or not digits.isdigit():
        return None
    return code


# ── Harvest printer binding (§5.4) ────────────────────────────────────────


class HarvestPrinterResult(StrEnum):
    """What a `BBP-` scan did against an open harvest session."""

    BOUND = "bound"
    REBOUND = "rebound"
    PLATE_CLOSED = "plate_closed"
    LOCKED = "locked"
    UNKNOWN_PRINTER = "unknown_printer"
    NO_SESSION = "no_session"


@dataclass(frozen=True)
class HarvestPrinterOutcome:
    """The result of applying one `BBP-` scan at the Harvest station."""

    result: HarvestPrinterResult
    session: FloorStationSession | None = None
    printer: Printer | None = None
    archive: LastPrint | None = None
    # Parts labeled against the plate this scan bound to, rebound to, or
    # closed. 0 for bound/rebound (a fresh plate has no parts yet); the
    # closing plate's final count for plate_closed.
    part_count: int = 0
    # Populated only on the (structurally near-unreachable) LOCKED path.
    blocking: FloorStationSession | None = None


async def _count_plate_parts(db: AsyncSession, session_id: int, printer_id: int) -> int:
    """Parts labeled against one plate — same session, same bound printer.

    Not "parts on this archive": a printer with no finished job still has a
    plate (and a count) even though every part on it is `no_job` (§7.2).
    """
    result = await db.execute(
        select(func.count())
        .select_from(FloorLabeledPart)
        .where(FloorLabeledPart.session_id == session_id, FloorLabeledPart.printer_id == printer_id)
    )
    return int(result.scalar_one() or 0)


async def scan_harvest_printer(db: AsyncSession, device_id: str, payload: str) -> HarvestPrinterOutcome:
    """Apply one `BBP-` scan for a device that holds an open harvest session.

    Requires the session to already exist and be Harvest's — the caller (the
    `/floor/harvest/printer` route) only reaches a device in that state, per
    the contract: a device with no harvest session should not be calling
    this endpoint, and `no_session` is a clean way to say so rather than an
    error.
    """
    session = await get_open_session_for_device(db, device_id)
    if session is None or session.station_slug != HARVEST_STATION_SLUG:
        return HarvestPrinterOutcome(result=HarvestPrinterResult.NO_SESSION)

    printer_id = printer_id_for_payload(payload)
    printer = await get_printer(db, printer_id) if printer_id is not None else None
    if printer is None:
        return HarvestPrinterOutcome(result=HarvestPrinterResult.UNKNOWN_PRINTER, session=session)

    # Defensive only: this device already holds harvest (checked above), and
    # the floor-wide lock means no other open harvest session can exist. The
    # contract calls this path "reserved for completeness" and asks for a
    # clean result rather than a crash if that invariant is ever violated —
    # e.g. a concurrent takeover landing between the check above and here.
    blocking = await get_open_session_for_station(db, HARVEST_STATION_SLUG)
    if blocking is not None and blocking.device_id != device_id:
        return HarvestPrinterOutcome(result=HarvestPrinterResult.LOCKED, session=session, blocking=blocking)

    if session.bound_printer_id is None:
        # No plate open — bind to this printer's latest finished job.
        last_print = await get_last_finished_print(db, printer_id)
        await bind_plate(
            db,
            session,
            printer_id=printer_id,
            archive_id=last_print.archive_id if last_print else None,
        )
        return HarvestPrinterOutcome(
            result=HarvestPrinterResult.BOUND,
            session=session,
            printer=printer,
            archive=last_print,
            part_count=0,
        )

    if session.bound_printer_id == printer_id:
        # Same printer re-scanned — close the plate. Per §5.4, within one
        # open harvest session a printer's "latest finished job" cannot
        # change (it cannot finish a second job while awaiting_plate_clear
        # is true), so this can only ever be a close, never a reopen against
        # a newer plate.
        part_count = await _count_plate_parts(db, session.id, printer_id)
        archive = await get_archive_summary(db, session.bound_archive_id) if session.bound_archive_id else None
        await bind_plate(db, session, printer_id=None, archive_id=None)
        return HarvestPrinterOutcome(
            result=HarvestPrinterResult.PLATE_CLOSED,
            session=session,
            printer=printer,
            archive=archive,
            part_count=part_count,
        )

    # A different printer — close this plate, open that one.
    last_print = await get_last_finished_print(db, printer_id)
    await bind_plate(
        db,
        session,
        printer_id=printer_id,
        archive_id=last_print.archive_id if last_print else None,
    )
    return HarvestPrinterOutcome(
        result=HarvestPrinterResult.REBOUND,
        session=session,
        printer=printer,
        archive=last_print,
        part_count=0,
    )


# ── Part scans (§7, §9) ────────────────────────────────────────────────────


class PartScanResult(StrEnum):
    """What a `BBD-` scan did."""

    LABELED = "labeled"
    NO_JOB = "no_job"
    DUPLICATE = "duplicate"
    LOCKED = "locked"
    NO_PRINTER = "no_printer"
    INVALID_CODE = "invalid_code"


@dataclass(frozen=True)
class PartScanOutcome:
    """The result of applying one `BBD-` scan."""

    result: PartScanResult
    part: FloorLabeledPart | None = None
    printer: Printer | None = None
    archive: LastPrint | None = None
    part_count: int = 0
    session: FloorStationSession | None = None
    blocking: FloorStationSession | None = None


async def _get_part_by_code(db: AsyncSession, code: str) -> FloorLabeledPart | None:
    result = await db.execute(select(FloorLabeledPart).where(FloorLabeledPart.sticker_code == code))
    return result.scalar_one_or_none()


async def scan_part(
    db: AsyncSession,
    device_id: str,
    payload: str,
    printer_id_hint: int | None = None,
) -> PartScanOutcome:
    """Apply one `BBD-` scan, per the §9 resolution order.

    ``printer_id_hint`` is the printer info page's entry point (§5.4 entry
    #2) — used *only* when this device holds no open harvest session yet.
    Once a session exists (bound or not), the hint is ignored: the session
    already says what plate is open, and a stale hint from an earlier page
    load must not override it.
    """
    code = parse_sticker_code(payload)
    if code is None:
        return PartScanOutcome(result=PartScanResult.INVALID_CODE)

    session = await get_open_session_for_device(db, device_id)

    existing = await _get_part_by_code(db, code)
    if existing is not None:
        # A second scan is an operator error whether the original harvest
        # resolved a job or not.  The office-side matching flow is the only
        # way to resolve an incomplete record; re-scanning must never turn a
        # later printer state into rewritten provenance.
        scan_details: dict[str, object] = {}
        if session is not None:
            scan_details["station_slug"] = session.station_slug
            if session.bound_printer_id is not None:
                scan_details["printer_id"] = session.bound_printer_id
        db.add(
            FloorPartEvent(
                part_id=existing.id,
                action="scanned",
                details=scan_details or None,
            )
        )
        await db.flush()
        return PartScanOutcome(result=PartScanResult.DUPLICATE, session=session)

    printer_id: int
    archive_id: int | None

    if session is not None and session.station_slug == HARVEST_STATION_SLUG:
        if session.bound_printer_id is None:
            # Harvest is open but no printer has been scanned yet. The
            # printer_id hint is not consulted here — see the docstring.
            return PartScanOutcome(result=PartScanResult.NO_PRINTER, session=session)
        printer_id = session.bound_printer_id
        archive_id = session.bound_archive_id

    elif session is None:
        if printer_id_hint is None:
            return PartScanOutcome(result=PartScanResult.NO_PRINTER)

        printer = await get_printer(db, printer_id_hint)
        if printer is None:
            return PartScanOutcome(result=PartScanResult.NO_PRINTER)

        # Entry #2: this scan itself claims the floor-wide harvest lock.
        station = station_for_slug(HARVEST_STATION_SLUG)
        if station is None:
            # The catalog is static and always defines Harvest; this would
            # only fire if the slug above and the catalog entry ever drifted
            # apart, which is a code bug, not a runtime data state.
            raise RuntimeError(f"Harvest station missing from the catalog (slug={HARVEST_STATION_SLUG!r})")

        last_print = await get_last_finished_print(db, printer_id_hint)
        claim = await claim_exclusive_station(
            db,
            station,
            device_id,
            bound_printer_id=printer_id_hint,
            bound_archive_id=last_print.archive_id if last_print else None,
        )
        if claim.result is ScanResult.LOCKED:
            return PartScanOutcome(result=PartScanResult.LOCKED, blocking=claim.blocking)

        session = claim.session
        printer_id = printer_id_hint
        archive_id = session.bound_archive_id

    else:
        # This device holds a session for a different station (e.g.
        # cleanup). Harvest "ignores" other codes (§5.4) — do not write a
        # part against a station that isn't harvest.
        return PartScanOutcome(result=PartScanResult.NO_PRINTER, session=session)

    part = FloorLabeledPart(sticker_code=code, printer_id=printer_id, archive_id=archive_id, session_id=session.id)
    db.add(part)
    await db.flush()
    db.add(
        FloorPartEvent(part_id=part.id, action="enrolled", details={"printer_id": printer_id, "archive_id": archive_id})
    )
    await db.flush()

    printer = await get_printer(db, printer_id)
    archive = await get_archive_summary(db, archive_id) if archive_id is not None else None
    part_count = await _count_plate_parts(db, session.id, printer_id)

    return PartScanOutcome(
        # Both write the part row (§7.2); the split is purely how the
        # screen should read it back — "linked, no job found" is not an
        # error.
        result=PartScanResult.LABELED if archive_id is not None else PartScanResult.NO_JOB,
        part=part,
        printer=printer,
        archive=archive,
        part_count=part_count,
        session=session,
    )


# ── Fit Check and Sanding (§5.4a, §5.4b) ────────────────────────────────────
#
# Neither is a station: there is no open/close/switch, no floor-wide lock,
# no session at all. The flow is scan-a-part-then-scan-a-location — "scan a
# part, scan a location, now that part is at that location" — and the
# *pending* half of that (which part is waiting for a location, or which
# part is waiting for a sanding reason) lives entirely in the scan page's
# own local state, not on the server. These two functions are the commit
# step only: by the time either is called, the caller already has every
# piece of information it needs (the sticker code, and for Sanding, the
# reason), so there is nothing here to look up beyond the part itself.


class LocationScanResult(StrEnum):
    """What a scan-part-then-location commit did."""

    RECORDED = "recorded"
    UNKNOWN_PART = "unknown_part"
    INVALID_CODE = "invalid_code"


@dataclass(frozen=True)
class LocationScanOutcome:
    """The result of committing one part to a location (Fit Check or Sanding)."""

    result: LocationScanResult
    part: FloorLabeledPart | None = None
    printer: Printer | None = None
    archive: LastPrint | None = None


async def _resolve_part_for_location(
    db: AsyncSession, payload: str
) -> tuple[LocationScanResult, FloorLabeledPart | None]:
    code = parse_sticker_code(payload)
    if code is None:
        return LocationScanResult.INVALID_CODE, None
    part = await _get_part_by_code(db, code)
    if part is None:
        # Never enrolled at Harvest — the sticker doesn't exist yet (§9).
        return LocationScanResult.UNKNOWN_PART, None
    return LocationScanResult.RECORDED, part


async def _to_location_outcome(
    db: AsyncSession, result: LocationScanResult, part: FloorLabeledPart | None
) -> LocationScanOutcome:
    if part is None:
        return LocationScanOutcome(result=result)
    printer = await get_printer(db, part.printer_id) if part.printer_id is not None else None
    archive = await get_archive_summary(db, part.archive_id) if part.archive_id is not None else None
    return LocationScanOutcome(result=result, part=part, printer=printer, archive=archive)


async def scan_fit_check_part(db: AsyncSession, payload: str) -> LocationScanOutcome:
    """Commit "part BBD-… is at Fit Check" (§5.4a, §9).

    Records only that the checkpoint happened — no pass/fail verdict, per
    the doc's reasoning that Sanding's own reason scan already covers "why"
    for the one case (doesn't fit) a verdict here would otherwise duplicate.
    Re-scanning an already-checked part is not an error: it appends another
    `fit_checked` event rather than refusing or amending, since there is no
    prior verdict to amend.
    """
    result, part = await _resolve_part_for_location(db, payload)
    if part is not None:
        db.add(FloorPartEvent(part_id=part.id, action="fit_checked"))
        await db.flush()
    return await _to_location_outcome(db, result, part)


class SandingReasonCode(StrEnum):
    """Why a part needs sanding (§5.4b), scanned as a `BBR-…` code.

    A small fixed set, the same shape as `UnlinkReasonCode` /
    `ReplaceStickerReasonCode` above — not a user-editable registry. Free
    text is always allowed alongside (required for `OTHER`), so this list
    only needs to cover the common cases well enough to be worth scanning
    instead of just always reaching for `OTHER`.
    """

    DOESNT_FIT = "doesnt_fit"
    ROUGH_SURFACE = "rough_surface"
    LAYER_LINES = "layer_lines"
    OTHER = "other"


async def scan_sanding_part(
    db: AsyncSession, payload: str, reason_code: str, reason_text: str | None = None
) -> LocationScanOutcome:
    """Commit "part BBD-… is at Sanding, because …" (§5.4b, §9).

    Unlike Fit Check, this is the *third* scan of its flow (part, then the
    Sanding location — which is a pure UI transition on the scan page, no
    server call — then this reason). Nothing commits until the reason is
    known, which is why there is no separate "part is now at Sanding, reason
    pending" server state to represent: the two facts are written together,
    in one event, or not at all.
    """
    result, part = await _resolve_part_for_location(db, payload)
    if part is not None:
        db.add(
            FloorPartEvent(
                part_id=part.id, action="sanding", details={"reason_code": reason_code, "reason_text": reason_text}
            )
        )
        await db.flush()
    return await _to_location_outcome(db, result, part)


# ── Needs-attention (§7.2, §9) ─────────────────────────────────────────────


@dataclass(frozen=True)
class NeedsAttentionPart:
    """One part with no job to show for it — the needs-attention list."""

    id: int
    sticker_code: str
    printer_id: int | None
    printer_name: str | None
    labeled_at: datetime


@dataclass(frozen=True)
class InventoryPart:
    id: int
    sticker_code: str
    printer_id: int | None
    printer_name: str | None
    archive_id: int | None
    print_name: str | None
    labeled_at: datetime
    archived_at: datetime | None
    released_at: datetime | None
    latest_event_action: str | None


@dataclass(frozen=True)
class PartEvent:
    """An audit entry displayed in a labeled part's history."""

    id: int
    action: str
    details: dict | None
    occurred_at: datetime


@dataclass(frozen=True)
class PartJobCandidate:
    """A completed job that is safe to offer for an unresolved part.

    Candidates are intentionally restricted to the printer recorded at
    harvest.  This is a convenience for resolving a missing archive link,
    not a way to turn the history view into a general job-reassignment UI.
    """

    id: int
    print_name: str
    completed_at: datetime | None


async def list_needs_attention(db: AsyncSession, *, limit: int = 50) -> tuple[list[NeedsAttentionPart], int]:
    """Parts with ``archive_id IS NULL``, newest first, plus the unbounded total.

    The total is queried separately (not ``len(parts)``) so the UI can say
    "showing 50 of 7xx" rather than just how many it happened to fetch.

    Left-joined against ``printers`` rather than inner-joined: a part
    survives its printer being deleted (``printer_id`` degrades to NULL, see
    ``FloorLabeledPart``'s docstring), and that row must still show up here
    rather than silently vanishing from the one list that would otherwise
    surface it.
    """
    total_result = await db.execute(
        select(func.count())
        .select_from(FloorLabeledPart)
        .where(FloorLabeledPart.archive_id.is_(None), FloorLabeledPart.archived_at.is_(None))
    )
    total = int(total_result.scalar_one() or 0)

    result = await db.execute(
        select(FloorLabeledPart, Printer.name)
        .outerjoin(Printer, Printer.id == FloorLabeledPart.printer_id)
        .where(FloorLabeledPart.archive_id.is_(None), FloorLabeledPart.archived_at.is_(None))
        .order_by(FloorLabeledPart.labeled_at.desc())
        .limit(limit)
    )
    parts = [
        NeedsAttentionPart(
            id=part.id,
            sticker_code=part.sticker_code,
            printer_id=part.printer_id,
            printer_name=printer_name,
            labeled_at=part.labeled_at,
        )
        for part, printer_name in result.all()
    ]
    return parts, total


async def list_unlabeled_build_plates(db: AsyncSession, *, limit: int = 50):
    """Completed jobs with no enrolled parts yet, newest first."""
    from backend.app.models.archive import PrintArchive

    cutoff = (
        await db.execute(select(Settings.value).where(Settings.key == "floor_part_tracking_started_at"))
    ).scalar_one_or_none()
    if cutoff is None:
        return []
    started_at = datetime.fromisoformat(cutoff)
    statement = (
        select(PrintArchive, Printer.name)
        .outerjoin(Printer, Printer.id == PrintArchive.printer_id)
        .outerjoin(FloorLabeledPart, FloorLabeledPart.archive_id == PrintArchive.id)
        .outerjoin(FloorDismissedBuildPlate, FloorDismissedBuildPlate.archive_id == PrintArchive.id)
        .where(
            PrintArchive.status == "completed",
            PrintArchive.completed_at >= started_at,
            FloorLabeledPart.id.is_(None),
            FloorDismissedBuildPlate.id.is_(None),
        )
        .order_by(PrintArchive.completed_at.desc().nullslast(), PrintArchive.id.desc())
    )
    rows = (await db.execute(statement.limit(limit))).all()
    return [
        {
            "id": archive.id,
            "print_name": archive.print_name or archive.filename,
            "printer_name": printer_name,
            "completed_at": archive.completed_at,
        }
        for archive, printer_name in rows
    ]


async def get_harvest_summary(db: AsyncSession, session_id: int) -> list[dict]:
    from backend.app.models.archive import PrintArchive

    rows = await db.execute(
        select(Printer.id, Printer.name, PrintArchive.print_name, func.count(FloorLabeledPart.id))
        .outerjoin(Printer, Printer.id == FloorLabeledPart.printer_id)
        .outerjoin(PrintArchive, PrintArchive.id == FloorLabeledPart.archive_id)
        .where(FloorLabeledPart.session_id == session_id)
        .group_by(Printer.id, Printer.name, PrintArchive.print_name)
        .order_by(Printer.name)
    )
    return [
        {"printer_id": printer_id, "printer_name": printer_name, "print_name": print_name, "part_count": count}
        for printer_id, printer_name, print_name, count in rows.all()
    ]


async def dismiss_build_plate(db: AsyncSession, archive_id: int) -> bool:
    from backend.app.models.archive import PrintArchive

    archive = await db.get(PrintArchive, archive_id)
    if archive is None or archive.status != "completed":
        return False
    existing = await db.execute(
        select(FloorDismissedBuildPlate).where(FloorDismissedBuildPlate.archive_id == archive_id)
    )
    if existing.scalar_one_or_none() is None:
        db.add(FloorDismissedBuildPlate(archive_id=archive_id))
        await db.flush()
    return True


async def has_labeled_parts_for_archive(db: AsyncSession, archive_id: int) -> bool:
    """Whether any part sticker has been linked to this archive yet.

    Feeds the printer info page's last-finished-print panel (§5.6) via a
    deferred import from ``floor_printers`` — that module imports this one
    for archive/printer resolution, so importing it back at module scope
    here would be circular; see the deferred import at its call site.
    """
    result = await db.execute(select(FloorLabeledPart.id).where(FloorLabeledPart.archive_id == archive_id).limit(1))
    return result.scalar_one_or_none() is not None


async def list_inventory_parts(db: AsyncSession, *, include_archived: bool = False) -> list[InventoryPart]:
    from backend.app.models.archive import PrintArchive

    latest_event_action = (
        select(FloorPartEvent.action)
        .where(FloorPartEvent.part_id == FloorLabeledPart.id)
        .order_by(FloorPartEvent.occurred_at.desc(), FloorPartEvent.id.desc())
        .limit(1)
        .scalar_subquery()
    )
    statement = (
        select(FloorLabeledPart, Printer.name, PrintArchive.print_name, latest_event_action)
        .outerjoin(Printer, Printer.id == FloorLabeledPart.printer_id)
        .outerjoin(PrintArchive, PrintArchive.id == FloorLabeledPart.archive_id)
    )
    if not include_archived:
        statement = statement.where(FloorLabeledPart.archived_at.is_(None))
    result = await db.execute(statement.order_by(FloorLabeledPart.labeled_at.desc()))
    return [
        InventoryPart(
            p.id,
            p.sticker_code,
            p.printer_id,
            printer_name,
            p.archive_id,
            print_name,
            p.labeled_at,
            p.archived_at,
            p.released_at,
            event_action,
        )
        for p, printer_name, print_name, event_action in result.all()
    ]


async def archive_part(db: AsyncSession, part_id: int, *, archived: bool) -> FloorLabeledPart | None:
    part = await db.get(FloorLabeledPart, part_id)
    if part is None:
        return None
    part.archived_at = None if not archived else datetime.now()
    db.add(FloorPartEvent(part_id=part.id, action="archived" if archived else "restored"))
    await db.flush()
    return part


async def delete_part(db: AsyncSession, part_id: int) -> bool:
    """Permanently remove a part record and its append-only audit history."""
    part = await db.get(FloorLabeledPart, part_id)
    if part is None:
        return False
    await db.execute(delete(FloorPartEvent).where(FloorPartEvent.part_id == part_id))
    await db.delete(part)
    await db.flush()
    return True


async def relink_part(db: AsyncSession, part_id: int, archive_id: int) -> FloorLabeledPart | None:
    """Bind an unlinked part to a completed job.

    Matching is only the recovery path for a record that had no job at
    harvest — or one just cleared by `unlink_part` below. It must not
    overwrite an established job association: a part with `archive_id`
    already set returns `None` unconditionally, and `unlink_part` is the
    only sanctioned way to clear that first (see
    `test_matching_only_resolves_an_unlinked_part`).

    Printer-agnostic by design, unlike an earlier version of this function:
    the printer recorded at harvest can itself be wrong (a mis-scanned
    `BBP-` code, or the wrong machine's plate cleared by hand), so a
    reviewer correcting that must be able to pick any completed job, not
    only ones on the recorded printer. That constraint still exists — it
    just lives one layer up now, in which candidates the caller offers
    rather than in this function: `list_part_job_candidates`'s *default*
    list still only offers same-printer jobs (overwhelmingly the common
    case, and it keeps that picker concise), and `search_completed_jobs` is
    the escalation when the default list is the wrong printer. Setting
    `part.printer_id = archive.printer_id` below means a cross-printer
    relink also fixes the printer record for free — no separate correction
    step needed.
    """
    from backend.app.models.archive import PrintArchive

    part = await db.get(FloorLabeledPart, part_id)
    archive = await db.get(PrintArchive, archive_id)
    if part is None or part.archive_id is not None or archive is None or archive.status != "completed":
        return None
    part.archive_id = archive.id
    part.printer_id = archive.printer_id
    db.add(
        FloorPartEvent(
            part_id=part.id, action="relinked", details={"archive_id": archive.id, "printer_id": archive.printer_id}
        )
    )
    await db.flush()
    return part


class UnlinkReasonCode(StrEnum):
    """Why an office reviewer is clearing an established job link.

    Follows `HarvestPrinterResult`/`PartScanResult`'s enum-per-outcome
    pattern (see the module docstring) rather than a free-text-only reason,
    so the audit trail stays queryable even though `reason_text` also exists
    for the `other` case.
    """

    WRONG_JOB = "wrong_job"
    WRONG_PRINTER = "wrong_printer"
    OTHER = "other"


async def unlink_part(
    db: AsyncSession, part_id: int, reason_code: str, reason_text: str | None = None
) -> FloorLabeledPart | None:
    """Clear an established job link, dropping the part back to needs-attention.

    `relink_part` above refuses ever to touch a part that already has an
    `archive_id` — an established link is trace evidence, not editable
    state. This is the one sanctioned way to clear it: a deliberate,
    reasoned action that leaves its own audit trail
    (`details.previous_archive_id`, plus the reason) rather than silently
    overwriting provenance. Once cleared, the part is an ordinary
    needs-attention row again, and `relink_part` can bind it to a
    (possibly different) job.

    Deliberately does not touch `printer_id`. A stale `printer_id` left over
    from the cleared link self-corrects the moment the part is relinked to a
    job on the right printer — `relink_part` always sets
    `printer_id = archive.printer_id` — so there is nothing here to guess at
    in the meantime; leaving it alone also means an unlinked-but-not-yet-
    relinked part still shows *some* printer for context rather than
    reverting to a bare "unknown".
    """
    part = await db.get(FloorLabeledPart, part_id)
    if part is None or part.archived_at is not None or part.archive_id is None:
        return None
    previous_archive_id = part.archive_id
    part.archive_id = None
    db.add(
        FloorPartEvent(
            part_id=part.id,
            action="unlinked",
            details={
                "previous_archive_id": previous_archive_id,
                "reason_code": reason_code,
                "reason_text": reason_text,
            },
        )
    )
    await db.flush()
    return part


async def list_part_events(db: AsyncSession, part_id: int) -> list[PartEvent] | None:
    """Return append-only audit entries, oldest first, for the detail panel."""
    part = await db.get(FloorLabeledPart, part_id)
    if part is None:
        return None
    result = await db.execute(
        select(FloorPartEvent)
        .where(FloorPartEvent.part_id == part_id)
        .order_by(FloorPartEvent.occurred_at.asc(), FloorPartEvent.id.asc())
    )
    return [PartEvent(e.id, e.action, e.details, e.occurred_at) for e in result.scalars()]


async def backfill_missing_enrolled_events(db: AsyncSession) -> int:
    """Create ``enrolled`` audit rows for parts that predate event logging."""
    from sqlalchemy import exists

    enrolled_exists = (
        select(FloorPartEvent.id)
        .where(
            FloorPartEvent.part_id == FloorLabeledPart.id,
            FloorPartEvent.action == "enrolled",
        )
        .limit(1)
    )
    result = await db.execute(select(FloorLabeledPart).where(~exists(enrolled_exists)))
    parts = result.scalars().all()
    for part in parts:
        db.add(
            FloorPartEvent(
                part_id=part.id,
                action="enrolled",
                details={"printer_id": part.printer_id, "archive_id": part.archive_id},
                occurred_at=part.labeled_at,
            )
        )
    if parts:
        await db.flush()
    return len(parts)


async def list_part_job_candidates(db: AsyncSession, part_id: int, *, limit: int = 12) -> list[PartJobCandidate] | None:
    """Completed same-printer jobs that can resolve an unlinked part.

    The label timestamp remains visible in the UI so the reviewer can choose
    the right nearby job; ordering recent completions first avoids pretending
    the server can infer an exact job from a timestamp alone.
    """
    from backend.app.models.archive import PrintArchive

    part = await db.get(FloorLabeledPart, part_id)
    if part is None:
        return None
    if part.archive_id is not None or part.printer_id is None:
        return []
    rows = await db.execute(
        select(PrintArchive)
        .where(
            PrintArchive.printer_id == part.printer_id,
            PrintArchive.status == "completed",
        )
        .order_by(PrintArchive.completed_at.desc().nullslast(), PrintArchive.id.desc())
        .limit(limit)
    )
    return [
        PartJobCandidate(
            archive.id,
            archive.print_name or archive.filename,
            archive.completed_at,
        )
        for archive in rows.scalars()
    ]


@dataclass(frozen=True)
class JobSearchResult:
    """One completed job returned by an office-side job search.

    The escalation from `list_part_job_candidates`'s same-printer default:
    when the printer recorded at harvest is itself wrong, the reviewer needs
    to search *all* completed jobs, not just one printer's. Carries
    `printer_id`/`printer_name` — which `PartJobCandidate` does not, since
    that list is already scoped to one known printer — so the picker can show
    which machine each result actually came from.
    """

    id: int
    print_name: str
    printer_id: int | None
    printer_name: str | None
    completed_at: datetime | None


async def search_completed_jobs(db: AsyncSession, query: str, *, limit: int = 20) -> list[JobSearchResult]:
    """Free-text search across all completed jobs, any printer.

    Mirrors the `ilike` fallback branch in `archives.py`'s `search_archives`
    rather than pulling in that route's FTS machinery — this is a small,
    printer-agnostic picker for a rare correction flow, not a general
    archive browser, so a straightforward `ilike` is enough. An empty query
    returns `[]` immediately rather than the shop's entire completed-job
    history, which would be both a useless wall of results and a query
    nobody asked for.
    """
    from backend.app.models.archive import PrintArchive

    search_term = query.strip()
    if not search_term:
        return []
    like_pattern = f"%{search_term}%"
    rows = await db.execute(
        select(PrintArchive, Printer.name)
        .outerjoin(Printer, Printer.id == PrintArchive.printer_id)
        .where(
            (PrintArchive.print_name.ilike(like_pattern)) | (PrintArchive.filename.ilike(like_pattern)),
            PrintArchive.status == "completed",
        )
        .order_by(PrintArchive.completed_at.desc().nullslast())
        .limit(limit)
    )
    return [
        JobSearchResult(
            id=archive.id,
            print_name=archive.print_name or archive.filename,
            printer_id=archive.printer_id,
            printer_name=printer_name,
            completed_at=archive.completed_at,
        )
        for archive, printer_name in rows.all()
    ]


class ReplaceStickerResult(StrEnum):
    """What a sticker-replacement request did."""

    REPLACED = "replaced"
    NOT_FOUND = "not_found"
    ARCHIVED = "archived"
    INVALID_CODE = "invalid_code"
    CODE_IN_USE = "code_in_use"


@dataclass(frozen=True)
class ReplaceStickerOutcome:
    """The result of applying one sticker-replacement request."""

    result: ReplaceStickerResult
    part: FloorLabeledPart | None = None


class ReplaceStickerReasonCode(StrEnum):
    """Why the physical sticker had to be swapped for a new code."""

    DAMAGED = "damaged"
    FELL_OFF = "fell_off"
    OTHER = "other"


async def replace_sticker_code(
    db: AsyncSession, part_id: int, new_code: str, reason_code: str, reason_text: str | None = None
) -> ReplaceStickerOutcome:
    """Re-point one part row at a freshly-applied physical sticker.

    Distinct from `unlink_part`/`relink_part` above: those correct which
    *job* a part points at; this corrects which *sticker* represents the
    part, for when the original `BBD-` label is damaged or falls off the
    physical part on the floor. `sticker_code` is globally unique forever
    (§7.1) — a code can never be reused for a different part, active or
    archived — which gives this several distinct failure modes that each
    deserve their own HTTP status (see `ReplaceStickerResult`), the same
    reasoning that put `PartScanOutcome`/`HarvestPrinterOutcome` behind a
    result-enum-plus-dataclass rather than a bare `Optional` above.
    """
    part = await db.get(FloorLabeledPart, part_id)
    if part is None:
        return ReplaceStickerOutcome(result=ReplaceStickerResult.NOT_FOUND)
    if part.archived_at is not None:
        return ReplaceStickerOutcome(result=ReplaceStickerResult.ARCHIVED)

    code = parse_sticker_code(new_code)
    if code is None or code == part.sticker_code:
        return ReplaceStickerOutcome(result=ReplaceStickerResult.INVALID_CODE)

    if await _get_part_by_code(db, code) is not None:
        return ReplaceStickerOutcome(result=ReplaceStickerResult.CODE_IN_USE)

    previous_code = part.sticker_code
    part.sticker_code = code
    db.add(
        FloorPartEvent(
            part_id=part.id,
            action="sticker_replaced",
            details={
                "previous_code": previous_code,
                "new_code": code,
                "reason_code": reason_code,
                "reason_text": reason_text,
            },
        )
    )
    await db.flush()
    return ReplaceStickerOutcome(result=ReplaceStickerResult.REPLACED, part=part)


__all__ = [
    "PART_PREFIX",
    "HARVEST_STATION_SLUG",
    "FIT_CHECK_LOCATION_SLUG",
    "SANDING_LOCATION_SLUG",
    "normalize_sticker_code",
    "parse_sticker_code",
    "HarvestPrinterResult",
    "HarvestPrinterOutcome",
    "scan_harvest_printer",
    "PartScanResult",
    "PartScanOutcome",
    "scan_part",
    "LocationScanResult",
    "LocationScanOutcome",
    "scan_fit_check_part",
    "SandingReasonCode",
    "scan_sanding_part",
    "NeedsAttentionPart",
    "list_needs_attention",
    "list_inventory_parts",
    "list_part_events",
    "backfill_missing_enrolled_events",
    "list_part_job_candidates",
    "archive_part",
    "delete_part",
    "relink_part",
    "UnlinkReasonCode",
    "unlink_part",
    "JobSearchResult",
    "search_completed_jobs",
    "ReplaceStickerResult",
    "ReplaceStickerOutcome",
    "ReplaceStickerReasonCode",
    "replace_sticker_code",
    "has_labeled_parts_for_archive",
]
