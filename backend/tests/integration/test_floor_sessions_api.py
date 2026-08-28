"""Integration tests for the Floor session routes (``docs/floor-plan.md`` §2.4).

The lock mechanics have unit tests; these cover the wiring — status codes,
response shape, and the one distinction the scan page depends on:

- **404** means "not a station code" → the unknown-code error flash of §9
- **200 with `result: locked`** means "a real station, held by someone else"
  → the refusal screen, with a takeover offer

Collapsing those two into one error would make an unrecognized barcode and a
busy station look identical on the floor.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

DEVICE_A = "device-a"
DEVICE_B = "device-b"


async def _scan(client: AsyncClient, payload: str, device_id: str):
    return await client.post(
        "/api/v1/floor/session/scan",
        json={"payload": payload, "device_id": device_id},
    )


class TestScanStation:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_opens_a_station(self, async_client: AsyncClient):
        resp = await _scan(async_client, "BBS-harvest", DEVICE_A)
        assert resp.status_code == 200

        body = resp.json()
        assert body["result"] == "opened"
        assert body["station_slug"] == "harvest"
        assert body["station_name"] == "Harvest"
        assert body["session"]["device_id"] == DEVICE_A
        assert body["blocking"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rescanning_closes(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-harvest", DEVICE_A)
        resp = await _scan(async_client, "BBS-harvest", DEVICE_A)

        assert resp.json()["result"] == "closed"
        assert resp.json()["session"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_scanning_a_location_code_does_not_switch_the_session(self, async_client: AsyncClient):
        """Locations resolve through the same catalog but are not sessions —
        the scan route refuses them so item→location flows handle them instead."""
        await _scan(async_client, "BBS-harvest", DEVICE_A)
        resp = await _scan(async_client, "BBS-initial-qc-pass", DEVICE_A)

        assert resp.status_code == 404
        body = (await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_A})).json()
        assert body["station_slug"] == "harvest"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_unknown_payload_is_404_not_a_lock(self, async_client: AsyncClient):
        """Must stay distinguishable from a locked station: one is the
        error flash, the other is the takeover screen."""
        resp = await _scan(async_client, "BBS-nope", DEVICE_A)
        assert resp.status_code == 404

        resp = await _scan(async_client, "not-a-code-at-all", DEVICE_A)
        assert resp.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_a_printer_code_is_not_a_station(self, async_client: AsyncClient):
        resp = await _scan(async_client, "BBP-12", DEVICE_A)
        assert resp.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_tolerates_a_pistol_whitespace_suffix(self, async_client: AsyncClient):
        """Some guns append whitespace depending on their suffix config; a
        stray space must not read as an unknown code."""
        resp = await _scan(async_client, "  BBS-harvest \n", DEVICE_A)
        assert resp.status_code == 200
        assert resp.json()["result"] == "opened"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_a_missing_device_id(self, async_client: AsyncClient):
        resp = await async_client.post("/api/v1/floor/session/scan", json={"payload": "BBS-harvest"})
        assert resp.status_code == 422


class TestLockAndTakeover:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_second_device_gets_locked_with_holder_details(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-harvest", DEVICE_A)
        resp = await _scan(async_client, "BBS-harvest", DEVICE_B)

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "locked"
        assert body["session"] is None
        # The refusal must carry enough to act on: who, and for how long.
        assert body["blocking"]["device_id"] == DEVICE_A
        assert body["blocking"]["open_seconds"] >= 0
        assert body["blocking"]["station_name"] == "Harvest"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_removed_cleanup_code_is_rejected(self, async_client: AsyncClient):
        resp = await _scan(async_client, "BBS-cleanup", DEVICE_A)

        assert resp.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_takeover_transfers_the_station(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-harvest", DEVICE_A)

        resp = await async_client.post(
            "/api/v1/floor/session/takeover",
            json={"payload": "BBS-harvest", "device_id": DEVICE_B},
        )
        assert resp.status_code == 200
        assert resp.json()["result"] == "opened"
        assert resp.json()["session"]["device_id"] == DEVICE_B

        # The dispossessed device now holds nothing.
        resp = await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_A})
        assert resp.json() is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_takeover_of_an_unknown_code_is_404(self, async_client: AsyncClient):
        resp = await async_client.post(
            "/api/v1/floor/session/takeover",
            json={"payload": "BBS-nope", "device_id": DEVICE_A},
        )
        assert resp.status_code == 404


class TestCurrentSession:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_null_when_nothing_is_open(self, async_client: AsyncClient):
        resp = await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_A})
        assert resp.status_code == 200
        assert resp.json() is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_survives_a_reload(self, async_client: AsyncClient):
        """The session lives on the server precisely so a reload resumes it
        rather than stranding an open station nobody can see."""
        await _scan(async_client, "BBS-harvest", DEVICE_A)

        resp = await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_A})
        body = resp.json()
        assert body["station_slug"] == "harvest"
        assert body["station_name"] == "Harvest"
        assert body["open_seconds"] >= 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_is_scoped_to_the_asking_device(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-harvest", DEVICE_A)

        resp = await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_B})
        assert resp.json() is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_close_endpoint_is_idempotent(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-harvest", DEVICE_A)

        resp = await async_client.request("DELETE", "/api/v1/floor/session", params={"device_id": DEVICE_A})
        assert resp.status_code == 200
        assert resp.json()["station_slug"] == "harvest"

        resp = await async_client.request("DELETE", "/api/v1/floor/session", params={"device_id": DEVICE_A})
        assert resp.status_code == 200
        assert resp.json() is None


@pytest.mark.asyncio
@pytest.mark.integration
class TestSessionOverview:
    """The /floor landing page's open-sessions panel.

    Exists because a stale session that nobody is going back to otherwise has
    no remedy except taking it over from the bench (§2.4).
    """

    async def test_lists_open_sessions(self, async_client):
        await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-A"},
        )

        resp = await async_client.get("/api/v1/floor/sessions")

        assert resp.status_code == 200
        body = resp.json()
        assert [s["station_slug"] for s in body["open"]] == ["harvest"]
        assert body["open"][0]["device_id"] == "pc-A"
        assert body["open"][0]["closed_at"] is None

    async def test_open_sessions_are_oldest_first(self, async_client):
        # The reason to read this list is usually hunting a session nobody
        # came back to, so the stalest belongs at the top.
        await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-A"},
        )
        await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-B"},
        )

        body = (await async_client.get("/api/v1/floor/sessions")).json()

        opened = [s["opened_at"] for s in body["open"]]
        assert opened == sorted(opened)

    async def test_closed_sessions_appear_in_recent(self, async_client):
        await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-A"},
        )
        # Rescanning the same station closes it.
        await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-A"},
        )

        body = (await async_client.get("/api/v1/floor/sessions")).json()

        assert body["open"] == []
        assert any(s["station_slug"] == "harvest" for s in body["recent"])

    async def test_recent_records_a_takeover(self, async_client):
        """The distinction the history exists to show: ended by someone else,
        not closed by its holder."""
        await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-A"},
        )
        await async_client.post(
            "/api/v1/floor/session/takeover",
            json={"payload": "BBS-harvest", "device_id": "pc-B"},
        )

        body = (await async_client.get("/api/v1/floor/sessions")).json()

        taken = [s for s in body["recent"] if s["device_id"] == "pc-A"]
        assert len(taken) == 1
        assert taken[0]["closed_by_takeover"] is True

    async def test_a_closed_session_stops_ageing(self, async_client):
        """open_seconds must be the duration it *was* open, not time since it
        opened — otherwise finished sessions keep growing in the history."""
        await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-A"},
        )
        await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-A"},
        )

        first = (await async_client.get("/api/v1/floor/sessions")).json()["recent"][0]
        second = (await async_client.get("/api/v1/floor/sessions")).json()["recent"][0]

        assert first["open_seconds"] == second["open_seconds"]

    async def test_closes_any_session_by_id(self, async_client):
        scan = await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-A"},
        )
        session_id = scan.json()["session"]["id"]

        resp = await async_client.delete(f"/api/v1/floor/sessions/{session_id}")

        assert resp.status_code == 200
        assert resp.json()["closed_at"] is not None
        # The station is free again — the whole point.
        after = (await async_client.get("/api/v1/floor/sessions")).json()
        assert after["open"] == []

    async def test_closing_frees_the_station_for_another_device(self, async_client):
        scan = await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-A"},
        )
        await async_client.delete(f"/api/v1/floor/sessions/{scan.json()['session']['id']}")

        retry = await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-B"},
        )

        assert retry.json()["result"] == "opened"

    async def test_closing_an_already_closed_session_is_a_404(self, async_client):
        """A double click must not resurrect a row to re-close it."""
        scan = await async_client.post(
            "/api/v1/floor/session/scan",
            json={"payload": "BBS-harvest", "device_id": "pc-A"},
        )
        session_id = scan.json()["session"]["id"]
        await async_client.delete(f"/api/v1/floor/sessions/{session_id}")

        again = await async_client.delete(f"/api/v1/floor/sessions/{session_id}")

        assert again.status_code == 404

    async def test_closing_an_unknown_session_is_a_404(self, async_client):
        assert (await async_client.delete("/api/v1/floor/sessions/999999")).status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
class TestHarvestSessionsClaimedByAPartScan:
    """Phase 8 (§5.4 entry #2) can open a harvest session through a
    completely different route (`POST /floor/parts/scan`) than the normal
    `BBS-harvest` station scan. These guard that the generic session
    machinery — the floor-wide lock and the ordinary session endpoints —
    treats a session opened that way exactly like any other harvest session.
    """

    async def test_a_lock_claimed_by_a_part_scan_blocks_a_station_scan(
        self, async_client, printer_factory, archive_factory
    ):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await async_client.post(
            "/api/v1/floor/parts/scan",
            json={"payload": "BBD-000001", "device_id": DEVICE_A, "printer_id": printer.id},
        )

        resp = await _scan(async_client, "BBS-harvest", DEVICE_B)

        assert resp.json()["result"] == "locked"
        assert resp.json()["blocking"]["device_id"] == DEVICE_A

    async def test_it_shows_up_in_the_session_overview(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await async_client.post(
            "/api/v1/floor/parts/scan",
            json={"payload": "BBD-000001", "device_id": DEVICE_A, "printer_id": printer.id},
        )

        resp = await async_client.get("/api/v1/floor/sessions")

        assert [s["station_slug"] for s in resp.json()["open"]] == ["harvest"]
        assert resp.json()["open"][0]["device_id"] == DEVICE_A

    async def test_the_station_toggle_still_closes_it(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await async_client.post(
            "/api/v1/floor/parts/scan",
            json={"payload": "BBD-000001", "device_id": DEVICE_A, "printer_id": printer.id},
        )

        resp = await _scan(async_client, "BBS-harvest", DEVICE_A)

        assert resp.json()["result"] == "closed"
