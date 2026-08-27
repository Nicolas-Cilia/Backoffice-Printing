"""Reusable KNB/BUT harvest bins and their append-only workflow history."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, func
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


class FloorBinBatchEvent(Base):
    """Append-only audit history for harvest, visual QC, and WIP intake."""

    __tablename__ = "floor_bin_batch_events"
    __table_args__ = (Index("ix_floor_bin_batch_events_batch_occurred", "batch_id", "occurred_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("floor_bin_batches.id", ondelete="CASCADE"), index=True)
    action: Mapped[str] = mapped_column(String(32))
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
