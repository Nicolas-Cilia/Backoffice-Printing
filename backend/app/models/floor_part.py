"""Labeled parts: one sticker enrolled to one physical part (docs/floor-plan.md §7).

A part row is written at harvest and never overwritten — §7.1's identity rule
("one code = one physical part forever") and §9's immutable job link both
mean this table only ever gains an `UPDATE` when a printer or archive it
points at is later deleted out from under it (see the FK notes below), never
when a sticker is re-scanned.

``archive_id`` is nullable by design (§7.2): a part is recorded even when the
printer has no finished job to bind to, so the physically-applied sticker is
never silently dropped by the app. Those rows are the needs-attention queue
(``floor_parts.list_needs_attention``).

**Deviation from the phase 8 contract on ``printer_id``:** the contract
specifies `NOT NULL`. Printers are hard-deletable (`DELETE /printers/{id}` in
``backend/app/api/routes/printers.py``), and that route already explicitly
orphans other child rows (archives, slot assignments, maintenance history)
rather than relying on the database to do it — this codebase runs on SQLite
by default, where `PRAGMA foreign_keys` is off (see
``backend/app/core/database.py``'s ``_normalize_filament_bucket_identity``
docstring), so an `ondelete` clause is enforced only on PostgreSQL and is
purely documentation on SQLite. A `NOT NULL` `printer_id` would force one of
two bad outcomes when its printer is deleted: cascade-deleting the part
(losing part history the contract explicitly wants to survive), or leaving a
permanently dangling id with no way to null it out without violating the
constraint. Making it nullable — and always set at write time in practice,
since every code path that creates a part row resolves a printer first —
lets ``delete_printer`` orphan it the same way it already orphans archives,
which is exactly the "does not cascade-delete part history" behavior the
contract asks for. See the matching change in
``backend/app/api/routes/printers.py``.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class FloorLabeledPart(Base):
    """One `BBD-` sticker, enrolled to a printer and (usually) a finished job."""

    __tablename__ = "floor_labeled_parts"
    __table_args__ = (
        Index("ix_floor_labeled_parts_archive", "archive_id"),
        Index("ix_floor_labeled_parts_printer", "printer_id"),
        Index("ix_floor_labeled_parts_labeled_at", "labeled_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # Normalized full payload (strip + uppercase), e.g. `BBD-000123`. Unique
    # forever: §7.1 says one code is one physical part, so a re-scan must
    # show the existing link rather than create a second row for it.
    sticker_code: Mapped[str] = mapped_column(String(32), unique=True, index=True)

    # Nullable — see the module docstring for why this deviates from the
    # phase 8 contract's `NOT NULL`. Always set at write time in practice:
    # every part-creating code path in `floor_parts.scan_part` resolves a
    # printer before writing.
    printer_id: Mapped[int | None] = mapped_column(ForeignKey("printers.id", ondelete="SET NULL"), nullable=True)
    # Null means "no finished job to bind to" (§7.2), not "unknown" — the
    # part is fully recorded either way. `ondelete="SET NULL"` matches
    # `print_archives.printer_id`'s own convention: deleting the archive
    # degrades the part to needs-attention rather than deleting it.
    archive_id: Mapped[int | None] = mapped_column(ForeignKey("print_archives.id", ondelete="SET NULL"), nullable=True)
    # Canonical Production part code (TOP/BOT/BUT/etc.) resolved from the
    # archived library file at link time. Null when that print is not mapped.
    part_code: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    # Exact Section Part whose parameters 3MF supplied the model thumbnail.
    # The code alone is not globally unique across library sections.
    section_part_id: Mapped[int | None] = mapped_column(
        ForeignKey("library_section_parts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Which harvest run enrolled this part. Audit only — nothing about a part
    # is ever blocked on its session still existing, which is why this is
    # nullable even though `floor_station_sessions` rows are never deleted
    # (only closed, per `floor_session.py`).
    session_id: Mapped[int | None] = mapped_column(
        ForeignKey("floor_station_sessions.id", ondelete="SET NULL"), nullable=True
    )

    # Part Assembly Linking (Wave 1): the KNB and BUT bin fills whose kit this
    # TOP part consumed one unit from when it entered Production WIP. Nullable
    # — set once at that WIP commit, and re-pointed by a kit reassign. Not a
    # cascade concern: ``ondelete="SET NULL"`` degrades a deleted bin fill to
    # "no kit recorded" rather than removing part history, the same convention
    # as ``printer_id``/``archive_id`` above.
    kit_knob_batch_id: Mapped[int | None] = mapped_column(
        ForeignKey("floor_bin_batches.id", ondelete="SET NULL"), nullable=True
    )
    kit_button_batch_id: Mapped[int | None] = mapped_column(
        ForeignKey("floor_bin_batches.id", ondelete="SET NULL"), nullable=True
    )
    kit_assigned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    labeled_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # Hidden from the active inventory view, never deleted. The event table
    # below records who/when/why so this remains an audit action.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    released_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class FloorPartEvent(Base):
    """Append-only history for a labeled physical part."""

    __tablename__ = "floor_part_events"
    __table_args__ = (Index("ix_floor_part_events_part_occurred", "part_id", "occurred_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    part_id: Mapped[int] = mapped_column(ForeignKey("floor_labeled_parts.id", ondelete="RESTRICT"), index=True)
    action: Mapped[str] = mapped_column(String(32))
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class FloorPrintStopReason(Base):
    """A reason attached to a recently stopped printer run from the Floor UI."""

    __tablename__ = "floor_print_stop_reasons"
    __table_args__ = (Index("ix_floor_print_stop_reasons_printer_stopped", "printer_id", "stopped_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    # Deliberately not a foreign key: print-log rows are independently
    # deletable, while this floor record should preserve the operator's reason.
    print_log_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    printer_id: Mapped[int] = mapped_column(Integer, index=True)
    archive_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    print_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    part_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reason_code: Mapped[str] = mapped_column(String(64))
    reason_text: Mapped[str | None] = mapped_column(String(500), nullable=True)
    stopped_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# Scan flow hardcodes ``BBF-other`` as the catch-all keyboard prompt for both
# Rework and discard, so that row cannot be removed from the catalog.
PROTECTED_ERROR_LABEL_SLUGS = frozenset({"other"})


class FloorErrorLabel(Base):
    """A user-managed ``BBF-…`` label used for both Rework and discard."""

    __tablename__ = "floor_error_labels"

    id: Mapped[int] = mapped_column(primary_key=True)
    # The suffix only; the printable/scannable value is always ``BBF-{slug}``.
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    @property
    def is_protected(self) -> bool:
        return self.slug in PROTECTED_ERROR_LABEL_SLUGS


class FloorDismissedBuildPlate(Base):
    """A completed job intentionally excluded from the Floor part backlog."""

    __tablename__ = "floor_dismissed_build_plates"

    id: Mapped[int] = mapped_column(primary_key=True)
    archive_id: Mapped[int] = mapped_column(
        ForeignKey("print_archives.id", ondelete="RESTRICT"), unique=True, index=True
    )
    dismissed_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
