"""Unit tests for floor station session mechanics (``docs/floor-plan.md`` §2.4).

These cover the two composing rules and their interaction, which is the part
of phase 1b that is easy to get subtly wrong:

1. one open session per device, and
2. one open session per *exclusive* station, floor-wide.

The database's partial unique indexes are the real guard, so a few tests
assert against the DB rather than only the service return value — a service
that returned the right dataclass while leaving two open rows behind would
still be broken.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from backend.app.models.floor_session import FloorStationSession
from backend.app.services.floor_codes import station_for_slug
from backend.app.services.floor_sessions import (
    ScanResult,
    apply_station_scan,
    close_session_for_device,
    get_open_session_for_device,
    list_open_sessions,
    take_over,
)

DEVICE_A = "device-a"
DEVICE_B = "device-b"

WIP = station_for_slug("wip")
RECEIVE = station_for_slug("storage-receive")


async def _open_rows(db) -> list[FloorStationSession]:
    result = await db.execute(select(FloorStationSession).where(FloorStationSession.closed_at.is_(None)))
    return list(result.scalars())


class TestOpenCloseSwitch:
    @pytest.mark.asyncio
    async def test_scanning_an_idle_station_opens_it(self, db_session):
        outcome = await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()

        assert outcome.result is ScanResult.OPENED
        assert outcome.session is not None
        assert outcome.session.station_slug == "wip"
        assert outcome.session.device_id == DEVICE_A

    @pytest.mark.asyncio
    async def test_rescanning_the_same_station_closes_it(self, db_session):
        """The documented toggle (§5.1): the station's own QR ends the
        session, so a bench needs one label, not a separate 'close' code."""
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()

        outcome = await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()

        assert outcome.result is ScanResult.CLOSED
        assert outcome.session is None
        assert await _open_rows(db_session) == []

    @pytest.mark.asyncio
    async def test_scanning_a_different_station_switches(self, db_session):
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()

        outcome = await apply_station_scan(db_session, RECEIVE, DEVICE_A)
        await db_session.commit()

        assert outcome.result is ScanResult.SWITCHED
        assert outcome.previous is not None
        assert outcome.previous.station_slug == "wip"
        assert outcome.previous.closed_at is not None

        # Rule 1: the switch must leave exactly one open session, not two.
        rows = await _open_rows(db_session)
        assert len(rows) == 1
        assert rows[0].station_slug == "storage-receive"

    @pytest.mark.asyncio
    async def test_closing_is_a_write_not_a_delete(self, db_session):
        """The ledger references sessions by id (§6.2), so history has to
        survive a close."""
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()

        result = await db_session.execute(select(FloorStationSession))
        rows = list(result.scalars())
        assert len(rows) == 1
        assert rows[0].closed_at is not None

    @pytest.mark.asyncio
    async def test_reopening_after_a_close_creates_a_new_session(self, db_session):
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()
        first = (await get_open_session_for_device(db_session, DEVICE_A)).id

        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()
        outcome = await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()

        assert outcome.result is ScanResult.OPENED
        assert outcome.session.id != first


class TestFloorWideLock:
    @pytest.mark.asyncio
    async def test_second_device_is_refused_an_exclusive_station(self, db_session):
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()

        outcome = await apply_station_scan(db_session, WIP, DEVICE_B)
        await db_session.commit()

        assert outcome.result is ScanResult.LOCKED
        assert outcome.is_locked
        assert outcome.session is None
        # The refusal has to name the holder — that is what makes it
        # actionable rather than a dead end (§2.4).
        assert outcome.blocking is not None
        assert outcome.blocking.device_id == DEVICE_A

    @pytest.mark.asyncio
    async def test_a_refusal_changes_nothing(self, db_session):
        """§9: a refused scan is not a state change. The blocked device must
        not lose whatever it was already holding."""
        await apply_station_scan(db_session, RECEIVE, DEVICE_B)
        await db_session.commit()
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()

        # B, holding receive, is refused WIP.
        outcome = await apply_station_scan(db_session, WIP, DEVICE_B)
        await db_session.commit()

        assert outcome.result is ScanResult.LOCKED
        still = await get_open_session_for_device(db_session, DEVICE_B)
        assert still is not None
        assert still.station_slug == "storage-receive"

    @pytest.mark.asyncio
    async def test_a_locked_station_frees_up_when_the_holder_closes(self, db_session):
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()
        await apply_station_scan(db_session, WIP, DEVICE_A)  # close
        await db_session.commit()

        outcome = await apply_station_scan(db_session, WIP, DEVICE_B)
        await db_session.commit()
        assert outcome.result is ScanResult.OPENED

    @pytest.mark.asyncio
    async def test_different_exclusive_stations_do_not_block_each_other(self, db_session):
        """The lock is per station, not one session for the whole floor —
        otherwise a storage screen and a WIP screen could never coexist."""
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()

        outcome = await apply_station_scan(db_session, RECEIVE, DEVICE_B)
        await db_session.commit()

        assert outcome.result is ScanResult.OPENED
        assert len(await _open_rows(db_session)) == 2


class TestTakeover:
    @pytest.mark.asyncio
    async def test_takeover_closes_the_holder_and_opens_for_the_taker(self, db_session):
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()

        outcome = await take_over(db_session, WIP, DEVICE_B)
        await db_session.commit()

        assert outcome.result is ScanResult.OPENED
        assert outcome.session.device_id == DEVICE_B
        assert outcome.previous.device_id == DEVICE_A
        assert outcome.previous.closed_at is not None

        rows = await _open_rows(db_session)
        assert len(rows) == 1
        assert rows[0].device_id == DEVICE_B

    @pytest.mark.asyncio
    async def test_takeover_is_recorded_as_such(self, db_session):
        """So a stale-session takeover stays distinguishable from a normal
        close when the history is read back later."""
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()
        await take_over(db_session, WIP, DEVICE_B)
        await db_session.commit()

        result = await db_session.execute(
            select(FloorStationSession).where(FloorStationSession.device_id == DEVICE_A)
        )
        assert result.scalar_one().closed_by_takeover is True

    @pytest.mark.asyncio
    async def test_takeover_also_closes_the_takers_own_other_session(self, db_session):
        """Otherwise rule 1 breaks: the taker would hold two stations."""
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()
        await apply_station_scan(db_session, RECEIVE, DEVICE_B)
        await db_session.commit()

        await take_over(db_session, WIP, DEVICE_B)
        await db_session.commit()

        rows = await _open_rows(db_session)
        assert len(rows) == 1
        assert rows[0].device_id == DEVICE_B
        assert rows[0].station_slug == "wip"

    @pytest.mark.asyncio
    async def test_takeover_of_a_free_station_just_opens_it(self, db_session):
        outcome = await take_over(db_session, WIP, DEVICE_A)
        await db_session.commit()

        assert outcome.result is ScanResult.OPENED
        assert outcome.previous is None

    @pytest.mark.asyncio
    async def test_takeover_recovers_a_session_stranded_by_a_lost_device_id(self, db_session):
        """The likeliest v1 deadlock (§2.4): one PC clears localStorage, gets
        a new device id, and its own old session holds the station forever.
        Without takeover the only fix is editing the database by hand."""
        await apply_station_scan(db_session, WIP, "old-identity")
        await db_session.commit()

        blocked = await apply_station_scan(db_session, WIP, "new-identity")
        await db_session.commit()
        assert blocked.result is ScanResult.LOCKED

        recovered = await take_over(db_session, WIP, "new-identity")
        await db_session.commit()
        assert recovered.result is ScanResult.OPENED
        assert len(await _open_rows(db_session)) == 1


class TestOpenRace:
    @pytest.mark.asyncio
    async def test_losing_the_open_race_reads_as_a_normal_refusal(self, db_session, monkeypatch):
        """Two devices can clear the lock check simultaneously and both try to
        insert. The partial unique index is the real guard, so the loser must
        surface as `locked` — not a 500 — and must not leave its own previous
        session closed, since a refusal is defined as no state change (§9).

        Forced by stubbing the pre-check to miss the existing holder, which is
        exactly what a real interleaving looks like from the loser's side.
        """
        import backend.app.services.floor_sessions as svc

        # Device A holds WIP; device B is mid-switch from receive.
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()
        await apply_station_scan(db_session, RECEIVE, DEVICE_B)
        await db_session.commit()

        real_lookup = svc.get_open_session_for_station
        calls = {"n": 0}

        async def blind_first_call(db, station_slug):
            # First call is the pre-check (misses the holder, as in a race);
            # the post-IntegrityError call must still find them to report.
            calls["n"] += 1
            if calls["n"] == 1:
                return None
            return await real_lookup(db, station_slug)

        monkeypatch.setattr(svc, "get_open_session_for_station", blind_first_call)

        outcome = await svc.apply_station_scan(db_session, WIP, DEVICE_B)

        assert outcome.result is ScanResult.LOCKED
        assert outcome.session is None
        assert outcome.blocking is not None
        assert outcome.blocking.device_id == DEVICE_A

        # The rollback must have restored B's receive session: a refused scan
        # cannot cost the operator the station they were already holding.
        still = await get_open_session_for_device(db_session, DEVICE_B)
        assert still is not None
        assert still.station_slug == "storage-receive"

        # And A keeps WIP — exactly one open session per station.
        rows = await _open_rows(db_session)
        assert len(rows) == 2
        assert {r.station_slug for r in rows} == {"wip", "storage-receive"}


class TestCloseAndQueries:
    @pytest.mark.asyncio
    async def test_close_for_device_is_idempotent(self, db_session):
        """The on-screen close control must not error on a double click."""
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()

        assert await close_session_for_device(db_session, DEVICE_A) is not None
        await db_session.commit()
        assert await close_session_for_device(db_session, DEVICE_A) is None

    @pytest.mark.asyncio
    async def test_open_session_lookup_ignores_closed_rows(self, db_session):
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()
        await close_session_for_device(db_session, DEVICE_A)
        await db_session.commit()

        assert await get_open_session_for_device(db_session, DEVICE_A) is None

    @pytest.mark.asyncio
    async def test_list_open_sessions_returns_oldest_first(self, db_session):
        await apply_station_scan(db_session, WIP, DEVICE_A)
        await db_session.commit()
        first = await get_open_session_for_device(db_session, DEVICE_A)
        # Force a distinguishable ordering: sub-second inserts would otherwise
        # share a timestamp and make the assertion meaningless.
        first.opened_at = datetime.utcnow() - timedelta(hours=2)
        await db_session.commit()

        await apply_station_scan(db_session, RECEIVE, DEVICE_B)
        await db_session.commit()

        rows = await list_open_sessions(db_session)
        assert [r.device_id for r in rows] == [DEVICE_A, DEVICE_B]
