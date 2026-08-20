"""Color + material filament tracking: stock buckets, usage, and purchase plan."""

from __future__ import annotations

import asyncio
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.filament_tracking import (
    FilamentColorBucket,
    FilamentColorUsage,
    FilamentSlotAssignment,
)
from backend.app.models.printer import Printer

CalibrationStage = Literal["collecting", "day", "week", "month"]

PRINT_JOB_SUFFIXES = (".gcode.3mf", ".gcode", ".3mf")
_SEPARATORS = re.compile(r"[-_\s]+")
_GENERIC_PLATE_STEM = re.compile(r"^plate-\d+$")

MONTH_DAYS = 30
DEFAULT_LEAD_TIME_DAYS = 7
PRINT_USAGE_KINDS = frozenset({"completed", "failed", "cancelled", "aborted"})
LIVE_USAGE_KIND = "printing"
TRACKABLE_USAGE_KINDS = PRINT_USAGE_KINDS | {LIVE_USAGE_KIND}


def print_job_stem(value: str | None) -> str:
    """Basename stem so ``foo.gcode.3mf``, ``foo.gcode``, and ``foo.3mf`` match.

    Equality is the separator-normalized casefold stem (hyphen / space /
    underscore collapse to ``-``). Never substring / LIKE matching.
    """
    if not isinstance(value, str) or not value.strip():
        return ""
    name = value.replace("\\", "/").split("/")[-1].strip()
    if not name:
        return ""
    lower = name.casefold()
    for suffix in PRINT_JOB_SUFFIXES:
        if lower.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return _SEPARATORS.sub("-", name.strip().casefold()).strip("-")


def is_generic_plate_stem(stem: str) -> bool:
    """True for firmware ``Metadata/plate_N.gcode`` names that are not a job id."""
    return bool(stem and _GENERIC_PLATE_STEM.fullmatch(stem))


def job_identity_stem(value: str | None) -> str:
    """Stem used for same-job / leftover-skip. Generic plate_N names do not identify a job."""
    stem = print_job_stem(value)
    return "" if is_generic_plate_stem(stem) else stem


def print_job_stems(*values: str | None) -> set[str]:
    stems: set[str] = set()
    for value in values:
        stem = print_job_stem(value)
        if stem:
            stems.add(stem)
    return stems


def print_job_separator_spellings(stem: str) -> set[str]:
    """Hyphen, space, and underscore spellings of one normalized job stem."""
    compact = print_job_stem(stem)
    if not compact:
        return set()
    parts = [part for part in compact.split("-") if part]
    spellings = {compact, compact.replace("-", " "), compact.replace("-", "_")}
    if len(parts) >= 2:
        spellings.add(" - ".join(parts))
        rest = " - ".join(parts[2:])
        spellings.add(f"{parts[0]} {parts[1]}" + (f" - {rest}" if rest else ""))
    return {item for item in spellings if item}


def print_job_filename_variants(stem: str) -> list[str]:
    return [stem, f"{stem}.3mf", f"{stem}.gcode", f"{stem}.gcode.3mf"]


def existing_3mf_path(stored: str | None, base_dir) -> Path | None:
    """Resolve a stored library/archive path to an on-disk ``.3mf`` file."""
    if not isinstance(stored, str) or not stored.strip():
        return None
    path = Path(stored)
    candidate = path if path.is_absolute() else base_dir / stored
    try:
        suffix = str(getattr(candidate, "suffix", "") or "").lower()
        if candidate.exists() and suffix == ".3mf" and candidate.stat().st_size > 0:
            return candidate
    except (OSError, TypeError):
        return None
    return None


def slots_from_3mf_file(path, plate_id: int | None = None) -> list[dict]:
    """Per-slot ``used_g`` from a 3MF, or empty if extract fails.

    When ``plate_id`` is unknown and the file has multiple plates, return
    nothing rather than summing every plate / every ``<filament>``.
    """
    from backend.app.utils.threemf_tools import extract_filament_usage_from_3mf, slice_info_plate_indexes

    try:
        plates = slice_info_plate_indexes(path)
    except Exception:
        plates = []
    if plate_id is None and len(plates) > 1:
        return []
    effective = plate_id if plate_id is not None else (plates[0] if len(plates) == 1 else None)
    try:
        slots = extract_filament_usage_from_3mf(path, effective)
    except Exception:
        return []
    return list(slots or [])


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


HOUR_SECONDS = 3600.0
LIVE_RATE_WARMUP_SECONDS = 180.0
LIVE_RATE_MAX_GPH = 1000.0


@dataclass(frozen=True)
class LiveUsageSample:
    """One live (kind=printing) assigned-product deduction row."""

    bucket_id: int
    color_name: str
    material: str
    brand: str | None
    subtype: str | None
    extra_colors: str | None
    effect_type: str | None
    color_hex: str | None
    grams: float
    occurred_at: datetime
    printer_id: int | None = None
    started_at: datetime | None = None
    progress: float | None = None
    remaining_seconds: float | None = None
    print_time_seconds: float | None = None


@dataclass(frozen=True)
class LiveUsageProduct:
    bucket_id: int
    color_name: str
    material: str
    brand: str | None
    subtype: str | None
    extra_colors: str | None
    effect_type: str | None
    color_hex: str | None
    grams_so_far: float
    grams_last_hour: float
    grams_per_hour: float


@dataclass(frozen=True)
class LiveUsageRate:
    grams_per_hour: float
    grams_last_hour: float
    grams_so_far: float
    active_jobs: int
    products: list[LiveUsageProduct]
    warming_up: bool = False


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


_STATUS_ALIASES = {
    "canceled": "cancelled",
    "stopped": "cancelled",
    "abort": "aborted",
}


def canonical_usage_status(status: str | None) -> str:
    return _STATUS_ALIASES.get((status or "").strip().lower(), (status or "").strip().lower())


def partial_progress_scale(status: str, progress: float | int | None) -> float:
    """Completed prints count in full; failed/cancelled/aborted scale by progress%."""
    if canonical_usage_status(status) == "completed":
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


def slot_to_global_tray(ams_id: int, tray_id: int) -> int:
    """Inverse of ``global_tray_to_slot`` for AMS remain% fallback rows."""
    if ams_id >= 254:
        return 254 + max(0, int(tray_id))
    if ams_id >= 128:
        return int(ams_id)
    return int(ams_id) * 4 + int(tray_id)


def mapping_tray_id(slot_id: int, ams_mapping: list[int] | None) -> int | None:
    """Return the mapped global tray id for a 1-based 3MF slot, if present.

    Length-1 mappings are aligned onto a single used slot by
    ``align_mapping_to_used_slots``; this helper only indexes the aligned list.
    Unmapped ``-1`` is skipped so leftover 3MF slots are not dumped onto Ext.
    """
    if not ams_mapping or slot_id < 1 or slot_id > len(ams_mapping):
        return None
    try:
        value = int(ams_mapping[slot_id - 1])
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return value


def align_mapping_to_used_slots(mapping: list[int] | None, slots: list[dict]) -> list[int] | None:
    """Pad a length-1 tray mapping onto exactly one used 3MF slot_id.

    ``tray_now`` / MQTT length-1 is enough when a job used one tray. Copying
    that tray onto every used slot would charge neighbor remain% or extra 3MF
    colors to the active product.
    """
    if not mapping:
        return mapping
    used_ids: list[int] = []
    for index, slot in enumerate(slots):
        if float(slot.get("used_g") or slot.get("used_grams") or 0) <= 0:
            continue
        try:
            used_ids.append(int(slot.get("slot_id") or (index + 1)))
        except (TypeError, ValueError):
            used_ids.append(index + 1)
    if len(mapping) != 1 or len(used_ids) != 1:
        return mapping
    slot_id = used_ids[0]
    if slot_id <= len(mapping):
        return mapping
    padded = [-1] * slot_id
    padded[slot_id - 1] = mapping[0]
    return padded


def is_active_global_tray(tray_id: int | None) -> bool:
    """True when a MQTT tray id can identify an AMS/external slot in use."""
    if tray_id is None:
        return False
    try:
        value = int(tray_id)
    except (TypeError, ValueError):
        return False
    if 0 <= value <= 15:
        return True
    if 24 <= value <= 27:
        return True
    if 128 <= value <= 135:
        return True
    return value in (254, 255)


def decode_mqtt_slot_mapping(mapping_raw: list | None) -> list[int] | None:
    """Decode MQTT ``mapping`` to global tray ids.

    Printer MQTT uses snow encoding (``ams_hw_id * 256 + local_slot``;
    ``65535`` = unmapped). Live state and tests may already pass global
    tray ids (0–15, 254/255). Values ``>= 256`` select the snow decoder so
    AMS 1+ reprints are not collapsed onto AMS 0.
    """
    if not isinstance(mapping_raw, list) or not mapping_raw:
        return None

    parsed: list[int] = []
    for value in mapping_raw:
        try:
            parsed.append(int(value))
        except (TypeError, ValueError):
            parsed.append(65535)

    usable = [value for value in parsed if 0 <= value < 65535]
    if not usable:
        return None

    result: list[int] = []
    if any(value >= 256 for value in usable):
        for value in parsed:
            if value < 0 or value >= 65535:
                result.append(-1)
                continue
            ams_hw_id = value >> 8
            slot = value & 0xFF
            if 0 <= ams_hw_id <= 3:
                result.append(ams_hw_id * 4 + (slot & 0x03))
            elif 128 <= ams_hw_id <= 135:
                result.append(ams_hw_id)
            elif ams_hw_id in (254, 255):
                result.append(254 if slot != 255 else 255)
            else:
                result.append(-1)
    else:
        for value in parsed:
            result.append(value if is_active_global_tray(value) else -1)

    if all(v < 0 for v in result):
        return None
    return result


def resolve_ams_mapping(
    *,
    ams_mapping: list[int] | None = None,
    mqtt_mapping: list | None = None,
    tray_now: int | None = None,
    slot_count: int = 0,
) -> list[int] | None:
    """Resolve 3MF-slot → global tray ids without our stored send mapping.

    Priority: print-command / stored ``ams_mapping``, MQTT ``mapping`` field,
    then the tray currently in use when the print only has one used slot.
    """
    if ams_mapping:
        try:
            return [int(v) for v in ams_mapping]
        except (TypeError, ValueError):
            pass
    decoded = decode_mqtt_slot_mapping(mqtt_mapping)
    if decoded:
        return decoded
    if slot_count <= 1 and is_active_global_tray(tray_now):
        return [int(tray_now)]
    return None


def _exact_name_sql_filters(column, stems: set[str]):
    """SQL equality / basename filters for exact print-job stems (not substring)."""
    lowers = sorted(
        {
            variant.casefold()
            for stem in stems
            for spelling in print_job_separator_spellings(stem)
            for variant in print_job_filename_variants(spelling)
        }
    )
    filters = [func.lower(column).in_(lowers)]
    for variant in lowers:
        filters.append(func.lower(column).like(f"%/{variant}"))
    return filters


def _row_matches_print_stems(stems: set[str], *values: str | None) -> bool:
    return bool(stems and print_job_stems(*values) & stems)


async def find_exact_named_3mf(
    db: AsyncSession,
    *,
    names: Sequence[str | None],
    base_dir,
    printer_id: int | None = None,
    exclude_archive_id: int | None = None,
) -> Path | None:
    """Find a library or previous-archive 3MF whose basename stem equals this job.

    Prefer an on-disk file. If several exact hits exist, use the newest library
    file, then the newest archive that still has a 3MF ``file_path``.
    """
    from backend.app.models.archive import PrintArchive
    from backend.app.models.library import LibraryFile

    stems = print_job_stems(*names)
    if not stems:
        return None

    try:
        lib_result = await db.execute(
            LibraryFile.active()
            .where(
                or_(
                    *_exact_name_sql_filters(LibraryFile.filename, stems),
                    *_exact_name_sql_filters(LibraryFile.file_path, stems),
                )
            )
            .order_by(LibraryFile.created_at.desc())
            .limit(50)
        )
        for lib_file in lib_result.scalars().all():
            if not _row_matches_print_stems(
                stems,
                getattr(lib_file, "filename", None),
                getattr(lib_file, "file_path", None),
            ):
                continue
            candidate = existing_3mf_path(getattr(lib_file, "file_path", None), base_dir)
            if candidate is not None:
                return candidate
    except Exception:
        pass

    try:
        query = (
            select(PrintArchive)
            .where(PrintArchive.file_path != "")
            .where(PrintArchive.file_path.isnot(None))
            .where(
                or_(
                    *_exact_name_sql_filters(PrintArchive.filename, stems),
                    *_exact_name_sql_filters(PrintArchive.print_name, stems),
                    *_exact_name_sql_filters(PrintArchive.file_path, stems),
                )
            )
        )
        if exclude_archive_id is not None:
            query = query.where(PrintArchive.id != exclude_archive_id)
        order_clauses = [PrintArchive.created_at.desc()]
        if printer_id is not None:
            order_clauses.append((PrintArchive.printer_id == printer_id).desc())
        prev_result = await db.execute(query.order_by(*order_clauses).limit(50))
        for prev_archive in prev_result.scalars().all():
            if not _row_matches_print_stems(
                stems,
                getattr(prev_archive, "filename", None),
                getattr(prev_archive, "print_name", None),
                getattr(prev_archive, "file_path", None),
            ):
                continue
            candidate = existing_3mf_path(getattr(prev_archive, "file_path", None), base_dir)
            if candidate is not None:
                return candidate
    except Exception:
        pass

    try:
        query = select(PrintArchive).where(PrintArchive.file_path != "").where(PrintArchive.file_path.isnot(None))
        if exclude_archive_id is not None:
            query = query.where(PrintArchive.id != exclude_archive_id)
        order_clauses = [PrintArchive.created_at.desc()]
        if printer_id is not None:
            order_clauses.append((PrintArchive.printer_id == printer_id).desc())
        prev_result = await db.execute(query.order_by(*order_clauses).limit(50))
        for prev_archive in prev_result.scalars().all():
            if not _row_matches_print_stems(
                stems,
                getattr(prev_archive, "filename", None),
                getattr(prev_archive, "print_name", None),
                getattr(prev_archive, "file_path", None),
            ):
                continue
            candidate = existing_3mf_path(getattr(prev_archive, "file_path", None), base_dir)
            if candidate is not None:
                return candidate
    except Exception:
        pass

    return None


def tracking_run_id(
    *,
    archive_id: int | None,
    printer_id: int | None,
    print_name: str | None,
    started_at: datetime | None,
) -> str:
    """Stable identity for one physical print run (live + complete share this)."""
    when = _as_utc(started_at or datetime.now(timezone.utc)).strftime("%Y%m%d%H%M%S")
    if archive_id:
        return f"a{archive_id}-{when}"
    slug = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in (print_name or "job"))[:40]
    slug = slug.strip("-") or "job"
    return f"p{printer_id or 0}-{slug}-{when}"


def usage_source_key(run_id: str, bucket_id: int, ams_id: int, tray_id: int) -> str:
    return f"track:{run_id}:{bucket_id}:{ams_id}:{tray_id}"


def source_key_run_id(source_key: str | None) -> str | None:
    """Run id embedded in ``track:{run_id}:{bucket}:{ams}:{tray}``."""
    if not isinstance(source_key, str) or not source_key.startswith("track:"):
        return None
    parts = source_key.split(":")
    if len(parts) < 5:
        return None
    run_id = ":".join(parts[1:-3])
    return run_id or None


def source_key_slot(source_key: str | None) -> tuple[int, int] | None:
    """(ams_id, tray_id) from a tracking source_key."""
    if not isinstance(source_key, str) or not source_key.startswith("track:"):
        return None
    parts = source_key.split(":")
    if len(parts) < 5:
        return None
    try:
        return int(parts[-2]), int(parts[-1])
    except (TypeError, ValueError):
        return None


async def live_run_id_for_job(
    db: AsyncSession,
    *,
    printer_id: int,
    print_name: str | None,
) -> str | None:
    """Reuse an open ``kind=printing`` run_id so reload/start jitter does not stack rows."""
    stem = job_identity_stem(print_name)
    result = await db.execute(
        select(FilamentColorUsage).where(
            FilamentColorUsage.printer_id == printer_id,
            FilamentColorUsage.kind == LIVE_USAGE_KIND,
        )
    )
    best: tuple[float, str] | None = None
    for event in result.scalars().all():
        if stem and job_identity_stem(event.print_name) != stem:
            continue
        run_id = source_key_run_id(event.source_key)
        if not run_id:
            continue
        grams = float(event.grams or 0)
        if best is None or grams >= best[0]:
            best = (grams, run_id)
    return best[1] if best else None


async def collapse_duplicate_live_usage(
    db: AsyncSession,
    *,
    printer_id: int,
    print_name: str | None = None,
) -> list[FilamentColorUsage]:
    """Keep one live row per product+slot; credit on_hand for leftover run_id splits."""
    stem = job_identity_stem(print_name)
    result = await db.execute(
        select(FilamentColorUsage).where(
            FilamentColorUsage.printer_id == printer_id,
            FilamentColorUsage.kind == LIVE_USAGE_KIND,
        )
    )
    groups: dict[tuple[int, int, int], list[FilamentColorUsage]] = {}
    for event in result.scalars().all():
        if stem and job_identity_stem(event.print_name) != stem:
            continue
        slot = source_key_slot(event.source_key) or (-1, -1)
        groups.setdefault((event.bucket_id, slot[0], slot[1]), []).append(event)
    kept: list[FilamentColorUsage] = []
    dirty = False
    for events in groups.values():
        events.sort(key=lambda row: (float(row.grams or 0), int(row.id or 0)), reverse=True)
        winner = events[0]
        kept.append(winner)
        for extra in events[1:]:
            bucket = await db.get(FilamentColorBucket, extra.bucket_id)
            if bucket and bucket.stock_initialized:
                bucket.on_hand_grams = (bucket.on_hand_grams or 0) + float(extra.grams or 0)
            await db.delete(extra)
            dirty = True
    if dirty:
        await db.flush()
    return kept


def tracking_slots_from_usage_results(
    usage_results: list[dict] | None,
) -> tuple[list[dict], list[int] | None]:
    """Convert AMS remain%/tracker rows into tracking slots.

    Grams are already actual consumption — callers must not scale again.
    When rows include ``ams_id``/``tray_id``, also return that physical mapping
    so printer reprints can deduct without a Backoffice send mapping.
    """
    slots: list[dict] = []
    mapping: list[int] = []
    have_physical = False
    for index, row in enumerate(usage_results or []):
        grams = float(row.get("weight_used") or row.get("used_g") or 0)
        if grams <= 0:
            continue
        try:
            slot_id = int(row["slot_id"]) if row.get("slot_id") is not None else index + 1
        except (TypeError, ValueError):
            slot_id = index + 1
        slots.append(
            {
                "slot_id": slot_id,
                "used_g": grams,
                "type": row.get("material") or row.get("type") or "UNKNOWN",
                "color": row.get("color"),
            }
        )
        ams_id = row.get("ams_id")
        tray_id = row.get("tray_id")
        if ams_id is None or tray_id is None:
            mapping.append(-1)
            continue
        try:
            mapping.append(slot_to_global_tray(int(ams_id), int(tray_id)))
            have_physical = True
        except (TypeError, ValueError):
            mapping.append(-1)
    return slots, mapping if have_physical else None


def parse_mqtt_tray_remain(
    raw_data: dict | None,
) -> dict[tuple[int, int], tuple[int, str | None, str | None]]:
    """Map (ams_id, tray_id) → (remain_pct, material, color) from printer MQTT."""
    if not isinstance(raw_data, dict):
        return {}
    trays: dict[tuple[int, int], tuple[int, str | None, str | None]] = {}
    ams_raw = raw_data.get("ams", [])
    ams_data = ams_raw.get("ams", []) if isinstance(ams_raw, dict) else ams_raw if isinstance(ams_raw, list) else []
    for ams_unit in ams_data:
        if not isinstance(ams_unit, dict):
            continue
        try:
            ams_id = int(ams_unit.get("id", 0))
        except (TypeError, ValueError):
            continue
        for tray in ams_unit.get("tray") or []:
            if not isinstance(tray, dict):
                continue
            remain = tray.get("remain", -1)
            # Generic / non-RFID trays report -1; never treat that as 0% or 1000 g.
            if not isinstance(remain, int) or remain < 0 or remain > 100:
                continue
            try:
                tray_id = int(tray.get("id", 0))
            except (TypeError, ValueError):
                continue
            trays[(ams_id, tray_id)] = (
                remain,
                tray.get("tray_type") or tray.get("type"),
                tray.get("tray_color") or tray.get("color"),
            )
    vt_tray_raw = raw_data.get("vt_tray") or []
    if isinstance(vt_tray_raw, dict):
        vt_tray_raw = [vt_tray_raw]
    for vt in vt_tray_raw:
        if not isinstance(vt, dict):
            continue
        remain = vt.get("remain", -1)
        # External generic filament also reports remain=-1.
        if not isinstance(remain, int) or remain < 0 or remain > 100:
            continue
        try:
            vt_id = int(vt.get("id", 254))
        except (TypeError, ValueError):
            vt_id = 254
        trays[(255, vt_id - 254)] = (
            remain,
            vt.get("tray_type") or vt.get("type"),
            vt.get("tray_color") or vt.get("color"),
        )
    return trays


def remain_delta_grams(start_remain: int, current_remain: int, spool_weight_grams: float) -> float:
    delta = int(start_remain) - int(current_remain)
    if delta <= 0:
        return 0.0
    return round((delta / 100.0) * (spool_weight_grams or 1000), 1)


def observed_print_trays(
    *,
    mqtt_mapping: list | None = None,
    tray_now: int | None = None,
    previously_seen: set[int] | None = None,
) -> set[int]:
    """Trays MQTT actually showed in use — mapping entries and tray_now history.

    Remain% on other assigned slots is noise (humidity, firmware), not this print.
    """
    seen = set(previously_seen or ())
    decoded = decode_mqtt_slot_mapping(mqtt_mapping)
    if decoded:
        for value in decoded:
            if is_active_global_tray(value):
                seen.add(int(value))
    if is_active_global_tray(tray_now):
        seen.add(int(tray_now))
    return seen


def slots_from_remain_deltas(
    start_remain: dict[tuple[int, int], int],
    spool_grams: dict[tuple[int, int], float],
    current_remain: dict[tuple[int, int], int],
    observed_trays: set[int] | None = None,
) -> tuple[list[dict], list[int] | None]:
    """RFID remain% deltas (0–100 only) into tracking slots + physical mapping.

    The product ledger is plate-scoped 3MF × progress. This path is a fallback
    for Bambu RFID trays. ``remain=-1`` never appears here. When
    ``observed_trays`` is set, only trays MQTT showed in use are counted.
    An empty set means we do not know which tray printed — do not guess.
    """
    slots: list[dict] = []
    mapping: list[int] = []
    for key, start in start_remain.items():
        now = current_remain.get(key)
        if now is None:
            continue
        ams_id, tray_id = key
        global_id = slot_to_global_tray(ams_id, tray_id)
        if observed_trays is not None and global_id not in observed_trays:
            continue
        grams = remain_delta_grams(start, now, spool_grams.get(key, 1000))
        if grams <= 0:
            continue
        slots.append(
            {
                "slot_id": len(slots) + 1,
                "used_g": grams,
                "type": "UNKNOWN",
                "color": None,
            }
        )
        mapping.append(global_id)
    return slots, mapping or None


def remain_has_coverage(
    start_remain: dict[tuple[int, int], int],
    current_remain: dict[tuple[int, int], int],
    observed_trays: set[int] | None,
) -> bool:
    """True when start+current remain% exist on a tray this job actually used.

    Unused assigned slots are ignored. Missing remain (``-1``, no snapshot,
    external without remain) is not coverage.
    """
    if not start_remain or not current_remain or not observed_trays:
        return False
    for key, start in start_remain.items():
        if current_remain.get(key) is None:
            continue
        if slot_to_global_tray(key[0], key[1]) in observed_trays:
            try:
                if int(start) < 0 or int(current_remain[key]) < 0:
                    continue
            except (TypeError, ValueError):
                continue
            return True
    return False


def mqtt_skipped_object_ids(*sources: dict | None) -> list[int]:
    """Printer skip-objects (``s_obj``). Full plate 3MF grams still apply."""
    for source in sources:
        if not isinstance(source, dict):
            continue
        value = source.get("s_obj")
        if not isinstance(value, list):
            value = source.get("skipped_objects")
        if not isinstance(value, list) or not value:
            continue
        ids: list[int] = []
        for item in value:
            try:
                ids.append(int(item))
            except (TypeError, ValueError):
                continue
        if ids:
            return ids
    return []


async def snapshot_assigned_tray_remain(
    db: AsyncSession,
    printer_id: int,
    raw_data: dict | None,
) -> tuple[dict[tuple[int, int], int], dict[tuple[int, int], float]]:
    """Remain% + spool grams for slots with a FilamentSlotAssignment."""
    trays = parse_mqtt_tray_remain(raw_data)
    if not trays:
        return {}, {}
    result = await db.execute(select(FilamentSlotAssignment).where(FilamentSlotAssignment.printer_id == printer_id))
    remain: dict[tuple[int, int], int] = {}
    weights: dict[tuple[int, int], float] = {}
    for assignment in result.scalars().all():
        key = (int(assignment.ams_id), int(assignment.tray_id))
        tray = trays.get(key)
        if tray is None:
            continue
        bucket = await db.get(FilamentColorBucket, assignment.bucket_id)
        remain[key] = tray[0]
        weights[key] = float(bucket.spool_weight_grams or 1000) if bucket else 1000.0
    return remain, weights


def usage_kind_for(status: str) -> str:
    kind = canonical_usage_status(status)
    if kind in TRACKABLE_USAGE_KINDS:
        return kind
    return "completed"


@dataclass
class LiveTrackingRun:
    run_id: str
    printer_id: int
    archive_id: int | None
    print_name: str | None
    started_at: datetime
    slots: list[dict]
    ams_mapping: list[int]
    last_progress: float = 0.0
    last_broadcast_progress: float = -1.0
    settled: bool = False
    remain_start: dict[tuple[int, int], int] = field(default_factory=dict)
    remain_spool_grams: dict[tuple[int, int], float] = field(default_factory=dict)
    seen_trays: set[int] = field(default_factory=set)
    remaining_seconds: float | None = None


_live_runs: dict[int, LiveTrackingRun] = {}
_printer_tracking_locks: dict[int, asyncio.Lock] = {}
_settle_in_progress: set[int] = set()
_settled_jobs: dict[int, tuple[int | None, str | None, str]] = {}


def get_live_run(printer_id: int) -> LiveTrackingRun | None:
    return _live_runs.get(printer_id)


def untracked_live_runs(existing_printer_ids: set[int]) -> list[LiveTrackingRun]:
    """In-flight jobs that have no kind=printing usage rows yet."""
    return [
        run
        for run in _live_runs.values()
        if not run.settled and run.printer_id not in existing_printer_ids
    ]


def cache_live_run(run: LiveTrackingRun) -> LiveTrackingRun:
    _live_runs[run.printer_id] = run
    return run


def clear_live_run(printer_id: int) -> None:
    _live_runs.pop(printer_id, None)


def printer_tracking_lock(printer_id: int) -> asyncio.Lock:
    """Serialize live/complete source_key upserts for one printer."""
    lock = _printer_tracking_locks.get(printer_id)
    if lock is None:
        lock = _printer_tracking_locks.setdefault(printer_id, asyncio.Lock())
    return lock


def same_live_tracking_job(
    live: LiveTrackingRun | None,
    *,
    archive_id: int | None,
    print_name: str | None,
) -> bool:
    """True when ``live`` is the in-flight job that should keep its run_id.

    An archive id appearing later (``live.archive_id is None`` → ``archive_id``)
    is the same physical job. A different archive id or a different print-job
    stem (``foo.gcode.3mf`` vs ``foo``, never substring) starts a new run, so
    callers must re-estimate slots instead of reusing them.
    """
    if live is None or live.settled:
        return False
    if live.archive_id is not None and archive_id is not None:
        return int(live.archive_id) == int(archive_id)
    live_stem = job_identity_stem(live.print_name)
    incoming_stem = job_identity_stem(print_name)
    return not live_stem or not incoming_stem or live_stem == incoming_stem


def begin_tracking_settle(printer_id: int) -> None:
    _settle_in_progress.add(printer_id)


def finish_tracking_settle(
    printer_id: int,
    *,
    archive_id: int | None,
    print_name: str | None,
    run_id: str,
) -> None:
    live = _live_runs.get(printer_id)
    if live:
        live.settled = True
    _settled_jobs[printer_id] = (archive_id, print_name, run_id)
    clear_live_run(printer_id)
    _settle_in_progress.discard(printer_id)


def abort_tracking_settle(printer_id: int) -> None:
    _settle_in_progress.discard(printer_id)
    live = _live_runs.get(printer_id)
    if live:
        live.settled = False


def release_settled_tracking(printer_id: int) -> None:
    """Allow a new physical print to start live upserts after a settle."""
    _settled_jobs.pop(printer_id, None)
    _settle_in_progress.discard(printer_id)


def prepare_live_tracking_for_start(
    printer_id: int,
    *,
    archive_id: int | None = None,
    print_name: str | None = None,
) -> None:
    """Keep the same physical job's run_id; only reset when a new job starts.

    Must run under ``printer_tracking_lock`` so MQTT ``is_file_change`` cannot
    wipe a live run_id while settle is writing, and so a same-name reprint is
    not skipped by a stale ``_settled_jobs`` entry from the previous job.
    """
    live = get_live_run(printer_id)
    if same_live_tracking_job(live, archive_id=archive_id, print_name=print_name):
        release_settled_tracking(printer_id)
        return
    clear_live_run(printer_id)
    release_settled_tracking(printer_id)


def should_skip_live_upsert(
    printer_id: int,
    *,
    archive_id: int | None,
    print_name: str | None,
) -> bool:
    """True when a progress task must not write after/during settle."""
    if printer_id in _settle_in_progress:
        return True
    live = get_live_run(printer_id)
    if live and live.settled:
        return True
    settled = _settled_jobs.get(printer_id)
    if not settled:
        return False
    settled_archive, settled_name, _run_id = settled
    if settled_archive is not None and archive_id is not None:
        return int(settled_archive) == int(archive_id)
    settled_stem = job_identity_stem(settled_name)
    incoming_stem = job_identity_stem(print_name)
    if settled_stem and incoming_stem:
        return settled_stem == incoming_stem
    return not incoming_stem


def should_broadcast_live_progress(run: LiveTrackingRun, progress: float | int | None, *, settle: bool) -> bool:
    if settle:
        return True
    current = float(progress or 0)
    last = run.last_broadcast_progress
    if last < 0:
        return True
    return current >= last + 5 or current >= 100


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
            estimated=True,
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


async def close_open_live_usage(
    db: AsyncSession,
    *,
    printer_id: int,
    status: str,
    progress: float | int | None,
    occurred_at: datetime,
    archive_id: int | None,
    print_name: str | None,
    grams: float | None = None,
    estimated: bool | None = None,
) -> list[FilamentColorUsage]:
    """Settle leftover kind=printing rows so /live-rate does not stay active."""
    kind = usage_kind_for(status)
    if kind not in PRINT_USAGE_KINDS:
        return []
    result = await db.execute(
        select(FilamentColorUsage).where(
            FilamentColorUsage.printer_id == printer_id,
            FilamentColorUsage.kind == LIVE_USAGE_KIND,
        )
    )
    closed: list[FilamentColorUsage] = []
    progress_value = None if kind == "completed" else round(partial_progress_scale(status, progress) * 100, 1)
    for event in result.scalars().all():
        bucket = await db.get(FilamentColorBucket, event.bucket_id)
        if not bucket:
            continue
        target = event.grams if grams is None else grams
        updated = _apply_assigned_usage_update(
            event,
            bucket=bucket,
            grams=float(target or 0),
            kind=kind,
            progress_value=progress_value,
            occurred_at=occurred_at,
            archive_id=archive_id,
            printer_id=printer_id,
            print_name=print_name,
            estimated=estimated,
            allow_decrease=True,
        )
        if updated:
            closed.append(updated)
    if closed:
        await db.flush()
    return closed


def _apply_assigned_usage_update(
    event: FilamentColorUsage,
    *,
    bucket: FilamentColorBucket,
    grams: float,
    kind: str,
    progress_value: float | None,
    occurred_at: datetime,
    archive_id: int | None,
    printer_id: int | None,
    print_name: str | None,
    estimated: bool | None = None,
    allow_decrease: bool = False,
) -> FilamentColorUsage | None:
    """Reconcile one source_key. Live 3MF grams are monotonic until remain/settle."""
    if event.kind in PRINT_USAGE_KINDS and kind == LIVE_USAGE_KIND:
        return None
    if kind == LIVE_USAGE_KIND and not allow_decrease and grams < (event.grams or 0):
        return event
    delta = round(grams - (event.grams or 0), 1)
    if bucket.stock_initialized and delta:
        bucket.on_hand_grams = round(max(0.0, (bucket.on_hand_grams or 0) - delta), 1)
    event.grams = grams
    event.kind = kind
    event.progress = progress_value
    if estimated is not None:
        event.estimated = estimated
    if archive_id is not None:
        event.archive_id = archive_id
    if printer_id is not None:
        event.printer_id = printer_id
    if print_name:
        event.print_name = print_name
    if kind in PRINT_USAGE_KINDS:
        event.occurred_at = occurred_at
    elif kind == LIVE_USAGE_KIND:
        # First write can be a mid-print latch; keep the earlier print start.
        existing = _as_utc(event.occurred_at)
        incoming = _as_utc(occurred_at)
        if incoming < existing:
            event.occurred_at = occurred_at
    return event


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
    estimated: bool = False,
    allow_decrease: bool = False,
) -> FilamentColorUsage | None:
    """Insert or replace usage for one run+slot so live progress is not stacked."""
    grams = round(max(0.0, grams), 1)
    kind = usage_kind_for(status)
    progress_value = None if kind == "completed" else round(partial_progress_scale(status, progress) * 100, 1)
    existing = await db.execute(select(FilamentColorUsage).where(FilamentColorUsage.source_key == source_key))
    event = existing.scalar_one_or_none()
    if event:
        return _apply_assigned_usage_update(
            event,
            bucket=bucket,
            grams=grams,
            kind=kind,
            progress_value=progress_value,
            occurred_at=occurred_at,
            archive_id=archive_id,
            printer_id=printer_id,
            print_name=print_name,
            estimated=estimated,
            allow_decrease=allow_decrease or kind in PRINT_USAGE_KINDS,
        )
    if grams <= 0 and kind != LIVE_USAGE_KIND:
        return None
    event = FilamentColorUsage(
        bucket_id=bucket.id,
        grams=grams,
        occurred_at=occurred_at,
        kind=kind,
        progress=progress_value,
        archive_id=archive_id,
        printer_id=printer_id,
        print_name=print_name,
        source_key=source_key,
        estimated=estimated,
    )
    try:
        async with db.begin_nested():
            db.add(event)
            await db.flush()
    except IntegrityError:
        result = await db.execute(select(FilamentColorUsage).where(FilamentColorUsage.source_key == source_key))
        raced = result.scalar_one_or_none()
        if raced is None:
            raise
        return _apply_assigned_usage_update(
            raced,
            bucket=bucket,
            grams=grams,
            kind=kind,
            progress_value=progress_value,
            occurred_at=occurred_at,
            archive_id=archive_id,
            printer_id=printer_id,
            print_name=print_name,
            estimated=estimated,
            allow_decrease=allow_decrease or kind in PRINT_USAGE_KINDS,
        )
    if bucket.stock_initialized:
        bucket.on_hand_grams = round(max(0.0, (bucket.on_hand_grams or 0) - grams), 1)
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
    mqtt_mapping: list | None = None,
    tray_now: int | None = None,
    started_at: datetime | None = None,
    run_id: str | None = None,
    estimated: bool = False,
    allow_decrease: bool = False,
) -> list[FilamentColorUsage]:
    """Subtract print grams from products assigned to the printer slots used.

    3MF hex/type is not enough: EasyRock White and generic white can share a
    hex. Deduction follows the slot assignment on the printers tab.
    Unassigned slots are skipped so we do not invent a family White bucket.

    Live progress upserts the same source_key so completion reconciles instead
    of stacking a second deduction. Mapping may come from our send, the MQTT
    print payload, the printer ``mapping`` field, or the tray currently in use.
    ``estimated`` is True only when skip-objects fired; remain=-1 is not.
    """
    when = occurred_at or datetime.now(timezone.utc)
    kind = usage_kind_for(status)
    if kind == LIVE_USAGE_KIND and started_at is not None:
        start = _as_utc(started_at)
        if start < _as_utc(when):
            when = start
    if printer_id is None:
        return []
    await collapse_duplicate_live_usage(db, printer_id=printer_id, print_name=print_name)
    settling = kind in PRINT_USAGE_KINDS
    scale = partial_progress_scale(status, progress)
    if scale <= 0:
        if settling:
            return await close_open_live_usage(
                db,
                printer_id=printer_id,
                status=status,
                progress=progress,
                occurred_at=when,
                archive_id=archive_id,
                print_name=print_name,
                grams=0.0,
                estimated=estimated,
            )
        return []
    used_slots = [slot for slot in slots if float(slot.get("used_g") or slot.get("used_grams") or 0) > 0]
    mapping = resolve_ams_mapping(
        ams_mapping=ams_mapping,
        mqtt_mapping=mqtt_mapping,
        tray_now=tray_now,
        slot_count=len(used_slots),
    )
    mapping = align_mapping_to_used_slots(mapping, slots)
    if not mapping:
        return []
    existing_run = await live_run_id_for_job(db, printer_id=printer_id, print_name=print_name)
    run_key = existing_run or run_id or tracking_run_id(
        archive_id=archive_id,
        printer_id=printer_id,
        print_name=print_name,
        started_at=started_at or when,
    )
    created: list[FilamentColorUsage] = []
    for index, slot in enumerate(slots):
        grams = float(slot.get("used_g") or slot.get("used_grams") or 0) * scale
        if grams <= 0:
            continue
        try:
            slot_id = int(slot.get("slot_id") or (index + 1))
        except (TypeError, ValueError):
            slot_id = index + 1
        mapped = mapping_tray_id(slot_id, mapping)
        if mapped is None or not is_active_global_tray(mapped):
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
            source_key=usage_source_key(run_key, bucket.id, ams_id, tray_id),
            estimated=estimated,
            allow_decrease=allow_decrease,
        )
        if event:
            created.append(event)
    if created:
        await db.flush()
    return created


async def ensure_live_job_visible(
    db: AsyncSession,
    *,
    printer_id: int,
    print_name: str | None,
    archive_id: int | None,
    progress: float | int | None,
    occurred_at: datetime,
    run_id: str,
    tray_now: int | None,
    estimated: bool = False,
) -> FilamentColorUsage | None:
    """0 g live row so a running job stays visible when assigned trays have no grams yet."""
    if not is_active_global_tray(tray_now):
        return None
    ams_id, tray_id = global_tray_to_slot(int(tray_now))
    bucket = await assigned_bucket_for_slot(db, printer_id=printer_id, ams_id=ams_id, tray_id=tray_id)
    if not bucket:
        return None
    event = await record_assigned_usage(
        db,
        bucket=bucket,
        grams=0.0,
        status=LIVE_USAGE_KIND,
        progress=progress,
        occurred_at=occurred_at,
        archive_id=archive_id,
        printer_id=printer_id,
        print_name=print_name,
        source_key=usage_source_key(run_id, bucket.id, ams_id, tray_id),
        estimated=estimated,
    )
    if event:
        await db.flush()
    return event


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


def _progress_fraction(progress: float | int | None) -> float | None:
    """Normalize 0–100 or 0–1 progress to (0, 1) exclusive. None if unusable."""
    if progress is None:
        return None
    try:
        value = float(progress)
    except (TypeError, ValueError):
        return None
    if value > 1.0:
        value /= 100.0
    if value <= 0.0 or value >= 1.0:
        return None
    return value


def infer_elapsed_seconds(
    progress: float | int | None,
    remaining_seconds: float | None = None,
    print_time_seconds: float | int | None = None,
) -> float | None:
    """Elapsed print time from MQTT remaining_time or slicer duration × progress."""
    fraction = _progress_fraction(progress)
    if fraction is None:
        return None
    try:
        remaining = float(remaining_seconds) if remaining_seconds is not None else None
    except (TypeError, ValueError):
        remaining = None
    if remaining is not None and remaining > 0:
        return remaining * fraction / (1.0 - fraction)
    try:
        total = float(print_time_seconds) if print_time_seconds is not None else None
    except (TypeError, ValueError):
        total = None
    if total is not None and total > 0:
        return total * fraction
    return None


def resolve_print_started_at(
    *,
    now: datetime,
    occurred_at: datetime | None = None,
    archive_started_at: datetime | None = None,
    live_started_at: datetime | None = None,
    progress: float | int | None = None,
    remaining_seconds: float | None = None,
    print_time_seconds: float | int | None = None,
) -> datetime:
    """Earliest plausible print start — never the mid-print first upsert if later.

    Prefer archive.started_at / live-run started_at, then MQTT remaining_time
    (or slicer duration) inferred elapsed, then the usage row's occurred_at.
    """
    now_utc = _as_utc(now)
    inferred = infer_elapsed_seconds(progress, remaining_seconds, print_time_seconds)
    inferred_start = now_utc - timedelta(seconds=inferred) if inferred else None
    candidates: list[datetime] = []
    for value in (archive_started_at, live_started_at, occurred_at):
        if value is not None:
            candidates.append(_as_utc(value))
    if inferred_start is not None and inferred_start <= now_utc + timedelta(seconds=1):
        candidates.append(inferred_start)
    return min(candidates) if candidates else now_utc


def printer_remaining_seconds(printer_id: int | None) -> float | None:
    """MQTT ``remaining_time`` in seconds (client stores minutes)."""
    if printer_id is None:
        return None
    try:
        from backend.app.services.printer_manager import printer_manager
    except Exception:
        return None
    try:
        client = printer_manager.get_client(printer_id)
        state = client.state if client else printer_manager.get_status(printer_id)
    except Exception:
        return None
    if not state:
        return None
    try:
        minutes = float(getattr(state, "remaining_time", None) or 0)
    except (TypeError, ValueError):
        return None
    if minutes <= 0:
        return None
    return minutes * 60.0


def live_usage_window(
    grams: float,
    started_at: datetime,
    now: datetime,
) -> tuple[float, float, float]:
    """Return (grams_per_hour, grams_last_hour, elapsed_seconds) for one live row.

    Rate is grams so far / hours since **print start**, not first DB write.
    Last-hour grams stay the actual deducted amount when elapsed < 1h; longer
    runs scale by 1h/elapsed. Tiny elapsed (warmup or a 3MF×progress catch-up
    blob) does not extrapolate to kg/h — grams_per_hour is 0 so the KPI can
    show "—" instead of a spike.
    """
    grams = max(0.0, float(grams or 0))
    elapsed = (_as_utc(now) - _as_utc(started_at)).total_seconds()
    if elapsed <= 0:
        return 0.0, round(grams, 1), 0.0
    if elapsed >= HOUR_SECONDS:
        last_hour = grams * (HOUR_SECONDS / elapsed)
    else:
        last_hour = grams
    last_hour = round(last_hour, 1)
    if elapsed < LIVE_RATE_WARMUP_SECONDS:
        return 0.0, last_hour, elapsed
    grams_per_hour = grams / (elapsed / HOUR_SECONDS)
    if grams_per_hour > LIVE_RATE_MAX_GPH:
        return 0.0, last_hour, elapsed
    return round(grams_per_hour, 1), last_hour, elapsed


def _dedupe_live_samples(samples: list[LiveUsageSample]) -> list[LiveUsageSample]:
    """One live row per printer+product. Stacked run_ids must not sum into kg/h."""
    best: dict[tuple[int, int], LiveUsageSample] = {}
    leftovers: list[LiveUsageSample] = []
    for sample in samples:
        if sample.printer_id is None:
            leftovers.append(sample)
            continue
        key = (sample.printer_id, sample.bucket_id)
        prev = best.get(key)
        if prev is None or sample.grams > prev.grams:
            best[key] = sample
    return list(best.values()) + leftovers


def compute_live_usage_rate(
    samples: list[LiveUsageSample],
    as_of: datetime | None = None,
) -> LiveUsageRate:
    """Aggregate live assigned-product deductions into a current g/h rate."""
    now = _as_utc(as_of or datetime.now(timezone.utc))
    samples = _dedupe_live_samples(samples)
    grouped: dict[int, list[LiveUsageSample]] = {}
    printers: set[int] = set()
    orphan_jobs = 0
    for sample in samples:
        if sample.printer_id is not None:
            printers.add(sample.printer_id)
        elif sample.grams > 0:
            orphan_jobs += 1
        if sample.grams <= 0:
            continue
        grouped.setdefault(sample.bucket_id, []).append(sample)

    products: list[LiveUsageProduct] = []
    any_reliable = False
    any_warming = False
    for bucket_samples in grouped.values():
        first = bucket_samples[0]
        grams_so_far = 0.0
        grams_last_hour = 0.0
        grams_per_hour = 0.0
        for sample in bucket_samples:
            started = resolve_print_started_at(
                now=now,
                occurred_at=sample.occurred_at,
                archive_started_at=sample.started_at,
                progress=sample.progress,
                remaining_seconds=sample.remaining_seconds,
                print_time_seconds=sample.print_time_seconds,
            )
            rate, last_hour, elapsed = live_usage_window(sample.grams, started, now)
            grams_so_far += sample.grams
            grams_last_hour += last_hour
            if elapsed >= LIVE_RATE_WARMUP_SECONDS and rate > 0:
                grams_per_hour += rate
                any_reliable = True
            elif sample.grams > 0 and (elapsed < LIVE_RATE_WARMUP_SECONDS or rate <= 0):
                any_warming = True
        products.append(
            LiveUsageProduct(
                bucket_id=first.bucket_id,
                color_name=first.color_name,
                material=first.material,
                brand=identity_or_none(first.brand),
                subtype=identity_or_none(first.subtype),
                extra_colors=normalize_extra_colors(first.extra_colors) or None,
                effect_type=normalize_effect_type(first.effect_type) or None,
                color_hex=first.color_hex,
                grams_so_far=round(grams_so_far, 1),
                grams_last_hour=round(grams_last_hour, 1),
                grams_per_hour=round(grams_per_hour, 1),
            )
        )
    products.sort(key=lambda row: (-row.grams_per_hour, row.color_name.lower(), row.material.lower()))
    return LiveUsageRate(
        grams_per_hour=round(sum(p.grams_per_hour for p in products), 1),
        grams_last_hour=round(sum(p.grams_last_hour for p in products), 1),
        grams_so_far=round(sum(p.grams_so_far for p in products), 1),
        active_jobs=len(printers) + orphan_jobs,
        products=products,
        warming_up=any_warming and not any_reliable,
    )


async def load_live_usage_rate(db: AsyncSession, as_of: datetime | None = None) -> LiveUsageRate:
    """Live kind=printing rows only — assigned products, not hex family buckets."""
    from backend.app.models.archive import PrintArchive

    rows = (
        await db.execute(
            select(FilamentColorUsage, FilamentColorBucket, PrintArchive)
            .join(FilamentColorBucket, FilamentColorUsage.bucket_id == FilamentColorBucket.id)
            .outerjoin(PrintArchive, FilamentColorUsage.archive_id == PrintArchive.id)
            .where(FilamentColorUsage.kind == LIVE_USAGE_KIND)
        )
    ).all()
    samples: list[LiveUsageSample] = []
    for event, bucket, archive in rows:
        live = get_live_run(event.printer_id) if event.printer_id is not None else None
        remaining = live.remaining_seconds if live and live.remaining_seconds else printer_remaining_seconds(
            event.printer_id
        )
        progress = event.progress
        if progress is None and live is not None:
            progress = live.last_progress or None
        print_time = archive.print_time_seconds if archive is not None else None
        started = resolve_print_started_at(
            now=as_of or datetime.now(timezone.utc),
            occurred_at=event.occurred_at,
            archive_started_at=archive.started_at if archive is not None else None,
            live_started_at=live.started_at if live is not None else None,
            progress=progress,
            remaining_seconds=remaining,
            print_time_seconds=print_time,
        )
        samples.append(
            LiveUsageSample(
                bucket_id=bucket.id,
                color_name=bucket.color_name,
                material=bucket.material,
                brand=identity_or_none(bucket.brand),
                subtype=identity_or_none(bucket.subtype),
                extra_colors=bucket.extra_colors,
                effect_type=bucket.effect_type,
                color_hex=bucket.color_hex,
                grams=float(event.grams or 0),
                occurred_at=event.occurred_at,
                printer_id=event.printer_id,
                started_at=started,
                progress=progress,
                remaining_seconds=remaining,
                print_time_seconds=print_time,
            )
        )
    return compute_live_usage_rate(samples, as_of=as_of)


async def load_printer_consumption(db: AsyncSession) -> list[PrinterConsumption]:
    """Sum tracked grams per printer, including live ``kind=printing`` rows.

    Attribution is ``printer_id`` on the usage event (the printer that ran the
    job), not the slot-assignment map. Two colors on one AMS still belong to
    that one printer.
    """
    usage_rows = (
        await db.execute(
            select(
                FilamentColorUsage.printer_id,
                func.coalesce(func.sum(FilamentColorUsage.grams), 0).label("grams"),
            )
            .where(
                FilamentColorUsage.kind.in_(TRACKABLE_USAGE_KINDS),
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
