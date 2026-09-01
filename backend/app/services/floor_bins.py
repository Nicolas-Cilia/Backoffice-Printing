"""Shared reusable KNB/BUT bins and their temporary harvest assignments."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.floor_bin import FloorBinBatch, FloorBinBatchEvent
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent
from backend.app.models.floor_session import FloorStationSession
from backend.app.models.printer import Printer
from backend.app.services.floor_codes import station_for_slug
from backend.app.services.floor_printers import (
    LastPrint,
    get_archive_summary,
    get_last_finished_print,
    get_printer,
)
from backend.app.services.floor_sessions import (
    ScanResult,
    claim_exclusive_station,
    get_open_session_for_device,
)

BIN_PREFIX = "BBN-"
BIN_PART_CODES = ("KNB", "BUT")
BOT_BIN_PART_CODE = "BOT"
ALL_BIN_PART_CODES = (*BIN_PART_CODES, BOT_BIN_PART_CODE)

# Item→location pipeline slugs a bin understands (§ item-then-location). Fit
# Check keeps its own quantity-carrying entry point and is not routed here.
READY_FOR_PRODUCTION_LOCATION_SLUG = "ready-for-production-inventory"
PRODUCTION_WIP_LOCATION_SLUG = "production-wip"
BIN_EMPTY_LOCATION_SLUG = "bin-empty"
BIN_LOCATION_SLUGS = frozenset(
    {READY_FOR_PRODUCTION_LOCATION_SLUG, PRODUCTION_WIP_LOCATION_SLUG, BIN_EMPTY_LOCATION_SLUG}
)
BIN_COUNT = 3
BIN_FREE_STATUSES = frozenset(("empty", "empty_override", "unlinked"))
# Events that describe a fill's remaining count rather than its workflow
# status. ``consumed`` (a kit unit pulled at TOP → WIP) and ``floor_adjust``
# (a manual floor subtract) join ``quantity_override`` here so a bin's derived
# status stays ``wip`` while these are appended, and so ``_remaining_quantity``
# reads their authoritative ``remaining_quantity`` like an override.
BIN_NON_STATUS_EVENTS = frozenset(("quantity_override", "consumed", "floor_adjust"))
# The subset of non-status events that carry an authoritative
# ``remaining_quantity`` in their details (newest wins).
BIN_REMAINING_QUANTITY_EVENTS = frozenset(("quantity_override", "consumed", "floor_adjust"))
_BIN_PATTERN = re.compile(r"^BBN-(KNB|BUT|BOT)-([1-3])$")


def is_bot_bin_payload(payload: str) -> bool:
    parsed = parse_bin_payload(payload)
    return parsed is not None and parsed[0] == BOT_BIN_PART_CODE


def bin_payload(part_code: str, bin_number: int) -> str:
    normalized = part_code.strip().upper()
    if normalized not in ALL_BIN_PART_CODES:
        raise ValueError(f"Unsupported bin part code: {part_code}")
    if bin_number < 1 or bin_number > BIN_COUNT:
        raise ValueError(f"Bin number must be between 1 and {BIN_COUNT}")
    return f"{BIN_PREFIX}{normalized}-{bin_number}"


def parse_bin_payload(payload: str) -> tuple[str, int] | None:
    match = _BIN_PATTERN.fullmatch(payload.strip().upper())
    if match is None:
        return None
    return match.group(1), int(match.group(2))


class BinScanResult(StrEnum):
    READY_FOR_QUANTITY = "ready_for_quantity"
    RECORDED = "recorded"
    BIN_IN_USE = "bin_in_use"
    WRONG_PART = "wrong_part"
    LOCKED = "locked"
    NO_SESSION = "no_session"
    NO_PRINTER = "no_printer"
    INVALID_CODE = "invalid_code"
    NO_BATCH = "no_batch"
    READY_FOR_QC = "ready_for_qc"
    READY_FOR_QC_QUANTITY = "ready_for_qc_quantity"
    QC_RECORDED = "qc_recorded"
    QC_QUANTITY_INVALID = "qc_quantity_invalid"
    QC_REQUIRED = "qc_required"
    ALREADY_WIP = "already_wip"
    WIP_RECORDED = "wip_recorded"
    READY_FOR_PRODUCTION_RECORDED = "ready_for_production_recorded"
    ALREADY_READY_FOR_PRODUCTION = "already_ready_for_production"
    EMPTY_RECORDED = "empty_recorded"
    ALREADY_EMPTY = "already_empty"
    EMPTY_REQUIRES_WIP = "empty_requires_wip"
    QUANTITY_OVERRIDDEN = "quantity_overridden"
    UNLINKED = "unlinked"
    DISCARDED = "discarded"
    # Part Assembly Linking (Wave 1).
    # A second fill of a type refused because one is already on the line.
    WIP_TYPE_OCCUPIED = "wip_type_occupied"
    # BOT bin still holds members — empty only when the tote is depleted.
    BIN_NOT_EMPTY = "bin_not_empty"
    # A floor remaining subtract succeeded / was refused because the fill is
    # not In WIP with remaining left.
    ADJUSTED = "adjusted"
    ADJUST_REQUIRES_WIP = "adjust_requires_wip"


@dataclass(frozen=True)
class BinInfo:
    payload: str
    bin_number: int
    part_code: str
    part_name: str


@dataclass(frozen=True)
class BinBatchInfo:
    id: int
    payload: str
    bin_number: int
    printer: Printer | None
    archive: LastPrint | None
    part_code: str
    quantity: int
    qc_passed_quantity: int | None
    remaining_quantity: int
    status: str
    harvested_at: datetime
    archived_at: datetime | None = None


@dataclass(frozen=True)
class BinBatchEventInfo:
    id: int
    action: str
    details: dict | None
    occurred_at: datetime


@dataclass(frozen=True)
class BinJobCandidate:
    id: int
    print_name: str
    completed_at: datetime | None


@dataclass(frozen=True)
class BinScanOutcome:
    result: BinScanResult
    bin: BinInfo | None = None
    batch: BinBatchInfo | None = None
    printer: Printer | None = None
    session: FloorStationSession | None = None
    blocking: FloorStationSession | None = None
    archive: LastPrint | None = None
    # True when this action left the fill at 0 remaining. The screen shows an
    # empty-bin prompt to scan it off the line — no 5→1 countdown (Wave 1).
    empty_bin_warning: bool = False


@dataclass(frozen=True)
class BinManagementInfo:
    bin: BinInfo
    batch: BinBatchInfo | None
    status: str


def _part_name(part_code: str) -> str:
    return {"KNB": "Knob bin", "BUT": "Button bin", "BOT": "Bot bin"}[part_code]


async def list_floor_bins(db: AsyncSession) -> list[BinInfo]:
    """Return the nine permanent physical bin labels, independent of printers."""
    return [
        BinInfo(
            payload=bin_payload(part_code, bin_number),
            bin_number=bin_number,
            part_code=part_code,
            part_name=_part_name(part_code),
        )
        for part_code in ALL_BIN_PART_CODES
        for bin_number in range(1, BIN_COUNT + 1)
    ]


async def _resolve_bin(db: AsyncSession, payload: str) -> BinInfo | None:
    parsed = parse_bin_payload(payload)
    if parsed is None:
        return None
    part_code, bin_number = parsed
    return BinInfo(
        payload=bin_payload(part_code, bin_number),
        bin_number=bin_number,
        part_code=part_code,
        part_name=_part_name(part_code),
    )


async def _latest_bin_event(db: AsyncSession, batch_id: int) -> str | None:
    actions = (
        await db.execute(
            select(FloorBinBatchEvent.action, FloorBinBatchEvent.details)
            .where(FloorBinBatchEvent.batch_id == batch_id)
            .order_by(FloorBinBatchEvent.occurred_at.desc(), FloorBinBatchEvent.id.desc())
        )
    ).all()
    for action, details in actions:
        if action in BIN_NON_STATUS_EVENTS:
            continue
        if action == "relinked" and isinstance(details, dict):
            restored_status = details.get("restored_status")
            if isinstance(restored_status, str) and restored_status:
                return restored_status
        return action
    return None


async def _remaining_quantity(db: AsyncSession, batch: FloorBinBatch) -> int:
    events = (
        await db.execute(
            select(FloorBinBatchEvent.action, FloorBinBatchEvent.details)
            .where(FloorBinBatchEvent.batch_id == batch.id)
            .order_by(FloorBinBatchEvent.occurred_at.desc(), FloorBinBatchEvent.id.desc())
        )
    ).all()
    for action, details in events:
        if action in ("empty", "empty_override"):
            return 0
        if action in ("unlinked", "relinked"):
            continue
        if action in BIN_REMAINING_QUANTITY_EVENTS and isinstance(details, dict):
            value = details.get("remaining_quantity")
            if isinstance(value, int):
                return max(0, value)
        if action == "visual_qc_passed" and isinstance(details, dict):
            value = details.get("passed_quantity")
            if isinstance(value, int):
                return max(0, value)
    return batch.quantity


async def _qc_passed_quantity(db: AsyncSession, batch_id: int) -> int | None:
    result = await db.execute(
        select(FloorBinBatchEvent.details)
        .where(
            FloorBinBatchEvent.batch_id == batch_id,
            FloorBinBatchEvent.action == "visual_qc_passed",
        )
        .order_by(FloorBinBatchEvent.occurred_at.desc(), FloorBinBatchEvent.id.desc())
        .limit(1)
    )
    details = result.scalar_one_or_none()
    if isinstance(details, dict) and isinstance(details.get("passed_quantity"), int):
        return max(0, details["passed_quantity"])
    return None


async def _latest_batch(db: AsyncSession, payload: str) -> FloorBinBatch | None:
    """Newest non-archived fill for a physical bin QR.

    Archived fills stay in Part history but no longer block reuse of the tote.
    """
    result = await db.execute(
        select(FloorBinBatch)
        .where(
            FloorBinBatch.bin_payload == payload.strip().upper(),
            FloorBinBatch.archived_at.is_(None),
        )
        .order_by(FloorBinBatch.harvested_at.desc(), FloorBinBatch.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _batch_info(db: AsyncSession, batch: FloorBinBatch, info: BinInfo | None = None) -> BinBatchInfo:
    resolved = info or await _resolve_bin(db, batch.bin_payload)
    printer = await get_printer(db, batch.printer_id) if batch.printer_id is not None else None
    archive = await get_archive_summary(db, batch.archive_id) if batch.archive_id is not None else None
    status = await _latest_bin_event(db, batch.id) or "harvested"
    return BinBatchInfo(
        id=batch.id,
        payload=batch.bin_payload,
        bin_number=resolved.bin_number if resolved else 0,
        printer=printer,
        archive=archive,
        part_code=batch.part_code,
        quantity=batch.quantity,
        qc_passed_quantity=await _qc_passed_quantity(db, batch.id),
        remaining_quantity=await _remaining_quantity(db, batch),
        status=status,
        harvested_at=batch.harvested_at,
        archived_at=batch.archived_at,
    )


async def _latest_batch_with_status(db: AsyncSession, info: BinInfo) -> tuple[FloorBinBatch | None, str | None]:
    batch = await _latest_batch(db, info.payload)
    if batch is None:
        return None, None
    return batch, await _latest_bin_event(db, batch.id)


async def scan_harvest_bin(
    db: AsyncSession,
    device_id: str,
    payload: str,
    quantity: int | None = None,
    printer_id_hint: int | None = None,
) -> BinScanOutcome:
    """Assign a free shared bin to the current printer/job and save its count."""
    info = await _resolve_bin(db, payload)
    if info is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    if info.part_code == BOT_BIN_PART_CODE:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE, bin=info)

    session = await get_open_session_for_device(db, device_id)
    if session is not None and session.station_slug != "harvest":
        return BinScanOutcome(result=BinScanResult.NO_SESSION, bin=info, session=session)

    # Check the shared bin before claiming a new Harvest session from a
    # printer-info page. Trying to use a filled bin must not accidentally bind
    # the new printer or take the floor-wide Harvest lock.
    current_batch, current_status = await _latest_batch_with_status(db, info)
    if current_batch is not None and current_status not in ("empty", "empty_override"):
        return BinScanOutcome(
            result=BinScanResult.BIN_IN_USE,
            bin=info,
            batch=await _batch_info(db, current_batch, info),
        )

    printer: Printer | None = None
    if session is None:
        if printer_id_hint is None:
            return BinScanOutcome(result=BinScanResult.NO_PRINTER, bin=info)
        printer = await get_printer(db, printer_id_hint)
        if printer is None:
            return BinScanOutcome(result=BinScanResult.NO_PRINTER, bin=info)
        station = station_for_slug("harvest")
        if station is None:
            raise RuntimeError("Harvest station missing from catalog")
        last_print = await get_last_finished_print(db, printer.id)
        claim = await claim_exclusive_station(
            db,
            station,
            device_id,
            bound_printer_id=printer.id,
            bound_archive_id=last_print.archive_id if last_print else None,
        )
        if claim.result is ScanResult.LOCKED:
            return BinScanOutcome(result=BinScanResult.LOCKED, bin=info, blocking=claim.blocking)
        session = claim.session
    elif session.bound_printer_id is None:
        return BinScanOutcome(result=BinScanResult.NO_PRINTER, bin=info, session=session)
    else:
        printer = await get_printer(db, session.bound_printer_id)

    if printer is None:
        return BinScanOutcome(result=BinScanResult.NO_PRINTER, bin=info, session=session)

    archive_id = session.bound_archive_id
    archive = await get_archive_summary(db, archive_id) if archive_id is not None else None
    archive_code = archive.part_code if archive is not None else None
    if archive_code is not None and archive_code != info.part_code:
        return BinScanOutcome(
            result=BinScanResult.WRONG_PART,
            bin=info,
            printer=printer,
            session=session,
            archive=archive,
        )

    if quantity is None:
        return BinScanOutcome(
            result=BinScanResult.READY_FOR_QUANTITY,
            bin=info,
            printer=printer,
            session=session,
            archive=archive,
        )

    batch = FloorBinBatch(
        bin_payload=info.payload,
        printer_id=printer.id,
        archive_id=archive_id,
        part_code=info.part_code,
        quantity=quantity,
        session_id=session.id,
    )
    db.add(batch)
    await db.flush()
    db.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="harvested",
            details={
                "bin_payload": info.payload,
                "bin_number": info.bin_number,
                "printer_id": printer.id,
                "archive_id": archive_id,
                "part_code": info.part_code,
                "quantity": quantity,
            },
        )
    )
    await db.flush()
    return BinScanOutcome(
        result=BinScanResult.RECORDED,
        bin=info,
        batch=await _batch_info(db, batch, info),
        printer=printer,
        session=session,
        archive=archive,
    )


async def resolve_bin_for_flow(db: AsyncSession, payload: str) -> BinScanOutcome:
    """Look up the current (not emptied) fill for a shared reusable bin."""
    if is_bot_bin_payload(payload):
        from backend.app.services.floor_bot_bins import resolve_bot_bin_for_flow

        return await resolve_bot_bin_for_flow(db, payload)
    info = await _resolve_bin(db, payload)
    if info is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    batch, status = await _latest_batch_with_status(db, info)
    if batch is None or status in BIN_FREE_STATUSES:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info)
    return BinScanOutcome(result=BinScanResult.READY_FOR_QC, bin=info, batch=await _batch_info(db, batch, info))


async def scan_bin_fit_check(
    db: AsyncSession,
    payload: str,
    passed_quantity: int | None = None,
) -> BinScanOutcome:
    """Record the visual inspection and the quantity that passed it."""
    outcome = await resolve_bin_for_flow(db, payload)
    if outcome.batch is None:
        return outcome
    if outcome.batch.status == "wip":
        return BinScanOutcome(result=BinScanResult.ALREADY_WIP, bin=outcome.bin, batch=outcome.batch)
    if outcome.batch.status in ("visual_qc_passed", "ready_for_production"):
        # Restaging from WIP must not reopen visual QC; staged fills already
        # passed inspection.
        return BinScanOutcome(result=BinScanResult.QC_RECORDED, bin=outcome.bin, batch=outcome.batch)
    if passed_quantity is None:
        return BinScanOutcome(
            result=BinScanResult.READY_FOR_QC_QUANTITY,
            bin=outcome.bin,
            batch=outcome.batch,
        )
    if passed_quantity > outcome.batch.quantity:
        return BinScanOutcome(
            result=BinScanResult.QC_QUANTITY_INVALID,
            bin=outcome.bin,
            batch=outcome.batch,
        )
    db.add(
        FloorBinBatchEvent(
            batch_id=outcome.batch.id,
            action="visual_qc_passed",
            details={
                "inspection": "visual",
                "harvested_quantity": outcome.batch.quantity,
                "passed_quantity": passed_quantity,
                "rejected_quantity": outcome.batch.quantity - passed_quantity,
            },
        )
    )
    await db.flush()
    batch = await db.get(FloorBinBatch, outcome.batch.id)
    return BinScanOutcome(
        result=BinScanResult.QC_RECORDED, bin=outcome.bin, batch=await _batch_info(db, batch, outcome.bin)
    )


async def scan_bin_ready_for_production(db: AsyncSession, payload: str) -> BinScanOutcome:
    """Stage a visually inspected fill in Ready-for-Production Inventory.

    Optional step between Initial QC and Production WIP (§ item→location):
    requires visual QC to have passed, and is never itself a prerequisite for
    WIP. A fill already in Production WIP may be restaged here. Idempotent — a
    fill already at Ready-for-Production reports so rather than appending a
    duplicate event."""
    outcome = await resolve_bin_for_flow(db, payload)
    if outcome.batch is None:
        return outcome
    if outcome.batch.status == "ready_for_production":
        return BinScanOutcome(result=BinScanResult.ALREADY_READY_FOR_PRODUCTION, bin=outcome.bin, batch=outcome.batch)
    if outcome.batch.status not in ("visual_qc_passed", "wip"):
        return BinScanOutcome(result=BinScanResult.QC_REQUIRED, bin=outcome.bin, batch=outcome.batch)
    db.add(
        FloorBinBatchEvent(batch_id=outcome.batch.id, action="ready_for_production", details={"source": "floor_scan"})
    )
    await db.flush()
    batch = await db.get(FloorBinBatch, outcome.batch.id)
    return BinScanOutcome(
        result=BinScanResult.READY_FOR_PRODUCTION_RECORDED,
        bin=outcome.bin,
        batch=await _batch_info(db, batch, outcome.bin),
    )


async def scan_bin_wip(db: AsyncSession, payload: str) -> BinScanOutcome:
    """Move a visually inspected fill into WIP.

    Accepts a fill straight from Initial QC (``visual_qc_passed``) or one that
    stopped at Ready-for-Production Inventory first — Ready-for-Production is
    optional, so both are valid predecessors. Anything earlier (still
    ``harvested``, never QC'd) is refused with ``QC_REQUIRED``."""
    if is_bot_bin_payload(payload):
        from backend.app.services.floor_bot_bins import scan_bot_bin_wip

        return await scan_bot_bin_wip(db, payload)
    outcome = await resolve_bin_for_flow(db, payload)
    if outcome.batch is None:
        return outcome
    if outcome.batch.status == "wip":
        return BinScanOutcome(result=BinScanResult.ALREADY_WIP, bin=outcome.bin, batch=outcome.batch)
    if outcome.batch.status not in ("visual_qc_passed", "ready_for_production"):
        return BinScanOutcome(result=BinScanResult.QC_REQUIRED, bin=outcome.bin, batch=outcome.batch)
    # One bin on the line per type (§ Part Assembly Linking, Wave 1): at most
    # one KNB and one BUT fill may be In WIP at a time — including one sitting
    # at 0 remaining until it is emptied off the line. A second fill of the
    # same type is refused until the first is emptied.
    occupied = await find_wip_batch(db, outcome.batch.part_code, exclude_batch_id=outcome.batch.id)
    if occupied is not None:
        return BinScanOutcome(result=BinScanResult.WIP_TYPE_OCCUPIED, bin=outcome.bin, batch=outcome.batch)
    db.add(FloorBinBatchEvent(batch_id=outcome.batch.id, action="wip", details={"source": "floor_scan"}))
    await db.flush()
    batch = await db.get(FloorBinBatch, outcome.batch.id)
    return BinScanOutcome(
        result=BinScanResult.WIP_RECORDED, bin=outcome.bin, batch=await _batch_info(db, batch, outcome.bin)
    )


async def scan_bin_empty(db: AsyncSession, payload: str) -> BinScanOutcome:
    """Close the current fill so this physical bin can be assigned again."""
    if is_bot_bin_payload(payload):
        from backend.app.services.floor_bot_bins import scan_bot_bin_empty

        return await scan_bot_bin_empty(db, payload)
    info = await _resolve_bin(db, payload)
    if info is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    batch, status = await _latest_batch_with_status(db, info)
    if batch is None:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info)
    batch_info = await _batch_info(db, batch, info)
    if status in BIN_FREE_STATUSES:
        return BinScanOutcome(result=BinScanResult.ALREADY_EMPTY, bin=info, batch=batch_info)
    if status != "wip":
        return BinScanOutcome(result=BinScanResult.EMPTY_REQUIRES_WIP, bin=info, batch=batch_info)
    db.add(FloorBinBatchEvent(batch_id=batch.id, action="empty", details={"source": "floor_scan"}))
    await db.flush()
    return BinScanOutcome(result=BinScanResult.EMPTY_RECORDED, bin=info, batch=await _batch_info(db, batch, info))


async def scan_bin_at_location(db: AsyncSession, payload: str, location_slug: str) -> BinScanOutcome:
    """Dispatch a bin item→location scan to the matching workflow step.

    The bin half of the universal scan-item-then-location pattern. Only the
    three bin locations are accepted here; a finishing or unknown location
    slug is an ``INVALID_CODE`` rather than a silent no-op."""
    if is_bot_bin_payload(payload):
        from backend.app.services.floor_bot_bins import scan_bot_bin_at_location

        return await scan_bot_bin_at_location(db, payload, location_slug)
    if location_slug == READY_FOR_PRODUCTION_LOCATION_SLUG:
        return await scan_bin_ready_for_production(db, payload)
    if location_slug == PRODUCTION_WIP_LOCATION_SLUG:
        return await scan_bin_wip(db, payload)
    if location_slug == BIN_EMPTY_LOCATION_SLUG:
        return await scan_bin_empty(db, payload)
    return BinScanOutcome(result=BinScanResult.INVALID_CODE, bin=await _resolve_bin(db, payload))


async def list_floor_bin_management(db: AsyncSession) -> list[BinManagementInfo]:
    """Return all shared bins with their current active fill, if any."""
    from backend.app.services.floor_bot_bins import bot_bin_management_info

    managed: list[BinManagementInfo] = []
    for info in await list_floor_bins(db):
        if info.part_code == BOT_BIN_PART_CODE:
            managed.append(await bot_bin_management_info(db, info))
            continue
        batch, status = await _latest_batch_with_status(db, info)
        active = batch is not None and status not in BIN_FREE_STATUSES
        needs_relink = batch is not None and status == "unlinked"
        managed.append(
            BinManagementInfo(
                bin=info,
                batch=await _batch_info(db, batch, info) if (active or needs_relink) and batch else None,
                status=status if (active or needs_relink) and status else "available",
            )
        )
    return managed


async def list_floor_bin_history(db: AsyncSession) -> list[BinManagementInfo]:
    """Return every shared-bin fill, including fills released for reuse."""
    result = await db.execute(
        select(FloorBinBatch).order_by(FloorBinBatch.harvested_at.desc(), FloorBinBatch.id.desc())
    )
    history: list[BinManagementInfo] = []
    for batch in result.scalars():
        info = await _resolve_bin(db, batch.bin_payload)
        if info is None:
            continue
        batch_info = await _batch_info(db, batch, info)
        history.append(BinManagementInfo(bin=info, batch=batch_info, status=batch_info.status))
    return history


async def list_bin_batch_events(db: AsyncSession, batch_id: int) -> list[BinBatchEventInfo] | None:
    """Return one bin fill's append-only workflow history, oldest first."""
    batch = await db.get(FloorBinBatch, batch_id)
    if batch is None:
        return None
    result = await db.execute(
        select(FloorBinBatchEvent)
        .where(FloorBinBatchEvent.batch_id == batch_id)
        .order_by(FloorBinBatchEvent.occurred_at.asc(), FloorBinBatchEvent.id.asc())
    )
    events = [BinBatchEventInfo(event.id, event.action, event.details, event.occurred_at) for event in result.scalars()]
    return await _attribute_consumed_events(db, batch_id, events)


async def _attribute_consumed_events(
    db: AsyncSession,
    batch_id: int,
    events: list[BinBatchEventInfo],
) -> list[BinBatchEventInfo]:
    """Fill in part_sticker on older ``consumed`` events that predate attribution.

    New kit assign/reassign writes write ``part_sticker`` onto the bin event.
    Older rows only have remaining_quantity — correlate them with the part's
    ``kit_assigned`` / ``kit_reassigned`` events that mention this batch so the
    history line can still say "Consumed by BBD-…".
    """
    needs = [event for event in events if event.action == "consumed" and not (event.details or {}).get("part_sticker")]
    if not needs:
        return events

    rows = (
        await db.execute(
            select(FloorPartEvent, FloorLabeledPart.sticker_code)
            .join(FloorLabeledPart, FloorLabeledPart.id == FloorPartEvent.part_id)
            .where(FloorPartEvent.action.in_(("kit_assigned", "kit_reassigned")))
            .order_by(FloorPartEvent.occurred_at.asc(), FloorPartEvent.id.asc())
        )
    ).all()

    candidates: list[tuple[datetime, int, str]] = []
    for part_event, sticker in rows:
        details = part_event.details if isinstance(part_event.details, dict) else {}
        mentions = False
        if part_event.action == "kit_assigned":
            mentions = details.get("kit_knob_batch_id") == batch_id or details.get("kit_button_batch_id") == batch_id
        elif part_event.action == "kit_reassigned":
            mentions = details.get("new_batch_id") == batch_id
        if mentions and isinstance(sticker, str) and sticker.strip():
            candidates.append((part_event.occurred_at, part_event.part_id, sticker.strip()))

    if not candidates:
        # Fallback: a part that still points at this fill as its kit.
        part_rows = (
            (
                await db.execute(
                    select(FloorLabeledPart).where(
                        (FloorLabeledPart.kit_knob_batch_id == batch_id)
                        | (FloorLabeledPart.kit_button_batch_id == batch_id)
                    )
                )
            )
            .scalars()
            .all()
        )
        if len(part_rows) == 1:
            only = part_rows[0]
            return [
                BinBatchEventInfo(
                    event.id,
                    event.action,
                    {
                        **(event.details or {}),
                        "part_id": only.id,
                        "part_sticker": only.sticker_code,
                    }
                    if event.action == "consumed" and not (event.details or {}).get("part_sticker")
                    else event.details,
                    event.occurred_at,
                )
                for event in events
            ]
        return events

    used: set[int] = set()
    enriched: list[BinBatchEventInfo] = []
    for event in events:
        if event.action != "consumed" or (event.details or {}).get("part_sticker"):
            enriched.append(event)
            continue
        best_i: int | None = None
        best_delta: float | None = None
        for index, (occurred_at, _part_id, _sticker) in enumerate(candidates):
            if index in used:
                continue
            delta = abs((occurred_at - event.occurred_at).total_seconds())
            if best_delta is None or delta < best_delta:
                best_delta = delta
                best_i = index
        if best_i is None:
            enriched.append(event)
            continue
        used.add(best_i)
        _occurred, part_id, sticker = candidates[best_i]
        details = dict(event.details or {})
        details["part_id"] = part_id
        details["part_sticker"] = sticker
        enriched.append(BinBatchEventInfo(event.id, event.action, details, event.occurred_at))
    return enriched


def _bin_fill_is_active(status: str | None, archived_at: datetime | None) -> bool:
    """True when the fill still occupies the physical tote (not free, not archived)."""
    if archived_at is not None:
        return False
    return (status or "harvested") not in BIN_FREE_STATUSES


def _bin_fill_blocks_archive(
    *,
    status: str | None,
    remaining_quantity: int,
    archive_id: int | None,
    archived_at: datetime | None,
) -> bool:
    """Refuse archive while the fill still has stock and is linked to a print.

    Deplete (remaining 0) or unlink first; restore is always allowed.
    """
    if archived_at is not None:
        return False
    if remaining_quantity <= 0:
        return False
    return archive_id is not None and (status or "harvested") != "unlinked"


async def archive_bin_batch(db: AsyncSession, batch_id: int, *, archived: bool) -> str:
    """Archive or restore a harvested fill.

    Returns ``"ok"``, ``"not_found"``, or ``"in_use"`` (still stocked + print-linked).
    Archiving frees the physical tote for reuse.
    """
    batch = await db.get(FloorBinBatch, batch_id)
    if batch is None:
        return "not_found"
    if archived:
        status = await _latest_bin_event(db, batch.id) or "harvested"
        remaining = await _remaining_quantity(db, batch)
        if _bin_fill_blocks_archive(
            status=status,
            remaining_quantity=remaining,
            archive_id=batch.archive_id,
            archived_at=batch.archived_at,
        ):
            return "in_use"
        batch.archived_at = datetime.now()
    else:
        batch.archived_at = None
    await db.flush()
    return "ok"


async def delete_bin_batch(db: AsyncSession, batch_id: int) -> str:
    """Permanently remove one harvested fill and its audit history.

    Active (still-linked) fills must be archived first — refuse with
    ``"active"``. Returns ``"deleted"``, ``"not_found"``, or ``"active"``.

    Kit references on TOP parts (``kit_knob_batch_id`` / ``kit_button_batch_id``)
    are ``ON DELETE SET NULL`` at the DB, so deleting a fill clears those
    pointers rather than cascading into part history.
    """
    batch = await db.get(FloorBinBatch, batch_id)
    if batch is None:
        return "not_found"
    status = await _latest_bin_event(db, batch.id) or "harvested"
    if _bin_fill_is_active(status, batch.archived_at):
        return "active"
    await db.execute(delete(FloorBinBatchEvent).where(FloorBinBatchEvent.batch_id == batch_id))
    await db.delete(batch)
    await db.flush()
    return "deleted"


async def assign_bin_manually(
    db: AsyncSession,
    payload: str,
    printer_id: int,
    quantity: int,
    archive_id: int | None = None,
) -> BinScanOutcome:
    """Create a bin fill from Inventory when Harvest could not match a KNB/BUT job.

    Allows assigning a free tote to a printer with a quantity even when no
    completed print resolves to the bin's part code. An optional ``archive_id``
    may still be attached when the job is unresolved (``part_code is None``) or
    already matches the bin; a mismatched resolved code is refused.
    """
    info = await _resolve_bin(db, payload)
    if info is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    if info.part_code == BOT_BIN_PART_CODE:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE, bin=info)

    current_batch, current_status = await _latest_batch_with_status(db, info)
    if current_batch is not None and current_status not in ("empty", "empty_override"):
        # Unlinked fills keep their batch for relink; do not silently replace them.
        return BinScanOutcome(
            result=BinScanResult.BIN_IN_USE,
            bin=info,
            batch=await _batch_info(db, current_batch, info),
        )

    printer = await get_printer(db, printer_id)
    if printer is None:
        return BinScanOutcome(result=BinScanResult.NO_PRINTER, bin=info)

    archive: LastPrint | None = None
    resolved_archive_id: int | None = None
    if archive_id is not None:
        from backend.app.models.archive import PrintArchive

        archive_row = await db.get(PrintArchive, archive_id)
        if archive_row is None or archive_row.status != "completed" or archive_row.printer_id != printer.id:
            return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info, printer=printer)
        archive = await get_archive_summary(db, archive_id)
        archive_code = archive.part_code if archive is not None else None
        if archive_code is not None and archive_code != info.part_code:
            return BinScanOutcome(
                result=BinScanResult.WRONG_PART,
                bin=info,
                printer=printer,
                archive=archive,
            )
        resolved_archive_id = archive_id

    batch = FloorBinBatch(
        bin_payload=info.payload,
        printer_id=printer.id,
        archive_id=resolved_archive_id,
        part_code=info.part_code,
        quantity=quantity,
        session_id=None,
    )
    db.add(batch)
    await db.flush()
    db.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="harvested",
            details={
                "source": "inventory_manual",
                "bin_payload": info.payload,
                "bin_number": info.bin_number,
                "printer_id": printer.id,
                "archive_id": resolved_archive_id,
                "part_code": info.part_code,
                "quantity": quantity,
            },
        )
    )
    await db.flush()
    return BinScanOutcome(
        result=BinScanResult.RECORDED,
        bin=info,
        batch=await _batch_info(db, batch, info),
        printer=printer,
        archive=archive,
    )


async def override_bin_quantity(db: AsyncSession, payload: str, remaining_quantity: int) -> BinScanOutcome:
    """Override a fill's remaining quantity; zero releases it as empty."""
    info = await _resolve_bin(db, payload)
    if info is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    batch, status = await _latest_batch_with_status(db, info)
    if batch is None or status in BIN_FREE_STATUSES:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info)
    if remaining_quantity == 0:
        action = "empty_override"
        details = {"source": "inventory_override", "remaining_quantity": 0}
        result = BinScanResult.EMPTY_RECORDED
    else:
        action = "quantity_override"
        details = {"source": "inventory_override", "remaining_quantity": remaining_quantity}
        result = BinScanResult.QUANTITY_OVERRIDDEN
    db.add(FloorBinBatchEvent(batch_id=batch.id, action=action, details=details))
    await db.flush()
    return BinScanOutcome(result=result, bin=info, batch=await _batch_info(db, batch, info))


async def unlink_bin(db: AsyncSession, payload: str) -> BinScanOutcome:
    """Release a bin's active fill without deleting its historical record."""
    info = await _resolve_bin(db, payload)
    if info is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    batch, status = await _latest_batch_with_status(db, info)
    if batch is None or status in BIN_FREE_STATUSES:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info)
    db.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="unlinked",
            details={
                "source": "inventory_override",
                "printer_id": batch.printer_id,
                "archive_id": batch.archive_id,
                "previous_status": status,
                "remaining_quantity": await _remaining_quantity(db, batch),
            },
        )
    )
    await db.flush()
    return BinScanOutcome(result=BinScanResult.UNLINKED, bin=info, batch=await _batch_info(db, batch, info))


async def discard_bin(db: AsyncSession, payload: str) -> BinScanOutcome:
    """Discard a bin's entire active fill from the floor kiosk in one action.

    Combines what the office side does as two separate steps — `unlink_bin`
    (sever the printer/job association, keeping history) then `scan_bin_empty`
    (clear the quantity) — because a discard means the contents are simply
    gone, not something to relink to a different job later. Appending
    "unlinked" before "empty" keeps both audit trails intact while "empty"
    ends up as the latest event, so the bin reads as immediately free
    everywhere status is derived (`_latest_bin_event`, `_remaining_quantity`,
    and `scan_harvest_bin`'s own free check) without touching those
    functions or `BIN_FREE_STATUSES`.
    """
    info = await _resolve_bin(db, payload)
    if info is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    batch, status = await _latest_batch_with_status(db, info)
    if batch is None or status in BIN_FREE_STATUSES:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info)
    db.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="unlinked",
            details={
                "source": "floor_discard",
                "printer_id": batch.printer_id,
                "archive_id": batch.archive_id,
                "previous_status": status,
                "remaining_quantity": await _remaining_quantity(db, batch),
            },
        )
    )
    db.add(FloorBinBatchEvent(batch_id=batch.id, action="empty", details={"source": "floor_discard"}))
    await db.flush()
    return BinScanOutcome(result=BinScanResult.DISCARDED, bin=info, batch=await _batch_info(db, batch, info))


async def list_bin_job_candidates(
    db: AsyncSession,
    batch_id: int,
    printer_id: int,
    *,
    limit: int = 12,
) -> list[BinJobCandidate] | None:
    """Return completed jobs from the selected printer for a bin relink."""
    from backend.app.models.archive import PrintArchive

    batch = await db.get(FloorBinBatch, batch_id)
    if batch is None:
        return None
    rows = await db.execute(
        select(PrintArchive)
        .where(PrintArchive.printer_id == printer_id, PrintArchive.status == "completed")
        .order_by(PrintArchive.completed_at.desc().nullslast(), PrintArchive.id.desc())
    )
    candidates: list[BinJobCandidate] = []
    for archive in rows.scalars():
        summary = await get_archive_summary(db, archive.id)
        part_code = summary.part_code if summary else None
        if part_code is None:
            source_names = (archive.print_name or "", archive.filename or "")
            if not any(
                re.search(rf"(?<![A-Z0-9]){re.escape(batch.part_code)}(?![A-Z0-9])", name.upper())
                for name in source_names
            ):
                continue
        elif part_code != batch.part_code:
            continue
        candidates.append(BinJobCandidate(archive.id, archive.print_name or archive.filename, archive.completed_at))
        if len(candidates) >= limit:
            break
    return candidates


async def relink_bin(db: AsyncSession, batch_id: int, archive_id: int) -> BinScanOutcome | None:
    """Restore an unlinked fill's printer/job association."""
    from backend.app.models.archive import PrintArchive

    batch = await db.get(FloorBinBatch, batch_id)
    archive = await db.get(PrintArchive, archive_id)
    if batch is None:
        return None
    status = await _latest_bin_event(db, batch.id)
    if status != "unlinked" or archive is None or archive.status != "completed":
        return None
    info = await _resolve_bin(db, batch.bin_payload)
    if info is None:
        return None
    archive_summary = await get_archive_summary(db, archive.id)
    if archive_summary is not None and archive_summary.part_code not in (None, info.part_code):
        return None

    previous_status = "harvested"
    events = (
        await db.execute(
            select(FloorBinBatchEvent.action, FloorBinBatchEvent.details)
            .where(FloorBinBatchEvent.batch_id == batch.id)
            .order_by(FloorBinBatchEvent.occurred_at.desc(), FloorBinBatchEvent.id.desc())
        )
    ).all()
    for action, details in events:
        if action == "unlinked":
            candidate = details.get("previous_status") if isinstance(details, dict) else None
            if isinstance(candidate, str) and candidate:
                previous_status = candidate
            break
    old_archive_id = batch.archive_id
    old_printer_id = batch.printer_id
    batch.archive_id = archive.id
    batch.printer_id = archive.printer_id
    db.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="relinked",
            details={
                "source": "inventory_override",
                "previous_archive_id": old_archive_id,
                "previous_printer_id": old_printer_id,
                "archive_id": archive.id,
                "printer_id": archive.printer_id,
                "restored_status": previous_status,
            },
        )
    )
    await db.flush()
    return BinScanOutcome(result=BinScanResult.RECORDED, bin=info, batch=await _batch_info(db, batch, info))


# ── Part Assembly Linking (Wave 1): kit consume / restore / floor adjust ──


async def find_wip_batch(
    db: AsyncSession,
    part_code: str,
    *,
    exclude_batch_id: int | None = None,
    require_remaining: bool = False,
) -> FloorBinBatch | None:
    """The single bin fill of ``part_code`` currently In WIP, if any.

    Scans the (few) physical bins of that type and returns the latest fill
    whose derived status is ``wip``. ``require_remaining`` narrows that to a
    fill with remaining > 0 — used by kit consume, which must refuse rather
    than consume from an already-empty line. ``exclude_batch_id`` skips a
    specific fill, used by the one-bin-per-type guard so a fill does not treat
    itself as the blocker.
    """
    normalized = part_code.strip().upper()
    if normalized not in BIN_PART_CODES:
        return None
    for bin_number in range(1, BIN_COUNT + 1):
        payload = bin_payload(normalized, bin_number)
        batch = await _latest_batch(db, payload)
        if batch is None or (exclude_batch_id is not None and batch.id == exclude_batch_id):
            continue
        status = await _latest_bin_event(db, batch.id)
        if status != "wip":
            continue
        if require_remaining and await _remaining_quantity(db, batch) <= 0:
            continue
        return batch
    return None


async def consume_from_batch(
    db: AsyncSession,
    batch: FloorBinBatch,
    *,
    source: str,
    amount: int = 1,
    part_id: int | None = None,
    part_sticker: str | None = None,
) -> int:
    """Pull ``amount`` from a fill by appending a ``consumed`` event.

    Append-only: never mutates ``batch.quantity``. Returns the new remaining
    (floored at 0). The ``consumed`` event carries the authoritative
    ``remaining_quantity`` so ``_remaining_quantity`` reads it back like an
    override, and is a non-status event so the fill stays In WIP.

    ``part_id`` / ``part_sticker`` record the consuming TOP identity so bin
    history can attribute a fill's ``consumed`` events to the part that pulled
    them (e.g. "Consumed · BBD-000000"). Both are optional — old events without
    them stay a bare "Consumed".
    """
    remaining = await _remaining_quantity(db, batch)
    new_remaining = max(0, remaining - amount)
    details: dict = {"source": source, "consumed": amount, "remaining_quantity": new_remaining}
    if part_id is not None:
        details["part_id"] = part_id
    if part_sticker is not None:
        details["part_sticker"] = part_sticker
    db.add(FloorBinBatchEvent(batch_id=batch.id, action="consumed", details=details))
    await db.flush()
    return new_remaining


async def restore_to_batch(db: AsyncSession, batch: FloorBinBatch, *, source: str, amount: int = 1) -> int:
    """Return ``amount`` to a fill (the inverse of :func:`consume_from_batch`).

    Recorded as a ``floor_adjust`` event carrying the new remaining, so it wins
    in ``_remaining_quantity`` and keeps the fill's status unchanged.
    """
    remaining = await _remaining_quantity(db, batch)
    new_remaining = remaining + amount
    db.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="floor_adjust",
            details={"source": source, "restored": amount, "remaining_quantity": new_remaining},
        )
    )
    await db.flush()
    return new_remaining


async def _batch_eligible_for_reassign(db: AsyncSession, batch: FloorBinBatch) -> bool:
    """Eligible = not archived, status In WIP or Ready-for-Production, remaining > 0."""
    if batch.archived_at is not None:
        return False
    status = await _latest_bin_event(db, batch.id)
    if status not in ("wip", "ready_for_production"):
        return False
    return await _remaining_quantity(db, batch) > 0


async def find_reassign_target(db: AsyncSession, payload: str) -> FloorBinBatch | None:
    """The latest fill on ``payload`` eligible to receive a reassigned kit.

    Eligible = status In WIP or Ready-for-Production, with remaining > 0.
    """
    parsed = parse_bin_payload(payload)
    if parsed is None:
        return None
    batch = await _latest_batch(db, bin_payload(*parsed))
    if batch is None:
        return None
    if not await _batch_eligible_for_reassign(db, batch):
        return None
    return batch


async def find_reassign_target_by_id(db: AsyncSession, batch_id: int, *, part_code: str) -> FloorBinBatch | None:
    """A specific harvest fill eligible to receive a reassigned kit slot.

    Same eligibility as :func:`find_reassign_target`, but keyed by batch id so
    the office Serials UI can pick any past or current fill of that type — not
    only the latest fill on a scanned bin payload.
    """
    normalized = part_code.strip().upper()
    if normalized not in BIN_PART_CODES:
        return None
    batch = await db.get(FloorBinBatch, batch_id)
    if batch is None or batch.part_code != normalized:
        return None
    if not await _batch_eligible_for_reassign(db, batch):
        return None
    return batch


async def adjust_bin_remaining(db: AsyncSession, payload: str, subtract: int) -> BinScanOutcome:
    """Subtract N from an In-WIP fill's remaining (floor floor-adjust flow).

    ``remaining = max(0, current - N)``. Requires the fill to be In WIP with
    remaining > 0 (the office set-to-N override keeps its own
    ``override_bin_quantity`` path). Recorded as a ``floor_adjust`` event; if
    it lands on 0 the outcome carries an empty-bin warning so the screen can
    prompt to scan the bin off the line — no countdown.
    """
    info = await _resolve_bin(db, payload)
    if info is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    batch, status = await _latest_batch_with_status(db, info)
    if batch is None or status in BIN_FREE_STATUSES:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info)
    if status != "wip":
        return BinScanOutcome(
            result=BinScanResult.ADJUST_REQUIRES_WIP, bin=info, batch=await _batch_info(db, batch, info)
        )
    remaining = await _remaining_quantity(db, batch)
    if remaining <= 0:
        return BinScanOutcome(
            result=BinScanResult.ADJUST_REQUIRES_WIP, bin=info, batch=await _batch_info(db, batch, info)
        )
    new_remaining = max(0, remaining - max(1, subtract))
    db.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="floor_adjust",
            details={"source": "floor_adjust", "subtracted": max(1, subtract), "remaining_quantity": new_remaining},
        )
    )
    await db.flush()
    return BinScanOutcome(
        result=BinScanResult.ADJUSTED,
        bin=info,
        batch=await _batch_info(db, batch, info),
        empty_bin_warning=new_remaining == 0,
    )


__all__ = [
    "BIN_PREFIX",
    "BIN_PART_CODES",
    "BOT_BIN_PART_CODE",
    "ALL_BIN_PART_CODES",
    "BIN_COUNT",
    "is_bot_bin_payload",
    "BinScanResult",
    "BinScanOutcome",
    "BinInfo",
    "BinBatchInfo",
    "BinBatchEventInfo",
    "BinJobCandidate",
    "BinManagementInfo",
    "bin_payload",
    "parse_bin_payload",
    "list_floor_bins",
    "scan_harvest_bin",
    "resolve_bin_for_flow",
    "scan_bin_fit_check",
    "scan_bin_wip",
    "scan_bin_ready_for_production",
    "scan_bin_at_location",
    "scan_bin_empty",
    "BIN_LOCATION_SLUGS",
    "READY_FOR_PRODUCTION_LOCATION_SLUG",
    "PRODUCTION_WIP_LOCATION_SLUG",
    "BIN_EMPTY_LOCATION_SLUG",
    "list_floor_bin_management",
    "list_floor_bin_history",
    "list_bin_batch_events",
    "list_bin_job_candidates",
    "delete_bin_batch",
    "archive_bin_batch",
    "relink_bin",
    "override_bin_quantity",
    "unlink_bin",
    "discard_bin",
    "find_wip_batch",
    "consume_from_batch",
    "restore_to_batch",
    "find_reassign_target",
    "find_reassign_target_by_id",
    "adjust_bin_remaining",
]
