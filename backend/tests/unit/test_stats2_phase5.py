"""Phase 5: plate-turnaround backfill + Stats 2 CSV export."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from backend.app.models.print_log import PrintLogEntry
from backend.app.models.stats_events import SOURCE_BACKFILL, PlateTurnaroundEvent
from backend.app.services.stats2_backfill import backfill_plate_turnaround_from_print_log
from backend.app.services.stats2_export import build_stats2_export


@pytest.mark.asyncio
async def test_backfill_inserts_from_consecutive_prints(db_session, printer_factory):
    printer = await printer_factory(model="X1C")
    t0 = datetime(2026, 3, 2, 9, 0)  # Monday staffed
    db_session.add(
        PrintLogEntry(
            printer_id=printer.id,
            printer_name=printer.name,
            print_name="A",
            status="completed",
            started_at=t0,
            completed_at=t0 + timedelta(hours=1),
            created_at=t0,
        )
    )
    db_session.add(
        PrintLogEntry(
            printer_id=printer.id,
            printer_name=printer.name,
            print_name="B",
            status="completed",
            started_at=t0 + timedelta(hours=1, minutes=20),
            completed_at=t0 + timedelta(hours=2, minutes=20),
            created_at=t0 + timedelta(hours=1, minutes=20),
        )
    )
    await db_session.commit()

    result = await backfill_plate_turnaround_from_print_log(db_session, lookback_days=365)
    await db_session.commit()
    assert result.candidates == 1
    assert result.inserted == 1

    rows = (await db_session.execute(select(PlateTurnaroundEvent))).scalars().all()
    assert len(rows) == 1
    row = rows[0]
    assert row.source == SOURCE_BACKFILL
    assert row.printer_id == printer.id
    assert row.actual_clear_minutes == pytest.approx(20.0)

    # Idempotent
    again = await backfill_plate_turnaround_from_print_log(db_session, lookback_days=365)
    assert again.inserted == 0
    assert again.skipped_existing == 1


@pytest.mark.asyncio
async def test_backfill_skips_huge_gaps(db_session, printer_factory):
    printer = await printer_factory(model="X1C")
    t0 = datetime(2026, 3, 2, 9, 0)
    db_session.add(
        PrintLogEntry(
            printer_id=printer.id,
            status="completed",
            started_at=t0,
            completed_at=t0 + timedelta(hours=1),
            created_at=t0,
        )
    )
    db_session.add(
        PrintLogEntry(
            printer_id=printer.id,
            status="completed",
            started_at=t0 + timedelta(days=5),
            completed_at=t0 + timedelta(days=5, hours=1),
            created_at=t0 + timedelta(days=5),
        )
    )
    await db_session.commit()

    result = await backfill_plate_turnaround_from_print_log(db_session, lookback_days=365, max_gap_hours=72)
    assert result.inserted == 0
    assert result.skipped_invalid >= 1


@pytest.mark.asyncio
async def test_stats2_export_csv(db_session):
    file_bytes, filename, content_type = await build_stats2_export(db_session, format="csv", lookback_days=30)
    assert content_type == "text/csv"
    assert filename.startswith("stats2_export_")
    text = file_bytes.decode("utf-8")
    assert "Device capacity" in text
    assert "Readiness" in text
    assert "Plate turnaround feedback" in text
