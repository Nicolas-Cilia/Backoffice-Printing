"""Unit tests for Wave 2 Part Assembly Linking (product-serial unit linking).

Covers, at the service layer (same style as ``test_floor_kit.py``):

- Serial normalization/validation (six alphanumeric, at least one letter).
- Linking a serial to a TOP (In WIP with a kit) and a BOT (In WIP): a unit row
  is written, both housings get ``unit_linked`` then ``shipped`` events, and the
  lookup carries the four identities (top, bottom, knob batch, button batch).
- Refusals: bad serial, already-linked serial, TOP without a kit / not in WIP,
  BOT not in WIP, TOP+TOP / BOT+BOT, and a part already on another unit
  (no double-link).
- After a successful link the housings are ``shipped``: further item→location
  scans on those stickers are refused (lookup only).
- Unlink frees the serial and both stickers (``unit_unlinked`` then ``wip``) so
  the pair can be linked again.
"""

from __future__ import annotations

import pytest

from backend.app.services.floor_bins import resolve_bin_for_flow
from backend.app.services.floor_codes import station_for_slug
from backend.app.services.floor_parts import (
    PRODUCTION_WIP_LOCATION_SLUG,
    LocationScanResult,
    list_part_events,
    scan_fit_check_part,
    scan_harvest_printer,
    scan_part,
    scan_part_at_location,
)
from backend.app.services.floor_sessions import apply_station_scan
from backend.app.services.floor_units import (
    LinkUnitResult,
    ReadyUnitToShipResult,
    ReplaceUnitKitResult,
    ReplaceUnitResult,
    ReturnUnitToReworkResult,
    UnlinkUnitResult,
    get_unit_by_part,
    get_unit_by_serial,
    link_unit,
    list_unit_events,
    list_units,
    parse_serial,
    ready_unit_to_ship,
    replace_unit,
    replace_unit_kit,
    return_unit_to_rework,
    unlink_unit,
)
from backend.tests.unit.services.test_floor_kit import (
    BUT1,
    DEVICE_A,
    KNB1,
    KNB2,
    _bin_to_ready,
    _bin_to_wip,
    _top_ready_for_wip,
)

HARVEST = station_for_slug("harvest")


async def _top_in_wip_with_kit(db, printer_factory, archive_factory, code="BBD-000100"):
    """A TOP part In WIP with a knob + button kit assigned."""
    await _bin_to_wip(db, printer_factory, archive_factory, KNB1, quantity=10)
    await _bin_to_wip(db, printer_factory, archive_factory, BUT1, quantity=10)
    part = await _top_ready_for_wip(db, printer_factory, archive_factory, code=code)
    await scan_part_at_location(db, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
    await db.commit()
    return part


async def _bot_in_wip(db, printer_factory, archive_factory, code="BBD-000200"):
    """A BOT part In WIP (no kit — bottoms do not consume knob/button)."""
    printer = await printer_factory()
    await archive_factory(printer_id=printer.id)
    await apply_station_scan(db, HARVEST, DEVICE_A)
    await db.commit()
    await scan_harvest_printer(db, DEVICE_A, f"BBP-{printer.id}")
    await db.commit()
    outcome = await scan_part(db, DEVICE_A, code)
    outcome.part.part_code = "BOT"
    await db.commit()
    await apply_station_scan(db, HARVEST, DEVICE_A)  # close harvest
    await db.commit()
    await scan_fit_check_part(db, code)
    await db.commit()
    await scan_part_at_location(db, code, PRODUCTION_WIP_LOCATION_SLUG)
    await db.commit()
    return outcome.part


async def _bot_ready_only(db, printer_factory, archive_factory, code="BBD-000300"):
    """A BOT part that passed QC but never entered WIP (ineligible to link)."""
    printer = await printer_factory()
    await archive_factory(printer_id=printer.id)
    await apply_station_scan(db, HARVEST, DEVICE_A)
    await db.commit()
    await scan_harvest_printer(db, DEVICE_A, f"BBP-{printer.id}")
    await db.commit()
    outcome = await scan_part(db, DEVICE_A, code)
    outcome.part.part_code = "BOT"
    await db.commit()
    await apply_station_scan(db, HARVEST, DEVICE_A)
    await db.commit()
    await scan_fit_check_part(db, code)
    await db.commit()
    return outcome.part


class TestSerialFormat:
    @pytest.mark.parametrize(
        "raw",
        ["XG2SNP", "8TBDT9", "IX72HD", "XAKZM2", "GMUOQL", "OEQ0AC", "ME2O6N"],
    )
    def test_valid_serials_parse(self, raw):
        assert parse_serial(raw) == raw

    def test_trim_and_upper(self):
        assert parse_serial("  xg2snp \n") == "XG2SNP"

    @pytest.mark.parametrize(
        "raw",
        ["123456", "XG2SN", "XG2SNPQ", "BBD-000123", "ABC-12", ""],
    )
    def test_invalid_serials_rejected(self, raw):
        assert parse_serial(raw) is None


class TestLinkUnit:
    @pytest.mark.asyncio
    async def test_link_top_and_bottom_creates_unit_and_ships_both(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory)
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory)

        outcome = await link_unit(db_session, "XG2SNP", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        assert outcome.result is LinkUnitResult.LINKED
        assert outcome.unit is not None
        assert outcome.unit.serial_code == "XG2SNP"
        assert outcome.unit.top_sticker == top.sticker_code
        assert outcome.unit.bottom_sticker == bottom.sticker_code
        # Four identities: top, bottom, knob batch, button batch (from TOP kit).
        assert outcome.unit.knob_batch_id == top.kit_knob_batch_id
        assert outcome.unit.button_batch_id == top.kit_button_batch_id
        assert outcome.unit.knob_bin_payload == KNB1
        assert outcome.unit.button_bin_payload == BUT1

        top_actions = [e.action for e in await list_part_events(db_session, top.id)]
        bot_actions = [e.action for e in await list_part_events(db_session, bottom.id)]
        assert top_actions[-2:] == ["unit_linked", "shipped"]
        assert bot_actions[-2:] == ["unit_linked", "shipped"]

    @pytest.mark.asyncio
    async def test_link_either_order_maps_roles_by_part_code(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory)
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory)

        # Housings arrive top-then-bottom or bottom-then-top; the link call is
        # keyed on which sticker is the top and which is the bottom regardless.
        outcome = await link_unit(db_session, "8TBDT9", top.sticker_code, bottom.sticker_code)
        await db_session.commit()
        assert outcome.result is LinkUnitResult.LINKED

    @pytest.mark.asyncio
    async def test_invalid_serial_refused(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory)
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory)

        outcome = await link_unit(db_session, "123456", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        assert outcome.result is LinkUnitResult.INVALID_SERIAL
        assert await get_unit_by_serial(db_session, "123456") is None

    @pytest.mark.asyncio
    async def test_top_without_kit_refused(self, db_session, printer_factory, archive_factory):
        # A TOP In WIP but with no kit assigned is not eligible.
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=10)
        top = await _top_ready_for_wip(db_session, printer_factory, archive_factory, code="BBD-000400")
        # Never scanned into WIP, so kit_knob_batch_id / kit_button_batch_id stay null.
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory)

        outcome = await link_unit(db_session, "XG2SNP", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        assert outcome.result is LinkUnitResult.TOP_NOT_ELIGIBLE

    @pytest.mark.asyncio
    async def test_bottom_not_in_wip_refused(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory)
        bottom = await _bot_ready_only(db_session, printer_factory, archive_factory)

        outcome = await link_unit(db_session, "XG2SNP", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        assert outcome.result is LinkUnitResult.BOTTOM_NOT_ELIGIBLE

    @pytest.mark.asyncio
    async def test_top_top_refused(self, db_session, printer_factory, archive_factory):
        top1 = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000101")
        top2 = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000102")

        outcome = await link_unit(db_session, "XG2SNP", top1.sticker_code, top2.sticker_code)
        await db_session.commit()

        # The bottom slot got a TOP — not a BOT — so it is refused.
        assert outcome.result is LinkUnitResult.BOTTOM_NOT_ELIGIBLE
        assert await get_unit_by_serial(db_session, "XG2SNP") is None

    @pytest.mark.asyncio
    async def test_bot_bot_refused(self, db_session, printer_factory, archive_factory):
        bot1 = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000201")
        bot2 = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000202")

        outcome = await link_unit(db_session, "XG2SNP", bot1.sticker_code, bot2.sticker_code)
        await db_session.commit()

        assert outcome.result is LinkUnitResult.TOP_NOT_ELIGIBLE
        assert await get_unit_by_serial(db_session, "XG2SNP") is None

    @pytest.mark.asyncio
    async def test_same_sticker_for_both_refused(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory)

        outcome = await link_unit(db_session, "XG2SNP", top.sticker_code, top.sticker_code)
        await db_session.commit()

        assert outcome.result is LinkUnitResult.SAME_PART

    @pytest.mark.asyncio
    async def test_already_linked_serial_refused(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000110")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000210")
        await link_unit(db_session, "XG2SNP", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        top2 = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000111")
        bottom2 = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000211")
        outcome = await link_unit(db_session, "XG2SNP", top2.sticker_code, bottom2.sticker_code)
        await db_session.commit()

        assert outcome.result is LinkUnitResult.SERIAL_IN_USE

    @pytest.mark.asyncio
    async def test_no_double_link_of_a_part(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000120")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000220")
        await link_unit(db_session, "XG2SNP", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        # A fresh BOT tries to reuse the already-linked (now shipped) TOP.
        bottom2 = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000221")
        outcome = await link_unit(db_session, "ME2O6N", top.sticker_code, bottom2.sticker_code)
        await db_session.commit()

        # The TOP is shipped and already on a unit, so it cannot be linked again.
        assert outcome.result in (LinkUnitResult.TOP_ALREADY_LINKED, LinkUnitResult.TOP_NOT_ELIGIBLE)
        assert await get_unit_by_serial(db_session, "ME2O6N") is None


class TestLookup:
    @pytest.mark.asyncio
    async def test_by_serial_and_by_part(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000130")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000230")
        await link_unit(db_session, "IX72HD", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        by_serial = await get_unit_by_serial(db_session, "ix72hd")  # normalized
        assert by_serial is not None
        assert by_serial.serial_code == "IX72HD"

        by_top = await get_unit_by_part(db_session, top.sticker_code)
        by_bot = await get_unit_by_part(db_session, bottom.sticker_code)
        assert by_top is not None and by_top.serial_code == "IX72HD"
        assert by_bot is not None and by_bot.serial_code == "IX72HD"

    @pytest.mark.asyncio
    async def test_list_units(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000140")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000240")
        await link_unit(db_session, "XAKZM2", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        units = await list_units(db_session)
        assert any(u.serial_code == "XAKZM2" for u in units)


class TestShippedRefusesLocationScans:
    @pytest.mark.asyncio
    async def test_location_scan_refused_after_shipped(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000150")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000250")
        await link_unit(db_session, "GMUOQL", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        outcome = await scan_part_at_location(db_session, top.sticker_code, "ready-for-production-inventory")
        await db_session.commit()

        assert outcome.result is LocationScanResult.SHIPPED


class TestUnlink:
    @pytest.mark.asyncio
    async def test_unlink_frees_serial_and_restores_wip(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000160")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000260")
        linked = await link_unit(db_session, "OEQ0AC", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        outcome = await unlink_unit(db_session, linked.unit.id)
        await db_session.commit()

        assert outcome.result is UnlinkUnitResult.UNLINKED
        # Serial is free again.
        assert await get_unit_by_serial(db_session, "OEQ0AC") is None
        # Both housings dropped back to WIP with an audit trail.
        top_actions = [e.action for e in await list_part_events(db_session, top.id)]
        bot_actions = [e.action for e in await list_part_events(db_session, bottom.id)]
        assert top_actions[-2:] == ["unit_unlinked", "wip"]
        assert bot_actions[-2:] == ["unit_unlinked", "wip"]

    @pytest.mark.asyncio
    async def test_serial_can_be_linked_again_after_unlink(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000170")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000270")
        linked = await link_unit(db_session, "XG2SNP", top.sticker_code, bottom.sticker_code)
        await db_session.commit()
        await unlink_unit(db_session, linked.unit.id)
        await db_session.commit()

        # After unlink both parts are back In WIP (the TOP kept its kit), so the
        # same serial and the same housings link cleanly a second time.
        again = await link_unit(db_session, "XG2SNP", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        assert again.result is LinkUnitResult.LINKED

    @pytest.mark.asyncio
    async def test_unlink_unknown_unit(self, db_session):
        outcome = await unlink_unit(db_session, 999999)
        assert outcome.result is UnlinkUnitResult.NOT_FOUND


class TestListUnitEvents:
    @pytest.mark.asyncio
    async def test_merges_housing_mirrors_into_serial_timeline(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000170")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000270")
        linked = await link_unit(db_session, "OEQ0AC", top.sticker_code, bottom.sticker_code)
        await db_session.commit()
        assert linked.unit is not None

        await return_unit_to_rework(db_session, "OEQ0AC", "doesnt_fit", "Customer return")
        await db_session.commit()
        await ready_unit_to_ship(db_session, "OEQ0AC")
        await db_session.commit()

        events = await list_unit_events(db_session, linked.unit.id)
        assert events is not None
        actions = [event.action for event in events]
        # One of each mirrored step — not TOP+BOT duplicates, and no pre-link WIP/finishing.
        assert actions == ["unit_linked", "shipped", "rework", "shipped"]
        assert all(
            (event.details or {}).get("unit_id") == linked.unit.id
            or (event.details or {}).get("serial_code") == "OEQ0AC"
            for event in events
        )
        assert events[2].details is not None
        assert events[2].details.get("source") == "serial_return"
        assert events[3].details is not None
        assert events[3].details.get("source") == "serial_ready_to_ship"

        top_actions = [e.action for e in await list_part_events(db_session, top.id)]
        assert "wip" in top_actions  # housing history still has finishing/WIP
        assert "wip" not in actions

    @pytest.mark.asyncio
    async def test_keeps_history_after_housing_replace(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000171")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000271")
        linked = await link_unit(db_session, "ME2O6N", top.sticker_code, bottom.sticker_code)
        await db_session.commit()
        assert linked.unit is not None
        unit_id = linked.unit.id

        top2 = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000172")
        await replace_unit(db_session, unit_id, top_sticker=top2.sticker_code)
        await db_session.commit()

        events = await list_unit_events(db_session, unit_id)
        assert events is not None
        actions = [event.action for event in events]
        # Original link/ship on the old TOP must still appear after the swap.
        assert actions[0] == "unit_linked"
        assert actions[1] == "shipped"
        assert "unit_unlinked" in actions
        assert actions.count("unit_linked") >= 2
        assert any((event.details or {}).get("source") == "unit_replace" for event in events)

    @pytest.mark.asyncio
    async def test_unknown_unit_returns_none(self, db_session):
        assert await list_unit_events(db_session, 999_999) is None


class TestReturnUnitToRework:
    @pytest.mark.asyncio
    async def test_return_keeps_unit_linked_and_sends_both_housings_to_rework(
        self, db_session, printer_factory, archive_factory
    ):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000165")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000265")
        await link_unit(db_session, "OEQ0AC", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        outcome = await return_unit_to_rework(db_session, "OEQ0AC", "doesnt_fit", "Customer return")
        await db_session.commit()

        assert outcome.result is ReturnUnitToReworkResult.RETURNED
        unit = await get_unit_by_serial(db_session, "OEQ0AC")
        assert unit is not None
        assert unit.unit_workflow_status == "rework"
        top_actions = [e.action for e in await list_part_events(db_session, top.id)]
        bot_actions = [e.action for e in await list_part_events(db_session, bottom.id)]
        assert top_actions[-1] == "rework"
        assert bot_actions[-1] == "rework"

    @pytest.mark.asyncio
    async def test_return_unknown_serial(self, db_session):
        outcome = await return_unit_to_rework(db_session, "XG2SNP", "doesnt_fit")
        assert outcome.result is ReturnUnitToReworkResult.NOT_FOUND


class TestReadyUnitToShip:
    @pytest.mark.asyncio
    async def test_ready_restores_both_housings_to_shipped(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000166")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000266")
        await link_unit(db_session, "XG2SNP", top.sticker_code, bottom.sticker_code)
        await db_session.commit()
        await return_unit_to_rework(db_session, "XG2SNP", "other")
        await db_session.commit()

        outcome = await ready_unit_to_ship(db_session, "XG2SNP")
        await db_session.commit()

        assert outcome.result is ReadyUnitToShipResult.READY
        unit = await get_unit_by_serial(db_session, "XG2SNP")
        assert unit is not None
        assert unit.unit_workflow_status == "shipped"
        top_actions = [e.action for e in await list_part_events(db_session, top.id)]
        bot_actions = [e.action for e in await list_part_events(db_session, bottom.id)]
        assert top_actions[-1] == "shipped"
        assert bot_actions[-1] == "shipped"

    @pytest.mark.asyncio
    async def test_ready_is_idempotent_when_already_shipped(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000167")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000267")
        await link_unit(db_session, "ME2O6N", top.sticker_code, bottom.sticker_code)
        await db_session.commit()
        await return_unit_to_rework(db_session, "ME2O6N", "other")
        await db_session.commit()
        await ready_unit_to_ship(db_session, "ME2O6N")
        await db_session.commit()

        outcome = await ready_unit_to_ship(db_session, "ME2O6N")
        assert outcome.result is ReadyUnitToShipResult.ALREADY_READY


class TestReplace:
    """Wave 3 replace: swap one housing of a linked unit for another eligible
    housing, keeping the serial. The new housing is unit_linked+shipped, the old
    is unit_unlinked+wip (so it can be reused), and the unit stays linked."""

    @pytest.mark.asyncio
    async def test_replace_top_keeps_serial_and_reships(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000300")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000400")
        linked = await link_unit(db_session, "XG2SNP", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        top2 = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000301")

        outcome = await replace_unit(db_session, linked.unit.id, top_sticker=top2.sticker_code)
        await db_session.commit()

        assert outcome.result is ReplaceUnitResult.REPLACED
        assert outcome.unit is not None
        # Serial is unchanged, the top is now the new housing.
        assert outcome.unit.serial_code == "XG2SNP"
        assert outcome.unit.top_sticker == top2.sticker_code
        assert outcome.unit.bottom_sticker == bottom.sticker_code
        # Kit is now read back from the new TOP.
        assert outcome.unit.knob_batch_id == top2.kit_knob_batch_id
        assert outcome.unit.button_batch_id == top2.kit_button_batch_id

        # New housing re-shipped; old housing freed back to WIP.
        new_actions = [e.action for e in await list_part_events(db_session, top2.id)]
        old_actions = [e.action for e in await list_part_events(db_session, top.id)]
        assert new_actions[-2:] == ["unit_linked", "shipped"]
        assert old_actions[-2:] == ["unit_unlinked", "wip"]

    @pytest.mark.asyncio
    async def test_replace_bottom_keeps_serial(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000310")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000410")
        linked = await link_unit(db_session, "8TBDT9", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        bottom2 = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000411")

        outcome = await replace_unit(db_session, linked.unit.id, bottom_sticker=bottom2.sticker_code)
        await db_session.commit()

        assert outcome.result is ReplaceUnitResult.REPLACED
        assert outcome.unit.bottom_sticker == bottom2.sticker_code
        assert outcome.unit.top_sticker == top.sticker_code
        new_actions = [e.action for e in await list_part_events(db_session, bottom2.id)]
        old_actions = [e.action for e in await list_part_events(db_session, bottom.id)]
        assert new_actions[-2:] == ["unit_linked", "shipped"]
        assert old_actions[-2:] == ["unit_unlinked", "wip"]

    @pytest.mark.asyncio
    async def test_replace_unknown_unit(self, db_session):
        outcome = await replace_unit(db_session, 999999, top_sticker="BBD-000999")
        assert outcome.result is ReplaceUnitResult.NOT_FOUND

    @pytest.mark.asyncio
    async def test_replace_nothing_provided_is_no_change(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000320")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000420")
        linked = await link_unit(db_session, "IX72HD", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        outcome = await replace_unit(db_session, linked.unit.id)
        await db_session.commit()

        assert outcome.result is ReplaceUnitResult.NO_CHANGE

    @pytest.mark.asyncio
    async def test_replace_top_not_eligible(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000330")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000430")
        linked = await link_unit(db_session, "XAKZM2", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        # A TOP that passed QC but never entered WIP: no kit, not In WIP.
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=10)
        top2 = await _top_ready_for_wip(db_session, printer_factory, archive_factory, code="BBD-000331")

        outcome = await replace_unit(db_session, linked.unit.id, top_sticker=top2.sticker_code)
        await db_session.commit()

        assert outcome.result is ReplaceUnitResult.TOP_NOT_ELIGIBLE
        # Nothing changed — the original top is still the housing.
        again = await get_unit_by_serial(db_session, "XAKZM2")
        assert again.top_sticker == top.sticker_code

    @pytest.mark.asyncio
    async def test_replace_bottom_not_eligible(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000340")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000440")
        linked = await link_unit(db_session, "GMUOQL", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        bottom2 = await _bot_ready_only(db_session, printer_factory, archive_factory, code="BBD-000441")

        outcome = await replace_unit(db_session, linked.unit.id, bottom_sticker=bottom2.sticker_code)
        await db_session.commit()

        assert outcome.result is ReplaceUnitResult.BOTTOM_NOT_ELIGIBLE

    @pytest.mark.asyncio
    async def test_replace_top_already_on_another_unit(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000350")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000450")
        linked = await link_unit(db_session, "OEQ0AC", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        top2 = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000351")
        bottom2 = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000451")
        await link_unit(db_session, "ME2O6N", top2.sticker_code, bottom2.sticker_code)
        await db_session.commit()

        outcome = await replace_unit(db_session, linked.unit.id, top_sticker=top2.sticker_code)
        await db_session.commit()

        assert outcome.result is ReplaceUnitResult.TOP_ALREADY_LINKED

    @pytest.mark.asyncio
    async def test_replaced_old_housing_can_be_reused(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000360")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000460")
        linked = await link_unit(db_session, "XG2SNP", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        top2 = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000361")
        await replace_unit(db_session, linked.unit.id, top_sticker=top2.sticker_code)
        await db_session.commit()

        # The freed old top is In WIP again and links cleanly into a new unit.
        bottom2 = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000461")
        again = await link_unit(db_session, "8TBDT9", top.sticker_code, bottom2.sticker_code)
        await db_session.commit()

        assert again.result is LinkUnitResult.LINKED


@pytest.mark.asyncio
class TestReplaceUnitKit:
    async def test_replace_knob_onto_ready_harvest(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000370")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000470")
        linked = await link_unit(db_session, "XG2SNP", top.sticker_code, bottom.sticker_code)
        await db_session.commit()
        old_knob = linked.unit.knob_batch_id

        await _bin_to_ready(db_session, printer_factory, archive_factory, KNB2, quantity=5)
        knb2 = await resolve_bin_for_flow(db_session, KNB2)
        assert knb2.batch is not None

        outcome = await replace_unit_kit(db_session, linked.unit.id, "KNB", knb2.batch.id)
        await db_session.commit()

        assert outcome.result is ReplaceUnitKitResult.REPLACED
        assert outcome.unit is not None
        assert outcome.unit.knob_batch_id == knb2.batch.id
        assert outcome.unit.knob_batch_id != old_knob
        assert outcome.unit.button_batch_id == linked.unit.button_batch_id
        assert outcome.new_remaining == 4

    async def test_replace_kit_unknown_unit(self, db_session):
        outcome = await replace_unit_kit(db_session, 999999, "KNB", 1)
        assert outcome.result is ReplaceUnitKitResult.NOT_FOUND

    async def test_replace_kit_refuses_ineligible_batch(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory, code="BBD-000371")
        bottom = await _bot_in_wip(db_session, printer_factory, archive_factory, code="BBD-000471")
        linked = await link_unit(db_session, "8TBDT9", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        # Button fill id used as a knob target — wrong type → no_target.
        outcome = await replace_unit_kit(db_session, linked.unit.id, "KNB", linked.unit.button_batch_id)
        assert outcome.result is ReplaceUnitKitResult.NO_TARGET
