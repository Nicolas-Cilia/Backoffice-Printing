"""Integration tests for Wave 2 Part Assembly Linking routes.

Exercises the wiring for the product-unit linking ceremony:
- ``POST /floor/units/link`` — bind a serial to a TOP + BOT pair, ship both.
- ``GET /floor/units/by-serial/{code}`` — already-linked lookup (404 if free).
- ``GET /floor/units/by-part/{sticker}`` — the unit a housing belongs to.
- ``POST /floor/units/{id}/unlink`` — free the serial + both stickers.
- ``GET /floor/inventory/units`` — the Wave 3 list.
- Strong assertions: invalid serial, no double-link, TOP+TOP / BOT+BOT refused,
  shipped housings refuse item→location scans (lookup only).

Reuses the harvest/part helpers from ``test_floor_parts_api`` /
``test_floor_kit_api``.
"""

from __future__ import annotations

import pytest

from backend.tests.integration.test_floor_kit_api import (
    _bin_to_ready,
    _bin_to_wip,
    _top_to_wip,
)
from backend.tests.integration.test_floor_parts_api import (
    DEVICE_A,
    _open_harvest,
    _scan_part,
    _scan_printer,
)

# Every enrolled sticker is globally unique forever (§7.1), so hand each part a
# fresh BBD code — enrolling two parts in one test would otherwise collide.
_next_sticker = iter(range(1, 10_000))
# Uniquely-named catalog sections per enroll, so creating the TOP/BOT part code
# never conflicts with an earlier section of the same name in the same test.
_next_section = iter(range(1, 10_000))


def _fresh_sticker() -> str:
    return f"BBD-{next(_next_sticker):06d}"


async def _catalog_part_code(async_client, code):
    """Ensure a ``LibrarySectionPart`` with this code exists so ``set_part_code``
    accepts it. A fresh uniquely-named section each call avoids name clashes."""
    section = (
        await async_client.post(
            "/api/v1/library/sections",
            json={"name": f"Line-{next(_next_section)}", "kind": "production"},
        )
    ).json()
    await async_client.post(
        f"/api/v1/library/sections/{section['id']}/parts",
        json={"code": code, "name": "Housing"},
    )


async def _enroll_part(async_client, printer_factory, archive_factory, code):
    """Enroll a job-linked part at Harvest, stamp a TOP/BOT code, pass QC."""
    await _catalog_part_code(async_client, code)
    sticker = _fresh_sticker()
    printer = await printer_factory()
    await archive_factory(printer_id=printer.id)
    await _open_harvest(async_client, DEVICE_A)
    await _scan_printer(async_client, printer.id, DEVICE_A)
    scanned = await _scan_part(async_client, sticker, DEVICE_A)
    part_id = scanned.json()["part"]["id"]
    await async_client.post(f"/api/v1/floor/inventory/parts/{part_id}/part-code", json={"code": code})
    await _open_harvest(async_client, DEVICE_A)  # close harvest
    await async_client.post("/api/v1/floor/locations/fit-check/part", json={"payload": sticker})
    return sticker


async def _bot_to_wip(async_client, sticker):
    """A BOT skips finishing: QC (already done) then straight to Production WIP."""
    return await async_client.post(
        "/api/v1/floor/locations/part",
        json={"payload": sticker, "location_slug": "production-wip"},
    )


async def _prepare_line(async_client, printer_factory, archive_factory):
    """Put one KNB + one BUT fill In WIP (one bin per type) with plenty of
    quantity, so any number of TOPs enrolled afterward can each draw a kit."""
    await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-KNB-1", 20)
    await _bin_to_wip(async_client, printer_factory, archive_factory, "BBN-BUT-1", 20)


async def _enroll_top_in_wip(async_client, printer_factory, archive_factory):
    """A kitted TOP In WIP, drawing from the KNB/BUT fills already on the line."""
    top = await _enroll_part(async_client, printer_factory, archive_factory, "TOP")
    await _top_to_wip(async_client, top)
    return top


async def _enroll_bot_in_wip(async_client, printer_factory, archive_factory):
    bot = await _enroll_part(async_client, printer_factory, archive_factory, "BOT")
    await _bot_to_wip(async_client, bot)
    return bot


async def _kitted_top_and_bot(async_client, printer_factory, archive_factory):
    """A TOP In WIP with a kit, and a BOT In WIP — the two housings a link needs."""
    await _prepare_line(async_client, printer_factory, archive_factory)
    top = await _enroll_top_in_wip(async_client, printer_factory, archive_factory)
    bot = await _enroll_bot_in_wip(async_client, printer_factory, archive_factory)
    return top, bot


@pytest.mark.asyncio
@pytest.mark.integration
class TestLinkUnitApi:
    async def test_link_creates_unit_with_four_identities(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)

        resp = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "XG2SNP", "top_sticker": top, "bottom_sticker": bot},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "linked"
        unit = body["unit"]
        assert unit["serial_code"] == "XG2SNP"
        assert unit["top_sticker"] == top
        assert unit["bottom_sticker"] == bot
        assert unit["knob_batch_id"] is not None
        assert unit["button_batch_id"] is not None
        assert unit["knob_bin_payload"] == "BBN-KNB-1"
        assert unit["button_bin_payload"] == "BBN-BUT-1"

    async def test_link_normalizes_serial(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)

        resp = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "  xg2snp ", "top_sticker": top, "bottom_sticker": bot},
        )

        assert resp.json()["unit"]["serial_code"] == "XG2SNP"

    async def test_invalid_serial_refused(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)

        resp = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "123456", "top_sticker": top, "bottom_sticker": bot},
        )

        assert resp.json()["result"] == "invalid_serial"

    async def test_top_top_refused(self, async_client, printer_factory, archive_factory):
        top, _ = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        # A second kitted TOP (drawn from the same fills on the line) in the
        # bottom slot.
        top2 = await _enroll_top_in_wip(async_client, printer_factory, archive_factory)

        resp = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "8TBDT9", "top_sticker": top, "bottom_sticker": top2},
        )

        assert resp.json()["result"] == "bottom_not_eligible"

    async def test_bot_bot_refused(self, async_client, printer_factory, archive_factory):
        bot1 = await _enroll_bot_in_wip(async_client, printer_factory, archive_factory)
        bot2 = await _enroll_bot_in_wip(async_client, printer_factory, archive_factory)

        resp = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "IX72HD", "top_sticker": bot1, "bottom_sticker": bot2},
        )

        assert resp.json()["result"] == "top_not_eligible"

    async def test_no_double_link(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "XG2SNP", "top_sticker": top, "bottom_sticker": bot},
        )
        # A fresh BOT tries to reuse the already-linked TOP.
        bot2 = await _enroll_bot_in_wip(async_client, printer_factory, archive_factory)

        resp = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "ME2O6N", "top_sticker": top, "bottom_sticker": bot2},
        )

        assert resp.json()["result"] in ("top_already_linked", "top_not_eligible")

    async def test_reused_serial_refused(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "XG2SNP", "top_sticker": top, "bottom_sticker": bot},
        )
        top2 = await _enroll_top_in_wip(async_client, printer_factory, archive_factory)
        bot2 = await _enroll_bot_in_wip(async_client, printer_factory, archive_factory)

        resp = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "XG2SNP", "top_sticker": top2, "bottom_sticker": bot2},
        )

        assert resp.json()["result"] == "serial_in_use"


@pytest.mark.asyncio
@pytest.mark.integration
class TestLookupApi:
    async def test_by_serial_after_link(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "XAKZM2", "top_sticker": top, "bottom_sticker": bot},
        )

        resp = await async_client.get("/api/v1/floor/units/by-serial/xakzm2")
        assert resp.status_code == 200
        assert resp.json()["serial_code"] == "XAKZM2"
        assert resp.json()["top_sticker"] == top

    async def test_by_serial_unlinked_is_404(self, async_client):
        resp = await async_client.get("/api/v1/floor/units/by-serial/GMUOQL")
        assert resp.status_code == 404

    async def test_by_part(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "OEQ0AC", "top_sticker": top, "bottom_sticker": bot},
        )

        resp = await async_client.get(f"/api/v1/floor/units/by-part/{bot}")
        assert resp.status_code == 200
        assert resp.json()["serial_code"] == "OEQ0AC"

    async def test_by_part_unlinked_is_404(self, async_client, printer_factory, archive_factory):
        top, _ = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        resp = await async_client.get(f"/api/v1/floor/units/by-part/{top}")
        assert resp.status_code == 404

    async def test_list_units(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "ME2O6N", "top_sticker": top, "bottom_sticker": bot},
        )

        resp = await async_client.get("/api/v1/floor/inventory/units")
        assert resp.status_code == 200
        assert any(u["serial_code"] == "ME2O6N" for u in resp.json())


@pytest.mark.asyncio
@pytest.mark.integration
class TestShippedRefusesLocationApi:
    async def test_location_scan_refused_after_link(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "XG2SNP", "top_sticker": top, "bottom_sticker": bot},
        )

        resp = await async_client.post(
            "/api/v1/floor/locations/part",
            json={"payload": top, "location_slug": "ready-for-production-inventory"},
        )

        assert resp.status_code == 200
        assert resp.json()["result"] == "shipped"


@pytest.mark.asyncio
@pytest.mark.integration
class TestUnlinkApi:
    async def test_unlink_frees_serial_and_reopens_link(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        linked = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "XG2SNP", "top_sticker": top, "bottom_sticker": bot},
        )
        unit_id = linked.json()["unit"]["id"]

        resp = await async_client.post(f"/api/v1/floor/units/{unit_id}/unlink")
        assert resp.status_code == 200
        assert resp.json()["result"] == "unlinked"

        # Serial is free again.
        assert (await async_client.get("/api/v1/floor/units/by-serial/XG2SNP")).status_code == 404

        # Both housings are In WIP again — the same serial + pair link cleanly.
        again = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "XG2SNP", "top_sticker": top, "bottom_sticker": bot},
        )
        assert again.json()["result"] == "linked"

    async def test_unlink_unknown_is_404(self, async_client):
        resp = await async_client.post("/api/v1/floor/units/999999/unlink")
        assert resp.status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
class TestReturnUnitReworkApi:
    async def test_return_rework_unlinks_and_frees_serial(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "XG2SNP", "top_sticker": top, "bottom_sticker": bot},
        )

        resp = await async_client.post(
            "/api/v1/floor/units/return-rework",
            json={"serial": "XG2SNP", "reason_code": "doesnt_fit", "reason_text": "Customer return"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "returned"
        assert (await async_client.get("/api/v1/floor/units/by-serial/XG2SNP")).status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
class TestReplaceApi:
    async def test_replace_top_via_api(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        linked = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "XG2SNP", "top_sticker": top, "bottom_sticker": bot},
        )
        unit_id = linked.json()["unit"]["id"]

        top2 = await _enroll_top_in_wip(async_client, printer_factory, archive_factory)
        resp = await async_client.post(
            f"/api/v1/floor/units/{unit_id}/replace",
            json={"top_sticker": top2},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "replaced"
        assert body["unit"]["serial_code"] == "XG2SNP"
        assert body["unit"]["top_sticker"] == top2
        assert body["unit"]["bottom_sticker"] == bot

    async def test_replace_bottom_via_api(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        linked = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "8TBDT9", "top_sticker": top, "bottom_sticker": bot},
        )
        unit_id = linked.json()["unit"]["id"]

        bot2 = await _enroll_bot_in_wip(async_client, printer_factory, archive_factory)
        resp = await async_client.post(
            f"/api/v1/floor/units/{unit_id}/replace",
            json={"bottom_sticker": bot2},
        )

        assert resp.status_code == 200
        assert resp.json()["result"] == "replaced"
        assert resp.json()["unit"]["bottom_sticker"] == bot2

    async def test_replace_unknown_unit_is_404(self, async_client):
        resp = await async_client.post(
            "/api/v1/floor/units/999999/replace",
            json={"top_sticker": "BBD-000001"},
        )
        assert resp.status_code == 404

    async def test_replace_ineligible_top_refused(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        linked = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "IX72HD", "top_sticker": top, "bottom_sticker": bot},
        )
        unit_id = linked.json()["unit"]["id"]

        # A BOT sticker in the top slot is not eligible.
        bot2 = await _enroll_bot_in_wip(async_client, printer_factory, archive_factory)
        resp = await async_client.post(
            f"/api/v1/floor/units/{unit_id}/replace",
            json={"top_sticker": bot2},
        )

        assert resp.status_code == 200
        assert resp.json()["result"] == "top_not_eligible"


@pytest.mark.asyncio
@pytest.mark.integration
class TestReplaceKitApi:
    async def test_replace_knob_via_api(self, async_client, printer_factory, archive_factory):
        top, bot = await _kitted_top_and_bot(async_client, printer_factory, archive_factory)
        linked = await async_client.post(
            "/api/v1/floor/units/link",
            json={"serial": "XG2SNP", "top_sticker": top, "bottom_sticker": bot},
        )
        unit = linked.json()["unit"]
        unit_id = unit["id"]
        old_knob = unit["knob_batch_id"]

        # Stage a second KNB harvest at Ready-for-Production (not In WIP).
        await _bin_to_ready(async_client, printer_factory, archive_factory, "BBN-KNB-2", 5)
        bins = await async_client.get("/api/v1/floor/inventory/bins?include_history=true")
        knb2 = next(row["batch"] for row in bins.json() if row.get("batch") and row["batch"]["payload"] == "BBN-KNB-2")

        resp = await async_client.post(
            f"/api/v1/floor/units/{unit_id}/replace-kit",
            json={"slot": "KNB", "batch_id": knb2["id"]},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "replaced"
        assert body["unit"]["knob_batch_id"] == knb2["id"]
        assert body["unit"]["knob_batch_id"] != old_knob
        assert body["new_remaining"] == 4

    async def test_replace_kit_unknown_unit_is_404(self, async_client):
        resp = await async_client.post(
            "/api/v1/floor/units/999999/replace-kit",
            json={"slot": "KNB", "batch_id": 1},
        )
        assert resp.status_code == 404
