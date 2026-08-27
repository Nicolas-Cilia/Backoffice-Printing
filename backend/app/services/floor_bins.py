"""Shared reusable KNB/BUT bins and their temporary harvest assignments."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.floor_bin import FloorBinBatch, FloorBinBatchEvent
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
BIN_COUNT = 3
BIN_FREE_STATUSES = frozenset(("empty", "empty_override", "unlinked"))
BIN_NON_STATUS_EVENTS = frozenset(("quantity_override",))
_BIN_PATTERN = re.compile(r"^BBN-(KNB|BUT)-([1-3])$")


def bin_payload(part_code: str, bin_number: int) -> str:
    normalized = part_code.strip().upper()
    if normalized not in BIN_PART_CODES:
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
    EMPTY_RECORDED = "empty_recorded"
    ALREADY_EMPTY = "already_empty"
    EMPTY_REQUIRES_WIP = "empty_requires_wip"
    QUANTITY_OVERRIDDEN = "quantity_overridden"
    UNLINKED = "unlinked"
    DISCARDED = "discarded"


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


@dataclass(frozen=True)
class BinManagementInfo:
    bin: BinInfo
    batch: BinBatchInfo | None
    status: str


def _part_name(part_code: str) -> str:
    return {"KNB": "Knob bin", "BUT": "Button bin"}[part_code]


async def list_floor_bins(db: AsyncSession) -> list[BinInfo]:
    """Return the six permanent physical bin labels, independent of printers."""
    return [
        BinInfo(
            payload=bin_payload(part_code, bin_number),
            bin_number=bin_number,
            part_code=part_code,
            part_name=_part_name(part_code),
        )
        for part_code in BIN_PART_CODES
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
        if action == "quantity_override" and isinstance(details, dict):
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
    result = await db.execute(
        select(FloorBinBatch)
        .where(FloorBinBatch.bin_payload == payload.strip().upper())
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
    if outcome.batch.status == "visual_qc_passed":
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


async def scan_bin_wip(db: AsyncSession, payload: str) -> BinScanOutcome:
    """Move a visually inspected fill into WIP."""
    outcome = await resolve_bin_for_flow(db, payload)
    if outcome.batch is None:
        return outcome
    if outcome.batch.status == "wip":
        return BinScanOutcome(result=BinScanResult.ALREADY_WIP, bin=outcome.bin, batch=outcome.batch)
    if outcome.batch.status != "visual_qc_passed":
        return BinScanOutcome(result=BinScanResult.QC_REQUIRED, bin=outcome.bin, batch=outcome.batch)
    db.add(FloorBinBatchEvent(batch_id=outcome.batch.id, action="wip", details={"source": "floor_scan"}))
    await db.flush()
    batch = await db.get(FloorBinBatch, outcome.batch.id)
    return BinScanOutcome(
        result=BinScanResult.WIP_RECORDED, bin=outcome.bin, batch=await _batch_info(db, batch, outcome.bin)
    )


async def scan_bin_empty(db: AsyncSession, payload: str) -> BinScanOutcome:
    """Close the current fill so this physical bin can be assigned again."""
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


async def list_floor_bin_management(db: AsyncSession) -> list[BinManagementInfo]:
    """Return all shared bins with their current active fill, if any."""
    managed: list[BinManagementInfo] = []
    for info in await list_floor_bins(db):
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
    return [BinBatchEventInfo(event.id, event.action, event.details, event.occurred_at) for event in result.scalars()]


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


__all__ = [
    "BIN_PREFIX",
    "BIN_PART_CODES",
    "BIN_COUNT",
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
    "scan_bin_empty",
    "list_floor_bin_management",
    "list_floor_bin_history",
    "list_bin_batch_events",
    "list_bin_job_candidates",
    "relink_bin",
    "override_bin_quantity",
    "unlink_bin",
    "discard_bin",
]
