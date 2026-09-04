"""Stats 2 (Phase 2) staffing model: a weekly template of operator shifts.

``OperatorSchedule`` replaces the Phase 1 weekday-08:00–17:00 stub used by
``services/plate_turnaround.compute_within_staffed_hours``. Each row is one
shift on one weekday (``day_of_week`` 0 = Monday … 6 = Sunday), expressed as
``HH:MM`` wall-clock ``start_time``/``end_time`` strings plus how many
operators staff it. A day may have several rows (e.g. a split shift). When no
enabled rows exist the service falls back to the Phase 1 stub so "no config"
never means "never staffed".

The global line-start / clear-minutes / buffer knobs live in the key-value
``settings`` table (see ``services/stats2_config.py``) rather than here — this
table is purely the weekly staffing template.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class OperatorSchedule(Base):
    """One staffed shift on one weekday in the weekly template."""

    __tablename__ = "operator_schedules"
    __table_args__ = (Index("ix_operator_schedules_day", "day_of_week"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # 0 = Monday … 6 = Sunday (matches datetime.weekday()).
    day_of_week: Mapped[int] = mapped_column(Integer, nullable=False)
    # Wall-clock "HH:MM" (24h) in ``timezone``.
    start_time: Mapped[str] = mapped_column(String(5), nullable=False)
    end_time: Mapped[str] = mapped_column(String(5), nullable=False)
    operator_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    # IANA timezone name (e.g. "UTC", "Europe/Paris"). Free-form; the effective
    # endpoint interprets shift times in this zone. Empty means server-local.
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="UTC", server_default="UTC")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
