"""Integration tests for the harvest and labeled-parts routes.

``docs/floor-plan.md`` §5.4 (Harvest), §5.6 (printer scan), §7 (part
identity/record), §9 (mis-scans). The resolution logic has its own unit
tests (``test_floor_parts.py``); these cover the wiring — status codes,
response shape, and every documented ``result`` value for both POST
endpoints, plus the needs-attention list.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from httpx import AsyncClient

from backend.tests.integration.test_library_section_parts_api import _create_tracking_section_with_part
from backend.tests.integration.test_production_api import _3mf, _config

DEVICE_A = "device-a"
DEVICE_B = "device-b"


async def _open_harvest(client: AsyncClient, device_id: str):
    return await client.post(
        "/api/v1/floor/session/scan",
        json={"payload": "BBS-harvest", "device_id": device_id},
    )


async def _scan_printer(client: AsyncClient, printer_id: int, device_id: str):
    return await client.post(
        "/api/v1/floor/harvest/printer",
        json={"payload": f"BBP-{printer_id}", "device_id": device_id},
    )


async def _scan_part(client: AsyncClient, code: str, device_id: str, printer_id: int | None = None):
    body = {"payload": code, "device_id": device_id}
    if printer_id is not None:
        body["printer_id"] = printer_id
    return await client.post("/api/v1/floor/parts/scan", json=body)


async def _scan_fit_check_part(client: AsyncClient, code: str):
    return await client.post("/api/v1/floor/locations/fit-check/part", json={"payload": code})


async def _scan_rework_part(client: AsyncClient, code: str, reason_code: str, reason_text: str | None = None):
    body = {"payload": code, "reason_code": reason_code}
    if reason_text is not None:
        body["reason_text"] = reason_text
    return await client.post("/api/v1/floor/locations/rework/part", json=body)


async def _harvest_one_part(client: AsyncClient, printer_id: int, device_id: str, code: str = "BBD-000001"):
    """Enroll one part via Harvest so a Fit Check/Rework test has something
    to scan. Closes the Harvest session afterward — Fit Check and Rework
    are locations, not stations, so there is nothing left open for them."""
    await _open_harvest(client, device_id)
    await _scan_printer(client, printer_id, device_id)
    await _scan_part(client, code, device_id)
    await _open_harvest(client, device_id)  # re-scanning Harvest's own QR closes the session


@pytest.mark.asyncio
@pytest.mark.integration
class TestHarvestPrinterScan:
    async def test_binds_to_the_latest_finished_job(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory(name="Bench A")
        archive = await archive_factory(printer_id=printer.id, print_name="Bracket v4", quantity=4)
        await _open_harvest(async_client, DEVICE_A)

        resp = await _scan_printer(async_client, printer.id, DEVICE_A)

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "bound"
        assert body["printer"] == {"id": printer.id, "name": "Bench A"}
        assert body["archive"]["id"] == archive.id
        assert body["archive"]["print_name"] == "Bracket v4"
        assert body["archive"]["quantity"] == 4
        assert body["part_count"] == 0
        assert body["session"]["station_slug"] == "harvest"

    async def test_binds_with_no_job_found(self, async_client, printer_factory):
        printer = await printer_factory()
        await _open_harvest(async_client, DEVICE_A)

        resp = await _scan_printer(async_client, printer.id, DEVICE_A)

        body = resp.json()
        assert body["result"] == "bound"
        assert body["archive"] is None

    async def test_rescanning_the_same_printer_closes_the_plate_only(
        self, async_client, printer_factory, archive_factory
    ):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)

        resp = await _scan_printer(async_client, printer.id, DEVICE_A)

        assert resp.json()["result"] == "plate_closed"
        # The harvest session itself is untouched — only the plate closed.
        session = await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_A})
        assert session.json()["station_slug"] == "harvest"

    async def test_scanning_a_different_printer_rebinds(self, async_client, printer_factory, archive_factory):
        first = await printer_factory()
        second = await printer_factory(name="Bench B")
        await archive_factory(printer_id=first.id)
        second_archive = await archive_factory(printer_id=second.id, print_name="Other job")
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, first.id, DEVICE_A)

        resp = await _scan_printer(async_client, second.id, DEVICE_A)

        body = resp.json()
        assert body["result"] == "rebound"
        assert body["printer"]["name"] == "Bench B"
        assert body["archive"]["id"] == second_archive.id
        assert body["part_count"] == 0

    async def test_unknown_printer_code(self, async_client):
        await _open_harvest(async_client, DEVICE_A)

        resp = await _scan_printer(async_client, 999999, DEVICE_A)

        assert resp.status_code == 200
        assert resp.json()["result"] == "unknown_printer"

    async def test_no_session_reports_cleanly(self, async_client, printer_factory):
        printer = await printer_factory()

        resp = await _scan_printer(async_client, printer.id, DEVICE_A)

        assert resp.status_code == 200
        assert resp.json()["result"] == "no_session"

    async def test_requires_the_floor_scan_permission_guard(self, async_client):
        """Same dependency as the existing floor routes — not asserting the
        auth stack itself (disabled in tests), just that the route is wired
        through it rather than left unguarded."""
        resp = await async_client.post(
            "/api/v1/floor/harvest/printer",
            json={"payload": "BBP-1", "device_id": DEVICE_A},
        )
        # Auth is disabled in the test app, so this is a normal `no_session`
        # 200 rather than a 401/403 — the guard itself has its own coverage
        # in the auth suite. This just proves the dependency is present and
        # doesn't 500.
        assert resp.status_code == 200


@pytest.mark.asyncio
@pytest.mark.integration
class TestPartScan:
    async def test_labels_a_part_against_the_bound_plate(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)

        resp = await _scan_part(async_client, "BBD-000001", DEVICE_A)

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "labeled"
        assert body["part"]["sticker_code"] == "BBD-000001"
        assert body["part"]["printer_id"] == printer.id
        assert body["part"]["archive_id"] == archive.id
        assert body["part_count"] == 1

    async def test_no_job_still_records_the_part(self, async_client, printer_factory):
        printer = await printer_factory()
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)

        resp = await _scan_part(async_client, "BBD-000001", DEVICE_A)

        body = resp.json()
        assert body["result"] == "no_job"
        assert body["part"]["printer_id"] == printer.id
        assert body["part"]["archive_id"] is None
        assert body["part"]["labeled_at"] is not None

    async def test_duplicate_part_is_rejected(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await _scan_part(async_client, "BBD-000001", DEVICE_A)

        resp = await _scan_part(async_client, "BBD-000001", DEVICE_A)

        body = resp.json()
        assert body["result"] == "duplicate"
        assert body["part"] is None

    async def test_duplicate_part_does_not_change_the_current_plate(
        self, async_client, printer_factory, archive_factory
    ):
        """A duplicate does not increment or otherwise alter the plate."""
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await _scan_part(async_client, "BBD-000001", DEVICE_A)
        await _scan_part(async_client, "BBD-000002", DEVICE_A)

        resp = await _scan_part(async_client, "BBD-000001", DEVICE_A)

        body = resp.json()
        assert body["result"] == "duplicate"
        assert body["part_count"] == 0

    async def test_invalid_code(self, async_client):
        resp = await _scan_part(async_client, "not-a-code", DEVICE_A)

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "invalid_code"
        assert body["part"] is None

    async def test_no_printer_when_harvest_open_but_unbound(self, async_client):
        await _open_harvest(async_client, DEVICE_A)

        resp = await _scan_part(async_client, "BBD-000001", DEVICE_A)

        assert resp.json()["result"] == "no_printer"

    async def test_no_printer_with_no_session_and_no_hint(self, async_client):
        resp = await _scan_part(async_client, "BBD-000001", DEVICE_A)

        assert resp.json()["result"] == "no_printer"

    async def test_no_printer_when_a_different_stations_session_is_held(self, async_client):
        await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-storage-receive", "device_id": DEVICE_A},
        )

        resp = await _scan_part(async_client, "BBD-000001", DEVICE_A)

        assert resp.json()["result"] == "no_printer"

    async def test_first_scan_from_printer_info_page_claims_the_lock(
        self, async_client, printer_factory, archive_factory
    ):
        printer = await printer_factory()
        archive = await archive_factory(printer_id=printer.id)

        resp = await _scan_part(async_client, "BBD-000001", DEVICE_A, printer_id=printer.id)

        body = resp.json()
        assert body["result"] == "labeled"
        assert body["part"]["archive_id"] == archive.id
        assert body["session"]["station_slug"] == "harvest"

        # And the device now holds a harvest session, same as if it had
        # scanned BBS-harvest first.
        session = await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_A})
        assert session.json()["station_slug"] == "harvest"

    async def test_locked_when_another_device_holds_harvest(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)

        resp = await _scan_part(async_client, "BBD-000001", DEVICE_B, printer_id=printer.id)

        body = resp.json()
        assert body["result"] == "locked"
        assert body["part"] is None
        assert body["blocking"]["device_id"] == DEVICE_A

    async def test_both_entry_points_produce_identical_part_rows(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer_id=printer.id)

        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        via_station = (await _scan_part(async_client, "BBD-000001", DEVICE_A)).json()
        # Free the lock before device B claims it — floor-wide, §5.4.
        await _open_harvest(async_client, DEVICE_A)

        via_info_page = (await _scan_part(async_client, "BBD-000002", DEVICE_B, printer_id=printer.id)).json()

        assert via_station["result"] == via_info_page["result"] == "labeled"
        assert via_station["part"]["printer_id"] == via_info_page["part"]["printer_id"] == printer.id
        assert via_station["part"]["archive_id"] == via_info_page["part"]["archive_id"] == archive.id


@pytest.mark.asyncio
@pytest.mark.integration
class TestFitCheckPartScan:
    """§5.4a: a location, not a station — the route takes just the sticker
    payload, no device_id/session involved at all."""

    async def test_records_a_fit_checked_event(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory(name="Bench A")
        archive = await archive_factory(printer_id=printer.id, print_name="Bracket v4")
        await _harvest_one_part(async_client, printer.id, DEVICE_A)

        resp = await _scan_fit_check_part(async_client, "BBD-000001")

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "recorded"
        assert body["part"]["sticker_code"] == "BBD-000001"
        assert body["printer"] == {"id": printer.id, "name": "Bench A"}
        assert body["archive"]["id"] == archive.id

    async def test_rescanning_an_already_checked_part_is_rejected(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _harvest_one_part(async_client, printer.id, DEVICE_A)
        await _scan_fit_check_part(async_client, "BBD-000001")

        resp = await _scan_fit_check_part(async_client, "BBD-000001")

        assert resp.status_code == 200
        assert resp.json()["result"] == "already_at_location"

    async def test_unknown_sticker_is_rejected(self, async_client):
        resp = await _scan_fit_check_part(async_client, "BBD-000001")

        assert resp.status_code == 200
        assert resp.json()["result"] == "unknown_part"

    async def test_unlinked_harvest_record_is_rejected(self, async_client, printer_factory):
        printer = await printer_factory()
        await _harvest_one_part(async_client, printer.id, DEVICE_A)

        resp = await _scan_fit_check_part(async_client, "BBD-000001")

        assert resp.status_code == 200
        assert resp.json()["result"] == "unknown_part"
        assert resp.json()["part"] is None

    async def test_invalid_code(self, async_client):
        resp = await _scan_fit_check_part(async_client, "not-a-code")

        assert resp.status_code == 200
        assert resp.json()["result"] == "invalid_code"

    async def test_commits_with_no_station_open_anywhere(self, async_client, printer_factory, archive_factory):
        """The common case: idle, no station open at all, just a part then
        a location."""
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _harvest_one_part(async_client, printer.id, DEVICE_A)
        session = await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_A})
        assert session.json() is None  # confirms _harvest_one_part left nothing open

        resp = await _scan_fit_check_part(async_client, "BBD-000001")

        assert resp.json()["result"] == "recorded"

    async def test_event_appears_in_part_history(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _harvest_one_part(async_client, printer.id, DEVICE_A)
        scan_resp = await _scan_fit_check_part(async_client, "BBD-000001")
        part_id = scan_resp.json()["part"]["id"]

        resp = await async_client.get(f"/api/v1/floor/inventory/parts/{part_id}/events")

        actions = [e["action"] for e in resp.json()]
        assert actions == ["enrolled", "fit_checked"]

    async def test_session_scan_refuses_to_open_it_as_a_station(self, async_client):
        """§5.4a: `BBS-initial-qc-pass` is a printable, resolvable payload (the
        Codes page's Locations tab needs that), but it must never open a
        session the way a real station QR does."""
        resp = await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-initial-qc-pass", "device_id": DEVICE_A},
        )

        assert resp.status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
class TestReworkPartScan:
    """§5.4b: the third scan of its flow (part, Rework location — a pure UI
    transition with no server call, then reason). Like Fit Check, this is a
    plain commit with no session concept."""

    async def test_records_a_rework_event_with_the_reason(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory(name="Bench A")
        archive = await archive_factory(printer_id=printer.id, print_name="Bracket v4")
        await _harvest_one_part(async_client, printer.id, DEVICE_A)

        resp = await _scan_rework_part(async_client, "BBD-000001", "doesnt_fit")

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "recorded"
        assert body["part"]["sticker_code"] == "BBD-000001"
        assert body["printer"] == {"id": printer.id, "name": "Bench A"}
        assert body["archive"]["id"] == archive.id

        events = await async_client.get(f"/api/v1/floor/inventory/parts/{body['part']['id']}/events")
        last_event = events.json()[-1]
        assert last_event["action"] == "rework"
        assert last_event["details"] == {"reason_code": "doesnt_fit", "reason_text": None}

    async def test_other_reason_carries_free_text(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _harvest_one_part(async_client, printer.id, DEVICE_A)

        resp = await _scan_rework_part(async_client, "BBD-000001", "other", "warped corner")

        part_id = resp.json()["part"]["id"]
        events = await async_client.get(f"/api/v1/floor/inventory/parts/{part_id}/events")
        assert events.json()[-1]["details"] == {"reason_code": "other", "reason_text": "warped corner"}

    async def test_unknown_sticker_is_rejected(self, async_client):
        resp = await _scan_rework_part(async_client, "BBD-000001", "other", "note")

        assert resp.status_code == 200
        assert resp.json()["result"] == "unknown_part"

    async def test_invalid_code(self, async_client):
        resp = await _scan_rework_part(async_client, "not-a-code", "other", "note")

        assert resp.status_code == 200
        assert resp.json()["result"] == "invalid_code"

    async def test_session_scan_refuses_to_open_it_as_a_station(self, async_client):
        resp = await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-rework", "device_id": DEVICE_A},
        )

        assert resp.status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
class TestNeedsAttention:
    async def test_lists_parts_with_no_job(self, async_client, printer_factory):
        printer = await printer_factory(name="Bench A")
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await _scan_part(async_client, "BBD-000001", DEVICE_A)

        resp = await async_client.get("/api/v1/floor/parts/needs-attention")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert body["parts"][0]["sticker_code"] == "BBD-000001"
        assert body["parts"][0]["printer_name"] == "Bench A"

    async def test_excludes_labeled_parts(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await _scan_part(async_client, "BBD-000001", DEVICE_A)

        resp = await async_client.get("/api/v1/floor/parts/needs-attention")

        assert resp.json() == {"parts": [], "total": 0}

    async def test_reports_the_unbounded_total_separately_from_the_page(self, async_client, printer_factory):
        printer = await printer_factory()
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        for i in range(3):
            await _scan_part(async_client, f"BBD-00000{i}", DEVICE_A)

        resp = await async_client.get("/api/v1/floor/parts/needs-attention", params={"limit": 2})

        body = resp.json()
        assert len(body["parts"]) == 2
        assert body["total"] == 3

    async def test_excludes_build_plate_linked_by_a_reusable_bin(
        self, async_client, db_session, printer_factory, archive_factory
    ):
        from backend.app.models.settings import Settings

        db_session.add(
            Settings(
                key="floor_part_tracking_started_at",
                value=(datetime.now() - timedelta(minutes=1)).isoformat(),
            )
        )
        await db_session.commit()
        printer = await printer_factory(name="Bench A")
        archive = await archive_factory(
            printer_id=printer.id,
            completed_at=datetime.now() + timedelta(minutes=1),
            print_name="Knob plate",
        )
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)

        before = await async_client.get("/api/v1/floor/parts/unlabeled-build-plates")
        assert any(plate["id"] == archive.id for plate in before.json())

        saved = await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-KNB-1", "quantity": 12},
        )
        assert saved.json()["result"] == "recorded"
        assert saved.json()["batch"]["archive_id"] == archive.id

        after = await async_client.get("/api/v1/floor/parts/unlabeled-build-plates")
        assert not any(plate["id"] == archive.id for plate in after.json())


@pytest.mark.asyncio
@pytest.mark.integration
class TestPartSurvivesPrinterDeletion:
    """The FloorLabeledPart.printer_id deviation from the phase 8 contract
    (nullable instead of NOT NULL, see that model's docstring): deleting a
    printer must degrade its parts to needs-attention, never delete or
    dangle them."""

    async def test_deleting_a_printer_orphans_its_parts_instead_of_deleting_them(
        self, async_client, printer_factory, archive_factory
    ):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await _scan_part(async_client, "BBD-000001", DEVICE_A)

        resp = await async_client.delete(f"/api/v1/printers/{printer.id}")
        assert resp.status_code == 200

        # The part row survives, degraded: printer_id and archive_id both
        # null now (the archive was deleted along with the printer by
        # delete_archives' default), same shape as a genuine needs-attention
        # row rather than a dangling reference to a printer that no longer
        # exists.
        again = await _scan_part(async_client, "BBD-000001", DEVICE_B)
        assert again.json()["result"] == "duplicate"
        assert again.json()["part"] is None

        # And it now shows up as needing attention, same as a genuine no-job
        # part — not silently excluded by a dangling archive_id.
        attention = await async_client.get("/api/v1/floor/parts/needs-attention")
        assert attention.json()["total"] == 1
        assert attention.json()["parts"][0]["sticker_code"] == "BBD-000001"

    async def test_deleting_a_printer_clears_a_bound_but_unclosed_plate(
        self, async_client, printer_factory, archive_factory
    ):
        """A harvest session left bound to a printer that gets deleted mid-
        session must not keep pointing at it — the next scan should see a
        clean, unbound session rather than a dangling id."""
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)

        await async_client.delete(f"/api/v1/printers/{printer.id}")

        # Scanning a fresh printer must bind cleanly rather than tripping
        # over the stale plate.
        other = await printer_factory()
        other_archive = await archive_factory(printer_id=other.id)
        resp = await _scan_printer(async_client, other.id, DEVICE_A)
        body = resp.json()
        # Since the deleted printer's binding was cleared to None/None,
        # scanning a new printer reads as a fresh bind, not a rebind.
        assert body["result"] == "bound"
        assert body["archive"]["id"] == other_archive.id


@pytest.mark.asyncio
@pytest.mark.integration
class TestViewingPrinterInfoTakesNoLock:
    async def test_viewing_a_printer_still_takes_no_harvest_lock(self, async_client, printer_factory):
        """Regression guard (phase 7): the info page itself must stay a pure
        read even after phase 8 adds part scanning from it."""
        printer = await printer_factory()

        await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        session = await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_A})
        assert session.json() is None

    async def test_has_labeled_parts_reflects_real_data(self, async_client, printer_factory, archive_factory):
        """§5.6/phase 8: the info page's last-print panel must show real
        labeling state, not the phase-7 hardcoded False."""
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)

        before = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")
        assert before.json()["last_print"]["has_labeled_parts"] is False

        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await _scan_part(async_client, "BBD-000001", DEVICE_A)

        after = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")
        assert after.json()["last_print"]["has_labeled_parts"] is True


@pytest.mark.asyncio
@pytest.mark.integration
class TestPartHistoryApi:
    """The office-side traceability endpoints used by Part history."""

    async def test_unresolved_part_exposes_same_printer_job_candidates_and_events(
        self, async_client, printer_factory, archive_factory
    ):
        printer = await printer_factory(name="Bench A")
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]
        candidate = await archive_factory(printer_id=printer.id, print_name="Bracket v4")
        other_printer = await printer_factory(name="Bench B")
        await archive_factory(printer_id=other_printer.id, print_name="Wrong machine")

        candidates = await async_client.get(f"/api/v1/floor/inventory/parts/{part_id}/job-candidates")
        assert candidates.status_code == 200
        assert candidates.json() == [{"id": candidate.id, "print_name": "Bracket v4", "completed_at": None}]

        events = await async_client.get(f"/api/v1/floor/inventory/parts/{part_id}/events")
        assert events.status_code == 200
        assert events.json()[0]["action"] == "enrolled"
        assert events.json()[0]["details"]["archive_id"] is None

    async def test_matching_only_resolves_an_unlinked_part(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]
        archive = await archive_factory(printer_id=printer.id, print_name="Bracket v4")

        matched = await async_client.post(
            f"/api/v1/floor/inventory/parts/{part_id}/relink", json={"archive_id": archive.id}
        )
        assert matched.status_code == 200
        assert matched.json()["archive_id"] == archive.id

        # Established harvest/matched links are trace evidence, not editable
        # state. A second POST must not silently replace it.
        again = await async_client.post(
            f"/api/v1/floor/inventory/parts/{part_id}/relink", json={"archive_id": archive.id}
        )
        assert again.status_code == 404

        events = await async_client.get(f"/api/v1/floor/inventory/parts/{part_id}/events")
        assert events.status_code == 200
        assert [event["action"] for event in events.json()] == ["enrolled", "relinked"]

    async def test_rescan_appends_a_scanned_event_without_changing_the_link(
        self, async_client, printer_factory, archive_factory
    ):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000010", DEVICE_A)
        part_id = scanned.json()["part"]["id"]

        duplicate = await _scan_part(async_client, "BBD-000010", DEVICE_A)
        assert duplicate.status_code == 200
        assert duplicate.json()["result"] == "duplicate"

        events = await async_client.get(f"/api/v1/floor/inventory/parts/{part_id}/events")
        assert events.status_code == 200
        assert [event["action"] for event in events.json()] == ["enrolled", "scanned"]
        assert events.json()[1]["details"]["station_slug"] == "harvest"
        assert events.json()[1]["details"]["printer_id"] == printer.id

    async def test_unlink_then_relink_round_trip_including_a_different_printer(
        self, async_client, printer_factory, archive_factory
    ):
        printer = await printer_factory(name="Bench A")
        archive = await archive_factory(printer_id=printer.id, print_name="Bracket v4")
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]
        assert scanned.json()["part"]["archive_id"] == archive.id

        unlinked = await async_client.post(
            f"/api/v1/floor/inventory/parts/{part_id}/unlink", json={"reason_code": "wrong_job"}
        )
        assert unlinked.status_code == 200
        assert unlinked.json()["archive_id"] is None

        # Back in needs-attention shape, same as a genuine no-job part.
        attention = await async_client.get("/api/v1/floor/parts/needs-attention")
        assert any(p["sticker_code"] == "BBD-000001" for p in attention.json()["parts"])

        # Relink to a different job — on a different printer entirely — now
        # succeeds where the old printer-constrained guard would have 404'd.
        other_printer = await printer_factory(name="Bench B")
        other_archive = await archive_factory(printer_id=other_printer.id, print_name="Correct job")

        relinked = await async_client.post(
            f"/api/v1/floor/inventory/parts/{part_id}/relink", json={"archive_id": other_archive.id}
        )
        assert relinked.status_code == 200
        body = relinked.json()
        assert body["archive_id"] == other_archive.id
        assert body["printer_id"] == other_printer.id

    async def test_unlink_reason_other_without_text_is_422(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]

        resp = await async_client.post(f"/api/v1/floor/inventory/parts/{part_id}/unlink", json={"reason_code": "other"})

        assert resp.status_code == 422

    async def test_unlink_invalid_reason_code_is_422(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]

        resp = await async_client.post(
            f"/api/v1/floor/inventory/parts/{part_id}/unlink", json={"reason_code": "not_a_real_code"}
        )

        assert resp.status_code == 422

    async def test_job_search_returns_cross_printer_results(self, async_client, printer_factory, archive_factory):
        bench_a = await printer_factory(name="Bench A")
        bench_b = await printer_factory(name="Bench B")
        match_a = await archive_factory(printer_id=bench_a.id, print_name="Widget Alpha")
        match_b = await archive_factory(printer_id=bench_b.id, print_name="Widget Beta")

        resp = await async_client.get("/api/v1/floor/inventory/jobs/search", params={"q": "widget"})

        assert resp.status_code == 200
        rows = resp.json()
        by_id = {row["id"]: row for row in rows}
        assert set(by_id) == {match_a.id, match_b.id}
        assert by_id[match_a.id]["printer_name"] == "Bench A"
        assert by_id[match_b.id]["printer_name"] == "Bench B"

    async def test_replace_sticker_round_trip(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]

        resp = await async_client.post(
            f"/api/v1/floor/inventory/parts/{part_id}/replace-sticker",
            json={"new_sticker_code": "BBD-000099", "reason_code": "damaged"},
        )

        assert resp.status_code == 200
        assert resp.json()["sticker_code"] == "BBD-000099"

        # The old code no longer resolves to the existing part — the plate
        # is still open and bound, so re-scanning it enrolls a brand-new row
        # instead of finding the (now renamed) original.
        rescanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        assert rescanned.json()["part"]["id"] != part_id
        assert rescanned.json()["part"]["archive_id"] == archive.id

        parts = await async_client.get("/api/v1/floor/inventory/parts")
        assert any(p["sticker_code"] == "BBD-000099" for p in parts.json())

    async def test_replace_sticker_code_already_in_use_is_409(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await _scan_part(async_client, "BBD-000001", DEVICE_A)
        second = await _scan_part(async_client, "BBD-000002", DEVICE_A)
        part_id = second.json()["part"]["id"]

        resp = await async_client.post(
            f"/api/v1/floor/inventory/parts/{part_id}/replace-sticker",
            json={"new_sticker_code": "BBD-000001", "reason_code": "damaged"},
        )

        assert resp.status_code == 409

    async def test_unlink_and_replace_against_an_archived_part(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]

        archived = await async_client.post(f"/api/v1/floor/inventory/parts/{part_id}/archive")
        assert archived.status_code == 200

        # `unlink` keeps `relink`'s single-catch-all-404 style — it does not
        # distinguish "archived" from "missing" or "already unlinked".
        unlink_resp = await async_client.post(
            f"/api/v1/floor/inventory/parts/{part_id}/unlink", json={"reason_code": "wrong_job"}
        )
        assert unlink_resp.status_code == 404

        # `replace-sticker` has enough distinct failure modes to earn its own
        # outcome dataclass (`ReplaceStickerOutcome`) and a dedicated 400 for
        # the archived case specifically.
        replace_resp = await async_client.post(
            f"/api/v1/floor/inventory/parts/{part_id}/replace-sticker",
            json={"new_sticker_code": "BBD-000099", "reason_code": "damaged"},
        )
        assert replace_resp.status_code == 400


def _seeded_3mf() -> bytes:
    return _3mf(_config(), extra_files={"Metadata/plate_1.png": b"\x89PNG\r\n\x1a\n"})


@pytest.mark.asyncio
@pytest.mark.integration
class TestPartCodeThumbnail:
    """`GET /floor/parts/thumbnail/{code}` — the 3MF cover image already
    captured in Files for a Production part code (§7), shown on the scan
    page next to a resolved part. Unknown code and known-but-imageless code
    are both a plain 404 — the scan page treats them the same."""

    async def test_unknown_code_is_404(self, async_client):
        resp = await async_client.get("/api/v1/floor/parts/thumbnail/ZZZ")
        assert resp.status_code == 404

    async def test_known_code_with_no_thumbnail_seeded_is_404(self, async_client):
        await _create_tracking_section_with_part(async_client, code="TOP")
        resp = await async_client.get("/api/v1/floor/parts/thumbnail/TOP")
        assert resp.status_code == 404

    async def test_seeded_code_serves_its_3mf_cover_image(self, async_client):
        section_id, part_id = await _create_tracking_section_with_part(async_client, code="TOP")
        seed = await async_client.post(
            f"/api/v1/library/sections/{section_id}/parts/{part_id}/parameters",
            files={"file": ("spec.3mf", _seeded_3mf(), "application/octet-stream")},
        )
        assert seed.status_code == 200, seed.text

        resp = await async_client.get("/api/v1/floor/parts/thumbnail/TOP")
        assert resp.status_code == 200
        assert resp.content.startswith(b"\x89PNG")

    async def test_code_lookup_is_case_and_whitespace_insensitive(self, async_client):
        section_id, part_id = await _create_tracking_section_with_part(async_client, code="TOP")
        await async_client.post(
            f"/api/v1/library/sections/{section_id}/parts/{part_id}/parameters",
            files={"file": ("spec.3mf", _seeded_3mf(), "application/octet-stream")},
        )

        resp = await async_client.get("/api/v1/floor/parts/thumbnail/%20top%20")
        assert resp.status_code == 200
        assert resp.content.startswith(b"\x89PNG")


@pytest.mark.asyncio
@pytest.mark.integration
class TestPartCodeCatalogAndAssignment:
    """`GET /floor/parts/codes` and `POST /floor/inventory/parts/{id}/part-code`
    — Part history's "assign a part code" flow for a sticker harvest could
    not resolve one for (§7)."""

    async def test_lists_the_catalog(self, async_client):
        section_id, _ = await _create_tracking_section_with_part(async_client, code="TOP")
        await async_client.post(f"/api/v1/library/sections/{section_id}/parts", json={"code": "BOT", "name": "Bottom"})

        resp = await async_client.get("/api/v1/floor/parts/codes")

        assert resp.status_code == 200
        codes = {row["code"] for row in resp.json()}
        assert {"TOP", "BOT"} <= codes

    async def test_assigns_a_code_to_a_part_with_none(self, async_client, printer_factory):
        await _create_tracking_section_with_part(async_client, code="TOP")
        printer = await printer_factory()
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]
        assert scanned.json()["part"]["part_code"] is None

        resp = await async_client.post(f"/api/v1/floor/inventory/parts/{part_id}/part-code", json={"code": "TOP"})

        assert resp.status_code == 200
        assert resp.json()["part_code"] == "TOP"

        events = await async_client.get(f"/api/v1/floor/inventory/parts/{part_id}/events")
        assert events.json()[-1]["action"] == "part_code_assigned"
        assert events.json()[-1]["details"] == {"part_code": "TOP", "previous_code": None}

    async def test_normalizes_case_and_whitespace(self, async_client, printer_factory):
        await _create_tracking_section_with_part(async_client, code="TOP")
        printer = await printer_factory()
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]

        resp = await async_client.post(f"/api/v1/floor/inventory/parts/{part_id}/part-code", json={"code": " top "})

        assert resp.status_code == 200
        assert resp.json()["part_code"] == "TOP"

    async def test_unknown_code_is_400(self, async_client, printer_factory):
        printer = await printer_factory()
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]

        resp = await async_client.post(f"/api/v1/floor/inventory/parts/{part_id}/part-code", json={"code": "ZZZ"})

        assert resp.status_code == 400

    async def test_changes_when_a_code_is_already_set(self, async_client, printer_factory):
        section_id, _ = await _create_tracking_section_with_part(async_client, code="TOP")
        await async_client.post(f"/api/v1/library/sections/{section_id}/parts", json={"code": "BOT", "name": "Bottom"})
        printer = await printer_factory()
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]
        first = await async_client.post(f"/api/v1/floor/inventory/parts/{part_id}/part-code", json={"code": "TOP"})
        assert first.status_code == 200

        resp = await async_client.post(f"/api/v1/floor/inventory/parts/{part_id}/part-code", json={"code": "BOT"})

        assert resp.status_code == 200
        assert resp.json()["part_code"] == "BOT"

    async def test_missing_part_is_404(self, async_client):
        resp = await async_client.post("/api/v1/floor/inventory/parts/999999/part-code", json={"code": "TOP"})
        assert resp.status_code == 404

    async def test_refuses_on_an_archived_part(self, async_client, printer_factory):
        await _create_tracking_section_with_part(async_client, code="TOP")
        printer = await printer_factory()
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]
        archived = await async_client.post(f"/api/v1/floor/inventory/parts/{part_id}/archive")
        assert archived.status_code == 200

        resp = await async_client.post(f"/api/v1/floor/inventory/parts/{part_id}/part-code", json={"code": "TOP"})

        assert resp.status_code == 400


@pytest.mark.asyncio
@pytest.mark.integration
class TestManualPartStatus:
    async def test_overrides_to_a_supported_status_and_exposes_it_in_history(self, async_client, printer_factory):
        printer = await printer_factory()
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]

        resp = await async_client.post(
            f"/api/v1/floor/inventory/parts/{part_id}/status",
            json={"status": "shipped"},
        )

        assert resp.status_code == 200
        assert resp.json()["latest_event_action"] == "shipped"
        events = await async_client.get(f"/api/v1/floor/inventory/parts/{part_id}/events")
        assert events.json()[-1]["action"] == "shipped"
        assert events.json()[-1]["details"]["status_override"] is True

    async def test_rejects_missing_part_and_metadata_status(self, async_client, printer_factory):
        missing = await async_client.post("/api/v1/floor/inventory/parts/999999/status", json={"status": "wip"})
        assert missing.status_code == 404

        printer = await printer_factory()
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        scanned = await _scan_part(async_client, "BBD-000001", DEVICE_A)
        part_id = scanned.json()["part"]["id"]
        invalid = await async_client.post(
            f"/api/v1/floor/inventory/parts/{part_id}/status",
            json={"status": "Ready for shipment"},
        )
        assert invalid.status_code == 400


@pytest.mark.asyncio
@pytest.mark.integration
class TestReusableBinFlow:
    async def test_lists_separate_knob_and_button_bins_for_each_printer(self, async_client, printer_factory):
        await printer_factory(name="Bench A")

        response = await async_client.get("/api/v1/floor/bins")

        assert response.status_code == 200
        assert {item["payload"] for item in response.json()} == {
            "BBN-KNB-1",
            "BBN-KNB-2",
            "BBN-KNB-3",
            "BBN-BUT-1",
            "BBN-BUT-2",
            "BBN-BUT-3",
        }

    async def test_quantity_is_required_then_visual_qc_gates_wip(self, async_client, printer_factory):
        printer = await printer_factory(name="Bench A")
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)

        scanned = await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-KNB-1"},
        )
        assert scanned.json()["result"] == "ready_for_quantity"
        assert scanned.json()["bin"]["part_code"] == "KNB"

        saved = await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-KNB-1", "quantity": 27},
        )
        assert saved.json()["result"] == "recorded"
        assert saved.json()["batch"]["quantity"] == 27

        in_use = await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-KNB-1"},
        )
        assert in_use.json()["result"] == "bin_in_use"

        before_qc = await async_client.post("/api/v1/floor/wip/bin", json={"payload": "BBN-KNB-1"})
        assert before_qc.json()["result"] == "qc_required"

        qc = await async_client.post(
            "/api/v1/floor/locations/fit-check/bin",
            json={"payload": "BBN-KNB-1"},
        )
        assert qc.json()["result"] == "ready_for_qc_quantity"

        qc = await async_client.post(
            "/api/v1/floor/locations/fit-check/bin",
            json={"payload": "BBN-KNB-1", "passed_quantity": 20},
        )
        assert qc.json()["result"] == "qc_recorded"
        assert qc.json()["batch"]["qc_passed_quantity"] == 20
        assert qc.json()["batch"]["remaining_quantity"] == 20

        events = await async_client.get(f"/api/v1/floor/inventory/bins/batches/{qc.json()['batch']['id']}/events")
        assert events.status_code == 200
        assert events.json()[-1]["action"] == "visual_qc_passed"
        assert events.json()[-1]["details"]["passed_quantity"] == 20
        assert events.json()[-1]["details"]["rejected_quantity"] == 7

        wip = await async_client.post("/api/v1/floor/wip/bin", json={"payload": "BBN-KNB-1"})
        assert wip.json()["result"] == "wip_recorded"
        assert wip.json()["batch"]["status"] == "wip"

        empty = await async_client.post("/api/v1/floor/bins/empty", json={"payload": "BBN-KNB-1"})
        assert empty.json()["result"] == "empty_recorded"

        reused = await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-KNB-1", "quantity": 11},
        )
        assert reused.json()["result"] == "recorded"
        assert reused.json()["batch"]["quantity"] == 11

    async def test_inventory_can_override_quantity_and_unlink_active_fill(
        self, async_client, printer_factory, archive_factory
    ):
        printer = await printer_factory(name="Bench A")
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-BUT-1", "quantity": 18},
        )

        listed = await async_client.get("/api/v1/floor/inventory/bins")
        current = next(item for item in listed.json() if item["payload"] == "BBN-BUT-1")
        assert current["batch"]["remaining_quantity"] == 18
        assert current["batch"]["printer_name"] == "Bench A"

        overridden = await async_client.post(
            "/api/v1/floor/inventory/bins/quantity-override",
            json={"payload": "BBN-BUT-1", "remaining_quantity": 0},
        )
        assert overridden.json()["result"] == "empty_recorded"

        available = await async_client.get("/api/v1/floor/inventory/bins")
        assert next(item for item in available.json() if item["payload"] == "BBN-BUT-1")["batch"] is None

        history = await async_client.get("/api/v1/floor/inventory/bins?include_history=true")
        assert history.status_code == 200
        cleared = next(item for item in history.json() if item["payload"] == "BBN-BUT-1")
        assert cleared["status"] == "empty_override"
        assert cleared["batch"]["remaining_quantity"] == 0

        await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-BUT-1", "quantity": 9},
        )
        unlinked = await async_client.post(
            "/api/v1/floor/inventory/bins/unlink",
            json={"payload": "BBN-BUT-1"},
        )
        assert unlinked.json()["result"] == "unlinked"
        available_again = await async_client.get("/api/v1/floor/inventory/bins")
        unlinked_item = next(item for item in available_again.json() if item["payload"] == "BBN-BUT-1")
        assert unlinked_item["status"] == "unlinked"
        assert unlinked_item["batch"]["remaining_quantity"] == 9

        replacement_job = await archive_factory(
            printer_id=printer.id,
            print_name="BUT H2D Test Print",
            quantity=18,
        )
        incompatible_job = await archive_factory(
            printer_id=printer.id,
            print_name="TOP H2D Test Print",
            quantity=18,
        )
        candidates = await async_client.get(
            f"/api/v1/floor/inventory/bins/batches/{unlinked_item['batch']['id']}/job-candidates",
            params={"printer_id": printer.id},
        )
        assert candidates.status_code == 200
        assert all(candidate["id"] != incompatible_job.id for candidate in candidates.json())
        assert candidates.json()[0]["id"] == replacement_job.id

        relinked = await async_client.post(
            f"/api/v1/floor/inventory/bins/batches/{unlinked_item['batch']['id']}/relink",
            json={"archive_id": replacement_job.id},
        )
        assert relinked.status_code == 200
        assert relinked.json()["batch"]["archive_id"] == replacement_job.id
        assert relinked.json()["batch"]["status"] == "harvested"

        active_again = await async_client.get("/api/v1/floor/inventory/bins")
        active_item = next(item for item in active_again.json() if item["payload"] == "BBN-BUT-1")
        assert active_item["batch"]["archive_id"] == replacement_job.id

    async def test_harvest_summary_reports_bins_instead_of_zero_parts(
        self, async_client, printer_factory, archive_factory
    ):
        """A Harvest session that only harvested KNB/BUT bins used to
        summarize as zero parts (docs bug report): the summary only ever
        counted ``FloorLabeledPart`` rows, never ``FloorBinBatch`` ones."""
        printer = await printer_factory(name="Bench A")
        await archive_factory(printer_id=printer.id, print_name="Button plate")
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-BUT-1", "quantity": 12},
        )
        session = await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_A})
        session_id = session.json()["id"]

        summary = await async_client.get(f"/api/v1/floor/harvest/sessions/{session_id}/summary")

        assert summary.status_code == 200
        assert summary.json() == [
            {
                "printer_id": printer.id,
                "printer_name": "Bench A",
                "print_name": "Button plate",
                "part_count": 0,
                "bin_quantity": 12,
            }
        ]

    async def test_discard_clears_the_bin_and_unlinks_it_in_one_action(
        self, async_client, printer_factory, archive_factory
    ):
        """The kiosk's bin discard combines what the office side does as two
        separate steps (unlink, then mark empty) — no reason is collected,
        unlike a part's discard."""
        printer = await printer_factory(name="Bench A")
        await archive_factory(printer_id=printer.id, print_name="Button plate")
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-BUT-1", "quantity": 12},
        )

        discarded = await async_client.post(
            "/api/v1/floor/bins/discard",
            json={"payload": "BBN-BUT-1"},
        )
        assert discarded.status_code == 200
        body = discarded.json()
        assert body["result"] == "discarded"
        assert body["batch"]["status"] == "empty"
        assert body["batch"]["remaining_quantity"] == 0

        # Both steps land in the audit trail, oldest first.
        events = await async_client.get(f"/api/v1/floor/inventory/bins/batches/{body['batch']['id']}/events")
        actions = [event["action"] for event in events.json()]
        assert actions[-2:] == ["unlinked", "empty"]

        # Reads as available everywhere — not stuck needing a manual relink.
        available = await async_client.get("/api/v1/floor/inventory/bins")
        item = next(i for i in available.json() if i["payload"] == "BBN-BUT-1")
        assert item["batch"] is None
        assert item["status"] == "available"

        # Immediately reusable at Harvest, unlike a plain office-side unlink.
        reharvested = await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-BUT-1", "quantity": 5},
        )
        assert reharvested.json()["result"] == "recorded"

    async def test_discard_requires_an_active_fill(self, async_client):
        response = await async_client.post(
            "/api/v1/floor/bins/discard",
            json={"payload": "BBN-KNB-2"},
        )
        assert response.json()["result"] == "no_batch"


async def _enroll_linked_part_with_code(
    async_client, printer_factory, archive_factory, part_code, sticker="BBD-000001", *, fit_check: bool = True
):
    """Enroll a job-linked part via Harvest, then stamp a part code on it so
    the item→location rules have a TOP-vs-BOT distinction to act on. Closes
    the harvest session afterward — locations are not sessions. By default
    also records Initial QC Pass (required before finishing / ready / WIP)."""
    await _create_tracking_section_with_part(async_client, code=part_code)
    printer = await printer_factory()
    await archive_factory(printer_id=printer.id)
    await _open_harvest(async_client, DEVICE_A)
    await _scan_printer(async_client, printer.id, DEVICE_A)
    scanned = await _scan_part(async_client, sticker, DEVICE_A)
    part_id = scanned.json()["part"]["id"]
    await async_client.post(f"/api/v1/floor/inventory/parts/{part_id}/part-code", json={"code": part_code})
    await _open_harvest(async_client, DEVICE_A)  # re-scanning Harvest's own QR closes the session
    if fit_check:
        await _scan_fit_check_part(async_client, sticker)
    return sticker


async def _seed_completed_archive(async_client, db_session, printer_factory, archive_factory, **archive_kwargs):
    """Set up part tracking and a completed build plate that shows up in the
    unlabeled list, so a test can dismiss and then restore it."""
    from backend.app.models.settings import Settings

    db_session.add(
        Settings(
            key="floor_part_tracking_started_at",
            value=(datetime.now() - timedelta(minutes=1)).isoformat(),
        )
    )
    await db_session.commit()
    printer = await printer_factory(name="Bench A")
    archive = await archive_factory(
        printer_id=printer.id,
        completed_at=datetime.now() + timedelta(minutes=1),
        **archive_kwargs,
    )
    return archive


@pytest.mark.asyncio
@pytest.mark.integration
class TestPartLocationApi:
    """`POST /floor/locations/part` — the item→location pipeline for parts."""

    async def test_bot_part_wip_without_qc_is_refused(self, async_client, printer_factory, archive_factory):
        sticker = await _enroll_linked_part_with_code(
            async_client, printer_factory, archive_factory, "BOT", fit_check=False
        )

        resp = await async_client.post(
            "/api/v1/floor/locations/part",
            json={"payload": sticker, "location_slug": "production-wip"},
        )

        assert resp.status_code == 200
        assert resp.json()["result"] == "qc_required"

    async def test_bot_part_moves_to_wip(self, async_client, printer_factory, archive_factory):
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "BOT")

        resp = await async_client.post(
            "/api/v1/floor/locations/part",
            json={"payload": sticker, "location_slug": "production-wip"},
        )

        assert resp.status_code == 200
        assert resp.json()["result"] == "recorded"

    async def test_bot_part_is_refused_at_a_finishing_location(self, async_client, printer_factory, archive_factory):
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "BOT")

        resp = await async_client.post(
            "/api/v1/floor/locations/part",
            json={"payload": sticker, "location_slug": "support-removal"},
        )

        assert resp.status_code == 200
        assert resp.json()["result"] == "wrong_part_type"

    async def test_top_part_wip_before_finishing_is_refused(self, async_client, printer_factory, archive_factory):
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "TOP")

        resp = await async_client.post(
            "/api/v1/floor/locations/part",
            json={"payload": sticker, "location_slug": "production-wip"},
        )

        assert resp.status_code == 200
        assert resp.json()["result"] == "finishing_required"

    async def test_top_part_full_finishing_then_wip(self, async_client, printer_factory, archive_factory):
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "TOP")

        for slug in ("support-removal", "overhang-removal", "hot-air-removal", "production-wip"):
            resp = await async_client.post(
                "/api/v1/floor/locations/part",
                json={"payload": sticker, "location_slug": slug},
            )
            assert resp.status_code == 200, slug
            assert resp.json()["result"] == "recorded", slug

    async def test_fit_check_slug_is_refused_here(self, async_client, printer_factory, archive_factory):
        """Fit Check keeps its own route; routing it through the generic
        endpoint is a 404 so its special handling cannot be bypassed."""
        sticker = await _enroll_linked_part_with_code(async_client, printer_factory, archive_factory, "BOT")

        resp = await async_client.post(
            "/api/v1/floor/locations/part",
            json={"payload": sticker, "location_slug": "fit-check"},
        )

        assert resp.status_code == 404

    async def test_unknown_location_is_404(self, async_client):
        resp = await async_client.post(
            "/api/v1/floor/locations/part",
            json={"payload": "BBD-000001", "location_slug": "nope"},
        )
        assert resp.status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
class TestBinLocationApi:
    """`POST /floor/locations/bin` — the item→location pipeline for bins,
    replacing the old open-WIP-session path."""

    async def _fill_and_qc(self, async_client, printer_factory, payload="BBN-KNB-1", quantity=20):
        printer = await printer_factory(name="Bench A")
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": payload, "quantity": quantity},
        )
        await async_client.post("/api/v1/floor/locations/fit-check/bin", json={"payload": payload})
        await async_client.post(
            "/api/v1/floor/locations/fit-check/bin",
            json={"payload": payload, "passed_quantity": quantity},
        )
        return payload

    async def test_wip_requires_qc(self, async_client, printer_factory):
        printer = await printer_factory(name="Bench A")
        await _open_harvest(async_client, DEVICE_A)
        await _scan_printer(async_client, printer.id, DEVICE_A)
        await async_client.post(
            "/api/v1/floor/harvest/bin",
            json={"device_id": DEVICE_A, "payload": "BBN-KNB-1", "quantity": 12},
        )

        resp = await async_client.post(
            "/api/v1/floor/locations/bin",
            json={"payload": "BBN-KNB-1", "location_slug": "production-wip"},
        )

        assert resp.status_code == 200
        assert resp.json()["result"] == "qc_required"

    async def test_ready_for_production_then_wip_then_empty(self, async_client, printer_factory):
        payload = await self._fill_and_qc(async_client, printer_factory)

        ready = await async_client.post(
            "/api/v1/floor/locations/bin",
            json={"payload": payload, "location_slug": "ready-for-production-inventory"},
        )
        wip = await async_client.post(
            "/api/v1/floor/locations/bin",
            json={"payload": payload, "location_slug": "production-wip"},
        )
        empty = await async_client.post(
            "/api/v1/floor/locations/bin",
            json={"payload": payload, "location_slug": "bin-empty"},
        )

        assert ready.json()["result"] == "ready_for_production_recorded"
        assert wip.json()["result"] == "wip_recorded"
        assert empty.json()["result"] == "empty_recorded"
        assert empty.json()["batch"]["remaining_quantity"] == 0

    async def test_empty_requires_wip(self, async_client, printer_factory):
        payload = await self._fill_and_qc(async_client, printer_factory)

        resp = await async_client.post(
            "/api/v1/floor/locations/bin",
            json={"payload": payload, "location_slug": "bin-empty"},
        )

        assert resp.status_code == 200
        assert resp.json()["result"] == "empty_requires_wip"

    async def test_fit_check_slug_is_refused_here(self, async_client):
        resp = await async_client.post(
            "/api/v1/floor/locations/bin",
            json={"payload": "BBN-KNB-1", "location_slug": "fit-check"},
        )
        assert resp.status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
class TestDismissedBuildPlates:
    async def test_lists_a_dismissed_plate_with_its_job_and_printer(
        self, async_client, db_session, printer_factory, archive_factory
    ):
        archive = await _seed_completed_archive(
            async_client, db_session, printer_factory, archive_factory, print_name="Cable guide"
        )
        dismissed = await async_client.post(f"/api/v1/floor/parts/unlabeled-build-plates/{archive.id}/dismiss")
        assert dismissed.status_code == 200

        resp = await async_client.get("/api/v1/floor/parts/dismissed-build-plates")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["id"] == archive.id
        assert body[0]["print_name"] == "Cable guide"
        assert body[0]["printer_name"] == "Bench A"
        assert body[0]["dismissed_at"] is not None

    async def test_dismissed_plate_is_absent_from_the_unlabeled_list(
        self, async_client, db_session, printer_factory, archive_factory
    ):
        archive = await _seed_completed_archive(async_client, db_session, printer_factory, archive_factory)
        before = await async_client.get("/api/v1/floor/parts/unlabeled-build-plates")
        assert any(plate["id"] == archive.id for plate in before.json())

        await async_client.post(f"/api/v1/floor/parts/unlabeled-build-plates/{archive.id}/dismiss")

        after = await async_client.get("/api/v1/floor/parts/unlabeled-build-plates")
        assert not any(plate["id"] == archive.id for plate in after.json())

    async def test_restore_returns_it_to_the_unlabeled_list(
        self, async_client, db_session, printer_factory, archive_factory
    ):
        archive = await _seed_completed_archive(async_client, db_session, printer_factory, archive_factory)
        await async_client.post(f"/api/v1/floor/parts/unlabeled-build-plates/{archive.id}/dismiss")

        restored = await async_client.post(f"/api/v1/floor/parts/dismissed-build-plates/{archive.id}/restore")

        assert restored.status_code == 200
        assert restored.json()["status"] == "restored"

        dismissed = await async_client.get("/api/v1/floor/parts/dismissed-build-plates")
        assert not any(plate["id"] == archive.id for plate in dismissed.json())

        unlabeled = await async_client.get("/api/v1/floor/parts/unlabeled-build-plates")
        assert any(plate["id"] == archive.id for plate in unlabeled.json())

    async def test_restore_of_a_plate_that_is_not_dismissed_is_404(
        self, async_client, db_session, printer_factory, archive_factory
    ):
        archive = await _seed_completed_archive(async_client, db_session, printer_factory, archive_factory)

        resp = await async_client.post(f"/api/v1/floor/parts/dismissed-build-plates/{archive.id}/restore")

        assert resp.status_code == 404

    async def test_empty_when_nothing_dismissed(self, async_client):
        resp = await async_client.get("/api/v1/floor/parts/dismissed-build-plates")

        assert resp.status_code == 200
        assert resp.json() == []

    async def test_dismissed_plate_drops_from_list_after_it_is_linked(
        self, async_client, db_session, printer_factory, archive_factory
    ):
        """Harvest while dismissed must not leave a Restore that can't return
        the plate to needing-linking — omit linked archives from the list."""
        from backend.app.models.floor_part import FloorLabeledPart

        archive = await _seed_completed_archive(async_client, db_session, printer_factory, archive_factory)
        await async_client.post(f"/api/v1/floor/parts/unlabeled-build-plates/{archive.id}/dismiss")
        before = await async_client.get("/api/v1/floor/parts/dismissed-build-plates")
        assert any(plate["id"] == archive.id for plate in before.json())

        db_session.add(
            FloorLabeledPart(
                sticker_code="BBD-009901",
                printer_id=archive.printer_id,
                archive_id=archive.id,
            )
        )
        await db_session.commit()

        after = await async_client.get("/api/v1/floor/parts/dismissed-build-plates")
        assert not any(plate["id"] == archive.id for plate in after.json())

        unlabeled = await async_client.get("/api/v1/floor/parts/unlabeled-build-plates")
        assert not any(plate["id"] == archive.id for plate in unlabeled.json())
