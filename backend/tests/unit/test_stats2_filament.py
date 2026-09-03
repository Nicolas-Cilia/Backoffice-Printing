"""Filament-per-device uses recipe slot library metadata only (no archives)."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.production import ProductionPart, ProductionPartInstance, ProductionSlot
from backend.app.models.settings import Settings
from backend.app.services.device_recipe_service import get_or_create_default_recipe
from backend.app.services.stats2_filament import compute_filament_stats


async def _seed_slot(
    db,
    *,
    part_code: str,
    model: str,
    quantity: int,
    filename: str,
    filament_grams: float | None,
) -> ProductionSlot:
    part = (await db.execute(select(ProductionPart).where(ProductionPart.code == part_code))).scalar_one_or_none()
    if part is None:
        part = ProductionPart(code=part_code, name=part_code)
        db.add(part)
        await db.flush()

    folder = LibraryFolder(name=f"{model}-{part_code}-{filename}", parent_id=None)
    db.add(folder)
    await db.flush()

    meta = {"print_time_seconds": 3600}
    if filament_grams is not None:
        meta["filament_used_grams"] = filament_grams
    lib = LibraryFile(
        folder_id=folder.id,
        filename=filename,
        file_path=f"library/{filename}",
        file_type="3mf",
        file_size=100,
        file_metadata=meta,
    )
    db.add(lib)
    await db.flush()

    inst = ProductionPartInstance(
        part_id=part.id,
        printer_model=model,
        folder_id=folder.id,
        hidden=False,
    )
    db.add(inst)
    await db.flush()

    slot = ProductionSlot(
        instance_id=inst.id,
        quantity=quantity,
        active_file_id=lib.id,
        major=1,
        revision=0,
        minor=0,
    )
    db.add(slot)
    await db.flush()
    return slot


@pytest.mark.asyncio
async def test_filament_uses_slot_file_not_archives(db_session):
    await get_or_create_default_recipe(db_session)

    top = await _seed_slot(
        db_session,
        part_code="TOP",
        model="X1C",
        quantity=2,
        filename="TOP x2 - 1.0.0 - X1C.gcode.3mf",
        filament_grams=200.0,
    )
    await _seed_slot(
        db_session,
        part_code="BOT",
        model="X1C",
        quantity=2,
        filename="BOT x2 - 1.0.0 - X1C.gcode.3mf",
        filament_grams=133.0,
    )
    await _seed_slot(
        db_session,
        part_code="KNB",
        model="A1M",
        quantity=25,
        filename="KNB x25 - 1.0.0 - A1M.gcode.3mf",
        filament_grams=130.0,
    )
    but = await _seed_slot(
        db_session,
        part_code="BUT",
        model="X1C",
        quantity=47,
        filename="BUT x47 - 1.0.0 - X1C.gcode.3mf",
        filament_grams=203.0,
    )

    # Pollute archives linked to BUT's library id — must be ignored.
    junk = PrintArchive(
        filename="Bell Holder.gcode.3mf",
        print_name="Bell Holder",
        file_path="archives/bell.gcode.3mf",
        file_size=50,
        status="completed",
        library_file_id=but.active_file_id,
        filament_used_grams=6.45,
    )
    db_session.add(junk)
    await db_session.flush()
    db_session.add(
        PrintLogEntry(
            archive_id=junk.id,
            status="completed",
            filament_used_grams=6.45,
        )
    )
    # Also a tiny unrelated TOP archive — must not affect TOP x2 metadata.
    junk_top = PrintArchive(
        filename="random.gcode.3mf",
        print_name="random",
        file_path="archives/random.gcode.3mf",
        file_size=50,
        status="completed",
        library_file_id=top.active_file_id,
        filament_used_grams=1.0,
    )
    db_session.add(junk_top)
    await db_session.flush()
    db_session.add(PrintLogEntry(archive_id=junk_top.id, status="completed", filament_used_grams=1.0))
    await db_session.commit()

    stats = await compute_filament_stats(db_session)
    by_code = {p["part_code"]: p for p in stats["parts"]}

    assert by_code["TOP"]["avg_grams_per_plate"] == 200.0
    assert by_code["TOP"]["grams_per_device_part"] == 100.0  # 200 / 2
    assert by_code["BOT"]["grams_per_device_part"] == 66.5  # 133 / 2
    assert by_code["KNB"]["grams_per_device_part"] == 5.2  # 130 / 25
    assert by_code["BUT"]["grams_per_device_part"] == pytest.approx(203.0 / 47, abs=0.01)
    assert by_code["BUT"]["filename"] == "BUT x47 - 1.0.0 - X1C.gcode.3mf"
    assert stats["source"] == "recipe_slot_library_metadata"
    assert stats["historical_total_grams"] is None
    # 100 + 66.5 + 5.2 + 203/47
    assert stats["grams_per_device_estimate"] == pytest.approx(100 + 66.5 + 5.2 + 203 / 47, abs=0.02)
    # Default Settings cost is 25 $/kg when unset
    assert stats["cost_per_kg"] == 25.0
    assert stats["currency"] == "USD"
    expected_grams = stats["grams_per_device_estimate"]
    assert stats["cost_per_device_estimate"] == pytest.approx(round((expected_grams / 1000.0) * 25.0, 2))
    assert by_code["TOP"]["cost_per_device_part"] == pytest.approx(2.50)  # 100g @ $25/kg
    assert by_code["BOT"]["cost_per_device_part"] == pytest.approx(1.66)  # 66.5g
    assert by_code["KNB"]["cost_per_device_part"] == pytest.approx(0.13)  # 5.2g


@pytest.mark.asyncio
async def test_filament_cost_uses_settings_default(db_session):
    await get_or_create_default_recipe(db_session)
    db_session.add(Settings(key="default_filament_cost", value="40.0"))
    db_session.add(Settings(key="currency", value="EUR"))
    await _seed_slot(
        db_session,
        part_code="TOP",
        model="X1C",
        quantity=1,
        filename="TOP - 1.0.0 - X1C.gcode.3mf",
        filament_grams=100.0,
    )
    await db_session.commit()

    stats = await compute_filament_stats(db_session)
    assert stats["cost_per_kg"] == 40.0
    assert stats["currency"] == "EUR"
    assert stats["grams_per_device_estimate"] == 100.0
    assert stats["cost_per_device_estimate"] == 4.0  # 100g @ €40/kg
    top = next(p for p in stats["parts"] if p["part_code"] == "TOP")
    assert top["cost_per_device_part"] == 4.0


@pytest.mark.asyncio
async def test_filament_missing_metadata_skips_part(db_session):
    await get_or_create_default_recipe(db_session)
    await _seed_slot(
        db_session,
        part_code="TOP",
        model="X1C",
        quantity=1,
        filename="TOP - 1.0.0 - X1C.gcode.3mf",
        filament_grams=None,
    )
    await db_session.commit()

    stats = await compute_filament_stats(db_session)
    top = next(p for p in stats["parts"] if p["part_code"] == "TOP")
    assert top["avg_grams_per_plate"] is None
    assert top["grams_per_device_part"] is None
    assert top["cost_per_device_part"] is None
    assert stats["cost_per_device_estimate"] is None
