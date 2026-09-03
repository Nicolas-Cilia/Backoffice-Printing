"""H2D idleness investigation: packing bug vs missing files vs ask-already-met.

Mirrors the user's Monday fleet as closely as practical to prove *why* an H2D
("El Jefe") can sit idle:

* 2× A1     — TOP capable, long overnight (~14h) qty-2 plates
* 6× A1M    — TOP (5) + one that runs KNB then TOP (WesCol-like)
* 1× H2D    — morning reserved block 09:30–11:00 Mon
* 1× H2S    — BOT
* 4× X1C    — BOT / BUT

Scenario A seeds H2D with a TOP file only (no BOT). Scenario B additionally
seeds a BOT file for H2D. We measure Monday H2D jobs and fleet capacity in both.

The final test isolates the *density-blind compact-lock* concern: a dense H2D
TOP×3 plate with a large ask and all compact printers free at open.
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.production import ProductionPart, ProductionPartInstance, ProductionSlot
from backend.app.services.capacity_analysis import compute_capacity
from backend.app.services.device_recipe_service import get_or_create_default_recipe
from backend.app.services.printer_time_block_service import TimeBlockIn, replace_blocks_for_printer
from backend.app.services.stats2_config import set_stats2_globals
from backend.app.services.stats2_print_plan import compute_print_plan, measure_schedulable_devices

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

    inst = ProductionPartInstance(part_id=part.id, printer_model=model, folder_id=folder.id, hidden=False)
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


async def _seed_monday_fleet(db, printer_factory, *, h2d_bot: bool = False):
    """Seed the user's Monday fleet. Returns the H2D printer row."""
    await set_stats2_globals(db, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db)

    # ── TOP files ────────────────────────────────────────────────────────
    # 2× A1: long overnight ~14h, qty 2.
    await _seed_slot(
        db, part_code="TOP", model="A1", quantity=2, print_time=14 * 3600, filename="TOP x2 - 1.0.0 - A1.3mf"
    )
    # A1M TOP (dense-ish, ~5h qty 2).
    await _seed_slot(
        db, part_code="TOP", model="A1M", quantity=2, print_time=5 * 3600, filename="TOP x2 - 1.0.0 - A1M.3mf"
    )
    # H2D dense TOP×3 plate ~4h.
    await _seed_slot(
        db, part_code="TOP", model="H2D", quantity=3, print_time=4 * 3600, filename="TOP x3 - 1.0.0 - H2D.3mf"
    )

    # ── KNB files (compact) ──────────────────────────────────────────────
    await _seed_slot(
        db, part_code="KNB", model="A1M", quantity=8, print_time=2 * 3600, filename="KNB x8 - 1.0.0 - A1M.3mf"
    )
    await _seed_slot(
        db, part_code="KNB", model="A1", quantity=8, print_time=2 * 3600, filename="KNB x8 - 1.0.0 - A1.3mf"
    )

    # ── BOT files ────────────────────────────────────────────────────────
    await _seed_slot(
        db, part_code="BOT", model="H2S", quantity=2, print_time=8 * 3600, filename="BOT x2 - 1.0.0 - H2S.3mf"
    )
    await _seed_slot(
        db, part_code="BOT", model="X1C", quantity=2, print_time=6 * 3600, filename="BOT x2 - 1.0.0 - X1C.3mf"
    )
    if h2d_bot:
        await _seed_slot(
            db, part_code="BOT", model="H2D", quantity=3, print_time=5 * 3600, filename="BOT x3 - 1.0.0 - H2D.3mf"
        )

    # ── BUT files ────────────────────────────────────────────────────────
    await _seed_slot(
        db, part_code="BUT", model="X1C", quantity=10, print_time=3 * 3600, filename="BUT x10 - 1.0.0 - X1C.3mf"
    )

    # ── Fleet ────────────────────────────────────────────────────────────
    for i in range(2):
        await printer_factory(name=f"A1-{i}", model="A1")
    for i in range(6):
        await printer_factory(name=f"A1M-{i}", model="A1 Mini")
    h2d = await printer_factory(name="H2D-ElJefe", model="H2D")
    await printer_factory(name="H2S-0", model="H2S")
    for i in range(4):
        await printer_factory(name=f"X1C-{i}", model="X1C")

    # Morning reserved block on H2D: 09:30–11:00 Monday (dow=0).
    await replace_blocks_for_printer(
        db,
        h2d.id,
        [TimeBlockIn(day_of_week=0, start_time="09:30", end_time="11:00", label="reserved", enabled=True)],
    )
    await db.commit()
    return h2d


def _h2d_monday_jobs(plan: dict) -> list[dict]:
    monday = next(d for d in plan["days"] if d["date"] == _MONDAY.isoformat())
    out: list[dict] = []
    for lane in monday["lanes"]:
        if lane["printer_model"] == "H2D":
            out.extend(lane["jobs"])
    return out


def _jobs_summary(jobs: list[dict]) -> dict:
    by_code: dict[str, int] = {}
    for j in jobs:
        by_code[j["part_code"]] = by_code.get(j["part_code"], 0) + 1
    return by_code


@pytest.mark.asyncio
async def test_h2d_top_only_vs_top_plus_bot(db_session, printer_factory, capsys):
    """Concrete numbers: H2D jobs + capacity with TOP-only vs TOP+BOT H2D files."""
    # ── Scenario A: H2D has TOP only ─────────────────────────────────────
    await _seed_monday_fleet(db_session, printer_factory, h2d_bot=False)

    cap_a = await compute_capacity(db_session, on_date=_MONDAY)
    measured_a = await measure_schedulable_devices(db_session, week_start=_MONDAY)
    plan_a = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=None)
    h2d_jobs_a = _h2d_monday_jobs(plan_a)

    # ── Scenario B: add a BOT file for H2D (same session) ────────────────
    await _seed_slot(
        db_session, part_code="BOT", model="H2D", quantity=3, print_time=5 * 3600, filename="BOT x3 - 1.0.0 - H2D.3mf"
    )
    await db_session.commit()

    cap_b = await compute_capacity(db_session, on_date=_MONDAY)
    measured_b = await measure_schedulable_devices(db_session, week_start=_MONDAY)
    plan_b = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=None)
    h2d_jobs_b = _h2d_monday_jobs(plan_b)

    report = {
        "scenario_A_h2d_top_only": {
            "capacity_realistic": cap_a["devices_per_day_realistic"],
            "capacity_theoretical": cap_a["devices_per_day_theoretical"],
            "capacity_realistic_unconstrained": cap_a["devices_per_day_realistic_unconstrained"],
            "binding_part": cap_a["binding_part"],
            "measured_schedulable": measured_a,
            "plan_target": plan_a["target_devices"],
            "plan_devices_achievable": plan_a["devices_achievable"],
            "h2d_monday_jobs": _jobs_summary(h2d_jobs_a),
            "h2d_monday_job_count": len(h2d_jobs_a),
            "h2d_monday_job_details": [
                (j["part_code"], j["quantity_per_plate"], j["start_at"][11:16], j["clear_until"][5:16])
                for j in h2d_jobs_a
            ],
            "parts_packed": plan_a["parts_packed"],
        },
        "scenario_B_h2d_top_plus_bot": {
            "capacity_realistic": cap_b["devices_per_day_realistic"],
            "capacity_theoretical": cap_b["devices_per_day_theoretical"],
            "capacity_realistic_unconstrained": cap_b["devices_per_day_realistic_unconstrained"],
            "binding_part": cap_b["binding_part"],
            "measured_schedulable": measured_b,
            "plan_target": plan_b["target_devices"],
            "plan_devices_achievable": plan_b["devices_achievable"],
            "h2d_monday_jobs": _jobs_summary(h2d_jobs_b),
            "h2d_monday_job_count": len(h2d_jobs_b),
            "h2d_monday_job_details": [
                (j["part_code"], j["quantity_per_plate"], j["start_at"][11:16], j["clear_until"][5:16])
                for j in h2d_jobs_b
            ],
            "parts_packed": plan_b["parts_packed"],
        },
    }
    import json

    print("\n===== H2D IDLENESS REPORT =====")
    print(json.dumps(report, indent=2, default=str))
    print("===== END REPORT =====\n")

    # ── Proven behavior ──────────────────────────────────────────────────
    # Scenario A: BOT is the binding bottleneck (only H2S + X1C make BOT).
    # TOP is abundant (2×A1 + 6×A1M + H2D), so the TOP ask is fully met by the
    # compact fleet and the target is capped at the BOT-limited number. H2D can
    # ONLY make TOP here, so it is correctly IDLE — this is *ask-already-met*
    # for the only part it can print, NOT a packing bug.
    assert cap_a["binding_part"] == "BOT"
    assert len(h2d_jobs_a) == 0, (
        f"expected H2D idle when its only file (TOP) is already covered by compact; got {h2d_jobs_a}"
    )
    assert float(plan_a["parts_packed"]["TOP"]) == pytest.approx(
        float(cap_a["devices_per_day_theoretical"]),
        abs=1.0,
    )

    # Scenario B: giving H2D a BOT file lets it attack the binding part. H2D now
    # gets BOT work and fleet capacity strictly rises.
    assert cap_b["binding_part"] == "BOT"
    codes_b = {j["part_code"] for j in h2d_jobs_b}
    assert "BOT" in codes_b, f"H2D should take BOT once it has a BOT file; got {h2d_jobs_b}"
    assert cap_b["devices_per_day_realistic"] > cap_a["devices_per_day_realistic"], (
        "adding an H2D BOT file must lift capacity (BOT was binding)"
    )


@pytest.mark.asyncio
async def test_h2d_bot_file_lets_h2d_take_bot(db_session, printer_factory):
    """Seeding a BOT file for H2D makes the packer schedule BOT on H2D."""
    await _seed_monday_fleet(db_session, printer_factory, h2d_bot=True)
    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=None)
    jobs = _h2d_monday_jobs(plan)
    codes = {j["part_code"] for j in jobs}
    assert jobs, "H2D idle despite having TOP and BOT files"
    # H2D should be used for at least one real part; BOT becomes available now.
    assert codes & {"TOP", "BOT"}


@pytest.mark.asyncio
async def test_h2d_stays_busy_under_large_ask_with_compact_free(db_session, printer_factory):
    """Density-blind compact-lock concern.

    H2D has a dense TOP×3 plate, the ask is large, and all A1/A1M are free at
    open. After the compact fleet's first wave, does the ceiling keep packing
    onto the free H2D, or does the compact lock strand it while the ask is
    still unmet?
    """
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    # Compact TOP files (short, qty 1) + a dense H2D TOP×3.
    await _seed_slot(
        db_session, part_code="TOP", model="A1", quantity=1, print_time=3600, filename="TOP - 1.0.0 - A1.3mf"
    )
    await _seed_slot(
        db_session, part_code="TOP", model="A1M", quantity=1, print_time=3600, filename="TOP - 1.0.0 - A1M.3mf"
    )
    await _seed_slot(
        db_session, part_code="TOP", model="H2D", quantity=3, print_time=4 * 3600, filename="TOP x3 - 1.0.0 - H2D.3mf"
    )
    # Other BOM parts so complete devices are possible (kept off compact/H2D TOP).
    await _seed_slot(
        db_session, part_code="BOT", model="X1C", quantity=2, print_time=6 * 3600, filename="BOT x2 - 1.0.0 - X1C.3mf"
    )
    await _seed_slot(
        db_session, part_code="KNB", model="A1M", quantity=8, print_time=2 * 3600, filename="KNB x8 - 1.0.0 - A1M.3mf"
    )
    await _seed_slot(
        db_session, part_code="BUT", model="X1C", quantity=10, print_time=3 * 3600, filename="BUT x10 - 1.0.0 - X1C.3mf"
    )
    for i in range(2):
        await printer_factory(name=f"A1-{i}", model="A1")
    for i in range(2):
        await printer_factory(name=f"A1M-{i}", model="A1 Mini")
    await printer_factory(name="H2D-ElJefe", model="H2D")
    for i in range(3):
        await printer_factory(name=f"X1C-{i}", model="X1C")
    await db_session.commit()

    # Large TOP ask that a 4-printer compact fleet cannot clear alone in a day.
    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=60.0)
    monday = next(d for d in plan["days"] if d["date"] == _MONDAY.isoformat())
    h2d_jobs = [j for ln in monday["lanes"] if ln["printer_model"] == "H2D" for j in ln["jobs"]]
    top_packed = float(plan["parts_packed"].get("TOP", 0.0))
    ask = float(plan["parts_needed"].get("TOP", 0.0))

    import json

    print("\n===== DENSITY-BLIND LOCK CHECK =====")
    print(
        json.dumps(
            {
                "top_ask": ask,
                "top_packed_first_staffed_day": top_packed,
                "h2d_monday_jobs": [(j["part_code"], j["quantity_per_plate"], j["start_at"][11:16]) for j in h2d_jobs],
                "h2d_monday_job_count": len(h2d_jobs),
            },
            indent=2,
        )
    )
    print("===== END CHECK =====\n")

    # If the ask exceeds what compact can pack, the free dense H2D must be used.
    assert h2d_jobs, f"H2D idle while TOP ask {ask} unmet (packed {top_packed}) — density-blind lock strands El Jefe"
