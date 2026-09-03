"""Unit tests for Stats 2 Phase 3a: capacity math, readiness, build plan."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import select

from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent
from backend.app.models.floor_unit import FloorProductUnit
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.production import ProductionPart, ProductionPartInstance, ProductionSlot
from backend.app.services.capacity_analysis import (
    compute_build_plan,
    compute_capacity,
    compute_capacity_history,
    compute_component,
    compute_overview,
    cycle_seconds,
    effective_parts_per_plate,
    plates_per_printer_per_day,
)
from backend.app.services.device_recipe_service import get_or_create_default_recipe, get_recipe_view
from backend.app.services.stats2_config import set_stats2_globals
from backend.app.services.stats2_print_plan import compute_print_plan
from backend.app.services.stats2_readiness import compute_readiness
from backend.app.services.stats2_slot_metrics import SlotMetrics


class TestCapacityMath:
    def test_cycle_includes_clear(self):
        assert cycle_seconds(3600, 15) == 3600 + 15 * 60

    def test_plates_per_day_theo(self):
        # 9h staffed, 1h15 cycle → 7.2 plates
        staffed = 9 * 3600
        cycle = cycle_seconds(3600, 15)
        assert abs(plates_per_printer_per_day(staffed, cycle, 1.0) - 7.2) < 1e-6

    def test_plates_apply_job_success(self):
        staffed = 9 * 3600
        cycle = cycle_seconds(3600, 15)
        assert abs(plates_per_printer_per_day(staffed, cycle, 0.5) - 3.6) < 1e-6

    def test_effective_parts_multi_up(self):
        # 47 expected → 41 effective at ~0.96 * 0.91 ≈ wait: 47 * 0.9 * 0.9 = 38.07
        assert abs(effective_parts_per_plate(47, 0.9, 0.9) - 38.07) < 1e-6

    def test_component_binding_uses_min(self):
        metrics = SlotMetrics(1, 1.0, 1.0, 1.0, 0, 0, True)
        top = compute_component(
            line={"part_code": "TOP", "part_name": "Top", "qty_per_device": 1},
            slot={
                "slot_id": 1,
                "printer_model": "X1C",
                "quantity": 1,
                "print_time_seconds": 3600,
                "filename": "TOP x1.3mf",
            },
            staffed_seconds=9 * 3600,
            clear_minutes=15,
            fleet={"X1C": 2},
            metrics=metrics,
        )
        but = compute_component(
            line={"part_code": "BUT", "part_name": "Button", "qty_per_device": 1},
            slot={
                "slot_id": 2,
                "printer_model": "X1C",
                "quantity": 47,
                "print_time_seconds": 7200,
                "filename": "BUT x47.3mf",
            },
            staffed_seconds=9 * 3600,
            clear_minutes=15,
            fleet={"X1C": 1},
            metrics=metrics,
        )
        assert top.devices_from_component > 0
        assert but.devices_from_component > 0
        # BUT has fewer printers and longer cycle → typically lower
        assert but.devices_from_component != top.devices_from_component


async def _seed_slot(db, *, part_code: str, model: str, quantity: int, print_time: int, filename: str):
    part = (await db.execute(select(ProductionPart).where(ProductionPart.code == part_code))).scalar_one_or_none()
    if part is None:
        part = ProductionPart(code=part_code, name=part_code)
        db.add(part)
        await db.flush()

    folder = LibraryFolder(name=f"{model}-{part_code}", parent_id=None)
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


@pytest.mark.asyncio
async def test_capacity_with_stub_schedule_and_fleet(db_session, printer_factory):
    await set_stats2_globals(db_session, expected_plate_clear_minutes=15)
    await get_or_create_default_recipe(db_session)

    await _seed_slot(
        db_session, part_code="TOP", model="X1C", quantity=1, print_time=3600, filename="TOP x1 - 1.0.0 - X1C.3mf"
    )
    await _seed_slot(
        db_session, part_code="BOT", model="X1C", quantity=3, print_time=7200, filename="BOT x3 - 1.0.0 - X1C.3mf"
    )
    await _seed_slot(
        db_session, part_code="KNB", model="X1C", quantity=12, print_time=1800, filename="KNB x12 - 1.0.0 - X1C.3mf"
    )
    await _seed_slot(
        db_session, part_code="BUT", model="X1C", quantity=47, print_time=5400, filename="BUT x47 - 1.0.0 - X1C.3mf"
    )

    await printer_factory(name="X1C-01", model="X1C")
    await printer_factory(name="X1C-02", model="X1C")
    await db_session.commit()

    cap = await compute_capacity(db_session, on_date=date(2026, 3, 2))  # Monday
    assert cap["using_default_schedule_stub"] is True
    assert cap["staffed_minutes"] == 540  # Mon–Fri stub average
    assert cap["expected_plate_clear_minutes"] == 15
    assert cap["fleet_by_model"].get("X1C") == 2
    assert cap["devices_per_day_theoretical"] > 0
    assert cap["devices_per_day_realistic"] > 0
    # Defaults (no history) → theo ≈ realistic
    assert abs(cap["devices_per_day_theoretical"] - cap["devices_per_day_realistic"]) < 1e-6
    assert cap["binding_part"] in {"TOP", "BOT", "KNB", "BUT"}
    assert len(cap["components"]) == 4
    assert all(not c["incomplete"] for c in cap["components"])


@pytest.mark.asyncio
async def test_capacity_incomplete_without_slots(db_session):
    await get_or_create_default_recipe(db_session)
    await db_session.commit()
    cap = await compute_capacity(db_session)
    assert cap["devices_per_day_realistic"] == 0
    assert all(c["incomplete"] for c in cap["components"])


@pytest.mark.asyncio
async def test_readiness_ready_now_excludes_linked_and_rework(db_session, printer_factory):
    from backend.app.models.floor_bin import FloorBinBatch, FloorBinBatchEvent

    await get_or_create_default_recipe(db_session)
    printer = await printer_factory(model="X1C")

    async def add_part(code: str, sticker: str, status: str):
        part = FloorLabeledPart(
            sticker_code=sticker,
            printer_id=printer.id,
            part_code=code,
        )
        db_session.add(part)
        await db_session.flush()
        db_session.add(FloorPartEvent(part_id=part.id, action=status))
        await db_session.flush()

    # TOP: 2 staged + 1 wip + 1 linked + 1 rework + 1 fit_checked
    await add_part("TOP", "BBD-T1", "ready_for_production")
    await add_part("TOP", "BBD-T2", "ready_for_production")
    await add_part("TOP", "BBD-T3", "wip")
    await add_part("TOP", "BBD-T4", "linked")
    await add_part("TOP", "BBD-T5", "rework")
    await add_part("TOP", "BBD-T6", "fit_checked")
    # BOT low: 1 staged only
    await add_part("BOT", "BBD-B1", "ready_for_production")

    # Plenty of KNB/BUT so BOT stays binding
    for payload, code, qty in (("BBN-KNB-1", "KNB", 50), ("BBN-BUT-1", "BUT", 50)):
        batch = FloorBinBatch(bin_payload=payload, part_code=code, quantity=qty, printer_id=printer.id)
        db_session.add(batch)
        await db_session.flush()
        db_session.add(FloorBinBatchEvent(batch_id=batch.id, action="ready_for_production"))

    await db_session.commit()

    ready = await compute_readiness(db_session)
    by_code = {p["part_code"]: p for p in ready["parts"]}
    assert by_code["TOP"]["ready_now"] == 3  # 2 staged + 1 wip
    assert by_code["TOP"]["upstream"] == 1
    assert by_code["TOP"]["rework_sanding"] == 1
    assert by_code["TOP"]["linked"] == 1
    assert by_code["BOT"]["ready_now"] == 1
    assert by_code["KNB"]["ready_now"] == 50
    assert by_code["BUT"]["ready_now"] == 50
    assert ready["devices_buildable_now"] == 1.0
    assert ready["binding_part"] == "BOT"


@pytest.mark.asyncio
async def test_build_plan_and_overview(db_session, printer_factory):
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    await _seed_slot(db_session, part_code="TOP", model="X1C", quantity=1, print_time=3600, filename="TOP x1.3mf")
    await _seed_slot(db_session, part_code="BOT", model="X1C", quantity=5, print_time=9000, filename="BOT x5.3mf")
    await _seed_slot(db_session, part_code="KNB", model="X1C", quantity=12, print_time=1800, filename="KNB x12.3mf")
    await _seed_slot(db_session, part_code="BUT", model="X1C", quantity=47, print_time=5400, filename="BUT x47.3mf")
    await printer_factory(model="X1C")
    await db_session.commit()

    plan = await compute_build_plan(db_session)
    assert len(plan["rows"]) == 4
    assert any(r["is_binding"] for r in plan["rows"])
    assert plan["devices_per_day_realistic"] > 0

    overview = await compute_overview(db_session)
    assert "capacity" in overview
    assert "readiness" in overview
    assert overview["capacity"]["devices_per_day_realistic"] == plan["devices_per_day_realistic"]


@pytest.mark.asyncio
async def test_print_plan_packs_lanes(db_session, printer_factory):
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

    plan = await compute_print_plan(db_session, week_start=date(2026, 3, 2), target_devices=2.0)
    assert plan["week_start"] == "2026-03-02"
    assert plan["target_devices"] == 2.0
    assert len(plan["days"]) == 7
    monday = plan["days"][0]
    assert monday["date"] == "2026-03-02"
    assert len(monday["lanes"]) == 2
    total_jobs = sum(len(ln["jobs"]) for ln in monday["lanes"])
    assert total_jobs > 0
    job = monday["lanes"][0]["jobs"][0]
    assert "start_at" in job and "end_at" in job and "part_code" in job


@pytest.mark.asyncio
async def test_recipe_view_sees_seeded_slots(db_session):
    await get_or_create_default_recipe(db_session)
    await _seed_slot(db_session, part_code="BOT", model="H2S", quantity=5, print_time=8000, filename="BOT x5.3mf")
    await db_session.commit()
    view = await get_recipe_view(db_session)
    bot = next(ln for ln in view["lines"] if ln["part_code"] == "BOT")
    assert bot["recommended_slot_id"] is not None
    assert any(s["quantity"] == 5 for s in bot["discovered_slots"])


@pytest.mark.asyncio
async def test_capacity_history_includes_devices_shipped(db_session, printer_factory):
    printer = await printer_factory(model="X1C")
    end = date(2026, 3, 6)  # Friday
    ship_at = datetime(2026, 3, 4, 14, 0)  # Wednesday

    async def add_shipped(sticker: str, code: str, when: datetime, *, extra_ship: bool = False):
        part = FloorLabeledPart(
            sticker_code=sticker,
            printer_id=printer.id,
            part_code=code,
            labeled_at=when,
        )
        db_session.add(part)
        await db_session.flush()
        db_session.add(FloorPartEvent(part_id=part.id, action="shipped", occurred_at=when))
        if extra_ship:
            db_session.add(FloorPartEvent(part_id=part.id, action="shipped", occurred_at=when + timedelta(hours=1)))

    await add_shipped("BBD-T1", "TOP", ship_at)
    await add_shipped("BBD-T2", "TOP", ship_at)
    await add_shipped("BBD-T3", "TOP", ship_at, extra_ship=True)  # re-ship same day counts
    await add_shipped("BBD-B1", "BOT", ship_at)  # not a device
    await add_shipped("BBD-T4", "TOP", datetime(2026, 3, 2, 11, 0))  # Monday
    archived = FloorLabeledPart(
        sticker_code="BBD-T-ARCH",
        printer_id=printer.id,
        part_code="TOP",
        labeled_at=ship_at,
        archived_at=ship_at,
    )
    db_session.add(archived)
    await db_session.flush()
    db_session.add(FloorPartEvent(part_id=archived.id, action="shipped", occurred_at=ship_at))
    await db_session.commit()

    history = await compute_capacity_history(db_session, days=5, end_date=end)
    by_date = {p["date"]: p for p in history["points"]}
    assert history["days"] == 5
    assert by_date["2026-03-04"]["devices_shipped"] == 4  # 3 TOPs + 1 re-ship; BOT/archived ignored
    assert by_date["2026-03-02"]["devices_shipped"] == 1
    assert by_date["2026-03-03"]["devices_shipped"] == 0
    assert by_date["2026-03-05"]["devices_shipped"] == 0
    assert by_date["2026-03-06"]["devices_shipped"] == 0


@pytest.mark.asyncio
async def test_capacity_history_counts_linked_units_without_shipped_event(db_session, printer_factory):
    """Assembled serials still count when housings never got a shipped event."""
    printer = await printer_factory(model="X1C")
    end = date(2026, 3, 6)
    when = datetime(2026, 3, 4, 14, 0)
    top = FloorLabeledPart(sticker_code="BBD-U-T", printer_id=printer.id, part_code="TOP", labeled_at=when)
    bot = FloorLabeledPart(sticker_code="BBD-U-B", printer_id=printer.id, part_code="BOT", labeled_at=when)
    db_session.add_all([top, bot])
    await db_session.flush()
    db_session.add(FloorProductUnit(serial_code="XG2SN1", top_part_id=top.id, bottom_part_id=bot.id, linked_at=when))
    await db_session.commit()

    history = await compute_capacity_history(db_session, days=5, end_date=end)
    by_date = {p["date"]: p for p in history["points"]}
    assert by_date["2026-03-04"]["devices_shipped"] == 1
    assert by_date["2026-03-05"]["devices_shipped"] == 0


@pytest.mark.asyncio
async def test_capacity_history_shipped_counts_units_without_double_counting(db_session, printer_factory):
    """Assembled serials count as shipped even without a TOP event; unit+TOP is max, not sum."""
    printer = await printer_factory(model="X1C")
    end = date(2026, 3, 6)
    when = datetime(2026, 3, 4, 14, 0)

    top = FloorLabeledPart(sticker_code="BBD-U-TOP", printer_id=printer.id, part_code="TOP", labeled_at=when)
    bot = FloorLabeledPart(sticker_code="BBD-U-BOT", printer_id=printer.id, part_code="BOT", labeled_at=when)
    db_session.add_all([top, bot])
    await db_session.flush()
    db_session.add(FloorProductUnit(serial_code="XG2SN1", top_part_id=top.id, bottom_part_id=bot.id, linked_at=when))
    # Same device also has a TOP shipped event — must not become 2.
    db_session.add(FloorPartEvent(part_id=top.id, action="shipped", occurred_at=when))

    top2 = FloorLabeledPart(sticker_code="BBD-U-TOP2", printer_id=printer.id, part_code="BOT", labeled_at=when)
    bot2 = FloorLabeledPart(sticker_code="BBD-U-BOT2", printer_id=printer.id, part_code="BOT", labeled_at=when)
    db_session.add_all([top2, bot2])
    await db_session.flush()
    db_session.add(FloorProductUnit(serial_code="XG2SN2", top_part_id=top2.id, bottom_part_id=bot2.id, linked_at=when))
    await db_session.commit()

    history = await compute_capacity_history(db_session, days=5, end_date=end)
    by_date = {p["date"]: p for p in history["points"]}
    # Unit XG2SN1: max(1 TOP ship, 1 unit) = 1; unit XG2SN2: unit-only = 1.
    assert by_date["2026-03-04"]["devices_shipped"] == 2
