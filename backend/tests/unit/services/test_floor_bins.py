"""Unit tests for the reusable-bin item→location pipeline.

The bin half of the universal scan-item-then-location flow: Initial QC gates
Production WIP, Ready-for-Production Inventory is an optional stop in between
that is never itself a WIP prerequisite, and Empty Bin only releases a fill
that actually reached WIP. These exercise the services directly, the same
style as ``test_floor_parts.py``.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.models.floor_bin import FloorBinBatch, FloorBinBatchEvent
from backend.app.services.floor_bins import (
    BIN_EMPTY_LOCATION_SLUG,
    PRODUCTION_WIP_LOCATION_SLUG,
    READY_FOR_PRODUCTION_LOCATION_SLUG,
    BinScanResult,
    archive_bin_batch,
    assign_bin_manually,
    delete_bin_batch,
    list_bin_batch_events,
    list_floor_bin_history,
    list_floor_bin_management,
    scan_bin_at_location,
    scan_bin_empty,
    scan_bin_fit_check,
    scan_bin_ready_for_production,
    scan_bin_wip,
    scan_harvest_bin,
    unlink_bin,
)
from backend.app.services.floor_codes import station_for_slug
from backend.app.services.floor_sessions import apply_station_scan

DEVICE_A = "device-a"
HARVEST = station_for_slug("harvest")


async def _fill_bin(db_session, printer_factory, archive_factory, payload="BBN-KNB-1", quantity=10):
    """Harvest one bin fill via the printer-info entry point, then close the
    harvest session so a later location scan is not "inside" harvest."""
    printer = await printer_factory()
    await archive_factory(printer_id=printer.id)
    await scan_harvest_bin(db_session, DEVICE_A, payload, printer_id_hint=printer.id)
    await db_session.commit()
    await scan_harvest_bin(db_session, DEVICE_A, payload, quantity=quantity)
    await db_session.commit()
    await apply_station_scan(db_session, HARVEST, DEVICE_A)
    await db_session.commit()
    return payload


async def _pass_qc(db_session, payload, passed_quantity=10):
    outcome = await scan_bin_fit_check(db_session, payload, passed_quantity)
    await db_session.commit()
    return outcome


class TestBinLocationPipeline:
    @pytest.mark.asyncio
    async def test_wip_without_qc_is_refused(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)

        outcome = await scan_bin_wip(db_session, payload)
        await db_session.commit()

        assert outcome.result is BinScanResult.QC_REQUIRED

    @pytest.mark.asyncio
    async def test_qc_then_wip_is_allowed(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)
        await _pass_qc(db_session, payload)

        outcome = await scan_bin_wip(db_session, payload)
        await db_session.commit()

        assert outcome.result is BinScanResult.WIP_RECORDED

    @pytest.mark.asyncio
    async def test_ready_for_production_requires_qc(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)

        outcome = await scan_bin_ready_for_production(db_session, payload)
        await db_session.commit()

        assert outcome.result is BinScanResult.QC_REQUIRED

    @pytest.mark.asyncio
    async def test_qc_then_ready_for_production_then_wip(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)
        await _pass_qc(db_session, payload)

        ready = await scan_bin_ready_for_production(db_session, payload)
        await db_session.commit()
        wip = await scan_bin_wip(db_session, payload)
        await db_session.commit()

        assert ready.result is BinScanResult.READY_FOR_PRODUCTION_RECORDED
        assert wip.result is BinScanResult.WIP_RECORDED

    @pytest.mark.asyncio
    async def test_ready_for_production_is_idempotent(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)
        await _pass_qc(db_session, payload)
        await scan_bin_ready_for_production(db_session, payload)
        await db_session.commit()

        again = await scan_bin_ready_for_production(db_session, payload)
        await db_session.commit()

        assert again.result is BinScanResult.ALREADY_READY_FOR_PRODUCTION

    @pytest.mark.asyncio
    async def test_wip_then_ready_for_production_is_allowed(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)
        await _pass_qc(db_session, payload)
        await scan_bin_wip(db_session, payload)
        await db_session.commit()

        ready = await scan_bin_ready_for_production(db_session, payload)
        await db_session.commit()

        assert ready.result is BinScanResult.READY_FOR_PRODUCTION_RECORDED
        assert ready.batch.status == "ready_for_production"

    @pytest.mark.asyncio
    async def test_fit_check_does_not_reopen_qc_on_a_staged_bin(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)
        await _pass_qc(db_session, payload)
        await scan_bin_wip(db_session, payload)
        await db_session.commit()
        await scan_bin_ready_for_production(db_session, payload)
        await db_session.commit()

        again = await scan_bin_fit_check(db_session, payload, passed_quantity=10)
        await db_session.commit()

        assert again.result is BinScanResult.QC_RECORDED
        assert again.batch.status == "ready_for_production"

    @pytest.mark.asyncio
    async def test_wip_then_ready_then_wip_again_is_allowed(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)
        await _pass_qc(db_session, payload)
        await scan_bin_wip(db_session, payload)
        await db_session.commit()
        await scan_bin_ready_for_production(db_session, payload)
        await db_session.commit()

        wip = await scan_bin_wip(db_session, payload)
        await db_session.commit()

        assert wip.result is BinScanResult.WIP_RECORDED
        assert wip.batch.status == "wip"

    @pytest.mark.asyncio
    async def test_empty_without_wip_is_refused(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)
        await _pass_qc(db_session, payload)

        outcome = await scan_bin_empty(db_session, payload)
        await db_session.commit()

        assert outcome.result is BinScanResult.EMPTY_REQUIRES_WIP

    @pytest.mark.asyncio
    async def test_wip_then_empty_releases_the_bin(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)
        await _pass_qc(db_session, payload)
        await scan_bin_wip(db_session, payload)
        await db_session.commit()

        outcome = await scan_bin_empty(db_session, payload)
        await db_session.commit()

        assert outcome.result is BinScanResult.EMPTY_RECORDED
        assert outcome.batch.remaining_quantity == 0


class TestBinLocationDispatch:
    @pytest.mark.asyncio
    async def test_dispatches_each_bin_location(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)
        await _pass_qc(db_session, payload)

        ready = await scan_bin_at_location(db_session, payload, READY_FOR_PRODUCTION_LOCATION_SLUG)
        await db_session.commit()
        wip = await scan_bin_at_location(db_session, payload, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()
        empty = await scan_bin_at_location(db_session, payload, BIN_EMPTY_LOCATION_SLUG)
        await db_session.commit()

        assert ready.result is BinScanResult.READY_FOR_PRODUCTION_RECORDED
        assert wip.result is BinScanResult.WIP_RECORDED
        assert empty.result is BinScanResult.EMPTY_RECORDED

    @pytest.mark.asyncio
    async def test_unknown_location_is_invalid(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory)

        outcome = await scan_bin_at_location(db_session, payload, "support-removal")
        await db_session.commit()

        assert outcome.result is BinScanResult.INVALID_CODE


class TestDeleteBinBatch:
    @pytest.mark.asyncio
    async def test_refuses_active_fill(self, db_session, printer_factory, archive_factory):
        await _fill_bin(db_session, printer_factory, archive_factory, quantity=12)
        batch_id = (await list_floor_bin_history(db_session))[0].batch.id

        assert await delete_bin_batch(db_session, batch_id) == "active"
        assert await db_session.get(FloorBinBatch, batch_id) is not None

    @pytest.mark.asyncio
    async def test_deletes_after_archive(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory, quantity=12)
        history = await list_floor_bin_history(db_session)
        assert len(history) == 1
        batch_id = history[0].batch.id
        events = await list_bin_batch_events(db_session, batch_id)
        assert events is not None
        assert len(events) >= 1

        await _pass_qc(db_session, payload, passed_quantity=12)
        await scan_bin_wip(db_session, payload)
        await db_session.commit()
        await scan_bin_empty(db_session, payload)
        await db_session.commit()

        assert await archive_bin_batch(db_session, batch_id, archived=True) == "ok"
        await db_session.commit()

        assert await delete_bin_batch(db_session, batch_id) == "deleted"
        await db_session.commit()

        assert await list_floor_bin_history(db_session) == []
        assert await list_bin_batch_events(db_session, batch_id) is None
        assert await db_session.get(FloorBinBatch, batch_id) is None
        remaining_events = (
            (await db_session.execute(select(FloorBinBatchEvent).where(FloorBinBatchEvent.batch_id == batch_id)))
            .scalars()
            .all()
        )
        assert remaining_events == []

    @pytest.mark.asyncio
    async def test_deletes_depleted_fill(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory, quantity=4)
        await _pass_qc(db_session, payload, passed_quantity=4)
        await scan_bin_wip(db_session, payload)
        await db_session.commit()
        await scan_bin_empty(db_session, payload)
        await db_session.commit()
        batch_id = (await list_floor_bin_history(db_session))[0].batch.id

        assert await delete_bin_batch(db_session, batch_id) == "deleted"
        await db_session.commit()
        assert await db_session.get(FloorBinBatch, batch_id) is None

    @pytest.mark.asyncio
    async def test_missing_batch_returns_not_found(self, db_session):
        assert await delete_bin_batch(db_session, 999_999) == "not_found"


class TestArchiveBinBatch:
    @pytest.mark.asyncio
    async def test_refuses_stocked_linked_fill(self, db_session, printer_factory, archive_factory):
        await _fill_bin(db_session, printer_factory, archive_factory, quantity=8)
        batch_id = (await list_floor_bin_history(db_session))[0].batch.id

        assert await archive_bin_batch(db_session, batch_id, archived=True) == "in_use"
        batch = await db_session.get(FloorBinBatch, batch_id)
        assert batch is not None
        assert batch.archived_at is None

    @pytest.mark.asyncio
    async def test_archive_after_empty_frees_tote_for_reuse(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory, quantity=8)
        batch_id = (await list_floor_bin_history(db_session))[0].batch.id
        await _pass_qc(db_session, payload, passed_quantity=8)
        await scan_bin_wip(db_session, payload)
        await db_session.commit()
        await scan_bin_empty(db_session, payload)
        await db_session.commit()

        assert await archive_bin_batch(db_session, batch_id, archived=True) == "ok"
        await db_session.commit()
        batch = await db_session.get(FloorBinBatch, batch_id)
        assert batch is not None
        assert batch.archived_at is not None

        # Physical tote can take a new harvest fill while the old row stays in history.
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        prompt = await scan_harvest_bin(db_session, DEVICE_A, payload, printer_id_hint=printer.id)
        await db_session.commit()
        assert prompt.result is BinScanResult.READY_FOR_QUANTITY

        recorded = await scan_harvest_bin(db_session, DEVICE_A, payload, quantity=5)
        await db_session.commit()
        assert recorded.result is BinScanResult.RECORDED
        history = await list_floor_bin_history(db_session)
        assert len(history) == 2
        assert any(item.batch and item.batch.id == batch_id and item.batch.archived_at for item in history)

    @pytest.mark.asyncio
    async def test_restore_clears_archived_at(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory, quantity=3)
        batch_id = (await list_floor_bin_history(db_session))[0].batch.id
        await _pass_qc(db_session, payload, passed_quantity=3)
        await scan_bin_wip(db_session, payload)
        await db_session.commit()
        await scan_bin_empty(db_session, payload)
        await db_session.commit()

        assert await archive_bin_batch(db_session, batch_id, archived=True) == "ok"
        await db_session.commit()

        assert await archive_bin_batch(db_session, batch_id, archived=False) == "ok"
        await db_session.commit()
        restored = await db_session.get(FloorBinBatch, batch_id)
        assert restored is not None
        assert restored.archived_at is None


class TestAssignBinManually:
    @pytest.mark.asyncio
    async def test_assigns_free_bin_without_archive(self, db_session, printer_factory):
        printer = await printer_factory()

        outcome = await assign_bin_manually(db_session, "BBN-KNB-2", printer.id, quantity=42)
        await db_session.commit()

        assert outcome.result is BinScanResult.RECORDED
        assert outcome.batch is not None
        assert outcome.batch.quantity == 42
        assert outcome.batch.remaining_quantity == 42
        assert outcome.batch.printer is not None
        assert outcome.batch.printer.id == printer.id
        assert outcome.batch.archive is None
        assert outcome.batch.part_code == "KNB"
        assert outcome.batch.status == "harvested"

        managed = await list_floor_bin_management(db_session)
        assigned = next(item for item in managed if item.bin.payload == "BBN-KNB-2")
        assert assigned.batch is not None
        assert assigned.batch.quantity == 42

        events = await list_bin_batch_events(db_session, outcome.batch.id)
        assert events is not None
        assert events[0].action == "harvested"
        assert events[0].details["source"] == "inventory_manual"

    @pytest.mark.asyncio
    async def test_refuses_occupied_bin(self, db_session, printer_factory, archive_factory):
        await _fill_bin(db_session, printer_factory, archive_factory, payload="BBN-BUT-1", quantity=5)
        printer = await printer_factory()

        outcome = await assign_bin_manually(db_session, "BBN-BUT-1", printer.id, quantity=8)
        await db_session.commit()

        assert outcome.result is BinScanResult.BIN_IN_USE

    @pytest.mark.asyncio
    async def test_refuses_unlinked_bin(self, db_session, printer_factory, archive_factory):
        payload = await _fill_bin(db_session, printer_factory, archive_factory, payload="BBN-BUT-2", quantity=6)
        await unlink_bin(db_session, payload)
        await db_session.commit()
        printer = await printer_factory()

        outcome = await assign_bin_manually(db_session, payload, printer.id, quantity=4)
        await db_session.commit()

        assert outcome.result is BinScanResult.BIN_IN_USE

    @pytest.mark.asyncio
    async def test_allows_after_empty_override(self, db_session, printer_factory, archive_factory):
        from backend.app.services.floor_bins import override_bin_quantity

        payload = await _fill_bin(db_session, printer_factory, archive_factory, payload="BBN-KNB-3", quantity=7)
        await override_bin_quantity(db_session, payload, 0)
        await db_session.commit()
        printer = await printer_factory()

        outcome = await assign_bin_manually(db_session, payload, printer.id, quantity=15)
        await db_session.commit()

        assert outcome.result is BinScanResult.RECORDED
        assert outcome.batch is not None
        assert outcome.batch.quantity == 15
