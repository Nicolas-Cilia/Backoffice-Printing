"""Shared BOT bins that collect individually-QC'd BBD- bottom housings."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.floor_bin import FloorBinBatch, FloorBinBatchEvent, FloorBotBinMember
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent
from backend.app.services.floor_bins import (
    BIN_COUNT,
    BIN_EMPTY_LOCATION_SLUG,
    BIN_FREE_STATUSES,
    BOT_BIN_PART_CODE,
    PRODUCTION_WIP_LOCATION_SLUG,
    READY_FOR_PRODUCTION_LOCATION_SLUG,
    BinBatchInfo,
    BinInfo,
    BinManagementInfo,
    BinScanOutcome,
    BinScanResult,
    _latest_batch,
    _resolve_bin,
    bin_payload,
)
from backend.app.services.floor_parts import (
    BOT_PART_CODE,
    PRODUCTION_WIP_ACTION,
    _get_part_by_code,
    _part_has_valid_qc,
    parse_sticker_code,
)

BOT_BIN_MAX_MEMBERS = 18
BOT_NON_STATUS_EVENTS = frozenset(("member_added", "member_removed", "member_moved"))


@dataclass(frozen=True)
class BotBinMemberInfo:
    part_id: int
    sticker_code: str
    part_code: str | None
    added_at: datetime


async def _member_part_ids(db: AsyncSession, batch_id: int) -> list[int]:
    rows = (await db.execute(select(FloorBotBinMember.part_id).where(FloorBotBinMember.batch_id == batch_id))).all()
    return [part_id for (part_id,) in rows]


def _bot_bin_part_event_details(batch: FloorBinBatch, *, source: str, **extra: object) -> dict:
    details: dict = {"batch_id": batch.id, "bin_payload": batch.bin_payload, "source": source}
    details.update(extra)
    return details


async def _record_bot_bin_loaded(
    db: AsyncSession,
    batch: FloorBinBatch,
    part: FloorLabeledPart,
    *,
    source: str,
) -> None:
    db.add(
        FloorPartEvent(
            part_id=part.id,
            action="bot_bin_loaded",
            details=_bot_bin_part_event_details(batch, source=source),
        )
    )


async def _record_bot_bin_staged(db: AsyncSession, batch: FloorBinBatch, *, source: str) -> None:
    """Mirror a BOT bin staging scan on every member so inventory last-scanned works."""
    details = _bot_bin_part_event_details(batch, source=source)
    for part_id in await _member_part_ids(db, batch.id):
        db.add(FloorPartEvent(part_id=part_id, action="ready_for_production", details=details))


async def _member_count(db: AsyncSession, batch_id: int) -> int:
    return int(
        await db.scalar(
            select(func.count()).select_from(FloorBotBinMember).where(FloorBotBinMember.batch_id == batch_id)
        )
        or 0
    )


async def _latest_bot_bin_event(db: AsyncSession, batch_id: int) -> str | None:
    actions = (
        await db.execute(
            select(FloorBinBatchEvent.action)
            .where(FloorBinBatchEvent.batch_id == batch_id)
            .order_by(FloorBinBatchEvent.occurred_at.desc(), FloorBinBatchEvent.id.desc())
        )
    ).all()
    for (action,) in actions:
        if action in BOT_NON_STATUS_EVENTS:
            continue
        return action
    return None


async def _bot_batch_info(db: AsyncSession, batch: FloorBinBatch, info: BinInfo) -> BinBatchInfo:
    member_count = await _member_count(db, batch.id)
    status = await _latest_bot_bin_event(db, batch.id) or "loaded"
    return BinBatchInfo(
        id=batch.id,
        payload=batch.bin_payload,
        bin_number=info.bin_number,
        printer=None,
        archive=None,
        part_code=batch.part_code,
        quantity=batch.quantity,
        qc_passed_quantity=None,
        remaining_quantity=member_count,
        status=status,
        harvested_at=batch.harvested_at,
        archived_at=batch.archived_at,
    )


async def _latest_bot_batch_with_status(db: AsyncSession, info: BinInfo) -> tuple[FloorBinBatch | None, str | None]:
    batch = await _latest_batch(db, info.payload)
    if batch is None:
        return None, None
    status = await _latest_bot_bin_event(db, batch.id)
    if status in BIN_FREE_STATUSES:
        return batch, status
    if await _member_count(db, batch.id) <= 0 and status not in ("wip",):
        return batch, status
    return batch, status


async def _get_member_batch(db: AsyncSession, part_id: int) -> FloorBinBatch | None:
    row = await db.scalar(select(FloorBotBinMember.batch_id).where(FloorBotBinMember.part_id == part_id))
    if row is None:
        return None
    return await db.get(FloorBinBatch, row)


async def _batch_is_on_wip(db: AsyncSession, batch_id: int) -> bool:
    return await _latest_bot_bin_event(db, batch_id) == "wip"


async def find_wip_bot_batch(db: AsyncSession, *, exclude_batch_id: int | None = None) -> FloorBinBatch | None:
    """The single BOT bin fill currently In WIP, if any."""
    for bin_number in range(1, BIN_COUNT + 1):
        payload = bin_payload(BOT_BIN_PART_CODE, bin_number)
        batch = await _latest_batch(db, payload)
        if batch is None or (exclude_batch_id is not None and batch.id == exclude_batch_id):
            continue
        if await _latest_bot_bin_event(db, batch.id) != "wip":
            continue
        return batch
    return None


async def _ensure_bot_batch(db: AsyncSession, info: BinInfo) -> tuple[FloorBinBatch, bool]:
    """Return the active fill for ``info``, creating one on first load."""
    batch, status = await _latest_bot_batch_with_status(db, info)
    if batch is not None and status not in BIN_FREE_STATUSES:
        return batch, False
    batch = FloorBinBatch(
        bin_payload=info.payload,
        printer_id=None,
        archive_id=None,
        part_code=BOT_BIN_PART_CODE,
        quantity=0,
        session_id=None,
    )
    db.add(batch)
    await db.flush()
    db.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="loaded",
            details={"bin_payload": info.payload, "bin_number": info.bin_number, "source": "floor_scan"},
        )
    )
    await db.flush()
    return batch, True


async def _add_member(
    db: AsyncSession,
    batch: FloorBinBatch,
    part: FloorLabeledPart,
    *,
    source: str,
    from_batch_id: int | None = None,
) -> None:
    db.add(FloorBotBinMember(batch_id=batch.id, part_id=part.id))
    details: dict = {"part_id": part.id, "part_sticker": part.sticker_code, "source": source}
    if from_batch_id is not None:
        details["from_batch_id"] = from_batch_id
    db.add(FloorBinBatchEvent(batch_id=batch.id, action="member_added", details=details))
    await _record_bot_bin_loaded(db, batch, part, source=source)
    await db.flush()


async def _remove_member(
    db: AsyncSession,
    batch: FloorBinBatch,
    part: FloorLabeledPart,
    *,
    source: str,
    to_batch_id: int | None = None,
) -> int:
    await db.execute(delete(FloorBotBinMember).where(FloorBotBinMember.part_id == part.id))
    details: dict = {"part_id": part.id, "part_sticker": part.sticker_code, "source": source}
    if to_batch_id is not None:
        details["to_batch_id"] = to_batch_id
    db.add(FloorBinBatchEvent(batch_id=batch.id, action="member_removed", details=details))
    await db.flush()
    return await _member_count(db, batch.id)


async def add_part_to_bot_bin(db: AsyncSession, part_sticker: str, payload: str) -> BinScanOutcome:
    """Load one BBD- bottom into a BOT bin, or move it from another non-WIP bin."""
    info = await _resolve_bin(db, payload)
    if info is None or info.part_code != BOT_BIN_PART_CODE:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)

    code = parse_sticker_code(part_sticker)
    part = await _get_part_by_code(db, code) if code is not None else None
    if part is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE, bin=info)

    part_code = (part.part_code or "").strip().upper()
    if part_code != BOT_PART_CODE:
        return BinScanOutcome(result=BinScanResult.WRONG_PART, bin=info)

    if not await _part_has_valid_qc(db, part.id):
        return BinScanOutcome(result=BinScanResult.QC_REQUIRED, bin=info)

    existing_batch = await _get_member_batch(db, part.id)
    if existing_batch is not None and existing_batch.bin_payload == info.payload:
        batch_info = await _bot_batch_info(db, existing_batch, info)
        return BinScanOutcome(result=BinScanResult.RECORDED, bin=info, batch=batch_info)

    target_existing = await _latest_batch(db, info.payload)
    if target_existing is not None and await _batch_is_on_wip(db, target_existing.id):
        batch_info = await _bot_batch_info(db, target_existing, info)
        return BinScanOutcome(result=BinScanResult.LOCKED, bin=info, batch=batch_info)

    if existing_batch is not None and await _batch_is_on_wip(db, existing_batch.id):
        batch_info = await _bot_batch_info(db, existing_batch, info)
        return BinScanOutcome(result=BinScanResult.LOCKED, bin=info, batch=batch_info)

    target_batch, _created = await _ensure_bot_batch(db, info)
    if await _batch_is_on_wip(db, target_batch.id):
        batch_info = await _bot_batch_info(db, target_batch, info)
        return BinScanOutcome(result=BinScanResult.LOCKED, bin=info, batch=batch_info)

    current_count = await _member_count(db, target_batch.id)
    if current_count >= BOT_BIN_MAX_MEMBERS:
        batch_info = await _bot_batch_info(db, target_batch, info)
        return BinScanOutcome(result=BinScanResult.BIN_IN_USE, bin=info, batch=batch_info)

    if existing_batch is not None and existing_batch.id != target_batch.id:
        await _remove_member(db, existing_batch, part, source="floor_move", to_batch_id=target_batch.id)
        db.add(
            FloorBinBatchEvent(
                batch_id=target_batch.id,
                action="member_moved",
                details={
                    "part_id": part.id,
                    "part_sticker": part.sticker_code,
                    "from_batch_id": existing_batch.id,
                    "from_bin_payload": existing_batch.bin_payload,
                    "source": "floor_move",
                },
            )
        )

    await _add_member(
        db,
        target_batch,
        part,
        source="floor_move" if existing_batch is not None else "floor_scan",
        from_batch_id=existing_batch.id if existing_batch is not None else None,
    )

    batch_info = await _bot_batch_info(db, target_batch, info)
    return BinScanOutcome(result=BinScanResult.RECORDED, bin=info, batch=batch_info)


async def resolve_bot_bin_for_flow(db: AsyncSession, payload: str) -> BinScanOutcome:
    info = await _resolve_bin(db, payload)
    if info is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    batch, status = await _latest_bot_batch_with_status(db, info)
    if batch is None or status in BIN_FREE_STATUSES:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info)
    if await _member_count(db, batch.id) <= 0 and status != "wip":
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info)
    return BinScanOutcome(
        result=BinScanResult.READY_FOR_QC,
        bin=info,
        batch=await _bot_batch_info(db, batch, info),
    )


async def scan_bot_bin_ready_for_production(
    db: AsyncSession, payload: str, *, source: str = "floor_scan"
) -> BinScanOutcome:
    outcome = await resolve_bot_bin_for_flow(db, payload)
    if outcome.batch is None:
        return outcome
    if outcome.batch.status == "ready_for_production":
        return BinScanOutcome(result=BinScanResult.ALREADY_READY_FOR_PRODUCTION, bin=outcome.bin, batch=outcome.batch)
    if outcome.batch.status == "wip":
        batch = await db.get(FloorBinBatch, outcome.batch.id)
        assert batch is not None
        db.add(
            FloorBinBatchEvent(
                batch_id=batch.id,
                action="ready_for_production",
                details={"source": source},
            )
        )
        await _record_bot_bin_staged(db, batch, source=source)
        await db.flush()
        batch = await db.get(FloorBinBatch, batch.id)
        assert batch is not None and outcome.bin is not None
        return BinScanOutcome(
            result=BinScanResult.READY_FOR_PRODUCTION_RECORDED,
            bin=outcome.bin,
            batch=await _bot_batch_info(db, batch, outcome.bin),
        )
    if outcome.batch.status != "loaded":
        return BinScanOutcome(result=BinScanResult.QC_REQUIRED, bin=outcome.bin, batch=outcome.batch)
    if outcome.batch.remaining_quantity <= 0:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=outcome.bin, batch=outcome.batch)
    batch = await db.get(FloorBinBatch, outcome.batch.id)
    assert batch is not None
    db.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="ready_for_production",
            details={"source": source},
        )
    )
    await _record_bot_bin_staged(db, batch, source=source)
    await db.flush()
    assert outcome.bin is not None
    return BinScanOutcome(
        result=BinScanResult.READY_FOR_PRODUCTION_RECORDED,
        bin=outcome.bin,
        batch=await _bot_batch_info(db, batch, outcome.bin),
    )


async def scan_bot_bin_wip(db: AsyncSession, payload: str) -> BinScanOutcome:
    outcome = await resolve_bot_bin_for_flow(db, payload)
    if outcome.batch is None:
        return outcome
    if outcome.batch.status == "wip":
        return BinScanOutcome(result=BinScanResult.ALREADY_WIP, bin=outcome.bin, batch=outcome.batch)
    if outcome.batch.status not in ("loaded", "ready_for_production"):
        return BinScanOutcome(result=BinScanResult.QC_REQUIRED, bin=outcome.bin, batch=outcome.batch)
    if outcome.batch.remaining_quantity <= 0:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=outcome.bin, batch=outcome.batch)

    occupied = await find_wip_bot_batch(db, exclude_batch_id=outcome.batch.id)
    if occupied is not None:
        return BinScanOutcome(result=BinScanResult.WIP_TYPE_OCCUPIED, bin=outcome.bin, batch=outcome.batch)

    batch = await db.get(FloorBinBatch, outcome.batch.id)
    assert batch is not None
    db.add(FloorBinBatchEvent(batch_id=batch.id, action="wip", details={"source": "floor_scan"}))
    members = (await db.execute(select(FloorBotBinMember.part_id).where(FloorBotBinMember.batch_id == batch.id))).all()
    for (part_id,) in members:
        db.add(
            FloorPartEvent(
                part_id=part_id,
                action=PRODUCTION_WIP_ACTION,
                details={"source": "bot_bin_wip", "batch_id": batch.id, "bin_payload": batch.bin_payload},
            )
        )
    await db.flush()
    assert outcome.bin is not None
    return BinScanOutcome(
        result=BinScanResult.WIP_RECORDED,
        bin=outcome.bin,
        batch=await _bot_batch_info(db, batch, outcome.bin),
    )


async def scan_bot_bin_empty(db: AsyncSession, payload: str, *, source: str = "floor_scan") -> BinScanOutcome:
    info = await _resolve_bin(db, payload)
    if info is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    batch, status = await _latest_bot_batch_with_status(db, info)
    if batch is None:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info)
    batch_info = await _bot_batch_info(db, batch, info)
    if status in BIN_FREE_STATUSES:
        return BinScanOutcome(result=BinScanResult.ALREADY_EMPTY, bin=info, batch=batch_info)
    if status != "wip":
        return BinScanOutcome(result=BinScanResult.EMPTY_REQUIRES_WIP, bin=info, batch=batch_info)
    if await _member_count(db, batch.id) > 0:
        return BinScanOutcome(result=BinScanResult.BIN_NOT_EMPTY, bin=info, batch=batch_info)
    db.add(FloorBinBatchEvent(batch_id=batch.id, action="empty", details={"source": source}))
    await db.flush()
    return BinScanOutcome(result=BinScanResult.EMPTY_RECORDED, bin=info, batch=await _bot_batch_info(db, batch, info))


async def scan_bot_bin_at_location(db: AsyncSession, payload: str, location_slug: str) -> BinScanOutcome:
    if location_slug == READY_FOR_PRODUCTION_LOCATION_SLUG:
        return await scan_bot_bin_ready_for_production(db, payload)
    if location_slug == PRODUCTION_WIP_LOCATION_SLUG:
        return await scan_bot_bin_wip(db, payload)
    if location_slug == BIN_EMPTY_LOCATION_SLUG:
        return await scan_bot_bin_empty(db, payload)
    return BinScanOutcome(result=BinScanResult.INVALID_CODE, bin=await _resolve_bin(db, payload))


async def consume_bot_bin_member_on_link(db: AsyncSession, part_id: int) -> tuple[int | None, bool]:
    """Remove a bottom from its BOT bin when linked. Returns (batch_id, empty_warning).

    Membership is always cleared so a bottom that reached WIP individually while
    still listed in a staged bin does not leave a stale row. The empty-bin
    warning and ``batch_id`` are returned only when the bin was on the line.
    """
    batch = await _get_member_batch(db, part_id)
    if batch is None:
        return None, False
    was_on_wip = await _batch_is_on_wip(db, batch.id)
    part = await db.get(FloorLabeledPart, part_id)
    if part is None:
        return None, False
    remaining = await _remove_member(db, batch, part, source="unit_link")
    empty_warning = was_on_wip and remaining == 0
    return (batch.id if was_on_wip else None), empty_warning


async def list_bot_bin_members(db: AsyncSession, batch_id: int) -> list[BotBinMemberInfo] | None:
    batch = await db.get(FloorBinBatch, batch_id)
    if batch is None or batch.part_code != BOT_BIN_PART_CODE:
        return None
    rows = (
        await db.execute(
            select(FloorBotBinMember, FloorLabeledPart.sticker_code, FloorLabeledPart.part_code)
            .join(FloorLabeledPart, FloorLabeledPart.id == FloorBotBinMember.part_id)
            .where(FloorBotBinMember.batch_id == batch_id)
            .order_by(FloorBotBinMember.added_at.asc(), FloorBotBinMember.id.asc())
        )
    ).all()
    return [
        BotBinMemberInfo(part_id=member.part_id, sticker_code=sticker, part_code=part_code, added_at=member.added_at)
        for member, sticker, part_code in rows
    ]


async def office_remove_bot_bin_member(db: AsyncSession, batch_id: int, part_id: int) -> BinScanOutcome:
    batch = await db.get(FloorBinBatch, batch_id)
    if batch is None or batch.part_code != BOT_BIN_PART_CODE:
        return BinScanOutcome(result=BinScanResult.NO_BATCH)
    info = await _resolve_bin(db, batch.bin_payload)
    if info is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    member = await db.scalar(
        select(FloorBotBinMember).where(
            FloorBotBinMember.batch_id == batch_id,
            FloorBotBinMember.part_id == part_id,
        )
    )
    if member is None:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info, batch=await _bot_batch_info(db, batch, info))
    part = await db.get(FloorLabeledPart, part_id)
    if part is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE, bin=info)
    remaining = await _remove_member(db, batch, part, source="office_override")
    batch_info = await _bot_batch_info(db, batch, info)
    return BinScanOutcome(
        result=BinScanResult.RECORDED,
        bin=info,
        batch=batch_info,
        empty_bin_warning=remaining == 0 and await _batch_is_on_wip(db, batch.id),
    )


async def office_bot_bin_ready_for_production(db: AsyncSession, payload: str) -> BinScanOutcome:
    """Office override: stage a loaded BOT bin, or return one from WIP to staged."""
    return await scan_bot_bin_ready_for_production(db, payload, source="office_override")


async def office_clear_bot_bin(db: AsyncSession, payload: str) -> BinScanOutcome:
    """Office override: remove every bottom from the fill and release the bin."""
    info = await _resolve_bin(db, payload)
    if info is None or info.part_code != BOT_BIN_PART_CODE:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE)
    batch, status = await _latest_bot_batch_with_status(db, info)
    if batch is None or status in BIN_FREE_STATUSES:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info)
    member_rows = (
        await db.execute(
            select(FloorBotBinMember, FloorLabeledPart)
            .join(FloorLabeledPart, FloorLabeledPart.id == FloorBotBinMember.part_id)
            .where(FloorBotBinMember.batch_id == batch.id)
        )
    ).all()
    cleared = 0
    for _member, part in member_rows:
        await _remove_member(db, batch, part, source="office_clear")
        cleared += 1
    db.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="empty",
            details={"source": "office_clear", "previous_status": status, "cleared_member_count": cleared},
        )
    )
    await db.flush()
    return BinScanOutcome(
        result=BinScanResult.EMPTY_RECORDED,
        bin=info,
        batch=await _bot_batch_info(db, batch, info),
    )


async def office_move_bot_bin_member(
    db: AsyncSession, batch_id: int, part_id: int, target_payload: str
) -> BinScanOutcome:
    batch = await db.get(FloorBinBatch, batch_id)
    if batch is None or batch.part_code != BOT_BIN_PART_CODE:
        return BinScanOutcome(result=BinScanResult.NO_BATCH)
    info = await _resolve_bin(db, batch.bin_payload)
    target_info = await _resolve_bin(db, target_payload)
    if info is None or target_info is None or target_info.part_code != BOT_BIN_PART_CODE:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE, bin=info)
    member = await db.scalar(
        select(FloorBotBinMember).where(
            FloorBotBinMember.batch_id == batch_id,
            FloorBotBinMember.part_id == part_id,
        )
    )
    if member is None:
        return BinScanOutcome(result=BinScanResult.NO_BATCH, bin=info, batch=await _bot_batch_info(db, batch, info))
    part = await db.get(FloorLabeledPart, part_id)
    if part is None:
        return BinScanOutcome(result=BinScanResult.INVALID_CODE, bin=info)
    target_batch, _ = await _ensure_bot_batch(db, target_info)
    if target_batch.id == batch.id:
        batch_info = await _bot_batch_info(db, batch, info)
        return BinScanOutcome(result=BinScanResult.RECORDED, bin=info, batch=batch_info)
    if await _member_count(db, target_batch.id) >= BOT_BIN_MAX_MEMBERS:
        return BinScanOutcome(
            result=BinScanResult.BIN_IN_USE,
            bin=target_info,
            batch=await _bot_batch_info(db, target_batch, target_info),
        )
    await _remove_member(db, batch, part, source="office_override", to_batch_id=target_batch.id)
    await _add_member(db, target_batch, part, source="office_override", from_batch_id=batch.id)
    source_remaining = await _member_count(db, batch.id)
    return BinScanOutcome(
        result=BinScanResult.RECORDED,
        bin=target_info,
        batch=await _bot_batch_info(db, target_batch, target_info),
        empty_bin_warning=source_remaining == 0 and await _batch_is_on_wip(db, batch.id),
    )


async def bot_bin_management_info(db: AsyncSession, info: BinInfo) -> BinManagementInfo:
    batch, status = await _latest_bot_batch_with_status(db, info)
    active = batch is not None and status not in BIN_FREE_STATUSES
    has_members = batch is not None and await _member_count(db, batch.id) > 0
    display_status = status if (active or has_members) and status else "available"
    if active and not has_members and status == "loaded":
        display_status = "available"
    return BinManagementInfo(
        bin=info,
        batch=await _bot_batch_info(db, batch, info) if batch is not None and (active or has_members) else None,
        status=display_status or "available",
    )


__all__ = [
    "BOT_BIN_MAX_MEMBERS",
    "BotBinMemberInfo",
    "add_part_to_bot_bin",
    "resolve_bot_bin_for_flow",
    "scan_bot_bin_at_location",
    "scan_bot_bin_empty",
    "scan_bot_bin_ready_for_production",
    "scan_bot_bin_wip",
    "consume_bot_bin_member_on_link",
    "find_wip_bot_batch",
    "list_bot_bin_members",
    "office_remove_bot_bin_member",
    "office_move_bot_bin_member",
    "office_bot_bin_ready_for_production",
    "office_clear_bot_bin",
    "bot_bin_management_info",
]
