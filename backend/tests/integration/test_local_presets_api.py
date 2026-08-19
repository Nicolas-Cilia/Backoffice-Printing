"""Integration tests for local preset list/detail contract fields."""

import io
import json
import zipfile

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.local_preset import LocalPreset


def _process_setting(**overrides) -> dict:
    setting = {
        "layer_height": "0.2",
        "sparse_infill_density": "20%",
        "sparse_infill_pattern": "grid",
        "wall_loops": "3",
        "brim_type": "auto_brim",
        "brim_object_gap": "0.1",
        "fuzzy_skin": "none",
        "enable_support": "0",
        "curr_bed_type": "Textured PEI Plate",
        "seam_position": "aligned",
    }
    setting.update(overrides)
    return setting


@pytest.mark.asyncio
@pytest.mark.integration
class TestLocalPresetsLockedParameters:
    async def test_process_list_and_create_include_locked_parameters_not_setting(self, async_client: AsyncClient):
        created = await async_client.post(
            "/api/v1/local-presets/",
            json={
                "name": "0.20mm Standard @BBL X1C",
                "preset_type": "process",
                "setting": _process_setting(),
            },
        )
        assert created.status_code == 200
        body = created.json()
        assert body["preset_type"] == "process"
        assert "setting" not in body
        assert body["locked_parameters"]["layer_height"] == 0.2
        assert body["locked_parameters"]["sparse_infill_density"] == 20
        assert body["locked_parameters"]["curr_bed_type"] == "Textured PEI Plate"
        assert "nozzles_used" not in body["locked_parameters"]

        filament = await async_client.post(
            "/api/v1/local-presets/",
            json={
                "name": "Generic PLA",
                "preset_type": "filament",
                "setting": {"filament_type": "PLA"},
            },
        )
        assert filament.status_code == 200
        assert filament.json()["locked_parameters"] is None

        listed = await async_client.get("/api/v1/local-presets/")
        assert listed.status_code == 200
        payload = listed.json()
        process = payload["process"][0]
        assert process["locked_parameters"]["layer_height"] == 0.2
        assert "setting" not in process
        assert payload["filament"][0]["locked_parameters"] is None

        detail = await async_client.get(f"/api/v1/local-presets/{body['id']}")
        assert detail.status_code == 200
        full = detail.json()
        assert full["locked_parameters"]["layer_height"] == 0.2
        assert full["setting"]["layer_height"] == "0.2"


def _zip_bytes(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, raw in entries.items():
            zf.writestr(name, raw)
    return buf.getvalue()


@pytest.mark.asyncio
@pytest.mark.integration
class TestLocalPresetSourceLabel:
    async def test_import_json_with_bbl_name_stores_bambu(self, async_client: AsyncClient):
        payload = {
            "name": "Bambu PLA Basic @BBL X1C",
            "type": "filament",
            "filament_type": ["PLA"],
            "compatible_printers": ["Bambu Lab X1 Carbon 0.4 nozzle"],
        }
        imported = await async_client.post(
            "/api/v1/local-presets/import",
            files={"file": ("Bambu PLA Basic.json", json.dumps(payload).encode(), "application/json")},
        )
        assert imported.status_code == 200
        assert imported.json()["imported"] == 1

        listed = await async_client.get("/api/v1/local-presets/")
        assert listed.status_code == 200
        assert listed.json()["filament"][0]["source"] == "bambu"

        detail = await async_client.get(f"/api/v1/local-presets/{listed.json()['filament'][0]['id']}")
        assert detail.json()["source"] == "bambu"

    async def test_import_bbscfg_stores_bambu(self, async_client: AsyncClient):
        inner = {"name": "Custom Process", "type": "process", "layer_height": "0.2"}
        archive = _zip_bytes({"process/custom.json": json.dumps(inner).encode()})
        imported = await async_client.post(
            "/api/v1/local-presets/import",
            files={"file": ("printer.bbscfg", archive, "application/zip")},
        )
        assert imported.status_code == 200
        assert imported.json()["imported"] == 1

        listed = await async_client.get("/api/v1/local-presets/")
        assert listed.json()["process"][0]["source"] == "bambu"

    async def test_import_orca_filament_without_bambu_markers_stays_orcaslicer(self, async_client: AsyncClient):
        inner = {"name": "Generic PLA @Voron 2.4", "type": "filament", "filament_type": ["PLA"]}
        archive = _zip_bytes({"filament/pla.json": json.dumps(inner).encode()})
        imported = await async_client.post(
            "/api/v1/local-presets/import",
            files={"file": ("export.orca_filament", archive, "application/zip")},
        )
        assert imported.status_code == 200
        assert imported.json()["imported"] == 1

        listed = await async_client.get("/api/v1/local-presets/")
        assert listed.json()["filament"][0]["source"] == "orcaslicer"

    async def test_import_orca_filament_inserts_orcaslicer_then_list_corrects_bbl(
        self, async_client: AsyncClient, db_session
    ):
        inner = {"name": "Bambu PLA Basic @BBL X1C", "type": "filament", "filament_type": ["PLA"]}
        archive = _zip_bytes({"filament/pla.json": json.dumps(inner).encode()})
        imported = await async_client.post(
            "/api/v1/local-presets/import",
            files={"file": ("export.orca_filament", archive, "application/zip")},
        )
        assert imported.status_code == 200
        assert imported.json()["imported"] == 1

        stored = (await db_session.execute(select(LocalPreset))).scalar_one()
        await db_session.refresh(stored)
        assert stored.source == "orcaslicer"

        listed = await async_client.get("/api/v1/local-presets/")
        assert listed.json()["filament"][0]["source"] == "bambu"
        await db_session.refresh(stored)
        assert stored.source == "bambu"

    async def test_import_generic_json_stays_orcaslicer(self, async_client: AsyncClient):
        payload = {"name": "Generic PLA @Voron 2.4", "type": "filament", "filament_type": ["PLA"]}
        imported = await async_client.post(
            "/api/v1/local-presets/import",
            files={"file": ("generic.json", json.dumps(payload).encode(), "application/json")},
        )
        assert imported.status_code == 200
        assert imported.json()["imported"] == 1

        listed = await async_client.get("/api/v1/local-presets/")
        assert listed.json()["filament"][0]["source"] == "orcaslicer"

    async def test_library_import_still_skips_duplicate_name(self, async_client: AsyncClient):
        payload = {"name": "Generic PLA @Voron 2.4", "type": "filament", "filament_type": ["PLA"]}
        first = await async_client.post(
            "/api/v1/local-presets/import",
            files={"file": ("generic.json", json.dumps(payload).encode(), "application/json")},
        )
        assert first.status_code == 200
        assert first.json()["imported"] == 1

        payload["filament_type"] = ["PETG"]
        second = await async_client.post(
            "/api/v1/local-presets/import",
            files={"file": ("generic.json", json.dumps(payload).encode(), "application/json")},
        )
        assert second.status_code == 200
        assert second.json()["imported"] == 0
        assert second.json()["skipped"] == 1

        listed = await async_client.get("/api/v1/local-presets/")
        assert listed.json()["filament"][0]["filament_type"] == "PLA"

    async def test_list_and_detail_correct_existing_orcaslicer_row(self, async_client: AsyncClient, db_session):
        preset = LocalPreset(
            name="Bambu PLA Basic @BBL X1C",
            preset_type="filament",
            source="orcaslicer",
            compatible_printers='["Bambu Lab X1 Carbon 0.4 nozzle"]',
            setting=json.dumps({"name": "Bambu PLA Basic @BBL X1C", "filament_type": ["PLA"]}),
        )
        db_session.add(preset)
        await db_session.commit()
        preset_id = preset.id

        listed = await async_client.get("/api/v1/local-presets/")
        assert listed.status_code == 200
        assert listed.json()["filament"][0]["source"] == "bambu"

        detail = await async_client.get(f"/api/v1/local-presets/{preset_id}")
        assert detail.json()["source"] == "bambu"

        await db_session.refresh(preset)
        assert preset.source == "bambu"

        leftover = await db_session.execute(select(LocalPreset).where(LocalPreset.id == preset_id))
        assert leftover.scalar_one().source == "bambu"


@pytest.mark.asyncio
@pytest.mark.integration
class TestLocalPresetDownload:
    async def test_download_returns_setting_json_and_filename(self, async_client: AsyncClient):
        created = await async_client.post(
            "/api/v1/local-presets/",
            json={
                "name": "0.20mm Standard @BBL X1C",
                "preset_type": "process",
                "setting": _process_setting(),
            },
        )
        assert created.status_code == 200
        preset_id = created.json()["id"]

        resp = await async_client.get(f"/api/v1/local-presets/{preset_id}/download")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/json")
        disposition = resp.headers["content-disposition"]
        assert disposition.startswith("attachment;")
        assert "0.20mm Standard @BBL X1C.json" in disposition

        body = resp.json()
        assert body["layer_height"] == "0.2"
        assert body["sparse_infill_density"] == "20%"
        assert body["curr_bed_type"] == "Textured PEI Plate"

    async def test_download_sanitizes_filename(self, async_client: AsyncClient):
        created = await async_client.post(
            "/api/v1/local-presets/",
            json={
                "name": "Foo/Bar:Baz<>.json",
                "preset_type": "filament",
                "setting": {"filament_type": "PLA", "name": "Foo/Bar:Baz<>.json"},
            },
        )
        assert created.status_code == 200
        preset_id = created.json()["id"]

        resp = await async_client.get(f"/api/v1/local-presets/{preset_id}/download")
        assert resp.status_code == 200
        assert "Foo_Bar_Baz.json" in resp.headers["content-disposition"]
        assert resp.json()["filament_type"] == "PLA"

    async def test_download_missing_preset_is_404(self, async_client: AsyncClient):
        resp = await async_client.get("/api/v1/local-presets/999999/download")
        assert resp.status_code == 404
