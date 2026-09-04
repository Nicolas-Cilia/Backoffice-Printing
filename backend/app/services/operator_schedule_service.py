"""Stats 2 (Phase 2) operator-schedule service: CRUD + effective staffed hours.

Replaces the Phase 1 weekday-08:00–17:00 stub with a real weekly template of
``OperatorSchedule`` shifts. When the template is empty the pure
``stub_within_staffed_hours`` fallback is used, so "no config" never means
"never staffed". Shift wall-clock times are interpreted in each shift's own
IANA ``timezone`` (UTC fallback).

``get_effective_schedule`` resolves one calendar day into merged staffed windows
plus the global line-start / ready-deadline / clear-minutes knobs for the
settings UI. Nothing here is a capacity input.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.operator_schedule import OperatorSchedule
from backend.app.services.stats2_config import (
    DEFAULT_TIMEZONE,
    get_stats2_globals,
    hhmm_to_minutes,
    minutes_to_hhmm,
    ready_deadline_hhmm,
    resolve_timezone_name,
)

try:  # stdlib on 3.9+, guard so an odd runtime can't break imports.
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

_STUB_START_HOUR = 8
_STUB_END_HOUR = 17


class ScheduleShiftIn(BaseModel):
    """One shift in a submitted weekly template."""

    day_of_week: int = Field(ge=0, le=6)
    start_time: str
    end_time: str
    operator_count: int = Field(default=1, ge=1)
    timezone: str = "UTC"
    enabled: bool = True


@dataclass
class EffectiveSchedule:
    """Resolved staffing + global knobs for one calendar day."""

    date: str
    day_of_week: int
    is_staffed: bool
    shifts: list[dict]
    windows: list[dict]
    peak_operator_count: int
    total_staffed_minutes: int
    staffed_now: bool | None
    line_start_time: str
    ready_deadline_time: str
    expected_plate_clear_minutes: int
    pre_line_buffer_minutes: int
    timezone: str
    using_default_stub: bool = False

    def to_dict(self) -> dict:
        return {
            "date": self.date,
            "day_of_week": self.day_of_week,
            "is_staffed": self.is_staffed,
            "shifts": self.shifts,
            "windows": self.windows,
            "peak_operator_count": self.peak_operator_count,
            "total_staffed_minutes": self.total_staffed_minutes,
            "staffed_now": self.staffed_now,
            "line_start_time": self.line_start_time,
            "ready_deadline_time": self.ready_deadline_time,
            "expected_plate_clear_minutes": self.expected_plate_clear_minutes,
            "pre_line_buffer_minutes": self.pre_line_buffer_minutes,
            "timezone": self.timezone,
            "using_default_stub": self.using_default_stub,
        }


def stub_within_staffed_hours(when: datetime | None) -> bool | None:
    """Phase 1 fallback: weekdays (Mon–Fri) 08:00 (incl.) to 17:00 (excl.)."""
    if when is None:
        return None
    if when.weekday() >= 5:
        return False
    return _STUB_START_HOUR <= when.hour < _STUB_END_HOUR


def _local_when(when: datetime, tzname: str | None) -> datetime:
    """Return ``when`` as naive wall-clock in ``tzname`` (UTC fallback)."""
    aware = when.replace(tzinfo=timezone.utc) if when.tzinfo is None else when
    resolved = resolve_timezone_name(tzname)
    if ZoneInfo is not None:
        try:
            return aware.astimezone(ZoneInfo(resolved)).replace(tzinfo=None)
        except Exception:
            pass
    return aware.astimezone(timezone.utc).replace(tzinfo=None)


def _validate_shift(shift: ScheduleShiftIn) -> None:
    if not (0 <= shift.day_of_week <= 6):
        raise ValueError("day_of_week must be between 0 (Monday) and 6 (Sunday)")
    start = hhmm_to_minutes(shift.start_time)
    end = hhmm_to_minutes(shift.end_time)
    if start is None or end is None:
        raise ValueError("start_time and end_time must be HH:MM (24h)")
    if end <= start:
        raise ValueError("end_time must be after start_time")
    if shift.operator_count < 1:
        raise ValueError("operator_count must be >= 1")


async def get_schedule(db: AsyncSession) -> list[OperatorSchedule]:
    """All shifts ordered by weekday then start time."""
    result = await db.execute(
        select(OperatorSchedule).order_by(OperatorSchedule.day_of_week, OperatorSchedule.start_time)
    )
    return list(result.scalars().all())


# Aliases used by plate_turnaround / earlier Phase 2 drafts
list_schedule = get_schedule


async def replace_schedule(db: AsyncSession, shifts: list[ScheduleShiftIn]) -> list[OperatorSchedule]:
    """Replace the entire weekly template with ``shifts`` (validated). Flushes.

    Does not commit — the caller (router/test) owns the transaction boundary.
    """
    for shift in shifts:
        _validate_shift(shift)
    await db.execute(delete(OperatorSchedule))
    for shift in shifts:
        tzname = (shift.timezone or "UTC").strip() or "UTC"
        db.add(
            OperatorSchedule(
                day_of_week=shift.day_of_week,
                start_time=shift.start_time.strip(),
                end_time=shift.end_time.strip(),
                operator_count=shift.operator_count,
                timezone=tzname,
                enabled=shift.enabled,
            )
        )
    await db.flush()
    return await get_schedule(db)


async def within_staffed_hours(db: AsyncSession, when: datetime | None) -> bool | None:
    """Whether ``when`` falls inside a staffed shift; stub fallback if none enabled.

    Shift ``HH:MM`` values are interpreted in the Stats 2 **global** timezone
    (not each row's possibly-stale ``timezone`` field). This matches the
    behavior of ``get_staffed_windows_context`` so turnaround, lead-time, and
    capacity explanations always agree.
    """
    if when is None:
        return None
    globals_ = await get_stats2_globals(db)
    global_tz = resolve_timezone_name((globals_.timezone or DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE)
    shifts = (await db.execute(select(OperatorSchedule).where(OperatorSchedule.enabled.is_(True)))).scalars().all()
    if not shifts:
        return stub_within_staffed_hours(_local_when(when, global_tz))

    local = _local_when(when, global_tz)
    for shift in shifts:
        if local.weekday() != shift.day_of_week:
            continue
        start = hhmm_to_minutes(shift.start_time)
        end = hhmm_to_minutes(shift.end_time)
        if start is None or end is None:
            continue
        now_min = local.hour * 60 + local.minute
        if start <= now_min < end:
            return True
    return False


is_within_staffed_hours = within_staffed_hours


def stub_windows_by_weekday() -> dict[int, list[tuple[int, int]]]:
    """Mon–Fri 08:00–17:00; weekends empty."""
    window = [(_STUB_START_HOUR * 60, _STUB_END_HOUR * 60)]
    return {d: list(window) if d < 5 else [] for d in range(7)}


def schedule_windows_by_weekday(shifts: list[OperatorSchedule]) -> dict[int, list[tuple[int, int]]]:
    by_day: dict[int, list[tuple[int, int]]] = {d: [] for d in range(7)}
    for shift in shifts:
        start = hhmm_to_minutes(shift.start_time)
        end = hhmm_to_minutes(shift.end_time)
        if start is None or end is None or end <= start:
            continue
        by_day[shift.day_of_week].append((start, end))
    return {d: _merge_intervals(intervals) for d, intervals in by_day.items()}


def staffed_minutes_between_local(
    start: datetime,
    end: datetime,
    *,
    windows_by_weekday: dict[int, list[tuple[int, int]]],
) -> float:
    """Sum minutes of ``[start, end)`` that fall inside staffed windows.

    ``start`` / ``end`` must already be naive wall-clock in the schedule's
    timezone. Overnight / weekend gaps do not count — e.g. finish 16:55, leave
    17:00, return 08:00, harvest 08:08 → 13 staffed minutes.
    """
    if start is None or end is None or end <= start:
        return 0.0

    total = 0.0
    day = start.date()
    end_day = end.date()
    while day <= end_day:
        windows = windows_by_weekday.get(day.weekday(), [])
        day_origin = datetime(day.year, day.month, day.day)
        for w_start_min, w_end_min in windows:
            window_start = day_origin + timedelta(minutes=w_start_min)
            window_end = day_origin + timedelta(minutes=w_end_min)
            overlap_start = max(window_start, start)
            overlap_end = min(window_end, end)
            if overlap_end > overlap_start:
                total += (overlap_end - overlap_start).total_seconds() / 60.0
        day += timedelta(days=1)
    return total


async def staffed_minutes_between(db: AsyncSession, start: datetime | None, end: datetime | None) -> float | None:
    """Staffed-only elapsed minutes between two timestamps (DB schedule or stub).

    Returns ``None`` when either bound is missing or ``end < start``.
    """
    if start is None or end is None:
        return None
    if end < start:
        return None
    if end == start:
        return 0.0

    tzname, windows, _using_stub = await get_staffed_windows_context(db)
    local_start = _local_when(start, tzname)
    local_end = _local_when(end, tzname)
    return staffed_minutes_between_local(local_start, local_end, windows_by_weekday=windows)


async def get_staffed_windows_context(
    db: AsyncSession,
) -> tuple[str, dict[int, list[tuple[int, int]]], bool]:
    """Timezone + weekday staffed windows for elapsed-minute math.

    Shift ``HH:MM`` values are always interpreted in the Stats 2 **global**
    timezone (not each row's possibly-stale ``timezone`` field). That keeps
    overnight harvest math aligned with the shop floor clock the operator set
    under Configuration.
    """
    globals_ = await get_stats2_globals(db)
    tzname = resolve_timezone_name((globals_.timezone or DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE)
    shifts = list(
        (await db.execute(select(OperatorSchedule).where(OperatorSchedule.enabled.is_(True)))).scalars().all()
    )
    if shifts:
        return tzname, schedule_windows_by_weekday(shifts), False
    return tzname, stub_windows_by_weekday(), True


def _merge_intervals(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not intervals:
        return []
    ordered = sorted(intervals)
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


async def get_effective_schedule(
    db: AsyncSession,
    on_date: date,
    now: datetime | None = None,
) -> EffectiveSchedule:
    """Resolve enabled shifts for ``on_date``'s weekday plus the global knobs."""
    weekday = on_date.weekday()
    day_shifts = (
        (
            await db.execute(
                select(OperatorSchedule)
                .where(OperatorSchedule.enabled.is_(True))
                .where(OperatorSchedule.day_of_week == weekday)
                .order_by(OperatorSchedule.start_time)
            )
        )
        .scalars()
        .all()
    )

    any_enabled = (
        await db.execute(select(OperatorSchedule.id).where(OperatorSchedule.enabled.is_(True)).limit(1))
    ).scalar_one_or_none() is not None

    intervals: list[tuple[int, int]] = []
    shifts_out: list[dict] = []
    peak_operators = 0
    for shift in day_shifts:
        start = hhmm_to_minutes(shift.start_time)
        end = hhmm_to_minutes(shift.end_time)
        if start is None or end is None or end <= start:
            continue
        intervals.append((start, end))
        peak_operators = max(peak_operators, shift.operator_count)
        shifts_out.append(
            {
                "id": shift.id,
                "day_of_week": shift.day_of_week,
                "start_time": shift.start_time,
                "end_time": shift.end_time,
                "operator_count": shift.operator_count,
                "timezone": shift.timezone,
            }
        )

    merged = _merge_intervals(intervals)
    windows = [{"start_time": minutes_to_hhmm(s), "end_time": minutes_to_hhmm(e)} for s, e in merged]
    total_staffed = sum(e - s for s, e in merged)

    # When using the default stub (no enabled shifts), fill in the Mon-Fri
    # 08:00-17:00 windows so the effective endpoint agrees with capacity.
    using_stub = not any_enabled
    if using_stub and weekday < 5:
        stub_start = _STUB_START_HOUR * 60
        stub_end = _STUB_END_HOUR * 60
        windows = [{"start_time": minutes_to_hhmm(stub_start), "end_time": minutes_to_hhmm(stub_end)}]
        total_staffed = stub_end - stub_start
        peak_operators = 1

    globals_ = await get_stats2_globals(db)
    reference = now or datetime.now(timezone.utc)
    staffed_now = await within_staffed_hours(db, reference)

    return EffectiveSchedule(
        date=on_date.isoformat(),
        day_of_week=weekday,
        is_staffed=len(shifts_out) > 0 or (using_stub and weekday < 5),
        shifts=shifts_out,
        windows=windows,
        peak_operator_count=peak_operators,
        total_staffed_minutes=total_staffed,
        staffed_now=staffed_now,
        line_start_time=globals_.production_line_start_time,
        ready_deadline_time=ready_deadline_hhmm(globals_.production_line_start_time, globals_.pre_line_buffer_minutes),
        expected_plate_clear_minutes=globals_.expected_plate_clear_minutes,
        pre_line_buffer_minutes=globals_.pre_line_buffer_minutes,
        timezone=globals_.timezone,
        using_default_stub=using_stub,
    )
