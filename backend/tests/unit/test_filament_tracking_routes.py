"""HTTP tests for /api/v1/filament-tracking/* (ASGI, no live server)."""

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.filament_tracking import FilamentColorUsage, FilamentSlotAssignment
from backend.app.services.filament_tracking import LIVE_USAGE_KIND


@pytest.mark.asyncio
async def test_filament_tracking_plan_events_assignments_buckets(async_client: AsyncClient, printer_factory, db_session):
    empty_plan = await async_client.get("/api/v1/filament-tracking/plan")
    assert empty_plan.status_code == 200
    assert empty_plan.json()["materials"] == []

    created = await async_client.post(
        "/api/v1/filament-tracking/buckets",
        json={
            "color_name": "EasyRock White",
            "material": "PLA",
            "color_hex": "#FFFFFF",
            "on_hand_grams": 10000,
            "spool_weight_grams": 1000,
        },
    )
    assert created.status_code == 200
    bucket = created.json()
    assert bucket["color_name"] == "EasyRock White"
    assert bucket["on_hand_grams"] == 10000

    listed = await async_client.get("/api/v1/filament-tracking/buckets")
    assert listed.status_code == 200
    assert any(row["id"] == bucket["id"] for row in listed.json())

    printer = await printer_factory()
    assigned = await async_client.post(
        "/api/v1/filament-tracking/assignments",
        json={"printer_id": printer.id, "ams_id": 0, "tray_id": 0, "bucket_id": bucket["id"]},
    )
    assert assigned.status_code == 200
    assert assigned.json()["color_name"] == "EasyRock White"

    assignments = await async_client.get(f"/api/v1/filament-tracking/assignments?printer_id={printer.id}")
    assert assignments.status_code == 200
    assert len(assignments.json()) == 1

    db_session.add(
        FilamentColorUsage(
            bucket_id=bucket["id"],
            grams=120,
            kind="completed",
            printer_id=printer.id,
            print_name="Benchy",
            source_key="test:route-event",
        )
    )
    await db_session.commit()

    events = await async_client.get("/api/v1/filament-tracking/events")
    assert events.status_code == 200
    assert any(row["grams"] == 120 and row["color_name"] == "EasyRock White" for row in events.json())

    consumption = await async_client.get("/api/v1/filament-tracking/printer-consumption")
    assert consumption.status_code == 200
    by_id = {row["printer_id"]: row["grams"] for row in consumption.json()}
    assert by_id[printer.id] == 120

    plan = await async_client.get("/api/v1/filament-tracking/plan")
    assert plan.status_code == 200
    assert plan.json()["total_on_hand_grams"] >= 0
    assert any(row["color_name"] == "EasyRock White" for row in plan.json()["materials"])


@pytest.mark.asyncio
async def test_printer_consumption_includes_live_printing_grams(async_client: AsyncClient, printer_factory, db_session):
    created = await async_client.post(
        "/api/v1/filament-tracking/buckets",
        json={"color_name": "Black", "material": "PLA", "color_hex": "#000000", "on_hand_grams": 10000},
    )
    assert created.status_code == 200
    bucket_id = created.json()["id"]
    trump = await printer_factory(name="Trump (4)")
    founders = await printer_factory(name="Founders (6)")
    db_session.add(
        FilamentColorUsage(
            bucket_id=bucket_id,
            grams=3.4,
            kind=LIVE_USAGE_KIND,
            progress=12,
            printer_id=trump.id,
            print_name="BTN-x47-.2mm-height-.53-width-1.0.0-X1C",
            source_key="test:live-trump-black",
        )
    )
    await db_session.commit()

    consumption = await async_client.get("/api/v1/filament-tracking/printer-consumption")
    assert consumption.status_code == 200
    by_id = {row["printer_id"]: row["grams"] for row in consumption.json()}
    assert by_id[trump.id] == pytest.approx(3.4)
    assert by_id[founders.id] == 0


@pytest.mark.asyncio
async def test_filament_tracking_live_rate_and_assignment_delete(async_client: AsyncClient, printer_factory, db_session):
    created = await async_client.post(
        "/api/v1/filament-tracking/buckets",
        json={"color_name": "Jade White", "material": "PLA", "color_hex": "FFFFFF", "on_hand_grams": 5000},
    )
    assert created.status_code == 200
    bucket_id = created.json()["id"]
    printer = await printer_factory()
    await async_client.post(
        "/api/v1/filament-tracking/assignments",
        json={"printer_id": printer.id, "ams_id": 0, "tray_id": 1, "bucket_id": bucket_id},
    )

    live = await async_client.get("/api/v1/filament-tracking/live-rate")
    assert live.status_code == 200
    body = live.json()
    assert body["active_jobs"] == 0
    assert body["products"] == []
    assert "grams_per_hour" in body

    deleted = await async_client.delete(f"/api/v1/filament-tracking/assignments/{printer.id}/0/1")
    assert deleted.status_code == 200
    remaining = (
        await db_session.execute(
            select(FilamentSlotAssignment).where(FilamentSlotAssignment.printer_id == printer.id)
        )
    ).scalars().all()
    assert remaining == []

    missing = await async_client.patch("/api/v1/filament-tracking/buckets/999999", json={"on_hand_grams": 1})
    assert missing.status_code == 404
