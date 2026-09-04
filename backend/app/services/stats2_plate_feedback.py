"""Plate-turnaround expected vs actual feedback (not a capacity input).

Actual clear time for judgment uses **staffed operating minutes only**
(operator schedule, or Mon–Fri 08:00–17:00 stub). A print that finishes at
16:55 and is cleared at 08:08 the next morning counts as ~13 minutes, not
wall-clock overnight.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from statistics import median

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.stats_events import PlateTurnaroundEvent
from backend.app.services.operator_schedule_service import (
    _local_when,
    get_staffed_windows_context,
    staffed_minutes_between_local,
)
from backend.app.services.stats2_config import get_stats2_globals


def _percentile(sorted_vals: list[float], p: float) -> float | None:
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * p
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def _series(vals: list[float]) -> dict:
    if not vals:
        return {"count": 0, "median_minutes": None, "p90_minutes": None, "mean_minutes": None}
    ordered = sorted(vals)
    return {
        "count": len(ordered),
        "median_minutes": round(median(ordered), 1),
        "p90_minutes": round(_percentile(ordered, 0.9) or 0, 1),
        "mean_minutes": round(sum(ordered) / len(ordered), 1),
    }


async def compute_plate_turnaround_feedback(
    db: AsyncSession,
    *,
    lookback_days: int = 30,
) -> dict:
    globals_ = await get_stats2_globals(db)
    expected = float(globals_.expected_plate_clear_minutes)
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=max(1, lookback_days))
    tzname, windows, using_stub = await get_staffed_windows_context(db)

    events = (
        (
            await db.execute(
                select(PlateTurnaroundEvent)
                .where(PlateTurnaroundEvent.print_finished_at >= since)
                .where(PlateTurnaroundEvent.plate_clear_confirmed_at.is_not(None))
            )
        )
        .scalars()
        .all()
    )

    staffed_clears: list[float] = []
    all_clears: list[float] = []
    live_count = 0
    backfill_count = 0
    for ev in events:
        # Skip finishes known to be outside staffed hours; keep True and None (legacy).
        if ev.within_staffed_hours is False:
            continue
        wall = ev.actual_clear_minutes
        if wall is None or wall < 0:
            continue
        all_clears.append(wall)
        src = (getattr(ev, "source", None) or "live").strip().lower()
        if src == "backfill":
            backfill_count += 1
        else:
            live_count += 1

        local_start = _local_when(ev.print_finished_at, tzname)
        local_end = _local_when(ev.plate_clear_confirmed_at, tzname)
        staffed = staffed_minutes_between_local(local_start, local_end, windows_by_weekday=windows)
        staffed_clears.append(staffed)

    sample = staffed_clears  # judgment vs expected uses staffed elapsed
    insufficient = len(sample) < 3

    if insufficient:
        status = "insufficient_data"
    else:
        p50 = median(sample)
        # ±20% band = on target
        if p50 < expected * 0.8:
            status = "ahead"
        elif p50 > expected * 1.2:
            status = "behind"
        else:
            status = "on_target"

    return {
        "lookback_days": lookback_days,
        "expected_plate_clear_minutes": expected,
        "status": status,
        "insufficient_data": insufficient,
        "staffed_hours_only": _series(sample),
        "all_clears": _series(all_clears),
        "live_event_count": live_count,
        "backfill_event_count": backfill_count,
        "timezone": tzname,
        "using_default_stub": using_stub,
        "as_of": datetime.now(timezone.utc).isoformat(),
        "note": (
            f"Cleanup judgment uses staffed operating minutes only ({tzname}"
            f"{', default Mon–Fri 08:00–17:00' if using_stub else ''}); "
            "overnight / weekends excluded. Capacity still uses configured expected. "
            "Set Timezone under Configuration if these look wrong."
        ),
    }
