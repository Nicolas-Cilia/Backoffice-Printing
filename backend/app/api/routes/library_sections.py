"""Library folder-picker section catalog endpoints (folder-sections feature).

Sections are a purely organizational layer over top-level library folders —
each folder optionally belongs to at most one section via
``LibraryFolder.section_id``, grouping folder cards under a named header on
the File Manager's folder-picker landing grid. The catalog is global (one
set per install), mirroring the ``LibraryTag`` catalog in ``library_tags.py``
— no per-user partitioning, since sections are shared organizational
structure rather than user data.

Design decisions:

* Sections only affect the *display* of root-level folders — a folder's
  ``section_id`` is stored regardless of nesting depth, but the frontend only
  exposes the "Move to section" action on root-level folder cards and only
  groups the top-level landing grid by section.
* Deleting a section never deletes its folders. ``delete_section`` clears
  ``section_id`` on every member folder (an explicit ``UPDATE``, since this
  app doesn't enable SQLite's ``PRAGMA foreign_keys`` and so can't rely on the
  ``ON DELETE SET NULL`` DDL hint being enforced by the database itself)
  before deleting the section row, so folders fall back to the "Ungrouped"
  bucket instead of disappearing.
* New sections are appended after every existing one (``sort_order`` =
  current max + 1) so creating a section never reorders existing ones.

Permission model mirrors folder rename/link in ``library.py``: folders (and
section membership) have no ownership tracking, so every mutation requires
``Permission.LIBRARY_UPDATE_ALL``. Listing follows the same read-pair used
elsewhere in the library API.
"""

from __future__ import annotations

import logging
import uuid
import zipfile
from datetime import datetime, timezone
from io import BytesIO

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.library import get_library_thumbnails_dir, to_absolute_path, to_relative_path
from backend.app.api.routes.production import (
    _diff_models,
    _has_mismatches,
    _normalize_part_identity,
    _refresh_section_part_mismatches,
)
from backend.app.core.auth import (
    RequireCameraStreamTokenIfAuthEnabled,
    require_any_permission_if_auth_enabled,
    require_ownership_permission,
    require_permission_if_auth_enabled,
)
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.library import LibraryFolder, LibraryFolderSection, LibrarySectionPart
from backend.app.models.production import ProductionPart, ProductionPartInstance
from backend.app.models.user import User
from backend.app.schemas.library import (
    FolderSectionCreate,
    FolderSectionResponse,
    FolderSectionUpdate,
    SectionPartCreate,
    SectionPartReorder,
    SectionPartResponse,
    SectionPartUpdate,
)
from backend.app.schemas.production import SectionPartParameterPreview
from backend.app.services.production_bootstrap import get_or_create_part, next_section_part_sort_order
from backend.app.services.production_settings import diff_parameters, extract_production_settings

router = APIRouter(prefix="/library/sections", tags=["library-sections"])

_REPLACE_RESOLUTION_DETAIL = (
    "This part already has a print-settings contract. Pass resolution 'accept_baseline' to replace it."
)
_EMPTY_SETTINGS_DETAIL = "Could not extract print settings from file"
_THUMBNAIL_CANDIDATES = (
    "Metadata/plate_1.png",
    "Metadata/thumbnail.png",
    "Metadata/model_thumbnail.png",
    "Auxiliaries/.thumbnails/thumbnail_middle.png",
    "Auxiliaries/.thumbnails/thumbnail_small.png",
    "Auxiliaries/.thumbnails/thumbnail_3mf.png",
)

logger = logging.getLogger(__name__)


def _name_key(name: str) -> str:
    """Case-insensitive uniqueness key — LOWER(TRIM(name)). Mirrors the same
    convention used by Locations (#1505) and library tags (#1268)."""
    return name.strip().lower()


async def _to_response(db: AsyncSession, section: LibraryFolderSection) -> FolderSectionResponse:
    count = (
        await db.execute(select(func.count(LibraryFolder.id)).where(LibraryFolder.section_id == section.id))
    ).scalar_one()
    return FolderSectionResponse(
        id=section.id,
        name=section.name,
        sort_order=section.sort_order,
        folder_count=int(count or 0),
        kind=section.kind or "normal",
        created_at=section.created_at,
        updated_at=section.updated_at,
    )


@router.get("", response_model=list[FolderSectionResponse])
@router.get("/", response_model=list[FolderSectionResponse])
async def list_sections(
    db: AsyncSession = Depends(get_db),
    _: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.LIBRARY_READ_ALL,
            Permission.LIBRARY_READ_OWN,
        )
    ),
) -> list[FolderSectionResponse]:
    """List every section ordered for the folder-picker grid (sort_order, then name)."""
    rows = (
        (
            await db.execute(
                select(LibraryFolderSection).order_by(LibraryFolderSection.sort_order, LibraryFolderSection.name)
            )
        )
        .scalars()
        .all()
    )
    return [await _to_response(db, s) for s in rows]


@router.post("", response_model=FolderSectionResponse, status_code=201)
@router.post("/", response_model=FolderSectionResponse, status_code=201)
async def create_section(
    payload: FolderSectionCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPDATE_ALL)),
) -> FolderSectionResponse:
    """Create a section. New sections sort after every existing one. Case-insensitive dup -> 409."""
    max_order = (await db.execute(select(func.max(LibraryFolderSection.sort_order)))).scalar_one()
    section = LibraryFolderSection(
        name=payload.name.strip(),
        name_key=_name_key(payload.name),
        sort_order=(max_order or 0) + 1,
        kind=payload.kind,
    )
    db.add(section)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Section with this name already exists") from None
    await db.refresh(section)
    return await _to_response(db, section)


@router.patch("/{section_id}", response_model=FolderSectionResponse)
async def rename_section(
    section_id: int,
    payload: FolderSectionUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPDATE_ALL)),
) -> FolderSectionResponse:
    """Rename a section. Case-insensitive dup -> 409 (own-name no-op is allowed). Folder membership is untouched."""
    section = (
        await db.execute(select(LibraryFolderSection).where(LibraryFolderSection.id == section_id))
    ).scalar_one_or_none()
    if section is None:
        raise HTTPException(status_code=404, detail="Section not found")

    new_key = _name_key(payload.name)
    if new_key != section.name_key:
        # Pre-check so the caller gets a clean 409 instead of an
        # IntegrityError we'd have to translate. The post-commit
        # IntegrityError branch below still catches the concurrent-create
        # race.
        existing = (
            await db.execute(select(LibraryFolderSection).where(LibraryFolderSection.name_key == new_key))
        ).scalar_one_or_none()
        if existing is not None and existing.id != section.id:
            raise HTTPException(status_code=409, detail="Section with this name already exists")
    section.name = payload.name.strip()
    section.name_key = new_key
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Section with this name already exists") from None
    await db.refresh(section)
    return await _to_response(db, section)


# response_model=None is load-bearing under `from __future__ import annotations`
# — see the identical comment on `library_tags.delete_tag` for why.
@router.delete("/{section_id}", status_code=204, response_model=None)
async def delete_section(
    section_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPDATE_ALL)),
) -> None:
    """Delete a section. Member folders are ungrouped (section_id -> NULL), never deleted."""
    section = (
        await db.execute(select(LibraryFolderSection).where(LibraryFolderSection.id == section_id))
    ).scalar_one_or_none()
    if section is None:
        raise HTTPException(status_code=404, detail="Section not found")
    await db.execute(update(LibraryFolder).where(LibraryFolder.section_id == section_id).values(section_id=None))
    await db.delete(section)
    await db.commit()


async def _load_section(db: AsyncSession, section_id: int) -> LibraryFolderSection:
    section = (
        await db.execute(select(LibraryFolderSection).where(LibraryFolderSection.id == section_id))
    ).scalar_one_or_none()
    if section is None:
        raise HTTPException(status_code=404, detail="Section not found")
    return section


async def _load_section_part(db: AsyncSession, section_id: int, part_id: int) -> LibrarySectionPart:
    part = (
        await db.execute(
            select(LibrarySectionPart).where(
                LibrarySectionPart.id == part_id,
                LibrarySectionPart.section_id == section_id,
            )
        )
    ).scalar_one_or_none()
    if part is None:
        raise HTTPException(status_code=404, detail="Part not found")
    return part


async def _instance_count(db: AsyncSession, part: LibrarySectionPart) -> int:
    count = (
        await db.execute(
            select(func.count(ProductionPartInstance.id))
            .join(ProductionPart, ProductionPartInstance.part_id == ProductionPart.id)
            .join(LibraryFolder, ProductionPartInstance.folder_id == LibraryFolder.id)
            .where(
                LibraryFolder.section_id == part.section_id,
                ProductionPart.code == part.code,
                ProductionPartInstance.hidden.is_(False),
            )
        )
    ).scalar_one()
    return int(count or 0)


async def _part_to_response(db: AsyncSession, part: LibrarySectionPart) -> SectionPartResponse:
    return SectionPartResponse(
        id=part.id,
        section_id=part.section_id,
        code=part.code,
        name=part.name,
        locked_parameters=part.locked_parameters,
        has_thumbnail=bool(part.thumbnail_path),
        instance_count=await _instance_count(db, part),
        sort_order=part.sort_order,
        created_at=part.created_at,
        updated_at=part.updated_at,
    )


@router.get("/{section_id}/parts", response_model=list[SectionPartResponse])
async def list_section_parts(
    section_id: int,
    db: AsyncSession = Depends(get_db),
    _: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.LIBRARY_READ_ALL,
            Permission.LIBRARY_READ_OWN,
        )
    ),
) -> list[SectionPartResponse]:
    """List section-level part templates for one folder-picker section."""
    await _load_section(db, section_id)
    rows = (
        (
            await db.execute(
                select(LibrarySectionPart)
                .where(LibrarySectionPart.section_id == section_id)
                .order_by(LibrarySectionPart.sort_order, LibrarySectionPart.code)
            )
        )
        .scalars()
        .all()
    )
    return [await _part_to_response(db, part) for part in rows]


@router.post("/{section_id}/parts", response_model=SectionPartResponse, status_code=201)
async def create_section_part(
    section_id: int,
    payload: SectionPartCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPDATE_ALL)),
) -> SectionPartResponse:
    """Create a section-level part template. Duplicate code in the section -> 409."""
    await _load_section(db, section_id)
    code, name = _normalize_part_identity(payload.code, payload.name)
    await get_or_create_part(db, code, name)
    part = LibrarySectionPart(
        section_id=section_id,
        code=code,
        name=name,
        locked_parameters=None,
        sort_order=await next_section_part_sort_order(db, section_id),
    )
    db.add(part)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Part with this code already exists in this section",
        ) from None
    await db.refresh(part)
    return await _part_to_response(db, part)


@router.put("/{section_id}/parts/reorder", response_model=list[SectionPartResponse])
async def reorder_section_parts(
    section_id: int,
    payload: SectionPartReorder,
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPDATE_ALL)),
) -> list[SectionPartResponse]:
    """Set the popup/grid order for every part template in this section."""
    await _load_section(db, section_id)
    rows = (
        (await db.execute(select(LibrarySectionPart).where(LibrarySectionPart.section_id == section_id)))
        .scalars()
        .all()
    )
    by_id = {part.id: part for part in rows}
    if len(payload.ids) != len(set(payload.ids)):
        raise HTTPException(status_code=400, detail="Part ids must be unique")
    if set(payload.ids) != set(by_id):
        raise HTTPException(status_code=400, detail="ids must include every part in this section exactly once")
    for index, part_id in enumerate(payload.ids):
        by_id[part_id].sort_order = index
    await db.commit()
    ordered = [by_id[part_id] for part_id in payload.ids]
    for part in ordered:
        await db.refresh(part)
    return [await _part_to_response(db, part) for part in ordered]


@router.patch("/{section_id}/parts/{part_id}", response_model=SectionPartResponse)
async def update_section_part(
    section_id: int,
    part_id: int,
    payload: SectionPartUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPDATE_ALL)),
) -> SectionPartResponse:
    """Rename a section-level part template. Folder instances are untouched."""
    part = await _load_section_part(db, section_id, part_id)
    cleaned = payload.name.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Part name is required")
    if len(cleaned) > 255:
        raise HTTPException(status_code=400, detail="Part name is too long")
    part.name = cleaned
    await db.commit()
    await db.refresh(part)
    return await _part_to_response(db, part)


@router.delete("/{section_id}/parts/{part_id}", status_code=204, response_model=None)
async def delete_section_part(
    section_id: int,
    part_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPDATE_ALL)),
) -> None:
    """Delete the template only. Folder instances and files are kept."""
    part = await _load_section_part(db, section_id, part_id)
    _delete_thumbnail_file(part.thumbnail_path)
    await db.delete(part)
    await db.commit()


async def _extract_upload_settings(file: UploadFile) -> dict:
    content = await file.read()
    settings = extract_production_settings(content)
    if not settings:
        raise HTTPException(status_code=400, detail=_EMPTY_SETTINGS_DETAIL)
    return settings


def _extract_3mf_thumbnail(content: bytes) -> bytes | None:
    try:
        with zipfile.ZipFile(BytesIO(content), "r") as archive:
            names = set(archive.namelist())
            for path in _THUMBNAIL_CANDIDATES:
                if path in names:
                    return archive.read(path)
    except (OSError, zipfile.BadZipFile):
        return None
    return None


def _delete_thumbnail_file(relative_path: str | None) -> None:
    if not relative_path:
        return
    try:
        abs_path = to_absolute_path(relative_path)
    except ValueError:
        return
    if abs_path is None or not abs_path.is_file():
        return
    try:
        abs_path.unlink()
    except OSError as exc:
        logger.warning("Failed to delete section-part thumbnail: %s", exc)


def _store_thumbnail(part: LibrarySectionPart, content: bytes) -> None:
    data = _extract_3mf_thumbnail(content)
    _delete_thumbnail_file(part.thumbnail_path)
    if not data:
        part.thumbnail_path = None
        return
    thumb_path = get_library_thumbnails_dir() / f"section-part-{uuid.uuid4().hex}.png"
    thumb_path.write_bytes(data)
    part.thumbnail_path = to_relative_path(thumb_path)


@router.post("/{section_id}/parts/{part_id}/parameters/preview", response_model=SectionPartParameterPreview)
async def preview_section_part_parameters(
    section_id: int,
    part_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.LIBRARY_READ_ALL,
            Permission.LIBRARY_READ_OWN,
        )
    ),
) -> SectionPartParameterPreview:
    """Compare an incoming 3MF against the section part contract without saving."""
    part = await _load_section_part(db, section_id, part_id)
    incoming = await _extract_upload_settings(file)
    if not part.locked_parameters:
        return SectionPartParameterPreview(
            parameter_diff=[],
            has_mismatches=False,
            has_existing_contract=False,
        )
    diff = diff_parameters(part.locked_parameters, incoming)
    return SectionPartParameterPreview(
        parameter_diff=_diff_models(diff),
        has_mismatches=_has_mismatches(diff),
        has_existing_contract=True,
    )


@router.post("/{section_id}/parts/{part_id}/parameters", response_model=SectionPartResponse)
async def seed_section_part_parameters(
    section_id: int,
    part_id: int,
    file: UploadFile = File(...),
    resolution: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(
        require_any_permission_if_auth_enabled(Permission.LIBRARY_UPLOAD, Permission.LIBRARY_UPDATE_ALL)
    ),
) -> SectionPartResponse:
    """Set or replace the section part's print-settings contract from a 3MF.

    The file is not stored. The first upload seeds the contract. Later uploads
    require ``resolution='accept_baseline'`` and re-check folder instances
    against the new spec.
    """
    part = await _load_section_part(db, section_id, part_id)
    content = await file.read()
    settings = extract_production_settings(content)
    if not settings:
        raise HTTPException(status_code=400, detail=_EMPTY_SETTINGS_DETAIL)
    replacing = bool(part.locked_parameters)
    if replacing and resolution != "accept_baseline":
        raise HTTPException(status_code=400, detail=_REPLACE_RESOLUTION_DETAIL)
    part.locked_parameters = settings
    _store_thumbnail(part, content)
    part.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await get_or_create_part(db, part.code, part.name)
    if replacing:
        await _refresh_section_part_mismatches(db, part)
    await db.commit()
    await db.refresh(part)
    return await _part_to_response(db, part)


@router.get("/{section_id}/parts/{part_id}/thumbnail")
async def get_section_part_thumbnail(
    section_id: int,
    part_id: int,
    db: AsyncSession = Depends(get_db),
    _: None = RequireCameraStreamTokenIfAuthEnabled,
):
    """Serve the 3MF cover image stored for a section part template."""
    part = await _load_section_part(db, section_id, part_id)
    abs_thumb_path = to_absolute_path(part.thumbnail_path)
    if abs_thumb_path is None or not abs_thumb_path.is_file():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(
        str(abs_thumb_path),
        media_type="image/png",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )
