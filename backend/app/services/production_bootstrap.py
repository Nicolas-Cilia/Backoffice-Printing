"""Idempotent bootstrap for production file-slots: section, printer folders, part catalog."""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.library import SECTION_KIND_PRODUCTION, LibraryFolder, LibraryFolderSection
from backend.app.models.production import (
    DEFAULT_PARTS,
    PRODUCTION_PRINTER_MODELS,
    PRODUCTION_SECTION_NAME,
    ProductionPart,
    ProductionPartInstance,
    default_part_codes_for_printer,
)

PRODUCTION_SECTION_NAME_KEY = PRODUCTION_SECTION_NAME.strip().lower()


@dataclass
class ProductionBootstrapResult:
    """Created-vs-existing counts plus ids for the Production section and printer folders."""

    section_id: int
    section_created: bool
    folder_ids: dict[str, int] = field(default_factory=dict)
    folders_created: int = 0
    folders_existing: int = 0
    parts_created: int = 0
    parts_existing: int = 0


async def bootstrap_production(db: AsyncSession) -> ProductionBootstrapResult:
    """Ensure the Production section, printer folders, and default parts exist.

    Safe to call repeatedly. Existing folders already tagged with a
    ``production_printer_model`` are left alone; a root folder whose name
    already matches a printer model is adopted (section + model assigned)
    rather than duplicated.
    """
    section, section_created = await _ensure_production_section(db)

    folder_ids: dict[str, int] = {}
    folders_created = 0
    folders_existing = 0
    for model in PRODUCTION_PRINTER_MODELS:
        folder, created = await _ensure_printer_folder(db, section.id, model)
        folder_ids[model] = folder.id
        if created:
            folders_created += 1
        else:
            folders_existing += 1

    parts_created = 0
    parts_existing = 0
    parts_by_code: dict[str, ProductionPart] = {}
    for code, name in DEFAULT_PARTS:
        created, part = await _ensure_part(db, code, name)
        parts_by_code[part.code] = part
        if created:
            parts_created += 1
        else:
            parts_existing += 1

    for model, folder_id in folder_ids.items():
        for code in default_part_codes_for_printer(model):
            part = parts_by_code.get(code)
            if part is None:
                continue
            await _ensure_default_instance(db, part, folder_id, model)

    await db.flush()
    return ProductionBootstrapResult(
        section_id=section.id,
        section_created=section_created,
        folder_ids=folder_ids,
        folders_created=folders_created,
        folders_existing=folders_existing,
        parts_created=parts_created,
        parts_existing=parts_existing,
    )


async def _ensure_production_section(db: AsyncSession) -> tuple[LibraryFolderSection, bool]:
    result = await db.execute(
        select(LibraryFolderSection).where(LibraryFolderSection.name_key == PRODUCTION_SECTION_NAME_KEY)
    )
    section = result.scalar_one_or_none()
    if section is not None:
        if section.kind != SECTION_KIND_PRODUCTION:
            section.kind = SECTION_KIND_PRODUCTION
            await db.flush()
        return section, False

    max_order = (await db.execute(select(func.max(LibraryFolderSection.sort_order)))).scalar_one()
    section = LibraryFolderSection(
        name=PRODUCTION_SECTION_NAME,
        name_key=PRODUCTION_SECTION_NAME_KEY,
        sort_order=(max_order or 0) + 1,
        kind=SECTION_KIND_PRODUCTION,
    )
    db.add(section)
    await db.flush()
    return section, True


async def _ensure_printer_folder(db: AsyncSession, section_id: int, model: str) -> tuple[LibraryFolder, bool]:
    tagged = (
        (
            await db.execute(
                select(LibraryFolder).where(LibraryFolder.production_printer_model == model).order_by(LibraryFolder.id)
            )
        )
        .scalars()
        .first()
    )
    if tagged is not None:
        if not tagged.parameter_tracking:
            tagged.parameter_tracking = True
            await db.flush()
        return tagged, False

    named = (
        (
            await db.execute(
                select(LibraryFolder)
                .where(LibraryFolder.parent_id.is_(None), LibraryFolder.name == model)
                .order_by(LibraryFolder.id)
            )
        )
        .scalars()
        .first()
    )
    if named is not None:
        named.section_id = section_id
        named.production_printer_model = model
        named.parameter_tracking = True
        await db.flush()
        return named, False

    folder = LibraryFolder(
        name=model,
        parent_id=None,
        section_id=section_id,
        production_printer_model=model,
        parameter_tracking=True,
    )
    db.add(folder)
    await db.flush()
    return folder, True


async def _ensure_part(db: AsyncSession, code: str, name: str) -> tuple[bool, ProductionPart]:
    stored_code = code.strip().upper()
    existing = (await db.execute(select(ProductionPart).where(ProductionPart.code == stored_code))).scalar_one_or_none()
    if existing is not None:
        return False, existing
    part = ProductionPart(code=stored_code, name=name)
    db.add(part)
    await db.flush()
    return True, part


async def _ensure_default_instance(db: AsyncSession, part: ProductionPart, folder_id: int, printer_model: str) -> None:
    """Create a visible empty instance if this printer has never had this part.

    Does not un-hide a part the user removed from this printer.
    """
    existing = (
        await db.execute(
            select(ProductionPartInstance.id).where(
                ProductionPartInstance.part_id == part.id,
                ProductionPartInstance.printer_model == printer_model,
                ProductionPartInstance.folder_id == folder_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return
    db.add(
        ProductionPartInstance(
            part_id=part.id,
            printer_model=printer_model,
            folder_id=folder_id,
            locked_parameters=None,
            hidden=False,
        )
    )


async def seed_printer_folder_defaults(db: AsyncSession, folder: LibraryFolder) -> None:
    """Ensure catalog parts and default visible instances exist for this printer folder."""
    printer_model = (folder.production_printer_model or "").strip()
    if not printer_model:
        return
    parts_by_code: dict[str, ProductionPart] = {}
    for code, name in DEFAULT_PARTS:
        _, part = await _ensure_part(db, code, name)
        parts_by_code[part.code] = part
    for code in default_part_codes_for_printer(printer_model):
        part = parts_by_code.get(code)
        if part is None:
            continue
        await _ensure_default_instance(db, part, folder.id, printer_model)
