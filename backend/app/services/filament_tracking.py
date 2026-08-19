"""Color + material filament tracking: stock buckets, usage, and purchase plan."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.filament_tracking import (
    FilamentColorBucket,
    FilamentColorUsage,
    FilamentSlotAssignment,
)
from backend.app.models.printer import Printer

CalibrationStage = Literal["collecting", "day", "week", "month"]

MONTH_DAYS = 30
DEFAULT_LEAD_TIME_DAYS = 7
PRINT_USAGE_KINDS = frozenset({"completed", "failed", "cancelled", "aborted"})


@dataclass(frozen=True)
class SlotUsage:
    color_hex: str | None
    color_name: str
    material: str
    grams: float


@dataclass(frozen=True)
class PlanBucket:
    id: int
    color_name: str
    material: str
    color_hex: str | None
    on_hand_grams: float
    spool_weight_grams: float
    stock_initialized: bool
    tracking_started_at: datetime | None
    cost_per_kg: float | None = None
    lead_time_days: int = DEFAULT_LEAD_TIME_DAYS
    brand: str | None = None
    subtype: str | None = None
    extra_colors: str | None = None
    effect_type: str | None = None


@dataclass(frozen=True)
class PlanEvent:
    bucket_id: int
    grams: float
    occurred_at: datetime
    kind: str


@dataclass(frozen=True)
class MaterialPlan:
    bucket_id: int
    color_name: str
    material: str
    color_hex: str | None
    on_hand_grams: float
    stock_initialized: bool
    spool_weight_grams: float
    spool_equivalent: float
    observed_usage_grams: float
    daily_rate_grams: float
    monthly_estimate_grams: float
    projected_remaining_grams: float
    recommended_spools: int
    days_of_cover: float | None
    days_until_order: int | None
    stage: CalibrationStage
    cost_per_kg: float | None = None
    on_hand_value: float | None = None
    monthly_cost_estimate: float | None = None
    lead_time_days: int = DEFAULT_LEAD_TIME_DAYS
    reorder_grams: float | None = None
    brand: str | None = None
    subtype: str | None = None
    extra_colors: str | None = None
    effect_type: str | None = None


@dataclass(frozen=True)
class PurchasePlan:
    stage: CalibrationStage
    days_observed: int
    window_label: str
    materials: list[MaterialPlan]
    total_on_hand_grams: float
    total_observed_usage_grams: float
    total_monthly_estimate_grams: float
    total_recommended_spools: int
    tracking_started_at: datetime | None
    total_on_hand_value: float | None = None
    total_monthly_cost_estimate: float | None = None
    soonest_days_until_order: int | None = None


@dataclass(frozen=True)
class PrinterConsumption:
    printer_id: int
    name: str
    grams: float


def normalize_material(value: str | None) -> str:
    cleaned = (value or "").strip().upper()
    return cleaned or "UNKNOWN"


def normalize_color_name(value: str | None) -> str:
    cleaned = " ".join((value or "").strip().split())
    return cleaned or "Unknown"


def normalize_identity_part(value: str | None) -> str:
    """Collapse whitespace; empty brand/subtype/effect become '' not None."""
    return " ".join((value or "").strip().split())


def normalize_extra_colors(value: str | None) -> str:
    """Canonical extra-color stops: lowercase hex, comma-separated, no #."""
    if not value:
        return ""
    tokens: list[str] = []
    for raw in value.replace("#", " ").replace(",", " ").split():
        tok = raw.strip().lower()
        if tok:
            tokens.append(tok)
    return ",".join(tokens)


def normalize_effect_type(value: str | None) -> str:
    return (value or "").strip().lower()


def identity_or_none(value: str | None) -> str | None:
    """API-facing empty identity: None when blank so labels skip the field."""
    cleaned = normalize_identity_part(value)
    return cleaned or None


def normalize_hex(value: str | None) -> str | None:
    if not value:
        return None
    hex_part = value.lstrip("#").strip()
    if len(hex_part) < 6:
        return None
    return hex_part[:6].upper()


def partial_progress_scale(status: str, progress: float | int | None) -> float:
    """Completed prints count in full; failed/cancelled/aborted scale by progress%."""
    if status == "completed":
        return 1.0
    return max(0.0, min((progress or 0) / 100.0, 1.0))


_NAME_FAMILIES = (
    ("transparent", "Clear"),
    ("clear", "Clear"),
    ("ivory", "White"),
    ("jade white", "White"),
    ("white", "White"),
    ("black", "Black"),
    ("dark gray", "Dark Gray"),
    ("dark grey", "Dark Gray"),
    ("light gray", "Light Gray"),
    ("light grey", "Light Gray"),
    ("gray", "Gray"),
    ("grey", "Gray"),
    ("brown", "Brown"),
    ("orange", "Orange"),
    ("yellow", "Yellow"),
    ("green", "Green"),
    ("cyan", "Cyan"),
    ("blue", "Blue"),
    ("purple", "Purple"),
    ("pink", "Pink"),
    ("red", "Red"),
)


def hex_to_basic_color_name(hex_color: str | None) -> str:
    """HSL family name matching frontend hexToColorName."""
    hex_part = normalize_hex(hex_color)
    if not hex_part:
        return "Unknown"
    raw = hex_color.lstrip("#").strip() if hex_color else ""
    if len(raw) >= 8 and raw[6:8].lower() == "00":
        return "Clear"

    r = int(hex_part[0:2], 16) / 255
    g = int(hex_part[2:4], 16) / 255
    b = int(hex_part[4:6], 16) / 255
    maximum = max(r, g, b)
    minimum = min(r, g, b)
    lightness = (maximum + minimum) / 2
    saturation = 0.0
    hue = 0.0
    if maximum != minimum:
        delta = maximum - minimum
        saturation = delta / (2 - maximum - minimum) if lightness > 0.5 else delta / (maximum + minimum)
        if maximum == r:
            hue = ((g - b) / delta + (6 if g < b else 0)) / 6
        elif maximum == g:
            hue = ((b - r) / delta + 2) / 6
        else:
            hue = ((r - g) / delta + 4) / 6
    hue *= 360

    if lightness < 0.15:
        return "Black"
    if lightness > 0.85:
        return "White"
    if saturation < 0.15:
        if lightness < 0.4:
            return "Dark Gray"
        if lightness > 0.6:
            return "Light Gray"
        return "Gray"
    if 15 <= hue < 45 and lightness < 0.45:
        return "Brown"
    if 45 <= hue < 70 and lightness < 0.40:
        return "Brown"
    if hue < 15 or hue >= 345:
        return "Red"
    if hue < 45:
        return "Orange"
    if hue < 70:
        return "Yellow"
    if hue < 150:
        return "Green"
    if hue < 200:
        return "Cyan"
    if hue < 260:
        return "Blue"
    if hue < 290:
        return "Purple"
    return "Pink"


def family_color_name(hex_color: str | None = None, fallback: str | None = None) -> str:
    """Legacy HSL family helper. Tracking products use the typed name instead."""
    if normalize_hex(hex_color):
        return hex_to_basic_color_name(hex_color)
    text = (fallback or "").strip().lower()
    for needle, family in _NAME_FAMILIES:
        if needle in text:
            return family
    return normalize_color_name(fallback)


def global_tray_to_slot(global_tray_id: int) -> tuple[int, int]:
    """Map a Bambu global tray id to (ams_id, tray_id)."""
    if global_tray_id < 0:
        return 255, 0
    if global_tray_id >= 254:
        return 255, max(0, global_tray_id - 254)
    if global_tray_id >= 128:
        return global_tray_id, 0
    return global_tray_id // 4, global_tray_id % 4


def mapping_tray_id(slot_id: int, ams_mapping: list[int] | None) -> int | None:
    """Return the mapped global tray id for a 1-based 3MF slot, if present."""
    if not ams_mapping or slot_id < 1 or slot_id > len(ams_mapping):
        return None
    mapped = ams_mapping[slot_id - 1]
    try:
        return int(mapped)
    except (TypeError, ValueError):
        return None


def calibration_stage(days_elapsed: float) -> CalibrationStage:
    if days_elapsed < 1:
        return "collecting"
    if days_elapsed < 7:
        return "day"
    if days_elapsed < MONTH_DAYS:
        return "week"
    return "month"


def window_label_for(stage: CalibrationStage, days_observed: int) -> str:
    if stage == "collecting":
        return "Collecting first-day usage"
    if stage == "day":
        suffix = "" if days_observed == 1 else "s"
        return f"Day average · {days_observed} day{suffix} observed"
    if stage == "week":
        return "Week average · extrapolating to 30 days"
    return "Month average · last 30 days of usage"


def clamp_lead_time_days(value: int | float | None) -> int:
    if value is None:
        return DEFAULT_LEAD_TIME_DAYS
    return max(1, min(365, int(value)))


def days_until_order_for(
    days_of_cover: float | None,
    lead_time_days: int,
) -> int | None:
    """Days left before stock would only last the product's shipping time."""
    if days_of_cover is None:
        return None
    remaining = days_of_cover - max(1, lead_time_days)
    if remaining <= 0:
        return 0
    return int(remaining + 0.5)


def recommended_spools_for_lead_time(
    *,
    on_hand_grams: float,
    daily_rate_grams: float,
    spool_weight_grams: float,
    lead_time_days: int,
    stock_initialized: bool,
    stage: CalibrationStage,
) -> int:
    """Buy a month of rolls once remaining stock would only last the ship time."""
    if stage == "collecting" or not stock_initialized or daily_rate_grams <= 0:
        return 0
    lead_grams = daily_rate_grams * max(1, lead_time_days)
    if on_hand_grams > lead_grams:
        return 0
    monthly_grams = daily_rate_grams * MONTH_DAYS
    spool_weight = spool_weight_grams or 1000
    return max(1, int((monthly_grams + spool_weight - 1e-9) // spool_weight))


def value_for_grams(grams: float, cost_per_kg: float | None) -> float | None:
    if cost_per_kg is None:
        return None
    return round((grams / 1000.0) * cost_per_kg, 2)


def window_days_for(stage: CalibrationStage, days_observed: int) -> int:
    if stage == "collecting":
        return max(days_observed, 0)
    if stage == "day":
        return max(1, min(days_observed, 6))
    if stage == "week":
        return 7
    return MONTH_DAYS


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def compute_purchase_plan(
    buckets: list[PlanBucket],
    events: list[PlanEvent],
    as_of: datetime | None = None,
) -> PurchasePlan:
    now = _as_utc(as_of or datetime.now(timezone.utc))
    started_candidates = [b.tracking_started_at for b in buckets if b.tracking_started_at]
    event_times = [e.occurred_at for e in events if e.kind in PRINT_USAGE_KINDS]
    started_at = None
    if started_candidates or event_times:
        started_at = min(_as_utc(t) for t in (*started_candidates, *event_times))

    elapsed_days = 0.0
    if started_at:
        elapsed_days = max(0.0, (now - started_at).total_seconds() / 86400)
    days_observed = int(elapsed_days)
    global_stage = calibration_stage(elapsed_days)

    events_by_bucket: dict[int, list[PlanEvent]] = {}
    for event in events:
        events_by_bucket.setdefault(event.bucket_id, []).append(event)

    materials: list[MaterialPlan] = []
    for bucket in buckets:
        bucket_events = events_by_bucket.get(bucket.id, [])
        print_events = [e for e in bucket_events if e.kind in PRINT_USAGE_KINDS]
        bucket_start = bucket.tracking_started_at or (min((e.occurred_at for e in print_events), default=None))
        bucket_elapsed = 0.0
        if bucket_start:
            bucket_elapsed = max(0.0, (now - _as_utc(bucket_start)).total_seconds() / 86400)
        stage = calibration_stage(bucket_elapsed)
        window_days = window_days_for(stage, int(bucket_elapsed))
        if stage in ("day", "collecting") and bucket_start:
            window_start = _as_utc(bucket_start)
        else:
            window_start = now - timedelta(days=window_days)

        window_events = [e for e in print_events if window_start <= _as_utc(e.occurred_at) <= now]
        observed = sum(e.grams for e in window_events)
        if stage == "collecting":
            divisor = 0.0
        elif stage == "day":
            divisor = max(bucket_elapsed, 1.0)
        elif stage == "week":
            divisor = 7.0
        else:
            divisor = float(MONTH_DAYS)
        daily_rate = observed / divisor if divisor > 0 else 0.0
        monthly = 0.0 if stage == "collecting" else daily_rate * MONTH_DAYS
        spool_weight = bucket.spool_weight_grams or 1000
        lead_days = clamp_lead_time_days(bucket.lead_time_days)
        lead_grams = daily_rate * lead_days if daily_rate > 0 and stage != "collecting" else None
        recommended = recommended_spools_for_lead_time(
            on_hand_grams=bucket.on_hand_grams,
            daily_rate_grams=daily_rate,
            spool_weight_grams=spool_weight,
            lead_time_days=lead_days,
            stock_initialized=bucket.stock_initialized,
            stage=stage,
        )
        days_of_cover = None
        if bucket.stock_initialized and daily_rate > 0:
            days_of_cover = bucket.on_hand_grams / daily_rate
        days_until_order = days_until_order_for(days_of_cover, lead_days)

        materials.append(
            MaterialPlan(
                bucket_id=bucket.id,
                color_name=bucket.color_name,
                material=bucket.material,
                color_hex=bucket.color_hex,
                on_hand_grams=bucket.on_hand_grams,
                stock_initialized=bucket.stock_initialized,
                spool_weight_grams=spool_weight,
                spool_equivalent=bucket.on_hand_grams / spool_weight if spool_weight else 0,
                observed_usage_grams=observed,
                daily_rate_grams=daily_rate,
                monthly_estimate_grams=monthly,
                projected_remaining_grams=bucket.on_hand_grams - monthly,
                recommended_spools=recommended,
                days_of_cover=days_of_cover,
                days_until_order=days_until_order,
                stage=stage,
                cost_per_kg=bucket.cost_per_kg,
                on_hand_value=value_for_grams(bucket.on_hand_grams, bucket.cost_per_kg),
                monthly_cost_estimate=value_for_grams(monthly, bucket.cost_per_kg) if stage != "collecting" else None,
                lead_time_days=lead_days,
                reorder_grams=lead_grams,
                brand=identity_or_none(bucket.brand),
                subtype=identity_or_none(bucket.subtype),
                extra_colors=normalize_extra_colors(bucket.extra_colors) or None,
                effect_type=normalize_effect_type(bucket.effect_type) or None,
            )
        )

    materials.sort(key=lambda m: (m.material, m.color_name))
    valued = [m.on_hand_value for m in materials if m.on_hand_value is not None]
    monthly_costs = [m.monthly_cost_estimate for m in materials if m.monthly_cost_estimate is not None]
    countdowns = [m.days_until_order for m in materials if m.days_until_order is not None]
    return PurchasePlan(
        stage=global_stage,
        days_observed=days_observed,
        window_label=window_label_for(global_stage, max(days_observed, 0)),
        materials=materials,
        total_on_hand_grams=sum(m.on_hand_grams for m in materials),
        total_observed_usage_grams=sum(m.observed_usage_grams for m in materials),
        total_monthly_estimate_grams=sum(m.monthly_estimate_grams for m in materials),
        total_on_hand_value=round(sum(valued), 2) if valued else None,
        total_monthly_cost_estimate=round(sum(monthly_costs), 2) if monthly_costs else None,
        total_recommended_spools=sum(m.recommended_spools for m in materials),
        soonest_days_until_order=min(countdowns) if countdowns else None,
        tracking_started_at=started_at,
    )


def scale_slots(slots: list[SlotUsage], status: str, progress: float | int | None) -> list[SlotUsage]:
    scale = partial_progress_scale(status, progress)
    if scale <= 0:
        return []
    if scale == 1.0:
        return [s for s in slots if s.grams > 0]
    return [
        SlotUsage(
            color_hex=slot.color_hex,
            color_name=slot.color_name,
            material=slot.material,
            grams=round(slot.grams * scale, 1),
        )
        for slot in slots
        if slot.grams * scale > 0
    ]


def _identity_filter(
    *,
    color_name: str,
    material: str,
    brand: str,
    subtype: str,
    extra_colors: str,
    effect_type: str,
):
    """Match a SKU. Empty brand/subtype/effect/extra_colors store as ''."""
    return (
        FilamentColorBucket.color_name == color_name,
        FilamentColorBucket.material == material,
        func.coalesce(FilamentColorBucket.brand, "") == brand,
        func.coalesce(FilamentColorBucket.subtype, "") == subtype,
        func.coalesce(FilamentColorBucket.extra_colors, "") == extra_colors,
        func.coalesce(FilamentColorBucket.effect_type, "") == effect_type,
    )


async def get_or_create_bucket(
    db: AsyncSession,
    *,
    color_name: str,
    material: str,
    color_hex: str | None,
    occurred_at: datetime | None = None,
    brand: str | None = None,
    subtype: str | None = None,
    extra_colors: str | None = None,
    effect_type: str | None = None,
) -> FilamentColorBucket:
    color = normalize_color_name(color_name)
    mat = normalize_material(material)
    brand_key = normalize_identity_part(brand)
    subtype_key = normalize_identity_part(subtype)
    extras_key = normalize_extra_colors(extra_colors)
    effect_key = normalize_effect_type(effect_type)
    identity = _identity_filter(
        color_name=color,
        material=mat,
        brand=brand_key,
        subtype=subtype_key,
        extra_colors=extras_key,
        effect_type=effect_key,
    )
    result = await db.execute(select(FilamentColorBucket).where(*identity))
    bucket = result.scalar_one_or_none()
    if bucket:
        if color_hex and not bucket.color_hex:
            bucket.color_hex = normalize_hex(color_hex)
        return bucket

    now = occurred_at or datetime.now(timezone.utc)
    bucket = FilamentColorBucket(
        color_name=color,
        material=mat,
        brand=brand_key,
        subtype=subtype_key,
        extra_colors=extras_key,
        effect_type=effect_key,
        color_hex=normalize_hex(color_hex),
        on_hand_grams=0,
        spool_weight_grams=1000,
        stock_initialized=False,
        tracking_started_at=now,
    )
    try:
        async with db.begin_nested():
            db.add(bucket)
            await db.flush()
    except IntegrityError:
        result = await db.execute(select(FilamentColorBucket).where(*identity))
        existing = result.scalar_one_or_none()
        if existing:
            return existing
        raise
    return bucket


async def record_slot_usage(
    db: AsyncSession,
    *,
    slots: list[SlotUsage],
    status: str,
    progress: float | int | None,
    occurred_at: datetime,
    archive_id: int | None,
    printer_id: int | None,
    print_name: str | None,
    source_prefix: str,
) -> list[FilamentColorUsage]:
    scaled = scale_slots(slots, status, progress)
    created: list[FilamentColorUsage] = []
    kind = status if status in PRINT_USAGE_KINDS else "completed"
    for slot in scaled:
        bucket = await get_or_create_bucket(
            db,
            color_name=slot.color_name,
            material=slot.material,
            color_hex=slot.color_hex,
            occurred_at=occurred_at,
        )
        source_key = f"{source_prefix}:{bucket.color_name}:{bucket.material}"
        existing = await db.execute(select(FilamentColorUsage).where(FilamentColorUsage.source_key == source_key))
        if existing.scalar_one_or_none():
            continue
        event = FilamentColorUsage(
            bucket_id=bucket.id,
            grams=slot.grams,
            occurred_at=occurred_at,
            kind=kind,
            progress=None if kind == "completed" else partial_progress_scale(status, progress) * 100,
            archive_id=archive_id,
            printer_id=printer_id,
            print_name=print_name,
            source_key=source_key,
        )
        db.add(event)
        if bucket.stock_initialized:
            bucket.on_hand_grams = max(0.0, (bucket.on_hand_grams or 0) - slot.grams)
        if bucket.tracking_started_at is None:
            bucket.tracking_started_at = occurred_at
        created.append(event)
    if created:
        await db.flush()
    return created


async def assigned_bucket_for_slot(
    db: AsyncSession,
    *,
    printer_id: int,
    ams_id: int,
    tray_id: int,
) -> FilamentColorBucket | None:
    result = await db.execute(
        select(FilamentSlotAssignment).where(
            FilamentSlotAssignment.printer_id == printer_id,
            FilamentSlotAssignment.ams_id == ams_id,
            FilamentSlotAssignment.tray_id == tray_id,
        )
    )
    assignment = result.scalar_one_or_none()
    if not assignment:
        return None
    return await db.get(FilamentColorBucket, assignment.bucket_id)


async def record_assigned_usage(
    db: AsyncSession,
    *,
    bucket: FilamentColorBucket,
    grams: float,
    status: str,
    progress: float | int | None,
    occurred_at: datetime,
    archive_id: int | None,
    printer_id: int | None,
    print_name: str | None,
    source_key: str,
) -> FilamentColorUsage | None:
    existing = await db.execute(select(FilamentColorUsage).where(FilamentColorUsage.source_key == source_key))
    if existing.scalar_one_or_none():
        return None
    kind = status if status in PRINT_USAGE_KINDS else "completed"
    event = FilamentColorUsage(
        bucket_id=bucket.id,
        grams=grams,
        occurred_at=occurred_at,
        kind=kind,
        progress=None if kind == "completed" else partial_progress_scale(status, progress) * 100,
        archive_id=archive_id,
        printer_id=printer_id,
        print_name=print_name,
        source_key=source_key,
    )
    db.add(event)
    if bucket.stock_initialized:
        bucket.on_hand_grams = max(0.0, (bucket.on_hand_grams or 0) - grams)
    if bucket.tracking_started_at is None:
        bucket.tracking_started_at = occurred_at
    return event


async def record_print_usage(
    db: AsyncSession,
    *,
    slots: list[dict],
    status: str,
    progress: float | int | None,
    archive_id: int | None,
    printer_id: int | None,
    print_name: str | None,
    occurred_at: datetime | None = None,
    ams_mapping: list[int] | None = None,
) -> list[FilamentColorUsage]:
    """Subtract print grams from products assigned to the printer slots used.

    3MF hex/type is not enough: EasyRock White and generic white can share a
    hex. Deduction follows the slot assignment on the printers tab.
    Unassigned slots are skipped so we do not invent a family White bucket.
    """
    when = occurred_at or datetime.now(timezone.utc)
    if printer_id is None or not ams_mapping:
        return []
    scale = partial_progress_scale(status, progress)
    if scale <= 0:
        return []
    created: list[FilamentColorUsage] = []
    prefix = f"archive:{archive_id or 'none'}:{status}:{when.isoformat(timespec='seconds')}"
    for index, slot in enumerate(slots):
        grams = float(slot.get("used_g") or slot.get("used_grams") or 0) * scale
        if grams <= 0:
            continue
        try:
            slot_id = int(slot.get("slot_id") or (index + 1))
        except (TypeError, ValueError):
            slot_id = index + 1
        mapped = mapping_tray_id(slot_id, ams_mapping)
        if mapped is None:
            continue
        ams_id, tray_id = global_tray_to_slot(mapped)
        bucket = await assigned_bucket_for_slot(db, printer_id=printer_id, ams_id=ams_id, tray_id=tray_id)
        if not bucket:
            continue
        event = await record_assigned_usage(
            db,
            bucket=bucket,
            grams=round(grams, 1),
            status=status,
            progress=progress,
            occurred_at=when,
            archive_id=archive_id,
            printer_id=printer_id,
            print_name=print_name,
            source_key=f"{prefix}:{bucket.id}:{ams_id}:{tray_id}",
        )
        if event:
            created.append(event)
    if created:
        await db.flush()
    return created


async def load_plan(db: AsyncSession) -> PurchasePlan:
    buckets = list((await db.execute(select(FilamentColorBucket))).scalars().all())
    events = list((await db.execute(select(FilamentColorUsage))).scalars().all())
    return compute_purchase_plan(
        [
            PlanBucket(
                id=b.id,
                color_name=b.color_name,
                material=b.material,
                color_hex=b.color_hex,
                on_hand_grams=b.on_hand_grams or 0,
                spool_weight_grams=b.spool_weight_grams or 1000,
                stock_initialized=bool(b.stock_initialized),
                tracking_started_at=b.tracking_started_at,
                cost_per_kg=b.cost_per_kg,
                lead_time_days=clamp_lead_time_days(b.lead_time_days),
                brand=b.brand,
                subtype=b.subtype,
                extra_colors=b.extra_colors,
                effect_type=b.effect_type,
            )
            for b in buckets
        ],
        [
            PlanEvent(
                bucket_id=e.bucket_id,
                grams=e.grams,
                occurred_at=e.occurred_at,
                kind=e.kind,
            )
            for e in events
        ],
    )


async def load_printer_consumption(db: AsyncSession) -> list[PrinterConsumption]:
    usage_rows = (
        await db.execute(
            select(
                FilamentColorUsage.printer_id,
                func.coalesce(func.sum(FilamentColorUsage.grams), 0).label("grams"),
            )
            .where(
                FilamentColorUsage.kind.in_(PRINT_USAGE_KINDS),
                FilamentColorUsage.printer_id.is_not(None),
            )
            .group_by(FilamentColorUsage.printer_id)
        )
    ).all()
    grams_by_id = {row.printer_id: float(row.grams or 0) for row in usage_rows}
    printers = list((await db.execute(select(Printer).order_by(Printer.name))).scalars().all())
    rows = [
        PrinterConsumption(printer_id=printer.id, name=printer.name, grams=grams_by_id.get(printer.id, 0.0))
        for printer in printers
    ]
    rows.sort(key=lambda row: (-row.grams, row.name.lower()))
    return rows
