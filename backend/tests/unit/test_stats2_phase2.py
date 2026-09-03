"""Unit tests for Stats 2 Phase 2: schedule, recipe, expected quantity, variance."""

from __future__ import annotations

from datetime import date, datetime

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.device_recipe import DeviceRecipe, DeviceRecipeLine
from backend.app.models.floor_bin import FloorBinBatch
from backend.app.models.operator_schedule import OperatorSchedule
from backend.app.models.production import ProductionPart
from backend.app.services.device_recipe_service import get_or_create_default_recipe, get_recipe_view
from backend.app.services.expected_quantity import SOURCE_DEFAULT, SOURCE_FILENAME, resolve_expected_quantity
from backend.app.services.harvest_variance import apply_snapshot_to_batch, snapshot_for_archive
from backend.app.services.operator_schedule_service import (
    ScheduleShiftIn,
    get_effective_schedule,
    get_schedule,
    replace_schedule,
)
from backend.app.services.production_filename import parse_production_filename
from backend.app.services.stats2_config import ready_deadline_hhmm, set_stats2_globals


class TestFilenameVariantsPhase2:
    def test_topx2_no_space_before_x(self):
        parsed = parse_production_filename("TOPx2-1.13.3 - A1.gcode.3mf")
        assert parsed is not None
        assert parsed.code == "TOP"
        assert parsed.quantity == 2
        assert parsed.version_tuple == (1, 13, 3)
        assert parsed.printer == "A1"

    def test_but_x47(self):
        parsed = parse_production_filename("BUT x47 - 1.0.0 - X1C.gcode.3mf")
        assert parsed is not None
        assert parsed.code == "BUT"
        assert parsed.quantity == 47

    def test_bot_x3_spaced(self):
        parsed = parse_production_filename("BOT x3 - 1.5.2 - X1C.gcode.3mf")
        assert parsed is not None
        assert parsed.quantity == 3


@pytest.mark.asyncio
async def test_resolve_expected_from_filename(db_session):
    archive = PrintArchive(
        filename="BUT x47 - 1.0.0 - X1C.gcode.3mf",
        print_name="BUT x47 - 1.0.0 - X1C",
        file_path="archives/test/but.gcode.3mf",
        file_size=100,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()
    resolved = await resolve_expected_quantity(db_session, archive.id)
    assert resolved.quantity == 47
    assert resolved.source == SOURCE_FILENAME


@pytest.mark.asyncio
async def test_resolve_expected_default_when_missing(db_session):
    resolved = await resolve_expected_quantity(db_session, None)
    assert resolved.quantity == 1
    assert resolved.source == SOURCE_DEFAULT


@pytest.mark.asyncio
async def test_harvest_variance_snapshot(db_session):
    archive = PrintArchive(
        filename="KNB x12 - 1.0.0 - X1C.gcode.3mf",
        print_name="KNB x12 - 1.0.0 - X1C",
        file_path="archives/test/knb.gcode.3mf",
        file_size=100,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()
    snap = await snapshot_for_archive(db_session, archive.id, 10)
    assert snap.expected_quantity == 12
    assert snap.expected_quantity_source == SOURCE_FILENAME
    assert snap.quantity_variance == -2
    batch = FloorBinBatch(
        bin_payload="BBK-1",
        part_code="KNB",
        quantity=10,
        archive_id=archive.id,
    )
    apply_snapshot_to_batch(batch, snap)
    assert batch.expected_quantity == 12
    assert batch.quantity_variance == -2


@pytest.mark.asyncio
async def test_schedule_replace_and_effective(db_session):
    await replace_schedule(
        db_session,
        [
            ScheduleShiftIn(day_of_week=0, start_time="08:00", end_time="17:00", operator_count=2),
            ScheduleShiftIn(day_of_week=1, start_time="09:00", end_time="18:00", operator_count=1),
        ],
    )
    await set_stats2_globals(
        db_session,
        expected_plate_clear_minutes=12,
        production_line_start_time="09:00",
        pre_line_buffer_minutes=30,
        timezone="UTC",
    )
    await db_session.commit()

    rows = (await db_session.execute(select(OperatorSchedule))).scalars().all()
    assert len(rows) == 2

    # Pick a known Monday.
    monday = date(2026, 9, 7)
    assert monday.weekday() == 0
    effective = await get_effective_schedule(db_session, monday)
    assert effective.is_staffed is True
    assert effective.line_start_time == "09:00"
    assert effective.ready_deadline_time == "08:30"
    assert effective.expected_plate_clear_minutes == 12
    assert ready_deadline_hhmm("09:00", 30) == "08:30"
    # Reload schedule via get_schedule alias
    assert len(await get_schedule(db_session)) == 2


@pytest.mark.asyncio
async def test_device_recipe_bootstrap(db_session):
    recipe = await get_or_create_default_recipe(db_session)
    await db_session.commit()
    assert recipe.name == "Default Device"
    codes = sorted(line.part.code for line in recipe.lines if line.part)
    assert codes == ["BOT", "BUT", "KNB", "TOP"]

    again = await get_or_create_default_recipe(db_session)
    assert again.id == recipe.id
    count = (await db_session.execute(select(DeviceRecipe))).scalars().all()
    assert len(count) == 1
    line_count = len((await db_session.execute(select(DeviceRecipeLine))).scalars().all())
    assert line_count == 4

    parts = (await db_session.execute(select(ProductionPart))).scalars().all()
    assert {p.code for p in parts} >= {"TOP", "BOT", "KNB", "BUT"}

    payload = await get_recipe_view(db_session)
    assert len(payload["lines"]) == 4
