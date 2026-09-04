"""Stats 2 (Phase 2) global configuration knobs.

Shop-wide values that don't belong on the per-shift ``OperatorSchedule``
template live in the key-value ``settings`` table:

* ``stats2_expected_plate_clear_minutes`` — target minutes to clear a plate
  between prints (compared later against the Phase 1 actual turnaround).
* ``stats2_production_line_start_time`` — wall-clock ``HH:MM`` the assembly line
  starts.
* ``stats2_pre_line_buffer_minutes`` — finished-goods buffer, in minutes, that
  should exist before the line starts; the "ready deadline" is the line start
  minus this buffer.
* ``stats2_timezone`` — IANA zone the above wall-clock values are expressed in.
* ``stats2_ready_buffer_targets`` — JSON map of part_code → min ready-on-hand
  qty for the optional buffer timeline (advisory Gantt only; never a capacity
  input). Defaults: BUT 80, KNB 50.

None are capacity inputs on their own; this is the single read/write choke point
so defaults and parsing stay consistent.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.settings import Settings

try:  # stdlib on 3.9+, guard so an odd runtime can't break imports.
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

KEY_EXPECTED_PLATE_CLEAR_MINUTES = "stats2_expected_plate_clear_minutes"
KEY_PRODUCTION_LINE_START_TIME = "stats2_production_line_start_time"
KEY_PRE_LINE_BUFFER_MINUTES = "stats2_pre_line_buffer_minutes"
KEY_TIMEZONE = "stats2_timezone"
KEY_READY_BUFFER_TARGETS = "stats2_ready_buffer_targets"

DEFAULT_EXPECTED_PLATE_CLEAR_MINUTES = 15
DEFAULT_PRODUCTION_LINE_START_TIME = "08:00"
DEFAULT_PRE_LINE_BUFFER_MINUTES = 30
DEFAULT_TIMEZONE = "UTC"
# Min ready-on-hand for the buffer timeline. 0 / omitted = no buffer for that part.
DEFAULT_READY_BUFFER_TARGETS: dict[str, int] = {"BUT": 80, "KNB": 50}

# Common abbreviations operators type into the free-text timezone field. Invalid
# IANA names (e.g. "PST") otherwise silently fall back to UTC and zero out
# staffed-minute spans that fall in the afternoon Pacific / evening UTC.
_TIMEZONE_ALIASES: dict[str, str] = {
    "PST": "America/Los_Angeles",
    "PDT": "America/Los_Angeles",
    "PT": "America/Los_Angeles",
    "PACIFIC": "America/Los_Angeles",
    "US/PACIFIC": "America/Los_Angeles",
    "EST": "America/New_York",
    "EDT": "America/New_York",
    "ET": "America/New_York",
    "EASTERN": "America/New_York",
    "CST": "America/Chicago",
    "CDT": "America/Chicago",
    "CT": "America/Chicago",
    "CENTRAL": "America/Chicago",
    "MST": "America/Denver",
    "MDT": "America/Denver",
    "MT": "America/Denver",
    "MOUNTAIN": "America/Denver",
}


def resolve_timezone_name(tzname: str | None) -> str:
    """Return a ZoneInfo-compatible IANA name, or ``UTC`` if unresolvable."""
    raw = (tzname or "").strip() or DEFAULT_TIMEZONE
    try:
        if ZoneInfo is not None:
            ZoneInfo(raw)
            return raw
    except Exception:
        pass
    aliased = _TIMEZONE_ALIASES.get(raw.upper())
    if aliased is not None:
        return aliased
    return DEFAULT_TIMEZONE


def shop_calendar_date(tzname: str | None = None, *, now: datetime | None = None) -> date:
    """Calendar date in shop timezone (UTC wall-clock fallback)."""
    when = now or datetime.now(timezone.utc)
    aware = when.replace(tzinfo=timezone.utc) if when.tzinfo is None else when
    resolved = resolve_timezone_name(tzname)
    if ZoneInfo is not None:
        try:
            return aware.astimezone(ZoneInfo(resolved)).date()
        except Exception:
            pass
    return aware.astimezone(timezone.utc).date()


async def shop_today(db: AsyncSession) -> date:
    g = await get_stats2_globals(db)
    return shop_calendar_date(g.timezone)


@dataclass(frozen=True)
class Stats2Globals:
    """Resolved global Stats 2 knobs."""

    expected_plate_clear_minutes: int
    production_line_start_time: str
    pre_line_buffer_minutes: int
    timezone: str
    ready_buffer_targets: dict[str, int]

    def to_dict(self) -> dict:
        return asdict(self)


def hhmm_to_minutes(value: str) -> int | None:
    """Parse ``HH:MM`` (24h) to minutes-since-midnight, or None if malformed."""
    parts = str(value).strip().split(":")
    if len(parts) != 2:
        return None
    try:
        hh, mm = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return None
    return hh * 60 + mm


def minutes_to_hhmm(total: int) -> str:
    """Format minutes-since-midnight to ``HH:MM``, wrapping across midnight."""
    total %= 24 * 60
    return f"{total // 60:02d}:{total % 60:02d}"


def is_valid_hhmm(value: str) -> bool:
    """True if ``value`` is a 24h ``HH:MM`` wall-clock string."""
    return hhmm_to_minutes(value) is not None


def ready_deadline_hhmm(line_start_time: str, pre_line_buffer_minutes: int) -> str:
    """The finished-goods "ready by" time: line start minus the buffer.

    ``ready_deadline_hhmm("09:00", 30) == "08:30"``. Wraps across midnight so a
    buffer larger than the line-start offset never raises.
    """
    start = hhmm_to_minutes(line_start_time)
    if start is None:
        start = hhmm_to_minutes(DEFAULT_PRODUCTION_LINE_START_TIME) or 0
    return minutes_to_hhmm(start - int(pre_line_buffer_minutes))


def _parse_int(value: str | None, default: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def _parse_hhmm(value: str | None, default: str) -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text if is_valid_hhmm(text) else default


def normalize_ready_buffer_targets(raw: object | None) -> dict[str, int]:
    """Coerce a map of part_code → non-negative int ready targets.

    Unknown shapes fall back to defaults. Explicit ``0`` disables a part.
    Codes are uppercased. Missing known default codes are filled from defaults
    so a partial save (e.g. only BUT) still keeps KNB=50 unless set to 0.
    """
    base = dict(DEFAULT_READY_BUFFER_TARGETS)
    if raw is None:
        return base
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return base
        try:
            raw = json.loads(text)
        except json.JSONDecodeError:
            return base
    if not isinstance(raw, dict):
        return base
    out = dict(base)
    for key, value in raw.items():
        code = str(key or "").strip().upper()
        if not code:
            continue
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            continue
        out[code] = max(0, parsed)
    return out


def quantize_buffer_catch_up(shortfall: int, qty_per_plate: int) -> int:
    """Whole-plate catch-up when below a ready buffer target.

    If shortfall > 0, schedule at least one plate (e.g. 10 short with a 47-up
    plate → ask 47). Larger shortfalls round up to full plates.
    """
    if shortfall <= 0:
        return 0
    plate = max(1, int(qty_per_plate))
    return ((int(shortfall) + plate - 1) // plate) * plate


async def _get_raw(db: AsyncSession, key: str) -> str | None:
    result = await db.execute(select(Settings.value).where(Settings.key == key))
    return result.scalar_one_or_none()


async def get_stats2_globals(db: AsyncSession) -> Stats2Globals:
    """Read global knobs, falling back to defaults for missing rows."""
    return Stats2Globals(
        expected_plate_clear_minutes=_parse_int(
            await _get_raw(db, KEY_EXPECTED_PLATE_CLEAR_MINUTES),
            DEFAULT_EXPECTED_PLATE_CLEAR_MINUTES,
        ),
        production_line_start_time=_parse_hhmm(
            await _get_raw(db, KEY_PRODUCTION_LINE_START_TIME),
            DEFAULT_PRODUCTION_LINE_START_TIME,
        ),
        pre_line_buffer_minutes=_parse_int(
            await _get_raw(db, KEY_PRE_LINE_BUFFER_MINUTES),
            DEFAULT_PRE_LINE_BUFFER_MINUTES,
        ),
        timezone=resolve_timezone_name((await _get_raw(db, KEY_TIMEZONE)) or DEFAULT_TIMEZONE),
        ready_buffer_targets=normalize_ready_buffer_targets(await _get_raw(db, KEY_READY_BUFFER_TARGETS)),
    )


async def set_stats2_globals(
    db: AsyncSession,
    *,
    expected_plate_clear_minutes: int | None = None,
    production_line_start_time: str | None = None,
    pre_line_buffer_minutes: int | None = None,
    timezone: str | None = None,
    ready_buffer_targets: dict[str, int] | None = None,
) -> None:
    """Upsert any provided knobs (None = leave unchanged). Does NOT commit.

    Raises ``ValueError`` for an invalid ``HH:MM`` or a negative minute count.
    """
    from backend.app.core.db_dialect import upsert_setting

    if expected_plate_clear_minutes is not None:
        if expected_plate_clear_minutes < 0:
            raise ValueError("expected_plate_clear_minutes must be >= 0")
        await upsert_setting(db, Settings, KEY_EXPECTED_PLATE_CLEAR_MINUTES, str(int(expected_plate_clear_minutes)))
    if production_line_start_time is not None:
        if not is_valid_hhmm(production_line_start_time):
            raise ValueError("production_line_start_time must be HH:MM (24h)")
        await upsert_setting(db, Settings, KEY_PRODUCTION_LINE_START_TIME, production_line_start_time.strip())
    if pre_line_buffer_minutes is not None:
        if pre_line_buffer_minutes < 0:
            raise ValueError("pre_line_buffer_minutes must be >= 0")
        await upsert_setting(db, Settings, KEY_PRE_LINE_BUFFER_MINUTES, str(int(pre_line_buffer_minutes)))
    if timezone is not None:
        await upsert_setting(
            db, Settings, KEY_TIMEZONE, resolve_timezone_name(str(timezone).strip() or DEFAULT_TIMEZONE)
        )
    if ready_buffer_targets is not None:
        normalized = normalize_ready_buffer_targets(ready_buffer_targets)
        await upsert_setting(db, Settings, KEY_READY_BUFFER_TARGETS, json.dumps(normalized, sort_keys=True))
