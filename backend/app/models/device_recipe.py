"""Stats 2 (Phase 2) device bill-of-materials.

A *device* is one finished product. Its BOM is expressed against the same
``ProductionPart`` catalog (TOP / BOT / KNB / BUT) used for parameter locks —
NOT against a hand-picked 3MF file. Each ``DeviceRecipeLine`` says "a device
needs ``qty_per_device`` of this part". Which concrete production slot (1-up /
2-up / …) is used to make that part is a *discovery* concern resolved at read
time from the part's active ``ProductionSlot`` rows; a line may pin a preferred
slot via ``preferred_slot_id`` but is not required to.

Phase 2 ships a single-recipe singleton (one "Default Device"). Multiple named
recipes / variant-compare capacity math are Phase 3.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base


class DeviceRecipe(Base):
    """A named device bill-of-materials (Phase 2 uses a single default row)."""

    __tablename__ = "device_recipes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False, default="Default Device")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    lines: Mapped[list["DeviceRecipeLine"]] = relationship(
        back_populates="recipe",
        cascade="all, delete-orphan",
    )


class DeviceRecipeLine(Base):
    """One part requirement in a device recipe: ``qty_per_device`` of a part."""

    __tablename__ = "device_recipe_lines"
    __table_args__ = (UniqueConstraint("recipe_id", "part_id", name="uq_device_recipe_line_recipe_part"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("device_recipes.id", ondelete="CASCADE"), nullable=False)
    part_id: Mapped[int] = mapped_column(ForeignKey("production_parts.id", ondelete="CASCADE"), nullable=False)
    qty_per_device: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    # Optional operator override: pin a specific production slot for this part
    # instead of letting discovery recommend one. SET NULL so deleting a slot
    # just clears the override rather than orphaning the line.
    preferred_slot_id: Mapped[int | None] = mapped_column(
        ForeignKey("production_slots.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    recipe: Mapped["DeviceRecipe"] = relationship(back_populates="lines")
    part: Mapped["ProductionPart"] = relationship()
    preferred_slot: Mapped["ProductionSlot | None"] = relationship()


from backend.app.models.production import ProductionPart, ProductionSlot  # noqa: E402, F811
