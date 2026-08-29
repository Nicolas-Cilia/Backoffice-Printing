"""Unit tests for Wave 1 Part Assembly Linking (kit assignment on TOP → WIP).

Covers, at the service layer (same style as ``test_floor_parts.py`` /
``test_floor_bins.py``):

- Kit assignment when a TOP part commits to Production WIP: consume 1 from the
  single In-WIP KNB batch and 1 from the single In-WIP BUT batch, write the kit
  FKs, emit the ``kit_assigned`` part event and ``consumed`` bin events, and
  refuse the whole WIP commit (no partial consume) when either type is missing.
- One bin on the line per type: a second Production WIP of a type that already
  has an In-WIP fill is refused until the first is emptied.
- Floor remaining subtract (``floor_adjust``): subtract N from an In-WIP fill.
- ``_remaining_quantity`` honouring ``consumed`` / ``floor_adjust`` like
  ``quantity_override``.
- Kit reassign: move a kit slot to a different bin, restoring the old batch and
  consuming the new one.
"""

from __future__ import annotations

import pytest

from backend.app.models.floor_bin import FloorBinBatch, FloorBinBatchEvent
from backend.app.services.floor_bins import (
    BinScanResult,
    _remaining_quantity,
    adjust_bin_remaining,
    bin_payload,
    list_bin_batch_events,
    resolve_bin_for_flow,
    scan_bin_fit_check,
    scan_bin_wip,
    scan_harvest_bin,
)
from backend.app.services.floor_codes import station_for_slug
from backend.app.services.floor_parts import (
    HOT_AIR_REMOVAL_LOCATION_SLUG,
    OVERHANG_REMOVAL_LOCATION_SLUG,
    PRODUCTION_WIP_LOCATION_SLUG,
    SUPPORT_REMOVAL_LOCATION_SLUG,
    KitReassignResult,
    LocationScanResult,
    list_part_events,
    reassign_kit,
    scan_fit_check_part,
    scan_harvest_printer,
    scan_part,
    scan_part_at_location,
)
from backend.app.services.floor_sessions import apply_station_scan

DEVICE_A = "device-a"
HARVEST = station_for_slug("harvest")

KNB1 = bin_payload("KNB", 1)
KNB2 = bin_payload("KNB", 2)
BUT1 = bin_payload("BUT", 1)


async def _bin_to_wip(db, printer_factory, archive_factory, payload, quantity=10):
    """Harvest a shared bin, pass visual QC, and admit it to Production WIP."""
    printer = await printer_factory()
    await archive_factory(printer_id=printer.id)
    await scan_harvest_bin(db, DEVICE_A, payload, printer_id_hint=printer.id)
    await db.commit()
    await scan_harvest_bin(db, DEVICE_A, payload, quantity=quantity)
    await db.commit()
    await apply_station_scan(db, HARVEST, DEVICE_A)  # close harvest
    await db.commit()
    await scan_bin_fit_check(db, payload, quantity)
    await db.commit()
    await scan_bin_wip(db, payload)
    await db.commit()


async def _bin_to_ready(db, printer_factory, archive_factory, payload, quantity=10):
    """Harvest a shared bin, pass visual QC, and stage it at Ready-for-Production.

    A valid kit-reassign target that does not occupy the single In-WIP slot for
    its type (so it can coexist with a different fill already on the line)."""
    from backend.app.services.floor_bins import scan_bin_ready_for_production

    await _bin_harvested_qc(db, printer_factory, archive_factory, payload, quantity=quantity)
    await scan_bin_ready_for_production(db, payload)
    await db.commit()


async def _bin_harvested_qc(db, printer_factory, archive_factory, payload, quantity=10):
    """Harvest a shared bin and pass visual QC, but stop before WIP."""
    printer = await printer_factory()
    await archive_factory(printer_id=printer.id)
    await scan_harvest_bin(db, DEVICE_A, payload, printer_id_hint=printer.id)
    await db.commit()
    await scan_harvest_bin(db, DEVICE_A, payload, quantity=quantity)
    await db.commit()
    await apply_station_scan(db, HARVEST, DEVICE_A)
    await db.commit()
    await scan_bin_fit_check(db, payload, quantity)
    await db.commit()


async def _top_ready_for_wip(db, printer_factory, archive_factory, code="BBD-000100"):
    """Enroll a TOP part and take it through QC + all three finishing steps,
    leaving it one scan short of Production WIP."""
    printer = await printer_factory()
    await archive_factory(printer_id=printer.id)
    await apply_station_scan(db, HARVEST, DEVICE_A)
    await db.commit()
    await scan_harvest_printer(db, DEVICE_A, f"BBP-{printer.id}")
    await db.commit()
    outcome = await scan_part(db, DEVICE_A, code)
    outcome.part.part_code = "TOP"
    await db.commit()
    await apply_station_scan(db, HARVEST, DEVICE_A)  # close harvest
    await db.commit()
    await scan_fit_check_part(db, code)
    await db.commit()
    for slug in (SUPPORT_REMOVAL_LOCATION_SLUG, OVERHANG_REMOVAL_LOCATION_SLUG, HOT_AIR_REMOVAL_LOCATION_SLUG):
        await scan_part_at_location(db, code, slug)
        await db.commit()
    return outcome.part


async def _remaining(db, payload):
    outcome = await resolve_bin_for_flow(db, payload)
    return outcome.batch.remaining_quantity


class TestKitAssignmentOnWip:
    @pytest.mark.asyncio
    async def test_top_wip_consumes_one_knob_and_one_button(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)

        outcome = await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        assert outcome.result is LocationScanResult.RECORDED
        assert await _remaining(db_session, KNB1) == 9
        assert await _remaining(db_session, BUT1) == 7
        refreshed = await db_session.get(type(part), part.id)
        assert refreshed.kit_knob_batch_id is not None
        assert refreshed.kit_button_batch_id is not None
        assert refreshed.kit_assigned_at is not None

    @pytest.mark.asyncio
    async def test_kit_assigned_event_records_batch_ids_and_remainings(
        self, db_session, printer_factory, archive_factory
    ):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)

        await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        events = await list_part_events(db_session, part.id)
        actions = [e.action for e in events]
        assert "kit_assigned" in actions
        assert "wip" in actions
        # Entering WIP is primary; kit assignment is recorded immediately after.
        assert actions.index("wip") < actions.index("kit_assigned")
        kit_event = next(e for e in events if e.action == "kit_assigned")
        assert kit_event.details["knob_remaining"] == 9
        assert kit_event.details["button_remaining"] == 7
        assert isinstance(kit_event.details["kit_knob_batch_id"], int)
        assert isinstance(kit_event.details["kit_button_batch_id"], int)
        assert kit_event.details.get("knob_bin_payload")
        assert kit_event.details.get("button_bin_payload")

    @pytest.mark.asyncio
    async def test_bins_get_consumed_events_and_status_stays_wip(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)

        await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        knb = await resolve_bin_for_flow(db_session, KNB1)
        assert knb.batch.status == "wip"
        assert knb.batch.remaining_quantity == 9
        knb_events = await list_bin_batch_events(db_session, knb.batch.id)
        consumed = [e for e in knb_events if e.action == "consumed"]
        assert len(consumed) == 1
        assert consumed[0].details["remaining_quantity"] == 9

    @pytest.mark.asyncio
    async def test_consumed_events_record_consuming_top_identity(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)

        await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        knb = await resolve_bin_for_flow(db_session, KNB1)
        knb_consumed = [e for e in await list_bin_batch_events(db_session, knb.batch.id) if e.action == "consumed"]
        assert knb_consumed[-1].details["source"] == "kit_assign"
        assert knb_consumed[-1].details["part_sticker"] == part.sticker_code
        assert knb_consumed[-1].details["part_id"] == part.id
        but = await resolve_bin_for_flow(db_session, BUT1)
        but_consumed = [e for e in await list_bin_batch_events(db_session, but.batch.id) if e.action == "consumed"]
        assert but_consumed[-1].details["part_sticker"] == part.sticker_code
        assert but_consumed[-1].details["part_id"] == part.id

    @pytest.mark.asyncio
    async def test_wip_refused_when_no_knob_wip_batch_and_no_partial_consume(
        self, db_session, printer_factory, archive_factory
    ):
        # Only BUT is In WIP; KNB has none.
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)

        outcome = await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        assert outcome.result is LocationScanResult.KIT_KNOB_UNAVAILABLE
        # No partial consume: BUT untouched.
        assert await _remaining(db_session, BUT1) == 8
        # No WIP event recorded, no kit FK set.
        actions = [e.action for e in await list_part_events(db_session, part.id)]
        assert "wip" not in actions
        assert "kit_assigned" not in actions
        refreshed = await db_session.get(type(part), part.id)
        assert refreshed.kit_button_batch_id is None

    @pytest.mark.asyncio
    async def test_wip_refused_when_no_button_wip_batch_and_no_partial_consume(
        self, db_session, printer_factory, archive_factory
    ):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)

        outcome = await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        assert outcome.result is LocationScanResult.KIT_BUTTON_UNAVAILABLE
        assert await _remaining(db_session, KNB1) == 10
        actions = [e.action for e in await list_part_events(db_session, part.id)]
        assert "wip" not in actions

    @pytest.mark.asyncio
    async def test_kit_not_reconsumed_on_restage(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)

        await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()
        # Restage: WIP → Ready-for-Production → WIP again.
        await scan_part_at_location(db_session, part.sticker_code, "ready-for-production-inventory")
        await db_session.commit()
        again = await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        assert again.result is LocationScanResult.RECORDED
        # Remainings unchanged after the first consume — idempotent.
        assert await _remaining(db_session, KNB1) == 9
        assert await _remaining(db_session, BUT1) == 7
        kit_events = [e for e in await list_part_events(db_session, part.id) if e.action == "kit_assigned"]
        assert len(kit_events) == 1

    @pytest.mark.asyncio
    async def test_consume_to_zero_sets_empty_warning(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=1)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)

        outcome = await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        assert outcome.result is LocationScanResult.RECORDED
        assert await _remaining(db_session, KNB1) == 0
        assert outcome.kit_knob_emptied is True
        assert outcome.kit_button_emptied is False
        # Bin stays WIP even at 0 — no auto-empty, no countdown.
        knb = await resolve_bin_for_flow(db_session, KNB1)
        assert knb.batch.status == "wip"


class TestOneBinPerTypeOnTheLine:
    @pytest.mark.asyncio
    async def test_second_wip_of_same_type_is_refused(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        # A second KNB fill, QC'd, tries to enter WIP while KNB1 is still on the line.
        await _bin_harvested_qc(db_session, printer_factory, archive_factory, KNB2, quantity=5)

        outcome = await scan_bin_wip(db_session, KNB2)
        await db_session.commit()

        assert outcome.result is BinScanResult.WIP_TYPE_OCCUPIED
        second = await resolve_bin_for_flow(db_session, KNB2)
        assert second.batch.status != "wip"

    @pytest.mark.asyncio
    async def test_second_wip_refused_while_first_at_zero_not_emptied(
        self, db_session, printer_factory, archive_factory
    ):
        """A fill at remaining 0 still occupies the line until BBS-bin-empty."""
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=1)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)
        outcome = await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()
        assert outcome.kit_knob_emptied is True
        assert await _remaining(db_session, KNB1) == 0
        knb = await resolve_bin_for_flow(db_session, KNB1)
        assert knb.batch.status == "wip"

        await _bin_harvested_qc(db_session, printer_factory, archive_factory, KNB2, quantity=5)
        blocked = await scan_bin_wip(db_session, KNB2)
        await db_session.commit()

        assert blocked.result is BinScanResult.WIP_TYPE_OCCUPIED
        second = await resolve_bin_for_flow(db_session, KNB2)
        assert second.batch.status != "wip"

    @pytest.mark.asyncio
    async def test_second_type_allowed_after_first_emptied(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_harvested_qc(db_session, printer_factory, archive_factory, KNB2, quantity=5)
        # Empty the first bin off the line.
        from backend.app.services.floor_bins import scan_bin_empty

        await scan_bin_empty(db_session, KNB1)
        await db_session.commit()

        outcome = await scan_bin_wip(db_session, KNB2)
        await db_session.commit()

        assert outcome.result is BinScanResult.WIP_RECORDED


class TestRemainingQuantityHonoursConsumedAndAdjust:
    @pytest.mark.asyncio
    async def test_remaining_quantity_uses_latest_consumed_or_floor_adjust(self, db_session):
        batch = FloorBinBatch(bin_payload=KNB1, part_code="KNB", quantity=10)
        db_session.add(batch)
        await db_session.flush()
        db_session.add(
            FloorBinBatchEvent(batch_id=batch.id, action="visual_qc_passed", details={"passed_quantity": 10})
        )
        db_session.add(FloorBinBatchEvent(batch_id=batch.id, action="wip", details={"source": "floor_scan"}))
        await db_session.flush()
        assert await _remaining_quantity(db_session, batch) == 10

        db_session.add(FloorBinBatchEvent(batch_id=batch.id, action="consumed", details={"remaining_quantity": 9}))
        await db_session.flush()
        assert await _remaining_quantity(db_session, batch) == 9

        db_session.add(FloorBinBatchEvent(batch_id=batch.id, action="floor_adjust", details={"remaining_quantity": 4}))
        await db_session.flush()
        assert await _remaining_quantity(db_session, batch) == 4


class TestFloorAdjust:
    @pytest.mark.asyncio
    async def test_subtracts_n_from_an_in_wip_fill(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)

        outcome = await adjust_bin_remaining(db_session, KNB1, 3)
        await db_session.commit()

        assert outcome.result is BinScanResult.ADJUSTED
        assert outcome.batch.remaining_quantity == 7
        assert outcome.empty_bin_warning is False
        events = await list_bin_batch_events(db_session, outcome.batch.id)
        adjust = [e for e in events if e.action == "floor_adjust"]
        assert adjust[-1].details["remaining_quantity"] == 7

    @pytest.mark.asyncio
    async def test_adjust_floors_at_zero_and_warns(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=2)

        outcome = await adjust_bin_remaining(db_session, KNB1, 5)
        await db_session.commit()

        assert outcome.result is BinScanResult.ADJUSTED
        assert outcome.batch.remaining_quantity == 0
        assert outcome.empty_bin_warning is True

    @pytest.mark.asyncio
    async def test_adjust_requires_wip(self, db_session, printer_factory, archive_factory):
        # QC'd but not yet In WIP.
        await _bin_harvested_qc(db_session, printer_factory, archive_factory, KNB1, quantity=10)

        outcome = await adjust_bin_remaining(db_session, KNB1, 1)
        await db_session.commit()

        assert outcome.result is BinScanResult.ADJUST_REQUIRES_WIP
        assert await _remaining(db_session, KNB1) == 10

    @pytest.mark.asyncio
    async def test_adjust_unknown_bin_is_invalid(self, db_session):
        outcome = await adjust_bin_remaining(db_session, "not-a-bin", 1)
        assert outcome.result is BinScanResult.INVALID_CODE


class TestKitReassign:
    @pytest.mark.asyncio
    async def test_reassign_moves_fk_restores_old_and_consumes_new(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)
        await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()
        assert await _remaining(db_session, KNB1) == 9

        # A second KNB fill staged at Ready-for-Production to reassign to (it
        # cannot also be In WIP — one bin per type on the line).
        await _bin_to_ready(db_session, printer_factory, archive_factory, KNB2, quantity=5)

        outcome = await reassign_kit(db_session, part.sticker_code, KNB2)
        await db_session.commit()

        assert outcome.result is KitReassignResult.REASSIGNED
        # Old KNB1 restored (+1 back to 10); new KNB2 consumed (-1 to 4).
        assert await _remaining(db_session, KNB1) == 10
        assert await _remaining(db_session, KNB2) == 4
        refreshed = await db_session.get(type(part), part.id)
        knb2_batch = await resolve_bin_for_flow(db_session, KNB2)
        assert refreshed.kit_knob_batch_id == knb2_batch.batch.id
        actions = [e.action for e in await list_part_events(db_session, part.id)]
        assert "kit_reassigned" in actions

    @pytest.mark.asyncio
    async def test_reassign_consumed_event_records_consuming_top_identity(
        self, db_session, printer_factory, archive_factory
    ):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)
        await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()
        await _bin_to_ready(db_session, printer_factory, archive_factory, KNB2, quantity=5)

        outcome = await reassign_kit(db_session, part.sticker_code, KNB2)
        await db_session.commit()

        assert outcome.result is KitReassignResult.REASSIGNED
        knb2 = await resolve_bin_for_flow(db_session, KNB2)
        consumed = [e for e in await list_bin_batch_events(db_session, knb2.batch.id) if e.action == "consumed"]
        assert consumed[-1].details["source"] == "kit_reassign"
        assert consumed[-1].details["part_sticker"] == part.sticker_code
        assert consumed[-1].details["part_id"] == part.id

    @pytest.mark.asyncio
    async def test_reassign_skips_restore_when_old_batch_already_empty(
        self, db_session, printer_factory, archive_factory
    ):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=1)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)
        await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()
        # KNB1 now at 0; empty it off the line.
        from backend.app.services.floor_bins import scan_bin_empty

        await scan_bin_empty(db_session, KNB1)
        await db_session.commit()

        await _bin_to_ready(db_session, printer_factory, archive_factory, KNB2, quantity=5)

        outcome = await reassign_kit(db_session, part.sticker_code, KNB2)
        await db_session.commit()

        assert outcome.result is KitReassignResult.REASSIGNED
        # KNB1 stays empty (no restore); KNB2 consumed.
        assert await _remaining(db_session, KNB2) == 4
        knb1 = await resolve_bin_for_flow(db_session, KNB1)
        assert knb1.result is BinScanResult.NO_BATCH  # emptied → free

    @pytest.mark.asyncio
    async def test_reassign_same_bin_is_noop(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)
        await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()
        assert await _remaining(db_session, KNB1) == 9
        events_before = len(
            await list_bin_batch_events(db_session, (await resolve_bin_for_flow(db_session, KNB1)).batch.id)
        )
        part_events_before = len(await list_part_events(db_session, part.id))

        outcome = await reassign_kit(db_session, part.sticker_code, KNB1)
        await db_session.commit()

        assert outcome.result is KitReassignResult.REASSIGNED
        assert await _remaining(db_session, KNB1) == 9
        knb = await resolve_bin_for_flow(db_session, KNB1)
        assert len(await list_bin_batch_events(db_session, knb.batch.id)) == events_before
        assert len(await list_part_events(db_session, part.id)) == part_events_before

    @pytest.mark.asyncio
    async def test_reassign_refused_for_part_without_kit(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        # A BOT-style part with no kit assigned.
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await apply_station_scan(db_session, HARVEST, DEVICE_A)
        await db_session.commit()
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()
        enrolled = await scan_part(db_session, DEVICE_A, "BBD-000200")
        enrolled.part.part_code = "BOT"
        await db_session.commit()
        await apply_station_scan(db_session, HARVEST, DEVICE_A)
        await db_session.commit()

        outcome = await reassign_kit(db_session, "BBD-000200", KNB1)
        await db_session.commit()

        assert outcome.result is KitReassignResult.NO_KIT

    @pytest.mark.asyncio
    async def test_reassign_refused_when_no_eligible_target(self, db_session, printer_factory, archive_factory):
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)
        await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()

        # KNB2 has no fill at all.
        outcome = await reassign_kit(db_session, part.sticker_code, KNB2)
        await db_session.commit()

        assert outcome.result is KitReassignResult.NO_TARGET

    @pytest.mark.asyncio
    async def test_reassign_refused_when_part_is_shipped(self, db_session, printer_factory, archive_factory):
        """Floor kit reassign must not mutate a housing already on a serial."""
        from backend.app.models.floor_part import FloorPartEvent

        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB1, quantity=10)
        await _bin_to_wip(db_session, printer_factory, archive_factory, BUT1, quantity=8)
        await _bin_to_wip(db_session, printer_factory, archive_factory, KNB2, quantity=5)
        part = await _top_ready_for_wip(db_session, printer_factory, archive_factory)
        await scan_part_at_location(db_session, part.sticker_code, PRODUCTION_WIP_LOCATION_SLUG)
        await db_session.commit()
        db_session.add(FloorPartEvent(part_id=part.id, action="shipped", details={}))
        await db_session.commit()

        outcome = await reassign_kit(db_session, part.sticker_code, KNB2)
        await db_session.commit()

        assert outcome.result is KitReassignResult.SHIPPED
        assert part.kit_knob_batch_id is not None
