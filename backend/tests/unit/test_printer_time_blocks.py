"""Printer time-block service + packing avoidance."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.production import ProductionPart, ProductionPartInstance, ProductionSlot
from backend.app.services.capacity_analysis import next_clear_start
from backend.app.services.device_recipe_service import get_or_create_default_recipe
from backend.app.services.printer_time_block_service import (
    TimeBlockIn,
    intervals_overlap,
    list_blocks,
    next_start_avoiding_blocks,
    replace_blocks_for_printer,
)
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


def test_intervals_overlap_half_open():
    assert intervals_overlap(0, 60, 60, 120) is False
    assert intervals_overlap(0, 61, 60, 120) is True
    assert intervals_overlap(100, 200, 50, 100) is False
    assert intervals_overlap(100, 200, 50, 101) is True


def test_next_start_avoiding_blocks_jumps_past_midday_reservation():
    windows = [(8 * 60, 18 * 60)]
    # Block 12:00–14:00; 4h print + 10m clear starting at 08:00 would clear ~12:10 → overlap.
    blocks = [(12 * 60, 14 * 60)]
    start = next_start_avoiding_blocks(
        8 * 60,
        windows,
        blocks,
        print_min=4 * 60,
        clear_minutes=10,
        next_clear_start_fn=next_clear_start,
        day_limit=24 * 60,
    )
    assert start == 14 * 60
    end = start + 4 * 60
    _cs, clear_end = next_clear_start(end, windows, 10)
    assert not intervals_overlap(start, clear_end, 12 * 60, 14 * 60)


@pytest.mark.asyncio
async def test_replace_blocks_for_printer_validates_and_lists(db_session, printer_factory):
    p = await printer_factory(name="Block-Printer", model="X1C")
    await db_session.commit()

    with pytest.raises(ValueError, match="before end"):
        await replace_blocks_for_printer(
            db_session,
            p.id,
            [TimeBlockIn(day_of_week=0, start_time="14:00", end_time="12:00")],
        )

    await replace_blocks_for_printer(
        db_session,
        p.id,
        [
            TimeBlockIn(day_of_week=0, start_time="12:00", end_time="13:30", label="demo"),
            TimeBlockIn(day_of_week=2, start_time="09:00", end_time="10:00", label="maint"),
        ],
    )
    await db_session.commit()

    rows = await list_blocks(db_session)
    assert len(rows) == 2
    assert {r.label for r in rows} == {"demo", "maint"}
    assert all(r.printer_id == p.id for r in rows)


@pytest.mark.asyncio
async def test_print_plan_skips_jobs_overlapping_time_block(db_session, printer_factory):
    """A mid-day must-be-free block forces the next start after the block."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    # 4h print — from 08:00 clears ~12:10, which would overlap 12:00–14:00.
    await _seed_slot(db_session, part_code="TOP", model="X1C", quantity=1, print_time=4 * 3600, filename="TOP-4h.3mf")
    for code in ("BOT", "KNB", "BUT"):
        await _seed_slot(db_session, part_code=code, model="X1C", quantity=1, print_time=1800, filename=f"{code}.3mf")
    p = await printer_factory(name="X1C-blocked", model="X1C")
    await db_session.commit()

    await replace_blocks_for_printer(
        db_session,
        p.id,
        [TimeBlockIn(day_of_week=0, start_time="12:00", end_time="14:00", label="reserved")],
    )
    await db_session.commit()

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=1.0)
    monday = plan["days"][0]
    lane = next(ln for ln in monday["lanes"] if ln["printer_id"] == p.id)
    assert lane["time_blocks"]
    assert lane["time_blocks"][0]["start_time"] == "12:00"
    assert lane["time_blocks"][0]["end_time"] == "14:00"

    for job in lane["jobs"]:
        # No job may occupy [12:00, 14:00).
        start = job["start_at"]
        clear = job["clear_until"]
        assert not (start < f"{_MONDAY.isoformat()}T14:00:00" and clear > f"{_MONDAY.isoformat()}T12:00:00"), (
            f"job overlaps block: {start} → clear {clear}"
        )
    # At least one TOP should still pack after the block when demand requires it.
    top_jobs = [j for j in lane["jobs"] if j["part_code"] == "TOP"]
    if top_jobs:
        assert top_jobs[0]["start_at"] >= f"{_MONDAY.isoformat()}T14:00:00"


@pytest.mark.asyncio
async def test_print_plan_falls_back_to_shorter_plate_around_daily_blocks(db_session, printer_factory):
    """Daily morning blocks make a ~30h TOP x4 impossible Mon–Thu; pack TOP x1 instead.

    Filenames without ``xN`` are quantity 1 (``TOP - …``); denser ``TOP x4`` is preferred
    when it fits, but must not starve the printer when only shorter files clear the blocks.
    """
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)
    await _seed_slot(
        db_session,
        part_code="TOP",
        model="H2D",
        quantity=4,
        print_time=29 * 3600 + 47 * 60,
        filename="TOP x4 - 1.0.0 - H2D.3mf",
    )
    await _seed_slot(
        db_session,
        part_code="TOP",
        model="H2D",
        quantity=1,
        print_time=7 * 3600 + 30 * 60,
        filename="TOP - 1.0.0 - H2D.3mf",
    )
    for code in ("BOT", "KNB", "BUT"):
        await _seed_slot(db_session, part_code=code, model="X1C", quantity=1, print_time=1800, filename=f"{code}.3mf")
    h2d = await printer_factory(name="H2D-blocked", model="H2D")
    await printer_factory(name="X1C-pad", model="X1C")
    await db_session.commit()

    # Mon–Fri 09:00–10:00 reserved — long plate always overlaps next morning.
    await replace_blocks_for_printer(
        db_session,
        h2d.id,
        [TimeBlockIn(day_of_week=d, start_time="09:00", end_time="10:00", label="reserved") for d in range(5)],
    )
    await db_session.commit()

    plan = await compute_print_plan(db_session, week_start=_MONDAY, target_devices=8.0)
    monday = plan["days"][0]
    lane = next(ln for ln in monday["lanes"] if ln["printer_id"] == h2d.id)
    assert lane["jobs"], "expected H2D to pack a shorter TOP that clears tomorrow's block"
    top = lane["jobs"][0]
    assert top["part_code"] == "TOP"
    assert top["quantity_per_plate"] == 1
    assert top["start_at"] >= f"{_MONDAY.isoformat()}T10:00:00"
    # Must finish+clear before Tuesday's 09:00 reserved window.
    assert top["clear_until"] <= "2026-03-03T09:00:00"
