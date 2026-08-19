"""Profile part-section models: user-named sections, per-printer process slots, replace history."""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base
from backend.app.models.local_preset import LocalPreset


class ProfilePartSection(Base):
    """User-named grouping of process presets that share one print-settings contract."""

    __tablename__ = "profile_part_sections"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    locked_parameters: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    slots: Mapped[list["ProfilePartSlot"]] = relationship(
        back_populates="section",
        cascade="all, delete-orphan",
    )


class ProfilePartSlot(Base):
    """One process preset per printer inside a part section."""

    __tablename__ = "profile_part_slots"
    __table_args__ = (UniqueConstraint("section_id", "printer_model", name="uq_profile_part_slot_section_printer"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    section_id: Mapped[int] = mapped_column(ForeignKey("profile_part_sections.id", ondelete="CASCADE"))
    printer_model: Mapped[str] = mapped_column(String(32))
    active_preset_id: Mapped[int | None] = mapped_column(
        ForeignKey("local_presets.id", ondelete="SET NULL"), nullable=True
    )
    parameter_overrides: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    last_mismatch: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    section: Mapped["ProfilePartSection"] = relationship(back_populates="slots")
    active_preset: Mapped[LocalPreset | None] = relationship()
    revisions: Mapped[list["ProfilePartRevision"]] = relationship(
        back_populates="slot",
        cascade="all, delete-orphan",
    )


class ProfilePartRevision(Base):
    """Historical snapshot of a slot replace (or first attach)."""

    __tablename__ = "profile_part_revisions"

    id: Mapped[int] = mapped_column(primary_key=True)
    slot_id: Mapped[int] = mapped_column(ForeignKey("profile_part_slots.id", ondelete="CASCADE"))
    local_preset_id: Mapped[int | None] = mapped_column(
        ForeignKey("local_presets.id", ondelete="SET NULL"), nullable=True
    )
    parameters: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    mismatch: Mapped[bool] = mapped_column(Boolean, default=False)
    accepted_new_baseline: Mapped[bool] = mapped_column(Boolean, default=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    slot: Mapped["ProfilePartSlot"] = relationship(back_populates="revisions")
    local_preset: Mapped[LocalPreset | None] = relationship()
