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
        resp = await _scan(async_client, "BBS-wip", DEVICE_A)
        assert resp.status_code == 200

        body = resp.json()
        assert body["result"] == "opened"
        assert body["station_slug"] == "wip"
        assert body["station_name"] == "WIP"
        assert body["session"]["device_id"] == DEVICE_A
        assert body["blocking"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rescanning_closes(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-wip", DEVICE_A)
        resp = await _scan(async_client, "BBS-wip", DEVICE_A)

        assert resp.json()["result"] == "closed"
        assert resp.json()["session"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_scanning_another_station_switches(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-wip", DEVICE_A)
        resp = await _scan(async_client, "BBS-storage-receive", DEVICE_A)

        body = resp.json()
        assert body["result"] == "switched"
        assert body["session"]["station_slug"] == "storage-receive"

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
        resp = await _scan(async_client, "  BBS-wip \n", DEVICE_A)
        assert resp.status_code == 200
        assert resp.json()["result"] == "opened"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_a_missing_device_id(self, async_client: AsyncClient):
        resp = await async_client.post("/api/v1/floor/session/scan", json={"payload": "BBS-wip"})
        assert resp.status_code == 422


class TestLockAndTakeover:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_second_device_gets_locked_with_holder_details(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-wip", DEVICE_A)
        resp = await _scan(async_client, "BBS-wip", DEVICE_B)

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"] == "locked"
        assert body["session"] is None
        # The refusal must carry enough to act on: who, and for how long.
        assert body["blocking"]["device_id"] == DEVICE_A
        assert body["blocking"]["open_seconds"] >= 0
        assert body["blocking"]["station_name"] == "WIP"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_cleanup_is_not_locked(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-cleanup", DEVICE_A)
        resp = await _scan(async_client, "BBS-cleanup", DEVICE_B)

        assert resp.json()["result"] == "opened"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_takeover_transfers_the_station(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-wip", DEVICE_A)

        resp = await async_client.post(
            "/api/v1/floor/session/takeover",
            json={"payload": "BBS-wip", "device_id": DEVICE_B},
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
        await _scan(async_client, "BBS-storage-move", DEVICE_A)

        resp = await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_A})
        body = resp.json()
        assert body["station_slug"] == "storage-move"
        assert body["station_name"] == "Move"
        assert body["open_seconds"] >= 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_is_scoped_to_the_asking_device(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-wip", DEVICE_A)

        resp = await async_client.get("/api/v1/floor/session", params={"device_id": DEVICE_B})
        assert resp.json() is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_close_endpoint_is_idempotent(self, async_client: AsyncClient):
        await _scan(async_client, "BBS-wip", DEVICE_A)

        resp = await async_client.request(
            "DELETE", "/api/v1/floor/session", params={"device_id": DEVICE_A}
        )
        assert resp.status_code == 200
        assert resp.json()["station_slug"] == "wip"

        resp = await async_client.request(
            "DELETE", "/api/v1/floor/session", params={"device_id": DEVICE_A}
        )
        assert resp.status_code == 200
        assert resp.json() is None
