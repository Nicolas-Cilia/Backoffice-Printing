"""Stats 2 weekly print-plan / Gantt builder.

Packs production slots onto every eligible printer model for each recipe part
(A1 / A1M / X1C / H2D / H2S, …) — not a single preferred/recommended file.
Prioritizes the readiness binding part, then the print-capacity binding part.
Prints may run into unstaffed hours; starts (and clears) still need staff.

Placement aims at theoretical (physical) max; print/harvest/QC yields are
recorded on each job for expected/realistic capacity, not for who prints what.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.printer import Printer
from backend.app.services.capacity_analysis import (
    _DAY_MINUTES,
    _STUB_STAFFED_MINUTES,
    _group_slots_by_model,
    compute_capacity_unconstrained,
    count_active_printers_by_model,
    eligible_printer_count,
    next_clear_start,
    normalize_printer_model,
    rank_slots_for_model,
    staffed_windows_for_day,
)
from backend.app.services.device_recipe_service import get_recipe_view
from backend.app.services.operator_schedule_service import get_effective_schedule
from backend.app.services.printer_time_block_service import (
    intervals_by_printer_day,
    list_blocks,
    next_start_avoiding_blocks,
    project_blocks_for_packing_day,
)
from backend.app.services.stats2_config import (
    get_stats2_globals,
    hhmm_to_minutes,
    minutes_to_hhmm,
    quantize_buffer_catch_up,
    shop_today,
)
from backend.app.services.stats2_readiness import compute_readiness
from backend.app.services.stats2_slot_metrics import SlotMetrics, get_slot_metrics_map

# Advisory Gantt modes. ``capacity`` = target × BOM (default; capacity KPI path).
# ``buffer`` = same packer, but catch up ready-on-hand to configured min targets
# (plate-quantized). Never used by ``measure_schedulable_devices``.
_TIMELINE_CAPACITY = "capacity"
_TIMELINE_BUFFER = "buffer"


@dataclass
class _LaneState:
    printer_id: int
    printer_name: str
    model: str
    cursor_minute: int  # minutes from midnight
    jobs: list[dict] = field(default_factory=list)
    hypothetical: bool = False


# Cap virtual what-if printers so a second pack stays responsive.
_MAX_VIRTUAL_PRINTERS = 80


def _fleet_boost_from_shorts(short_parts: list[dict]) -> dict[str, int]:
    """Map primary model → extra printers from short_parts (summed, capped)."""
    boost: dict[str, int] = {}
    for row in short_parts:
        extra = int(row.get("min_extra_printers") or 0)
        if extra <= 0:
            continue
        models = [str(m) for m in (row.get("eligible_models") or []) if m]
        if not models:
            continue
        primary = models[0]
        boost[primary] = int(boost.get(primary, 0)) + extra
    total = sum(boost.values())
    if total <= _MAX_VIRTUAL_PRINTERS or total <= 0:
        return boost
    # Scale down proportionally; keep at least 1 per model that had extras.
    scaled: dict[str, int] = {}
    assigned = 0
    items = sorted(boost.items(), key=lambda kv: (-kv[1], kv[0]))
    for i, (model, n) in enumerate(items):
        remaining_models = len(items) - i
        room = max(0, _MAX_VIRTUAL_PRINTERS - assigned - (remaining_models - 1))
        take = max(1, int(round(n * _MAX_VIRTUAL_PRINTERS / total)))
        take = min(take, n, room)
        scaled[model] = take
        assigned += take
    return scaled


def _virtual_printer_specs(fleet_boost: dict[str, int]) -> list[tuple[int, str, str]]:
    """``(negative_id, display_name, model)`` for hypothetical lanes."""
    specs: list[tuple[int, str, str]] = []
    next_id = -1
    for model in sorted(fleet_boost.keys()):
        n = max(0, int(fleet_boost.get(model) or 0))
        for i in range(1, n + 1):
            specs.append((next_id, f"+{model} #{i}", str(model)))
            next_id -= 1
    return specs


def _iso(day: date, minute: int) -> str:
    day_offset, rem = divmod(int(minute), _DAY_MINUTES)
    d = day + timedelta(days=day_offset)
    hh = rem // 60
    mm = rem % 60
    return f"{d.isoformat()}T{hh:02d}:{mm:02d}:00"


def _parts_for_target(target: float, qty_per_device: int) -> float:
    return max(0.0, float(target)) * max(1, int(qty_per_device))


def _devices_from_parts(
    part_qty: dict[str, int],
    parts_packed: dict[str, float],
) -> float:
    """Min complete devices from packed part counts."""
    if not part_qty:
        return 0.0
    devices: list[float] = []
    for code, qty_dev in part_qty.items():
        packed = float(parts_packed.get(code, 0.0))
        devices.append(packed / max(1, int(qty_dev)))
    return float(min(devices)) if devices else 0.0


def plate_yield_rates(metrics: SlotMetrics | None) -> tuple[float, float, float]:
    """``(print_job_success, harvest_yield, qc_yield)`` clamped to ``[0, 1]``."""
    if metrics is None:
        return 1.0, 1.0, 1.0
    success = max(0.0, min(1.0, float(metrics.print_job_success)))
    harvest = max(0.0, min(1.0, float(metrics.harvest_yield)))
    qc = max(0.0, min(1.0, float(metrics.qc_yield)))
    return success, harvest, qc


def expected_good_parts(slot: dict, metrics: SlotMetrics | None) -> float:
    """Expected good parts from one plate (qty × success × harvest × QC)."""
    qty = max(1, int(slot.get("quantity") or 1))
    success, harvest, qc = plate_yield_rates(metrics)
    return float(qty) * success * harvest * qc


def placement_sort_key(
    *,
    progress: float,
    rate: float,
    clear_end: int,
    qty: int,
    wave_time: int = 0,
    start: int = 0,
) -> tuple[float, int, int, float, int, int]:
    """Lexicographic key (higher is better).

    1. Ask coverage from a parallel wave of this plate
    2. Earlier feasible start (free H2D at 10:00 beats a mid-afternoon X1C
       when progress is equal)
    3. Sooner wave finish (``-wave_time``)
    4. Physical parts per occupancy minute
    5. Earlier clear on this lane
    6. Higher physical qty

    Placement scores use *physical* plate qty (not yield-adjusted). Yields are
    applied afterward on the packed jobs for expected/realistic capacity so the
    schedule still aims at theoretical max when print/harvest/QC are imperfect.

    Dedicated single-part models (e.g. H2S→BOT only) pass *uncapped* plate
    progress into ``progress`` so a leftover ask of 2 cannot make BOT x2 beat
    BOT x5 via the sooner-wave tie-break.
    """
    return (
        float(progress),
        -int(start),
        -int(wave_time),
        float(rate),
        -int(clear_end),
        int(qty),
    )


# Compact printers that can run TOP/KNB but not BOT/BUT — prefer them for TOP
# when they can start as soon as any other fleet; otherwise spill to H2D/X1C.
_COMPACT_MODELS = frozenset({"A1", "A1M"})
# Compact wins only if it can start within this many minutes of the earliest
# feasible start on any eligible model (avoids blocking free H2D all morning
# because an A1 could start tonight).
_COMPACT_START_EPSILON_MIN = 15
# Same-model lanes only count as one parallel wave when their cursors are this
# close. Otherwise a mid-afternoon X1C fleet looks like N simultaneous starts
# and outranks a free H2D that can start now.
_PARALLEL_WAVE_EPSILON_MIN = 15


def _devices_equiv(packed: float, qty_per_device: int) -> float:
    return float(packed) / max(1, int(qty_per_device))


def _model_sharedness(model: str, part_model_slots: dict[str, dict[str, list[dict]]]) -> int:
    """How many recipe parts can use this printer model (static fleet overlap)."""
    return sum(1 for mmap in part_model_slots.values() if model in mmap)


def _part_can_use_compact(model_map: dict[str, list[dict]]) -> bool:
    return any(m in _COMPACT_MODELS for m in model_map)


def _bom_balanced_part_order(
    codes: list[str],
    *,
    part_qty: dict[str, int],
    parts_packed_day: dict[str, float],
    remaining_by_code: dict[str, float],
    binding_print: str | None,
) -> list[str]:
    """Prefer the least-covered BOM part so shared printers raise complete devices."""

    def sort_key(code: str) -> tuple[float, int, int]:
        qty = max(1, int(part_qty.get(code, 1)))
        devices = _devices_equiv(float(parts_packed_day.get(code, 0.0)), qty)
        # Print bottleneck first on a tie (e.g. BOT before TOP when equal).
        tie = 0 if binding_print and code == binding_print else 1
        return (devices, tie, codes.index(code) if code in codes else 0)

    return sorted(
        [c for c in codes if float(remaining_by_code.get(c, 0.0)) > 0],
        key=sort_key,
    )


def _binding_part_from_packed(
    part_qty: dict[str, int],
    parts_packed: dict[str, float],
) -> str | None:
    """Part that limits complete devices given packed part counts."""
    if not part_qty:
        return None
    best_code: str | None = None
    best_devices: float | None = None
    for code, qty_dev in part_qty.items():
        packed = float(parts_packed.get(code, 0.0))
        devices = packed / max(1, int(qty_dev))
        if best_devices is None or devices < best_devices:
            best_devices = devices
            best_code = code
    return best_code


def _printers_used_for_part(days_out: list[dict] | None, part_code: str) -> tuple[int, list[str]]:
    """Unique printers (and models) that started this part on the first staffed day."""
    if not days_out:
        return 0, []
    used: dict[int, str] = {}
    for day_payload in days_out:
        if float(day_payload.get("staffed_minutes") or 0) <= 0:
            continue
        for lane in day_payload.get("lanes") or []:
            pid = lane.get("printer_id")
            model = normalize_printer_model(lane.get("printer_model")) or str(lane.get("printer_model") or "")
            for job in lane.get("jobs") or []:
                if str(job.get("part_code") or "") != part_code:
                    continue
                if pid is None:
                    continue
                used[int(pid)] = model
        break
    models = sorted({m for m in used.values() if m})
    return len(used), models


def _short_parts_from_pack(
    *,
    part_qty: dict[str, int],
    parts_needed: dict[str, float],
    parts_packed: dict[str, float],
    part_model_slots: dict[str, dict[str, list[dict]]],
    fleet: dict[str, int],
    target: float,
    capacity_ceiling: float,
    days_out: list[dict] | None = None,
) -> list[dict]:
    """Parts that missed the ask, with model-scoped minimum extra printers.

    Extra printers scale the fleet that **actually printed** this part (fallback:
    eligible models) by ``target / capacity_ceiling`` — the shop's device/day
    ceiling under the current operator schedule. Do **not** scale by
    needed/packed under an over-ask pack: that under-states part throughput vs
    the full eligible fleet and wildly inflates extras.

    Per-part extras are independent lower bounds — shared models must not be
    summed blindly.
    """
    ceiling = max(float(capacity_ceiling or 0.0), 1e-9)
    ask = max(float(target or 0.0), 0.0)
    shorts: list[dict] = []
    for code, needed_raw in parts_needed.items():
        needed = float(needed_raw)
        packed = float(parts_packed.get(code, 0.0))
        if packed + 1e-9 >= needed:
            continue
        qty_dev = max(1, int(part_qty.get(code, 1)))
        model_map = part_model_slots.get(code) or {}
        eligible_models: list[str] = []
        eligible_n = 0
        for model in sorted(model_map.keys()):
            n = eligible_printer_count(fleet, model, code)
            if n > 0:
                eligible_models.append(str(model))
                eligible_n += n
        used_n, used_models = _printers_used_for_part(days_out, code)
        if used_n > 0:
            scale_n = used_n
            scale_models = used_models
        else:
            scale_n = eligible_n
            scale_models = eligible_models
        if ask > 0 and scale_n > 0 and ceiling > 0:
            extra = max(0, int(math.ceil(scale_n * ask / ceiling)) - scale_n)
        elif needed > 0:
            extra = 1
        else:
            extra = 0
        devices_needed = ask if ask > 0 else needed / float(qty_dev)
        shorts.append(
            {
                "part_code": code,
                "parts_needed": int(round(needed)),
                "parts_packed": int(round(packed)),
                "devices_needed": devices_needed,
                "devices_packed": packed / float(qty_dev),
                "eligible_models": scale_models or eligible_models,
                "eligible_printers": scale_n,
                "min_extra_printers": int(extra),
            }
        )
    shorts.sort(key=lambda row: (float(row["devices_packed"]), str(row["part_code"])))
    return shorts


def _expected_good_parts_from_plan(plan: dict) -> dict[str, float]:
    """Sum yield-adjusted ``est_good_parts`` on the first staffed day."""
    out: dict[str, float] = {}
    for day_payload in plan.get("days") or []:
        if float(day_payload.get("staffed_minutes") or 0) <= 0:
            continue
        for lane in day_payload.get("lanes") or []:
            for job in lane.get("jobs") or []:
                code = str(job.get("part_code") or "")
                if not code:
                    continue
                qty = max(1, int(job.get("quantity_per_plate") or 1))
                est = job.get("est_good_parts")
                good = float(est) if est is not None else float(qty)
                out[code] = out.get(code, 0.0) + good
        break
    return out


def _iter_first_staffed_day_jobs(plan: dict):
    """Yield jobs from the first staffed day in a print plan."""
    for day_payload in plan.get("days") or []:
        if float(day_payload.get("staffed_minutes") or 0) <= 0:
            continue
        for lane in day_payload.get("lanes") or []:
            yield from lane.get("jobs") or []
        break


def _whole_devices(n: float) -> int:
    """Floor to whole devices — same rule as the Stats2 UI headline."""
    if n is None or n <= 0:
        return 0
    return int(float(n) // 1)


def yield_drag_from_plan(
    plan: dict,
    part_qty: dict[str, int],
    *,
    theoretical: float | None = None,
    expected: float | None = None,
) -> dict:
    """Decompose theoretical → expected into print / harvest / QC device losses.

    Walks day-1 plate starts sequentially (physical → print → harvest → QC),
    takes the BOM min at each stage, then **floors to whole devices** so:

        lost_print + lost_harvest + lost_qc == theoretical_whole - expected_whole

    Pass the headline ``theoretical`` / ``expected`` floats to anchor the ends
    of the waterfall to the same numbers shown as Expected / Theoretical.
    """
    empty = {
        "devices_lost_total": 0,
        "devices_theoretical_whole": 0,
        "devices_expected_whole": 0,
        "devices_after_print": 0,
        "devices_after_harvest": 0,
        "devices_after_qc": 0,
        "lost_print": 0,
        "lost_harvest": 0,
        "lost_qc": 0,
        "binding_part": None,
        "stages": [],
        "parts": [],
    }
    if not part_qty:
        return empty

    parts_theo: dict[str, float] = dict.fromkeys(part_qty, 0.0)
    parts_print: dict[str, float] = dict.fromkeys(part_qty, 0.0)
    parts_harvest: dict[str, float] = dict.fromkeys(part_qty, 0.0)
    parts_qc: dict[str, float] = dict.fromkeys(part_qty, 0.0)
    # Weight yield rates by physical parts started (for UI %).
    yield_acc: dict[str, dict[str, float]] = {c: {"w": 0.0, "s": 0.0, "h": 0.0, "q": 0.0} for c in part_qty}

    for job in _iter_first_staffed_day_jobs(plan):
        code = str(job.get("part_code") or "")
        if not code or code not in part_qty:
            continue
        qty = max(1, int(job.get("quantity_per_plate") or 1))
        if job.get("print_job_success") is not None:
            success = max(0.0, min(1.0, float(job["print_job_success"])))
        else:
            success = 1.0
        if job.get("harvest_yield") is not None:
            harvest = max(0.0, min(1.0, float(job["harvest_yield"])))
        else:
            harvest = 1.0
        if job.get("qc_yield") is not None:
            qc = max(0.0, min(1.0, float(job["qc_yield"])))
        else:
            qc = 1.0
        est = job.get("est_good_parts")
        if (
            job.get("print_job_success") is None
            and job.get("harvest_yield") is None
            and job.get("qc_yield") is None
            and est is not None
        ):
            ratio = max(0.0, min(1.0, float(est) / float(qty)))
            success, harvest, qc = 1.0, 1.0, ratio

        after_print = float(qty) * success
        after_harvest = after_print * harvest
        # Prefer the job's est_good_parts so the QC stage matches the headline
        # expected path (same source as measure_schedulable_devices).
        after_qc = float(est) if est is not None else after_harvest * qc
        after_qc = min(after_qc, after_harvest)

        parts_theo[code] += float(qty)
        parts_print[code] += after_print
        parts_harvest[code] += after_harvest
        parts_qc[code] += after_qc
        yield_acc[code]["w"] += float(qty)
        yield_acc[code]["s"] += float(qty) * success
        yield_acc[code]["h"] += float(qty) * harvest
        yield_acc[code]["q"] += float(qty) * qc

    d_theo = _devices_from_parts(part_qty, parts_theo)
    d_print = _devices_from_parts(part_qty, parts_print)
    d_harvest = _devices_from_parts(part_qty, parts_harvest)
    d_qc = _devices_from_parts(part_qty, parts_qc)

    # Anchor ends to the capacity headline (same floats the UI floors).
    if theoretical is not None:
        d_theo = float(theoretical)
    if expected is not None:
        d_qc = float(expected)
    d_theo = max(0.0, d_theo)
    d_qc = max(0.0, min(d_qc, d_theo))
    d_print = min(max(d_print, d_qc), d_theo)
    d_harvest = min(max(d_harvest, d_qc), d_print)

    # Whole-device waterfall — floors telescope: losses sum to theo − expected.
    w_theo = _whole_devices(d_theo)
    w_qc = _whole_devices(d_qc)
    w_print = min(max(_whole_devices(d_print), w_qc), w_theo)
    w_harvest = min(max(_whole_devices(d_harvest), w_qc), w_print)

    lost_print = w_theo - w_print
    lost_harvest = w_print - w_harvest
    lost_qc = w_harvest - w_qc
    lost_total = lost_print + lost_harvest + lost_qc  # == w_theo - w_qc

    binding = _binding_part_from_packed(part_qty, parts_qc) or _binding_part_from_packed(part_qty, parts_theo)

    stages = [
        {
            "stage": "print",
            "label": "Print failures",
            "devices_lost": lost_print,
            "devices_after": w_print,
            "binding_part": _binding_part_from_packed(part_qty, parts_print),
        },
        {
            "stage": "harvest",
            "label": "Harvest scrap",
            "devices_lost": lost_harvest,
            "devices_after": w_harvest,
            "binding_part": _binding_part_from_packed(part_qty, parts_harvest),
        },
        {
            "stage": "qc",
            "label": "QC rejects",
            "devices_lost": lost_qc,
            "devices_after": w_qc,
            "binding_part": _binding_part_from_packed(part_qty, parts_qc),
        },
    ]

    part_rows = []
    for code, qty_dev in part_qty.items():
        w = yield_acc[code]["w"]
        if w <= 0:
            continue
        part_rows.append(
            {
                "part_code": code,
                "qty_per_device": int(qty_dev),
                "print_job_success": yield_acc[code]["s"] / w,
                "harvest_yield": yield_acc[code]["h"] / w,
                "qc_yield": yield_acc[code]["q"] / w,
                "devices_theoretical": parts_theo[code] / max(1, int(qty_dev)),
                "devices_expected": parts_qc[code] / max(1, int(qty_dev)),
                "is_binding": code == binding,
            }
        )
    part_rows.sort(key=lambda r: (not r["is_binding"], r["part_code"]))

    return {
        "devices_lost_total": lost_total,
        "devices_theoretical_whole": w_theo,
        "devices_expected_whole": w_qc,
        "devices_after_print": w_print,
        "devices_after_harvest": w_harvest,
        "devices_after_qc": w_qc,
        "lost_print": lost_print,
        "lost_harvest": lost_harvest,
        "lost_qc": lost_qc,
        "binding_part": binding,
        "stages": stages,
        "parts": part_rows,
    }


async def measure_schedulable_devices(
    db: AsyncSession,
    *,
    week_start: date | None = None,
    capacity: dict | None = None,
) -> dict:
    """Max complete devices/day the shared-fleet packer can clear (no readiness boost).

    ``devices_per_day_theoretical`` = physical plate starts (100% yield).
    ``devices_per_day_realistic`` = expected good devices after print/harvest/QC yields
    on those same starts.

    Uses binary search: a single huge probe ask is non-monotonic (over-asking KNB/BOT
    steals compact/X1C time from TOP and can *lower* packed devices).
    """
    capacity = capacity or await compute_capacity_unconstrained(db)
    u_r = float(capacity.get("devices_per_day_realistic") or 0.0)
    u_t = float(capacity.get("devices_per_day_theoretical") or 0.0)
    if u_r <= 0 and u_t <= 0:
        return {
            "devices_per_day_realistic": 0.0,
            "devices_per_day_theoretical": 0.0,
            "binding_part": capacity.get("binding_part"),
            "yield_drag": None,
        }
    ceiling = max(u_r, u_t, 1.0) * 3.0
    lo = 0.0
    hi = ceiling
    best_target = 0.0
    best_physical = 0.0
    best_plan: dict | None = None
    # ~10 iterations → ~0.1% of ceiling; enough for whole devices.
    # Packing is non-monotonic in the ask (over-asking BOT can steal TOP time),
    # so always retain the densest *physical* pack seen — even from infeasible
    # probes — then re-pack at that whole-device target.
    for _ in range(12):
        mid = (lo + hi) / 2.0
        if mid <= 0:
            break
        plan = await compute_print_plan(
            db,
            week_start=week_start,
            target_devices=mid,
            apply_readiness_boost=False,
            capacity=capacity,
        )
        ach = float(plan.get("devices_achievable") or 0.0)
        pq = {r["part_code"]: int(r["qty_per_device"]) for r in plan.get("scenario_rows") or []}
        packed = {k: float(v) for k, v in (plan.get("parts_packed") or {}).items()}
        packed_devs = _devices_from_parts(pq, packed) if pq else 0.0
        if packed_devs > best_physical + 1e-9:
            best_physical = packed_devs
            best_plan = plan
        if bool(plan.get("feasible")) and ach + 1e-9 >= mid and packed_devs + 1e-9 >= mid:
            best_target = mid
            lo = mid
        else:
            hi = mid
            if ach > best_target + 1e-9:
                best_target = ach

    if best_plan is None:
        best_plan = await compute_print_plan(
            db,
            week_start=week_start,
            target_devices=max(u_t, 1.0),
            apply_readiness_boost=False,
            capacity=capacity,
        )
        best_target = float(best_plan.get("devices_achievable") or 0.0)
        pq = {r["part_code"]: int(r["qty_per_device"]) for r in best_plan.get("scenario_rows") or []}
        packed = {k: float(v) for k, v in (best_plan.get("parts_packed") or {}).items()}
        best_physical = _devices_from_parts(pq, packed) if pq else best_target

    # Prefer the best physical pack observed; ask at a whole-device target so the
    # Gantt matches theoretical (yields only affect expected afterward).
    final_target = max(best_target, best_physical, 0.0)
    final_target = float(int(final_target + 1e-9)) if final_target > 0 else 0.0
    plan = await compute_print_plan(
        db,
        week_start=week_start,
        target_devices=final_target if final_target > 0 else max(u_t, 1.0),
        apply_readiness_boost=False,
        capacity=capacity,
    )
    part_qty = {r["part_code"]: int(r["qty_per_device"]) for r in plan.get("scenario_rows") or []}
    packed_parts = {k: float(v) for k, v in (plan.get("parts_packed") or {}).items()}
    # Use physical BOM-limited devices from packed parts — not devices_achievable,
    # which may boost up to the ask even when multi-up rounding leaves a short part.
    theoretical = _devices_from_parts(part_qty, packed_parts) if part_qty else 0.0
    # Non-monotonic packing: a probe may have packed denser than the final
    # whole-device re-ask. Keep that denser plan if the re-pack underperforms.
    if best_plan is not None:
        bp_qty = {r["part_code"]: int(r["qty_per_device"]) for r in best_plan.get("scenario_rows") or []}
        bp_packed = {k: float(v) for k, v in (best_plan.get("parts_packed") or {}).items()}
        bp_theo = _devices_from_parts(bp_qty, bp_packed) if bp_qty else 0.0
        if bp_theo > theoretical + 1e-9:
            plan = best_plan
            part_qty = bp_qty
            packed_parts = bp_packed
            theoretical = bp_theo

    expected_parts = _expected_good_parts_from_plan(plan)
    for code in part_qty:
        expected_parts.setdefault(code, 0.0)
    expected = _devices_from_parts(part_qty, expected_parts) if part_qty else 0.0
    expected = min(float(expected), theoretical)
    binding = _binding_part_from_packed(part_qty, expected_parts) or _binding_part_from_packed(
        part_qty,
        packed_parts,
    )
    yield_drag = (
        yield_drag_from_plan(
            plan,
            part_qty,
            theoretical=theoretical,
            expected=expected,
        )
        if part_qty
        else None
    )
    return {
        "devices_per_day_realistic": expected,
        "devices_per_day_theoretical": theoretical,
        "binding_part": binding or capacity.get("binding_part"),
        "yield_drag": yield_drag,
    }


async def compute_print_plan(
    db: AsyncSession,
    *,
    week_start: date | None = None,
    target_devices: float | None = None,
    apply_readiness_boost: bool = False,
    timeline_mode: str = _TIMELINE_CAPACITY,
    capacity: dict | None = None,
    schedulable_ceiling: float | None = None,
    fleet_boost: dict[str, int] | None = None,
    allow_hypothetical_fleet: bool = False,
) -> dict:
    today = await shop_today(db)
    if week_start is None:
        week_start = today - timedelta(days=today.weekday())
    # Normalize to Monday
    week_start = week_start - timedelta(days=week_start.weekday())

    mode = str(timeline_mode or _TIMELINE_CAPACITY).strip().lower()
    if mode not in (_TIMELINE_CAPACITY, _TIMELINE_BUFFER):
        mode = _TIMELINE_CAPACITY
    apply_buffer_targets = mode == _TIMELINE_BUFFER

    globals_ = await get_stats2_globals(db)
    clear_minutes = int(globals_.expected_plate_clear_minutes)
    buffer_targets = {
        str(code).upper(): int(qty) for code, qty in (globals_.ready_buffer_targets or {}).items() if int(qty) > 0
    }
    recipe = await get_recipe_view(db)
    # Dedicated-fleet rates (may overstate shared printers). Schedulable ceiling
    # is measured separately so the default target matches the timeline.
    capacity = capacity or await compute_capacity_unconstrained(db)
    readiness = await compute_readiness(db)
    fleet = await count_active_printers_by_model(db)

    u_r = float(capacity.get("devices_per_day_realistic") or 0.0)
    u_t = float(capacity.get("devices_per_day_theoretical") or 0.0)
    capacity_theoretical = u_t
    if target_devices is None:
        measured = await measure_schedulable_devices(db, week_start=week_start, capacity=capacity)
        # Schedule to the physical pack ceiling; expected (yield-adjusted) is reported separately.
        capacity_theoretical = float(measured.get("devices_per_day_theoretical") or 0.0)
        capacity_realistic = float(measured.get("devices_per_day_realistic") or 0.0)
        target = capacity_theoretical
        binding_print = measured.get("binding_part") or capacity.get("binding_part")
    else:
        # Explicit what-if (and binary-search probes): pack once at the asked
        # target. Re-running measure_schedulable_devices here multiplies latency
        # (~10× pack runs); the UI already has the schedulable ceiling from
        # /capacity / overview.
        target = max(0.0, float(target_devices))
        binding_print = capacity.get("binding_part")
        capacity_realistic = u_r
        capacity_theoretical = u_t

    binding_ready = readiness.get("binding_part") if apply_readiness_boost else None

    ready_by_code: dict[str, int] = {}
    for part in readiness.get("parts") or []:
        code = str(part.get("part_code") or "").upper()
        if code:
            ready_by_code[code] = int(part.get("ready_now") or 0)

    # Ranked production files per (part, printer_model) — densest/best first.
    # Packing may fall back to a shorter plate when the preferred one cannot
    # clear printer time-blocks (e.g. TOP x4 vs daily morning reserved hour).
    slot_ids: list[int] = []
    for line in recipe["lines"]:
        for slot in line.get("discovered_slots") or []:
            if slot.get("slot_id") is not None:
                slot_ids.append(int(slot["slot_id"]))
    metrics_map = await get_slot_metrics_map(db, slot_ids)

    part_model_slots: dict[str, dict[str, list[dict]]] = {}
    part_qty: dict[str, int] = {}
    part_names: dict[str, str] = {}
    for line in recipe["lines"]:
        code = line["part_code"]
        part_qty[code] = max(1, int(line["qty_per_device"]))
        part_names[code] = line.get("part_name") or code
        model_map: dict[str, list[dict]] = {}
        for model, model_slots in _group_slots_by_model(list(line.get("discovered_slots") or [])).items():
            printers = eligible_printer_count(fleet, model, code)
            if printers <= 0:
                continue
            ranked = rank_slots_for_model(
                model_slots,
                metrics_map=metrics_map,
                clear_minutes=clear_minutes,
                printers=printers,
            )
            if ranked:
                model_map[model] = ranked
        if model_map:
            part_model_slots[code] = model_map

    # Demand in parts (not plates) so mixed qty/plate across models works.
    # Whole units only — you either need N physical parts or you don't.
    parts_needed_base: dict[str, float] = {}
    plates_needed_approx: dict[str, int] = {}
    plate_qty_by_code: dict[str, int] = {}
    scenario_rows: list[dict] = []
    for code, model_map in part_model_slots.items():
        qty_dev = part_qty[code]
        needed_parts = float(int(round(_parts_for_target(target, qty_dev))))
        parts_needed_base[code] = needed_parts
        # Approximate plate count using the densest file (UI legacy field).
        max_qty_plate = max(max(1, int(s.get("quantity") or 1)) for slots in model_map.values() for s in slots)
        plate_qty_by_code[code] = max_qty_plate
        plates_needed_approx[code] = int((needed_parts + max_qty_plate - 1) // max_qty_plate)
        scenario_rows.append(
            {
                "part_code": code,
                "qty_per_device": qty_dev,
                "quantity_per_plate": max_qty_plate,
                "plates_needed": plates_needed_approx[code],
                "parts_needed": int(needed_parts),
            }
        )

    # Buffer timeline: plate-quantized catch-up from ready-on-hand vs targets.
    # Front-loaded across staffed days; capacity mode leaves these at 0.
    buffer_debt_initial: dict[str, float] = {}
    buffer_remaining: dict[str, float] = {}
    if apply_buffer_targets:
        for code, target_qty in buffer_targets.items():
            if code not in part_model_slots:
                continue
            ready_now = int(ready_by_code.get(code, 0))
            shortfall = max(0, int(target_qty) - ready_now)
            catch = quantize_buffer_catch_up(shortfall, plate_qty_by_code.get(code, 1))
            if catch > 0:
                buffer_debt_initial[code] = float(catch)
                buffer_remaining[code] = float(catch)

    # Priority order for packing — buffer-short parts first in buffer mode.
    priority_parts: list[str] = []
    if apply_buffer_targets:
        for code, _debt in sorted(buffer_remaining.items(), key=lambda kv: (-kv[1], kv[0])):
            if code in part_model_slots and code not in priority_parts:
                priority_parts.append(code)
    for code in (binding_ready, binding_print):
        if code and code in part_model_slots and code not in priority_parts:
            priority_parts.append(code)
    for code in part_model_slots:
        if code not in priority_parts:
            priority_parts.append(code)

    days_out = []
    # Headline feasibility from the first staffed weekday (devices/day).
    headline_packed: dict[str, float] | None = None

    models_needed = {model for model_map in part_model_slots.values() for model in model_map}
    # Multi-up surplus carried across the week (e.g. one BUT x47 plate covers
    # ~2 days of a ~23-device target — do not reprint it every weekday).
    part_surplus: dict[str, float] = dict.fromkeys(part_model_slots, 0.0)
    # Printer free-at as minutes-from-midnight on the *next* calendar day
    # (may be >= 1440 when a multi-day print is still running past tomorrow).
    # Never store ``cursor % 1440`` — that turns "Thu 08:10" into "Wed 08:10"
    # and double-books the printer while yesterday's job is still printing.
    printer_free_at: dict[int, int] = {}

    block_rows = await list_blocks(db, enabled_only=True)
    blocks_by_printer = intervals_by_printer_day(block_rows)

    boost_map = {
        str(normalize_printer_model(m) or m): max(0, int(n))
        for m, n in (fleet_boost or {}).items()
        if max(0, int(n)) > 0 and (normalize_printer_model(m) or m)
    }
    # Only inject models the recipe can actually print.
    boost_map = {m: n for m, n in boost_map.items() if m in models_needed}
    virtual_specs = _virtual_printer_specs(boost_map)
    hyp_ids = {pid for pid, _, _ in virtual_specs}

    for day_offset in range(7):
        day = week_start + timedelta(days=day_offset)
        effective = await get_effective_schedule(db, day)
        windows = staffed_windows_for_day(effective)
        day_is_staffed = bool(windows)
        line_start_min = hhmm_to_minutes(effective.line_start_time) or 8 * 60
        ready_deadline_min = hhmm_to_minutes(effective.ready_deadline_time) or line_start_min
        dow = day.weekday()

        all_printers = (
            (await db.execute(select(Printer).where(Printer.is_active.is_(True)).order_by(Printer.name)))
            .scalars()
            .all()
        )
        lanes: dict[int, _LaneState] = {}
        for p in all_printers:
            model = normalize_printer_model(p.model)
            if model not in models_needed:
                continue
            default_start = windows[0][0] if windows else 0
            start_cursor = printer_free_at.pop(p.id, default_start)
            # Only pull an early carry up to today's staffed open — never clamp a
            # mid/late-day free time, and never clamp a still-busy multi-day cursor.
            if windows and 0 <= start_cursor < windows[0][0]:
                start_cursor = windows[0][0]
            lanes[p.id] = _LaneState(
                printer_id=p.id,
                printer_name=p.name,
                model=model,
                cursor_minute=start_cursor,
            )
        for vid, vname, vmodel in virtual_specs:
            default_start = windows[0][0] if windows else 0
            start_cursor = printer_free_at.pop(vid, default_start)
            if windows and 0 <= start_cursor < windows[0][0]:
                start_cursor = windows[0][0]
            lanes[vid] = _LaneState(
                printer_id=vid,
                printer_name=vname,
                model=vmodel,
                cursor_minute=start_cursor,
                hypothetical=True,
            )

        # Apply carried multi-up surplus before asking for new plates today.
        parts_needed: dict[str, float] = {}
        for code, daily in parts_needed_base.items():
            covered = min(float(part_surplus.get(code, 0.0)), float(daily))
            part_surplus[code] = float(part_surplus.get(code, 0.0)) - covered
            parts_needed[code] = max(0.0, float(daily) - covered)
        parts_packed_day: dict[str, float] = dict.fromkeys(part_model_slots, 0.0)
        buffer_ask_today: dict[str, float] = {}

        # Production schedule ask = target × BOM only. Do NOT add readiness
        # inventory shortfall on top — that overproduced the short floor part
        # (e.g. TOP 30 vs BOT 18) while pretending demand was still the target.
        # Optional catch-up: replace the ask with max(0, target − ready), never add.
        if apply_readiness_boost and binding_ready and binding_ready in parts_needed:
            ready_parts = next(
                (p for p in readiness.get("parts", []) if p["part_code"] == binding_ready),
                None,
            )
            if ready_parts is not None:
                qty_dev = max(1, int(part_qty.get(binding_ready, 1)))
                ready_now = float(ready_parts.get("ready_now") or 0)
                # Parts still needed for ``target`` complete devices given floor stock.
                catch_up = max(0.0, float(target) * qty_dev - ready_now)
                parts_needed[binding_ready] = max(
                    float(parts_needed.get(binding_ready, 0.0)),
                    catch_up,
                )

        # Buffer timeline: raise today's ask to plate-quantized remaining debt
        # (max with daily — substitution on shared printers, not unbounded add).
        if apply_buffer_targets and day_is_staffed:
            for code, debt in list(buffer_remaining.items()):
                if debt <= 0 or code not in parts_needed:
                    continue
                catch = float(quantize_buffer_catch_up(int(max(1, round(debt))), plate_qty_by_code.get(code, 1)))
                parts_needed[code] = max(float(parts_needed.get(code, 0.0)), catch)
                buffer_ask_today[code] = catch

        packable_parts = priority_parts if day_is_staffed else []
        remaining_by_code = {code: float(parts_needed.get(code, 0.0)) for code in packable_parts}

        # Pack least-covered BOM parts first so shared fleets (X1C) raise
        # complete devices instead of overbuilding TOP on A1 while BOT is short.
        guard = 0
        while guard < 4000 and any(v > 0 for v in remaining_by_code.values()):
            guard += 1
            placed_any = False
            ordered_parts = _bom_balanced_part_order(
                packable_parts,
                part_qty=part_qty,
                parts_packed_day=parts_packed_day,
                remaining_by_code=remaining_by_code,
                binding_print=binding_print if isinstance(binding_print, str) else None,
            )
            for code in ordered_parts:
                remaining = remaining_by_code.get(code, 0.0)
                model_map = part_model_slots.get(code) or {}
                if remaining <= 0 or not model_map:
                    continue

                rationale = "buffer"
                if apply_buffer_targets and code in buffer_ask_today and float(buffer_ask_today.get(code, 0)) > 0:
                    rationale = "inventory_buffer"
                elif code == binding_ready and apply_readiness_boost:
                    rationale = "inventory_shortfall"
                elif code == binding_print:
                    rationale = "print_bottleneck"

                free_lanes = [ln for ln in lanes.values() if ln.model in model_map and ln.cursor_minute < _DAY_MINUTES]
                if not free_lanes:
                    # No lane free *this* iteration — other parts may free a
                    # shared printer later in the day. Do not abandon the ask.
                    continue

                # Score every feasible lane×slot first, then apply a *time-aware*
                # compact preference: lock to A1/A1M only when compact can start
                # as soon as (within epsilon of) the earliest option. If H2D/X1C
                # can start this morning but compact is busy until tonight, spill
                # TOP onto H2D now — do not leave El Jefe idle all day.
                scored: list[tuple[tuple, _LaneState, dict, int, int, int, float, float, float, float]] = []
                for lane in free_lanes:
                    projected_blocks = project_blocks_for_packing_day(
                        blocks_by_printer.get(lane.printer_id, {}),
                        day_of_week=dow,
                        horizon_days=3,
                    )
                    for slot in model_map[lane.model]:
                        print_time = int(slot.get("print_time_seconds") or 3600)
                        print_min = max(1, (print_time + 59) // 60)
                        qty_plate = max(1, int(slot.get("quantity") or 1))
                        metrics = metrics_map.get(int(slot["slot_id"])) if slot.get("slot_id") is not None else None
                        success, harvest, qc = plate_yield_rates(metrics)
                        # Yield-adjusted parts for expected/realistic only.
                        eff = float(qty_plate) * success * harvest * qc
                        start = next_start_avoiding_blocks(
                            lane.cursor_minute,
                            windows,
                            projected_blocks,
                            print_min=print_min,
                            clear_minutes=clear_minutes,
                            next_clear_start_fn=next_clear_start,
                            day_limit=_DAY_MINUTES,
                        )
                        if start is None:
                            continue
                        end = start + print_min
                        _clear_start, clear_end = next_clear_start(end, windows, clear_minutes)
                        occupancy = max(1, int(clear_end) - int(start))
                        # Score placements on physical qty so imperfect QC/yield
                        # cannot shrink the theoretical schedule (e.g. H2S BOT x5
                        # with qc=0.75 losing to X1C BOT and capping devices at 23).
                        rate = float(qty_plate) / float(occupancy)

                        n_same_wave = sum(
                            1
                            for ln in free_lanes
                            if ln.model == lane.model
                            and abs(int(ln.cursor_minute) - int(lane.cursor_minute)) <= _PARALLEL_WAVE_EPSILON_MIN
                        )
                        plates_needed_for_ask = max(1, int((remaining + qty_plate - 1e-9) // max(qty_plate, 1)))
                        starts = min(max(1, n_same_wave), plates_needed_for_ask)
                        raw_progress = float(starts) * float(qty_plate)
                        # Single-printer dedicated models (H2S→BOT): do not cap
                        # progress by leftover ask. Capping made BOT x2 tie BOT x5
                        # at remaining=2, then sooner-wave picked x2 and idled the
                        # H2S. Multi-printer fleets still cap so parallel shorts
                        # and shared BOT→TOP switches keep working.
                        model_fleet = sum(1 for ln in lanes.values() if ln.model == lane.model)
                        if model_fleet <= 1 and _model_sharedness(lane.model, part_model_slots) <= 1:
                            wave_progress = raw_progress
                        else:
                            wave_progress = min(float(remaining), raw_progress)

                        key = placement_sort_key(
                            progress=wave_progress,
                            rate=rate,
                            clear_end=int(clear_end),
                            qty=qty_plate,
                            wave_time=occupancy,
                            start=int(start),
                        )
                        scored.append((key, lane, slot, start, end, clear_end, eff, success, harvest, qc))

                if not scored:
                    # Every free lane rejected this part's plates right now
                    # (blocks / staffed window). Retry after other placements.
                    continue

                if _part_can_use_compact(model_map):
                    earliest_all = min(int(row[3]) for row in scored)
                    compact_starts = [int(row[3]) for row in scored if row[1].model in _COMPACT_MODELS]
                    earliest_compact = min(compact_starts) if compact_starts else None
                    if earliest_compact is not None and earliest_compact <= earliest_all + _COMPACT_START_EPSILON_MIN:
                        scored = [row for row in scored if row[1].model in _COMPACT_MODELS]
                    elif earliest_compact is not None and earliest_all < earliest_compact:
                        # Shared fleet can start sooner — use it this placement.
                        spilled = [row for row in scored if row[1].model not in _COMPACT_MODELS]
                        if spilled:
                            scored = spilled

                scored.sort(key=lambda row: row[0], reverse=True)
                _key, lane, slot, start, end, clear_end, eff, success, harvest, qc = scored[0]
                qty_plate = max(1, int(slot.get("quantity") or 1))
                ready_by = clear_end
                for_line = day if ready_by <= ready_deadline_min else day + timedelta(days=1)
                lane.jobs.append(
                    {
                        "start_at": _iso(day, start),
                        "end_at": _iso(day, end),
                        "clear_until": _iso(day, clear_end),
                        "ready_by_estimate": _iso(day, ready_by),
                        "for_line_date": for_line.isoformat(),
                        "slot_id": slot.get("slot_id"),
                        "filename": slot.get("filename"),
                        "part_code": code,
                        "quantity_per_plate": qty_plate,
                        "priority": priority_parts.index(code) + 1,
                        "rationale": rationale,
                        "est_good_parts": round(eff, 4),
                        "print_job_success": round(success, 6),
                        "harvest_yield": round(harvest, 6),
                        "qc_yield": round(qc, 6),
                    }
                )
                lane.cursor_minute = clear_end
                remaining_by_code[code] = remaining - qty_plate
                parts_packed_day[code] = parts_packed_day.get(code, 0.0) + float(qty_plate)
                placed_any = True
            if not placed_any:
                break

        # Multi-up plates that overshoot today's ask become tomorrow's surplus.
        for code in part_model_slots:
            ask = float(parts_needed.get(code, 0.0))
            packed = float(parts_packed_day.get(code, 0.0))
            if packed > ask:
                part_surplus[code] = float(part_surplus.get(code, 0.0)) + (packed - ask)

        # Credit packed parts against remaining buffer debt (plan-local only).
        if apply_buffer_targets:
            for code in list(buffer_remaining.keys()):
                packed = float(parts_packed_day.get(code, 0.0))
                if packed <= 0:
                    continue
                buffer_remaining[code] = max(0.0, float(buffer_remaining.get(code, 0.0)) - packed)

        # Overnight / multi-day clears: carry remaining busy time into tomorrow
        # as minutes-from-tomorrow-midnight (may exceed one day).
        for lane in lanes.values():
            if lane.cursor_minute >= _DAY_MINUTES:
                printer_free_at[lane.printer_id] = int(lane.cursor_minute - _DAY_MINUTES)

        if day_is_staffed and headline_packed is None:
            headline_packed = dict(parts_packed_day)

        lanes_out = []
        for lane in sorted(
            lanes.values(),
            key=lambda ln: (1 if ln.hypothetical else 0, ln.model, ln.printer_name),
        ):
            day_blocks = [] if lane.printer_id in hyp_ids else blocks_by_printer.get(lane.printer_id, {}).get(dow, [])
            lanes_out.append(
                {
                    "printer_id": lane.printer_id,
                    "printer_name": lane.printer_name,
                    "printer_model": lane.model,
                    "hypothetical": bool(lane.hypothetical),
                    "jobs": lane.jobs,
                    "time_blocks": [
                        {
                            "start_time": minutes_to_hhmm(s),
                            "end_time": minutes_to_hhmm(e),
                            "label": label,
                        }
                        for s, e, label in day_blocks
                    ],
                }
            )

        staffed_minutes = (
            sum(e - s for s, e in windows)
            if windows
            else (_STUB_STAFFED_MINUTES if effective.using_default_stub and day.weekday() < 5 else 0)
        )

        days_out.append(
            {
                "date": day.isoformat(),
                "day_of_week": day.weekday(),
                "line_start_at": _iso(day, line_start_min),
                "ready_deadline_at": _iso(day, ready_deadline_min),
                "staffed_windows": [
                    {"start_time": minutes_to_hhmm(s), "end_time": minutes_to_hhmm(e)} for s, e in windows
                ],
                "staffed_minutes": staffed_minutes,
                "using_default_stub": effective.using_default_stub,
                "lanes": lanes_out,
            }
        )

    packed_parts = headline_packed or dict.fromkeys(part_model_slots, 0.0)
    devices_achievable = _devices_from_parts(part_qty, packed_parts)
    # Count actual plate starts on the first staffed day (matches Gantt bars).
    plates_packed: dict[str, int] = dict.fromkeys(part_model_slots, 0)
    for day_payload in days_out:
        if float(day_payload.get("staffed_minutes") or 0) <= 0:
            continue
        for lane in day_payload.get("lanes") or []:
            for job in lane.get("jobs") or []:
                code = str(job.get("part_code") or "")
                if code in plates_packed:
                    plates_packed[code] += 1
        break
    all_base_packed = bool(parts_needed_base) and all(
        packed_parts.get(c, 0.0) + 1e-9 >= parts_needed_base.get(c, 0.0) for c in parts_needed_base
    )
    if target <= 0:
        feasible = True
        devices_achievable = 0.0
    elif all_base_packed:
        feasible = True
        devices_achievable = max(devices_achievable, target)
    else:
        feasible = False

    short_parts: list[dict] = []
    # Only the real-fleet pass computes shorts and may re-pack with a boost.
    # A boosted pass must not recurse again.
    if fleet_boost is None and not feasible and target > 0:
        # Prefer the shop's measured schedulable ceiling (from overview / query)
        # so extras match "Capacity ~N/day". Fall back to unconstrained / packed.
        capacity_ceiling = max(
            float(schedulable_ceiling or 0.0),
            float(devices_achievable or 0.0),
            float(capacity_theoretical or 0.0),
            float(capacity_realistic or 0.0),
            1.0,
        )
        short_parts = _short_parts_from_pack(
            part_qty=part_qty,
            parts_needed=parts_needed_base,
            parts_packed=packed_parts,
            part_model_slots=part_model_slots,
            fleet=fleet,
            target=target,
            capacity_ceiling=capacity_ceiling,
            days_out=days_out,
        )
        if short_parts:
            # Worst short part wins binding for packer / backward-compat callers.
            binding_print = str(short_parts[0]["part_code"])

        boost = _fleet_boost_from_shorts(short_parts)
        if allow_hypothetical_fleet and boost:
            boosted = await compute_print_plan(
                db,
                week_start=week_start,
                target_devices=target,
                apply_readiness_boost=apply_readiness_boost,
                timeline_mode=mode,
                capacity=capacity,
                schedulable_ceiling=schedulable_ceiling,
                fleet_boost=boost,
                allow_hypothetical_fleet=False,
            )
            boosted["short_parts"] = short_parts
            boosted["binding_print_part"] = binding_print
            boosted["hypothetical_fleet"] = True
            boosted["hypothetical_added"] = {k: int(v) for k, v in sorted(boost.items())}
            return boosted

    return {
        "week_start": week_start.isoformat(),
        "timeline_mode": mode,
        "target_devices": target,
        "capacity_devices_realistic": capacity_realistic,
        "capacity_devices_theoretical": capacity_theoretical,
        "devices_achievable": devices_achievable,
        "feasible": feasible,
        "plates_needed": plates_needed_approx,
        "plates_packed": plates_packed,
        "parts_needed": {k: float(v) for k, v in parts_needed_base.items()},
        "parts_packed": {k: float(v) for k, v in packed_parts.items()},
        "scenario_rows": scenario_rows,
        "short_parts": short_parts,
        "binding_readiness_part": readiness.get("binding_part"),
        "binding_print_part": binding_print,
        "buffer_targets": {k: int(v) for k, v in buffer_targets.items()},
        "buffer_ready": {k: int(ready_by_code.get(k, 0)) for k in buffer_targets},
        "buffer_debt": {k: float(v) for k, v in buffer_debt_initial.items()},
        "buffer_debt_remaining": {k: float(v) for k, v in buffer_remaining.items() if float(v) > 0},
        "as_of": datetime.now(timezone.utc).isoformat(),
        "days": days_out,
        "capacity_devices_unconstrained": u_r,
        "capacity_devices_theoretical_unconstrained": u_t,
        "hypothetical_fleet": bool(virtual_specs),
        "hypothetical_added": {k: int(v) for k, v in sorted(boost_map.items())} if boost_map else {},
    }
