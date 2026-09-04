"""Stats 2 (Phase 1) recording helpers: plate turnaround + queue lifecycle.

These are measurement-only helpers that append/update the analytics event rows
defined in ``models/stats_events.py``. Nothing here is read back as a scheduler
capacity input — the sole purpose is to capture *actual* timings so a later
phase can validate the operator's configured expectations
("cleanup target vs reality").

Every helper is best-effort and fire-and-forget: it opens its own DB session
and swallows its own errors so a stats write can never break the print
lifecycle it hangs off of. Each targets the most recent *open* turnaround row
per printer (``next_print_started_at IS NULL``) or upserts one queue-lifecycle
row per ``queue_item_id``.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select

from backend.app.core.database import async_session
from backend.app.models.stats_events import PlateTurnaroundEvent, QueueLifecycleEvent

logger = logging.getLogger(__name__)

# Fallback staffed-hours stub when OperatorSchedule has no enabled rows.
_STAFFED_START_HOUR = 8
_STAFFED_END_HOUR = 17


def _utcnow() -> datetime:
    """Naive UTC now, matching how DateTime columns are stored on SQLite."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def compute_within_staffed_hours(when: datetime | None) -> bool | None:
    """Whether ``when`` falls inside staffed hours (sync fallback stub).

    Prefer ``compute_within_staffed_hours_async`` when a DB session is available
    so OperatorSchedule is consulted. This sync helper keeps the Phase 1
    weekday 08:00–17:00 behaviour for callers that cannot await.
    """
    if when is None:
        return None
    if when.weekday() >= 5:  # Saturday / Sunday
        return False
    return _STAFFED_START_HOUR <= when.hour < _STAFFED_END_HOUR


async def compute_within_staffed_hours_async(when: datetime | None) -> bool | None:
    """Async staffed-hours check using OperatorSchedule when configured."""
    if when is None:
        return None
    try:
        from backend.app.services.operator_schedule_service import within_staffed_hours

        async with async_session() as db:
            return await within_staffed_hours(db, when)
    except Exception:
        logger.debug("staffed-hours schedule lookup failed; using stub", exc_info=True)
        return compute_within_staffed_hours(when)


async def _latest_open_turnaround(db, printer_id: int) -> PlateTurnaroundEvent | None:
    result = await db.execute(
        select(PlateTurnaroundEvent)
        .where(PlateTurnaroundEvent.printer_id == printer_id)
        .where(PlateTurnaroundEvent.next_print_started_at.is_(None))
        .order_by(
            PlateTurnaroundEvent.print_finished_at.desc(),
            PlateTurnaroundEvent.id.desc(),
        )
        .limit(1)
    )
    return result.scalar_one_or_none()


async def start_plate_turnaround(
    printer_id: int,
    archive_id: int | None,
    print_finished_at: datetime,
) -> None:
    """Open a turnaround row when a print finishes and the plate-clear gate rises.

    ``plate_clear_requested_at`` is stamped equal to ``print_finished_at`` (they
    coincide today) and ``within_staffed_hours`` is computed on write.
    """
    try:
        async with async_session() as db:
            from backend.app.services.operator_schedule_service import within_staffed_hours

            try:
                within = await within_staffed_hours(db, print_finished_at)
            except Exception:
                within = compute_within_staffed_hours(print_finished_at)
            db.add(
                PlateTurnaroundEvent(
                    printer_id=printer_id,
                    archive_id=archive_id,
                    print_finished_at=print_finished_at,
                    plate_clear_requested_at=print_finished_at,
                    within_staffed_hours=within,
                    source="live",
                )
            )
            await db.commit()
    except Exception:
        logger.warning("start_plate_turnaround failed for printer %s", printer_id, exc_info=True)


async def record_plate_clear_confirmed(
    printer_id: int,
    confirmed_at: datetime | None = None,
) -> None:
    """Stamp the operator's plate-clear ack on the latest open row. No-op if none."""
    try:
        async with async_session() as db:
            row = await _latest_open_turnaround(db, printer_id)
            if row is None:
                return
            row.plate_clear_confirmed_at = confirmed_at or _utcnow()
            await db.commit()
    except Exception:
        logger.warning("record_plate_clear_confirmed failed for printer %s", printer_id, exc_info=True)


async def record_next_print_started(
    printer_id: int,
    started_at: datetime | None = None,
) -> None:
    """Close the latest open row with the next print's start time. No-op if none."""
    try:
        async with async_session() as db:
            row = await _latest_open_turnaround(db, printer_id)
            if row is None:
                return
            row.next_print_started_at = started_at or _utcnow()
            await db.commit()
    except Exception:
        logger.warning("record_next_print_started failed for printer %s", printer_id, exc_info=True)


async def _queue_lifecycle_row(db, queue_item_id: int) -> QueueLifecycleEvent | None:
    result = await db.execute(
        select(QueueLifecycleEvent).where(QueueLifecycleEvent.queue_item_id == queue_item_id).limit(1)
    )
    return result.scalar_one_or_none()


async def record_queue_dispatched(
    queue_item_id: int,
    created_at: datetime | None = None,
    dispatched_at: datetime | None = None,
) -> None:
    """Record a queue item's dispatch claim. Idempotent — first dispatch wins."""
    try:
        async with async_session() as db:
            row = await _queue_lifecycle_row(db, queue_item_id)
            if row is not None:
                # Already recorded: don't overwrite the original dispatch time.
                return
            db.add(
                QueueLifecycleEvent(
                    queue_item_id=queue_item_id,
                    created_at=created_at,
                    dispatched_at=dispatched_at or _utcnow(),
                )
            )
            await db.commit()
    except Exception:
        logger.warning("record_queue_dispatched failed for queue item %s", queue_item_id, exc_info=True)


async def record_queue_started(
    queue_item_id: int,
    started_at: datetime | None = None,
) -> None:
    """Stamp a queue item's print-start, creating the row if dispatch never landed."""
    try:
        async with async_session() as db:
            row = await _queue_lifecycle_row(db, queue_item_id)
            if row is None:
                db.add(
                    QueueLifecycleEvent(
                        queue_item_id=queue_item_id,
                        started_at=started_at or _utcnow(),
                    )
                )
            else:
                row.started_at = started_at or _utcnow()
            await db.commit()
    except Exception:
        logger.warning("record_queue_started failed for queue item %s", queue_item_id, exc_info=True)
