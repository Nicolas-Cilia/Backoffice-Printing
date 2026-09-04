"""Tests for Stats 2 Phase 1 analytics events (plate turnaround + queue lifecycle).

Covers the recording helpers in ``services/plate_turnaround.py`` and the two
event models. The turnaround flow verified end-to-end is finish → clear
requested → clear confirmed → next print started, producing exactly one complete
row. QueueLifecycleEvent timestamp writes are verified too.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401 - populate Base.metadata
import backend.app.services.plate_turnaround as pt
from backend.app.core.database import Base
from backend.app.models.printer import Printer
from backend.app.models.stats_events import PlateTurnaroundEvent, QueueLifecycleEvent


@pytest.fixture
async def db_env(monkeypatch):
    """In-memory DB with the service's ``async_session`` pointed at it."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    # Seed a printer so the CASCADE/SET NULL FKs are satisfiable.
    async with session_maker() as db:
        db.add(
            Printer(
                id=1,
                name="P1",
                serial_number="S1",
                ip_address="1.1.1.1",
                access_code="x",
            )
        )
        await db.commit()

    monkeypatch.setattr(pt, "async_session", session_maker)
    try:
        yield session_maker
    finally:
        await engine.dispose()


class TestComputeWithinStaffedHours:
    """The Phase 1 weekday-08:00–17:00 stub (no OperatorSchedule table yet)."""

    def test_weekday_midday_is_staffed(self):
        # 2026-09-02 is a Wednesday.
        assert pt.compute_within_staffed_hours(datetime(2026, 9, 2, 10, 0)) is True

    def test_weekday_evening_not_staffed(self):
        assert pt.compute_within_staffed_hours(datetime(2026, 9, 2, 20, 0)) is False

    def test_weekday_early_morning_not_staffed(self):
        assert pt.compute_within_staffed_hours(datetime(2026, 9, 2, 6, 0)) is False

    def test_weekend_not_staffed(self):
        # 2026-09-05 is a Saturday.
        assert pt.compute_within_staffed_hours(datetime(2026, 9, 5, 10, 0)) is False

    def test_boundary_17_is_not_staffed(self):
        assert pt.compute_within_staffed_hours(datetime(2026, 9, 2, 17, 0)) is False

    def test_boundary_08_is_staffed(self):
        assert pt.compute_within_staffed_hours(datetime(2026, 9, 2, 8, 0)) is True

    def test_none_returns_none(self):
        assert pt.compute_within_staffed_hours(None) is None


class TestPlateTurnaroundLifecycle:
    """finish → clear requested → clear confirmed → next start = one complete row."""

    @pytest.mark.asyncio
    async def test_full_turnaround_writes_one_complete_row(self, db_env):
        finished = datetime(2026, 9, 2, 10, 0, 0)
        confirmed = datetime(2026, 9, 2, 10, 20, 0)
        next_start = datetime(2026, 9, 2, 10, 25, 0)

        await pt.start_plate_turnaround(printer_id=1, archive_id=None, print_finished_at=finished)
        await pt.record_plate_clear_confirmed(printer_id=1, confirmed_at=confirmed)
        await pt.record_next_print_started(printer_id=1, started_at=next_start)

        async with db_env() as db:
            rows = (await db.execute(select(PlateTurnaroundEvent))).scalars().all()

        assert len(rows) == 1
        row = rows[0]
        assert row.printer_id == 1
        assert row.print_finished_at == finished
        assert row.plate_clear_requested_at == finished
        assert row.plate_clear_confirmed_at == confirmed
        assert row.next_print_started_at == next_start
        # Derived, not stored: 20 minutes finish → confirmed.
        assert row.actual_clear_minutes == pytest.approx(20.0)
        # 2026-09-02 10:00 is a Wednesday inside staffed hours.
        assert row.within_staffed_hours is True

    @pytest.mark.asyncio
    async def test_start_stores_archive_id(self, db_env):
        await pt.start_plate_turnaround(printer_id=1, archive_id=None, print_finished_at=datetime(2026, 9, 2, 9, 0))
        async with db_env() as db:
            row = (await db.execute(select(PlateTurnaroundEvent))).scalar_one()
        assert row.archive_id is None
        assert row.next_print_started_at is None  # still open

    @pytest.mark.asyncio
    async def test_confirm_without_open_row_is_noop(self, db_env):
        await pt.record_plate_clear_confirmed(printer_id=1)
        async with db_env() as db:
            rows = (await db.execute(select(PlateTurnaroundEvent))).scalars().all()
        assert rows == []

    @pytest.mark.asyncio
    async def test_next_start_without_open_row_is_noop(self, db_env):
        await pt.record_next_print_started(printer_id=1)
        async with db_env() as db:
            rows = (await db.execute(select(PlateTurnaroundEvent))).scalars().all()
        assert rows == []

    @pytest.mark.asyncio
    async def test_confirm_updates_only_latest_open_row(self, db_env):
        first = datetime(2026, 9, 2, 8, 0)
        second = datetime(2026, 9, 2, 12, 0)
        await pt.start_plate_turnaround(printer_id=1, archive_id=None, print_finished_at=first)
        # Close the first turnaround so only the second stays open.
        await pt.record_next_print_started(printer_id=1, started_at=first + timedelta(minutes=30))
        await pt.start_plate_turnaround(printer_id=1, archive_id=None, print_finished_at=second)

        confirmed = second + timedelta(minutes=10)
        await pt.record_plate_clear_confirmed(printer_id=1, confirmed_at=confirmed)

        async with db_env() as db:
            rows = (await db.execute(select(PlateTurnaroundEvent).order_by(PlateTurnaroundEvent.id))).scalars().all()
        assert len(rows) == 2
        # First row was closed before confirmation → no confirmation stamped.
        assert rows[0].plate_clear_confirmed_at is None
        assert rows[0].next_print_started_at is not None
        # Second (open) row received the confirmation.
        assert rows[1].plate_clear_confirmed_at == confirmed

    @pytest.mark.asyncio
    async def test_default_timestamps_are_utc_now(self, db_env):
        before = datetime.now(timezone.utc).replace(tzinfo=None)
        await pt.start_plate_turnaround(printer_id=1, archive_id=None, print_finished_at=datetime.now(timezone.utc))
        await pt.record_plate_clear_confirmed(printer_id=1)
        async with db_env() as db:
            row = (await db.execute(select(PlateTurnaroundEvent))).scalar_one()
        assert row.plate_clear_confirmed_at is not None
        assert row.plate_clear_confirmed_at >= before


class TestQueueLifecycle:
    """created → dispatched → started for one queue item = one upserted row."""

    @pytest.mark.asyncio
    async def test_dispatch_then_start_single_row(self, db_env):
        created = datetime(2026, 9, 2, 9, 0)
        dispatched = datetime(2026, 9, 2, 9, 5)
        started = datetime(2026, 9, 2, 9, 6)

        await pt.record_queue_dispatched(queue_item_id=42, created_at=created, dispatched_at=dispatched)
        await pt.record_queue_started(queue_item_id=42, started_at=started)

        async with db_env() as db:
            rows = (await db.execute(select(QueueLifecycleEvent))).scalars().all()

        assert len(rows) == 1
        row = rows[0]
        assert row.queue_item_id == 42
        assert row.created_at == created
        assert row.dispatched_at == dispatched
        assert row.started_at == started

    @pytest.mark.asyncio
    async def test_started_before_dispatch_creates_row(self, db_env):
        started = datetime(2026, 9, 2, 9, 6)
        await pt.record_queue_started(queue_item_id=7, started_at=started)
        async with db_env() as db:
            row = (await db.execute(select(QueueLifecycleEvent))).scalar_one()
        assert row.queue_item_id == 7
        assert row.started_at == started
        assert row.dispatched_at is None

    @pytest.mark.asyncio
    async def test_dispatch_is_idempotent(self, db_env):
        created = datetime(2026, 9, 2, 9, 0)
        first_dispatch = datetime(2026, 9, 2, 9, 5)
        second_dispatch = datetime(2026, 9, 2, 9, 9)

        await pt.record_queue_dispatched(queue_item_id=1, created_at=created, dispatched_at=first_dispatch)
        await pt.record_queue_dispatched(queue_item_id=1, created_at=created, dispatched_at=second_dispatch)

        async with db_env() as db:
            rows = (await db.execute(select(QueueLifecycleEvent))).scalars().all()

        assert len(rows) == 1
        # First dispatch wins; re-dispatch does not overwrite.
        assert rows[0].dispatched_at == first_dispatch
