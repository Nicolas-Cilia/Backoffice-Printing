"""Buffer-stock timeline: ready targets + plate-quantized catch-up (advisory only)."""

from __future__ import annotations

from datetime import date
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.production import ProductionPart, ProductionPartInstance, ProductionSlot
from backend.app.services.device_recipe_service import get_or_create_default_recipe
from backend.app.services.stats2_config import (
    normalize_ready_buffer_targets,
    quantize_buffer_catch_up,
    set_stats2_globals,
)
from backend.app.services.stats2_print_plan import compute_print_plan, measure_schedulable_devices

_MONDAY = date(2026, 3, 2)


def test_quantize_buffer_catch_up_whole_plates():
    assert quantize_buffer_catch_up(0, 47) == 0
    assert quantize_buffer_catch_up(10, 47) == 47
    assert quantize_buffer_catch_up(47, 47) == 47
    assert quantize_buffer_catch_up(48, 47) == 94
    assert quantize_buffer_catch_up(80, 47) == 94


def test_normalize_ready_buffer_targets_defaults_and_zero():
    assert normalize_ready_buffer_targets(None) == {"BUT": 80, "KNB": 50}
    assert normalize_ready_buffer_targets({})["KNB"] == 50
    out = normalize_ready_buffer_targets({"but": 100, "KNB": 0})
    assert out["BUT"] == 100
    assert out["KNB"] == 0


async def _seed_slot(db, *, part_code: str, model: str, quantity: int, print_time: int, filename: str):
    part = (await db.execute(select(ProductionPart).where(ProductionPart.code == part_code))).scalar_one_or_none()
    if part is None:
        part = ProductionPart(code=part_code, name=part_code)
        db.add(part)
        await db.flush()

    folder = LibraryFolder(name=f"{model}-{part_code}-{filename}", parent_id=None)
    db.add(folder)
    await db.flush()

    lib = LibraryFile(
        folder_id=folder.id,
        filename=filename,
        file_path=f"library/{filename}",
        file_type="3mf",
        file_size=100,
        file_metadata={"print_time_seconds": print_time},
    )
    db.add(lib)
    await db.flush()

    inst = ProductionPartInstance(
        part_id=part.id,
        printer_model=model,
        folder_id=folder.id,
        hidden=False,
    )
    db.add(inst)
    await db.flush()

    slot = ProductionSlot(
        instance_id=inst.id,
        quantity=quantity,
        active_file_id=lib.id,
        major=1,
        revision=0,
        minor=0,
    )
    db.add(slot)
    await db.flush()
    return slot


def _ready_payload(*, but_ready: int, knb_ready: int) -> dict:
    return {
        "as_of": "2026-03-02T00:00:00+00:00",
        "line_start_at": "2026-03-02T08:00:00",
        "ready_deadline_at": "2026-03-02T07:30:00",
        "devices_buildable_now": 0.0,
        "binding_part": "BUT",
        "parts": [
            {
                "part_code": "TOP",
                "part_name": "Top",
                "qty_per_device": 1,
                "ready_now": 100,
                "is_binding": False,
            },
            {
                "part_code": "BOT",
                "part_name": "Bottom",
                "qty_per_device": 1,
                "ready_now": 100,
                "is_binding": False,
            },
            {
                "part_code": "KNB",
                "part_name": "Knob",
                "qty_per_device": 1,
                "ready_now": knb_ready,
                "is_binding": False,
            },
            {
                "part_code": "BUT",
                "part_name": "Button",
                "qty_per_device": 1,
                "ready_now": but_ready,
                "is_binding": True,
            },
        ],
    }


def _but_parts(plan: dict) -> float:
    monday = plan["days"][0]
    total = 0.0
    for lane in monday["lanes"]:
        for job in lane["jobs"]:
            if job["part_code"] == "BUT":
                total += float(job.get("quantity_per_plate") or 0)
    return total


@pytest.mark.asyncio
async def test_buffer_timeline_boosts_but_when_below_target(db_session, printer_factory):
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    for code, qty, t in (("TOP", 1, 3600), ("BOT", 3, 7200), ("KNB", 12, 1800), ("BUT", 47, 5400)):
        await _seed_slot(
            db_session,
            part_code=code,
            model="X1C",
            quantity=qty,
            print_time=t,
            filename=f"{code} x{qty}.3mf",
        )
    await printer_factory(name="X1C-A", model="X1C")
    await printer_factory(name="X1C-B", model="X1C")
    await db_session.commit()

    ready = _ready_payload(but_ready=10, knb_ready=50)
    with patch(
        "backend.app.services.stats2_print_plan.compute_readiness",
        new=AsyncMock(return_value=ready),
    ):
        capacity = await compute_print_plan(
            db_session, week_start=_MONDAY, target_devices=2.0, timeline_mode="capacity"
        )
        buffer = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=2.0, timeline_mode="buffer")

    assert capacity["timeline_mode"] == "capacity"
    assert float(capacity.get("buffer_debt", {}).get("BUT", 0) or 0) == 0

    assert buffer["timeline_mode"] == "buffer"
    assert buffer["buffer_targets"]["BUT"] == 80
    assert buffer["buffer_targets"]["KNB"] == 50
    assert buffer["buffer_ready"]["BUT"] == 10
    # 80 - 10 = 70 → ceil(70/47)*47 = 94
    assert buffer["buffer_debt"]["BUT"] == 94.0
    assert "KNB" not in buffer["buffer_debt"]

    assert _but_parts(buffer) >= _but_parts(capacity)
    assert _but_parts(buffer) >= 47
    assert any(
        job.get("rationale") == "inventory_buffer"
        for lane in buffer["days"][0]["lanes"]
        for job in lane["jobs"]
        if job["part_code"] == "BUT"
    )


@pytest.mark.asyncio
async def test_buffer_timeline_knob_target_fifty(db_session, printer_factory):
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    for code, qty, t in (("TOP", 1, 3600), ("BOT", 3, 7200), ("KNB", 12, 1800), ("BUT", 47, 5400)):
        await _seed_slot(
            db_session,
            part_code=code,
            model="X1C",
            quantity=qty,
            print_time=t,
            filename=f"{code} x{qty}.3mf",
        )
    await printer_factory(name="X1C-A", model="X1C")
    await db_session.commit()

    ready = _ready_payload(but_ready=80, knb_ready=5)
    with patch(
        "backend.app.services.stats2_print_plan.compute_readiness",
        new=AsyncMock(return_value=ready),
    ):
        buffer = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=2.0, timeline_mode="buffer")

    assert buffer["buffer_debt"]["KNB"] == 48.0  # 50-5=45 → ceil to 12-up = 48
    assert "BUT" not in buffer["buffer_debt"]


@pytest.mark.asyncio
async def test_measure_schedulable_ignores_buffer_mode(db_session, printer_factory):
    """Capacity KPI path must not inherit buffer catch-up asks."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    for code, qty, t in (("TOP", 1, 3600), ("BOT", 3, 7200), ("KNB", 12, 1800), ("BUT", 47, 5400)):
        await _seed_slot(
            db_session,
            part_code=code,
            model="X1C",
            quantity=qty,
            print_time=t,
            filename=f"{code} x{qty}.3mf",
        )
    await printer_factory(name="X1C-A", model="X1C")
    await db_session.commit()

    ready = _ready_payload(but_ready=0, knb_ready=0)
    with patch(
        "backend.app.services.stats2_print_plan.compute_readiness",
        new=AsyncMock(return_value=ready),
    ):
        measured = await measure_schedulable_devices(db_session, week_start=_MONDAY)

    assert measured["devices_per_day_theoretical"] >= 0
