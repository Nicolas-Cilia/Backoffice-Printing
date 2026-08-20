"""Section-level part templates: catalog CRUD and parameter seed/replace."""

import pytest
from httpx import AsyncClient

from backend.tests.integration.test_production_api import _3mf, _config


async def _create_tracking_section_with_part(async_client: AsyncClient, code: str = "TOP") -> tuple[int, int]:
    section = (await async_client.post("/api/v1/library/sections", json={"name": "Line", "kind": "production"})).json()
    part = (
        await async_client.post(
            f"/api/v1/library/sections/{section['id']}/parts",
            json={"code": code, "name": "Housing"},
        )
    ).json()
    return section["id"], part["id"]


@pytest.mark.asyncio
@pytest.mark.integration
class TestLibrarySectionParts:
    async def test_seed_then_replace_requires_accept_baseline(self, async_client: AsyncClient):
        section_id, part_id = await _create_tracking_section_with_part(async_client)
        png = b"\x89PNG\r\n\x1a\n"
        seed = await async_client.post(
            f"/api/v1/library/sections/{section_id}/parts/{part_id}/parameters",
            files={
                "file": (
                    "spec.3mf",
                    _3mf(_config(layer_height="0.2"), extra_files={"Metadata/plate_1.png": png}),  # type: ignore[arg-type]
                    "application/octet-stream",
                )
            },
        )
        assert seed.status_code == 200, seed.text
        assert seed.json()["locked_parameters"]["layer_height"] == 0.2
        assert seed.json()["has_thumbnail"] is True
        thumb = await async_client.get(f"/api/v1/library/sections/{section_id}/parts/{part_id}/thumbnail")
        assert thumb.status_code == 200
        assert thumb.content.startswith(b"\x89PNG")

        blocked = await async_client.post(
            f"/api/v1/library/sections/{section_id}/parts/{part_id}/parameters",
            files={"file": ("next.3mf", _3mf(_config(layer_height="0.28")), "application/octet-stream")},
        )
        assert blocked.status_code == 400
        assert "accept_baseline" in blocked.json()["detail"]

        preview = await async_client.post(
            f"/api/v1/library/sections/{section_id}/parts/{part_id}/parameters/preview",
            files={"file": ("next.3mf", _3mf(_config(layer_height="0.28")), "application/octet-stream")},
        )
        assert preview.status_code == 200, preview.text
        body = preview.json()
        assert body["has_existing_contract"] is True
        assert body["has_mismatches"] is True
        layer = next(row for row in body["parameter_diff"] if row["key"] == "layer_height")
        assert layer["match"] is False
        assert layer["locked"] == 0.2
        assert layer["incoming"] == 0.28

        replaced = await async_client.post(
            f"/api/v1/library/sections/{section_id}/parts/{part_id}/parameters",
            files={"file": ("next.3mf", _3mf(_config(layer_height="0.28")), "application/octet-stream")},
            data={"resolution": "accept_baseline"},
        )
        assert replaced.status_code == 200, replaced.text
        assert replaced.json()["locked_parameters"]["layer_height"] == 0.28

    async def test_replace_renews_or_clears_thumbnail(self, async_client: AsyncClient):
        section_id, part_id = await _create_tracking_section_with_part(async_client)
        png_a = b"\x89PNG\r\n\x1a\nA"
        png_b = b"\x89PNG\r\n\x1a\nB"
        seed = await async_client.post(
            f"/api/v1/library/sections/{section_id}/parts/{part_id}/parameters",
            files={
                "file": (
                    "spec.3mf",
                    _3mf(_config(layer_height="0.2"), extra_files={"Metadata/plate_1.png": png_a}),  # type: ignore[arg-type]
                    "application/octet-stream",
                )
            },
        )
        assert seed.status_code == 200, seed.text
        assert seed.json()["has_thumbnail"] is True
        first = await async_client.get(f"/api/v1/library/sections/{section_id}/parts/{part_id}/thumbnail")
        assert first.status_code == 200
        assert first.content == png_a
        assert "no-store" in first.headers.get("cache-control", "").lower()

        replaced = await async_client.post(
            f"/api/v1/library/sections/{section_id}/parts/{part_id}/parameters",
            files={
                "file": (
                    "next.3mf",
                    _3mf(_config(layer_height="0.28"), extra_files={"Metadata/plate_1.png": png_b}),  # type: ignore[arg-type]
                    "application/octet-stream",
                )
            },
            data={"resolution": "accept_baseline"},
        )
        assert replaced.status_code == 200, replaced.text
        assert replaced.json()["has_thumbnail"] is True
        assert replaced.json()["updated_at"] != seed.json()["updated_at"]
        second = await async_client.get(f"/api/v1/library/sections/{section_id}/parts/{part_id}/thumbnail")
        assert second.status_code == 200
        assert second.content == png_b

        cleared = await async_client.post(
            f"/api/v1/library/sections/{section_id}/parts/{part_id}/parameters",
            files={"file": ("bare.3mf", _3mf(_config(layer_height="0.16")), "application/octet-stream")},
            data={"resolution": "accept_baseline"},
        )
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["has_thumbnail"] is False
        missing = await async_client.get(f"/api/v1/library/sections/{section_id}/parts/{part_id}/thumbnail")
        assert missing.status_code == 404

    async def test_reorder_parts_persists_custom_grid_order(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/library/sections", json={"name": "Line", "kind": "production"})).json()
        section_id = section["id"]
        bot = (
            await async_client.post(
                f"/api/v1/library/sections/{section_id}/parts",
                json={"code": "BOT", "name": "Bottom"},
            )
        ).json()
        top = (
            await async_client.post(
                f"/api/v1/library/sections/{section_id}/parts",
                json={"code": "TOP", "name": "Housing"},
            )
        ).json()
        listed = (await async_client.get(f"/api/v1/library/sections/{section_id}/parts")).json()
        assert [row["code"] for row in listed] == ["BOT", "TOP"]

        reordered = await async_client.put(
            f"/api/v1/library/sections/{section_id}/parts/reorder",
            json={"ids": [top["id"], bot["id"]]},
        )
        assert reordered.status_code == 200, reordered.text
        assert [row["code"] for row in reordered.json()] == ["TOP", "BOT"]
        assert [row["sort_order"] for row in reordered.json()] == [0, 1]

        listed = (await async_client.get(f"/api/v1/library/sections/{section_id}/parts")).json()
        assert [row["code"] for row in listed] == ["TOP", "BOT"]

        missing = await async_client.put(
            f"/api/v1/library/sections/{section_id}/parts/reorder",
            json={"ids": [top["id"]]},
        )
        assert missing.status_code == 400
