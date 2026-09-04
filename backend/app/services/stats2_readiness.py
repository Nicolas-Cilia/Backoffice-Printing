"""Stats 2 readiness: devices buildable from on-hand stock.

Ready now = staged_for_prod + in_wip (NOT linked, NOT rework/sanding).
Upstream = initial QC finished (fit_checked) only.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.device_recipe_service import get_recipe_view
from backend.app.services.floor_bins import list_floor_bin_management, list_floor_bins
from backend.app.services.floor_parts import list_inventory_parts
from backend.app.services.operator_schedule_service import get_effective_schedule
from backend.app.services.stats2_config import shop_today

_UPSTREAM_STATUSES = frozenset({"fit_checked", "visual_qc_passed"})
_REWORK_STATUSES = frozenset({"rework", "sanding"})
_LINKED_STATUSES = frozenset({"linked"})
_STICKER_CODES = frozenset({"TOP", "BOT"})
# BOT is a sticker-tracked part only; its bins feed the sticker pipeline and
# must NOT be summed on top of the staged stickers (would double-count).
_BIN_CODES = frozenset({"KNB", "BUT"})


@dataclass
class PartReadiness:
    part_code: str
    part_name: str
    qty_per_device: int
    in_wip: int
    staged_for_prod: int
    initial_qc_finished: int
    rework_sanding: int
    linked: int
    ready_now: int
    upstream: int
    devices_covered: float


def _bucket_qty(counts: dict[str, int], statuses: frozenset[str]) -> int:
    return sum(counts.get(s, 0) for s in statuses)


async def _sticker_status_counts(db: AsyncSession) -> dict[str, dict[str, int]]:
    """part_code → status → count of labeled parts."""
    out: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    parts = await list_inventory_parts(db)
    for part in parts:
        code = (part.part_code or "").strip().upper()
        if code not in _STICKER_CODES:
            continue
        status = (part.latest_event_action or "").strip().lower()
        if not status:
            continue
        out[code][status] += 1
    return out


async def _bin_status_counts(db: AsyncSession) -> dict[str, dict[str, int]]:
    """part_code → status → sum of remaining_quantity on active bins."""
    out: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    # Ensure permanent bins exist conceptually; management list carries remaining.
    await list_floor_bins(db)
    for row in await list_floor_bin_management(db):
        batch = row.batch
        if batch is None:
            continue
        code = (batch.part_code or "").strip().upper()
        if code not in _BIN_CODES:
            continue
        status = (row.status or batch.status or "").strip().lower()
        qty = int(batch.remaining_quantity or 0)
        if qty <= 0:
            continue
        out[code][status] += qty
    return out


async def compute_readiness(
    db: AsyncSession,
    *,
    on_date: date | None = None,
) -> dict:
    recipe = await get_recipe_view(db)
    sticker = await _sticker_status_counts(db)
    bins = await _bin_status_counts(db)

    target = on_date or await shop_today(db)
    effective = await get_effective_schedule(db, target)
    line_start_at = f"{effective.date}T{effective.line_start_time}:00"
    ready_deadline_at = f"{effective.date}T{effective.ready_deadline_time}:00"

    lines: list[PartReadiness] = []
    for line in recipe["lines"]:
        code = line["part_code"]
        counts: dict[str, int] = defaultdict(int)
        if code in sticker:
            for k, v in sticker[code].items():
                counts[k] += v
        if code in bins:
            for k, v in bins[code].items():
                counts[k] += v

        in_wip = counts.get("wip", 0)
        staged = counts.get("ready_for_production", 0)
        qc = _bucket_qty(counts, _UPSTREAM_STATUSES)
        rework = _bucket_qty(counts, _REWORK_STATUSES)
        linked = _bucket_qty(counts, _LINKED_STATUSES)
        ready_now = staged + in_wip
        qty = max(1, int(line["qty_per_device"]))
        covered = ready_now / qty
        lines.append(
            PartReadiness(
                part_code=code,
                part_name=line.get("part_name") or code,
                qty_per_device=qty,
                in_wip=in_wip,
                staged_for_prod=staged,
                initial_qc_finished=qc,
                rework_sanding=rework,
                linked=linked,
                ready_now=ready_now,
                upstream=qc,
                devices_covered=covered,
            )
        )

    if lines:
        devices_buildable = min(ln.devices_covered for ln in lines)
        binding = min(lines, key=lambda ln: ln.devices_covered).part_code
    else:
        devices_buildable = 0.0
        binding = None

    return {
        "as_of": datetime.now(timezone.utc).isoformat(),
        "line_start_at": line_start_at,
        "ready_deadline_at": ready_deadline_at,
        "devices_buildable_now": devices_buildable,
        "binding_part": binding,
        "parts": [
            {
                "part_code": ln.part_code,
                "part_name": ln.part_name,
                "qty_per_device": ln.qty_per_device,
                "in_wip": ln.in_wip,
                "staged_for_prod": ln.staged_for_prod,
                "initial_qc_finished": ln.initial_qc_finished,
                "rework_sanding": ln.rework_sanding,
                "linked": ln.linked,
                "ready_now": ln.ready_now,
                "upstream": ln.upstream,
                "devices_covered": ln.devices_covered,
                "is_binding": ln.part_code == binding,
            }
            for ln in lines
        ],
    }
