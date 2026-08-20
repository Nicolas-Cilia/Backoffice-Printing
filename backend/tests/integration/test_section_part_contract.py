"""Section-level print-settings contract for parameter-tracking File Manager folders."""

import pytest
from httpx import AsyncClient

from backend.tests.integration.test_production_api import _3mf, _config, _upload


def _mismatch_notes(preview: dict, text: str = "H2S max is 0.24") -> dict[str, str]:
    return {row["key"]: text for row in preview["parameter_diff"] if not row["match"]}


@pytest.mark.asyncio
@pytest.mark.integration
class TestSectionPartContract:
    async def test_section_contract_notes_and_accept_baseline(self, async_client: AsyncClient):
        section = (
            await async_client.post(
                "/api/v1/library/sections",
                json={"name": "Shared line", "kind": "production"},
            )
        ).json()
        folder1 = (
            await async_client.post(
                "/api/v1/library/folders",
                json={
                    "name": "Station 1",
                    "section_id": section["id"],
                    "parameter_tracking": True,
                },
            )
        ).json()
        folder2 = (
            await async_client.post(
                "/api/v1/library/folders",
                json={
                    "name": "Station 2",
                    "section_id": section["id"],
                    "parameter_tracking": True,
                },
            )
        ).json()

        created = await async_client.post(
            f"/api/v1/library/sections/{section['id']}/parts",
            json={"code": "TOP", "name": "Top Housing"},
        )
        assert created.status_code == 201, created.text
        part_id = created.json()["id"]

        seeded = await async_client.post(
            f"/api/v1/library/sections/{section['id']}/parts/{part_id}/parameters",
            files={"file": ("seed.3mf", _3mf(_config(layer_height="0.20")), "application/octet-stream")},
        )
        assert seeded.status_code == 200, seeded.text
        assert seeded.json()["locked_parameters"]["layer_height"] == 0.2

        added = await async_client.post(
            f"/api/v1/production/folders/{folder1['id']}/parts",
            json={"code": "TOP"},
        )
        assert added.status_code == 200, added.text
        assert added.json()["locked_parameters"]["layer_height"] == 0.2

        match_files, match_data = _upload(
            "TOP - 1.0.0 - X1C.3mf",
            _3mf(_config(layer_height="0.20")),
            folder_id=folder1["id"],
        )
        matched = await async_client.post("/api/v1/production/slots", files=match_files, data=match_data)
        assert matched.status_code == 200, matched.text
        assert matched.json()["last_mismatch"] is False
        assert matched.json()["parameter_notes"] is None

        preview_files, preview_data = _upload(
            "TOP x2 - 1.0.0 - X1C.3mf",
            _3mf(_config(layer_height="0.28")),
            folder_id=folder1["id"],
        )
        preview = await async_client.post("/api/v1/production/slots/preview", files=preview_files, data=preview_data)
        assert preview.status_code == 200, preview.text
        assert preview.json()["has_mismatches"] is True

        blocked_files, blocked_data = _upload(
            "TOP x2 - 1.0.0 - X1C.3mf",
            _3mf(_config(layer_height="0.28")),
            folder_id=folder1["id"],
            resolution="proceed",
        )
        blocked = await async_client.post("/api/v1/production/slots", files=blocked_files, data=blocked_data)
        assert blocked.status_code == 400
        assert blocked.json()["detail"] == "Explain every mismatched parameter"

        notes = _mismatch_notes(preview.json())
        proceed_files, proceed_data = _upload(
            "TOP x2 - 1.0.0 - X1C.3mf",
            _3mf(_config(layer_height="0.28")),
            folder_id=folder1["id"],
            resolution="proceed",
            parameter_notes=notes,
        )
        proceeded = await async_client.post("/api/v1/production/slots", files=proceed_files, data=proceed_data)
        assert proceeded.status_code == 200, proceeded.text
        assert proceeded.json()["last_mismatch"] is True
        assert proceeded.json()["parameter_notes"]["layer_height"] == notes["layer_height"]
        mismatch_slot_id = proceeded.json()["id"]

        added2 = await async_client.post(
            f"/api/v1/production/folders/{folder2['id']}/parts",
            json={"code": "TOP"},
        )
        assert added2.status_code == 200, added2.text
        files2, data2 = _upload(
            "TOP - 1.0.0 - X1C.3mf",
            _3mf(_config(layer_height="0.20")),
            folder_id=folder2["id"],
        )
        match2 = await async_client.post("/api/v1/production/slots", files=files2, data=data2)
        assert match2.status_code == 200, match2.text
        assert match2.json()["last_mismatch"] is False
        assert match2.json()["locked_parameters"]["layer_height"] == 0.2

        incoming, form = _upload(
            "TOP x2 - 1.1.0 - X1C.3mf",
            _3mf(_config(layer_height="0.28")),
            resolution="accept_baseline",
        )
        accepted = await async_client.post(
            f"/api/v1/production/slots/{mismatch_slot_id}/replace",
            files=incoming,
            data=form,
        )
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["last_mismatch"] is False
        assert accepted.json()["locked_parameters"]["layer_height"] == 0.28
        assert accepted.json()["parameter_notes"] is None

        view2 = await async_client.get(f"/api/v1/production/folders/{folder2['id']}")
        assert view2.status_code == 200
        top2 = next(part for part in view2.json()["parts"] if part["code"] == "TOP")
        assert top2["locked_parameters"]["layer_height"] == 0.28
        assert top2["slots"][0]["last_mismatch"] is True

        section_parts = await async_client.get(f"/api/v1/library/sections/{section['id']}/parts")
        top_template = next(row for row in section_parts.json() if row["code"] == "TOP")
        assert top_template["locked_parameters"]["layer_height"] == 0.28

    async def test_folder_without_section_uses_instance_contract(self, async_client: AsyncClient):
        folder = await async_client.post(
            "/api/v1/library/folders",
            json={"name": "Loose tracking", "parameter_tracking": True},
        )
        assert folder.status_code == 200, folder.text
        folder_id = folder.json()["id"]
        assert folder.json()["section_id"] is None

        added = await async_client.post(
            f"/api/v1/production/folders/{folder_id}/parts",
            json={"code": "LID", "name": "Lid"},
        )
        assert added.status_code == 200, added.text
        assert added.json()["locked_parameters"] is None

        first_files, first_data = _upload("LID - 1.0.0 - A1.3mf", folder_id=folder_id)
        first = await async_client.post("/api/v1/production/slots", files=first_files, data=first_data)
        assert first.status_code == 200, first.text
        assert first.json()["locked_parameters"]["layer_height"] == 0.2

        other = await async_client.post(
            "/api/v1/library/folders",
            json={"name": "Other tracking", "parameter_tracking": True},
        )
        assert other.status_code == 200, other.text
        other_id = other.json()["id"]
        await async_client.post(
            f"/api/v1/production/folders/{other_id}/parts",
            json={"code": "LID", "name": "Lid"},
        )
        other_files, other_data = _upload(
            "LID - 1.0.0 - A1.3mf",
            _3mf(_config(layer_height="0.28")),
            folder_id=other_id,
        )
        other_slot = await async_client.post("/api/v1/production/slots", files=other_files, data=other_data)
        assert other_slot.status_code == 200, other_slot.text
        assert other_slot.json()["last_mismatch"] is False
        assert other_slot.json()["locked_parameters"]["layer_height"] == 0.28

        original = await async_client.get(f"/api/v1/production/folders/{folder_id}")
        lid = next(part for part in original.json()["parts"] if part["code"] == "LID")
        assert lid["locked_parameters"]["layer_height"] == 0.2
