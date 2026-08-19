from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class FilamentColorBucket(Base):
    """On-hand stock for one named product (e.g. EasyRock White PLA).

    This is not a physical spool and does not store remaining grams on a
    specific AMS RFID. Printer slots point here so prints subtract from
    the assigned product.
    """

    __tablename__ = "filament_color_buckets"
    __table_args__ = (
        UniqueConstraint(
            "color_name",
            "material",
            "brand",
            "subtype",
            "extra_colors",
            "effect_type",
            name="uq_filament_color_bucket",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    color_name: Mapped[str] = mapped_column(String(100))
    material: Mapped[str] = mapped_column(String(50))
    brand: Mapped[str | None] = mapped_column(String(100))
    subtype: Mapped[str | None] = mapped_column(String(50))
    extra_colors: Mapped[str | None] = mapped_column(String(255))
    effect_type: Mapped[str | None] = mapped_column(String(20))
    color_hex: Mapped[str | None] = mapped_column(String(9))
    on_hand_grams: Mapped[float] = mapped_column(Float, default=0)
    spool_weight_grams: Mapped[float] = mapped_column(Float, default=1000)
    cost_per_kg: Mapped[float | None] = mapped_column(Float, nullable=True)
    lead_time_days: Mapped[int] = mapped_column(default=7)
    stock_initialized: Mapped[bool] = mapped_column(Boolean, default=False)
    tracking_started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class FilamentColorUsage(Base):
    """Grams removed from (or added to) a color + material bucket."""

    __tablename__ = "filament_color_usage"
    __table_args__ = (UniqueConstraint("source_key", name="uq_filament_color_usage_source"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    bucket_id: Mapped[int] = mapped_column(ForeignKey("filament_color_buckets.id", ondelete="CASCADE"))
    grams: Mapped[float] = mapped_column(Float)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    kind: Mapped[str] = mapped_column(String(20), default="completed")
    progress: Mapped[float | None] = mapped_column(Float, nullable=True)
    archive_id: Mapped[int | None] = mapped_column(ForeignKey("print_archives.id", ondelete="SET NULL"))
    printer_id: Mapped[int | None] = mapped_column(ForeignKey("printers.id", ondelete="SET NULL"))
    print_name: Mapped[str | None] = mapped_column(String(500))
    source_key: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class FilamentSlotAssignment(Base):
    """Which tracking product is loaded in a printer AMS/external slot."""

    __tablename__ = "filament_slot_assignments"
    __table_args__ = (
        UniqueConstraint("printer_id", "ams_id", "tray_id", name="uq_filament_slot_assignment"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"))
    ams_id: Mapped[int] = mapped_column()
    tray_id: Mapped[int] = mapped_column()
    bucket_id: Mapped[int] = mapped_column(ForeignKey("filament_color_buckets.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
