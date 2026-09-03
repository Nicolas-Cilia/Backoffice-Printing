"""Stats 2 filament-per-device estimate from recipe slot library files.

Uses each recommended production slot's active library file
``file_metadata.filament_used_grams`` (slicer weight for that plate), divided
by qty/plate × qty/device. Never averages print archives — those can link
unrelated jobs to a library file id.

Material cost uses Settings ``default_filament_cost`` ($/kg) × grams/1000 —
same fallback as archive/print cost tracking when no spool rate is known.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.api.routes.settings import get_setting
from backend.app.models.library import LibraryFile
from backend.app.models.production import ProductionSlot
from backend.app.services.capacity_analysis import _slot_from_line
from backend.app.services.device_recipe_service import get_recipe_view


def _plate_grams_from_metadata(meta: dict | None) -> float | None:
    if not meta:
        return None
    raw = meta.get("filament_used_grams")
    if raw is None:
        return None
    try:
        grams = float(raw)
    except (TypeError, ValueError):
        return None
    if grams < 0:
        return None
    return grams


def _cost_for_grams(grams: float | None, cost_per_kg: float) -> float | None:
    if grams is None or cost_per_kg <= 0:
        return None
    return round((grams / 1000.0) * cost_per_kg, 2)


async def compute_filament_stats(db: AsyncSession, *, lookback_days: int = 30) -> dict:
    # lookback_days kept for API compatibility; estimate is file-metadata based.
    recipe = await get_recipe_view(db)

    default_cost_str = await get_setting(db, "default_filament_cost")
    try:
        cost_per_kg = float(default_cost_str) if default_cost_str is not None else 25.0
    except (TypeError, ValueError):
        cost_per_kg = 25.0
    currency = (await get_setting(db, "currency")) or "USD"

    per_part = []
    grams_per_device = 0.0
    for line in recipe["lines"]:
        slot = _slot_from_line(line)
        qty_device = max(1, int(line["qty_per_device"]))
        est_grams_plate = None
        filename = slot.get("filename") if slot else None

        if slot and slot.get("slot_id"):
            slot_row = await db.get(
                ProductionSlot,
                int(slot["slot_id"]),
                options=(selectinload(ProductionSlot.active_file),),
            )
            active: LibraryFile | None = slot_row.active_file if slot_row else None
            if active is not None:
                filename = active.filename or filename
                est_grams_plate = _plate_grams_from_metadata(active.file_metadata)

        qty_plate = max(1, int(slot.get("quantity") or 1)) if slot else 1
        grams_for_part = None
        if est_grams_plate is not None:
            grams_for_part = (est_grams_plate / qty_plate) * qty_device
            grams_per_device += grams_for_part

        grams_rounded = round(grams_for_part, 2) if grams_for_part is not None else None
        per_part.append(
            {
                "part_code": line["part_code"],
                "qty_per_device": qty_device,
                "slot_id": slot.get("slot_id") if slot else None,
                "filename": filename,
                "quantity_per_plate": qty_plate if slot else None,
                "avg_grams_per_plate": round(est_grams_plate, 2) if est_grams_plate is not None else None,
                "grams_per_device_part": grams_rounded,
                "cost_per_device_part": _cost_for_grams(grams_rounded, cost_per_kg),
            }
        )

    grams_estimate = round(grams_per_device, 2) if grams_per_device else None
    return {
        "lookback_days": lookback_days,
        "grams_per_device_estimate": grams_estimate,
        "cost_per_device_estimate": _cost_for_grams(grams_estimate, cost_per_kg),
        "cost_per_kg": cost_per_kg,
        "currency": currency,
        "parts": per_part,
        "historical_total_grams": None,
        "as_of": datetime.now(timezone.utc).isoformat(),
        "source": "recipe_slot_library_metadata",
    }
