"""Lexicographic print-plan packing (ask first, then expected good parts / minute).

TDD: these tests define the desired score + packer behavior before implementation.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.production import ProductionPart, ProductionPartInstance, ProductionSlot
from backend.app.services.device_recipe_service import get_or_create_default_recipe
from backend.app.services.stats2_config import set_stats2_globals
from backend.app.services.stats2_print_plan import (
    compute_print_plan,
    expected_good_parts,
    placement_sort_key,
    yield_drag_from_plan,
)
from backend.app.services.stats2_slot_metrics import SlotMetrics

_MONDAY = date(2026, 3, 2)


def _metrics(
    slot_id: int,
    *,
    success: float = 1.0,
    harvest: float = 1.0,
    qc: float = 1.0,
) -> SlotMetrics:
    return SlotMetrics(
        slot_id=slot_id,
        print_job_success=success,
        harvest_yield=harvest,
        qc_yield=qc,
        job_samples=10,
        harvest_samples=10,
        using_defaults=False,
    )


# ── Pure helpers ─────────────────────────────────────────────────────────────


def test_expected_good_parts_multiplies_qty_and_yields():
    slot = {"quantity": 4, "slot_id": 1}
    assert expected_good_parts(slot, _metrics(1, success=0.5, harvest=0.8, qc=1.0)) == pytest.approx(1.6)
    assert expected_good_parts(slot, None) == pytest.approx(4.0)
    assert expected_good_parts({"quantity": 0, "slot_id": 2}, None) == pytest.approx(1.0)


def test_placement_sort_key_equal_progress_prefers_earlier_start():
    """Equal ask coverage: free H2D at 10:00 beats a later X1C start."""
    early = placement_sort_key(progress=3.0, rate=0.002, clear_end=1950, qty=3, wave_time=1350, start=600)
    late = placement_sort_key(progress=3.0, rate=0.003, clear_end=2100, qty=3, wave_time=1200, start=830)
    assert early > late


def test_placement_sort_key_progress_beats_earlier_start():
    """Covering more of the remaining ask still wins even if start is later."""
    dense = placement_sort_key(progress=4.0, rate=0.01, clear_end=1000, qty=4, wave_time=1000, start=830)
    sparse = placement_sort_key(progress=1.0, rate=1.0, clear_end=100, qty=1, wave_time=100, start=600)
    assert dense > sparse


def test_placement_sort_key_equal_start_progress_prefers_sooner_wave():
    a = placement_sort_key(progress=4.0, rate=0.002, clear_end=500, qty=1, wave_time=360, start=100)
    b = placement_sort_key(progress=4.0, rate=0.003, clear_end=2000, qty=4, wave_time=1440, start=100)
    assert a > b


def test_placement_sort_key_equal_progress_and_wave_prefers_higher_rate():
    a = placement_sort_key(progress=2.0, rate=0.5, clear_end=500, qty=2, wave_time=100, start=50)
    b = placement_sort_key(progress=2.0, rate=0.2, clear_end=100, qty=2, wave_time=100, start=50)
    assert a > b


def test_placement_sort_key_equal_progress_rate_prefers_earlier_clear():
    a = placement_sort_key(progress=2.0, rate=0.5, clear_end=200, qty=2, wave_time=100, start=50)
    b = placement_sort_key(progress=2.0, rate=0.5, clear_end=800, qty=4, wave_time=100, start=50)
    assert a > b


def test_yield_drag_from_plan_splits_print_harvest_qc():
    """Sequential device losses explain theoretical → expected for the binding part."""
    plan = {
        "days": [
            {
                "staffed_minutes": 480,
                "lanes": [
                    {
                        "jobs": [
                            # 10 physical TOP parts; print 80% → harvest 75% → QC 100%
                            # → 10 → 8 → 6 → 6 devices (qty_per_device=1)
                            {
                                "part_code": "TOP",
                                "quantity_per_plate": 10,
                                "print_job_success": 0.8,
                                "harvest_yield": 0.75,
                                "qc_yield": 1.0,
                                "est_good_parts": 6.0,
                            },
                            # BOT never binds (more than enough after yields)
                            {
                                "part_code": "BOT",
                                "quantity_per_plate": 20,
                                "print_job_success": 1.0,
                                "harvest_yield": 1.0,
                                "qc_yield": 1.0,
                                "est_good_parts": 20.0,
                            },
                        ]
                    }
                ],
            }
        ]
    }
    drag = yield_drag_from_plan(plan, {"TOP": 1, "BOT": 1}, theoretical=10.0, expected=6.0)
    assert drag["devices_theoretical_whole"] == 10
    assert drag["devices_expected_whole"] == 6
    assert drag["devices_lost_total"] == 4
    assert drag["lost_print"] + drag["lost_harvest"] + drag["lost_qc"] == 4
    assert drag["lost_print"] == 2
    assert drag["lost_harvest"] == 2
    assert drag["lost_qc"] == 0
    assert drag["binding_part"] == "TOP"
    assert drag["devices_after_qc"] == 6
    top = next(p for p in drag["parts"] if p["part_code"] == "TOP")
    assert top["is_binding"] is True
    assert top["print_job_success"] == pytest.approx(0.8)
    assert top["harvest_yield"] == pytest.approx(0.75)


def test_yield_drag_whole_devices_telescope_to_headline():
    """Floored stage losses must sum exactly to floored theo − expected (no 26−5≠20)."""
    # Floats that previously rounded poorly: 26.0 → 21.84 → 21.84 → 20.09
    plan = {
        "days": [
            {
                "staffed_minutes": 480,
                "lanes": [
                    {
                        "jobs": [
                            {
                                "part_code": "TOP",
                                "quantity_per_plate": 26,
                                "print_job_success": 0.84,
                                "harvest_yield": 1.0,
                                "qc_yield": 0.92,
                                "est_good_parts": 26 * 0.84 * 0.92,
                            }
                        ]
                    }
                ],
            }
        ]
    }
    theo = 26.0
    expected = 26 * 0.84 * 0.92  # ≈ 20.0928
    drag = yield_drag_from_plan(plan, {"TOP": 1}, theoretical=theo, expected=expected)
    assert drag["devices_theoretical_whole"] == 26
    assert drag["devices_expected_whole"] == 20
    assert drag["devices_lost_total"] == 6
    assert drag["lost_print"] + drag["lost_harvest"] + drag["lost_qc"] == 6
    assert (
        drag["devices_theoretical_whole"] - drag["lost_print"] - drag["lost_harvest"] - drag["lost_qc"]
        == drag["devices_expected_whole"]
    )
    # Visible stages only
    visible = [s for s in drag["stages"] if s["devices_lost"] >= 1]
    assert sum(s["devices_lost"] for s in visible) == 6


def test_yield_drag_zero_when_all_yields_perfect():
    plan = {
        "days": [
            {
                "staffed_minutes": 480,
                "lanes": [
                    {
                        "jobs": [
                            {
                                "part_code": "TOP",
                                "quantity_per_plate": 5,
                                "print_job_success": 1.0,
                                "harvest_yield": 1.0,
                                "qc_yield": 1.0,
                                "est_good_parts": 5.0,
                            }
                        ]
                    }
                ],
            }
        ]
    }
    drag = yield_drag_from_plan(plan, {"TOP": 1}, theoretical=5.0, expected=5.0)
    assert drag["devices_lost_total"] == 0
    assert drag["stages"][0]["devices_lost"] == 0


# ── Packer integration ───────────────────────────────────────────────────────


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


def _patch_metrics(monkeypatch, by_slot: dict[int, SlotMetrics]):
    async def _fake(_db, slot_ids, **_kwargs):
        return {int(sid): by_slot.get(int(sid), _metrics(int(sid))) for sid in slot_ids}

    monkeypatch.setattr(
        "backend.app.services.stats2_print_plan.get_slot_metrics_map",
        AsyncMock(side_effect=_fake),
    )


@pytest.mark.asyncio
async def test_parallel_short_plates_preferred_over_idle_fleet_under_long_x4(db_session, printer_factory, monkeypatch):
    """Need 4 TOP with 4 free printers: pack x1s across the fleet, not one x4 + 3 idle.

    Only TOP is seeded so BOM-balance does not burn sibling printers on BOT/KNB
    mid-wave (that case is about part mix, not plate-density ranking).
    """
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    x4 = await _seed_slot(
        db_session,
        part_code="TOP",
        model="X1C",
        quantity=4,
        print_time=24 * 3600,
        filename="TOP x4 - 1.0.0 - X1C.3mf",
    )
    x1 = await _seed_slot(
        db_session,
        part_code="TOP",
        model="X1C",
        quantity=1,
        print_time=6 * 3600,
        filename="TOP - 1.0.0 - X1C.3mf",
    )
    for i in range(4):
        await printer_factory(name=f"X1C-{i}", model="X1C")
    await db_session.commit()

    _patch_metrics(
        monkeypatch,
        {
            x4.id: _metrics(x4.id),
            x1.id: _metrics(x1.id),
        },
    )

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=4.0)
    monday = plan["days"][0]
    top_jobs = [j for ln in monday["lanes"] for j in ln["jobs"] if j["part_code"] == "TOP"]
    assert top_jobs, "expected TOP jobs on Monday"
    lanes_with_top = sum(1 for ln in monday["lanes"] if any(j["part_code"] == "TOP" for j in ln["jobs"]))
    assert lanes_with_top >= 3, f"expected parallel shorts across fleet, got lanes={lanes_with_top} jobs={top_jobs}"
    x1_jobs = [j for j in top_jobs if j["quantity_per_plate"] == 1]
    assert len(x1_jobs) >= 3


@pytest.mark.asyncio
async def test_dense_plate_preferred_on_single_printer_with_large_ask(db_session, printer_factory, monkeypatch):
    """One printer, large remaining ask, similar yield → prefer TOP x4 over TOP x1."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    x4 = await _seed_slot(
        db_session,
        part_code="TOP",
        model="X1C",
        quantity=4,
        print_time=8 * 3600,
        filename="TOP x4 - 1.0.0 - X1C.3mf",
    )
    x1 = await _seed_slot(
        db_session,
        part_code="TOP",
        model="X1C",
        quantity=1,
        print_time=2 * 3600,
        filename="TOP - 1.0.0 - X1C.3mf",
    )
    for code in ("BOT", "KNB", "BUT"):
        await _seed_slot(db_session, part_code=code, model="X1C", quantity=1, print_time=1800, filename=f"{code}.3mf")
    await printer_factory(name="X1C-only", model="X1C")
    await db_session.commit()

    _patch_metrics(monkeypatch, {x4.id: _metrics(x4.id), x1.id: _metrics(x1.id)})

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=20.0)
    monday = plan["days"][0]
    lane = monday["lanes"][0]
    top_jobs = [j for j in lane["jobs"] if j["part_code"] == "TOP"]
    assert top_jobs
    assert top_jobs[0]["quantity_per_plate"] == 4


@pytest.mark.asyncio
async def test_low_success_dense_plate_loses_to_reliable_short(db_session, printer_factory, monkeypatch):
    """x4 with poor success loses to x1 with high success on a single printer."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    x4 = await _seed_slot(
        db_session,
        part_code="TOP",
        model="X1C",
        quantity=4,
        print_time=8 * 3600,
        filename="TOP x4 - 1.0.0 - X1C.3mf",
    )
    x1 = await _seed_slot(
        db_session,
        part_code="TOP",
        model="X1C",
        quantity=1,
        print_time=2 * 3600,
        filename="TOP - 1.0.0 - X1C.3mf",
    )
    for code in ("BOT", "KNB", "BUT"):
        await _seed_slot(db_session, part_code=code, model="X1C", quantity=1, print_time=1800, filename=f"{code}.3mf")
    await printer_factory(name="X1C-only", model="X1C")
    await db_session.commit()

    _patch_metrics(
        monkeypatch,
        {
            x4.id: _metrics(x4.id, success=0.25),
            x1.id: _metrics(x1.id, success=1.0),
        },
    )

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=8.0)
    monday = plan["days"][0]
    top_jobs = [j for j in monday["lanes"][0]["jobs"] if j["part_code"] == "TOP"]
    assert top_jobs
    assert top_jobs[0]["quantity_per_plate"] == 1
