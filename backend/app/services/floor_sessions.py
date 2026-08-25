"""Opening, closing, switching and taking over floor station sessions.

Implements the two composing rules from ``docs/floor-plan.md`` §2.4:

1. **One open session per device** — so scanning a new station QR closes the
   device's current session and opens the new one, atomically.
2. **One open session per exclusive station, floor-wide** — a second device
   scanning WIP / + Storage / Move / Harvest is refused and told who holds
   it. Cleanup is not exclusive and so is exempt.

Every outcome is returned as a :class:`ScanOutcome` rather than signalled by
exception, because the caller has to *render* the difference: opened, closed,
switched and refused are four different screens, and refusal in particular
carries the holder's identity and elapsed time so the operator can decide
whether to take over.

Closing is always an update, never a delete: the ledger references sessions
by id (§6.2), so session history has to survive.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import StrEnum

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.floor_session import FloorStationSession
from backend.app.services.floor_codes import FloorStation, station_for_slug

logger = logging.getLogger(__name__)


class ScanResult(StrEnum):
    """What a station scan did. Each maps to a distinct scan-page state."""

    OPENED = "opened"
    CLOSED = "closed"
    SWITCHED = "switched"
    # Refused by the floor-wide lock: another device holds this station.
    LOCKED = "locked"


@dataclass(frozen=True)
class ScanOutcome:
    """The result of applying one station scan."""

    result: ScanResult
    station: FloorStation
    # The session now open for this device, or None after a close/refusal.
    session: FloorStationSession | None = None
    # On CLOSED / SWITCHED: the session that was closed.
    previous: FloorStationSession | None = None
    # On LOCKED: the session blocking us, held by another device.
    blocking: FloorStationSession | None = None

    @property
    def is_locked(self) -> bool:
        return self.result is ScanResult.LOCKED


def _utcnow() -> datetime:
    """Naive UTC, matching the ``DateTime`` columns elsewhere in the schema."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def get_open_session_for_device(db: AsyncSession, device_id: str) -> FloorStationSession | None:
    """The session this device currently holds, if any."""
    result = await db.execute(
        select(FloorStationSession).where(
            FloorStationSession.device_id == device_id,
            FloorStationSession.closed_at.is_(None),
        )
    )
    return result.scalar_one_or_none()


async def get_open_session_for_station(db: AsyncSession, station_slug: str) -> FloorStationSession | None:
    """The session currently holding this station, if any.

    Only meaningful for exclusive stations — cleanup may have several open at
    once, in which case this returns an arbitrary one and callers should not
    be asking.
    """
    result = await db.execute(
        select(FloorStationSession)
        .where(
            FloorStationSession.station_slug == station_slug,
            FloorStationSession.closed_at.is_(None),
        )
        .order_by(FloorStationSession.opened_at)
    )
    return result.scalars().first()


async def list_open_sessions(db: AsyncSession) -> list[FloorStationSession]:
    """Every currently open session, **oldest first**.

    Oldest first is deliberate: the most likely reason to read this list is
    hunting a session nobody came back to, and that one is at the top.
    """
    result = await db.execute(
        select(FloorStationSession)
        .where(FloorStationSession.closed_at.is_(None))
        .order_by(FloorStationSession.opened_at)
    )
    return list(result.scalars())


async def list_recent_sessions(
    db: AsyncSession,
    *,
    hours: int = 24,
    limit: int = 50,
) -> list[FloorStationSession]:
    """Recently closed sessions, newest first.

    Available at all only because closing is a write rather than a delete
    (§2.4) — the history is a side effect of that choice, not extra
    bookkeeping. Answers "who had WIP open this morning", and shows which
    sessions ended in a takeover rather than a normal close.
    """
    since = _utcnow() - timedelta(hours=hours)
    result = await db.execute(
        select(FloorStationSession)
        .where(
            FloorStationSession.closed_at.is_not(None),
            FloorStationSession.closed_at >= since,
        )
        .order_by(FloorStationSession.closed_at.desc())
        .limit(limit)
    )
    return list(result.scalars())


async def close_session_by_id(db: AsyncSession, session_id: int) -> FloorStationSession | None:
    """Close one session by id, whichever device holds it.

    The escape hatch for a session nobody is going back to — distinct from
    :func:`close_session_for_device`, which only ever closes the caller's
    own. Returns None if the id is unknown *or already closed*, so a
    double-click cannot resurrect and re-close a row.
    """
    result = await db.execute(
        select(FloorStationSession).where(
            FloorStationSession.id == session_id,
            FloorStationSession.closed_at.is_(None),
        )
    )
    session = result.scalar_one_or_none()
    if session is None:
        return None
    _close(session)
    await db.flush()
    logger.info("Session %s (%s) closed from the sessions view", session_id, session.station_slug)
    return session


def _close(session: FloorStationSession, *, by_takeover: bool = False) -> None:
    session.closed_at = _utcnow()
    session.closed_by_takeover = by_takeover


async def _open(db: AsyncSession, station: FloorStation, device_id: str) -> FloorStationSession:
    session = FloorStationSession(
        station_slug=station.slug,
        device_id=device_id,
        exclusive=station.exclusive,
    )
    db.add(session)
    await db.flush()
    return session


async def apply_station_scan(
    db: AsyncSession,
    station: FloorStation,
    device_id: str,
) -> ScanOutcome:
    """Apply one station-QR scan for ``device_id``.

    - Same station this device already holds → **close** it (the documented
      toggle: scanning a station's QR again ends the session, §5.1).
    - A different station → **switch**, unless the target is locked.
    - Nothing open → **open**, unless the target is locked.

    Does not commit; the caller owns the transaction so a scan that also
    writes stock stays atomic with the session change.
    """
    current = await get_open_session_for_device(db, device_id)

    # Toggle close. Checked before the lock, since a device closing its own
    # session can never be blocked by itself.
    if current is not None and current.station_slug == station.slug:
        _close(current)
        await db.flush()
        return ScanOutcome(result=ScanResult.CLOSED, station=station, previous=current)

    if station.exclusive:
        blocking = await get_open_session_for_station(db, station.slug)
        if blocking is not None and blocking.device_id != device_id:
            # No state change (§9): the operator is told who holds it and may
            # take over explicitly.
            return ScanOutcome(result=ScanResult.LOCKED, station=station, blocking=blocking)

    previous = current
    if previous is not None:
        _close(previous)
        await db.flush()

    try:
        session = await _open(db, station, device_id)
    except IntegrityError:
        # Lost a race against another device between the check above and the
        # insert. The partial unique index is the real guard; surface it as a
        # normal refusal rather than a 500.
        await db.rollback()
        blocking = await get_open_session_for_station(db, station.slug)
        logger.info("Station %s lost open race for device %s", station.slug, device_id)
        return ScanOutcome(result=ScanResult.LOCKED, station=station, blocking=blocking)

    return ScanOutcome(
        result=ScanResult.SWITCHED if previous is not None else ScanResult.OPENED,
        station=station,
        session=session,
        previous=previous,
    )


async def take_over(db: AsyncSession, station: FloorStation, device_id: str) -> ScanOutcome:
    """Close whoever holds ``station`` and open it for ``device_id``.

    The recovery path for a session nobody is coming back to (§2.4). Also the
    only way out when a device loses its own identity — cleared
    ``localStorage`` leaves a session open under an id no browser will
    present again, which would otherwise hold the station forever.

    Takeover is unconditional by design: there is no "is it really stale"
    test, because no such test exists that an operator standing at the screen
    could not answer better from the elapsed time.
    """
    holder = await get_open_session_for_station(db, station.slug) if station.exclusive else None

    # The taking device's own session (on some other station) has to close
    # too, or rule 1 would be violated.
    current = await get_open_session_for_device(db, device_id)
    if current is not None and (holder is None or current.id != holder.id):
        _close(current)

    if holder is not None:
        _close(holder, by_takeover=True)

    await db.flush()
    session = await _open(db, station, device_id)

    logger.info(
        "Device %s took over station %s (was held by %s)",
        device_id,
        station.slug,
        holder.device_id if holder else "nobody",
    )
    return ScanOutcome(
        result=ScanResult.OPENED,
        station=station,
        session=session,
        previous=holder,
    )


async def close_session_for_device(db: AsyncSession, device_id: str) -> FloorStationSession | None:
    """Close whatever this device holds. Returns the closed session, or None."""
    current = await get_open_session_for_device(db, device_id)
    if current is None:
        return None
    _close(current)
    await db.flush()
    return current


def resolve_station(slug: str) -> FloorStation | None:
    """Station for a slug, or None. Thin pass-through so callers in this
    module's vocabulary do not have to reach into the catalog."""
    return station_for_slug(slug)


__all__ = [
    "ScanResult",
    "ScanOutcome",
    "apply_station_scan",
    "take_over",
    "close_session_for_device",
    "get_open_session_for_device",
    "get_open_session_for_station",
    "list_open_sessions",
    "list_recent_sessions",
    "close_session_by_id",
    "resolve_station",
]
