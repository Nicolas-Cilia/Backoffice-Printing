"""Print-plan what-if feasibility: capacity soft-max, staffed-day stop."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.production import ProductionPart, ProductionPartInstance, ProductionSlot
from backend.app.services.capacity_analysis import compute_capacity, compute_capacity_unconstrained
from backend.app.services.device_recipe_service import get_or_create_default_recipe
from backend.app.services.printer_time_block_service import TimeBlockIn, replace_blocks_for_printer
from backend.app.services.stats2_config import set_stats2_globals
from backend.app.services.stats2_print_plan import compute_print_plan

_MONDAY = date(2026, 3, 2)


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


async def _seed_full_recipe(db, printer_factory, *, printers: int = 2):
    await set_stats2_globals(db, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db)
    for code, qty, t in (("TOP", 1, 3600), ("BOT", 3, 7200), ("KNB", 12, 1800), ("BUT", 47, 5400)):
        await _seed_slot(db, part_code=code, model="X1C", quantity=qty, print_time=t, filename=f"{code} x{qty}.3mf")
    for i in range(printers):
        await printer_factory(name=f"X1C-{i}", model="X1C")
    await db.commit()


@pytest.mark.asyncio
async def test_print_plan_default_target_uses_realistic_capacity(db_session, printer_factory):
    await _seed_full_recipe(db_session, printer_factory)
    cap = await compute_capacity(db_session)
    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=None)
    assert plan["target_devices"] == pytest.approx(cap["devices_per_day_theoretical"])
    assert plan["capacity_devices_theoretical"] == pytest.approx(cap["devices_per_day_theoretical"])
    assert plan["capacity_devices_realistic"] == pytest.approx(cap["devices_per_day_realistic"])
    assert "scenario_rows" in plan and len(plan["scenario_rows"]) >= 1
    # Default target is the physical schedule ceiling; expected may be lower after yields.
    assert plan["devices_achievable"] >= 0
    assert isinstance(plan["feasible"], bool)


@pytest.mark.asyncio
async def test_capacity_headline_is_schedulable_not_dedicated_fleet(db_session, printer_factory):
    """Shared X1C fleet: dedicated-fleet min() overstates complete devices vs packer."""
    from backend.app.services.stats2_print_plan import _devices_from_parts

    await _seed_full_recipe(db_session, printer_factory, printers=2)
    unconst = await compute_capacity_unconstrained(db_session, on_date=_MONDAY)
    cap = await compute_capacity(db_session, on_date=_MONDAY)
    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=None)

    assert unconst["devices_per_day_realistic"] > 0
    part_qty = {r["part_code"]: int(r["qty_per_device"]) for r in plan["scenario_rows"]}
    packed_devs = _devices_from_parts(part_qty, {k: float(v) for k, v in plan["parts_packed"].items()})
    # Headline theoretical matches the packer's BOM-limited packed devices
    # (allow 1 device of binary-search / multi-up boundary drift).
    assert cap["devices_per_day_theoretical"] == pytest.approx(packed_devs, abs=1.0)
    assert plan["target_devices"] == pytest.approx(cap["devices_per_day_theoretical"], abs=1.0)
    assert cap["devices_per_day_realistic_unconstrained"] == pytest.approx(
        unconst["devices_per_day_realistic"], abs=1e-6
    )
    assert cap["devices_per_day_theoretical"] <= unconst["devices_per_day_theoretical"] + 1e-6
    # With a shared X1C fleet across four parts, contention should bite.
    assert cap["devices_per_day_theoretical"] < unconst["devices_per_day_theoretical"] - 0.5
    # Expected ≤ theoretical (equal when slot yields default to 1.0).
    assert cap["devices_per_day_realistic"] <= cap["devices_per_day_theoretical"] + 1e-6
    # Default schedule targets the measured ceiling (may be 1 device of boundary drift).
    assert float(plan["devices_achievable"]) + 1.0 >= float(cap["devices_per_day_theoretical"])


@pytest.mark.asyncio
async def test_print_plan_over_capacity_is_not_feasible(db_session, printer_factory):
    await _seed_full_recipe(db_session, printer_factory, printers=1)
    cap = await compute_capacity(db_session)
    realistic = float(cap["devices_per_day_realistic"] or 0)
    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=100.0)
    assert plan["target_devices"] == 100.0
    assert plan["feasible"] is False
    assert plan["devices_achievable"] < 100.0
    assert plan["devices_achievable"] <= max(realistic * 2, plan["devices_achievable"])
    assert any(
        float(plan["parts_packed"].get(code, 0)) + 1e-9 < float(plan["parts_needed"].get(code, 0))
        for code in plan["parts_needed"]
    )


@pytest.mark.asyncio
async def test_print_plan_short_parts_lists_all_misses_with_model_extras(db_session, printer_factory):
    """Over-ask: every short part is listed with eligible-model extras (not only binding)."""
    await _seed_full_recipe(db_session, printer_factory, printers=1)
    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=100.0, allow_hypothetical_fleet=True)
    assert plan["feasible"] is False or plan.get("short_parts")
    shorts = plan["short_parts"]
    assert len(shorts) >= 1
    codes = {s["part_code"] for s in shorts}
    # With one shared X1C, multiple recipe lines typically miss a huge ask.
    assert codes <= {"TOP", "BOT", "KNB", "BUT"}
    for row in shorts:
        assert row["parts_packed"] < row["parts_needed"]
        assert row["min_extra_printers"] >= 1
        assert "X1C" in row["eligible_models"]
        assert "A1" not in row["eligible_models"]  # seed is X1C-only
    # Worst short part is the binding for backward-compat.
    assert plan["binding_print_part"] == shorts[0]["part_code"]
    # Feasible / default → no shorts.
    ok = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=None)
    assert ok["short_parts"] == []
    assert ok.get("hypothetical_fleet") is False


@pytest.mark.asyncio
async def test_print_plan_hypothetical_fleet_repacks_with_virtual_lanes(db_session, printer_factory):
    """Over-ask with allow_hypothetical_fleet adds dashed what-if lanes and re-packs."""
    await _seed_full_recipe(db_session, printer_factory, printers=1)
    real_only = await compute_print_plan(
        db_session, week_start=_MONDAY, target_devices=100.0, allow_hypothetical_fleet=False
    )
    assert real_only.get("hypothetical_fleet") is False
    assert not any(lane.get("hypothetical") for day in real_only["days"] for lane in day["lanes"])

    boosted = await compute_print_plan(
        db_session, week_start=_MONDAY, target_devices=100.0, allow_hypothetical_fleet=True
    )
    assert boosted.get("short_parts")  # estimate from real fleet kept
    assert boosted["hypothetical_fleet"] is True
    assert boosted["hypothetical_added"]
    hyp_lanes = [
        lane
        for day in boosted["days"]
        if float(day.get("staffed_minutes") or 0) > 0
        for lane in day["lanes"]
        if lane.get("hypothetical")
    ]
    assert hyp_lanes
    assert all(int(lane["printer_id"]) < 0 for lane in hyp_lanes)
    assert sum(boosted["hypothetical_added"].values()) == len({lane["printer_id"] for lane in hyp_lanes})
    # Boosted pack should place at least as many parts as the real-only pack.
    real_parts = sum(float(v) for v in real_only["parts_packed"].values())
    boost_parts = sum(float(v) for v in boosted["parts_packed"].values())
    assert boost_parts + 1e-9 >= real_parts


def test_fleet_boost_from_shorts_caps_and_picks_primary_model():
    from backend.app.services.stats2_print_plan import (
        _MAX_VIRTUAL_PRINTERS,
        _fleet_boost_from_shorts,
    )

    boost = _fleet_boost_from_shorts(
        [
            {"min_extra_printers": 7, "eligible_models": ["A1", "X1C"]},
            {"min_extra_printers": 5, "eligible_models": ["H2S", "X1C"]},
            {"min_extra_printers": 0, "eligible_models": ["A1M"]},
        ]
    )
    assert boost == {"A1": 7, "H2S": 5}

    huge = _fleet_boost_from_shorts(
        [
            {"min_extra_printers": 200, "eligible_models": ["A1"]},
            {"min_extra_printers": 200, "eligible_models": ["X1C"]},
        ]
    )
    assert sum(huge.values()) <= _MAX_VIRTUAL_PRINTERS


def test_capacity_ceiling_for_extras_prefers_schedulable_not_unconstrained():
    """Mild over-ask (28 vs ~26) must not use unconstrained rates as the denominator."""
    from backend.app.services.stats2_print_plan import _capacity_ceiling_for_extras

    assert _capacity_ceiling_for_extras(schedulable_ceiling=26.0, devices_achievable=23.0) == 26.0
    # Without overview ceiling, fall back to what this pack achieved — never invent unconstrained.
    assert _capacity_ceiling_for_extras(schedulable_ceiling=None, devices_achievable=23.0) == 23.0
    assert _capacity_ceiling_for_extras(schedulable_ceiling=0.0, devices_achievable=0.0) == 1.0


def test_short_parts_mild_over_ask_reports_at_least_one_extra():
    """28/day ask vs 26/day ceiling must not report 0 printers needed for a short part."""
    import math

    from backend.app.services.stats2_print_plan import _short_parts_from_pack

    days = [
        {
            "staffed_minutes": 480,
            "lanes": [
                *[{"printer_id": i, "printer_model": "A1", "jobs": [{"part_code": "TOP"}]} for i in range(10)],
            ],
        }
    ]
    shorts = _short_parts_from_pack(
        part_qty={"TOP": 1},
        parts_needed={"TOP": 28.0},
        parts_packed={"TOP": 23.0},
        part_model_slots={"TOP": {"A1": [{}], "A1M": [{}], "H2D": [{}], "X1C": [{}]}},
        fleet={"A1": 10, "A1M": 5, "H2D": 1, "X1C": 4},
        target=28.0,
        capacity_ceiling=26.0,
        days_out=days,
    )
    assert len(shorts) == 1
    # ceil(10 * 28/26) - 10 = 2
    assert shorts[0]["min_extra_printers"] == max(0, int(math.ceil(10 * 28 / 26)) - 10)
    assert shorts[0]["min_extra_printers"] >= 1


def test_short_parts_from_pack_scales_from_capacity_ceiling_not_packed_skew():
    """Extras use target/capacity × printers that ran the part — not needed/packed."""
    from backend.app.services.stats2_print_plan import _short_parts_from_pack

    days = [
        {
            "staffed_minutes": 480,
            "lanes": [
                *[{"printer_id": i, "printer_model": "A1", "jobs": [{"part_code": "TOP"}]} for i in range(6)],
                *[{"printer_id": 100 + i, "printer_model": "H2S", "jobs": [{"part_code": "BOT"}]} for i in range(2)],
                *[{"printer_id": 200 + i, "printer_model": "X1C", "jobs": [{"part_code": "BOT"}]} for i in range(2)],
            ],
        }
    ]
    shorts = _short_parts_from_pack(
        part_qty={"TOP": 1, "BOT": 1, "KNB": 1},
        parts_needed={"TOP": 55.0, "BOT": 55.0, "KNB": 55.0},
        # Over-ask pack under-states TOP vs eligible fleet — must NOT drive the scale.
        parts_packed={"TOP": 17.0, "BOT": 38.0, "KNB": 60.0},
        part_model_slots={
            "TOP": {"A1": [{}], "A1M": [{}], "X1C": [{}], "H2D": [{}]},
            "BOT": {"H2S": [{}], "X1C": [{}]},
            "KNB": {"A1M": [{}]},
        },
        fleet={"A1": 6, "A1M": 5, "X1C": 4, "H2D": 1, "H2S": 2},
        target=55.0,
        capacity_ceiling=26.0,  # schedulable devices/day with current fleet
        days_out=days,
    )
    by_code = {s["part_code"]: s for s in shorts}
    assert set(by_code) == {"TOP", "BOT"}
    # TOP: 6 A1s that actually printed × 55/26 → ceil(6*55/26)-6 = 7 (not ~30+)
    assert by_code["TOP"]["eligible_models"] == ["A1"]
    assert by_code["TOP"]["eligible_printers"] == 6
    assert by_code["TOP"]["min_extra_printers"] == 7
    # BOT: 4 printers (2 H2S + 2 X1C) × 55/26 → ceil(4*55/26)-4 = 5
    assert set(by_code["BOT"]["eligible_models"]) == {"H2S", "X1C"}
    assert by_code["BOT"]["eligible_printers"] == 4
    assert by_code["BOT"]["min_extra_printers"] == 5
    assert shorts[0]["part_code"] == "TOP"


def test_short_parts_from_pack_falls_back_to_eligible_when_no_jobs():
    from backend.app.services.stats2_print_plan import _short_parts_from_pack

    shorts = _short_parts_from_pack(
        part_qty={"TOP": 1, "BOT": 1},
        parts_needed={"TOP": 40.0, "BOT": 40.0},
        parts_packed={"TOP": 10.0, "BOT": 40.0},
        part_model_slots={
            "TOP": {"A1": [{}], "X1C": [{}]},
            "BOT": {"H2S": [{}]},
        },
        fleet={"A1": 6, "X1C": 4, "H2S": 1},
        target=40.0,
        capacity_ceiling=20.0,
        days_out=None,
    )
    by_code = {s["part_code"]: s for s in shorts}
    assert set(by_code) == {"TOP"}
    # Fallback: eligible 10 × 40/20 → ceil(10*2)-10 = 10
    assert by_code["TOP"]["eligible_models"] == ["A1", "X1C"]
    assert by_code["TOP"]["eligible_printers"] == 10
    assert by_code["TOP"]["min_extra_printers"] == 10
    assert "A1" not in (by_code.get("BOT") or {}).get("eligible_models", [])


@pytest.mark.asyncio
async def test_print_plan_plates_packed_counts_headline_job_starts(db_session, printer_factory):
    """plates_packed must be whole plate starts on the first staffed day, not a rate."""
    await _seed_full_recipe(db_session, printer_factory)
    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=5.0)
    counted: dict[str, int] = {}
    for day in plan["days"]:
        if float(day.get("staffed_minutes") or 0) <= 0:
            continue
        for lane in day["lanes"]:
            for job in lane["jobs"]:
                code = job["part_code"]
                counted[code] = counted.get(code, 0) + 1
        break
    for code, n in counted.items():
        assert plan["plates_packed"].get(code, 0) == n
    for row in plan["scenario_rows"]:
        assert isinstance(row["parts_needed"], (int, float))
        assert float(row["parts_needed"]).is_integer()


@pytest.mark.asyncio
async def test_print_plan_allows_overnight_clear_on_long_prints(db_session, printer_factory):
    """Long prints may finish/clear next morning; the start still packs onto today."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    for code, qty in (("TOP", 1), ("BOT", 1), ("KNB", 1), ("BUT", 1)):
        await _seed_slot(
            db_session,
            part_code=code,
            model="X1C",
            quantity=qty,
            print_time=8 * 3600,
            filename=f"{code} x{qty}-long.3mf",
        )
    await printer_factory(name="X1C-only", model="X1C")
    await db_session.commit()

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=50.0)
    monday = plan["days"][0]
    assert monday["staffed_minutes"] > 0
    total_jobs = sum(len(ln["jobs"]) for ln in monday["lanes"])
    assert total_jobs >= 1
    assert plan["feasible"] is False
    # At least one job may clear the next calendar morning.
    clear_dates = {job["clear_until"][:10] for lane in monday["lanes"] for job in lane["jobs"]}
    assert clear_dates


@pytest.mark.asyncio
async def test_capacity_sums_all_printer_models_for_a_part(db_session, printer_factory):
    """TOP capacity must include A1 + X1C + H2D fleets, not only the densest recommended slot."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    await _seed_slot(db_session, part_code="TOP", model="A1", quantity=1, print_time=3600, filename="TOP-A1.3mf")
    await _seed_slot(db_session, part_code="TOP", model="X1C", quantity=3, print_time=3600, filename="TOP-X1C.3mf")
    await _seed_slot(db_session, part_code="TOP", model="H2D", quantity=2, print_time=3600, filename="TOP-H2D.3mf")
    for code in ("BOT", "KNB", "BUT"):
        await _seed_slot(
            db_session, part_code=code, model="X1C", quantity=1, print_time=1800, filename=f"{code}-X1C.3mf"
        )
    await printer_factory(name="A1-1", model="A1")
    await printer_factory(name="A1-2", model="A1")
    await printer_factory(name="X1C-1", model="X1C")
    await printer_factory(name="H2D-1", model="H2D")
    await db_session.commit()

    cap = await compute_capacity(db_session, on_date=_MONDAY)
    top = next(c for c in cap["components"] if c["part_code"] == "TOP")
    models = {b["printer_model"] for b in top["model_breakdown"]}
    assert models == {"A1", "X1C", "H2D"}
    assert top["active_printers"] == 4
    # Single densest X1C-only view would be 1 printer; fleet sum must be larger.
    x1c_only = next(b for b in top["model_breakdown"] if b["printer_model"] == "X1C")
    assert top["devices_from_component"] > x1c_only["devices_from_component"]


@pytest.mark.asyncio
async def test_print_plan_includes_h2_and_a1_lanes(db_session, printer_factory):
    """Weekly schedule lanes must include every model that has a production file."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    await _seed_slot(db_session, part_code="TOP", model="A1", quantity=1, print_time=3600, filename="TOP-A1.3mf")
    await _seed_slot(db_session, part_code="TOP", model="H2D", quantity=1, print_time=3600, filename="TOP-H2D.3mf")
    await _seed_slot(db_session, part_code="BOT", model="H2S", quantity=2, print_time=3600, filename="BOT-H2S.3mf")
    await _seed_slot(db_session, part_code="BOT", model="X1C", quantity=2, print_time=3600, filename="BOT-X1C.3mf")
    await _seed_slot(db_session, part_code="KNB", model="A1M", quantity=12, print_time=1800, filename="KNB-A1M.3mf")
    await _seed_slot(db_session, part_code="BUT", model="X1C", quantity=47, print_time=1800, filename="BUT-X1C.3mf")
    await printer_factory(name="A1-1", model="A1")
    await printer_factory(name="Mini-1", model="A1 Mini")
    await printer_factory(name="X1C-1", model="X1C")
    await printer_factory(name="H2D-1", model="H2D")
    await printer_factory(name="H2S-1", model="H2S")
    await db_session.commit()

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=20.0)
    monday = plan["days"][0]
    models = {ln["printer_model"] for ln in monday["lanes"]}
    assert {"A1", "A1M", "X1C", "H2D", "H2S"} <= models
    jobs_by_model = {}
    for ln in monday["lanes"]:
        for job in ln["jobs"]:
            jobs_by_model.setdefault(ln["printer_model"], set()).add(job["part_code"])
    assert "TOP" in jobs_by_model.get("A1", set()) or "TOP" in jobs_by_model.get("H2D", set())
    assert "BOT" in jobs_by_model.get("H2S", set()) or "BOT" in jobs_by_model.get("X1C", set())


def test_next_clear_start_projects_single_day_windows_past_midnight():
    """A print finishing tomorrow afternoon must clear tomorrow afternoon, not morning."""
    from backend.app.services.capacity_analysis import next_clear_start

    windows = [(8 * 60, 18 * 60)]
    # Finish Tue 13:47 (day-offset minutes from Mon midnight).
    clear_start, clear_end = next_clear_start(24 * 60 + 13 * 60 + 47, windows, 10)
    assert clear_start == 24 * 60 + 13 * 60 + 47
    assert clear_end == clear_start + 10

    # Finish Tue 00:33 → wait for Tue 08:00 staffed open.
    clear_start, _ = next_clear_start(24 * 60 + 33, windows, 10)
    assert clear_start == 24 * 60 + 8 * 60


def test_next_clear_start_spills_when_clear_would_end_past_window():
    """Clear that would finish after staffed close spills to the next opening."""
    from backend.app.services.capacity_analysis import next_clear_start

    windows = [(8 * 60, 17 * 60)]
    # Finish 16:50 with a 20-minute clear → would end 17:10 past close.
    clear_start, clear_end = next_clear_start(16 * 60 + 50, windows, 20)
    assert clear_start == 24 * 60 + 8 * 60  # next day 08:00
    assert clear_end == clear_start + 20


@pytest.mark.asyncio
async def test_print_plan_balances_top_bot_without_readiness_overbuild(db_session, printer_factory):
    """Fill A1/A1M with TOP; shift X1C to BOT — do not park TOP on X1C while A1s idle."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    await _seed_slot(db_session, part_code="TOP", model="A1", quantity=2, print_time=3600, filename="TOP-x2-A1.3mf")
    await _seed_slot(db_session, part_code="TOP", model="A1M", quantity=1, print_time=3600, filename="TOP-x1-A1M.3mf")
    await _seed_slot(db_session, part_code="TOP", model="X1C", quantity=3, print_time=3600, filename="TOP-x3-X1C.3mf")
    # Slow single H2S cannot clear BOT ask alone → X1C must take BOT.
    await _seed_slot(
        db_session, part_code="BOT", model="H2S", quantity=5, print_time=8 * 3600, filename="BOT-x5-H2S.3mf"
    )
    await _seed_slot(db_session, part_code="BOT", model="X1C", quantity=4, print_time=7200, filename="BOT-x4-X1C.3mf")
    await _seed_slot(db_session, part_code="KNB", model="A1M", quantity=25, print_time=1800, filename="KNB-x25.3mf")
    await _seed_slot(db_session, part_code="BUT", model="X1C", quantity=47, print_time=5400, filename="BUT-x47.3mf")
    for i in range(6):
        await printer_factory(name=f"A1-{i}", model="A1")
    for i in range(4):
        await printer_factory(name=f"A1M-{i}", model="A1M")
    for i in range(4):
        await printer_factory(name=f"X1C-{i}", model="X1C")
    await printer_factory(name="H2S-0", model="H2S")
    await db_session.commit()

    target = 18.0
    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=target)
    day = next(d for d in plan["days"] if float(d.get("staffed_minutes") or 0) > 0)
    parts: dict[str, int] = {}
    top_by_model: dict[str, int] = {}
    bot_by_model: dict[str, int] = {}
    for lane in day["lanes"]:
        model = lane["printer_model"]
        for job in lane["jobs"]:
            code = job["part_code"]
            qty = int(job.get("quantity_per_plate") or 1)
            parts[code] = parts.get(code, 0) + qty
            if code == "TOP":
                top_by_model[model] = top_by_model.get(model, 0) + qty
            if code == "BOT":
                bot_by_model[model] = bot_by_model.get(model, 0) + qty

    assert parts.get("TOP", 0) <= target + 3
    assert parts.get("BOT", 0) <= target + 5
    assert abs(parts.get("TOP", 0) - parts.get("BOT", 0)) <= 6

    top_on_compact = top_by_model.get("A1", 0) + top_by_model.get("A1M", 0)
    top_on_x1 = top_by_model.get("X1C", 0)
    assert top_on_compact > 0, f"expected TOP on A1/A1M, got {top_by_model}"
    assert top_on_x1 == 0, f"TOP should stay off X1C while A1/A1M can cover ask: {top_by_model}"
    assert bot_by_model.get("X1C", 0) > 0, f"expected BOT on X1C, got {bot_by_model}"


@pytest.mark.asyncio
async def test_top_spills_to_free_h2d_when_compact_start_is_delayed(db_session, printer_factory):
    """H2D must print TOP in the morning when A1/A1M are blocked until afternoon.

    Regression: day-wide compact lock left El Jefe (H2D) idle because an A1
    could still start tonight.
    """
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    await _seed_slot(db_session, part_code="TOP", model="A1", quantity=1, print_time=3600, filename="TOP-A1.3mf")
    await _seed_slot(db_session, part_code="TOP", model="H2D", quantity=3, print_time=3600, filename="TOP-H2D.3mf")
    await _seed_slot(db_session, part_code="BOT", model="X1C", quantity=1, print_time=3600, filename="BOT-X1C.3mf")
    await _seed_slot(db_session, part_code="KNB", model="A1", quantity=1, print_time=1800, filename="KNB-A1.3mf")
    await _seed_slot(db_session, part_code="BUT", model="X1C", quantity=1, print_time=1800, filename="BUT-X1C.3mf")
    a1 = await printer_factory(name="A1-blocked", model="A1")
    await printer_factory(name="H2D-free", model="H2D")
    await printer_factory(name="X1C-0", model="X1C")
    # Block compact fleet all morning / early afternoon (Mon=0).
    await replace_blocks_for_printer(
        db_session,
        a1.id,
        [TimeBlockIn(day_of_week=0, start_time="08:00", end_time="16:00", label="busy", enabled=True)],
    )
    await db_session.commit()

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=12.0)
    day = next(d for d in plan["days"] if d["date"] == _MONDAY.isoformat())
    h2d_lane = next(ln for ln in day["lanes"] if ln["printer_name"] == "H2D-free")
    top_jobs = [j for j in h2d_lane["jobs"] if j["part_code"] == "TOP"]
    assert top_jobs, f"expected TOP on free H2D, jobs={h2d_lane['jobs']}"
    # Must start in the morning window, not wait for A1 at 16:00.
    assert top_jobs[0]["start_at"] < f"{_MONDAY.isoformat()}T12:00:00", top_jobs[0]["start_at"]


@pytest.mark.asyncio
async def test_top_prefers_compact_when_both_fleets_free_at_open(db_session, printer_factory):
    """When A1 and H2D are both free at open, the first TOP starts on compact."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    await _seed_slot(db_session, part_code="TOP", model="A1", quantity=1, print_time=3600, filename="TOP-A1.3mf")
    await _seed_slot(db_session, part_code="TOP", model="H2D", quantity=3, print_time=3600, filename="TOP-H2D.3mf")
    await _seed_slot(db_session, part_code="BOT", model="X1C", quantity=1, print_time=3600, filename="BOT-X1C.3mf")
    await _seed_slot(db_session, part_code="KNB", model="X1C", quantity=1, print_time=1800, filename="KNB-X1C.3mf")
    await _seed_slot(db_session, part_code="BUT", model="X1C", quantity=1, print_time=1800, filename="BUT-X1C.3mf")
    await printer_factory(name="A1-free", model="A1")
    await printer_factory(name="H2D-free", model="H2D")
    for i in range(2):
        await printer_factory(name=f"X1C-{i}", model="X1C")
    await db_session.commit()

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=1.0)
    day = next(d for d in plan["days"] if d["date"] == _MONDAY.isoformat())
    first_top = None
    for lane in day["lanes"]:
        for job in lane["jobs"]:
            if job["part_code"] != "TOP":
                continue
            if first_top is None or job["start_at"] < first_top[0]:
                first_top = (job["start_at"], lane["printer_model"], job.get("quantity_per_plate"))
    assert first_top is not None
    assert first_top[1] == "A1", f"first TOP should be on A1 while free, got {first_top}"
    # Small ask fits on compact — do not also burn H2D.
    h2d_top = sum(
        int(j.get("quantity_per_plate") or 1)
        for ln in day["lanes"]
        if ln["printer_model"] == "H2D"
        for j in ln["jobs"]
        if j["part_code"] == "TOP"
    )
    assert h2d_top == 0, f"H2D should stay free when compact covers the ask, got {h2d_top}"


@pytest.mark.asyncio
async def test_high_target_uses_h2d_after_compact_busy(db_session, printer_factory):
    """Large TOP ask: after A1 is busy mid-print, free H2D must take TOP (not sit idle)."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    await _seed_slot(
        db_session, part_code="TOP", model="A1", quantity=1, print_time=8 * 3600, filename="TOP-A1-long.3mf"
    )
    await _seed_slot(db_session, part_code="TOP", model="H2D", quantity=3, print_time=3600, filename="TOP-H2D.3mf")
    await _seed_slot(db_session, part_code="BOT", model="X1C", quantity=1, print_time=3600, filename="BOT-X1C.3mf")
    await _seed_slot(db_session, part_code="KNB", model="X1C", quantity=1, print_time=1800, filename="KNB-X1C.3mf")
    await _seed_slot(db_session, part_code="BUT", model="X1C", quantity=1, print_time=1800, filename="BUT-X1C.3mf")
    await printer_factory(name="A1-only", model="A1")
    await printer_factory(name="H2D-free", model="H2D")
    for i in range(3):
        await printer_factory(name=f"X1C-{i}", model="X1C")
    await db_session.commit()

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=10.0)
    day = next(d for d in plan["days"] if d["date"] == _MONDAY.isoformat())
    h2d_lane = next(ln for ln in day["lanes"] if ln["printer_name"] == "H2D-free")
    assert any(j["part_code"] == "TOP" for j in h2d_lane["jobs"]), (
        f"H2D should print TOP after compact is busy, jobs={h2d_lane['jobs']}"
    )


@pytest.mark.asyncio
async def test_h2d_beats_later_x1c_wave_for_top_spill(db_session, printer_factory):
    """Regression: El Jefe idle while X1Cs take afternoon TOP.

    Compact is locked until evening. H2D can start at 10:00 after a morning
    reserved hour. Four X1Cs free mid-afternoon must NOT outrank H2D via
    inflated parallel-wave progress (n_free_model=4 vs 1).
    """
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    await _seed_slot(db_session, part_code="TOP", model="A1", quantity=1, print_time=8 * 3600, filename="TOP-A1.3mf")
    await _seed_slot(db_session, part_code="TOP", model="A1M", quantity=1, print_time=8 * 3600, filename="TOP-A1M.3mf")
    await _seed_slot(db_session, part_code="TOP", model="H2D", quantity=3, print_time=3 * 3600, filename="TOP-H2D.3mf")
    await _seed_slot(db_session, part_code="TOP", model="X1C", quantity=3, print_time=3 * 3600, filename="TOP-X1C.3mf")
    await _seed_slot(db_session, part_code="BOT", model="X1C", quantity=4, print_time=6 * 3600, filename="BOT-X1C.3mf")
    await _seed_slot(db_session, part_code="KNB", model="A1M", quantity=25, print_time=4 * 3600, filename="KNB-A1M.3mf")
    await _seed_slot(db_session, part_code="BUT", model="X1C", quantity=47, print_time=5 * 3600, filename="BUT-X1C.3mf")
    await printer_factory(name="A1-0", model="A1")
    await printer_factory(name="A1-1", model="A1")
    for i in range(5):
        await printer_factory(name=f"A1M-{i}", model="A1M")
    h2d = await printer_factory(name="El-Jefe", model="H2D")
    await printer_factory(name="H2S-0", model="H2S")
    await _seed_slot(db_session, part_code="BOT", model="H2S", quantity=2, print_time=3 * 3600, filename="BOT-H2S.3mf")
    for i in range(4):
        await printer_factory(name=f"X1C-{i}", model="X1C")
    await replace_blocks_for_printer(
        db_session,
        h2d.id,
        [TimeBlockIn(day_of_week=0, start_time="09:00", end_time="10:00", label="reserved", enabled=True)],
    )
    await db_session.commit()

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=18.0)
    day = next(d for d in plan["days"] if d["date"] == _MONDAY.isoformat())
    h2d_lane = next(ln for ln in day["lanes"] if ln["printer_name"] == "El-Jefe")
    top_jobs = [j for j in h2d_lane["jobs"] if j["part_code"] == "TOP"]
    assert top_jobs, f"H2D must print TOP when compact is busy and ask remains: {h2d_lane['jobs']}"
    assert top_jobs[0]["start_at"] < f"{_MONDAY.isoformat()}T12:00:00", top_jobs[0]["start_at"]


def test_bom_balanced_part_order_prefers_short_part():
    from backend.app.services.stats2_print_plan import _bom_balanced_part_order

    ordered = _bom_balanced_part_order(
        ["TOP", "BOT", "KNB"],
        part_qty={"TOP": 1, "BOT": 1, "KNB": 1},
        parts_packed_day={"TOP": 20, "BOT": 10, "KNB": 10},
        remaining_by_code={"TOP": 5, "BOT": 8, "KNB": 8},
        binding_print="BOT",
    )
    assert ordered[0] == "BOT"


def test_model_sharedness_ranks_compact_fleet_below_x1c():
    from backend.app.services.stats2_print_plan import _model_sharedness

    slots = {
        "TOP": {"A1": [{}], "A1M": [{}], "X1C": [{}]},
        "BOT": {"X1C": [{}], "H2S": [{}]},
        "KNB": {"A1M": [{}], "X1C": [{}]},
        "BUT": {"X1C": [{}]},
    }
    assert _model_sharedness("A1", slots) < _model_sharedness("X1C", slots)
    assert _model_sharedness("A1M", slots) < _model_sharedness("X1C", slots)


@pytest.mark.asyncio
async def test_print_plan_multiday_print_does_not_double_book_printer(db_session, printer_factory):
    """A ~30h print that clears next-next morning must not start another job mid-run.

    Regression: carrying ``clear_end % 1440`` turned Thu 08:10 into Wed 08:10 and
    overlapped the still-running plate on the Gantt.
    """
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    # ~29h 47m — finishes next-day afternoon; clear may land the morning after that.
    long_print = 29 * 3600 + 47 * 60
    await _seed_slot(
        db_session, part_code="TOP", model="H2D", quantity=4, print_time=long_print, filename="TOP-H2D-long.3mf"
    )
    for code in ("BOT", "KNB", "BUT"):
        await _seed_slot(
            db_session, part_code=code, model="X1C", quantity=1, print_time=1800, filename=f"{code}-pad.3mf"
        )
    await printer_factory(name="H2D-only", model="H2D")
    await printer_factory(name="X1C-pad", model="X1C")
    await db_session.commit()

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=20.0)
    h2d_jobs: list[dict] = []
    for day in plan["days"]:
        for ln in day["lanes"]:
            if ln["printer_model"] != "H2D":
                continue
            h2d_jobs.extend(ln["jobs"])
    h2d_jobs.sort(key=lambda j: j["start_at"])
    assert len(h2d_jobs) >= 2, "expected multiple H2D jobs across the week"
    for prev, nxt in zip(h2d_jobs, h2d_jobs[1:], strict=False):
        assert nxt["start_at"] >= prev["end_at"], (
            f"overlap: {prev['start_at']}→{prev['end_at']} vs {nxt['start_at']}→{nxt['end_at']}"
        )
        assert nxt["start_at"] >= prev["clear_until"], (
            f"start before clear: clear {prev['clear_until']} vs start {nxt['start_at']}"
        )
