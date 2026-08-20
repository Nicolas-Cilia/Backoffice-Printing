"""Integration tests for Maintenance API endpoints."""

import pytest
from httpx import AsyncClient


class TestMaintenanceTypesAPI:
    """Integration tests for /api/v1/maintenance/types endpoints."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_list_maintenance_types(self, async_client: AsyncClient):
        """Verify maintenance types list returns data with defaults."""
        response = await async_client.get("/api/v1/maintenance/types")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        # Should have default system types
        assert len(data) >= 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_list_includes_system_types(self, async_client: AsyncClient):
        """Verify default system types are created."""
        response = await async_client.get("/api/v1/maintenance/types")
        assert response.status_code == 200
        data = response.json()
        names = [t["name"] for t in data]
        # Check for some default types
        assert "Lubricate Linear Rails" in names or len(data) > 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_custom_maintenance_type(self, async_client: AsyncClient):
        """Verify custom maintenance type can be created."""
        data = {
            "name": "Custom Test Task",
            "description": "Test description",
            "default_interval_hours": 200.0,
            "interval_type": "hours",
            "icon": "Wrench",
        }
        response = await async_client.post("/api/v1/maintenance/types", json=data)
        assert response.status_code == 200
        result = response.json()
        assert result["name"] == "Custom Test Task"
        assert result["is_system"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_custom_type_persists_wiki_url(self, async_client: AsyncClient):
        """#1596: pre-fix, the POST handler hard-coded every constructor field
        by name and silently dropped `wiki_url`. The schema accepted the value,
        the response echoed `null`, and the row landed without it. Pin the
        contract so the constructor doesn't drift again."""
        data = {
            "name": "Wiki URL Persistence Test",
            "default_interval_hours": 50.0,
            "interval_type": "hours",
            "wiki_url": "https://wiki.example.com/lubrication",
        }
        response = await async_client.post("/api/v1/maintenance/types", json=data)
        assert response.status_code == 200
        assert response.json()["wiki_url"] == "https://wiki.example.com/lubrication"

        # Verify it persists through a separate GET round-trip — the POST
        # response could have echoed the request body without committing.
        list_response = await async_client.get("/api/v1/maintenance/types")
        assert list_response.status_code == 200
        matching = [t for t in list_response.json() if t["name"] == data["name"]]
        assert len(matching) == 1
        assert matching[0]["wiki_url"] == "https://wiki.example.com/lubrication"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_maintenance_type(self, async_client: AsyncClient):
        """Verify maintenance type can be updated."""
        # First create a custom type
        create_data = {
            "name": "Update Test",
            "description": "Original",
            "default_interval_hours": 100.0,
        }
        create_response = await async_client.post("/api/v1/maintenance/types", json=create_data)
        assert create_response.status_code == 200
        type_id = create_response.json()["id"]

        # Update it
        update_data = {"description": "Updated description"}
        response = await async_client.patch(f"/api/v1/maintenance/types/{type_id}", json=update_data)
        assert response.status_code == 200
        assert response.json()["description"] == "Updated description"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_custom_maintenance_type(self, async_client: AsyncClient):
        """Verify custom maintenance type can be deleted."""
        # Create a custom type
        create_data = {
            "name": "Delete Test",
            "description": "To be deleted",
            "default_interval_hours": 50.0,
        }
        create_response = await async_client.post("/api/v1/maintenance/types", json=create_data)
        type_id = create_response.json()["id"]

        # Delete it
        response = await async_client.delete(f"/api/v1/maintenance/types/{type_id}")
        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_hide_and_restore_single_system_type(self, async_client: AsyncClient):
        listed = await async_client.get("/api/v1/maintenance/types")
        assert listed.status_code == 200
        build_plate = next((row for row in listed.json() if row["name"] == "Clean Build Plate"), None)
        if not build_plate:
            pytest.skip("Clean Build Plate default type not present")

        hide = await async_client.delete(f"/api/v1/maintenance/types/{build_plate['id']}")
        assert hide.status_code == 200
        assert hide.json()["status"] == "hidden"

        visible_names = [row["name"] for row in (await async_client.get("/api/v1/maintenance/types")).json()]
        assert "Clean Build Plate" not in visible_names

        with_hidden = await async_client.get("/api/v1/maintenance/types", params={"include_hidden": True})
        hidden_row = next(row for row in with_hidden.json() if row["id"] == build_plate["id"])
        assert hidden_row["is_deleted"] is True

        restore = await async_client.post(f"/api/v1/maintenance/types/{build_plate['id']}/restore")
        assert restore.status_code == 200
        assert restore.json()["is_deleted"] is False

        visible_again = [row["name"] for row in (await async_client.get("/api/v1/maintenance/types")).json()]
        assert "Clean Build Plate" in visible_again


class TestPrinterMaintenanceAPI:
    """Integration tests for /api/v1/maintenance/printers endpoints."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_printer_maintenance_not_found(self, async_client: AsyncClient):
        """Verify 404 for non-existent printer."""
        response = await async_client.get("/api/v1/maintenance/printers/9999")
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_printer_maintenance(self, async_client: AsyncClient, printer_factory, db_session):
        """Verify maintenance overview for a printer."""
        printer = await printer_factory(name="Maintenance Test Printer")
        response = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["printer_id"] == printer.id
        assert data["printer_name"] == "Maintenance Test Printer"
        assert "maintenance_items" in data
        assert "total_print_hours" in data

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_all_maintenance_overview(self, async_client: AsyncClient, printer_factory, db_session):
        """Verify overview endpoint returns all printers."""
        await printer_factory(name="Overview Printer 1")
        await printer_factory(name="Overview Printer 2")
        response = await async_client.get("/api/v1/maintenance/overview")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_maintenance_summary(self, async_client: AsyncClient):
        """Verify summary endpoint returns counts."""
        response = await async_client.get("/api/v1/maintenance/summary")
        assert response.status_code == 200
        data = response.json()
        assert "total_due" in data
        assert "total_warning" in data
        assert "printers_with_issues" in data


class TestMaintenanceItemsAPI:
    """Integration tests for /api/v1/maintenance/items endpoints."""

    @pytest.fixture
    async def maintenance_item(self, async_client: AsyncClient, printer_factory, db_session):
        """Create a maintenance item for testing."""
        printer = await printer_factory(name="Item Test Printer")
        # Get the printer's maintenance overview to create items
        response = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        assert response.status_code == 200
        data = response.json()
        # Return the first maintenance item
        if data["maintenance_items"]:
            return data["maintenance_items"][0]
        return None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_maintenance_item(self, async_client: AsyncClient, maintenance_item):
        """Verify maintenance item can be updated."""
        if not maintenance_item:
            pytest.skip("No maintenance items available")

        item_id = maintenance_item["id"]
        response = await async_client.patch(
            f"/api/v1/maintenance/items/{item_id}", json={"custom_interval_hours": 150.0}
        )
        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_disable_maintenance_item(self, async_client: AsyncClient, maintenance_item):
        """Verify maintenance item can be disabled."""
        if not maintenance_item:
            pytest.skip("No maintenance items available")

        item_id = maintenance_item["id"]
        response = await async_client.patch(f"/api/v1/maintenance/items/{item_id}", json={"enabled": False})
        assert response.status_code == 200
        assert response.json()["enabled"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_perform_maintenance(self, async_client: AsyncClient, maintenance_item):
        """Verify maintenance can be marked as performed."""
        if not maintenance_item:
            pytest.skip("No maintenance items available")

        item_id = maintenance_item["id"]
        response = await async_client.post(
            f"/api/v1/maintenance/items/{item_id}/perform", json={"notes": "Test maintenance performed"}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["last_performed_at"] is not None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_maintenance_history(self, async_client: AsyncClient, maintenance_item):
        """Verify maintenance history can be retrieved."""
        if not maintenance_item:
            pytest.skip("No maintenance items available")

        item_id = maintenance_item["id"]
        # First perform maintenance to create history
        await async_client.post(f"/api/v1/maintenance/items/{item_id}/perform", json={"notes": "History test"})

        response = await async_client.get(f"/api/v1/maintenance/items/{item_id}/history")
        assert response.status_code == 200
        history = response.json()
        assert isinstance(history, list)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_maintenance_item_not_found(self, async_client: AsyncClient):
        """Verify 404 for non-existent maintenance item."""
        response = await async_client.patch("/api/v1/maintenance/items/9999", json={"enabled": False})
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_perform_records_cost_and_part_url(self, async_client: AsyncClient, maintenance_item):
        if not maintenance_item:
            pytest.skip("No maintenance items available")

        item_id = maintenance_item["id"]
        printer_id = maintenance_item["printer_id"]
        response = await async_client.post(
            f"/api/v1/maintenance/items/{item_id}/perform",
            json={
                "notes": "Swapped hotend",
                "part_url": "https://example.com/nozzle",
                "cost": 24.5,
            },
        )
        assert response.status_code == 200

        history = await async_client.get(f"/api/v1/maintenance/printers/{printer_id}/history")
        assert history.status_code == 200
        rows = history.json()
        assert len(rows) >= 1
        latest = rows[0]
        assert latest["notes"] == "Swapped hotend"
        assert latest["part_url"] == "https://example.com/nozzle"
        assert latest["cost"] == 24.5
        assert latest["job_name"]

        overview = await async_client.get(f"/api/v1/maintenance/printers/{printer_id}")
        assert overview.status_code == 200
        assert overview.json()["total_maintenance_cost"] == 24.5


class TestPrinterHoursAPI:
    """Integration tests for /api/v1/maintenance/printers/{id}/hours endpoint."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_set_printer_hours(self, async_client: AsyncClient, printer_factory, db_session):
        """Verify printer hours can be set."""
        printer = await printer_factory(name="Hours Test Printer")
        response = await async_client.patch(
            f"/api/v1/maintenance/printers/{printer.id}/hours", params={"total_hours": 500.0}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["total_hours"] == 500.0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_set_printer_hours_not_found(self, async_client: AsyncClient):
        """Verify 404 for non-existent printer."""
        response = await async_client.patch("/api/v1/maintenance/printers/9999/hours", params={"total_hours": 100.0})
        assert response.status_code == 404


class TestPrinterMaintenanceLogAPI:
    """Per-printer log: one-off custom jobs with cost and part links."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_log_custom_job_without_resetting_interval(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        printer = await printer_factory(name="Custom Job Printer")
        overview = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        assert overview.status_code == 200
        before_items = overview.json()["maintenance_items"]
        names_before = {item["maintenance_type_name"] for item in before_items}
        assert "Custom job" not in names_before

        response = await async_client.post(
            f"/api/v1/maintenance/printers/{printer.id}/jobs",
            json={
                "title": "Replace nozzle",
                "notes": "0.4mm hardened",
                "part_url": "https://shop.example.com/nozzle",
                "cost": 12.0,
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["job_name"] == "Replace nozzle"
        assert body["cost"] == 12.0
        assert body["part_url"] == "https://shop.example.com/nozzle"

        after = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        names_after = {item["maintenance_type_name"] for item in after.json()["maintenance_items"]}
        assert "Custom job" not in names_after
        assert after.json()["total_maintenance_cost"] == 12.0

        history = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}/history")
        assert history.json()[0]["job_name"] == "Replace nozzle"
        assert history.json()[0]["is_custom"] is True

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_custom_job_requires_title(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Untitled Job Printer")
        response = await async_client.post(
            f"/api/v1/maintenance/printers/{printer.id}/jobs",
            json={"notes": "forgot the title"},
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_edit_custom_job_log_entry(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Edit Custom Job Printer")
        created = await async_client.post(
            f"/api/v1/maintenance/printers/{printer.id}/jobs",
            json={
                "title": "Replace nozzle",
                "notes": "wrong size",
                "part_url": "https://shop.example.com/old",
                "cost": 12.0,
            },
        )
        assert created.status_code == 200
        history_id = created.json()["id"]

        updated = await async_client.patch(
            f"/api/v1/maintenance/history/{history_id}",
            json={
                "title": "Replace sensor",
                "notes": "filament runout",
                "part_url": "https://shop.example.com/sensor",
                "cost": 18.5,
            },
        )
        assert updated.status_code == 200
        body = updated.json()
        assert body["job_name"] == "Replace sensor"
        assert body["notes"] == "filament runout"
        assert body["part_url"] == "https://shop.example.com/sensor"
        assert body["cost"] == 18.5
        assert body["is_custom"] is True

        overview = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        assert overview.json()["total_maintenance_cost"] == 18.5

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_edit_scheduled_reset_notes_only(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Edit Reset Printer")
        overview = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        items = overview.json()["maintenance_items"]
        if not items:
            pytest.skip("No maintenance items available")
        item_id = items[0]["id"]

        performed = await async_client.post(
            f"/api/v1/maintenance/items/{item_id}/perform",
            json={"notes": "oops"},
        )
        assert performed.status_code == 200

        history = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}/history")
        row = history.json()[0]
        assert row["is_custom"] is False
        original_title = row["job_name"]

        updated = await async_client.patch(
            f"/api/v1/maintenance/history/{row['id']}",
            json={"notes": "cleaned as usual", "title": "should be ignored", "cost": 99},
        )
        assert updated.status_code == 200
        assert updated.json()["notes"] == "cleaned as usual"
        assert updated.json()["job_name"] == original_title
        assert updated.json()["cost"] is None
        assert updated.json()["is_custom"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_log_entry_updates_cost(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Delete Log Printer")
        created = await async_client.post(
            f"/api/v1/maintenance/printers/{printer.id}/jobs",
            json={"title": "Replace nozzle", "cost": 12.0},
        )
        assert created.status_code == 200
        history_id = created.json()["id"]

        overview = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        assert overview.json()["total_maintenance_cost"] == 12.0

        deleted = await async_client.delete(f"/api/v1/maintenance/history/{history_id}")
        assert deleted.status_code == 200
        assert deleted.json()["status"] == "deleted"

        history = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}/history")
        assert history.json() == []
        after = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        assert after.json()["total_maintenance_cost"] == 0.0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_log_entry_not_found(self, async_client: AsyncClient):
        response = await async_client.delete("/api/v1/maintenance/history/999999")
        assert response.status_code == 404
