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

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import require_ownership_permission, require_permission_if_auth_enabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.library import LibraryFolder, LibraryFolderSection
from backend.app.models.user import User
from backend.app.schemas.library import (
    FolderSectionCreate,
    FolderSectionResponse,
    FolderSectionUpdate,
)

router = APIRouter(prefix="/library/sections", tags=["library-sections"])


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
