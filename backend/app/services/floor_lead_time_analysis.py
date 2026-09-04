"""Stats 2 floor lead-time analytics from FloorPartEvent timestamps.

Durations count **staffed operating minutes only** (operator schedule, or the
Mon–Fri 08:00–17:00 stub). Overnight / weekend idle is excluded so a print that
finishes at 16:55 and is harvested at 08:08 the next morning reports ~13 min,
not ~15 h.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from statistics import mean, median

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent
from backend.app.services.operator_schedule_service import (
    _local_when,
    get_staffed_windows_context,
    staffed_minutes_between_local,
)

_DEFAULT_LOOKBACK = 30

# metric_id → (label, start_key, end_key)
# Special start: "print_finish" uses archive.completed_at.
# Special end: "ready_or_wip" is the earlier of ready_for_production / wip.
# Special end: "fit_checked" also accepts sanding / _qc_or_sanding stand-in.
_METRICS: list[tuple[str, str, str, str]] = [
    ("print_to_linked", "Print finish → Linked", "print_finish", "enrolled"),
    ("linked_to_qc", "Linked → Initial QC", "enrolled", "fit_checked"),
    (
        "qc_to_production",
        "Initial QC → Production WIP/Ready for Production",
        "fit_checked",
        "ready_or_wip",
    ),
    ("wip_to_unit_linked", "WIP → Linked with serial (TOP)", "wip", "unit_linked"),
    # First Support Removal scan → first Ready for Production or WIP (TOP).
    ("finishing_total", "Finishing steps (TOP)", "support_removed", "ready_or_wip"),
]

_TOP_ONLY = frozenset({"wip_to_unit_linked", "finishing_total"})


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


def _stats(durations_minutes: list[float]) -> dict:
    """Aggregate staffed-minute samples; also expose hours for older consumers."""
    if not durations_minutes:
        return {
            "count": 0,
            "mean_minutes": None,
            "median_minutes": None,
            "p90_minutes": None,
            "min_minutes": None,
            "max_minutes": None,
            "mean_hours": None,
            "median_hours": None,
            "p90_hours": None,
            "min_hours": None,
            "max_hours": None,
        }
    ordered = sorted(durations_minutes)
    mean_m = mean(ordered)
    median_m = median(ordered)
    p90_m = _percentile(ordered, 0.9) or 0.0
    min_m = ordered[0]
    max_m = ordered[-1]
    return {
        "count": len(ordered),
        "mean_minutes": round(mean_m, 1),
        "median_minutes": round(median_m, 1),
        "p90_minutes": round(p90_m, 1),
        "min_minutes": round(min_m, 1),
        "max_minutes": round(max_m, 1),
        "mean_hours": round(mean_m / 60.0, 3),
        "median_hours": round(median_m / 60.0, 3),
        "p90_hours": round(p90_m / 60.0, 3),
        "min_hours": round(min_m / 60.0, 3),
        "max_hours": round(max_m / 60.0, 3),
    }


def _staffed_minutes(
    start: datetime | None,
    end: datetime | None,
    *,
    tzname: str,
    windows_by_weekday: dict[int, list[tuple[int, int]]],
) -> float | None:
    if start is None or end is None or end < start:
        return None
    if end == start:
        return 0.0
    local_start = _local_when(start, tzname)
    local_end = _local_when(end, tzname)
    return staffed_minutes_between_local(local_start, local_end, windows_by_weekday=windows_by_weekday)


def _resolve_action_time(acts: dict[str, datetime], key: str) -> datetime | None:
    if key == "fit_checked":
        return acts.get("fit_checked")
    if key == "ready_or_wip":
        candidates = [t for k in ("ready_for_production", "wip") if (t := acts.get(k)) is not None]
        return min(candidates) if candidates else None
    return acts.get(key)


async def compute_lead_times(
    db: AsyncSession,
    *,
    lookback_days: int = _DEFAULT_LOOKBACK,
) -> dict:
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=max(1, lookback_days))
    tzname, windows_by_weekday, using_stub = await get_staffed_windows_context(db)
    parts = (
        (
            await db.execute(
                select(FloorLabeledPart)
                .where(FloorLabeledPart.labeled_at >= since)
                .where(FloorLabeledPart.archived_at.is_(None))
            )
        )
        .scalars()
        .all()
    )
    empty_note = (
        f"Durations count staffed operating minutes only ({tzname}"
        f"{', default Mon–Fri 08:00–17:00' if using_stub else ''}); "
        "overnight and weekends are excluded. Set Timezone under Configuration if these look wrong."
    )
    empty_metrics = [
        {
            "metric_id": mid,
            "label": label,
            **_stats([]),
            "by_part_code": {},
        }
        for mid, label, _, _ in _METRICS
    ]
    if not parts:
        return {
            "lookback_days": lookback_days,
            "staffed_hours_only": True,
            "timezone": tzname,
            "using_default_stub": using_stub,
            "metrics": empty_metrics,
            "as_of": datetime.now(timezone.utc).isoformat(),
            "note": empty_note,
        }

    part_ids = [p.id for p in parts]
    events = (
        (
            await db.execute(
                select(FloorPartEvent)
                .where(FloorPartEvent.part_id.in_(part_ids))
                .order_by(FloorPartEvent.occurred_at, FloorPartEvent.id)
            )
        )
        .scalars()
        .all()
    )
    first_action: dict[int, dict[str, datetime]] = defaultdict(dict)
    for ev in events:
        # first occurrence wins
        if ev.action not in first_action[ev.part_id]:
            first_action[ev.part_id][ev.action] = ev.occurred_at

    archive_ids = {p.archive_id for p in parts if p.archive_id is not None}
    archive_finish: dict[int, datetime] = {}
    if archive_ids:
        for arch in (
            (await db.execute(select(PrintArchive).where(PrintArchive.id.in_(list(archive_ids))))).scalars().all()
        ):
            if arch.completed_at is not None:
                archive_finish[arch.id] = arch.completed_at

    # durations[metric_id][part_code] = list of staffed minutes
    durations: dict[str, dict[str, list[float]]] = {mid: defaultdict(list) for mid, _, _, _ in _METRICS}

    for part in parts:
        code = (part.part_code or "UNK").strip().upper()
        acts = first_action.get(part.id, {})

        for mid, _label, start_key, end_key in _METRICS:
            if mid in _TOP_ONLY and code != "TOP":
                continue

            if start_key == "print_finish":
                start = archive_finish.get(part.archive_id) if part.archive_id else None
            elif start_key == "enrolled" and "enrolled" not in acts:
                # enrollment may be implicit at labeled_at
                start = part.labeled_at
            else:
                start = _resolve_action_time(acts, start_key)
            end = _resolve_action_time(acts, end_key)
            mins = _staffed_minutes(start, end, tzname=tzname, windows_by_weekday=windows_by_weekday)

            if mins is not None:
                durations[mid][code].append(mins)

    metrics_out = []
    for mid, label, _, _ in _METRICS:
        all_vals: list[float] = []
        by_code = {}
        for code, vals in sorted(durations[mid].items()):
            by_code[code] = _stats(vals)
            all_vals.extend(vals)
        metrics_out.append(
            {
                "metric_id": mid,
                "label": label,
                **_stats(all_vals),
                "by_part_code": by_code,
            }
        )

    return {
        "lookback_days": lookback_days,
        "staffed_hours_only": True,
        "timezone": tzname,
        "using_default_stub": using_stub,
        "metrics": metrics_out,
        "as_of": datetime.now(timezone.utc).isoformat(),
        "note": empty_note,
    }


async def compute_lead_time_detail(
    db: AsyncSession,
    metric_id: str,
    *,
    lookback_days: int = _DEFAULT_LOOKBACK,
) -> dict:
    summary = await compute_lead_times(db, lookback_days=lookback_days)
    metric = next((m for m in summary["metrics"] if m["metric_id"] == metric_id), None)
    if metric is None:
        return {"metric_id": metric_id, "error": "unknown metric", "metrics": summary["metrics"]}

    return {
        "metric_id": metric_id,
        "label": metric["label"],
        "stats": {
            "count": metric["count"],
            "mean_minutes": metric["mean_minutes"],
            "median_minutes": metric["median_minutes"],
            "p90_minutes": metric["p90_minutes"],
            "min_minutes": metric["min_minutes"],
            "max_minutes": metric["max_minutes"],
            "mean_hours": metric["mean_hours"],
            "median_hours": metric["median_hours"],
            "p90_hours": metric["p90_hours"],
            "min_hours": metric["min_hours"],
            "max_hours": metric["max_hours"],
        },
        "by_part_code": metric["by_part_code"],
        "histogram": _histogram_from_stats(metric),
        "staffed_hours_only": True,
        "lookback_days": lookback_days,
        "as_of": summary["as_of"],
        "note": summary.get("note"),
    }


def _histogram_from_stats(metric: dict) -> list[dict]:
    """Simple fixed buckets in minutes when we only have aggregates — empty if no data."""
    if not metric.get("count"):
        return []
    edges = [0, 15, 30, 60, 120, 240, 480, 1440]
    return [
        {"bucket_start_minutes": edges[i], "bucket_end_minutes": edges[i + 1], "count": None}
        for i in range(len(edges) - 1)
    ]


async def export_lead_times_csv_rows(db: AsyncSession, *, lookback_days: int = 30) -> list[dict]:
    """Flat rows for CSV export: one per metric × part_code."""
    summary = await compute_lead_times(db, lookback_days=lookback_days)
    rows = []
    for metric in summary["metrics"]:
        for code, stats in (metric.get("by_part_code") or {}).items():
            rows.append(
                {
                    "metric_id": metric["metric_id"],
                    "label": metric["label"],
                    "part_code": code,
                    **stats,
                }
            )
    return rows
