"""Integration tests for the production file-slot HTTP API."""

import io
import json
import zipfile

import pytest
from httpx import AsyncClient

from backend.app.models.production import PRODUCTION_PRINTER_MODELS

_PRODUCTION_BLOCK = (
    "This folder is managed by Production. Use the production add/replace endpoints instead of a generic upload."
)


def _config(**overrides) -> dict:
    base = {
        "layer_height": "0.2",
        "initial_layer_line_width": "100%",
        "sparse_infill_density": "20%",
        "sparse_infill_pattern": "grid",
        "wall_loops": "3",
        "brim_type": "auto_brim",
        "brim_width": "5",
        "fuzzy_skin": "none",
        "fuzzy_skin_thickness": "0.3",
        "fuzzy_skin_point_distance": "0.8",
        "enable_support": "0",
        "support_type": "normal(auto)",
        "enable_prime_tower": "0",
        "seam_position": "aligned",
        "filament_settings_id": ["Bambu PLA Basic @BBL X1C"],
    }
    base.update(overrides)
    return base


def _3mf(config: dict | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        zf.writestr("Metadata/project_settings.config", json.dumps(config if config is not None else _config()))
    return buffer.getvalue()


def _upload(filename: str, content: bytes | None = None, **form):
    files = {"file": (filename, content if content is not None else _3mf(), "application/octet-stream")}
    data = {key: str(value) for key, value in form.items() if value is not None}
    return files, data


@pytest.mark.asyncio
@pytest.mark.integration
class TestProductionAPI:
    async def test_bootstrap_creates_section_and_folders_then_is_idempotent(self, async_client: AsyncClient):
        first = await async_client.post("/api/v1/production/bootstrap")
        assert first.status_code == 200
        body = first.json()
        assert body["section_id"]
        assert body["parts_created"] == 4
        assert body["parts_existing"] == 0
        assert body["folders_created"] == len(PRODUCTION_PRINTER_MODELS)
        models = {folder["production_printer_model"] for folder in body["folders"]}
        names = {folder["name"] for folder in body["folders"]}
        assert models == set(PRODUCTION_PRINTER_MODELS)
        assert names == set(PRODUCTION_PRINTER_MODELS)

        second = await async_client.post("/api/v1/production/bootstrap")
        assert second.status_code == 200
        again = second.json()
        assert again["section_id"] == body["section_id"]
        assert again["folders_created"] == 0
        assert again["folders_existing"] == len(PRODUCTION_PRINTER_MODELS)
        assert again["parts_created"] == 0
        assert again["parts_existing"] == 4
        assert {f["id"] for f in again["folders"]} == {f["id"] for f in body["folders"]}

    async def test_list_folders_bootstraps_production_section(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/library/folders")
        assert response.status_code == 200
        items = response.json()
        production = [folder for folder in items if folder.get("production_printer_model")]
        assert {folder["production_printer_model"] for folder in production} == set(PRODUCTION_PRINTER_MODELS)
        assert all(folder["section_id"] for folder in production)

        sections = await async_client.get("/api/v1/library/sections")
        assert sections.status_code == 200
        assert any(section["name"] == "Production" for section in sections.json())

    async def test_create_slot_then_duplicate_409(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        x1c = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")
        filename = "TOP - 1.13.2 - X1C.3mf"
        files, data = _upload(filename, folder_id=x1c["id"])

        created = await async_client.post("/api/v1/production/slots", files=files, data=data)
        assert created.status_code == 200, created.text
        slot = created.json()
        assert slot["code"] == "TOP"
        assert slot["quantity"] == 1
        assert slot["version"] == "1.13.2"
        assert slot["printer_model"] == "X1C"
        assert slot["active_file"]["filename"] == filename
        assert slot["last_mismatch"] is False
        assert slot["locked_parameters"]["layer_height"] == 0.2

        files, data = _upload(filename, folder_id=x1c["id"])
        duplicate = await async_client.post("/api/v1/production/slots", files=files, data=data)
        assert duplicate.status_code == 409
        assert duplicate.json()["detail"] == "Use replace for existing production slots"

        view = await async_client.get(f"/api/v1/production/folders/{x1c['id']}")
        assert view.status_code == 200
        payload = view.json()
        assert payload["printer_model"] == "X1C"
        top = next(part for part in payload["parts"] if part["code"] == "TOP")
        assert top["instance_id"] == slot["instance_id"]
        assert len(top["slots"]) == 1
        assert top["slots"][0]["id"] == slot["id"]
        assert {part["code"] for part in payload["parts"]} >= {"TOP", "BOT", "KNB", "BUT"}

    async def test_preview_replace_match_and_mismatch(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        x1c = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")
        files, data = _upload("TOP - 1.13.2 - X1C.3mf", folder_id=x1c["id"])
        slot_id = (await async_client.post("/api/v1/production/slots", files=files, data=data)).json()["id"]

        match_files, _ = _upload("TOP - 1.14.0 - X1C.3mf", _3mf(_config()))
        match = await async_client.post(f"/api/v1/production/slots/{slot_id}/preview-replace", files=match_files)
        assert match.status_code == 200, match.text
        matched = match.json()
        assert matched["parsed_filename"]["code"] == "TOP"
        assert matched["current_version"] == "1.13.2"
        assert matched["incoming_version"] == "1.14.0"
        assert matched["version_is_newer"] is True
        assert matched["suggested_next_version"] == "1.14.0"
        assert matched["has_mismatches"] is False
        assert matched["printer_matches_folder"] is True

        mismatch_files, _ = _upload("TOP - 1.14.0 - X1C.3mf", _3mf(_config(layer_height="0.28")))
        mismatch = await async_client.post(f"/api/v1/production/slots/{slot_id}/preview-replace", files=mismatch_files)
        assert mismatch.status_code == 200
        mismatched = mismatch.json()
        assert mismatched["has_mismatches"] is True
        layer = next(row for row in mismatched["parameter_diff"] if row["key"] == "layer_height")
        assert layer["match"] is False
        assert layer["locked"] == 0.2
        assert layer["incoming"] == 0.28

    async def test_replace_proceed_keeps_locked_params_and_history(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        x1c = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")
        files, data = _upload("TOP - 1.13.2 - X1C.3mf", folder_id=x1c["id"])
        created = (await async_client.post("/api/v1/production/slots", files=files, data=data)).json()
        slot_id = created["id"]
        old_file_id = created["active_file"]["id"]
        original_locked = created["locked_parameters"]["layer_height"]

        incoming, form = _upload(
            "TOP - 1.14.0 - X1C.3mf",
            _3mf(_config(layer_height="0.28")),
            resolution="proceed",
            reason="keep contract",
        )
        replaced = await async_client.post(f"/api/v1/production/slots/{slot_id}/replace", files=incoming, data=form)
        assert replaced.status_code == 200, replaced.text
        body = replaced.json()
        assert body["version"] == "1.14.0"
        assert body["last_mismatch"] is True
        assert body["locked_parameters"]["layer_height"] == original_locked
        new_file_id = body["active_file"]["id"]
        assert new_file_id != old_file_id

        history = await async_client.get(f"/api/v1/production/slots/{slot_id}/history")
        assert history.status_code == 200
        rows = history.json()
        assert len(rows) == 2
        assert rows[0]["version"] == "1.14.0"
        assert rows[0]["mismatch"] is True
        assert rows[0]["accepted_new_baseline"] is False
        assert rows[0]["file_id"] == new_file_id
        assert rows[1]["version"] == "1.13.2"
        assert rows[1]["accepted_new_baseline"] is True

        view = await async_client.get(f"/api/v1/production/folders/{x1c['id']}")
        top = next(part for part in view.json()["parts"] if part["code"] == "TOP")
        assert top["slots"][0]["active_file"]["id"] == new_file_id
        assert top["locked_parameters"]["layer_height"] == original_locked

        old_get = await async_client.get(f"/api/v1/library/files/{old_file_id}")
        new_get = await async_client.get(f"/api/v1/library/files/{new_file_id}")
        assert old_get.status_code == 200
        assert new_get.status_code == 200
        assert old_get.json()["id"] == old_file_id

    async def test_replace_accept_baseline_updates_locked_params(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        x1c = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")
        files, data = _upload("BOT x2 - 1.0.0 - X1C.3mf", folder_id=x1c["id"])
        created = (await async_client.post("/api/v1/production/slots", files=files, data=data)).json()
        slot_id = created["id"]

        incoming, form = _upload(
            "BOT x2 - 1.1.0 - X1C.3mf",
            _3mf(_config(layer_height="0.28")),
            resolution="accept_baseline",
        )
        replaced = await async_client.post(f"/api/v1/production/slots/{slot_id}/replace", files=incoming, data=form)
        assert replaced.status_code == 200, replaced.text
        body = replaced.json()
        assert body["locked_parameters"]["layer_height"] == 0.28
        assert body["last_mismatch"] is False
        assert body["version"] == "1.1.0"

        view = await async_client.get(f"/api/v1/production/folders/{x1c['id']}")
        bot = next(part for part in view.json()["parts"] if part["code"] == "BOT")
        assert bot["locked_parameters"]["layer_height"] == 0.28

    async def test_generic_upload_and_move_into_production_folder_409(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        x1c_id = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")["id"]

        upload = await async_client.post(
            f"/api/v1/library/files?folder_id={x1c_id}",
            files={"file": ("TOP - 1.13.2 - X1C.3mf", _3mf(), "application/octet-stream")},
        )
        assert upload.status_code == 409
        assert upload.json()["detail"] == _PRODUCTION_BLOCK

        zip_extract = await async_client.post(
            f"/api/v1/library/files/extract-zip?folder_id={x1c_id}",
            files={"file": ("pack.zip", b"PK dummy", "application/zip")},
        )
        assert zip_extract.status_code == 409
        assert zip_extract.json()["detail"] == _PRODUCTION_BLOCK

        root_upload = await async_client.post(
            "/api/v1/library/files",
            files={"file": ("loose.3mf", _3mf(), "application/octet-stream")},
        )
        assert root_upload.status_code == 200
        file_id = root_upload.json()["id"]

        moved = await async_client.post(
            "/api/v1/library/files/move",
            json={"file_ids": [file_id], "folder_id": x1c_id},
        )
        assert moved.status_code == 409
        assert moved.json()["detail"] == _PRODUCTION_BLOCK

        updated = await async_client.put(f"/api/v1/library/files/{file_id}", json={"folder_id": x1c_id})
        assert updated.status_code == 409
        assert updated.json()["detail"] == _PRODUCTION_BLOCK

    async def test_get_folder_rejects_non_production(self, async_client: AsyncClient, db_session):
        from backend.app.models.library import LibraryFolder

        folder = LibraryFolder(name="Ordinary")
        db_session.add(folder)
        await db_session.commit()
        await db_session.refresh(folder)

        missing = await async_client.get("/api/v1/production/folders/999999")
        assert missing.status_code == 404

        ordinary = await async_client.get(f"/api/v1/production/folders/{folder.id}")
        assert ordinary.status_code == 400
