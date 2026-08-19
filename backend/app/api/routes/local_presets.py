"""API routes for local slicer presets (imported from OrcaSlicer, etc.)."""

import json
import logging
import re

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.local_preset import LocalPreset
from backend.app.models.user import User
from backend.app.schemas.local_preset import (
    ImportResponse,
    LocalPresetCreate,
    LocalPresetDetail,
    LocalPresetResponse,
    LocalPresetsResponse,
    LocalPresetUpdate,
)
from backend.app.services.orca_profiles import (
    extract_core_fields,
    get_cache_status,
    import_orca_file,
    maybe_correct_local_preset_source,
    reclassify_presets,
    refresh_base_cache,
    resolve_preset,
)
from backend.app.services.production_settings import extract_from_process_settings
from backend.app.utils.http import build_content_disposition

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/local-presets", tags=["Local Presets"])

_UNSAFE_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')


def _download_filename(name: str) -> str:
    """Build a filesystem-safe `{name}.json` download filename from a preset name."""
    base = _UNSAFE_FILENAME_RE.sub("_", name or "")
    base = re.sub(r"_+", "_", base).strip(" ._")
    if base.lower().endswith(".json"):
        base = base[:-5].rstrip(" ._")
    if not base:
        base = "preset"
    if len(base) > 180:
        base = base[:180].rstrip(" ._") or "preset"
    return f"{base}.json"


def _locked_parameters_from_setting(setting: str | None) -> dict | None:
    """Compact production contract from a process preset's resolved JSON."""
    if not setting:
        return None
    try:
        config = json.loads(setting)
    except (ValueError, TypeError):
        return None
    if not isinstance(config, dict):
        return None
    return extract_from_process_settings(config)


def _to_response(preset: LocalPreset) -> LocalPresetResponse:
    maybe_correct_local_preset_source(preset)
    resp = LocalPresetResponse.model_validate(preset)
    if preset.preset_type != "process":
        return resp
    return resp.model_copy(update={"locked_parameters": _locked_parameters_from_setting(preset.setting)})


@router.get("/", response_model=LocalPresetsResponse)
async def list_local_presets(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
    db: AsyncSession = Depends(get_db),
):
    """List all local presets grouped by type."""
    result = await db.execute(select(LocalPreset).order_by(LocalPreset.name))
    presets = result.scalars().all()

    grouped = LocalPresetsResponse()
    for p in presets:
        resp = _to_response(p)
        if p.preset_type == "filament":
            grouped.filament.append(resp)
        elif p.preset_type == "printer":
            grouped.printer.append(resp)
        elif p.preset_type == "process":
            grouped.process.append(resp)

    return grouped


@router.get("/{preset_id}", response_model=LocalPresetDetail)
async def get_local_preset(
    preset_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
    db: AsyncSession = Depends(get_db),
):
    """Get full detail for a local preset including the setting JSON."""
    result = await db.execute(select(LocalPreset).where(LocalPreset.id == preset_id))
    preset = result.scalar_one_or_none()
    if not preset:
        raise HTTPException(404, "Local preset not found")

    data = _to_response(preset).model_dump()
    try:
        data["setting"] = json.loads(preset.setting)
    except Exception:
        data["setting"] = {}

    return LocalPresetDetail(**data)


@router.get("/{preset_id}/download")
async def download_local_preset(
    preset_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
    db: AsyncSession = Depends(get_db),
):
    """Download the stored resolved setting JSON so it can be re-imported."""
    result = await db.execute(select(LocalPreset).where(LocalPreset.id == preset_id))
    preset = result.scalar_one_or_none()
    if not preset:
        raise HTTPException(404, "Local preset not found")

    try:
        parsed = json.loads(preset.setting)
    except (ValueError, TypeError):
        raise HTTPException(500, "Preset setting is not valid JSON") from None
    if not isinstance(parsed, dict):
        raise HTTPException(500, "Preset setting is not a JSON object")

    body = json.dumps(parsed, indent=2, ensure_ascii=False) + "\n"
    filename = _download_filename(preset.name)
    return Response(
        content=body.encode("utf-8"),
        media_type="application/json",
        headers={"Content-Disposition": build_content_disposition(filename)},
    )


@router.post("/import", response_model=ImportResponse)
async def import_presets(
    file: UploadFile,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Import presets from an OrcaSlicer export file (.json, .orca_filament, .bbscfg, .bbsflmt, .zip)."""
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    content = await file.read()
    if not content:
        raise HTTPException(400, "Empty file")

    result = await import_orca_file(file.filename, content, db)
    return ImportResponse(
        success=result["success"],
        imported=result["imported"],
        skipped=result["skipped"],
        errors=result["errors"],
    )


@router.post("/", response_model=LocalPresetResponse)
async def create_local_preset(
    data: LocalPresetCreate,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Manually create a local preset."""
    if data.preset_type not in ("filament", "printer", "process"):
        raise HTTPException(400, "preset_type must be filament, printer, or process")

    # Extract core fields
    core = extract_core_fields(data.setting)

    preset = LocalPreset(
        name=data.name,
        preset_type=data.preset_type,
        source="manual",
        setting=json.dumps(data.setting),
        **core,
    )
    db.add(preset)
    await db.flush()
    await db.refresh(preset)
    return _to_response(preset)


@router.put("/{preset_id}", response_model=LocalPresetResponse)
async def update_local_preset(
    preset_id: int,
    data: LocalPresetUpdate,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Update a local preset's name or settings."""
    result = await db.execute(select(LocalPreset).where(LocalPreset.id == preset_id))
    preset = result.scalar_one_or_none()
    if not preset:
        raise HTTPException(404, "Local preset not found")

    if data.name is not None:
        preset.name = data.name

    if data.setting is not None:
        # Re-resolve and extract core fields
        resolved = await resolve_preset(data.setting, preset.preset_type, db)
        core = extract_core_fields(resolved)
        preset.setting = json.dumps(resolved)
        preset.filament_type = core.get("filament_type")
        preset.filament_vendor = core.get("filament_vendor")
        preset.nozzle_temp_min = core.get("nozzle_temp_min")
        preset.nozzle_temp_max = core.get("nozzle_temp_max")
        preset.pressure_advance = core.get("pressure_advance")
        preset.default_filament_colour = core.get("default_filament_colour")
        preset.filament_cost = core.get("filament_cost")
        preset.filament_density = core.get("filament_density")
        preset.compatible_printers = core.get("compatible_printers")

    await db.flush()
    await db.refresh(preset)
    return _to_response(preset)


@router.delete("/{preset_id}")
async def delete_local_preset(
    preset_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Delete a local preset."""
    result = await db.execute(select(LocalPreset).where(LocalPreset.id == preset_id))
    preset = result.scalar_one_or_none()
    if not preset:
        raise HTTPException(404, "Local preset not found")

    await db.delete(preset)
    return {"success": True}


@router.get("/base-cache/status")
async def base_cache_status(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
    db: AsyncSession = Depends(get_db),
):
    """Get the status of the OrcaSlicer base profile cache."""
    return await get_cache_status(db)


@router.post("/base-cache/refresh")
async def refresh_cache(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Force refresh all cached base profiles from GitHub."""
    return await refresh_base_cache(db)


@router.post("/reclassify")
async def reclassify(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    """Re-evaluate preset types for all local presets using the improved heuristic."""
    return await reclassify_presets(db)
