"""Integration tests for profile part-section create / add / replace."""

import json

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


async def _create_process(client: AsyncClient, name: str, **setting_overrides) -> dict:
    created = await client.post(
        "/api/v1/local-presets/",
        json={
            "name": name,
            "preset_type": "process",
            "setting": _process_setting(**setting_overrides),
        },
    )
    assert created.status_code == 200, created.text
    return created.json()


@pytest.mark.asyncio
@pytest.mark.integration
class TestProfilePartsAPI:
    async def test_create_section_add_mismatch_replace_proceed_and_accept(self, async_client: AsyncClient):
        created = await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})
        assert created.status_code == 200, created.text
        section = created.json()
        assert section["name"] == "Top part"
        assert section["locked_parameters"] is None
        assert section["slots"] == []

        x1c = await _create_process(async_client, "0.20mm Standard @BBL X1C", layer_height="0.2")
        a1 = await _create_process(async_client, "0.28mm Strength @BBL A1", layer_height="0.28")

        first = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={"section_id": section["id"], "preset_id": x1c["id"]},
        )
        assert first.status_code == 200, first.text
        seeded = first.json()
        assert seeded["locked_parameters"]["layer_height"] == 0.2
        assert len(seeded["slots"]) == 1
        x1c_slot = seeded["slots"][0]
        assert x1c_slot["printer_model"] == "X1C"
        assert x1c_slot["last_mismatch"] is False
        assert x1c_slot["spec_status"] == "match"
        assert x1c_slot["preset"]["name"] == "0.20mm Standard @BBL X1C"

        preview_add = await async_client.post(
            f"/api/v1/profile-parts/sections/{section['id']}/preview-add",
            json={"preset_id": a1["id"]},
        )
        assert preview_add.status_code == 200, preview_add.text
        assert preview_add.json()["has_mismatches"] is True

        blocked = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={"section_id": section["id"], "preset_id": a1["id"]},
        )
        assert blocked.status_code == 409
        listed_blocked = await async_client.get("/api/v1/profile-parts/sections")
        blocked_section = next(item for item in listed_blocked.json() if item["id"] == section["id"])
        assert len(blocked_section["slots"]) == 1

        second = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={"section_id": section["id"], "preset_id": a1["id"], "resolution": "proceed"},
        )
        assert second.status_code == 200, second.text
        mismatched = second.json()
        assert mismatched["locked_parameters"]["layer_height"] == 0.2
        a1_slot = next(slot for slot in mismatched["slots"] if slot["printer_model"] == "A1")
        assert a1_slot["last_mismatch"] is True
        assert a1_slot["spec_status"] == "mismatch"
        layer_row = next(row for row in a1_slot["parameter_diff"] if row["key"] == "layer_height")
        assert layer_row["locked"] == 0.2
        assert layer_row["incoming"] == 0.28
        assert layer_row["match"] is False

        listed = await async_client.get("/api/v1/profile-parts/sections")
        assert listed.status_code == 200
        listed_section = next(item for item in listed.json() if item["id"] == section["id"])
        assert len(listed_section["slots"]) == 2
        listed_a1 = next(slot for slot in listed_section["slots"] if slot["printer_model"] == "A1")
        assert listed_a1["last_mismatch"] is True

        preview = await async_client.post(
            f"/api/v1/profile-parts/slots/{a1_slot['id']}/preview-replace",
            json={"preset_id": a1["id"]},
        )
        assert preview.status_code == 200, preview.text
        assert preview.json()["has_mismatches"] is True
        assert preview.json()["printer_model"] == "A1"
        assert preview.json()["incoming_parameters"]["layer_height"] == 0.28

        proceeded = await async_client.post(
            f"/api/v1/profile-parts/slots/{a1_slot['id']}/replace",
            json={"preset_id": a1["id"], "resolution": "proceed"},
        )
        assert proceeded.status_code == 200, proceeded.text
        after_proceed = proceeded.json()
        assert after_proceed["locked_parameters"]["layer_height"] == 0.2
        a1_after = next(slot for slot in after_proceed["slots"] if slot["id"] == a1_slot["id"])
        assert a1_after["last_mismatch"] is True

        replacement = await _create_process(async_client, "0.28mm Strength v2 @BBL A1", layer_height="0.28")
        accepted = await async_client.post(
            f"/api/v1/profile-parts/slots/{a1_slot['id']}/replace",
            json={"preset_id": replacement["id"], "resolution": "accept_baseline"},
        )
        assert accepted.status_code == 200, accepted.text
        after_accept = accepted.json()
        assert after_accept["locked_parameters"]["layer_height"] == 0.28
        a1_accepted = next(slot for slot in after_accept["slots"] if slot["id"] == a1_slot["id"])
        assert a1_accepted["last_mismatch"] is False
        assert a1_accepted["spec_status"] == "match"
        x1c_after = next(slot for slot in after_accept["slots"] if slot["printer_model"] == "X1C")
        assert x1c_after["last_mismatch"] is True

    async def test_h2s_max_layer_matches_thicker_x1c_spec(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})).json()
        x1c = await _create_process(async_client, "0.28mm Strength @BBL X1C", layer_height="0.28")
        h2s = await _create_process(async_client, "0.24mm Standard @BBL H2S", layer_height="0.24")

        seeded = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={"section_id": section["id"], "preset_id": x1c["id"]},
        )
        assert seeded.status_code == 200, seeded.text
        assert seeded.json()["locked_parameters"]["layer_height"] == 0.28

        preview = await async_client.post(
            f"/api/v1/profile-parts/sections/{section['id']}/preview-add",
            json={"preset_id": h2s["id"]},
        )
        assert preview.status_code == 200, preview.text
        assert preview.json()["has_mismatches"] is False
        layer_row = next(
            row for row in preview.json()["parameter_diff"] if row["key"] == "layer_height"
        )
        assert layer_row["locked"] == 0.28
        assert layer_row["incoming"] == 0.24
        assert layer_row["match"] is True

        added = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={"section_id": section["id"], "preset_id": h2s["id"]},
        )
        assert added.status_code == 200, added.text
        body = added.json()
        assert body["locked_parameters"]["layer_height"] == 0.28
        h2s_slot = next(slot for slot in body["slots"] if slot["printer_model"] == "H2S")
        assert h2s_slot["last_mismatch"] is False
        assert h2s_slot["spec_status"] == "match"
        assert h2s_slot["preset"]["locked_parameters"]["layer_height"] == 0.24

        listed = await async_client.get("/api/v1/local-presets/")
        h2s_listed = next(preset for preset in listed.json()["process"] if preset["id"] == h2s["id"])
        assert h2s_listed["locked_parameters"]["layer_height"] == 0.24

        detail = await async_client.get(f"/api/v1/local-presets/{h2s['id']}")
        assert detail.status_code == 200, detail.text
        assert detail.json()["setting"]["layer_height"] == "0.24"

    async def test_h2s_below_max_still_needs_proceed(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})).json()
        x1c = await _create_process(async_client, "0.28mm Strength @BBL X1C", layer_height="0.28")
        h2s = await _create_process(async_client, "0.16mm Optimal @BBL H2S", layer_height="0.16")

        seeded = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={"section_id": section["id"], "preset_id": x1c["id"]},
        )
        assert seeded.status_code == 200, seeded.text

        blocked = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={"section_id": section["id"], "preset_id": h2s["id"]},
        )
        assert blocked.status_code == 409

        proceeded = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={"section_id": section["id"], "preset_id": h2s["id"], "resolution": "proceed"},
        )
        assert proceeded.status_code == 200, proceeded.text
        h2s_slot = next(slot for slot in proceeded.json()["slots"] if slot["printer_model"] == "H2S")
        assert h2s_slot["last_mismatch"] is True
        assert h2s_slot["spec_status"] == "mismatch"

    async def test_second_process_same_printer_is_409(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})).json()
        first = await _create_process(async_client, "0.20mm Standard @BBL X1C")
        other = await _create_process(async_client, "0.16mm Optimal @BBL X1C", layer_height="0.16")
        added = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={"section_id": section["id"], "preset_id": first["id"]},
        )
        assert added.status_code == 200, added.text
        duplicate = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={"section_id": section["id"], "preset_id": other["id"]},
        )
        assert duplicate.status_code == 409
        assert duplicate.json()["detail"] == "Use replace for an existing printer slot"

    async def test_delete_section_and_empty_name_rejected(self, async_client: AsyncClient):
        blank = await async_client.post("/api/v1/profile-parts/sections", json={"name": "   "})
        assert blank.status_code == 400

        section = (await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})).json()
        deleted = await async_client.delete(f"/api/v1/profile-parts/sections/{section['id']}")
        assert deleted.status_code == 200
        listed = await async_client.get("/api/v1/profile-parts/sections")
        assert listed.json() == []


def _process_file_payload(name: str, **setting_overrides) -> dict:
    payload = _process_setting(**setting_overrides)
    payload["name"] = name
    payload["type"] = "process"
    return payload


def _upload_process(client: AsyncClient, section_id: int, name: str, filename: str | None = None, **setting_overrides):
    payload = _process_file_payload(name, **setting_overrides)
    file_name = filename or f"{name}.json"
    return client.post(
        f"/api/v1/profile-parts/sections/{section_id}/import",
        files={"file": (file_name, json.dumps(payload).encode(), "application/json")},
    )


@pytest.mark.asyncio
@pytest.mark.integration
class TestProfilePartSectionImport:
    async def test_upload_process_into_empty_section_seeds_contract(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})).json()
        uploaded = await _upload_process(async_client, section["id"], "0.20mm Standard @BBL X1C")
        assert uploaded.status_code == 200, uploaded.text
        body = uploaded.json()
        assert body["imported"] == 1
        assert body["skipped"] == 0
        assert len(body["attached"]) == 1
        assert body["needs_replace"] == []
        assert body["section"]["locked_parameters"]["layer_height"] == 0.2
        slot = body["attached"][0]["slot"]
        assert slot["printer_model"] == "X1C"
        assert slot["spec_status"] == "match"
        assert slot["last_mismatch"] is False
        assert body["section"]["slots"][0]["preset"]["name"] == "0.20mm Standard @BBL X1C"

    async def test_upload_second_printer_flags_mismatch(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})).json()
        first = await _upload_process(async_client, section["id"], "0.20mm Standard @BBL X1C")
        assert first.status_code == 200, first.text
        second = await _upload_process(
            async_client, section["id"], "0.28mm Strength @BBL A1", layer_height="0.28"
        )
        assert second.status_code == 200, second.text
        body = second.json()
        assert body["attached"] == []
        assert body["needs_replace"] == []
        assert len(body["needs_confirm"]) == 1
        assert body["section"]["locked_parameters"]["layer_height"] == 0.2
        assert len(body["section"]["slots"]) == 1
        pending = body["needs_confirm"][0]
        assert pending["printer_model"] == "A1"
        assert pending["preview"]["has_mismatches"] is True
        layer_row = next(row for row in pending["preview"]["parameter_diff"] if row["key"] == "layer_height")
        assert layer_row["locked"] == 0.2
        assert layer_row["incoming"] == 0.28

        proceeded = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={
                "section_id": section["id"],
                "preset_id": pending["preset_id"],
                "resolution": "proceed",
            },
        )
        assert proceeded.status_code == 200, proceeded.text
        a1 = next(slot for slot in proceeded.json()["slots"] if slot["printer_model"] == "A1")
        assert a1["spec_status"] == "mismatch"
        assert a1["last_mismatch"] is True

    async def test_upload_same_printer_returns_needs_replace_not_second_slot(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})).json()
        first = await _upload_process(async_client, section["id"], "0.20mm Standard @BBL X1C")
        assert first.status_code == 200, first.text
        slot_id = first.json()["section"]["slots"][0]["id"]

        again = await _upload_process(
            async_client, section["id"], "0.16mm Optimal @BBL X1C", layer_height="0.16"
        )
        assert again.status_code == 200, again.text
        body = again.json()
        assert body["attached"] == []
        assert len(body["needs_replace"]) == 1
        pending = body["needs_replace"][0]
        assert pending["printer_model"] == "X1C"
        assert pending["existing_slot_id"] == slot_id
        assert pending["preview"]["has_mismatches"] is True
        assert pending["preview"]["incoming_parameters"]["layer_height"] == 0.16
        assert len(body["section"]["slots"]) == 1

        proceeded = await async_client.post(
            f"/api/v1/profile-parts/slots/{slot_id}/replace",
            json={"preset_id": pending["preset_id"], "resolution": "proceed"},
        )
        assert proceeded.status_code == 200, proceeded.text
        after_proceed = proceeded.json()
        assert after_proceed["locked_parameters"]["layer_height"] == 0.2
        assert after_proceed["slots"][0]["last_mismatch"] is True

        accepted = await async_client.post(
            f"/api/v1/profile-parts/slots/{slot_id}/replace",
            json={"preset_id": pending["preset_id"], "resolution": "accept_baseline"},
        )
        assert accepted.status_code == 200, accepted.text
        after_accept = accepted.json()
        assert after_accept["locked_parameters"]["layer_height"] == 0.16
        assert after_accept["slots"][0]["last_mismatch"] is False

    async def test_upload_h2s_max_layer_attaches_as_match(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})).json()
        first = await _upload_process(
            async_client, section["id"], "0.28mm Strength @BBL X1C", layer_height="0.28"
        )
        assert first.status_code == 200, first.text
        assert first.json()["section"]["locked_parameters"]["layer_height"] == 0.28

        second = await _upload_process(
            async_client, section["id"], "0.24mm Standard @BBL H2S", layer_height="0.24"
        )
        assert second.status_code == 200, second.text
        body = second.json()
        assert body["needs_confirm"] == []
        assert body["needs_replace"] == []
        assert len(body["attached"]) == 1
        assert body["section"]["locked_parameters"]["layer_height"] == 0.28
        slot = body["attached"][0]["slot"]
        assert slot["printer_model"] == "H2S"
        assert slot["spec_status"] == "match"
        assert slot["last_mismatch"] is False
        layer_row = next(row for row in slot["parameter_diff"] if row["key"] == "layer_height")
        assert layer_row["match"] is True
        assert layer_row["locked"] == 0.28
        assert layer_row["incoming"] == 0.24

    async def test_upload_h2s_below_max_needs_confirm(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})).json()
        first = await _upload_process(
            async_client, section["id"], "0.28mm Strength @BBL X1C", layer_height="0.28"
        )
        assert first.status_code == 200, first.text

        second = await _upload_process(
            async_client, section["id"], "0.16mm Optimal @BBL H2S", layer_height="0.16"
        )
        assert second.status_code == 200, second.text
        body = second.json()
        assert body["attached"] == []
        assert len(body["needs_confirm"]) == 1
        pending = body["needs_confirm"][0]
        assert pending["printer_model"] == "H2S"
        assert pending["preview"]["has_mismatches"] is True
        layer_row = next(
            row for row in pending["preview"]["parameter_diff"] if row["key"] == "layer_height"
        )
        assert layer_row["locked"] == 0.28
        assert layer_row["incoming"] == 0.16
        assert layer_row["match"] is False

        proceeded = await async_client.post(
            "/api/v1/profile-parts/slots",
            json={
                "section_id": section["id"],
                "preset_id": pending["preset_id"],
                "resolution": "proceed",
            },
        )
        assert proceeded.status_code == 200, proceeded.text
        h2s = next(slot for slot in proceeded.json()["slots"] if slot["printer_model"] == "H2S")
        assert h2s["spec_status"] == "mismatch"
        assert h2s["last_mismatch"] is True

    async def test_upload_filament_only_is_400(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})).json()
        payload = {"name": "Generic PLA @Voron 2.4", "type": "filament", "filament_type": ["PLA"]}
        uploaded = await async_client.post(
            f"/api/v1/profile-parts/sections/{section['id']}/import",
            files={"file": ("filament.json", json.dumps(payload).encode(), "application/json")},
        )
        assert uploaded.status_code == 400
        assert uploaded.json()["detail"] == "This file does not contain a process preset"
        listed = await async_client.get("/api/v1/profile-parts/sections")
        assert listed.json()[0]["slots"] == []

    async def test_duplicate_name_updates_and_attaches(self, async_client: AsyncClient, db_session):
        existing = await _create_process(async_client, "0.20mm Standard @BBL X1C", layer_height="0.2")
        section = (await async_client.post("/api/v1/profile-parts/sections", json={"name": "Top part"})).json()
        uploaded = await _upload_process(
            async_client, section["id"], "0.20mm Standard @BBL X1C", layer_height="0.16"
        )
        assert uploaded.status_code == 200, uploaded.text
        body = uploaded.json()
        assert body["imported"] == 1
        assert body["skipped"] == 0
        assert len(body["attached"]) == 1
        assert body["section"]["locked_parameters"]["layer_height"] == 0.16
        assert body["attached"][0]["slot"]["preset"]["id"] == existing["id"]

        stored = (
            await db_session.execute(select(LocalPreset).where(LocalPreset.id == existing["id"]))
        ).scalar_one()
        await db_session.refresh(stored)
        setting = json.loads(stored.setting)
        assert setting["layer_height"] == "0.16"

        listed = await async_client.get("/api/v1/local-presets/")
        processes = listed.json()["process"]
        assert len(processes) == 1
        assert processes[0]["id"] == existing["id"]
        assert processes[0]["locked_parameters"]["layer_height"] == 0.16
