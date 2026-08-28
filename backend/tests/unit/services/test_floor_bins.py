"""Unit tests for the reusable-bin item→location pipeline.

The bin half of the universal scan-item-then-location flow: Initial QC gates
Production WIP, Ready-for-Production Inventory is an optional stop in between
that is never itself a WIP prerequisite, and Empty Bin only releases a fill
that actually reached WIP. These exercise the services directly, the same
style as ``test_floor_parts.py``.
"""

from __future__ import annotations

import pytest

from backend.app.services.floor_bins import (
    BIN_EMPTY_LOCATION_SLUG,
    PRODUCTION_WIP_LOCATION_SLUG,
    READY_FOR_PRODUCTION_LOCATION_SLUG,
    BinScanResult,
    scan_bin_at_location,
    scan_bin_empty,
    scan_bin_fit_check,
    scan_bin_ready_for_production,
    scan_bin_wip,
    scan_harvest_bin,
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
