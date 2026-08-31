"""Integration tests for Wave 1 Part Assembly Linking routes.

Exercises the wiring for:
- Kit assignment when a TOP commits to Production WIP via ``POST
  /floor/locations/part`` (consume 1 KNB + 1 BUT, refuse on either missing).
- One bin on the line per type via ``POST /floor/wip/bin``.
- ``POST /floor/bins/adjust`` — floor remaining subtract.
- ``POST /floor/parts/kit/reassign`` — move a kit slot to another bin.

Reuses the harvest/part helpers from ``test_floor_parts_api``.
"""

from __future__ import annotations

import pytest

from backend.tests.integration.test_floor_parts_api import (
    DEVICE_A,
    _enroll_linked_part_with_code,
    _open_harvest,
    _scan_printer,
)

FINISHING = ("support-removal", "overhang-removal", "hot-air-removal")


async def _bin_to_wip(async_client, printer_factory, archive_factory, payload, quantity):
    """Drive a shared bin from harvest through visual QC into Production WIP."""
    printer = await printer_factory()
    await archive_factory(printer_id=printer.id)
    await _open_harvest(async_client, DEVICE_A)
    await _scan_printer(async_client, printer.id, DEVICE_A)
    await async_client.post(
        "/api/v1/floor/harvest/bin",
        json={"device_id": DEVICE_A, "payload": payload, "quantity": quantity},
    )
    await _open_harvest(async_client, DEVICE_A)  # close harvest
    await async_client.post(
        "/api/v1/floor/locations/fit-check/bin",
        json={"payload": payload, "passed_quantity": quantity},
    )
    return await async_client.post("/api/v1/floor/wip/bin", json={"payload": payload})


async def _bin_to_ready(async_client, printer_factory, archive_factory, payload, quantity):
    """Drive a shared bin from harvest through visual QC to Ready-for-Production."""
    printer = await printer_factory()
    await archive_factory(printer_id=printer.id)
    await _open_harvest(async_client, DEVICE_A)
    await _scan_printer(async_client, printer.id, DEVICE_A)
    await async_client.post(
        "/api/v1/floor/harvest/bin",
        json={"device_id": DEVICE_A, "payload": payload, "quantity": quantity},
    )
    await _open_harvest(async_client, DEVICE_A)
    await async_client.post(
        "/api/v1/floor/locations/fit-check/bin",
        json={"payload": payload, "passed_quantity": quantity},
    )
    return await async_client.post(
        "/api/v1/floor/locations/bin",
        json={"payload": payload, "location_slug": "ready-for-production-inventory"},
    )


async def _top_to_wip(async_client, sticker):
    for slug in FINISHING:
        await async_client.post("/api/v1/floor/locations/part", json={"payload": sticker, "location_slug": slug})
    return await async_client.post(
        "/api/v1/floor/locations/part",
        json={"payload": sticker, "location_slug": "production-wip"},
    )


@pytest.mark.asyncio
@pytest.mark.integration
class TestKitAssignmentApi:
    async def test_top_wip_assigns_a_kit_and_consumes_both_bins(self, async_client, printer_factory, archive_factory):
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-KNB-1", 10)
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-BUT-1", 8)
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "TOP")

        resp = await _top_to_wip(async_client, sticker)

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "recorded"
        assert body["kit_knob_batch_id"] is not None
        assert body["kit_button_batch_id"] is not None
        assert body["kit_knob_remaining"] == 9
        assert body["kit_button_remaining"] == 7
        assert body["part"]["kit_knob_batch_id"] is not None
        assert body["part"]["kit_assigned_at"] is not None

        # Bins were decremented and stay In WIP.
        knb = await async_client.post("/api/v1/floor/bins/resolve", json={"payload": "BBN-KNB-1"})
        assert knb.json()["batch"]["remaining_quantity"] == 9
        assert knb.json()["batch"]["status"] == "wip"

    async def test_top_wip_refused_when_button_missing_no_partial_consume(
        self, async_client, printer_factory, archive_factory
    ):
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-KNB-1", 10)
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "TOP")

        resp = await _top_to_wip(async_client, sticker)

        assert resp.json()["result"] == "kit_button_unavailable"
        # KNB was not consumed.
        knb = await async_client.post("/api/v1/floor/bins/resolve", json={"payload": "BBN-KNB-1"})
        assert knb.json()["batch"]["remaining_quantity"] == 10

    async def test_consume_to_zero_flags_empty_warning(self, async_client, printer_factory, archive_factory):
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-KNB-1", 1)
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-BUT-1", 8)
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "TOP")

        resp = await _top_to_wip(async_client, sticker)

        body = resp.json()
        assert body["result"] == "recorded"
        assert body["kit_knob_emptied"] is True
        assert body["kit_button_emptied"] is False


@pytest.mark.asyncio
@pytest.mark.integration
class TestOneBinPerTypeApi:
    async def test_second_wip_of_same_type_refused(self, async_client, printer_factory, archive_factory):
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-KNB-1", 10)
        # Second KNB fill, QC'd, tries WIP while the first is on the line.
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-KNB-2", "quantity": 5},
        )
        await _open_harvest(async_client, DEVICE_A)
        await async_client.post(
            "/api/v1/floor/locations/fit-check/bin",
            json={"payload": "BBN-KNB-2", "passed_quantity": 5},
        )

        resp = await async_client.post("/api/v1/floor/wip/bin", json={"payload": "BBN-KNB-2"})

        assert resp.json()["result"] == "wip_type_occupied"


@pytest.mark.asyncio
@pytest.mark.integration
class TestFloorAdjustApi:
    async def test_adjust_subtracts_from_in_wip_fill(self, async_client, printer_factory, archive_factory):
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-KNB-1", 10)

        resp = await async_client.post("/api/v1/floor/bins/adjust", json={"payload": "BBN-KNB-1", "subtract": 3})

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "adjusted"
        assert body["batch"]["remaining_quantity"] == 7
        assert body["empty_bin_warning"] is False

    async def test_adjust_to_zero_warns(self, async_client, printer_factory, archive_factory):
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-KNB-1", 2)

        resp = await async_client.post("/api/v1/floor/bins/adjust", json={"payload": "BBN-KNB-1", "subtract": 5})

        assert resp.json()["result"] == "adjusted"
        assert resp.json()["batch"]["remaining_quantity"] == 0
        assert resp.json()["empty_bin_warning"] is True

    async def test_adjust_requires_positive_subtract(self, async_client, printer_factory, archive_factory):
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-KNB-1", 10)

        resp = await async_client.post("/api/v1/floor/bins/adjust", json={"payload": "BBN-KNB-1", "subtract": 0})

        assert resp.status_code == 422


@pytest.mark.asyncio
@pytest.mark.integration
class TestKitReassignApi:
    async def test_reassign_knob_to_a_staged_bin(self, async_client, printer_factory, archive_factory):
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-KNB-1", 10)
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-BUT-1", 8)
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "TOP")
        await _top_to_wip(async_client, sticker)
        await _bin_to_ready(async_client, printer_factory, archive_factory, "BBN-KNB-2", 5)

        resp = await async_client.post(
            "/api/v1/floor/parts/kit/reassign",
            json={"payload": sticker, "bin_payload": "BBN-KNB-2"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "reassigned"
        assert body["slot"] == "KNB"
        assert body["new_remaining"] == 4
        # Old KNB1 restored back to 10.
        knb1 = await async_client.post("/api/v1/floor/bins/resolve", json={"payload": "BBN-KNB-1"})
        assert knb1.json()["batch"]["remaining_quantity"] == 10

    async def test_reassign_refused_for_part_without_kit(self, async_client, printer_factory, archive_factory):
        await _bin_to_ready(async_client, printer_factory, archive_factory, "BBN-KNB-1", 5)
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "BOT")

        resp = await async_client.post(
            "/api/v1/floor/parts/kit/reassign",
            json={"payload": sticker, "bin_payload": "BBN-KNB-1"},
        )

        assert resp.json()["result"] == "no_kit"


@pytest.mark.asyncio
@pytest.mark.integration
class TestStickerLookupKitFields:
    async def test_by_sticker_exposes_kit_fields_after_wip(self, async_client, printer_factory, archive_factory):
        # The idle part lookup the kiosk uses to decide whether to offer kit
        # reassign must carry the kit fills once a TOP has entered WIP.
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-KNB-1", 10)
        await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-BUT-1", 8)
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "TOP")
        await _top_to_wip(async_client, sticker)

        resp = await async_client.get(f"/api/v1/floor/inventory/parts/by-sticker/{sticker}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["part_code"] == "TOP"
        assert body["kit_knob_batch_id"] is not None
        assert body["kit_button_batch_id"] is not None

    async def test_by_sticker_kit_fields_null_before_wip(self, async_client, printer_factory, archive_factory):
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "TOP")

        resp = await async_client.get(f"/api/v1/floor/inventory/parts/by-sticker/{sticker}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["kit_knob_batch_id"] is None
        assert body["kit_button_batch_id"] is None
