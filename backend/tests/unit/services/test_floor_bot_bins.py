"""Unit tests for shared BOT bin membership and staging."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.models.floor_bin import FloorBotBinMember
from backend.app.services.floor_bins import (
    BIN_EMPTY_LOCATION_SLUG,
    PRODUCTION_WIP_LOCATION_SLUG,
    READY_FOR_PRODUCTION_LOCATION_SLUG,
    BinScanResult,
    bin_payload,
    scan_bin_at_location,
)
from backend.app.services.floor_bot_bins import (
    BOT_BIN_MAX_MEMBERS,
    add_part_to_bot_bin,
    list_bot_bin_members,
    office_bot_bin_ready_for_production,
    office_clear_bot_bin,
    office_move_bot_bin_member,
    office_remove_bot_bin_member,
    scan_bot_bin_wip,
)
from backend.app.services.floor_codes import station_for_slug
from backend.app.services.floor_parts import (
    LocationScanResult,
    scan_fit_check_part,
    scan_harvest_printer,
    scan_part,
    scan_part_at_location,
    scan_rework_part,
    scan_sanding_part,
)
from backend.app.services.floor_sessions import apply_station_scan
from backend.app.services.floor_units import LinkUnitResult, link_unit
from backend.tests.unit.services.test_floor_kit import (
    BUT1,
    DEVICE_A,
    KNB1,
    _bin_to_wip,
    _top_ready_for_wip,
)

HARVEST = station_for_slug("harvest")
BOT1 = bin_payload("BOT", 1)
BOT2 = bin_payload("BOT", 2)


async def _bot_part_with_qc(db, printer_factory, archive_factory, code="BBD-000210"):
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


async def _top_in_wip_with_kit(db, printer_factory, archive_factory, code="BBD-000100"):
    await _bin_to_wip(db, printer_factory, archive_factory, KNB1, quantity=10)
    await _bin_to_wip(db, printer_factory, archive_factory, BUT1, quantity=10)
    part = await _top_ready_for_wip(db, printer_factory, archive_factory, code=code)
    await scan_part_at_location(db, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
    await db.commit()
    return part


class TestBotBinLoadFlow:
    @pytest.mark.asyncio
    async def test_add_bot_part_to_bin(self, db_session, printer_factory, archive_factory):
        part = await _bot_part_with_qc(db_session, printer_factory, archive_factory)

        outcome = await add_part_to_bot_bin(db_session, part.sticker_code, BOT1)
        await db_session.commit()

        assert outcome.result is BinScanResult.RECORDED
        assert outcome.batch is not None
        assert outcome.batch.remaining_quantity == 1
        members = await list_bot_bin_members(db_session, outcome.batch.id)
        assert members is not None
        assert len(members) == 1
        assert members[0].sticker_code == part.sticker_code

    @pytest.mark.asyncio
    async def test_add_without_qc_is_refused(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await apply_station_scan(db_session, HARVEST, DEVICE_A)
        await db_session.commit()
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()
        outcome = await scan_part(db_session, DEVICE_A, "BBD-000211")
        outcome.part.part_code = "BOT"
        await db_session.commit()

        result = await add_part_to_bot_bin(db_session, "BBD-000211", BOT1)
        await db_session.commit()

        assert result.result is BinScanResult.QC_REQUIRED

    @pytest.mark.asyncio
    async def test_sanding_without_refit_is_refused_at_wip(self, db_session, printer_factory, archive_factory):
        part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000212")
        await scan_sanding_part(db_session, part.sticker_code, "rough_surface")
        await db_session.commit()

        wip = await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        assert wip.result is LocationScanResult.QC_REQUIRED

    @pytest.mark.asyncio
    async def test_move_between_bins_when_not_on_wip(self, db_session, printer_factory, archive_factory):
        part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000213")
        await add_part_to_bot_bin(db_session, part.sticker_code, BOT1)
        await db_session.commit()

        moved = await add_part_to_bot_bin(db_session, part.sticker_code, BOT2)
        await db_session.commit()

        assert moved.result is BinScanResult.RECORDED
        assert moved.batch is not None
        assert moved.batch.payload == BOT2
        members = await list_bot_bin_members(db_session, moved.batch.id)
        assert members is not None
        assert len(members) == 1

    @pytest.mark.asyncio
    async def test_cannot_add_when_target_bin_on_wip(self, db_session, printer_factory, archive_factory):
        part_a = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000214")
        part_b = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000215")
        await add_part_to_bot_bin(db_session, part_a.sticker_code, BOT1)
        await db_session.commit()
        await scan_bin_at_location(db_session, BOT1, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        locked = await add_part_to_bot_bin(db_session, part_b.sticker_code, BOT1)
        await db_session.commit()

        assert locked.result is BinScanResult.LOCKED

    @pytest.mark.asyncio
    async def test_bin_full_at_max_members(self, db_session, printer_factory, archive_factory):
        for index in range(BOT_BIN_MAX_MEMBERS):
            part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code=f"BBD-{220 + index:06d}")
            outcome = await add_part_to_bot_bin(db_session, part.sticker_code, BOT1)
            await db_session.commit()
            assert outcome.result is BinScanResult.RECORDED

        extra = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000299")
        full = await add_part_to_bot_bin(db_session, extra.sticker_code, BOT1)
        await db_session.commit()

        assert full.result is BinScanResult.BIN_IN_USE


class TestBotBinStaging:
    @pytest.mark.asyncio
    async def test_ready_for_production_then_wip_bulk_events(self, db_session, printer_factory, archive_factory):
        part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000301")
        await add_part_to_bot_bin(db_session, part.sticker_code, BOT1)
        await db_session.commit()

        ready = await scan_bin_at_location(db_session, BOT1, READY_FOR_PRODUCTION_LOCATION_SLUG)
        await db_session.commit()
        wip = await scan_bin_at_location(db_session, BOT1, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        assert ready.result is BinScanResult.READY_FOR_PRODUCTION_RECORDED
        assert wip.result is BinScanResult.WIP_RECORDED
        assert wip.batch is not None
        assert wip.batch.status == "wip"

        individual = await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()
        assert individual.result is LocationScanResult.ALREADY_AT_LOCATION

    @pytest.mark.asyncio
    async def test_only_one_bot_bin_on_wip_line(self, db_session, printer_factory, archive_factory):
        part_a = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000302")
        part_b = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000303")
        await add_part_to_bot_bin(db_session, part_a.sticker_code, BOT1)
        await add_part_to_bot_bin(db_session, part_b.sticker_code, BOT2)
        await db_session.commit()
        await scan_bot_bin_wip(db_session, BOT1)
        await db_session.commit()

        blocked = await scan_bot_bin_wip(db_session, BOT2)
        await db_session.commit()

        assert blocked.result is BinScanResult.WIP_TYPE_OCCUPIED

    @pytest.mark.asyncio
    async def test_empty_requires_wip(self, db_session, printer_factory, archive_factory):
        part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000304")
        await add_part_to_bot_bin(db_session, part.sticker_code, BOT1)
        await db_session.commit()

        refused = await scan_bin_at_location(db_session, BOT1, BIN_EMPTY_LOCATION_SLUG)
        await db_session.commit()
        assert refused.result is BinScanResult.EMPTY_REQUIRES_WIP

        await scan_bin_at_location(db_session, BOT1, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory)
        await link_unit(db_session, "ABC126", top.sticker_code, part.sticker_code)
        await db_session.commit()
        emptied = await scan_bin_at_location(db_session, BOT1, BIN_EMPTY_LOCATION_SLUG)
        await db_session.commit()
        assert emptied.result is BinScanResult.EMPTY_RECORDED

    @pytest.mark.asyncio
    async def test_empty_refused_while_members_remain(self, db_session, printer_factory, archive_factory):
        part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000309")
        load = await add_part_to_bot_bin(db_session, part.sticker_code, BOT1)
        await db_session.commit()
        await scan_bin_at_location(db_session, BOT1, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        refused = await scan_bin_at_location(db_session, BOT1, BIN_EMPTY_LOCATION_SLUG)
        await db_session.commit()

        assert refused.result is BinScanResult.BIN_NOT_EMPTY
        members = await list_bot_bin_members(db_session, load.batch.id)
        assert members is not None
        assert len(members) == 1


class TestBotBinLinkConsume:
    @pytest.mark.asyncio
    async def test_link_removes_bottom_from_wip_bot_bin(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory)
        bottom = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000305")
        load = await add_part_to_bot_bin(db_session, bottom.sticker_code, BOT1)
        await db_session.commit()
        batch_id = load.batch.id
        await scan_bin_at_location(db_session, BOT1, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        outcome = await link_unit(db_session, "ABC123", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        assert outcome.result is LinkUnitResult.LINKED
        assert outcome.empty_bin_warning is True
        assert outcome.bot_bin_payload == BOT1
        members = (
            await db_session.scalars(select(FloorBotBinMember).where(FloorBotBinMember.batch_id == batch_id))
        ).all()
        assert members == []

    @pytest.mark.asyncio
    async def test_move_to_full_bin_keeps_source_member(self, db_session, printer_factory, archive_factory):
        for index in range(BOT_BIN_MAX_MEMBERS):
            part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code=f"BBD-{330 + index:06d}")
            await add_part_to_bot_bin(db_session, part.sticker_code, BOT2)
            await db_session.commit()

        mover = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000399")
        load = await add_part_to_bot_bin(db_session, mover.sticker_code, BOT1)
        await db_session.commit()
        source_batch_id = load.batch.id

        blocked = await add_part_to_bot_bin(db_session, mover.sticker_code, BOT2)
        await db_session.commit()

        assert blocked.result is BinScanResult.BIN_IN_USE
        source_members = await list_bot_bin_members(db_session, source_batch_id)
        assert source_members is not None
        assert len(source_members) == 1
        assert source_members[0].sticker_code == mover.sticker_code

    @pytest.mark.asyncio
    async def test_link_clears_staged_bin_membership_after_individual_wip(
        self, db_session, printer_factory, archive_factory
    ):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory)
        bottom = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000310")
        load = await add_part_to_bot_bin(db_session, bottom.sticker_code, BOT1)
        await db_session.commit()
        batch_id = load.batch.id
        await scan_part_at_location(db_session, bottom.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        outcome = await link_unit(db_session, "ABC125", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        assert outcome.result is LinkUnitResult.LINKED
        assert outcome.empty_bin_warning is False
        members = (
            await db_session.scalars(select(FloorBotBinMember).where(FloorBotBinMember.batch_id == batch_id))
        ).all()
        assert members == []

    @pytest.mark.asyncio
    async def test_individual_wip_bottom_unaffected(self, db_session, printer_factory, archive_factory):
        top = await _top_in_wip_with_kit(db_session, printer_factory, archive_factory)
        bottom = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000306")
        await scan_part_at_location(db_session, bottom.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        outcome = await link_unit(db_session, "ABC124", top.sticker_code, bottom.sticker_code)
        await db_session.commit()

        assert outcome.result is LinkUnitResult.LINKED
        assert outcome.empty_bin_warning is False
        assert outcome.bot_bin_payload is None


class TestBotBinOfficeOverrides:
    @pytest.mark.asyncio
    async def test_office_remove_from_wip_bin(self, db_session, printer_factory, archive_factory):
        part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000307")
        load = await add_part_to_bot_bin(db_session, part.sticker_code, BOT1)
        await db_session.commit()
        await scan_bin_at_location(db_session, BOT1, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        removed = await office_remove_bot_bin_member(db_session, load.batch.id, part.id)
        await db_session.commit()

        assert removed.result is BinScanResult.RECORDED
        assert removed.empty_bin_warning is True

    @pytest.mark.asyncio
    async def test_office_move_from_wip_bin(self, db_session, printer_factory, archive_factory):
        part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000308")
        load = await add_part_to_bot_bin(db_session, part.sticker_code, BOT1)
        await db_session.commit()
        await scan_bin_at_location(db_session, BOT1, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        moved = await office_move_bot_bin_member(db_session, load.batch.id, part.id, BOT2)
        await db_session.commit()

        assert moved.result is BinScanResult.RECORDED
        assert moved.bin is not None
        assert moved.bin.payload == BOT2
        assert moved.empty_bin_warning is True

    @pytest.mark.asyncio
    async def test_office_remove_from_loaded_bin(self, db_session, printer_factory, archive_factory):
        part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000309")
        load = await add_part_to_bot_bin(db_session, part.sticker_code, BOT1)
        await db_session.commit()

        removed = await office_remove_bot_bin_member(db_session, load.batch.id, part.id)
        await db_session.commit()

        assert removed.result is BinScanResult.RECORDED
        assert removed.empty_bin_warning is False
        assert await list_bot_bin_members(db_session, load.batch.id) == []

    @pytest.mark.asyncio
    async def test_office_stage_loaded_bin(self, db_session, printer_factory, archive_factory):
        part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000310")
        await add_part_to_bot_bin(db_session, part.sticker_code, BOT1)
        await db_session.commit()

        staged = await office_bot_bin_ready_for_production(db_session, BOT1)
        await db_session.commit()

        assert staged.result is BinScanResult.READY_FOR_PRODUCTION_RECORDED
        assert staged.batch is not None
        assert staged.batch.status == "ready_for_production"

    @pytest.mark.asyncio
    async def test_office_return_wip_bin_to_staged(self, db_session, printer_factory, archive_factory):
        part = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000311")
        await add_part_to_bot_bin(db_session, part.sticker_code, BOT1)
        await db_session.commit()
        await scan_bot_bin_wip(db_session, BOT1)
        await db_session.commit()

        returned = await office_bot_bin_ready_for_production(db_session, BOT1)
        await db_session.commit()

        assert returned.result is BinScanResult.READY_FOR_PRODUCTION_RECORDED
        assert returned.batch is not None
        assert returned.batch.status == "ready_for_production"

    @pytest.mark.asyncio
    async def test_office_clear_bot_bin(self, db_session, printer_factory, archive_factory):
        part_a = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000312")
        part_b = await _bot_part_with_qc(db_session, printer_factory, archive_factory, code="BBD-000313")
        load = await add_part_to_bot_bin(db_session, part_a.sticker_code, BOT1)
        await add_part_to_bot_bin(db_session, part_b.sticker_code, BOT1)
        await db_session.commit()

        cleared = await office_clear_bot_bin(db_session, BOT1)
        await db_session.commit()

        assert cleared.result is BinScanResult.EMPTY_RECORDED
        assert cleared.batch is not None
        assert cleared.batch.status == "empty"
        assert await list_bot_bin_members(db_session, load.batch.id) == []
