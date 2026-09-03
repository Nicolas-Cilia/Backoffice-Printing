"""Stats 2 (Phase 2) device-recipe service: bootstrap + slot discovery.

BOM lines reference ProductionPart (TOP/BOT/KNB/BUT). Discovery scans the
Production section's printer-model folders (those with
``production_printer_model`` set) for library files whose name parses as
``CODE xQTY - M.R.m - PRINTER`` matching the part code, and materializes them
as real ``ProductionPartInstance`` + ``ProductionSlot`` rows so preferred-slot,
metrics, and capacity math keep working. Phase 2 keeps one default recipe.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.models.device_recipe import DeviceRecipe, DeviceRecipeLine
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.production import (
    DEFAULT_PARTS,
    ProductionPart,
    ProductionPartInstance,
    ProductionSlot,
    default_part_codes_for_printer,
)
from backend.app.services.production_filename import (
    normalize_production_printer_code,
    parse_production_filename,
)
from backend.app.services.stats2_config import get_stats2_globals
from backend.app.services.stats2_slot_metrics import get_slot_metrics_map

DEFAULT_RECIPE_NAME = "Default Device"

_DEFAULT_PRINT_TIME_SECONDS = 3600  # 1h fallback when a slot has no metadata


async def _ensure_default_parts(db: AsyncSession) -> dict[str, ProductionPart]:
    by_code: dict[str, ProductionPart] = {}
    for code, name in DEFAULT_PARTS:
        result = await db.execute(select(ProductionPart).where(ProductionPart.code == code))
        part = result.scalar_one_or_none()
        if part is None:
            part = ProductionPart(code=code, name=name)
            db.add(part)
            await db.flush()
        by_code[code] = part
    return by_code


async def get_or_create_default_recipe(db: AsyncSession) -> DeviceRecipe:
    """Return the singleton default recipe; create lines for DEFAULT_PARTS if needed."""
    parts_by_code = await _ensure_default_parts(db)
    result = await db.execute(
        select(DeviceRecipe).options(selectinload(DeviceRecipe.lines)).order_by(DeviceRecipe.id).limit(1)
    )
    recipe = result.scalar_one_or_none()
    if recipe is None:
        recipe = DeviceRecipe(name=DEFAULT_RECIPE_NAME)
        db.add(recipe)
        await db.flush()
        for code, _name in DEFAULT_PARTS:
            db.add(
                DeviceRecipeLine(
                    recipe_id=recipe.id,
                    part_id=parts_by_code[code].id,
                    qty_per_device=1,
                )
            )
        await db.flush()
    else:
        existing_part_ids = {line.part_id for line in recipe.lines}
        for code, _name in DEFAULT_PARTS:
            part = parts_by_code[code]
            if part.id not in existing_part_ids:
                db.add(DeviceRecipeLine(recipe_id=recipe.id, part_id=part.id, qty_per_device=1))
        await db.flush()

    result = await db.execute(
        select(DeviceRecipe)
        .options(
            selectinload(DeviceRecipe.lines).selectinload(DeviceRecipeLine.part),
        )
        .where(DeviceRecipe.id == recipe.id)
    )
    return result.scalar_one()


def _effective_score(slot: dict, metrics, clear_minutes: int, eligible_printers: int = 1) -> float:
    """Projected effective devices/day for a slot, aligned with capacity math.

    Proportional to
    ``eligible_printers * job_success / cycle_seconds
      * (quantity * harvest_yield * qc_yield)``.
    ``qty_per_device`` is identical across a part's slots so it drops out of the
    ranking, but the eligible active-printer count does NOT: a slot's printer
    model may have no fleet, in which case it can never actually print and must
    score zero regardless of how dense or reliable it looks.
    """
    success = metrics.print_job_success if metrics is not None else 1.0
    harvest = metrics.harvest_yield if metrics is not None else 1.0
    qc = metrics.qc_yield if metrics is not None else 1.0
    print_time = int(slot.get("print_time_seconds") or _DEFAULT_PRINT_TIME_SECONDS)
    qty = max(1, int(slot.get("quantity") or 1))
    cycle = max(1, print_time + int(clear_minutes) * 60)
    plates = max(0.0, min(1.0, success)) / cycle
    eff_parts = qty * max(0.0, min(1.0, harvest)) * max(0.0, min(1.0, qc))
    return max(0, int(eligible_printers)) * plates * eff_parts


async def recommend_slot_for_part(
    db: AsyncSession,
    slots: list[dict],
    preferred_slot_id: int | None,
    *,
    part_code: str | None = None,
) -> int | None:
    """Pick the slot with the best projected *effective* devices/day.

    Applies per-slot print-job success (and harvest/QC when available) from
    history via ``get_slot_metrics_map`` AND weights each slot by the number of
    active printers eligible for its ``printer_model`` + ``part_code`` (see
    ``capacity_analysis.eligible_printer_count``) so a slot with no fleet never
    wins. Densest slot is only a tie-break when effective scores are equal.

    ``preferred_slot_id`` is ignored — capacity and the weekly print plan sum
    every eligible model, so a single preferred file must not pin the fleet.
    """
    del preferred_slot_id  # retained in signature for call-site compatibility
    if not slots:
        return None
    slot_ids = [int(s["slot_id"]) for s in slots]
    metrics_map = await get_slot_metrics_map(db, slot_ids)
    globals_ = await get_stats2_globals(db)
    clear_minutes = globals_.expected_plate_clear_minutes

    # Imported lazily to avoid a circular import (capacity_analysis imports
    # get_recipe_view from this module).
    from backend.app.services.capacity_analysis import (
        count_active_printers_by_model,
        eligible_printer_count,
    )

    fleet = await count_active_printers_by_model(db)

    def _eligible(slot: dict) -> int:
        if part_code is None:
            return 1
        return eligible_printer_count(fleet, slot.get("printer_model"), part_code)

    ranked = sorted(
        slots,
        key=lambda s: (
            -_effective_score(s, metrics_map.get(int(s["slot_id"])), clear_minutes, _eligible(s)),
            -int(s["quantity"]),
            int(s["slot_id"]),
        ),
    )
    return ranked[0]["slot_id"]


async def _ensure_instance(
    db: AsyncSession, part_id: int, printer_model: str, folder_id: int
) -> ProductionPartInstance:
    """Get-or-create the (part, printer_model, folder) instance; un-hide if hidden."""
    model = normalize_production_printer_code(printer_model) or printer_model
    result = await db.execute(
        select(ProductionPartInstance)
        .where(ProductionPartInstance.part_id == part_id)
        .where(ProductionPartInstance.printer_model == model)
        .where(ProductionPartInstance.folder_id == folder_id)
    )
    instance = result.scalar_one_or_none()
    if instance is None:
        instance = ProductionPartInstance(
            part_id=part_id,
            printer_model=model,
            folder_id=folder_id,
        )
        db.add(instance)
        await db.flush()
    elif instance.hidden:
        instance.hidden = False
        await db.flush()
    return instance


async def _ensure_slots_from_production_folders(db: AsyncSession, part: ProductionPart) -> None:
    """Materialize ProductionSlots for ``part`` from matching production-folder files.

    Scans every ``LibraryFolder`` bound to a printer model, keeps the newest
    library file per quantity whose parsed code/printer matches, and upserts a
    real ``ProductionSlot`` (creating the instance on demand) so downstream
    discovery, metrics, and capacity math operate on persisted rows.
    """
    folders = (
        (await db.execute(select(LibraryFolder).where(LibraryFolder.production_printer_model.is_not(None))))
        .scalars()
        .all()
    )

    for folder in folders:
        folder_model = normalize_production_printer_code(folder.production_printer_model)
        if not folder_model:
            continue
        if part.code not in default_part_codes_for_printer(folder_model):
            continue

        files = (await db.execute(LibraryFile.active().where(LibraryFile.folder_id == folder.id))).scalars().all()

        # Best (highest version) file per quantity.
        best_by_qty: dict[int, tuple[LibraryFile, object]] = {}
        for lib in files:
            parsed = parse_production_filename(lib.filename)
            if parsed is None or parsed.code != part.code:
                continue
            file_model = normalize_production_printer_code(parsed.printer)
            if file_model and file_model != folder_model:
                continue
            current = best_by_qty.get(parsed.quantity)
            if current is None or parsed.version_tuple > current[1].version_tuple:
                best_by_qty[parsed.quantity] = (lib, parsed)

        if not best_by_qty:
            continue

        instance = await _ensure_instance(db, part.id, folder_model, folder.id)

        for quantity, (lib, parsed) in best_by_qty.items():
            slot = (
                await db.execute(
                    select(ProductionSlot)
                    .where(ProductionSlot.instance_id == instance.id)
                    .where(ProductionSlot.quantity == quantity)
                )
            ).scalar_one_or_none()
            if slot is None:
                slot = ProductionSlot(
                    instance_id=instance.id,
                    quantity=quantity,
                    active_file_id=lib.id,
                    major=parsed.major,
                    revision=parsed.revision,
                    minor=parsed.minor,
                )
                db.add(slot)
            elif parsed.version_tuple > (slot.major, slot.revision, slot.minor):
                slot.active_file_id = lib.id
                slot.major = parsed.major
                slot.revision = parsed.revision
                slot.minor = parsed.minor
            elif slot.active_file_id is None:
                slot.active_file_id = lib.id
        await db.flush()


async def _slots_for_part_id(db: AsyncSession, part_id: int) -> list[dict]:
    part = await db.get(ProductionPart, part_id)
    if part is not None:
        await _ensure_slots_from_production_folders(db, part)
    rows = (
        await db.execute(
            select(ProductionSlot, ProductionPartInstance)
            .join(ProductionPartInstance, ProductionSlot.instance_id == ProductionPartInstance.id)
            .where(ProductionPartInstance.part_id == part_id)
            .where(ProductionPartInstance.hidden.is_(False))
            .where(ProductionSlot.active_file_id.is_not(None))
            .options(selectinload(ProductionSlot.active_file))
            .order_by(ProductionPartInstance.printer_model, ProductionSlot.quantity)
        )
    ).all()
    out: list[dict] = []
    for slot, instance in rows:
        filename = slot.active_file.filename if slot.active_file is not None else None
        print_time = None
        if slot.active_file is not None:
            meta = slot.active_file.file_metadata or {}
            raw = meta.get("print_time_seconds") or meta.get("estimated_print_time_seconds")
            try:
                print_time = int(raw) if raw is not None else None
            except (TypeError, ValueError):
                print_time = None
        out.append(
            {
                "slot_id": slot.id,
                "printer_model": instance.printer_model,
                "quantity": slot.quantity,
                "print_time_seconds": print_time,
                "filename": filename,
                "version": f"{slot.major}.{slot.revision}.{slot.minor}",
            }
        )
    return out


async def discover_slots_for_part_code(db: AsyncSession, part_code: str) -> list[dict]:
    code = part_code.strip().upper()
    part = (await db.execute(select(ProductionPart).where(ProductionPart.code == code))).scalar_one_or_none()
    if part is None:
        return []
    slots = await _slots_for_part_id(db, part.id)
    rec_id = await recommend_slot_for_part(db, slots, None, part_code=code)
    for s in slots:
        s["recommended"] = s["slot_id"] == rec_id
    return slots


async def get_recipe_view(db: AsyncSession) -> dict:
    """Full recipe view with discovered slots and ★ recommendation per line."""
    recipe = await get_or_create_default_recipe(db)
    lines_out = []
    for line in sorted(recipe.lines, key=lambda ln: (ln.part.code if ln.part else "", ln.id)):
        part = line.part
        slots = await _slots_for_part_id(db, line.part_id) if part else []
        rec_id = await recommend_slot_for_part(db, slots, line.preferred_slot_id, part_code=part.code if part else None)
        for s in slots:
            s["recommended"] = s["slot_id"] == rec_id
        rec = next((s for s in slots if s["recommended"]), None)
        lines_out.append(
            {
                "id": line.id,
                "part_id": line.part_id,
                "part_code": part.code if part else "",
                "part_name": part.name if part else "",
                "qty_per_device": line.qty_per_device,
                "preferred_slot_id": line.preferred_slot_id,
                "recommended_slot_id": rec_id,
                "recommended_filename": rec["filename"] if rec else None,
                "discovered_slots": slots,
            }
        )
    return {"id": recipe.id, "name": recipe.name, "lines": lines_out}


async def replace_recipe_lines(db: AsyncSession, lines: list[dict]) -> dict:
    """Replace default recipe lines. Each: part_code, qty_per_device, preferred_slot_id?"""
    recipe = await get_or_create_default_recipe(db)
    parts = await _ensure_default_parts(db)

    normalized: list[dict] = []
    seen: set[str] = set()
    for raw in lines:
        code = str(raw.get("part_code", "")).strip().upper()
        if not code:
            raise ValueError("each line needs part_code")
        if code not in parts:
            raise ValueError(f"unknown part_code {code}")
        if code in seen:
            raise ValueError(f"duplicate part_code {code}")
        seen.add(code)
        qty = int(raw.get("qty_per_device", 1) or 1)
        if qty < 1:
            raise ValueError("qty_per_device must be >= 1")
        preferred = raw.get("preferred_slot_id")
        preferred_id = int(preferred) if preferred not in (None, "") else None
        if preferred_id is not None:
            allowed = {s["slot_id"] for s in await _slots_for_part_id(db, parts[code].id)}
            # Allow prefer even if no active file yet (slot may exist without active file)
            slot = await db.get(ProductionSlot, preferred_id)
            if slot is None:
                raise ValueError(f"unknown preferred_slot_id {preferred_id}")
            if allowed and preferred_id not in allowed:
                # Still allow if slot belongs to this part via instance
                inst = await db.get(ProductionPartInstance, slot.instance_id)
                if inst is None or inst.part_id != parts[code].id:
                    raise ValueError(f"preferred_slot_id {preferred_id} does not belong to {code}")
        normalized.append(
            {
                "part_id": parts[code].id,
                "qty_per_device": qty,
                "preferred_slot_id": preferred_id,
            }
        )

    for line in list(recipe.lines):
        await db.delete(line)
    await db.flush()
    for values in normalized:
        db.add(DeviceRecipeLine(recipe_id=recipe.id, **values))
    await db.flush()
    return await get_recipe_view(db)


# Back-compat aliases used by tests / older drafts
get_or_bootstrap_recipe = get_or_create_default_recipe
recipe_with_discovery = get_recipe_view
