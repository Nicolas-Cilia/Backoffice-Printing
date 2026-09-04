"""Stats 2 hardening — FAILING (TDD RED) tests that lock in four bugs.

These tests intentionally FAIL against the current production code. They
encode the *desired* behavior so a later fix can turn them green. Do NOT
adjust production code to satisfy them here — this file is the RED half of a
TDD cycle.

Bugs locked in:
  1. Readiness double-counts BOT stickers + BOT bins (sum = 12 instead of the
     sticker-only 2). BOT must use the TOP/BOT sticker pipeline only; KNB/BUT
     use bins only.
  2. Production yield double-counts BOT across the bin + sticker pipelines
     (harvested = 20 / plates = 2 instead of the single-pipeline 10 / 1).
  3. Capacity headline devices/day is overstated for an *incomplete* recipe:
     with only a TOP slot (no BOT/KNB/BUT slots) it reports TOP's throughput
     instead of 0 — you cannot build a whole device without every part.
  4. Print-plan packs clear jobs on an unstaffed Sunday (staffed_minutes == 0)
     as though it were staffed.
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.floor_bin import FloorBinBatch, FloorBinBatchEvent, FloorBotBinMember
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.production import (
    ProductionPart,
    ProductionPartInstance,
    ProductionSlot,
)
from backend.app.services.capacity_analysis import compute_capacity
from backend.app.services.device_recipe_service import get_or_create_default_recipe
from backend.app.services.production_yield_analysis import compute_yield_summary
from backend.app.services.stats2_config import set_stats2_globals
from backend.app.services.stats2_print_plan import compute_print_plan
from backend.app.services.stats2_readiness import compute_readiness

# 2026-03-02 is a Monday (matches the phase 3a fixtures); 2026-03-08 is a Sunday.
_MONDAY = date(2026, 3, 2)


async def _seed_slot(db, *, part_code: str, model: str, quantity: int, print_time: int, filename: str):
    """Discoverable production slot for ``part_code`` (mirrors phase 3a helper)."""
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


async def _add_sticker_part(db, *, sticker: str, code: str, status: str | None, printer_id: int, archive_id=None):
    part = FloorLabeledPart(sticker_code=sticker, printer_id=printer_id, part_code=code, archive_id=archive_id)
    db.add(part)
    await db.flush()
    if status is not None:
        db.add(FloorPartEvent(part_id=part.id, action=status))
        await db.flush()
    return part


async def _seed_bot_bin_ready(db, *, payload: str, remaining: int, printer_id: int) -> FloorBinBatch:
    """A BOT member-bin fill with ``remaining`` members, staged ready-for-production.

    The BOT bin readiness signal is its member count (see
    ``floor_bot_bins._bot_batch_info``), so real ``FloorBotBinMember`` rows are
    added. The member parts carry no workflow events, so they are NOT counted
    by the sticker pipeline — keeping the sticker vs bin double-count clean.
    """
    batch = FloorBinBatch(bin_payload=payload, part_code="BOT", quantity=0, printer_id=printer_id)
    db.add(batch)
    await db.flush()
    db.add(FloorBinBatchEvent(batch_id=batch.id, action="loaded"))
    for i in range(remaining):
        member = FloorLabeledPart(sticker_code=f"BBD-BOTMEM-{i}", printer_id=printer_id, part_code="BOT")
        db.add(member)
        await db.flush()
        db.add(FloorBotBinMember(batch_id=batch.id, part_id=member.id))
    db.add(FloorBinBatchEvent(batch_id=batch.id, action="ready_for_production"))
    await db.flush()
    return batch


@pytest.mark.asyncio
async def test_readiness_bot_does_not_double_count_stickers_and_bins(db_session, printer_factory):
    """Bug 1: BOT ready_now must be the sticker count (2), not stickers + bins (12)."""
    await get_or_create_default_recipe(db_session)
    printer = await printer_factory(model="X1C")

    # Sticker pipeline: exactly 2 BOT bottoms staged ready-for-production.
    await _add_sticker_part(
        db_session, sticker="BBD-BOT-1", code="BOT", status="ready_for_production", printer_id=printer.id
    )
    await _add_sticker_part(
        db_session, sticker="BBD-BOT-2", code="BOT", status="ready_for_production", printer_id=printer.id
    )

    # Bin pipeline: a BOT bin with 10 members, also staged ready-for-production.
    await _seed_bot_bin_ready(db_session, payload="BBN-BOT-1", remaining=10, printer_id=printer.id)

    await db_session.commit()

    ready = await compute_readiness(db_session, on_date=_MONDAY)
    by_code = {p["part_code"]: p for p in ready["parts"]}

    # BOT uses the sticker pipeline only; the 10-member bin must NOT be added on
    # top of the 2 staged stickers. Current code sums both → 12.
    assert by_code["BOT"]["ready_now"] == 2, (
        f"BOT ready_now double-counts sticker + bin pipelines: got {by_code['BOT']['ready_now']} (expected 2)"
    )
    assert by_code["BOT"]["ready_now"] != 12


@pytest.mark.asyncio
async def test_yield_bot_does_not_sum_both_pipelines(db_session, printer_factory):
    """Bug 2: BOT yield totals must reflect one pipeline (10), not bin + sticker (20)."""
    printer = await printer_factory(model="X1C")

    # Bin pipeline: one BOT harvest fill of 10.
    batch = FloorBinBatch(
        bin_payload="BBN-BOT-1",
        part_code="BOT",
        quantity=10,
        expected_quantity=10,
        printer_id=printer.id,
    )
    db_session.add(batch)
    await db_session.flush()
    db_session.add(FloorBinBatchEvent(batch_id=batch.id, action="harvested", details={"quantity": 10}))

    # Sticker pipeline: the SAME 10 BOT bottoms as labeled parts on one archive.
    archive = PrintArchive(
        printer_id=printer.id,
        filename="BOT x10 - 1.0.0 - X1C.3mf",
        print_name="BOT x10",
        file_path="archives/bot_x10.3mf",
        file_size=1000,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()
    for i in range(10):
        await _add_sticker_part(
            db_session,
            sticker=f"BBD-BOTY-{i}",
            code="BOT",
            status="fit_checked",
            printer_id=printer.id,
            archive_id=archive.id,
        )

    await db_session.commit()

    summary = await compute_yield_summary(db_session, lookback_days=30)
    bot = next(p for p in summary["parts"] if p["part_code"] == "BOT")

    # A single coherent pipeline yields 10 harvested across 1 plate. Current
    # code adds bin (10) + sticker (10) → 20 harvested across 2 plates.
    assert bot["harvested_total"] == 10, (
        f"BOT harvested_total sums both pipelines: got {bot['harvested_total']} (expected 10)"
    )
    assert bot["harvested_total"] != 20
    assert bot["plates"] == 1, f"BOT plates double-counted: got {bot['plates']} (expected 1)"


@pytest.mark.asyncio
async def test_capacity_incomplete_recipe_does_not_overstate_devices(db_session, printer_factory):
    """Bug 3: with only a TOP slot, devices/day must be 0 (recipe incomplete)."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=15)
    await get_or_create_default_recipe(db_session)

    # Only TOP has a discoverable slot; BOT/KNB/BUT have none.
    await _seed_slot(
        db_session, part_code="TOP", model="X1C", quantity=1, print_time=3600, filename="TOP x1 - 1.0.0 - X1C.3mf"
    )
    await printer_factory(name="X1C-01", model="X1C")
    await printer_factory(name="X1C-02", model="X1C")
    await db_session.commit()

    cap = await compute_capacity(db_session, on_date=_MONDAY)

    # At least one component is incomplete (BOT/KNB/BUT lack slots).
    assert any(c["incomplete"] for c in cap["components"])
    # You cannot build a full device without every part, so the headline
    # realistic devices/day must be 0 — not TOP's standalone throughput.
    assert cap["devices_per_day_realistic"] == 0, (
        f"Incomplete recipe overstates devices/day: got {cap['devices_per_day_realistic']} from TOP alone (expected 0)"
    )


@pytest.mark.asyncio
async def test_print_plan_does_not_pack_unstaffed_sunday(db_session, printer_factory):
    """Bug 4: an unstaffed Sunday must have staffed_minutes == 0 and pack 0 jobs."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    for code, qty, t in (("TOP", 1, 3600), ("BOT", 3, 7200), ("KNB", 12, 1800), ("BUT", 47, 5400)):
        await _seed_slot(
            db_session, part_code=code, model="X1C", quantity=qty, print_time=t, filename=f"{code} x{qty}.3mf"
        )
    await printer_factory(name="X1C-A", model="X1C")
    await printer_factory(name="X1C-B", model="X1C")
    await db_session.commit()

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=2.0)
    assert len(plan["days"]) == 7

    # Sanity: the staffed Monday DOES pack jobs, so the setup is valid.
    monday = plan["days"][0]
    assert monday["day_of_week"] == 0
    assert monday["staffed_minutes"] > 0
    assert sum(len(ln["jobs"]) for ln in monday["lanes"]) > 0

    # Sunday (default-stub unstaffed) has zero staffed minutes...
    sunday = plan["days"][6]
    assert sunday["day_of_week"] == 6
    assert sunday["staffed_minutes"] == 0
    # ...so no jobs may be scheduled/packed as if it were staffed. Current code
    # still packs clear jobs into the empty-window Sunday.
    sunday_jobs = sum(len(ln["jobs"]) for ln in sunday["lanes"])
    assert sunday_jobs == 0, f"Print-plan packed {sunday_jobs} job(s) on an unstaffed Sunday (expected 0)"
