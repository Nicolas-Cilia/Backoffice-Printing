"""Integration tests for the folder-picker section catalog + folder assignment
(folder-sections feature, built on top of #folder-cards)."""

import pytest
from httpx import AsyncClient


@pytest.fixture
async def folder_factory(db_session):
    """Minimal folder factory shared across the tests in this module."""
    _counter = [0]

    async def _create_folder(**kwargs):
        from backend.app.models.library import LibraryFolder

        _counter[0] += 1
        defaults = {"name": f"Folder {_counter[0]}"}
        defaults.update(kwargs)
        f = LibraryFolder(**defaults)
        db_session.add(f)
        await db_session.commit()
        await db_session.refresh(f)
        return f

    return _create_folder


class TestFolderSectionCRUD:
    """Catalog CRUD: create / list / rename / delete."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_section_and_list(self, async_client: AsyncClient):
        r = await async_client.post("/api/v1/library/sections", json={"name": "Production"})
        assert r.status_code == 201
        body = r.json()
        assert body["name"] == "Production"
        assert body["folder_count"] == 0
        assert body["sort_order"] == 1

        r = await async_client.get("/api/v1/library/sections")
        assert r.status_code == 200
        names = [s["name"] for s in r.json()]
        assert "Production" in names

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_section_strips_whitespace(self, async_client: AsyncClient):
        r = await async_client.post("/api/v1/library/sections", json={"name": "  Testing  "})
        assert r.status_code == 201
        assert r.json()["name"] == "Testing"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_duplicate_case_insensitive_409(self, async_client: AsyncClient):
        r1 = await async_client.post("/api/v1/library/sections", json={"name": "Production"})
        assert r1.status_code == 201
        for dup in ("production", "PRODUCTION", "  Production  "):
            r = await async_client.post("/api/v1/library/sections", json={"name": dup})
            assert r.status_code == 409, dup

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_new_sections_append_sort_order(self, async_client: AsyncClient):
        a = (await async_client.post("/api/v1/library/sections", json={"name": "A"})).json()
        b = (await async_client.post("/api/v1/library/sections", json={"name": "B"})).json()
        assert b["sort_order"] > a["sort_order"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rename_section(self, async_client: AsyncClient):
        r = await async_client.post("/api/v1/library/sections", json={"name": "Testng"})
        section_id = r.json()["id"]
        r = await async_client.patch(f"/api/v1/library/sections/{section_id}", json={"name": "Testing"})
        assert r.status_code == 200
        assert r.json()["name"] == "Testing"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rename_collision_409_but_own_name_noop_ok(self, async_client: AsyncClient):
        a = (await async_client.post("/api/v1/library/sections", json={"name": "A"})).json()
        b = (await async_client.post("/api/v1/library/sections", json={"name": "B"})).json()
        # Renaming b -> A (case-insensitive collision with a) must fail.
        r = await async_client.patch(f"/api/v1/library/sections/{b['id']}", json={"name": "A"})
        assert r.status_code == 409
        # Renaming a row to its own current name (round-trip) must NOT 409.
        r = await async_client.patch(f"/api/v1/library/sections/{a['id']}", json={"name": "A"})
        assert r.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rename_unknown_section_404(self, async_client: AsyncClient):
        r = await async_client.patch("/api/v1/library/sections/999999", json={"name": "X"})
        assert r.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_unknown_section_404(self, async_client: AsyncClient):
        r = await async_client.delete("/api/v1/library/sections/999999")
        assert r.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_section_ungroups_folders_without_deleting_them(
        self, async_client: AsyncClient, folder_factory
    ):
        f1 = await folder_factory(name="Widget A")
        f2 = await folder_factory(name="Widget B")
        section = (await async_client.post("/api/v1/library/sections", json={"name": "Production"})).json()
        await async_client.put(f"/api/v1/library/folders/{f1.id}/section", json={"section_id": section["id"]})
        await async_client.put(f"/api/v1/library/folders/{f2.id}/section", json={"section_id": section["id"]})

        r = await async_client.delete(f"/api/v1/library/sections/{section['id']}")
        assert r.status_code == 204

        # Section is gone from the catalog.
        names = [s["name"] for s in (await async_client.get("/api/v1/library/sections")).json()]
        assert "Production" not in names

        # Folders themselves survive and are now ungrouped (section_id is null).
        r = await async_client.get("/api/v1/library/folders")
        tree = r.json()
        by_id = {f["id"]: f for f in tree}
        assert by_id[f1.id]["section_id"] is None
        assert by_id[f2.id]["section_id"] is None


class TestFolderSectionAssignment:
    """PUT /library/folders/{id}/section — assign / clear a folder's section."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_assign_folder_to_section(self, async_client: AsyncClient, folder_factory):
        f = await folder_factory()
        section = (await async_client.post("/api/v1/library/sections", json={"name": "Production"})).json()

        r = await async_client.put(f"/api/v1/library/folders/{f.id}/section", json={"section_id": section["id"]})
        assert r.status_code == 200
        assert r.json()["section_id"] == section["id"]

        # folder_count on the section catalog reflects the assignment.
        sections = (await async_client.get("/api/v1/library/sections")).json()
        assert next(s["folder_count"] for s in sections if s["id"] == section["id"]) == 1

        # The folder tree endpoint also surfaces the section_id.
        tree = (await async_client.get("/api/v1/library/folders")).json()
        assert next(item["section_id"] for item in tree if item["id"] == f.id) == section["id"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_clear_folder_section_back_to_ungrouped(self, async_client: AsyncClient, folder_factory):
        f = await folder_factory()
        section = (await async_client.post("/api/v1/library/sections", json={"name": "Production"})).json()
        await async_client.put(f"/api/v1/library/folders/{f.id}/section", json={"section_id": section["id"]})

        r = await async_client.put(f"/api/v1/library/folders/{f.id}/section", json={"section_id": None})
        assert r.status_code == 200
        assert r.json()["section_id"] is None

        sections = (await async_client.get("/api/v1/library/sections")).json()
        assert next(s["folder_count"] for s in sections if s["id"] == section["id"]) == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_assign_to_unknown_section_404(self, async_client: AsyncClient, folder_factory):
        f = await folder_factory()
        r = await async_client.put(f"/api/v1/library/folders/{f.id}/section", json={"section_id": 999999})
        assert r.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_assign_unknown_folder_404(self, async_client: AsyncClient):
        section = (await async_client.post("/api/v1/library/sections", json={"name": "Production"})).json()
        r = await async_client.put("/api/v1/library/folders/999999/section", json={"section_id": section["id"]})
        assert r.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reassign_folder_moves_between_sections(self, async_client: AsyncClient, folder_factory):
        f = await folder_factory()
        prod = (await async_client.post("/api/v1/library/sections", json={"name": "Production"})).json()
        testing = (await async_client.post("/api/v1/library/sections", json={"name": "Testing"})).json()

        await async_client.put(f"/api/v1/library/folders/{f.id}/section", json={"section_id": prod["id"]})
        r = await async_client.put(f"/api/v1/library/folders/{f.id}/section", json={"section_id": testing["id"]})
        assert r.status_code == 200
        assert r.json()["section_id"] == testing["id"]

        sections = {s["id"]: s for s in (await async_client.get("/api/v1/library/sections")).json()}
        assert sections[prod["id"]]["folder_count"] == 0
        assert sections[testing["id"]]["folder_count"] == 1
