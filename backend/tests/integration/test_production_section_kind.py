"""Per-folder parameter tracking: mixed normal sections, forced tracking sections, empty parts."""

import pytest
from httpx import AsyncClient

from backend.app.models.production import default_part_codes_for_printer
from backend.tests.integration.test_production_api import _PRODUCTION_BLOCK, _3mf, _upload


@pytest.mark.asyncio
@pytest.mark.integration
class TestPerFolderParameterTracking:
    async def test_create_tracking_folder_in_normal_tests_section(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/library/sections", json={"name": "Tests"})).json()
        assert section["kind"] == "normal"

        created = await async_client.post(
            "/api/v1/library/folders",
            json={
                "name": "Test files",
                "section_id": section["id"],
                "parameter_tracking": True,
            },
        )
        assert created.status_code == 200, created.text
        body = created.json()
        assert body["section_id"] == section["id"]
        assert body["parameter_tracking"] is True
        assert body["production_printer_model"] is None

        view = await async_client.get(f"/api/v1/production/folders/{body['id']}")
        assert view.status_code == 200
        assert view.json()["parts"] == []

        upload = await async_client.post(
            f"/api/v1/library/files?folder_id={body['id']}",
            files={"file": ("LID - 1.0.0 - A1.3mf", _3mf(), "application/octet-stream")},
        )
        assert upload.status_code == 409
        assert upload.json()["detail"] == _PRODUCTION_BLOCK

    async def test_production_section_forces_tracking_even_if_client_opts_out(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        production_id = boot["section_id"]
        x1c = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "X1C")

        forced = await async_client.post(
            "/api/v1/library/folders",
            json={"name": "Line extras", "section_id": production_id, "parameter_tracking": False},
        )
        assert forced.status_code == 200, forced.text
        assert forced.json()["parameter_tracking"] is True
        assert forced.json()["production_printer_model"] is None

        view = await async_client.get(f"/api/v1/production/folders/{forced.json()['id']}")
        assert view.status_code == 200
        assert view.json()["parts"] == []

        ordinary = await async_client.post(
            f"/api/v1/library/files?folder_id={forced.json()['id']}",
            files={"file": ("toy.3mf", _3mf(), "application/octet-stream")},
        )
        assert ordinary.status_code == 409
        assert ordinary.json()["detail"] == _PRODUCTION_BLOCK

        blocked = await async_client.post(
            f"/api/v1/library/files?folder_id={x1c['id']}",
            files={"file": ("TOP - 1.13.2 - X1C.3mf", _3mf(), "application/octet-stream")},
        )
        assert blocked.status_code == 409
        assert blocked.json()["detail"] == _PRODUCTION_BLOCK

    async def test_mixed_folders_in_same_normal_tests_section(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/library/sections", json={"name": "Testing"})).json()

        fun = await async_client.post(
            "/api/v1/library/folders",
            json={"name": "Fun parts", "section_id": section["id"]},
        )
        tracking = await async_client.post(
            "/api/v1/library/folders",
            json={
                "name": "Test files",
                "section_id": section["id"],
                "parameter_tracking": True,
            },
        )
        assert fun.status_code == 200
        assert tracking.status_code == 200
        assert fun.json()["parameter_tracking"] is False
        assert fun.json()["production_printer_model"] is None
        assert tracking.json()["parameter_tracking"] is True
        assert tracking.json()["production_printer_model"] is None

        ok = await async_client.post(
            f"/api/v1/library/files?folder_id={fun.json()['id']}",
            files={"file": ("toy.3mf", _3mf(), "application/octet-stream")},
        )
        assert ok.status_code == 200, ok.text

        blocked = await async_client.post(
            f"/api/v1/library/files?folder_id={tracking.json()['id']}",
            files={"file": ("LID - 1.0.0 - A1.3mf", _3mf(), "application/octet-stream")},
        )
        assert blocked.status_code == 409
        assert blocked.json()["detail"] == _PRODUCTION_BLOCK

        tree = (await async_client.get("/api/v1/library/folders")).json()
        by_id = {item["id"]: item for item in tree}
        assert by_id[fun.json()["id"]]["section_id"] == section["id"]
        assert by_id[tracking.json()["id"]]["section_id"] == section["id"]

    async def test_add_part_then_upload_filename_printer_without_folder_printer(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/library/sections", json={"name": "Testing"})).json()
        created = await async_client.post(
            "/api/v1/library/folders",
            json={"name": "Test files", "section_id": section["id"], "parameter_tracking": True},
        )
        assert created.status_code == 200, created.text
        folder_id = created.json()["id"]

        part = await async_client.post(
            f"/api/v1/production/folders/{folder_id}/parts",
            json={"code": "lid", "name": "Lid"},
        )
        assert part.status_code == 200, part.text
        assert part.json()["code"] == "LID"
        assert part.json()["slots"] == []

        view = await async_client.get(f"/api/v1/production/folders/{folder_id}")
        assert view.status_code == 200
        assert {p["code"] for p in view.json()["parts"]} == {"LID"}
        assert view.json()["printer_model"] == ""

        files, data = _upload("LID - 1.0.0 - A1.3mf", folder_id=folder_id)
        slot = await async_client.post("/api/v1/production/slots", files=files, data=data)
        assert slot.status_code == 200, slot.text
        assert slot.json()["code"] == "LID"
        assert slot.json()["version"] == "1.0.0"

        after = await async_client.get(f"/api/v1/production/folders/{folder_id}")
        lid = next(p for p in after.json()["parts"] if p["code"] == "LID")
        assert len(lid["slots"]) == 1

    async def test_moving_folder_into_tracking_section_enables_tracking(self, async_client: AsyncClient):
        section = (
            await async_client.post(
                "/api/v1/library/sections",
                json={"name": "QA Line", "kind": "production"},
            )
        ).json()
        folder = (await async_client.post("/api/v1/library/folders", json={"name": "Widgets"})).json()
        assert folder["parameter_tracking"] is False

        moved = await async_client.put(
            f"/api/v1/library/folders/{folder['id']}/section",
            json={"section_id": section["id"]},
        )
        assert moved.status_code == 200, moved.text
        assert moved.json()["parameter_tracking"] is True

        upload = await async_client.post(
            f"/api/v1/library/files?folder_id={folder['id']}",
            files={"file": ("toy.3mf", _3mf(), "application/octet-stream")},
        )
        assert upload.status_code == 409

    async def test_second_tracking_folder_is_independent(self, async_client: AsyncClient):
        boot = (await async_client.post("/api/v1/production/bootstrap")).json()
        production_a1 = next(folder for folder in boot["folders"] if folder["production_printer_model"] == "A1")

        section = (await async_client.post("/api/v1/library/sections", json={"name": "Testing"})).json()
        created = await async_client.post(
            "/api/v1/library/folders",
            json={
                "name": "Test files",
                "section_id": section["id"],
                "parameter_tracking": True,
            },
        )
        assert created.status_code == 200, created.text
        assert created.json()["id"] != production_a1["id"]

        view = await async_client.get(f"/api/v1/production/folders/{created.json()['id']}")
        assert view.status_code == 200
        assert view.json()["parts"] == []

        prod_view = await async_client.get(f"/api/v1/production/folders/{production_a1['id']}")
        assert prod_view.status_code == 200
        assert {part["code"] for part in prod_view.json()["parts"]} == set(default_part_codes_for_printer("A1"))

    async def test_bootstrapped_production_folders_still_block_generic_upload(self, async_client: AsyncClient):
        boot = await async_client.post("/api/v1/production/bootstrap")
        assert boot.status_code == 200
        sections = (await async_client.get("/api/v1/library/sections")).json()
        production = next(section for section in sections if section["id"] == boot.json()["section_id"])
        assert production["kind"] == "production"

        x1c = next(folder for folder in boot.json()["folders"] if folder["production_printer_model"] == "X1C")
        upload = await async_client.post(
            f"/api/v1/library/files?folder_id={x1c['id']}",
            files={"file": ("TOP - 1.13.2 - X1C.3mf", _3mf(), "application/octet-stream")},
        )
        assert upload.status_code == 409
        assert upload.json()["detail"] == _PRODUCTION_BLOCK
