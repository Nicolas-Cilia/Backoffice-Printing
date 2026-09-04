"""Stats 2 analytics events (Phase 1).

Two lightweight, append-then-update event tables that record *actual* timings
so Stats 2 can later validate the operator's configured expectations. Neither
table is a capacity input — they are measurement only.

``PlateTurnaroundEvent`` captures one print's full bed-turnaround: finish →
plate-clear requested → plate-clear confirmed → next print started. The derived
``actual_clear_minutes`` (confirmed − finished) is intentionally *not* stored;
it is computed on read so a corrected timestamp never leaves a stale duration
behind.

``QueueLifecycleEvent`` captures a queue item's wait profile: created →
dispatched → started, for queue-wait analytics.

``within_staffed_hours`` is computed on write. There is no OperatorSchedule
table yet (Phase 2); ``compute_within_staffed_hours`` in
``services/plate_turnaround.py`` is a weekday-08:00–17:00 stub and the column is
nullable so "unknown" stays distinguishable from "outside hours".
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base

SOURCE_LIVE = "live"
SOURCE_BACKFILL = "backfill"


class PlateTurnaroundEvent(Base):
    """One bed-turnaround measurement for a single finished print.

    A row is opened when a print finishes and the plate-clear gate is raised,
    updated when the operator confirms the plate is clear, and closed when the
    next print starts on the same printer. "Open" means ``next_print_started_at
    IS NULL``; the service layer updates the most recent open row per printer.

    ``source`` distinguishes live instrumentation (``live``) from optional
    historical backfill (``backfill``). Backfill rows are feedback-only — never
    capacity inputs.
    """

    __tablename__ = "plate_turnaround_events"
    __table_args__ = (
        # The hot lookup is "the open turnaround row for this printer", served by
        # printer_id + next_print_started_at (NULL = still open).
        Index("ix_plate_turnaround_printer_open", "printer_id", "next_print_started_at"),
        Index("ix_plate_turnaround_finished_at", "print_finished_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), nullable=False)
    # Nullable + SET NULL: a turnaround can outlive its archive (history purge),
    # and the finish callback occasionally can't resolve the archive at all.
    archive_id: Mapped[int | None] = mapped_column(ForeignKey("print_archives.id", ondelete="SET NULL"), nullable=True)

    # MQTT FINISH / archive completion time.
    print_finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # When the awaiting-plate-clear gate was raised (same moment as finish today).
    plate_clear_requested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # When the operator acknowledged the plate is clear.
    plate_clear_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # When the next print started on this printer — closes the turnaround.
    next_print_started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Whether print_finished_at fell inside staffed hours (computed on write).
    # Nullable: no OperatorSchedule table yet (Phase 2), so "unknown" is null.
    within_staffed_hours: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    # ``live`` (default) or ``backfill`` (historical approximation).
    source: Mapped[str] = mapped_column(String(16), default=SOURCE_LIVE, server_default=SOURCE_LIVE)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    @property
    def actual_clear_minutes(self) -> float | None:
        """Confirmed − finished, in minutes. Derived, never stored."""
        if self.plate_clear_confirmed_at is None or self.print_finished_at is None:
            return None
        return (self.plate_clear_confirmed_at - self.print_finished_at).total_seconds() / 60.0


class QueueLifecycleEvent(Base):
    """Wait-profile timestamps for one queue item: created → dispatched → started.

    One row per queue item (``queue_item_id`` is unique); the service layer
    upserts it at dispatch and stamps ``started_at`` when the print starts.
    ``queue_item_id`` is a bare integer rather than a foreign key so the analytics
    row survives the queue item's deletion (completed items are pruned).
    """

    __tablename__ = "queue_lifecycle_events"
    __table_args__ = (
        Index("ix_queue_lifecycle_item", "queue_item_id", unique=True),
        Index("ix_queue_lifecycle_created_at", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    queue_item_id: Mapped[int] = mapped_column(Integer, nullable=False)

    # When the queue item was created (copied from PrintQueueItem.created_at).
    created_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # When the scheduler claimed the item for dispatch.
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # When the print actually started.
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    recorded_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
