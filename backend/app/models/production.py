"""Production file-slot models: parts, printer instances, quantity slots, and revision history."""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base
from backend.app.models.library import LibraryFile, LibraryFolder

DEFAULT_PARTS = (
    ("TOP", "Top Housing"),
    ("BOT", "Bottom Housing"),
    ("KNB", "Knob"),
    ("BUT", "Button"),
)
PRODUCTION_PRINTER_MODELS = ("X1C", "A1M", "A1", "H2D", "H2S")
PRODUCTION_SECTION_NAME = "Production"

# A1 / A1 Mini do not print bottom housing or button.
DEFAULT_PART_CODES_BY_PRINTER: dict[str, tuple[str, ...]] = {
    "A1": ("TOP", "KNB"),
    "A1M": ("TOP", "KNB"),
    "X1C": ("TOP", "BOT", "KNB", "BUT"),
    "H2D": ("TOP", "BOT", "KNB", "BUT"),
    "H2S": ("TOP", "BOT", "KNB", "BUT"),
}


def default_part_codes_for_printer(printer_model: str) -> tuple[str, ...]:
    """Visible catalog codes for a printer folder before the user customizes."""
    return DEFAULT_PART_CODES_BY_PRINTER.get(
        printer_model,
        tuple(code for code, _ in DEFAULT_PARTS),
    )


class ProductionPart(Base):
    """Catalog part (e.g. TOP / Top Housing). ``code`` is stored uppercase."""

    __tablename__ = "production_parts"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    instances: Mapped[list["ProductionPartInstance"]] = relationship(
        back_populates="part",
        cascade="all, delete-orphan",
    )


class ProductionPartInstance(Base):
    """A catalog part bound to one printer model and its library folder."""

    __tablename__ = "production_part_instances"
    __table_args__ = (
        UniqueConstraint(
            "part_id",
            "printer_model",
            "folder_id",
            name="uq_production_part_instance_part_printer_folder",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    part_id: Mapped[int] = mapped_column(ForeignKey("production_parts.id", ondelete="CASCADE"))
    printer_model: Mapped[str] = mapped_column(String(32))
    folder_id: Mapped[int] = mapped_column(ForeignKey("library_folders.id", ondelete="CASCADE"))
    locked_parameters: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    part: Mapped["ProductionPart"] = relationship(back_populates="instances")
    folder: Mapped[LibraryFolder] = relationship()
    slots: Mapped[list["ProductionSlot"]] = relationship(
        back_populates="instance",
        cascade="all, delete-orphan",
    )


class ProductionSlot(Base):
    """Quantity variant of a part instance (1-up, 2-up, 4-up, ...)."""

    __tablename__ = "production_slots"
    __table_args__ = (UniqueConstraint("instance_id", "quantity", name="uq_production_slot_instance_quantity"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    instance_id: Mapped[int] = mapped_column(ForeignKey("production_part_instances.id", ondelete="CASCADE"))
    quantity: Mapped[int] = mapped_column(Integer)
    active_file_id: Mapped[int | None] = mapped_column(
        ForeignKey("library_files.id", ondelete="SET NULL"), nullable=True
    )
    major: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer)
    minor: Mapped[int] = mapped_column(Integer)
    parameter_overrides: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Per-contract-key explanations for the latest mismatch (key → note).
    parameter_notes: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    instance: Mapped["ProductionPartInstance"] = relationship(back_populates="slots")
    active_file: Mapped[LibraryFile | None] = relationship()
    revisions: Mapped[list["ProductionRevision"]] = relationship(
        back_populates="slot",
        cascade="all, delete-orphan",
    )


class ProductionRevision(Base):
    """Historical snapshot of a slot's active file and parameters."""

    __tablename__ = "production_revisions"

    id: Mapped[int] = mapped_column(primary_key=True)
    slot_id: Mapped[int] = mapped_column(ForeignKey("production_slots.id", ondelete="CASCADE"))
    library_file_id: Mapped[int | None] = mapped_column(
        ForeignKey("library_files.id", ondelete="SET NULL"), nullable=True
    )
    major: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer)
    minor: Mapped[int] = mapped_column(Integer)
    parameters: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    mismatch: Mapped[bool] = mapped_column(Boolean, default=False)
    accepted_new_baseline: Mapped[bool] = mapped_column(Boolean, default=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Per-contract-key explanations required when proceeding with mismatches.
    parameter_notes: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    slot: Mapped["ProductionSlot"] = relationship(back_populates="revisions")
    library_file: Mapped[LibraryFile | None] = relationship()
    created_by: Mapped["User | None"] = relationship()


from backend.app.models.user import User  # noqa: E402, F811
