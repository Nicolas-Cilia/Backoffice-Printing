"""Reusable KNB/BUT harvest bins, BOT member bins, and append-only workflow history."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class FloorBinBatch(Base):
    """One quantity harvested into a shared reusable bin."""

    __tablename__ = "floor_bin_batches"
    __table_args__ = (
        Index("ix_floor_bin_batches_payload_harvested", "bin_payload", "harvested_at"),
        Index("ix_floor_bin_batches_printer", "printer_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    bin_payload: Mapped[str] = mapped_column(String(64), index=True)
    printer_id: Mapped[int | None] = mapped_column(ForeignKey("printers.id", ondelete="SET NULL"), nullable=True)
    archive_id: Mapped[int | None] = mapped_column(ForeignKey("print_archives.id", ondelete="SET NULL"), nullable=True)
    part_code: Mapped[str] = mapped_column(String(3))
    quantity: Mapped[int] = mapped_column(Integer)
    session_id: Mapped[int | None] = mapped_column(
        ForeignKey("floor_station_sessions.id", ondelete="SET NULL"), nullable=True
    )
    harvested_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # Hidden from the active Part history filters, never deleted by archive.
    # An archived fill is skipped by `_latest_batch`, so the physical bin QR
    # is free to harvest again without destroying the record.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Stats 2 (Phase 2) silent expected-quantity variance snapshot. Resolved at
    # harvest time from the source production filename (or a fallback) and
    # frozen on the row — measurement only, never blocks the harvest. See
    # ``services/expected_quantity.py`` and ``services/harvest_variance.py``.
    expected_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Where ``expected_quantity`` came from: "filename" | "production_slot" | "default".
    expected_quantity_source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # harvested quantity − expected_quantity (signed). NULL when expected unknown.
    quantity_variance: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Optional, skippable operator note explaining a variance. Never required.
    variance_reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class FloorBinBatchEvent(Base):
    """Append-only audit history for harvest, visual QC, and WIP intake."""

    __tablename__ = "floor_bin_batch_events"
    __table_args__ = (Index("ix_floor_bin_batch_events_batch_occurred", "batch_id", "occurred_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("floor_bin_batches.id", ondelete="CASCADE"), index=True)
    action: Mapped[str] = mapped_column(String(32))
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class FloorBotBinMember(Base):
    """One BBD- bottom housed in a shared BOT bin fill."""

    __tablename__ = "floor_bot_bin_members"
    __table_args__ = (
        Index("ix_floor_bot_bin_members_batch", "batch_id"),
        UniqueConstraint("part_id", name="uq_floor_bot_bin_members_part_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("floor_bin_batches.id", ondelete="CASCADE"), index=True)
    part_id: Mapped[int] = mapped_column(ForeignKey("floor_labeled_parts.id", ondelete="CASCADE"), index=True)
    added_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
