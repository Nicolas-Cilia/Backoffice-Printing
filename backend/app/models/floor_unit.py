"""Product units: one bought serial linked to a TOP + BOT housing pair.

Part Assembly Linking (docs/floor-workflow.md, Wave 2). A ``FloorProductUnit``
row is the assembled product: a scanned product serial (``XG2SNP`` — six
alphanumeric, no hyphen, at least one letter) bound to exactly one TOP labeled
part and one BOT labeled part. Both housings are marked ``shipped`` the moment
the unit is written; the pair's provenance (which knob/button kit the TOP drew)
is read back through the TOP part's ``kit_knob_batch_id`` / ``kit_button_batch_id``.

The row is deliberately thin — serial + the two part FKs + when. The audit
trail (``unit_linked`` / ``shipped`` / ``unit_unlinked``) lives on the existing
``floor_part_events`` history for each housing, so a part's full life is still
readable from one place. Unlink deletes this row (freeing the serial and both
stickers) and restores both parts to ``wip`` with an audit event, so a pair can
be corrected and linked again.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class FloorProductUnit(Base):
    """One product serial linked to a TOP + BOT labeled-part pair."""

    __tablename__ = "floor_product_units"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Normalized product serial (strip + uppercase), e.g. ``XG2SNP``. Unique
    # forever: a serial identifies one physical product, so a re-scan is a
    # lookup of the existing unit, never a second row.
    serial_code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    # Each housing belongs to at most one unit — the unique constraints are the
    # database-level "no double-link" guard behind the service's own check.
    # ``ondelete="RESTRICT"`` matches ``floor_part_events`` — a part on a unit
    # cannot be deleted out from under it; unlink is the sanctioned removal.
    top_part_id: Mapped[int] = mapped_column(
        ForeignKey("floor_labeled_parts.id", ondelete="RESTRICT"), unique=True, index=True
    )
    bottom_part_id: Mapped[int] = mapped_column(
        ForeignKey("floor_labeled_parts.id", ondelete="RESTRICT"), unique=True, index=True
    )
    linked_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
