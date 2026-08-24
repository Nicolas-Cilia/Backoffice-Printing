"""Floor station sessions: who currently holds which station (docs/floor-plan.md §2.4).

A session is an **exclusive claim on a station**, which is why it lives here
rather than in the browser: a lock only means anything if every device can
see it. The client reads this table; it does not own the state.

Two rules are enforced, both by partial unique indexes rather than by
application checks alone, so a race cannot open two sessions that the
business rules forbid:

1. **One open session per device.** A device is in exactly one station mode
   at a time, or none. Station switching is close-then-open in a single
   transaction.
2. **One open session per station, floor-wide — for exclusive stations.**
   WIP, + Storage, Move and Harvest are each held by at most one device.
   Cleanup is not exclusive, so several devices may hold it at once.

``exclusive`` is denormalized from the station catalog
(``services/floor_codes.FloorStation.exclusive``) at open time. The catalog
stays the single source of truth for *which* stations lock; this column
exists so the constraint can be expressed as an index without hardcoding a
slug like ``!= 'cleanup'`` into the schema, where it would silently drift
from the catalog.

Later phases extend the session rather than replacing it: harvest (phase 8)
binds a printer to the open session, and Move (phase 5) hangs its queued kg
off ``session_id``. Both are additive.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, String, func, text
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class FloorStationSession(Base):
    """One open (or historical) claim on a floor station by one device."""

    __tablename__ = "floor_station_sessions"
    __table_args__ = (
        # Rule 2: one open session per exclusive station, floor-wide.
        # Cleanup rows carry exclusive=False and so are exempt.
        Index(
            "uq_floor_session_open_station",
            "station_slug",
            unique=True,
            sqlite_where=text("closed_at IS NULL AND exclusive = 1"),
            postgresql_where=text("closed_at IS NULL AND exclusive"),
        ),
        # Rule 1: one open session per device, every station including
        # cleanup. This is what stops one machine holding two sessions —
        # and therefore what stops two pistols on one screen from being
        # treated as two independent benches (§5.5).
        Index(
            "uq_floor_session_open_device",
            "device_id",
            unique=True,
            sqlite_where=text("closed_at IS NULL"),
            postgresql_where=text("closed_at IS NULL"),
        ),
        # Lookups are almost always "the open row for this device" or "the
        # open row for this station"; both are served by the indexes above.
        Index("ix_floor_session_opened_at", "opened_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    station_slug: Mapped[str] = mapped_column(String(64), index=True)
    # Stable per machine and browser profile, generated client-side and kept
    # in localStorage. An identity for the lock, not a security boundary —
    # never trust it for authorization.
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    exclusive: Mapped[bool] = mapped_column(Boolean, default=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # NULL means open. Closing is always a write, never a delete, so the
    # history of who held what survives for the audit trail the ledger
    # references by session id (§6.2).
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    # Set when another device took this session over, so a stale-session
    # takeover is distinguishable from a normal close after the fact.
    closed_by_takeover: Mapped[bool] = mapped_column(Boolean, default=False)

    @property
    def is_open(self) -> bool:
        return self.closed_at is None
