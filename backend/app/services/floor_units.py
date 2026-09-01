"""Product-unit linking: bind a scanned serial to a TOP + BOT housing pair.

Part Assembly Linking (docs/floor-workflow.md, Wave 2). The kiosk ceremony is:
scan an unlinked product serial, then park a TOP or a BOT housing, then scan the
other housing — at which point ``link_unit`` writes the unit and ships both
housings. This module is the commit + lookup half; the pending "which housing is
parked" state lives in the scan page's local state, exactly like Fit Check /
Rework (see ``floor_parts``'s item→location note).

Serial shape (§4): exactly six alphanumeric characters after strip+upper, with
at least one letter — ``^[A-Z0-9]{6}$`` plus ``[A-Z]``. All-numeric barcodes and
hyphenated floor codes never match, so a serial can never collide with a
``BBD-`` sticker.

Eligibility to link:
- TOP: In WIP (current status ``wip``) **with a kit assigned** (both
  ``kit_knob_batch_id`` and ``kit_button_batch_id`` set).
- BOT: In WIP.
- Neither already on another unit (also guarded by the unique FKs).

On a successful link both housings get ``unit_linked`` then ``shipped`` events;
after that, item→location scans on their stickers are refused (see
``floor_parts._resolve_part_for_location``). Unlink deletes the unit, freeing the
serial and both stickers, and writes ``unit_unlinked`` then ``wip`` so the pair
can be linked again.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.floor_bin import FloorBinBatch
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent
from backend.app.models.floor_unit import FloorProductUnit
from backend.app.services.floor_bot_bins import consume_bot_bin_member_on_link
from backend.app.services.floor_parts import (
    BOT_PART_CODE,
    PRODUCTION_WIP_ACTION,
    TOP_PART_CODE,
    KitReassignResult,
    PartStatus,
    _error_label_for_payload,
    _get_part_by_code,
    _part_current_status,
    parse_sticker_code,
    reassign_kit_by_batch_id,
)

# §4: six alphanumeric, no hyphen, at least one letter — after strip + upper.
_SERIAL_PATTERN = re.compile(r"^[A-Z0-9]{6}$")


def parse_serial(raw: str) -> str | None:
    """Validate + normalize a product serial, or ``None`` if malformed (§4).

    Strip + uppercase, then require exactly six alphanumeric characters with at
    least one letter. All-numeric barcodes (filament SKUs) and hyphenated floor
    codes fail this, so they fall through to the caller's existing handling
    rather than being mistaken for a serial.
    """
    if raw is None:
        return None
    code = raw.strip().upper()
    if not _SERIAL_PATTERN.match(code):
        return None
    if not any(ch.isalpha() for ch in code):
        return None
    return code


class LinkUnitResult(StrEnum):
    """What a ``link_unit`` request did."""

    LINKED = "linked"
    INVALID_SERIAL = "invalid_serial"
    SERIAL_IN_USE = "serial_in_use"
    TOP_NOT_FOUND = "top_not_found"
    BOTTOM_NOT_FOUND = "bottom_not_found"
    SAME_PART = "same_part"
    # The top slot is not a TOP In WIP with a kit (a BOT in the top slot, a TOP
    # not in WIP, or a TOP with no kit). Covers the BOT+BOT case for the top.
    TOP_NOT_ELIGIBLE = "top_not_eligible"
    # The bottom slot is not a BOT In WIP. Covers the TOP+TOP case for the bottom.
    BOTTOM_NOT_ELIGIBLE = "bottom_not_eligible"
    TOP_ALREADY_LINKED = "top_already_linked"
    BOTTOM_ALREADY_LINKED = "bottom_already_linked"


class UnlinkUnitResult(StrEnum):
    """What an ``unlink_unit`` request did."""

    UNLINKED = "unlinked"
    NOT_FOUND = "not_found"


class ReplaceUnitResult(StrEnum):
    """What a ``replace_unit`` request did (Wave 3).

    Replacing swaps one housing of a still-linked unit for another eligible
    housing, keeping the serial. Refusals mirror ``link_unit``'s vocabulary so
    the kiosk/office can reuse the same messaging.
    """

    REPLACED = "replaced"
    NOT_FOUND = "not_found"
    # Neither a new top nor a new bottom was supplied (or the supplied sticker
    # already is that housing) — nothing to do.
    NO_CHANGE = "no_change"
    TOP_NOT_FOUND = "top_not_found"
    BOTTOM_NOT_FOUND = "bottom_not_found"
    SAME_PART = "same_part"
    TOP_NOT_ELIGIBLE = "top_not_eligible"
    BOTTOM_NOT_ELIGIBLE = "bottom_not_eligible"
    TOP_ALREADY_LINKED = "top_already_linked"
    BOTTOM_ALREADY_LINKED = "bottom_already_linked"


@dataclass(frozen=True)
class UnitDetail:
    """A linked product unit, with the four identities the kiosk shows.

    ``knob_*`` / ``button_*`` are read back from the TOP part's kit FKs, so a
    unit always reports which bin fills its knob and button were drawn from.
    """

    id: int
    serial_code: str
    top_part_id: int
    bottom_part_id: int
    top_sticker: str
    bottom_sticker: str
    top_part_code: str | None
    bottom_part_code: str | None
    knob_batch_id: int | None
    button_batch_id: int | None
    knob_bin_payload: str | None
    button_bin_payload: str | None
    linked_at: datetime


@dataclass(frozen=True)
class LinkUnitOutcome:
    result: LinkUnitResult
    unit: UnitDetail | None = None
    empty_bin_warning: bool = False
    bot_bin_payload: str | None = None


@dataclass(frozen=True)
class UnlinkUnitOutcome:
    result: UnlinkUnitResult
    unit_id: int | None = None
    serial_code: str | None = None


@dataclass(frozen=True)
class ReplaceUnitOutcome:
    result: ReplaceUnitResult
    unit: UnitDetail | None = None
    empty_bin_warning: bool = False
    bot_bin_payload: str | None = None


async def _bin_payload_for_batch(db: AsyncSession, batch_id: int | None) -> str | None:
    if batch_id is None:
        return None
    batch = await db.get(FloorBinBatch, batch_id)
    return batch.bin_payload if batch is not None else None


async def _detail_from_unit(db: AsyncSession, unit: FloorProductUnit) -> UnitDetail:
    top = await db.get(FloorLabeledPart, unit.top_part_id)
    bottom = await db.get(FloorLabeledPart, unit.bottom_part_id)
    # The kit is the TOP part's — a BOT never carries one.
    knob_batch_id = top.kit_knob_batch_id if top is not None else None
    button_batch_id = top.kit_button_batch_id if top is not None else None
    return UnitDetail(
        id=unit.id,
        serial_code=unit.serial_code,
        top_part_id=unit.top_part_id,
        bottom_part_id=unit.bottom_part_id,
        top_sticker=top.sticker_code if top is not None else "",
        bottom_sticker=bottom.sticker_code if bottom is not None else "",
        top_part_code=top.part_code if top is not None else None,
        bottom_part_code=bottom.part_code if bottom is not None else None,
        knob_batch_id=knob_batch_id,
        button_batch_id=button_batch_id,
        knob_bin_payload=await _bin_payload_for_batch(db, knob_batch_id),
        button_bin_payload=await _bin_payload_for_batch(db, button_batch_id),
        linked_at=unit.linked_at,
    )


async def _unit_row_for_part(db: AsyncSession, part_id: int) -> FloorProductUnit | None:
    return await db.scalar(
        select(FloorProductUnit).where(
            (FloorProductUnit.top_part_id == part_id) | (FloorProductUnit.bottom_part_id == part_id)
        )
    )


async def _is_in_wip(db: AsyncSession, part: FloorLabeledPart) -> bool:
    return await _part_current_status(db, part.id) == PRODUCTION_WIP_ACTION


async def link_unit(db: AsyncSession, serial: str, top_sticker: str, bottom_sticker: str) -> LinkUnitOutcome:
    """Bind a product serial to a TOP + BOT housing pair, shipping both (§5).

    Refuses (writing nothing) on: a malformed serial, an already-linked serial,
    an unknown TOP/BOT sticker, the same sticker twice, a housing already on
    another unit, or an ineligible housing (top not a TOP In WIP with a kit;
    bottom not a BOT In WIP — which is how TOP+TOP and BOT+BOT are rejected).
    """
    normalized = parse_serial(serial)
    if normalized is None:
        return LinkUnitOutcome(result=LinkUnitResult.INVALID_SERIAL)

    if await db.scalar(select(FloorProductUnit).where(FloorProductUnit.serial_code == normalized)) is not None:
        return LinkUnitOutcome(result=LinkUnitResult.SERIAL_IN_USE)

    top_code = parse_sticker_code(top_sticker)
    top = await _get_part_by_code(db, top_code) if top_code is not None else None
    if top is None:
        return LinkUnitOutcome(result=LinkUnitResult.TOP_NOT_FOUND)

    bottom_code = parse_sticker_code(bottom_sticker)
    bottom = await _get_part_by_code(db, bottom_code) if bottom_code is not None else None
    if bottom is None:
        return LinkUnitOutcome(result=LinkUnitResult.BOTTOM_NOT_FOUND)

    if top.id == bottom.id:
        return LinkUnitOutcome(result=LinkUnitResult.SAME_PART)

    if await _unit_row_for_part(db, top.id) is not None:
        return LinkUnitOutcome(result=LinkUnitResult.TOP_ALREADY_LINKED)
    if await _unit_row_for_part(db, bottom.id) is not None:
        return LinkUnitOutcome(result=LinkUnitResult.BOTTOM_ALREADY_LINKED)

    # Top slot: a TOP part, In WIP, with a kit assigned. A BOT here (BOT+BOT)
    # fails the part-code check; a TOP not in WIP or with no kit fails the rest.
    top_part_code = (top.part_code or "").strip().upper()
    top_eligible = (
        top_part_code == TOP_PART_CODE
        and await _is_in_wip(db, top)
        and top.kit_knob_batch_id is not None
        and top.kit_button_batch_id is not None
    )
    if not top_eligible:
        return LinkUnitOutcome(result=LinkUnitResult.TOP_NOT_ELIGIBLE)

    # Bottom slot: a BOT part, In WIP. A TOP here (TOP+TOP) fails the part-code
    # check and is rejected as BOTTOM_NOT_ELIGIBLE.
    bottom_part_code = (bottom.part_code or "").strip().upper()
    bottom_eligible = bottom_part_code == BOT_PART_CODE and await _is_in_wip(db, bottom)
    if not bottom_eligible:
        return LinkUnitOutcome(result=LinkUnitResult.BOTTOM_NOT_ELIGIBLE)

    unit = FloorProductUnit(
        serial_code=normalized,
        top_part_id=top.id,
        bottom_part_id=bottom.id,
    )
    db.add(unit)
    await db.flush()

    for part in (top, bottom):
        db.add(
            FloorPartEvent(
                part_id=part.id,
                action="unit_linked",
                details={
                    "unit_id": unit.id,
                    "serial_code": normalized,
                    "top_sticker": top.sticker_code,
                    "bottom_sticker": bottom.sticker_code,
                    "role": "top" if part.id == top.id else "bottom",
                    "kit_knob_batch_id": top.kit_knob_batch_id,
                    "kit_button_batch_id": top.kit_button_batch_id,
                    "knob_bin_payload": await _bin_payload_for_batch(db, top.kit_knob_batch_id),
                    "button_bin_payload": await _bin_payload_for_batch(db, top.kit_button_batch_id),
                },
            )
        )
        db.add(
            FloorPartEvent(
                part_id=part.id,
                action=PartStatus.SHIPPED.value,
                details={"unit_id": unit.id, "serial_code": normalized},
            )
        )
    await db.flush()

    _bot_batch_id, empty_bin_warning = await consume_bot_bin_member_on_link(db, bottom.id)
    bot_bin_payload = await _bin_payload_for_batch(db, _bot_batch_id)

    return LinkUnitOutcome(
        result=LinkUnitResult.LINKED,
        unit=await _detail_from_unit(db, unit),
        empty_bin_warning=empty_bin_warning,
        bot_bin_payload=bot_bin_payload,
    )


async def get_unit_by_serial(db: AsyncSession, serial: str) -> UnitDetail | None:
    """Look up a linked unit by product serial (idle already-linked scan)."""
    normalized = parse_serial(serial)
    if normalized is None:
        return None
    unit = await db.scalar(select(FloorProductUnit).where(FloorProductUnit.serial_code == normalized))
    return await _detail_from_unit(db, unit) if unit is not None else None


async def get_unit_by_part(db: AsyncSession, sticker: str) -> UnitDetail | None:
    """Look up the unit a TOP/BOT sticker belongs to, if any (idle part scan)."""
    code = parse_sticker_code(sticker)
    if code is None:
        return None
    part = await _get_part_by_code(db, code)
    if part is None:
        return None
    unit = await _unit_row_for_part(db, part.id)
    return await _detail_from_unit(db, unit) if unit is not None else None


async def list_units(db: AsyncSession) -> list[UnitDetail]:
    """Every linked unit, newest first — the minimum Wave 3 needs."""
    units = (
        (
            await db.execute(
                select(FloorProductUnit).order_by(FloorProductUnit.linked_at.desc(), FloorProductUnit.id.desc())
            )
        )
        .scalars()
        .all()
    )
    return [await _detail_from_unit(db, unit) for unit in units]


async def unlink_unit(db: AsyncSession, unit_id: int) -> UnlinkUnitOutcome:
    """Reverse a link: free the serial + both stickers, restore both to WIP.

    Deletes the unit row (a serial can be re-used once its unit is gone) and
    writes ``unit_unlinked`` then ``wip`` on each housing, so both parts drop
    back to In WIP and can be linked again. The TOP keeps its kit FKs, so a
    re-link needs no re-consume.
    """
    unit = await db.get(FloorProductUnit, unit_id)
    if unit is None:
        return UnlinkUnitOutcome(result=UnlinkUnitResult.NOT_FOUND)

    serial_code = unit.serial_code
    top_part_id = unit.top_part_id
    bottom_part_id = unit.bottom_part_id
    await db.delete(unit)
    await db.flush()

    for part_id in (top_part_id, bottom_part_id):
        db.add(
            FloorPartEvent(
                part_id=part_id,
                action="unit_unlinked",
                details={"unit_id": unit_id, "serial_code": serial_code},
            )
        )
        db.add(
            FloorPartEvent(
                part_id=part_id,
                action=PRODUCTION_WIP_ACTION,
                details={"source": "unit_unlink"},
            )
        )
    await db.flush()

    return UnlinkUnitOutcome(result=UnlinkUnitResult.UNLINKED, unit_id=unit_id, serial_code=serial_code)


async def _resolve_eligible_top(
    db: AsyncSession, sticker: str
) -> tuple[FloorLabeledPart | None, ReplaceUnitResult | None]:
    """Resolve a new TOP sticker and check it is a TOP In WIP with a kit, on no
    other unit. Returns ``(part, None)`` when eligible, else ``(None, reason)``."""
    code = parse_sticker_code(sticker)
    part = await _get_part_by_code(db, code) if code is not None else None
    if part is None:
        return None, ReplaceUnitResult.TOP_NOT_FOUND
    if await _unit_row_for_part(db, part.id) is not None:
        return None, ReplaceUnitResult.TOP_ALREADY_LINKED
    part_code = (part.part_code or "").strip().upper()
    eligible = (
        part_code == TOP_PART_CODE
        and await _is_in_wip(db, part)
        and part.kit_knob_batch_id is not None
        and part.kit_button_batch_id is not None
    )
    if not eligible:
        return None, ReplaceUnitResult.TOP_NOT_ELIGIBLE
    return part, None


async def _resolve_eligible_bottom(
    db: AsyncSession, sticker: str
) -> tuple[FloorLabeledPart | None, ReplaceUnitResult | None]:
    """Resolve a new BOT sticker and check it is a BOT In WIP, on no other unit."""
    code = parse_sticker_code(sticker)
    part = await _get_part_by_code(db, code) if code is not None else None
    if part is None:
        return None, ReplaceUnitResult.BOTTOM_NOT_FOUND
    if await _unit_row_for_part(db, part.id) is not None:
        return None, ReplaceUnitResult.BOTTOM_ALREADY_LINKED
    part_code = (part.part_code or "").strip().upper()
    if not (part_code == BOT_PART_CODE and await _is_in_wip(db, part)):
        return None, ReplaceUnitResult.BOTTOM_NOT_ELIGIBLE
    return part, None


def _swap_housing_events(
    db: AsyncSession, unit_id: int, serial: str, old_part_id: int, new_part: FloorLabeledPart, role: str
) -> None:
    """Free the old housing (``unit_unlinked`` → ``wip``) and re-ship the new one
    (``unit_linked`` → ``shipped``), tagging both with the replace context."""
    db.add(
        FloorPartEvent(
            part_id=old_part_id,
            action="unit_unlinked",
            details={"unit_id": unit_id, "serial_code": serial, "source": "unit_replace", "role": role},
        )
    )
    db.add(
        FloorPartEvent(
            part_id=old_part_id,
            action=PRODUCTION_WIP_ACTION,
            details={"source": "unit_replace"},
        )
    )
    db.add(
        FloorPartEvent(
            part_id=new_part.id,
            action="unit_linked",
            details={"unit_id": unit_id, "serial_code": serial, "source": "unit_replace", "role": role},
        )
    )
    db.add(
        FloorPartEvent(
            part_id=new_part.id,
            action=PartStatus.SHIPPED.value,
            details={"unit_id": unit_id, "serial_code": serial, "source": "unit_replace"},
        )
    )


async def replace_unit(
    db: AsyncSession,
    unit_id: int,
    top_sticker: str | None = None,
    bottom_sticker: str | None = None,
) -> ReplaceUnitOutcome:
    """Swap one (or both) housing of a linked unit for another eligible housing.

    The serial is kept. Each new housing must satisfy the same eligibility as a
    fresh link (new TOP: In WIP with a kit; new BOT: In WIP; neither already on
    another unit). The old housing is freed back to In WIP (``unit_unlinked`` →
    ``wip``) so it can be reused, while the new housing is re-shipped
    (``unit_linked`` → ``shipped``); the unit stays linked throughout. Refuses
    (writing nothing) on any ineligible/unknown housing, leaving the unit as-is.
    """
    unit = await db.get(FloorProductUnit, unit_id)
    if unit is None:
        return ReplaceUnitOutcome(result=ReplaceUnitResult.NOT_FOUND)

    # Resolve each requested slot, treating "already this housing" as no change.
    new_top: FloorLabeledPart | None = None
    if top_sticker is not None:
        top_code = parse_sticker_code(top_sticker)
        maybe_top = await _get_part_by_code(db, top_code) if top_code is not None else None
        if maybe_top is not None and maybe_top.id == unit.top_part_id:
            new_top = None  # unchanged
        else:
            new_top, reason = await _resolve_eligible_top(db, top_sticker)
            if reason is not None:
                return ReplaceUnitOutcome(result=reason)

    new_bottom: FloorLabeledPart | None = None
    if bottom_sticker is not None:
        bottom_code = parse_sticker_code(bottom_sticker)
        maybe_bottom = await _get_part_by_code(db, bottom_code) if bottom_code is not None else None
        if maybe_bottom is not None and maybe_bottom.id == unit.bottom_part_id:
            new_bottom = None  # unchanged
        else:
            new_bottom, reason = await _resolve_eligible_bottom(db, bottom_sticker)
            if reason is not None:
                return ReplaceUnitOutcome(result=reason)

    if new_top is None and new_bottom is None:
        return ReplaceUnitOutcome(result=ReplaceUnitResult.NO_CHANGE)

    # A housing cannot be both slots, nor collide with the housing it is not
    # replacing (e.g. a new top equal to the current/new bottom).
    resulting_top_id = new_top.id if new_top is not None else unit.top_part_id
    resulting_bottom_id = new_bottom.id if new_bottom is not None else unit.bottom_part_id
    if resulting_top_id == resulting_bottom_id:
        return ReplaceUnitOutcome(result=ReplaceUnitResult.SAME_PART)

    serial = unit.serial_code
    empty_bin_warning = False
    bot_bin_payload: str | None = None
    if new_top is not None:
        _swap_housing_events(db, unit.id, serial, unit.top_part_id, new_top, "top")
        unit.top_part_id = new_top.id
    if new_bottom is not None:
        _swap_housing_events(db, unit.id, serial, unit.bottom_part_id, new_bottom, "bottom")
        unit.bottom_part_id = new_bottom.id
        _bot_batch_id, empty_bin_warning = await consume_bot_bin_member_on_link(db, new_bottom.id)
        bot_bin_payload = await _bin_payload_for_batch(db, _bot_batch_id)
    await db.flush()

    return ReplaceUnitOutcome(
        result=ReplaceUnitResult.REPLACED,
        unit=await _detail_from_unit(db, unit),
        empty_bin_warning=empty_bin_warning,
        bot_bin_payload=bot_bin_payload,
    )


class ReturnUnitToReworkResult(StrEnum):
    """What a ``return_unit_to_rework`` request did."""

    RETURNED = "returned"
    NOT_FOUND = "not_found"
    INVALID_SERIAL = "invalid_serial"
    NOT_SHIPPED = "not_shipped"
    INVALID_REASON = "invalid_reason"


class ReplaceUnitKitResult(StrEnum):
    """What a ``replace_unit_kit`` request did (Serials knob/button harvest swap)."""

    REPLACED = "replaced"
    NOT_FOUND = "not_found"
    NO_KIT = "no_kit"
    INVALID_SLOT = "invalid_slot"
    NO_TARGET = "no_target"


@dataclass(frozen=True)
class ReplaceUnitKitOutcome:
    result: ReplaceUnitKitResult
    unit: UnitDetail | None = None
    slot: str | None = None
    previous_batch_id: int | None = None
    new_batch_id: int | None = None
    previous_remaining: int | None = None
    new_remaining: int | None = None


@dataclass(frozen=True)
class ReturnUnitToReworkOutcome:
    result: ReturnUnitToReworkResult
    unit_id: int | None = None
    serial_code: str | None = None
    top_sticker: str | None = None
    bottom_sticker: str | None = None
    reason: str | None = None


async def _return_unit_parts_to_rework(
    db: AsyncSession,
    unit: FloorProductUnit,
    *,
    rework_details: dict,
    reason_display: str | None,
) -> ReturnUnitToReworkOutcome:
    """Unlink a shipped unit and write ``rework`` on both housings."""
    top = await db.get(FloorLabeledPart, unit.top_part_id)
    bottom = await db.get(FloorLabeledPart, unit.bottom_part_id)
    if top is None or bottom is None:
        return ReturnUnitToReworkOutcome(result=ReturnUnitToReworkResult.NOT_FOUND)

    for part in (top, bottom):
        if await _part_current_status(db, part.id) != PartStatus.SHIPPED.value:
            return ReturnUnitToReworkOutcome(result=ReturnUnitToReworkResult.NOT_SHIPPED)

    unit_id = unit.id
    serial_code = unit.serial_code
    top_sticker = top.sticker_code
    bottom_sticker = bottom.sticker_code
    top_part_id = unit.top_part_id
    bottom_part_id = unit.bottom_part_id

    await db.delete(unit)
    await db.flush()

    unlink_details = {"unit_id": unit_id, "serial_code": serial_code, "source": "serial_return"}
    for part_id in (top_part_id, bottom_part_id):
        db.add(
            FloorPartEvent(
                part_id=part_id,
                action="unit_unlinked",
                details=unlink_details,
            )
        )
        db.add(
            FloorPartEvent(
                part_id=part_id,
                action=PartStatus.REWORK.value,
                details=rework_details,
            )
        )
    await db.flush()

    return ReturnUnitToReworkOutcome(
        result=ReturnUnitToReworkResult.RETURNED,
        unit_id=unit_id,
        serial_code=serial_code,
        top_sticker=top_sticker,
        bottom_sticker=bottom_sticker,
        reason=reason_display,
    )


async def return_unit_to_rework(
    db: AsyncSession,
    serial: str,
    reason_code: str,
    reason_text: str | None = None,
) -> ReturnUnitToReworkOutcome:
    """Return a linked (shipped) unit to WIP Rework via its product serial."""
    normalized = parse_serial(serial)
    if normalized is None:
        return ReturnUnitToReworkOutcome(result=ReturnUnitToReworkResult.INVALID_SERIAL)

    unit = await db.scalar(select(FloorProductUnit).where(FloorProductUnit.serial_code == normalized))
    if unit is None:
        return ReturnUnitToReworkOutcome(result=ReturnUnitToReworkResult.NOT_FOUND)

    rework_details = {
        "reason_code": reason_code,
        "reason_text": reason_text,
        "source": "serial_return",
        "serial_code": normalized,
    }
    return await _return_unit_parts_to_rework(
        db,
        unit,
        rework_details=rework_details,
        reason_display=reason_text or reason_code,
    )


async def return_unit_to_rework_error(
    db: AsyncSession,
    serial: str,
    error_payload: str,
    reason_text: str | None = None,
) -> ReturnUnitToReworkOutcome:
    """Return a shipped unit to WIP Rework using a user-managed error label."""
    normalized = parse_serial(serial)
    if normalized is None:
        return ReturnUnitToReworkOutcome(result=ReturnUnitToReworkResult.INVALID_SERIAL)

    unit = await db.scalar(select(FloorProductUnit).where(FloorProductUnit.serial_code == normalized))
    if unit is None:
        return ReturnUnitToReworkOutcome(result=ReturnUnitToReworkResult.NOT_FOUND)

    label = await _error_label_for_payload(db, error_payload)
    if label is None:
        return ReturnUnitToReworkOutcome(result=ReturnUnitToReworkResult.INVALID_REASON)

    rework_details = {
        "error_label_id": label.id,
        "error_payload": f"BBF-{label.slug}",
        "error_name": label.name,
        "reason_text": reason_text,
        "source": "serial_return",
        "serial_code": normalized,
    }
    return await _return_unit_parts_to_rework(
        db,
        unit,
        rework_details=rework_details,
        reason_display=reason_text or label.name,
    )


async def replace_unit_kit(
    db: AsyncSession,
    unit_id: int,
    slot: str,
    batch_id: int,
) -> ReplaceUnitKitOutcome:
    """Move a linked unit's knob or button kit slot onto a specific harvest fill.

    The kit FKs live on the TOP housing; this is the office Serials path that
    picks any past/current eligible ``FloorBinBatch`` by id (remaining > 0,
    In WIP or Ready-for-Production, matching slot type) rather than scanning a
    live bin. Restores +1 on the previous fill and consumes −1 on the new one,
    same inventory rules as floor kit reassign.
    """
    unit = await db.get(FloorProductUnit, unit_id)
    if unit is None:
        return ReplaceUnitKitOutcome(result=ReplaceUnitKitResult.NOT_FOUND)

    top = await db.get(FloorLabeledPart, unit.top_part_id)
    if top is None:
        return ReplaceUnitKitOutcome(result=ReplaceUnitKitResult.NOT_FOUND)

    outcome = await reassign_kit_by_batch_id(db, top.sticker_code, slot, batch_id)
    if outcome.result is KitReassignResult.NO_KIT:
        return ReplaceUnitKitOutcome(result=ReplaceUnitKitResult.NO_KIT)
    if outcome.result is KitReassignResult.INVALID_BIN:
        return ReplaceUnitKitOutcome(result=ReplaceUnitKitResult.INVALID_SLOT)
    if outcome.result is KitReassignResult.NO_TARGET:
        return ReplaceUnitKitOutcome(result=ReplaceUnitKitResult.NO_TARGET)
    if outcome.result is not KitReassignResult.REASSIGNED:
        return ReplaceUnitKitOutcome(result=ReplaceUnitKitResult.NOT_FOUND)

    # Re-read unit after the TOP's kit FKs moved.
    refreshed = await db.get(FloorProductUnit, unit_id)
    if refreshed is None:
        return ReplaceUnitKitOutcome(result=ReplaceUnitKitResult.NOT_FOUND)
    return ReplaceUnitKitOutcome(
        result=ReplaceUnitKitResult.REPLACED,
        unit=await _detail_from_unit(db, refreshed),
        slot=outcome.slot,
        previous_batch_id=outcome.previous_batch_id,
        new_batch_id=outcome.new_batch_id,
        previous_remaining=outcome.previous_remaining,
        new_remaining=outcome.new_remaining,
    )


__all__ = [
    "parse_serial",
    "LinkUnitResult",
    "UnlinkUnitResult",
    "ReplaceUnitResult",
    "ReplaceUnitKitResult",
    "ReturnUnitToReworkResult",
    "UnitDetail",
    "LinkUnitOutcome",
    "UnlinkUnitOutcome",
    "ReplaceUnitOutcome",
    "ReplaceUnitKitOutcome",
    "ReturnUnitToReworkOutcome",
    "link_unit",
    "get_unit_by_serial",
    "get_unit_by_part",
    "list_units",
    "unlink_unit",
    "replace_unit",
    "replace_unit_kit",
    "return_unit_to_rework",
    "return_unit_to_rework_error",
]
