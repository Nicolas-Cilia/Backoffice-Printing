"""Stats 2 capacity analysis: theoretical + yield-adjusted devices/day.

Uses operator schedule + expected plate clear (NOT historical turnaround).
Yields come from per-slot metrics; defaults are 1.0 when data is sparse.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent
from backend.app.models.floor_unit import FloorProductUnit
from backend.app.models.printer import Printer
from backend.app.models.production import default_part_codes_for_printer
from backend.app.services.device_recipe_service import get_recipe_view
from backend.app.services.operator_schedule_service import get_effective_schedule
from backend.app.services.production_filename import normalize_production_printer_code
from backend.app.services.stats2_config import get_stats2_globals, hhmm_to_minutes, shop_today
from backend.app.services.stats2_readiness import compute_readiness
from backend.app.services.stats2_slot_metrics import SlotMetrics, get_slot_metrics_map

# Match operator_schedule stub: Mon–Fri 08:00–17:00
_STUB_STAFFED_MINUTES = (17 - 8) * 60
_DEFAULT_PRINT_TIME_SECONDS = 3600  # 1h fallback when slot has no metadata
_DAY_MINUTES = 24 * 60
# Horizon for steady-state plates/day (overnight prints clear on later days).
_PLATE_SIM_HORIZON_DAYS = 14


@dataclass(frozen=True)
class ComponentCapacity:
    part_code: str
    part_name: str
    qty_per_device: int
    slot_id: int | None
    filename: str | None
    printer_model: str | None
    quantity_per_plate: int
    print_time_seconds: int
    cycle_seconds: int
    active_printers: int
    plates_per_printer_per_day_theo: float
    plates_per_printer_per_day: float
    effective_parts_per_plate: float
    parts_per_day: float
    devices_from_component: float
    print_job_success: float
    harvest_yield: float
    qc_yield: float
    incomplete: bool
    warning: str | None = None
    # True when the yields came from defaults (no per-slot history backing them).
    using_defaults: bool = False
    # True when print_time_seconds was assumed (slot had no print-time metadata).
    print_time_assumed: bool = False
    # Theoretical devices/day for this component (yields forced to 1.0).
    devices_theoretical: float = 0.0
    # Per-model contributions when capacity sums the whole fleet.
    model_breakdown: tuple[dict, ...] = ()


def cycle_seconds(print_time_seconds: int, clear_minutes: int) -> int:
    return max(1, int(print_time_seconds) + int(clear_minutes) * 60)


def plates_per_printer_per_day(staffed_seconds: float, cycle_sec: int, job_success: float = 1.0) -> float:
    if cycle_sec <= 0 or staffed_seconds <= 0:
        return 0.0
    theo = staffed_seconds / cycle_sec
    return theo * max(0.0, min(1.0, job_success))


def effective_parts_per_plate(qty: int, harvest_yield: float, qc_yield: float) -> float:
    return max(0.0, int(qty)) * max(0.0, min(1.0, harvest_yield)) * max(0.0, min(1.0, qc_yield))


# ── Schedule-aware plate throughput (shared with the print-plan packer) ─────
#
# Prints may RUN through unstaffed hours. Starts and clears require staff.
# Capacity uses a multi-day steady-state sim so overnight / multi-day prints
# still contribute plates/day (clear + next start happen when staff return).


def staffed_windows_for_day(effective) -> list[tuple[int, int]]:
    """Staffed ``(start, end)`` minute-of-day windows for a day's schedule.

    The Mon–Fri default stub is 08:00–17:00; weekends in the stub (and any
    unstaffed day) yield no windows.
    """
    if effective.using_default_stub:
        if effective.day_of_week is not None and effective.day_of_week < 5:
            return [(8 * 60, 17 * 60)]
        return []
    windows: list[tuple[int, int]] = []
    for w in effective.windows or []:
        start = hhmm_to_minutes(w.get("start_time"))
        end = hhmm_to_minutes(w.get("end_time"))
        if start is not None and end is not None and end > start:
            windows.append((start, end))
    return windows


def next_clear_start(finish_minute: int, windows: list[tuple[int, int]], clear_minutes: int) -> tuple[int, int]:
    """``(clear_start, clear_end)`` for a plate finishing at ``finish_minute``.

    Clears only happen while staff are present. Prints may finish deep into
    unstaffed / multi-day time; this projects a single-day staffed pattern
    forward to the finish day so clear never precedes finish.

    If the clear would end past the staffed window that contains (or receives)
    it, the full clear spills to the next staffed window opening.
    """
    if not windows:
        return finish_minute, finish_minute + clear_minutes

    clear_minutes = max(0, int(clear_minutes))

    # Single-day window lists (print plan) must be projected to the finish day
    # so a 20h+ print that lands tomorrow afternoon clears tomorrow afternoon,
    # not tomorrow morning before it has finished. Project an extra day so a
    # late-day spill still has a next opening.
    max_end = max(end for _start, end in windows)
    if max_end <= _DAY_MINUTES:
        day = max(0, int(finish_minute) // _DAY_MINUTES)
        projected: list[tuple[int, int]] = []
        for d in range(day, day + 3):
            offset = d * _DAY_MINUTES
            for start, end in windows:
                projected.append((start + offset, end + offset))
        windows = projected

    for start, end in windows:
        if end <= finish_minute:
            continue
        candidate = max(finish_minute, start)
        if candidate + clear_minutes <= end:
            return candidate, candidate + clear_minutes

    # Past every provided window (or no window fits the clear) → next opening.
    next_day = (windows[-1][0] // _DAY_MINUTES) + 1
    opening = windows[0][0] % _DAY_MINUTES
    clear_start = next_day * _DAY_MINUTES + opening
    return clear_start, clear_start + clear_minutes


def _next_staffed_start(cursor: int, windows: list[tuple[int, int]]) -> int | None:
    """Earliest minute >= ``cursor`` at which a print may START (staff present)."""
    for start, end in windows:
        if cursor < start:
            return start
        if start <= cursor < end:
            return cursor
    return None


def _expand_windows_over_days(
    windows: list[tuple[int, int]],
    horizon_days: int,
) -> list[tuple[int, int]]:
    """Repeat minute-of-day windows across ``horizon_days`` calendar days."""
    expanded: list[tuple[int, int]] = []
    for day in range(max(0, int(horizon_days))):
        offset = day * _DAY_MINUTES
        for start, end in windows:
            expanded.append((start + offset, end + offset))
    return expanded


def simulate_plates_per_printer_day(
    print_time_seconds: int,
    clear_minutes: int,
    windows: list[tuple[int, int]],
    *,
    horizon_days: int = _PLATE_SIM_HORIZON_DAYS,
) -> float:
    """Steady-state plates one printer fully clears per calendar day.

    A print may only START inside a staffed window but may RUN into unstaffed
    hours; the plate's clear only happens while staff are present. Long prints
    that finish overnight (or span multiple days) still count: we simulate
    ``horizon_days`` repeating copies of ``windows`` and return
    ``clears / horizon_days``.
    """
    if not windows or horizon_days <= 0:
        return 0.0
    expanded = _expand_windows_over_days(windows, horizon_days)
    print_min = max(1, (int(print_time_seconds) + 59) // 60)
    clear_min = max(0, int(clear_minutes))
    horizon_end = int(horizon_days) * _DAY_MINUTES
    cursor = expanded[0][0]
    count = 0
    guard = 0
    while guard < 5000:
        guard += 1
        start = _next_staffed_start(cursor, expanded)
        if start is None or start >= horizon_end:
            break
        finish = start + print_min
        clear_start, clear_end = next_clear_start(finish, expanded, clear_min)
        if clear_end > horizon_end:
            # Plate would clear past the simulation horizon — stop.
            break
        count += 1
        cursor = clear_end
    return count / float(horizon_days)


async def _windows_for_day(db: AsyncSession, on_date: date) -> list[tuple[int, int]]:
    effective = await get_effective_schedule(db, on_date)
    return staffed_windows_for_day(effective)


async def _representative_weekday_windows(db: AsyncSession, ref: date) -> list[tuple[int, int]]:
    """First staffed Mon–Fri window set in ``ref``'s week (capacity 'typical day')."""
    monday = ref - timedelta(days=ref.weekday())
    for i in range(5):
        windows = await _windows_for_day(db, monday + timedelta(days=i))
        if windows:
            return windows
    return []


def normalize_printer_model(model: str | None) -> str:
    """Canonical production model code (``A1 Mini`` / ``A1M`` → ``A1M``).

    Fleet keys and slot ``printer_model`` must share this space so A1 Mini
    printers match A1M production slots (and the same for other aliases).
    """
    code = normalize_production_printer_code(model)
    if code:
        return code
    return (model or "").strip().upper()


async def resolve_staffed_minutes(db: AsyncSession, on_date: date) -> tuple[int, bool]:
    """Staffed minutes for capacity; apply Mon–Fri stub when schedule empty."""
    effective = await get_effective_schedule(db, on_date)
    if effective.using_default_stub:
        if on_date.weekday() < 5:
            return _STUB_STAFFED_MINUTES, True
        return 0, True
    return int(effective.total_staffed_minutes), False


async def average_weekday_staffed_minutes(db: AsyncSession, *, ref: date | None = None) -> tuple[float, bool]:
    """Mean Mon–Fri staffed minutes (capacity 'devices/day' denominator)."""
    base = ref or await shop_today(db)
    # Align to a Monday in the same week as base
    monday = base - timedelta(days=base.weekday())
    totals: list[int] = []
    any_stub = False
    for i in range(5):
        mins, stub = await resolve_staffed_minutes(db, monday + timedelta(days=i))
        totals.append(mins)
        any_stub = any_stub or stub
    if not totals:
        return 0.0, any_stub
    return sum(totals) / len(totals), any_stub


async def count_active_printers_by_model(db: AsyncSession) -> dict[str, int]:
    rows = (await db.execute(select(Printer).where(Printer.is_active.is_(True)))).scalars().all()
    counts: dict[str, int] = {}
    for printer in rows:
        model = normalize_printer_model(printer.model)
        if not model:
            continue
        counts[model] = counts.get(model, 0) + 1
    return counts


def eligible_printer_count(
    fleet: dict[str, int],
    printer_model: str | None,
    part_code: str,
) -> int:
    model = normalize_printer_model(printer_model)
    if not model:
        return 0
    if part_code.upper() not in default_part_codes_for_printer(model):
        return 0
    return int(fleet.get(model, 0))


def _slot_from_line(line: dict) -> dict | None:
    """Best single slot for display / legacy callers (ignores preferred overrides).

    Prefer the recipe's auto-recommended slot when present; otherwise the first
    discovered slot. Capacity and print-plan no longer use this as the sole
    throughput source — see ``aggregate_component_across_models``.
    """
    slots = line.get("discovered_slots") or []
    if not slots:
        return None
    rec_id = line.get("recommended_slot_id")
    if rec_id is not None:
        for s in slots:
            if s.get("slot_id") == rec_id:
                return s
    return next((s for s in slots if s.get("recommended")), slots[0])


def _group_slots_by_model(slots: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for slot in slots:
        model = normalize_printer_model(slot.get("printer_model"))
        if model:
            grouped[model].append(slot)
    return grouped


def pick_best_slot_for_model(
    slots: list[dict],
    *,
    metrics_map: dict[int, SlotMetrics],
    clear_minutes: int,
    printers: int,
) -> dict | None:
    """Highest projected throughput slot among ``slots`` (same printer model)."""
    ranked = rank_slots_for_model(slots, metrics_map=metrics_map, clear_minutes=clear_minutes, printers=printers)
    return ranked[0] if ranked else None


def rank_slots_for_model(
    slots: list[dict],
    *,
    metrics_map: dict[int, SlotMetrics],
    clear_minutes: int,
    printers: int,
) -> list[dict]:
    """Slots for one model ordered by projected throughput (best first)."""
    if not slots:
        return []

    def _score(slot: dict) -> tuple[float, int, int]:
        metrics = metrics_map.get(int(slot["slot_id"]))
        success = metrics.print_job_success if metrics else 1.0
        harvest = metrics.harvest_yield if metrics else 1.0
        qc = metrics.qc_yield if metrics else 1.0
        raw_print_time = slot.get("print_time_seconds")
        print_time = (
            _DEFAULT_PRINT_TIME_SECONDS if raw_print_time is None or int(raw_print_time) <= 0 else int(raw_print_time)
        )
        qty = max(1, int(slot.get("quantity") or 1))
        cycle = cycle_seconds(print_time, clear_minutes)
        plates = max(0.0, min(1.0, success)) / cycle
        eff_parts = qty * max(0.0, min(1.0, harvest)) * max(0.0, min(1.0, qc))
        return (max(0, int(printers)) * plates * eff_parts, qty, -int(slot["slot_id"]))

    return sorted(slots, key=_score, reverse=True)


def compute_component(
    *,
    line: dict,
    slot: dict | None,
    staffed_seconds: float,
    clear_minutes: int,
    fleet: dict[str, int],
    metrics: SlotMetrics | None,
    windows: list[tuple[int, int]] | None = None,
) -> ComponentCapacity:
    code = line["part_code"]
    name = line.get("part_name") or code
    qty_per_device = max(1, int(line.get("qty_per_device") or 1))

    if slot is None:
        return ComponentCapacity(
            part_code=code,
            part_name=name,
            qty_per_device=qty_per_device,
            slot_id=None,
            filename=None,
            printer_model=None,
            quantity_per_plate=0,
            print_time_seconds=0,
            cycle_seconds=0,
            active_printers=0,
            plates_per_printer_per_day_theo=0.0,
            plates_per_printer_per_day=0.0,
            effective_parts_per_plate=0.0,
            parts_per_day=0.0,
            devices_from_component=0.0,
            print_job_success=1.0,
            harvest_yield=1.0,
            qc_yield=1.0,
            incomplete=True,
            warning="No active production slot under this part model",
            using_defaults=True,
            devices_theoretical=0.0,
        )

    raw_print_time = slot.get("print_time_seconds")
    print_time_assumed = raw_print_time is None or int(raw_print_time) <= 0
    print_time = _DEFAULT_PRINT_TIME_SECONDS if print_time_assumed else int(raw_print_time)
    qty_plate = max(1, int(slot.get("quantity") or 1))
    model = slot.get("printer_model")
    cycle = cycle_seconds(print_time, clear_minutes)
    success = metrics.print_job_success if metrics else 1.0
    harvest = metrics.harvest_yield if metrics else 1.0
    qc = metrics.qc_yield if metrics else 1.0

    if windows is not None:
        # Schedule-aware steady-state plates/day (prints may run unstaffed).
        sim_plates = simulate_plates_per_printer_day(print_time, clear_minutes, windows)
        theo = float(sim_plates)
        realistic_plates = float(sim_plates) * max(0.0, min(1.0, success))
    else:
        theo = plates_per_printer_per_day(staffed_seconds, cycle, 1.0)
        realistic_plates = plates_per_printer_per_day(staffed_seconds, cycle, success)
    eff_parts = effective_parts_per_plate(qty_plate, harvest, qc)
    printers = eligible_printer_count(fleet, model, code)
    parts_day = printers * realistic_plates * eff_parts
    devices = parts_day / qty_per_device
    devices_theo = (printers * theo * qty_plate) / qty_per_device

    using_defaults = metrics is None or metrics.using_defaults

    warning = None
    if printers == 0:
        warning = f"No active printers for model {model} eligible for {code}"
    elif print_time_assumed:
        warning = f"Assumed print time {_DEFAULT_PRINT_TIME_SECONDS}s (missing metadata)"

    return ComponentCapacity(
        part_code=code,
        part_name=name,
        qty_per_device=qty_per_device,
        slot_id=slot.get("slot_id"),
        filename=slot.get("filename"),
        printer_model=model,
        quantity_per_plate=qty_plate,
        print_time_seconds=print_time,
        cycle_seconds=cycle,
        active_printers=printers,
        plates_per_printer_per_day_theo=theo,
        plates_per_printer_per_day=realistic_plates,
        effective_parts_per_plate=eff_parts,
        parts_per_day=parts_day,
        devices_from_component=devices,
        print_job_success=success,
        harvest_yield=harvest,
        qc_yield=qc,
        incomplete=False,
        warning=warning,
        using_defaults=using_defaults,
        print_time_assumed=print_time_assumed,
        devices_theoretical=devices_theo,
    )


def aggregate_component_across_models(
    *,
    line: dict,
    staffed_seconds: float,
    clear_minutes: int,
    fleet: dict[str, int],
    metrics_map: dict[int, SlotMetrics],
    windows: list[tuple[int, int]] | None = None,
) -> ComponentCapacity:
    """Sum capacity across every printer model that has a production slot for ``line``.

    Preferred / single recommended slots are not used — each model contributes
    independently with its best local file, so A1 + A1M + X1C + H2D + H2S all
    count when they have matching production files and active printers.
    """
    slots = list(line.get("discovered_slots") or [])
    if not slots:
        return compute_component(
            line=line,
            slot=None,
            staffed_seconds=staffed_seconds,
            clear_minutes=clear_minutes,
            fleet=fleet,
            metrics=None,
            windows=windows,
        )

    contributions: list[ComponentCapacity] = []
    breakdown: list[dict] = []
    for model, model_slots in sorted(_group_slots_by_model(slots).items()):
        printers = eligible_printer_count(fleet, model, line["part_code"])
        if printers <= 0:
            continue
        best = pick_best_slot_for_model(
            model_slots,
            metrics_map=metrics_map,
            clear_minutes=clear_minutes,
            printers=printers,
        )
        if best is None:
            continue
        metrics = metrics_map.get(int(best["slot_id"]))
        comp = compute_component(
            line=line,
            slot=best,
            staffed_seconds=staffed_seconds,
            clear_minutes=clear_minutes,
            fleet=fleet,
            metrics=metrics,
            windows=windows,
        )
        if comp.active_printers <= 0:
            continue
        contributions.append(comp)
        breakdown.append(
            {
                "printer_model": normalize_printer_model(comp.printer_model),
                "slot_id": comp.slot_id,
                "filename": comp.filename,
                "quantity_per_plate": comp.quantity_per_plate,
                "print_time_seconds": comp.print_time_seconds,
                "active_printers": comp.active_printers,
                "plates_per_printer_per_day": comp.plates_per_printer_per_day,
                "parts_per_day": comp.parts_per_day,
                "devices_from_component": comp.devices_from_component,
                "devices_theoretical": comp.devices_theoretical,
            }
        )

    if not contributions:
        # Slots exist but no eligible fleet — surface a single-slot warning.
        return compute_component(
            line=line,
            slot=slots[0],
            staffed_seconds=staffed_seconds,
            clear_minutes=clear_minutes,
            fleet=fleet,
            metrics=metrics_map.get(int(slots[0]["slot_id"])) if slots[0].get("slot_id") is not None else None,
            windows=windows,
        )

    primary = max(contributions, key=lambda c: (c.devices_from_component, c.active_printers))
    warnings = [c.warning for c in contributions if c.warning]
    models = sorted({normalize_printer_model(c.printer_model) for c in contributions if c.printer_model})
    return ComponentCapacity(
        part_code=primary.part_code,
        part_name=primary.part_name,
        qty_per_device=primary.qty_per_device,
        slot_id=primary.slot_id,
        filename=primary.filename,
        printer_model="+".join(models) if len(models) > 1 else primary.printer_model,
        quantity_per_plate=primary.quantity_per_plate,
        print_time_seconds=primary.print_time_seconds,
        cycle_seconds=primary.cycle_seconds,
        active_printers=sum(c.active_printers for c in contributions),
        plates_per_printer_per_day_theo=(
            sum(c.plates_per_printer_per_day_theo * c.active_printers for c in contributions)
            / max(1, sum(c.active_printers for c in contributions))
        ),
        plates_per_printer_per_day=(
            sum(c.plates_per_printer_per_day * c.active_printers for c in contributions)
            / max(1, sum(c.active_printers for c in contributions))
        ),
        effective_parts_per_plate=primary.effective_parts_per_plate,
        parts_per_day=sum(c.parts_per_day for c in contributions),
        devices_from_component=sum(c.devices_from_component for c in contributions),
        print_job_success=primary.print_job_success,
        harvest_yield=primary.harvest_yield,
        qc_yield=primary.qc_yield,
        incomplete=False,
        warning="; ".join(warnings) if warnings else None,
        using_defaults=any(c.using_defaults for c in contributions),
        print_time_assumed=any(c.print_time_assumed for c in contributions),
        devices_theoretical=sum(c.devices_theoretical for c in contributions),
        model_breakdown=tuple(breakdown),
    )


def _component_to_dict(c: ComponentCapacity) -> dict:
    return {
        "part_code": c.part_code,
        "part_name": c.part_name,
        "qty_per_device": c.qty_per_device,
        "slot_id": c.slot_id,
        "filename": c.filename,
        "printer_model": c.printer_model,
        "quantity_per_plate": c.quantity_per_plate,
        "print_time_seconds": c.print_time_seconds,
        "cycle_seconds": c.cycle_seconds,
        "active_printers": c.active_printers,
        "plates_per_printer_per_day_theo": c.plates_per_printer_per_day_theo,
        "plates_per_printer_per_day": c.plates_per_printer_per_day,
        "effective_parts_per_plate": c.effective_parts_per_plate,
        "parts_per_day": c.parts_per_day,
        "devices_from_component": c.devices_from_component,
        "devices_theoretical": c.devices_theoretical,
        "print_job_success": c.print_job_success,
        "harvest_yield": c.harvest_yield,
        "qc_yield": c.qc_yield,
        "incomplete": c.incomplete,
        "warning": c.warning,
        "using_defaults": c.using_defaults,
        "print_time_assumed": c.print_time_assumed,
        "model_breakdown": list(c.model_breakdown),
    }


async def compute_capacity_unconstrained(
    db: AsyncSession,
    *,
    on_date: date | None = None,
    staffed_minutes: float | None = None,
) -> dict:
    """Dedicated-fleet capacity: each part assumes the full eligible printer count.

    This can overstate complete-device throughput when models are shared across
    recipe parts (e.g. A1M for TOP+KNB). Prefer ``compute_capacity`` for the
    headline KPI (contention-aware via the weekly packer).
    """
    ref = on_date or await shop_today(db)
    globals_ = await get_stats2_globals(db)
    clear_minutes = globals_.expected_plate_clear_minutes

    if staffed_minutes is None:
        avg_mins, using_stub = await average_weekday_staffed_minutes(db, ref=ref)
        staffed_minutes = avg_mins
        # Averaged 'typical staffed day' → simulate against a representative
        # staffed weekday's windows.
        windows = await _representative_weekday_windows(db, ref)
    else:
        _, using_stub = await resolve_staffed_minutes(db, ref)
        # Explicit day (e.g. capacity history) → simulate against that day.
        windows = await _windows_for_day(db, ref)

    staffed_seconds = float(staffed_minutes) * 60.0
    recipe = await get_recipe_view(db)
    fleet = await count_active_printers_by_model(db)

    slot_ids: list[int] = []
    for line in recipe["lines"]:
        for slot in line.get("discovered_slots") or []:
            if slot.get("slot_id") is not None:
                slot_ids.append(int(slot["slot_id"]))

    metrics_map = await get_slot_metrics_map(db, slot_ids)

    components: list[ComponentCapacity] = []
    for line in recipe["lines"]:
        components.append(
            aggregate_component_across_models(
                line=line,
                staffed_seconds=staffed_seconds,
                clear_minutes=clear_minutes,
                fleet=fleet,
                metrics_map=metrics_map,
                windows=windows,
            )
        )

    complete = [c for c in components if not c.incomplete]
    any_incomplete = any(c.incomplete for c in components)
    if complete and not any_incomplete:
        binding = min(complete, key=lambda c: c.devices_from_component)
        devices_realistic = binding.devices_from_component
        devices_theoretical = min(c.devices_theoretical for c in complete)
        binding_part = binding.part_code
    else:
        devices_realistic = 0.0
        devices_theoretical = 0.0
        binding_part = None

    return {
        "as_of": datetime.now(timezone.utc).isoformat(),
        "staffed_minutes": staffed_minutes,
        "staffed_seconds": staffed_seconds,
        "expected_plate_clear_minutes": clear_minutes,
        "using_default_schedule_stub": using_stub,
        "devices_per_day_theoretical": devices_theoretical,
        "devices_per_day_realistic": devices_realistic,
        "binding_part": binding_part,
        "fleet_by_model": fleet,
        "components": [_component_to_dict(c) for c in components],
    }


async def compute_capacity(
    db: AsyncSession,
    *,
    on_date: date | None = None,
    staffed_minutes: float | None = None,
) -> dict:
    """Complete-device capacity for a representative staffed day.

    Headline ``devices_per_day_*`` values are **schedulable** (shared-fleet packer).
    Per-part ``components`` remain dedicated-fleet diagnostics. Unconstrained
    dedicated-fleet totals are also returned for comparison.
    """
    unconstrained = await compute_capacity_unconstrained(db, on_date=on_date, staffed_minutes=staffed_minutes)
    u_r = float(unconstrained.get("devices_per_day_realistic") or 0.0)
    u_t = float(unconstrained.get("devices_per_day_theoretical") or 0.0)
    result = {
        **unconstrained,
        "devices_per_day_realistic_unconstrained": u_r,
        "devices_per_day_theoretical_unconstrained": u_t,
    }
    if u_r <= 0 and u_t <= 0:
        return result

    from backend.app.services.stats2_print_plan import measure_schedulable_devices

    ref = on_date or await shop_today(db)
    week_start = ref - timedelta(days=ref.weekday())
    measured = await measure_schedulable_devices(db, week_start=week_start, capacity=unconstrained)
    result["devices_per_day_realistic"] = float(measured.get("devices_per_day_realistic") or 0.0)
    result["devices_per_day_theoretical"] = float(measured.get("devices_per_day_theoretical") or 0.0)
    if measured.get("binding_part"):
        result["binding_part"] = measured["binding_part"]
    if measured.get("yield_drag") is not None:
        result["yield_drag"] = measured["yield_drag"]
    return result


async def compute_build_plan(db: AsyncSession, *, on_date: date | None = None) -> dict:
    capacity = await compute_capacity(db, on_date=on_date)
    binding = capacity.get("binding_part")
    rows = []
    for c in capacity["components"]:
        breakdown = c.get("model_breakdown") or []
        plates_day = sum(
            float(b.get("active_printers") or 0) * float(b.get("plates_per_printer_per_day") or 0) for b in breakdown
        )
        if not breakdown:
            plates_day = c["active_printers"] * c["plates_per_printer_per_day"]
        models = [str(b.get("printer_model")) for b in breakdown if b.get("printer_model")]
        files = [str(b.get("filename")) for b in breakdown if b.get("filename")]
        rows.append(
            {
                "part_code": c["part_code"],
                "part_name": c["part_name"],
                "qty_per_device": c["qty_per_device"],
                "recommended_slot_id": c["slot_id"],
                "recommended_filename": " · ".join(files) if files else c["filename"],
                "quantity_per_plate": c["quantity_per_plate"],
                "printer_model": "+".join(models) if models else c["printer_model"],
                "active_printers": c["active_printers"],
                "plates_per_day": plates_day,
                "parts_per_day": c["parts_per_day"],
                "devices_per_day": c["devices_from_component"],
                "is_binding": c["part_code"] == binding,
                "incomplete": c["incomplete"],
                "warning": c["warning"],
                "model_breakdown": breakdown,
            }
        )
    return {
        "devices_per_day_realistic": capacity["devices_per_day_realistic"],
        "devices_per_day_theoretical": capacity["devices_per_day_theoretical"],
        "binding_part": binding,
        "rows": rows,
    }


async def compute_variant_compare(
    db: AsyncSession,
    part_code: str,
    *,
    on_date: date | None = None,
) -> dict:
    code = part_code.strip().upper()
    recipe = await get_recipe_view(db)
    line = next((ln for ln in recipe["lines"] if ln["part_code"] == code), None)
    if line is None:
        return {"part_code": code, "variants": [], "warning": f"No recipe line for {code}"}

    globals_ = await get_stats2_globals(db)
    ref = on_date or await shop_today(db)
    avg_mins, _ = await average_weekday_staffed_minutes(db, ref=ref)
    staffed_seconds = avg_mins * 60.0
    windows = await _representative_weekday_windows(db, ref)
    fleet = await count_active_printers_by_model(db)
    slots = line.get("discovered_slots") or []
    metrics_map = await get_slot_metrics_map(db, [int(s["slot_id"]) for s in slots])

    variants = []
    for slot in slots:
        fake_line = {**line, "recommended_slot_id": slot["slot_id"]}
        metrics = metrics_map.get(int(slot["slot_id"]))
        comp = compute_component(
            line=fake_line,
            slot=slot,
            staffed_seconds=staffed_seconds,
            clear_minutes=globals_.expected_plate_clear_minutes,
            fleet=fleet,
            metrics=metrics,
            windows=windows,
        )
        variants.append(
            {
                **_component_to_dict(comp),
                "recommended": bool(slot.get("recommended")),
                "is_preferred": line.get("preferred_slot_id") == slot.get("slot_id"),
            }
        )
    variants.sort(key=lambda v: (-v["devices_from_component"], -v["quantity_per_plate"]))
    return {
        "part_code": code,
        "qty_per_device": line["qty_per_device"],
        "recommended_slot_id": line.get("recommended_slot_id"),
        "variants": variants,
    }


async def compute_overview(db: AsyncSession, *, on_date: date | None = None) -> dict:
    capacity = await compute_capacity(db, on_date=on_date)
    readiness = await compute_readiness(db, on_date=on_date)
    return {
        "capacity": {
            "devices_per_day_theoretical": capacity["devices_per_day_theoretical"],
            "devices_per_day_realistic": capacity["devices_per_day_realistic"],
            "devices_per_day_theoretical_unconstrained": capacity.get(
                "devices_per_day_theoretical_unconstrained", capacity["devices_per_day_theoretical"]
            ),
            "devices_per_day_realistic_unconstrained": capacity.get(
                "devices_per_day_realistic_unconstrained", capacity["devices_per_day_realistic"]
            ),
            "binding_part": capacity["binding_part"],
            "fleet_by_model": capacity["fleet_by_model"],
            "staffed_minutes": capacity["staffed_minutes"],
            "expected_plate_clear_minutes": capacity["expected_plate_clear_minutes"],
            "using_default_schedule_stub": capacity["using_default_schedule_stub"],
            "yield_drag": capacity.get("yield_drag"),
        },
        "readiness": {
            "devices_buildable_now": readiness["devices_buildable_now"],
            "binding_part": readiness["binding_part"],
            "line_start_at": readiness["line_start_at"],
            "ready_deadline_at": readiness["ready_deadline_at"],
        },
        "components": capacity["components"],
    }


async def devices_shipped_by_day(
    db: AsyncSession,
    *,
    start: date,
    end: date,
) -> dict[str, int]:
    """Complete devices shipped per calendar day (floor outcomes).

    Uses the larger of:
    - TOP housing ``shipped`` events (unit link or inventory override)
    - ``FloorProductUnit.linked_at`` (assembled serials)

    BOT is not counted separately — each complete unit writes shipped on both
    housings, and TOP is qty_per_device 1. ``max`` avoids double-counting the
    same device when both signals fire.
    """
    start_dt = datetime.combine(start, datetime.min.time())
    end_exclusive = datetime.combine(end + timedelta(days=1), datetime.min.time())

    top_rows = (
        await db.execute(
            select(FloorPartEvent.occurred_at)
            .join(FloorLabeledPart, FloorLabeledPart.id == FloorPartEvent.part_id)
            .where(FloorPartEvent.action == "shipped")
            .where(FloorLabeledPart.part_code == "TOP")
            .where(FloorLabeledPart.archived_at.is_(None))
            .where(FloorPartEvent.occurred_at >= start_dt)
            .where(FloorPartEvent.occurred_at < end_exclusive)
        )
    ).all()
    unit_rows = (
        await db.execute(
            select(FloorProductUnit.linked_at)
            .where(FloorProductUnit.linked_at >= start_dt)
            .where(FloorProductUnit.linked_at < end_exclusive)
        )
    ).all()

    top_counts: dict[str, int] = defaultdict(int)
    for (when,) in top_rows:
        if when is not None:
            top_counts[when.date().isoformat()] += 1
    unit_counts: dict[str, int] = defaultdict(int)
    for (when,) in unit_rows:
        if when is not None:
            unit_counts[when.date().isoformat()] += 1

    keys = set(top_counts) | set(unit_counts)
    return {k: max(top_counts.get(k, 0), unit_counts.get(k, 0)) for k in keys}


async def compute_capacity_history(
    db: AsyncSession,
    *,
    days: int = 14,
    end_date: date | None = None,
) -> dict:
    """Time series of estimated capacity plus actual devices shipped."""
    end = end_date or await shop_today(db)
    n = max(1, min(90, int(days)))
    start = end - timedelta(days=n - 1)
    shipped = await devices_shipped_by_day(db, start=start, end=end)
    points = []
    for i in range(n - 1, -1, -1):
        d = end - timedelta(days=i)
        mins, _ = await resolve_staffed_minutes(db, d)
        # Per-day staffed minutes only — do not overwrite with week-wide
        # measure_schedulable_devices (which would flatten weekends).
        cap = await compute_capacity_unconstrained(db, on_date=d, staffed_minutes=float(mins))
        points.append(
            {
                "date": d.isoformat(),
                "staffed_minutes": mins,
                "devices_per_day_theoretical": cap["devices_per_day_theoretical"],
                "devices_per_day_realistic": cap["devices_per_day_realistic"],
                "devices_shipped": shipped.get(d.isoformat(), 0),
                "binding_part": cap["binding_part"],
            }
        )
    return {"days": n, "points": points}
