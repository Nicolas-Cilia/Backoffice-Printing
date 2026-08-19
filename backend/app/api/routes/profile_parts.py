"""Profile part-section HTTP API: named sections, per-printer process slots, replace/diff."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.local_preset import LocalPreset
from backend.app.models.profile_part import ProfilePartRevision, ProfilePartSection, ProfilePartSlot
from backend.app.models.user import User
from backend.app.schemas.production import ProductionParameterDiff
from backend.app.schemas.profile_part import (
    ProfilePartImportAttached,
    ProfilePartImportNeedsConfirm,
    ProfilePartImportNeedsReplace,
    ProfilePartImportResponse,
    ProfilePartPresetSummary,
    ProfilePartPreviewReplaceRequest,
    ProfilePartReplacePreview,
    ProfilePartReplaceRequest,
    ProfilePartSectionCreate,
    ProfilePartSectionView,
    ProfilePartSlotCreate,
    ProfilePartSlotView,
)
from backend.app.services.orca_profiles import import_orca_file
from backend.app.services.production_settings import diff_parameters, extract_from_process_settings
from backend.app.services.profile_part_printer import is_unknown_printer, printer_model_from_preset

router = APIRouter(prefix="/profile-parts", tags=["Profile Parts"])

_VALID_RESOLUTIONS = frozenset({"proceed", "accept_baseline"})
_SLOT_EXISTS_DETAIL = "Use replace for an existing printer slot"
_MISMATCH_CONFIRM_DETAIL = (
    "This process does not match the section print-settings contract. "
    "Pass resolution 'proceed' to attach anyway."
)
_CONTRACT_RESOLUTION_DETAIL = (
    "This section already has a print-settings contract. Pass resolution 'proceed' or 'accept_baseline'."
)
_PRINTER_MISMATCH_DETAIL = "This process belongs to a different printer than the slot"
_NOT_PROCESS_DETAIL = "Only process presets can be attached to a part section"
_NOT_PROCESS_FILE_DETAIL = "This file does not contain a process preset"


def _has_mismatches(diff: list[dict[str, Any]]) -> bool:
    return any(not row.get("match", False) for row in diff)


def _process_parameters(preset: LocalPreset) -> dict[str, Any]:
    if not preset.setting:
        return {}
    try:
        config = json.loads(preset.setting)
    except (ValueError, TypeError):
        return {}
    if not isinstance(config, dict):
        return {}
    return extract_from_process_settings(config)


def _preset_printer_model(preset: LocalPreset) -> str:
    return printer_model_from_preset(
        name=preset.name,
        compatible_printers=preset.compatible_printers,
        preset_id=preset.id,
    )


def _apply_shared_contract(
    section: ProfilePartSection,
    incoming: dict[str, Any],
    resolution: str | None,
    printer_model: str | None = None,
) -> tuple[bool, bool]:
    """Compare incoming settings to the section contract.

    Returns ``(mismatch, accepted_new_baseline)``. The first process seeds
    ``locked_parameters``. Later adds that mismatch require ``resolution='proceed'``
    to attach without changing the baseline. Replace also accepts ``accept_baseline``.
    """
    if not section.locked_parameters:
        section.locked_parameters = incoming
        return False, True
    diff = diff_parameters(section.locked_parameters, incoming, printer_model=printer_model)
    if not _has_mismatches(diff):
        return False, False
    if resolution is None:
        return True, False
    if resolution not in _VALID_RESOLUTIONS:
        raise HTTPException(status_code=400, detail=_CONTRACT_RESOLUTION_DETAIL)
    if resolution == "accept_baseline":
        section.locked_parameters = incoming
        return False, True
    return True, False


def _slot_diff(
    section: ProfilePartSection,
    incoming: dict[str, Any],
    printer_model: str | None = None,
) -> list[dict[str, Any]]:
    if not section.locked_parameters:
        return []
    return diff_parameters(section.locked_parameters, incoming, printer_model=printer_model)


def _mismatches_contract(
    section: ProfilePartSection,
    incoming: dict[str, Any],
    printer_model: str | None = None,
) -> bool:
    if not section.locked_parameters:
        return False
    return _has_mismatches(_slot_diff(section, incoming, printer_model=printer_model))


def _slot_view(section: ProfilePartSection, slot: ProfilePartSlot) -> ProfilePartSlotView:
    preset = slot.active_preset
    incoming = _process_parameters(preset) if preset is not None else {}
    rows = _slot_diff(section, incoming, printer_model=slot.printer_model) if preset is not None else []
    preset_summary = None
    if preset is not None:
        printer = _preset_printer_model(preset)
        preset_summary = ProfilePartPresetSummary(
            id=preset.id,
            name=preset.name,
            printer_model=printer,
            locked_parameters=incoming or None,
        )
    return ProfilePartSlotView(
        id=slot.id,
        printer_model=slot.printer_model,
        last_mismatch=bool(slot.last_mismatch),
        spec_status="mismatch" if slot.last_mismatch else "match",
        parameter_diff=[ProductionParameterDiff(**row) for row in rows],
        parameter_overrides=slot.parameter_overrides,
        preset=preset_summary,
    )


def _section_view(section: ProfilePartSection) -> ProfilePartSectionView:
    slots = sorted(section.slots, key=lambda s: (s.printer_model, s.id or 0))
    return ProfilePartSectionView(
        id=section.id,
        name=section.name,
        locked_parameters=section.locked_parameters,
        created_at=section.created_at,
        updated_at=section.updated_at,
        slots=[_slot_view(section, slot) for slot in slots],
    )


def _normalize_section_name(name: str) -> str:
    cleaned = (name or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Section name is required")
    if len(cleaned) > 255:
        raise HTTPException(status_code=400, detail="Section name is too long")
    return cleaned


async def _load_section(db: AsyncSession, section_id: int) -> ProfilePartSection:
    section = (
        await db.execute(
            select(ProfilePartSection)
            .where(ProfilePartSection.id == section_id)
            .options(
                selectinload(ProfilePartSection.slots).options(
                    selectinload(ProfilePartSlot.active_preset),
                    selectinload(ProfilePartSlot.revisions),
                )
            )
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if section is None:
        raise HTTPException(status_code=404, detail="Part section not found")
    return section


async def _load_slot(db: AsyncSession, slot_id: int) -> ProfilePartSlot:
    slot = (
        await db.execute(
            select(ProfilePartSlot)
            .where(ProfilePartSlot.id == slot_id)
            .options(
                selectinload(ProfilePartSlot.active_preset),
                selectinload(ProfilePartSlot.section)
                .selectinload(ProfilePartSection.slots)
                .selectinload(ProfilePartSlot.active_preset),
                selectinload(ProfilePartSlot.revisions),
            )
        )
    ).scalar_one_or_none()
    if slot is None:
        raise HTTPException(status_code=404, detail="Part slot not found")
    return slot


async def _load_process_preset(db: AsyncSession, preset_id: int) -> LocalPreset:
    preset = (await db.execute(select(LocalPreset).where(LocalPreset.id == preset_id))).scalar_one_or_none()
    if preset is None:
        raise HTTPException(status_code=404, detail="Local preset not found")
    if preset.preset_type != "process":
        raise HTTPException(status_code=400, detail=_NOT_PROCESS_DETAIL)
    return preset


async def _refresh_section_mismatches(section: ProfilePartSection) -> None:
    """Recompute last_mismatch for every slot against the current baseline."""
    for slot in section.slots:
        if slot.active_preset is None:
            slot.last_mismatch = False
            continue
        incoming = _process_parameters(slot.active_preset)
        slot.last_mismatch = _has_mismatches(
            _slot_diff(section, incoming, printer_model=slot.printer_model)
        )


def _printers_compatible(slot_printer: str, incoming_printer: str) -> bool:
    if slot_printer == incoming_printer:
        return True
    # Unknown incoming may attach to a known slot; two unknowns never match.
    return is_unknown_printer(incoming_printer) and not is_unknown_printer(slot_printer)


def _replace_preview(section: ProfilePartSection, preset: LocalPreset) -> ProfilePartReplacePreview:
    incoming = _process_parameters(preset)
    printer_model = _preset_printer_model(preset)
    rows = (
        _slot_diff(section, incoming, printer_model=printer_model) if section.locked_parameters else []
    )
    return ProfilePartReplacePreview(
        parameter_diff=[ProductionParameterDiff(**row) for row in rows],
        has_mismatches=_has_mismatches(rows),
        incoming_parameters=incoming,
        printer_model=printer_model,
    )


async def _attach_new_slot(
    db: AsyncSession,
    section: ProfilePartSection,
    preset: LocalPreset,
    resolution: str | None = None,
) -> ProfilePartSlot:
    """Create a printer slot. First process seeds the section contract."""
    incoming = _process_parameters(preset)
    printer_model = _preset_printer_model(preset)
    mismatch, accepted_new_baseline = _apply_shared_contract(
        section, incoming, resolution=resolution, printer_model=printer_model
    )
    slot = ProfilePartSlot(
        section_id=section.id,
        printer_model=printer_model,
        active_preset_id=preset.id,
        last_mismatch=mismatch,
    )
    db.add(slot)
    await db.flush()
    slot.active_preset = preset
    db.add(
        ProfilePartRevision(
            slot_id=slot.id,
            local_preset_id=preset.id,
            parameters=incoming,
            mismatch=mismatch,
            accepted_new_baseline=accepted_new_baseline,
        )
    )
    return slot


@router.get("/sections", response_model=list[ProfilePartSectionView])
async def list_sections(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
    db: AsyncSession = Depends(get_db),
):
    """List all part sections with nested printer slots and contract diffs."""
    sections = (
        (
            await db.execute(
                select(ProfilePartSection)
                .options(selectinload(ProfilePartSection.slots).selectinload(ProfilePartSlot.active_preset))
                .order_by(ProfilePartSection.id)
            )
        )
        .scalars()
        .all()
    )
    return [_section_view(section) for section in sections]


@router.post("/sections", response_model=ProfilePartSectionView)
async def create_section(
    body: ProfilePartSectionCreate,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Create an empty user-named part section. Does not seed TOP/KNB/BOT."""
    section = ProfilePartSection(name=_normalize_section_name(body.name), locked_parameters=None)
    db.add(section)
    await db.flush()
    await db.refresh(section)
    return ProfilePartSectionView(
        id=section.id,
        name=section.name,
        locked_parameters=None,
        created_at=section.created_at,
        updated_at=section.updated_at,
        slots=[],
    )


@router.post("/sections/{section_id}/import", response_model=ProfilePartImportResponse)
async def import_into_section(
    section_id: int,
    file: UploadFile = File(...),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Import a process file and attach it to this section.

    Duplicate library names update the existing row (not skip). An occupied
    printer slot returns ``needs_replace`` instead of a second slot. A new
    printer that mismatches the section baseline returns ``needs_confirm``
    and is not attached until the client posts the slot with ``resolution='proceed'``.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    section = await _load_section(db, section_id)
    result = await import_orca_file(file.filename, content, db, on_duplicate="update")
    await db.flush()

    imported_presets: list[LocalPreset] = result.get("presets") or []
    process_presets = [preset for preset in imported_presets if preset.preset_type == "process"]
    if not process_presets:
        errors = result.get("errors") or []
        raise HTTPException(status_code=400, detail=errors[0] if errors else _NOT_PROCESS_FILE_DETAIL)

    attached: list[ProfilePartImportAttached] = []
    needs_replace: list[ProfilePartImportNeedsReplace] = []
    needs_confirm: list[ProfilePartImportNeedsConfirm] = []

    for preset in process_presets:
        printer_model = _preset_printer_model(preset)
        incoming = _process_parameters(preset)
        existing = next((slot for slot in section.slots if slot.printer_model == printer_model), None)
        if existing is not None:
            needs_replace.append(
                ProfilePartImportNeedsReplace(
                    printer_model=printer_model,
                    preset_id=preset.id,
                    preset_name=preset.name,
                    existing_slot_id=existing.id,
                    preview=_replace_preview(section, preset),
                )
            )
            continue
        if _mismatches_contract(section, incoming, printer_model=printer_model):
            needs_confirm.append(
                ProfilePartImportNeedsConfirm(
                    printer_model=printer_model,
                    preset_id=preset.id,
                    preset_name=preset.name,
                    preview=_replace_preview(section, preset),
                )
            )
            continue
        slot = await _attach_new_slot(db, section, preset)
        section.slots.append(slot)
        slot_view = _slot_view(section, slot)
        attached.append(
            ProfilePartImportAttached(
                slot=slot_view,
                spec_status=slot_view.spec_status,
                parameter_diff=slot_view.parameter_diff,
            )
        )

    await db.flush()
    section = await _load_section(db, section_id)
    errors = result.get("errors") or []
    imported = int(result.get("imported") or 0)
    skipped = int(result.get("skipped") or 0)
    return ProfilePartImportResponse(
        success=bool(attached or needs_replace or needs_confirm or imported > 0),
        imported=imported,
        skipped=skipped,
        errors=errors,
        attached=attached,
        needs_replace=needs_replace,
        needs_confirm=needs_confirm,
        section=_section_view(section),
    )


@router.delete("/sections/{section_id}")
async def delete_section(
    section_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Delete a part section and its slots."""
    section = await _load_section(db, section_id)
    await db.delete(section)
    return {"success": True}


@router.post("/slots", response_model=ProfilePartSectionView)
async def add_slot(
    body: ProfilePartSlotCreate,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Attach an existing process preset. First process seeds the section contract."""
    section = await _load_section(db, body.section_id)
    preset = await _load_process_preset(db, body.preset_id)
    printer_model = _preset_printer_model(preset)
    incoming = _process_parameters(preset)

    existing = next((slot for slot in section.slots if slot.printer_model == printer_model), None)
    if existing is not None:
        raise HTTPException(status_code=409, detail=_SLOT_EXISTS_DETAIL)
    if _mismatches_contract(section, incoming, printer_model=printer_model) and body.resolution != "proceed":
        raise HTTPException(status_code=409, detail=_MISMATCH_CONFIRM_DETAIL)

    await _attach_new_slot(db, section, preset, resolution=body.resolution)
    await db.flush()
    section = await _load_section(db, section.id)
    return _section_view(section)


@router.post("/sections/{section_id}/preview-add", response_model=ProfilePartReplacePreview)
async def preview_add(
    section_id: int,
    body: ProfilePartPreviewReplaceRequest,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
    db: AsyncSession = Depends(get_db),
):
    """Compare an incoming process to the section baseline without attaching."""
    section = await _load_section(db, section_id)
    preset = await _load_process_preset(db, body.preset_id)
    printer_model = _preset_printer_model(preset)
    existing = next((slot for slot in section.slots if slot.printer_model == printer_model), None)
    if existing is not None:
        raise HTTPException(status_code=409, detail=_SLOT_EXISTS_DETAIL)
    return _replace_preview(section, preset)


@router.post("/slots/{slot_id}/preview-replace", response_model=ProfilePartReplacePreview)
async def preview_replace(
    slot_id: int,
    body: ProfilePartPreviewReplaceRequest,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
    db: AsyncSession = Depends(get_db),
):
    """Compare an incoming process preset to the section baseline. Does not persist."""
    slot = await _load_slot(db, slot_id)
    preset = await _load_process_preset(db, body.preset_id)
    printer_model = _preset_printer_model(preset)
    if not _printers_compatible(slot.printer_model, printer_model) and not is_unknown_printer(slot.printer_model):
        raise HTTPException(status_code=400, detail=_PRINTER_MISMATCH_DETAIL)
    return _replace_preview(slot.section, preset)


@router.post("/slots/{slot_id}/replace", response_model=ProfilePartSectionView)
async def replace_slot(
    slot_id: int,
    body: ProfilePartReplaceRequest,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Replace the process in a slot. Proceed keeps baseline; accept_baseline updates it."""
    if body.resolution not in _VALID_RESOLUTIONS:
        raise HTTPException(status_code=400, detail="resolution must be 'proceed' or 'accept_baseline'")

    slot = await _load_slot(db, slot_id)
    preset = await _load_process_preset(db, body.preset_id)
    incoming_printer = _preset_printer_model(preset)
    if not _printers_compatible(slot.printer_model, incoming_printer) and not is_unknown_printer(slot.printer_model):
        raise HTTPException(status_code=400, detail=_PRINTER_MISMATCH_DETAIL)

    incoming = _process_parameters(preset)
    section = slot.section
    mismatch, accepted_new_baseline = _apply_shared_contract(
        section, incoming, body.resolution, printer_model=incoming_printer
    )

    slot.active_preset_id = preset.id
    slot.active_preset = preset
    slot.last_mismatch = mismatch
    if is_unknown_printer(slot.printer_model) and not is_unknown_printer(incoming_printer):
        collision = next(
            (other for other in section.slots if other.id != slot.id and other.printer_model == incoming_printer),
            None,
        )
        if collision is None:
            slot.printer_model = incoming_printer

    db.add(
        ProfilePartRevision(
            slot_id=slot.id,
            local_preset_id=preset.id,
            parameters=incoming,
            mismatch=mismatch,
            accepted_new_baseline=accepted_new_baseline,
            reason=body.reason,
        )
    )
    if accepted_new_baseline:
        await _refresh_section_mismatches(section)
    await db.flush()
    section = await _load_section(db, section.id)
    return _section_view(section)


@router.delete("/slots/{slot_id}", response_model=ProfilePartSectionView)
async def delete_slot(
    slot_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Remove a printer slot. Clearing the last slot also clears the section baseline."""
    slot = await _load_slot(db, slot_id)
    section_id = slot.section_id
    section = slot.section
    remaining = [other for other in section.slots if other.id != slot.id]
    await db.delete(slot)
    await db.flush()
    if not remaining:
        section.locked_parameters = None
        await db.flush()
    section = await _load_section(db, section_id)
    return _section_view(section)
