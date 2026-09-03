"""Recurring weekly "must be free" windows per printer (Stats 2 packing).

Each row reserves a wall-clock interval on one weekday for one printer. The
print-plan packer will not place a job whose ``[start, clear_end)`` overlaps an
enabled block. Same-day only (``start_time < end_time``); no overnight blocks.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class PrinterTimeBlock(Base):
    """One reserved free window on one weekday for one printer."""

    __tablename__ = "printer_time_blocks"
    __table_args__ = (
        Index("ix_printer_time_blocks_printer", "printer_id"),
        Index("ix_printer_time_blocks_day", "day_of_week"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    printer_id: Mapped[int] = mapped_column(Integer, ForeignKey("printers.id"), nullable=False)
    # 0 = Monday … 6 = Sunday (matches datetime.weekday()).
    day_of_week: Mapped[int] = mapped_column(Integer, nullable=False)
    # Wall-clock "HH:MM" (24h).
    start_time: Mapped[str] = mapped_column(String(5), nullable=False)
    end_time: Mapped[str] = mapped_column(String(5), nullable=False)
    label: Mapped[str | None] = mapped_column(String(128), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
