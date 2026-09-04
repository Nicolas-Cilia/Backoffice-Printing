"""Folder-based Stats2 discovery: recipe part codes → files in printer-model folders.

Product model: device recipe says which codes make a device; discovery scans
Production section folders (A1/H2S/X1C/…) for matching ``CODE xQTY - M.R.m - PRINTER``
library files and surfaces them as production slots for capacity / preferred / Gantt.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.production import ProductionPart, ProductionSlot
from backend.app.services.device_recipe_service import (
    discover_slots_for_part_code,
    get_or_create_default_recipe,
    get_recipe_view,
)


async def _seed_production_folder(db, *, model: str, name: str | None = None) -> LibraryFolder:
    folder = LibraryFolder(
        name=name or model,
        parent_id=None,
        production_printer_model=model,
        parameter_tracking=True,
    )
    db.add(folder)
    await db.flush()
    return folder


async def _seed_file(
    db,
    folder: LibraryFolder,
    *,
    filename: str,
    print_time: int | None = 3600,
) -> LibraryFile:
    meta = {}
    if print_time is not None:
        meta["print_time_seconds"] = print_time
    lib = LibraryFile(
        folder_id=folder.id,
        filename=filename,
        file_path=f"library/{folder.name}/{filename}",
        file_type="3mf",
        file_size=100,
        file_metadata=meta or None,
    )
    db.add(lib)
    await db.flush()
    return lib


@pytest.mark.asyncio
async def test_discover_slots_from_printer_model_folder_files(db_session):
    """BOT x5 in the H2S production folder is discovered without a prior slot upload."""
    part = ProductionPart(code="BOT", name="Bottom Housing")
    db_session.add(part)
    folder = await _seed_production_folder(db_session, model="H2S")
    await _seed_file(db_session, folder, filename="BOT x5 - 1.8.2 - H2S.3mf", print_time=7200)
    await db_session.commit()

    slots = await discover_slots_for_part_code(db_session, "BOT")

    assert len(slots) == 1
    s = slots[0]
    assert s["printer_model"] == "H2S"
    assert s["quantity"] == 5
    assert s["filename"] == "BOT x5 - 1.8.2 - H2S.3mf"
    assert s["version"] == "1.8.2"
    assert s["print_time_seconds"] == 7200
    assert s["slot_id"] is not None
    # Persisted as a real ProductionSlot so preferred_slot_id / metrics work.
    row = await db_session.get(ProductionSlot, s["slot_id"])
    assert row is not None
    assert row.quantity == 5
    assert row.active_file_id is not None


@pytest.mark.asyncio
async def test_discover_ignores_other_part_codes_in_same_folder(db_session):
    part = ProductionPart(code="TOP", name="Top Housing")
    db_session.add(part)
    folder = await _seed_production_folder(db_session, model="X1C")
    await _seed_file(db_session, folder, filename="TOP x1 - 1.13.2 - X1C.3mf")
    await _seed_file(db_session, folder, filename="BUT x47 - 1.0.0 - X1C.3mf")
    await db_session.commit()

    slots = await discover_slots_for_part_code(db_session, "TOP")
    assert len(slots) == 1
    assert slots[0]["quantity"] == 1
    assert "TOP" in (slots[0]["filename"] or "")


@pytest.mark.asyncio
async def test_discover_multiple_printer_folders_and_quantities(db_session):
    part = ProductionPart(code="KNB", name="Knob")
    db_session.add(part)
    h2s = await _seed_production_folder(db_session, model="H2S")
    x1c = await _seed_production_folder(db_session, model="X1C")
    await _seed_file(db_session, h2s, filename="KNB x12 - 1.0.0 - H2S.3mf")
    await _seed_file(db_session, x1c, filename="KNB x24 - 1.1.0 - X1C.3mf")
    await db_session.commit()

    slots = await discover_slots_for_part_code(db_session, "KNB")
    by_model = {(s["printer_model"], s["quantity"]) for s in slots}
    assert by_model == {("H2S", 12), ("X1C", 24)}


@pytest.mark.asyncio
async def test_discover_skips_ineligible_part_for_printer_folder(db_session):
    """A1 folders only print TOP/KNB — a BOT file there must not become a slot."""
    part = ProductionPart(code="BOT", name="Bottom Housing")
    db_session.add(part)
    a1 = await _seed_production_folder(db_session, model="A1")
    await _seed_file(db_session, a1, filename="BOT x3 - 1.0.0 - A1.3mf")
    await db_session.commit()

    slots = await discover_slots_for_part_code(db_session, "BOT")
    assert slots == []


@pytest.mark.asyncio
async def test_recipe_view_surfaces_folder_discovered_slots(db_session):
    await get_or_create_default_recipe(db_session)
    folder = await _seed_production_folder(db_session, model="X1C")
    await _seed_file(db_session, folder, filename="TOP x1 - 1.13.2 - X1C.3mf")
    await _seed_file(db_session, folder, filename="BUT x47 - 1.0.0 - X1C.3mf")
    await db_session.commit()

    view = await get_recipe_view(db_session)
    by_code = {line["part_code"]: line for line in view["lines"]}
    assert any(s["quantity"] == 1 for s in by_code["TOP"]["discovered_slots"])
    assert any(s["quantity"] == 47 for s in by_code["BUT"]["discovered_slots"])
    assert by_code["TOP"]["recommended_slot_id"] is not None


@pytest.mark.asyncio
async def test_rediscover_is_idempotent_same_slot_id(db_session):
    part = ProductionPart(code="BUT", name="Button")
    db_session.add(part)
    folder = await _seed_production_folder(db_session, model="X1C")
    await _seed_file(db_session, folder, filename="BUT x47 - 1.0.0 - X1C.3mf")
    await db_session.commit()

    first = await discover_slots_for_part_code(db_session, "BUT")
    second = await discover_slots_for_part_code(db_session, "BUT")
    assert len(first) == 1 and len(second) == 1
    assert first[0]["slot_id"] == second[0]["slot_id"]

    count = (await db_session.execute(select(ProductionSlot).where(ProductionSlot.quantity == 47))).scalars().all()
    assert len(count) == 1
