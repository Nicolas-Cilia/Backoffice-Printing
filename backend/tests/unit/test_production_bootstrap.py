"""Unit tests for production file-slots bootstrap (section, printer folders, parts)."""

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.library import LibraryFolder, LibraryFolderSection
from backend.app.models.production import (
    DEFAULT_PARTS,
    PRODUCTION_PRINTER_MODELS,
    PRODUCTION_SECTION_NAME,
    ProductionPart,
)
from backend.app.services.production_bootstrap import bootstrap_production


@pytest.mark.asyncio
async def test_bootstrap_creates_section_folders_and_parts(db_session: AsyncSession):
    result = await bootstrap_production(db_session)
    await db_session.commit()

    assert result.section_created is True
    assert result.folders_created == len(PRODUCTION_PRINTER_MODELS)
    assert result.folders_existing == 0
    assert result.parts_created == len(DEFAULT_PARTS)
    assert result.parts_existing == 0
    assert set(result.folder_ids) == set(PRODUCTION_PRINTER_MODELS)

    section = (
        await db_session.execute(select(LibraryFolderSection).where(LibraryFolderSection.id == result.section_id))
    ).scalar_one()
    assert section.name == PRODUCTION_SECTION_NAME
    assert section.name_key == "production"

    folders = (await db_session.execute(select(LibraryFolder).where(LibraryFolder.parent_id.is_(None)))).scalars().all()
    assert {f.name for f in folders} == set(PRODUCTION_PRINTER_MODELS)
    for folder in folders:
        assert folder.section_id == result.section_id
        assert folder.production_printer_model == folder.name
        assert result.folder_ids[folder.name] == folder.id

    parts = (await db_session.execute(select(ProductionPart))).scalars().all()
    assert {(p.code, p.name) for p in parts} == set(DEFAULT_PARTS)
    assert all(p.code == p.code.upper() for p in parts)


@pytest.mark.asyncio
async def test_bootstrap_is_idempotent(db_session: AsyncSession):
    first = await bootstrap_production(db_session)
    await db_session.commit()

    second = await bootstrap_production(db_session)
    await db_session.commit()

    assert second.section_created is False
    assert second.section_id == first.section_id
    assert second.folder_ids == first.folder_ids
    assert second.folders_created == 0
    assert second.folders_existing == len(PRODUCTION_PRINTER_MODELS)
    assert second.parts_created == 0
    assert second.parts_existing == len(DEFAULT_PARTS)

    section_count = (await db_session.execute(select(func.count()).select_from(LibraryFolderSection))).scalar_one()
    folder_count = (await db_session.execute(select(func.count()).select_from(LibraryFolder))).scalar_one()
    part_count = (await db_session.execute(select(func.count()).select_from(ProductionPart))).scalar_one()
    assert section_count == 1
    assert folder_count == len(PRODUCTION_PRINTER_MODELS)
    assert part_count == len(DEFAULT_PARTS)


@pytest.mark.asyncio
async def test_bootstrap_adopts_existing_root_folder_by_name(db_session: AsyncSession):
    existing = LibraryFolder(name="X1C", parent_id=None)
    db_session.add(existing)
    await db_session.commit()
    await db_session.refresh(existing)

    result = await bootstrap_production(db_session)
    await db_session.commit()

    assert result.folder_ids["X1C"] == existing.id
    assert result.folders_created == len(PRODUCTION_PRINTER_MODELS) - 1
    assert result.folders_existing == 1

    adopted = await db_session.get(LibraryFolder, existing.id)
    assert adopted is not None
    assert adopted.section_id == result.section_id
    assert adopted.production_printer_model == "X1C"

    folder_count = (await db_session.execute(select(func.count()).select_from(LibraryFolder))).scalar_one()
    assert folder_count == len(PRODUCTION_PRINTER_MODELS)


@pytest.mark.asyncio
async def test_bootstrap_leaves_already_tagged_folder_alone(db_session: AsyncSession):
    tagged = LibraryFolder(name="My X1C Folder", parent_id=None, production_printer_model="X1C")
    db_session.add(tagged)
    await db_session.commit()
    await db_session.refresh(tagged)

    result = await bootstrap_production(db_session)
    await db_session.commit()

    assert result.folder_ids["X1C"] == tagged.id
    await db_session.refresh(tagged)
    assert tagged.name == "My X1C Folder"
    assert tagged.production_printer_model == "X1C"
    # Already tagged folders are left as-is, including section membership.
    assert tagged.section_id is None

    x1c_named = (
        await db_session.execute(
            select(LibraryFolder).where(LibraryFolder.parent_id.is_(None), LibraryFolder.name == "X1C")
        )
    ).scalar_one_or_none()
    assert x1c_named is None
