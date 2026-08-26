"""Integration tests for the Floor codes routes (``docs/floor-plan.md`` §3.3).

The renderer and station catalog have their own unit tests; these cover the
wiring — response shape, validation, and that a real PDF comes back.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient


class TestListStations:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_the_station_catalog(self, async_client: AsyncClient):
        resp = await async_client.get("/api/v1/floor/stations")
        assert resp.status_code == 200

        stations = resp.json()
        assert len(stations) == 7

        payloads = [s["payload"] for s in stations]
        assert payloads == [
            "BBS-wip",
            "BBS-storage-receive",
            "BBS-storage-move",
            "BBS-harvest",
            "BBS-fit-check",
            "BBS-sanding",
            "BBS-cleanup",
        ]
        # Order is the documented workflow order (§5), not alphabetical — the
        # Codes page prints them in this sequence.
        assert stations[0]["name"] == "WIP"
        assert all(s["description"] for s in stations)

        by_slug = {s["slug"]: s for s in stations}
        assert by_slug["fit-check"]["category"] == "location"
        assert by_slug["sanding"]["category"] == "location"
        assert by_slug["wip"]["category"] == "station"
        assert by_slug["cleanup"]["category"] == "station"


class TestRenderStationLabels:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_renders_a_pdf(self, async_client: AsyncClient):
        resp = await async_client.post(
            "/api/v1/floor/labels/stations",
            json={"payloads": ["BBS-wip", "BBS-cleanup"], "width_mm": 60, "height_mm": 60},
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/pdf"
        assert resp.content.startswith(b"%PDF-")
        # Exact length matters for the inline PDF viewer; the gzip middleware
        # is configured to leave /floor/labels alone so this stays accurate.
        assert int(resp.headers["content-length"]) == len(resp.content)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_an_unknown_station_code(self, async_client: AsyncClient):
        """Refuse the whole request rather than silently printing fewer
        labels — a missing label is only discovered at the shelf."""
        resp = await async_client.post(
            "/api/v1/floor/labels/stations",
            json={"payloads": ["BBS-wip", "BBS-not-a-station"], "width_mm": 60, "height_mm": 60},
        )
        assert resp.status_code == 400
        assert "BBS-not-a-station" in resp.json()["detail"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize(
        ("width", "height"),
        [(5, 60), (60, 5), (500, 60), (60, 500)],
    )
    async def test_rejects_sizes_outside_the_supported_range(
        self, async_client: AsyncClient, width: float, height: float
    ):
        resp = await async_client.post(
            "/api/v1/floor/labels/stations",
            json={"payloads": ["BBS-wip"], "width_mm": width, "height_mm": height},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_an_empty_payload_list(self, async_client: AsyncClient):
        resp = await async_client.post(
            "/api/v1/floor/labels/stations",
            json={"payloads": [], "width_mm": 60, "height_mm": 60},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_accepts_a_non_square_custom_size(self, async_client: AsyncClient):
        resp = await async_client.post(
            "/api/v1/floor/labels/stations",
            json={"payloads": ["BBS-storage-move"], "width_mm": 80, "height_mm": 40},
        )
        assert resp.status_code == 200
        assert resp.content.startswith(b"%PDF-")
