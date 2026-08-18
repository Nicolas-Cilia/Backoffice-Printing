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
_PRODUCTION_ACTIVE_DELETE = "This file is an active production slot. Use the production slot delete endpoint instead."


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


def _3mf(config: dict | None = None, extra_files: dict[str, str] | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        zf.writestr("Metadata/project_settings.config", json.dumps(config if config is not None else _config()))
        if extra_files:
            for path, content in extra_files.items():
                zf.writestr(path, content)
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
        assert any(section["name"] == "Production" and section.get("kind") == "production" for section in sections.json())

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

    async def test_list_folders_file_count_excludes_superseded(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        x1c = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")
        files, data = _upload("TOP - 1.13.2 - X1C.3mf", folder_id=x1c["id"])
        created = await async_client.post("/api/v1/production/slots", files=files, data=data)
        assert created.status_code == 200, created.text

        incoming, form = _upload("TOP - 1.14.0 - X1C.3mf", resolution="proceed")
        replaced = await async_client.post(
            f"/api/v1/production/slots/{created.json()['id']}/replace", files=incoming, data=form
        )
        assert replaced.status_code == 200, replaced.text

        folders = (await async_client.get("/api/v1/library/folders")).json()
        x1c_tree = next(folder for folder in folders if folder["id"] == x1c["id"])
        assert x1c_tree["file_count"] == 1

        other_production = [
            folder for folder in folders if folder.get("production_printer_model") and folder["id"] != x1c["id"]
        ]
        assert all(folder["file_count"] == 0 for folder in other_production)

        detail = await async_client.get(f"/api/v1/library/folders/{x1c['id']}")
        assert detail.status_code == 200
        assert detail.json()["file_count"] == 1

    async def test_library_stats_excludes_superseded_production_files(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        x1c = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")
        files, data = _upload("TOP - 1.13.2 - X1C.3mf", folder_id=x1c["id"])
        created = await async_client.post("/api/v1/production/slots", files=files, data=data)
        assert created.status_code == 200, created.text
        slot_id = created.json()["id"]

        active_size = None
        for version in ("1.14.0", "1.15.0"):
            incoming, form = _upload(f"TOP - {version} - X1C.3mf", resolution="proceed")
            replaced = await async_client.post(f"/api/v1/production/slots/{slot_id}/replace", files=incoming, data=form)
            assert replaced.status_code == 200, replaced.text
            active_size = replaced.json()["active_file"]["file_size"]

        regular = await async_client.post(
            "/api/v1/library/files",
            files={"file": ("extra.3mf", _3mf(), "application/octet-stream")},
        )
        assert regular.status_code == 200, regular.text

        stats = await async_client.get("/api/v1/library/stats")
        assert stats.status_code == 200
        body = stats.json()
        assert body["total_files"] == 2
        assert body["total_size_bytes"] == active_size + regular.json()["file_size"]

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

    async def test_delete_slot_trashes_files_and_allows_readd(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        x1c = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")
        filename = "TOP x2 - 1.13.2 - X1C.3mf"
        files, data = _upload(filename, folder_id=x1c["id"])
        created = await async_client.post("/api/v1/production/slots", files=files, data=data)
        assert created.status_code == 200, created.text
        slot = created.json()
        slot_id = slot["id"]
        file_id = slot["active_file"]["id"]
        instance_id = slot["instance_id"]
        locked_height = slot["locked_parameters"]["layer_height"]

        missing = await async_client.delete("/api/v1/production/slots/999999")
        assert missing.status_code == 404

        generic = await async_client.delete(f"/api/v1/library/files/{file_id}")
        assert generic.status_code == 409
        assert generic.json()["detail"] == _PRODUCTION_ACTIVE_DELETE

        deleted = await async_client.delete(f"/api/v1/production/slots/{slot_id}")
        assert deleted.status_code == 200
        assert deleted.json() == {"deleted": True}

        view = await async_client.get(f"/api/v1/production/folders/{x1c['id']}")
        top = next(part for part in view.json()["parts"] if part["code"] == "TOP")
        assert top["slots"] == []
        assert top["instance_id"] == instance_id
        assert top["locked_parameters"]["layer_height"] == locked_height

        gone = await async_client.get(f"/api/v1/library/files/{file_id}")
        assert gone.status_code == 404

        trash = await async_client.get("/api/v1/library/trash")
        assert trash.status_code == 200
        assert file_id in {item["id"] for item in trash.json()["items"]}

        files, data = _upload(filename, folder_id=x1c["id"])
        readded = await async_client.post("/api/v1/production/slots", files=files, data=data)
        assert readded.status_code == 200, readded.text
        assert readded.json()["code"] == "TOP"
        assert readded.json()["quantity"] == 2

        view_after = await async_client.get(f"/api/v1/production/folders/{x1c['id']}")
        top_after = next(part for part in view_after.json()["parts"] if part["code"] == "TOP")
        assert len(top_after["slots"]) == 1
        assert top_after["slots"][0]["quantity"] == 2

    async def test_delete_slot_trashes_history_files(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        x1c = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")
        files, data = _upload("TOP - 1.13.2 - X1C.3mf", folder_id=x1c["id"])
        created = (await async_client.post("/api/v1/production/slots", files=files, data=data)).json()
        slot_id = created["id"]
        old_file_id = created["active_file"]["id"]

        incoming, form = _upload("TOP - 1.14.0 - X1C.3mf", resolution="proceed")
        replaced = await async_client.post(f"/api/v1/production/slots/{slot_id}/replace", files=incoming, data=form)
        assert replaced.status_code == 200, replaced.text
        new_file_id = replaced.json()["active_file"]["id"]
        assert new_file_id != old_file_id

        deleted = await async_client.delete(f"/api/v1/production/slots/{slot_id}")
        assert deleted.status_code == 200

        trash_ids = {item["id"] for item in (await async_client.get("/api/v1/library/trash")).json()["items"]}
        assert old_file_id in trash_ids
        assert new_file_id in trash_ids

        history = await async_client.get(f"/api/v1/production/slots/{slot_id}/history")
        assert history.status_code == 404

    async def test_sliced_fuzzy_without_mesh_paint_stays_none(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        a1 = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "A1")
        content = _3mf(
            _config(
                different_settings_to_system=[
                    "fuzzy_skin_point_distance;fuzzy_skin_thickness;wall_loops"
                ]
            ),
            extra_files={"Metadata/plate_1.gcode": "; fuzzy_skin = none\nG1 X0 Y0\n"},
        )
        files, data = _upload("TOP - 1.13.2 - A1.3mf", content, folder_id=a1["id"])
        created = await async_client.post("/api/v1/production/slots", files=files, data=data)
        assert created.status_code == 200, created.text
        assert created.json()["locked_parameters"]["fuzzy_skin"] == "none"

        view = await async_client.get(f"/api/v1/production/folders/{a1['id']}")
        assert view.status_code == 200
        top = next(part for part in view.json()["parts"] if part["code"] == "TOP")
        assert top["locked_parameters"]["fuzzy_skin"] == "none"

    async def test_a1_and_a1m_default_visible_parts_exclude_bot_and_but(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        folders = {folder["production_printer_model"]: folder for folder in boot["folders"]}

        a1 = (await async_client.get(f"/api/v1/production/folders/{folders['A1']['id']}")).json()
        a1m = (await async_client.get(f"/api/v1/production/folders/{folders['A1M']['id']}")).json()
        x1c = (await async_client.get(f"/api/v1/production/folders/{folders['X1C']['id']}")).json()
        h2d = (await async_client.get(f"/api/v1/production/folders/{folders['H2D']['id']}")).json()

        assert {part["code"] for part in a1["parts"]} == {"TOP", "KNB"}
        assert {part["code"] for part in a1m["parts"]} == {"TOP", "KNB"}
        assert {part["code"] for part in x1c["parts"]} == {"TOP", "BOT", "KNB", "BUT"}
        assert {part["code"] for part in h2d["parts"]} == {"TOP", "BOT", "KNB", "BUT"}
        assert all(part["instance_id"] for part in a1["parts"])
        assert all(part["slots"] == [] for part in a1["parts"])

    async def test_add_custom_part_is_per_printer(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        folders = {folder["production_printer_model"]: folder for folder in boot["folders"]}
        a1_id = folders["A1"]["id"]
        x1c_id = folders["X1C"]["id"]

        created = await async_client.post(
            f"/api/v1/production/folders/{a1_id}/parts",
            json={"code": "lid", "name": "Lid"},
        )
        assert created.status_code == 200, created.text
        body = created.json()
        assert body["code"] == "LID"
        assert body["name"] == "Lid"
        assert body["instance_id"]
        assert body["slots"] == []

        duplicate = await async_client.post(
            f"/api/v1/production/folders/{a1_id}/parts",
            json={"code": "LID", "name": "Lid"},
        )
        assert duplicate.status_code == 409

        invalid = await async_client.post(
            f"/api/v1/production/folders/{a1_id}/parts",
            json={"code": "L1D", "name": "Bad"},
        )
        assert invalid.status_code == 400

        a1 = (await async_client.get(f"/api/v1/production/folders/{a1_id}")).json()
        x1c = (await async_client.get(f"/api/v1/production/folders/{x1c_id}")).json()
        assert "LID" in {part["code"] for part in a1["parts"]}
        assert "LID" not in {part["code"] for part in x1c["parts"]}

    async def test_remove_empty_part_hides_row_and_can_be_readded(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        a1 = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "A1")
        view = (await async_client.get(f"/api/v1/production/folders/{a1['id']}")).json()
        knb = next(part for part in view["parts"] if part["code"] == "KNB")

        removed = await async_client.delete(f"/api/v1/production/folders/{a1['id']}/parts/{knb['id']}")
        assert removed.status_code == 200, removed.text
        assert removed.json() == {"removed": True, "files_trashed": 0}

        after = (await async_client.get(f"/api/v1/production/folders/{a1['id']}")).json()
        assert {part["code"] for part in after["parts"]} == {"TOP"}

        readded = await async_client.post(
            f"/api/v1/production/folders/{a1['id']}/parts",
            json={"code": "KNB", "name": "Knob"},
        )
        assert readded.status_code == 200, readded.text
        restored = (await async_client.get(f"/api/v1/production/folders/{a1['id']}")).json()
        assert {part["code"] for part in restored["parts"]} == {"TOP", "KNB"}

    async def test_remove_part_with_files_trashes_slots(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        a1 = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "A1")
        files, data = _upload("TOP - 1.0.0 - A1.3mf", folder_id=a1["id"])
        created = await async_client.post("/api/v1/production/slots", files=files, data=data)
        assert created.status_code == 200, created.text
        file_id = created.json()["active_file"]["id"]
        part_id = created.json()["part_id"]

        removed = await async_client.delete(f"/api/v1/production/folders/{a1['id']}/parts/{part_id}")
        assert removed.status_code == 200, removed.text
        assert removed.json()["files_trashed"] == 1

        view = (await async_client.get(f"/api/v1/production/folders/{a1['id']}")).json()
        assert "TOP" not in {part["code"] for part in view["parts"]}
        assert file_id in {item["id"] for item in (await async_client.get("/api/v1/library/trash")).json()["items"]}

    async def test_remove_part_route_error_is_not_masked_as_auth_unavailable(
        self, async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """Auth-disabled File Manager must not toast the auth-probe 503 when
        a production delete handler raises. The middleware used to wrap
        ``call_next`` in that fail-closed except.
        """
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        a1 = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "A1")
        view = (await async_client.get(f"/api/v1/production/folders/{a1['id']}")).json()
        knb = next(part for part in view["parts"] if part["code"] == "KNB")

        async def boom(*_args, **_kwargs):
            raise RuntimeError("simulated part-remove failure")

        monkeypatch.setattr("backend.app.api.routes.production._load_production_folder", boom)
        # BaseHTTPMiddleware re-raises unhandled route errors. The bug was
        # converting that into a 503 "Authentication service temporarily
        # unavailable" JSON body when auth is disabled.
        try:
            removed = await async_client.delete(
                f"/api/v1/production/folders/{a1['id']}/parts/{knb['id']}"
            )
        except BaseException as exc:
            assert "Authentication service temporarily unavailable" not in str(exc)
            assert "simulated part-remove failure" in str(exc)
        else:
            assert removed.status_code != 503
            assert "Authentication service temporarily unavailable" not in removed.text

    async def test_second_quantity_shares_instance_contract(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        x1c = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")
        first_files, first_data = _upload("TOP - 1.0.0 - X1C.3mf", folder_id=x1c["id"])
        first = await async_client.post("/api/v1/production/slots", files=first_files, data=first_data)
        assert first.status_code == 200, first.text
        instance_id = first.json()["instance_id"]
        original_height = first.json()["locked_parameters"]["layer_height"]

        match_files, match_data = _upload("TOP x2 - 1.0.0 - X1C.3mf", folder_id=x1c["id"])
        matched = await async_client.post("/api/v1/production/slots", files=match_files, data=match_data)
        assert matched.status_code == 200, matched.text
        assert matched.json()["instance_id"] == instance_id
        assert matched.json()["quantity"] == 2
        assert matched.json()["last_mismatch"] is False
        assert matched.json()["locked_parameters"]["layer_height"] == original_height

        mismatch_files, mismatch_data = _upload(
            "TOP x4 - 1.0.0 - X1C.3mf",
            _3mf(_config(layer_height="0.28")),
            folder_id=x1c["id"],
        )
        blocked = await async_client.post("/api/v1/production/slots", files=mismatch_files, data=mismatch_data)
        assert blocked.status_code == 400
        assert "proceed" in blocked.json()["detail"]

        preview_files, preview_data = _upload(
            "TOP x4 - 1.0.0 - X1C.3mf",
            _3mf(_config(layer_height="0.28")),
            folder_id=x1c["id"],
        )
        preview = await async_client.post("/api/v1/production/slots/preview", files=preview_files, data=preview_data)
        assert preview.status_code == 200, preview.text
        assert preview.json()["has_mismatches"] is True

        proceed_files, proceed_data = _upload(
            "TOP x4 - 1.0.0 - X1C.3mf",
            _3mf(_config(layer_height="0.28")),
            folder_id=x1c["id"],
            resolution="proceed",
            reason="keep x1 contract",
        )
        proceeded = await async_client.post("/api/v1/production/slots", files=proceed_files, data=proceed_data)
        assert proceeded.status_code == 200, proceeded.text
        assert proceeded.json()["last_mismatch"] is True
        assert proceeded.json()["locked_parameters"]["layer_height"] == original_height

        view = (await async_client.get(f"/api/v1/production/folders/{x1c['id']}")).json()
        top = next(part for part in view["parts"] if part["code"] == "TOP")
        assert top["locked_parameters"]["layer_height"] == original_height
        assert {slot["quantity"] for slot in top["slots"]} == {1, 2, 4}

    async def test_second_quantity_accept_baseline_updates_shared_contract(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        x1c = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")
        first_files, first_data = _upload("KNB - 1.0.0 - X1C.3mf", folder_id=x1c["id"])
        first = await async_client.post("/api/v1/production/slots", files=first_files, data=first_data)
        assert first.status_code == 200, first.text

        incoming, form = _upload(
            "KNB x2 - 1.0.0 - X1C.3mf",
            _3mf(_config(layer_height="0.28")),
            folder_id=x1c["id"],
            resolution="accept_baseline",
            reason="new shared spec",
        )
        accepted = await async_client.post("/api/v1/production/slots", files=incoming, data=form)
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["last_mismatch"] is False
        assert accepted.json()["locked_parameters"]["layer_height"] == 0.28

        view = (await async_client.get(f"/api/v1/production/folders/{x1c['id']}")).json()
        knb = next(part for part in view["parts"] if part["code"] == "KNB")
        assert knb["locked_parameters"]["layer_height"] == 0.28
        assert {slot["quantity"] for slot in knb["slots"]} == {1, 2}
