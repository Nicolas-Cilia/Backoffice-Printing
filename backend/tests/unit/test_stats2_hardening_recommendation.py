"""Stats 2 hardening — slot recommendation must use *effective* devices/day.

These tests lock in the intended behavior that the slot recommendation
(``get_recipe_view`` / ``_recommend_slot_id`` and everything that consumes it:
``compute_capacity``, ``compute_build_plan``, ``compute_variant_compare``)
picks the slot that yields the most *effective* devices/day — i.e. it must
apply per-slot print-job success from history — instead of blindly picking the
densest slot (highest ``quantity``).

They are written TDD-style: on the current code the recommendation is
quantity-only, so the effective-winner assertions FAIL (red).
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.device_recipe import DeviceRecipeLine
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.production import ProductionPart, ProductionPartInstance, ProductionSlot
from backend.app.services.capacity_analysis import (
    compute_build_plan,
    compute_capacity,
    compute_variant_compare,
)
from backend.app.services.device_recipe_service import (
    get_or_create_default_recipe,
    get_recipe_view,
)
from backend.app.services.stats2_config import set_stats2_globals

# A representative Monday so the staffed-minutes stub is deterministic.
_MONDAY = date(2026, 3, 2)


async def _seed_slot(db, *, part_code: str, model: str, quantity: int, print_time: int, filename: str):
    """Mirror of test_stats2_phase3a._seed_slot: part → instance → slot + active file."""
    part = (await db.execute(select(ProductionPart).where(ProductionPart.code == part_code))).scalar_one_or_none()
    if part is None:
        part = ProductionPart(code=part_code, name=part_code)
        db.add(part)
        await db.flush()

    folder = LibraryFolder(name=f"{model}-{part_code}-{filename}", parent_id=None)
    db.add(folder)
    await db.flush()

    lib = LibraryFile(
        folder_id=folder.id,
        filename=filename,
        file_path=f"library/{filename}",
        file_type="3mf",
        file_size=100,
        file_metadata={"print_time_seconds": print_time},
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


async def _seed_jobs(db, slot: ProductionSlot, *, completed: int, failed: int) -> None:
    """Attach print-log history to a slot's active file via a single archive.

    Job success is aggregated from ``PrintLogEntry`` joined to ``PrintArchive``
    on ``archive_id`` and matched to the slot via ``PrintArchive.library_file_id
    == slot.active_file_id``. One archive per slot keeps the harvest-yield
    sampler below its ``_MIN_HARVEST_SAMPLES`` threshold so harvest/QC stay at
    their 1.0 defaults and job success is the only differentiator.
    """
    archive = PrintArchive(
        printer_id=None,
        library_file_id=slot.active_file_id,
        filename=f"slot-{slot.id}.3mf",
        file_path=f"archives/slot-{slot.id}.3mf",
        file_size=100,
        status="completed",
    )
    db.add(archive)
    await db.flush()

    for _ in range(completed):
        db.add(PrintLogEntry(archive_id=archive.id, status="completed"))
    for _ in range(failed):
        db.add(PrintLogEntry(archive_id=archive.id, status="failed"))
    await db.flush()


async def _seed_top_two_slots(db):
    """TOP has two same-model slots; densest (A) is unreliable, sparse (B) is reliable.

    Effective devices/day is proportional to ``quantity * job_success`` (same
    print time, printers, and default harvest/QC), so:
        slot A: qty 3 × ~0.30 success ≈ 0.90 effective
        slot B: qty 1 × ~0.95 success ≈ 0.95 effective  ← effective winner
    The densest slot (A, qty 3) is NOT the effective winner.
    """
    await set_stats2_globals(db, expected_plate_clear_minutes=15)
    await get_or_create_default_recipe(db)

    slot_a = await _seed_slot(
        db, part_code="TOP", model="X1C", quantity=3, print_time=3600, filename="TOP x3 - dense.3mf"
    )
    slot_b = await _seed_slot(
        db, part_code="TOP", model="X1C", quantity=1, print_time=3600, filename="TOP x1 - reliable.3mf"
    )
    # A: 3 ok / 7 fail = 0.30 success (>= 3 job samples → not defaulted)
    await _seed_jobs(db, slot_a, completed=3, failed=7)
    # B: 19 ok / 1 fail = 0.95 success (>= 3 job samples → not defaulted)
    await _seed_jobs(db, slot_b, completed=19, failed=1)
    return slot_a, slot_b


@pytest.mark.asyncio
async def test_recipe_recommendation_uses_effective_not_densest(db_session, printer_factory):
    slot_a, slot_b = await _seed_top_two_slots(db_session)
    await printer_factory(name="X1C-01", model="X1C")
    await db_session.commit()

    view = await get_recipe_view(db_session)
    top = next(ln for ln in view["lines"] if ln["part_code"] == "TOP")

    # Effective winner is the reliable single-up slot B, NOT the densest slot A.
    assert top["recommended_slot_id"] == slot_b.id, (
        f"expected effective winner slot B ({slot_b.id}), got {top['recommended_slot_id']} "
        f"(densest slot A is {slot_a.id})"
    )
    assert top["recommended_slot_id"] != slot_a.id


@pytest.mark.asyncio
async def test_capacity_uses_effective_recommended_slot(db_session, printer_factory):
    slot_a, slot_b = await _seed_top_two_slots(db_session)
    await printer_factory(name="X1C-01", model="X1C")
    await db_session.commit()

    cap = await compute_capacity(db_session, on_date=_MONDAY)
    top = next(c for c in cap["components"] if c["part_code"] == "TOP")

    assert top["slot_id"] == slot_b.id, (
        f"capacity should bind to effective winner slot B ({slot_b.id}), got {top['slot_id']} "
        f"(densest slot A is {slot_a.id})"
    )


@pytest.mark.asyncio
async def test_build_plan_uses_effective_recommended_slot(db_session, printer_factory):
    slot_a, slot_b = await _seed_top_two_slots(db_session)
    await printer_factory(name="X1C-01", model="X1C")
    await db_session.commit()

    plan = await compute_build_plan(db_session, on_date=_MONDAY)
    top = next(r for r in plan["rows"] if r["part_code"] == "TOP")

    assert top["recommended_slot_id"] == slot_b.id, (
        f"build plan should use effective winner slot B ({slot_b.id}), got {top['recommended_slot_id']} "
        f"(densest slot A is {slot_a.id})"
    )


@pytest.mark.asyncio
async def test_variant_compare_ranking_agrees_with_recipe(db_session, printer_factory):
    slot_a, slot_b = await _seed_top_two_slots(db_session)
    await printer_factory(name="X1C-01", model="X1C")
    await db_session.commit()

    vc = await compute_variant_compare(db_session, "TOP", on_date=_MONDAY)
    assert vc["variants"], "expected discovered variants for TOP"

    top_variant = vc["variants"][0]
    # The #1 ranked variant (by effective devices/day) is the reliable slot B ...
    assert top_variant["slot_id"] == slot_b.id, (
        f"top-ranked variant should be effective winner slot B ({slot_b.id}), "
        f"got {top_variant['slot_id']} (densest slot A is {slot_a.id})"
    )
    # ... and the recipe recommendation must AGREE with that ranking.
    assert vc["recommended_slot_id"] == top_variant["slot_id"], (
        f"recipe recommendation {vc['recommended_slot_id']} disagrees with variant-compare "
        f"ranking winner {top_variant['slot_id']}"
    )


@pytest.mark.asyncio
async def test_preferred_slot_does_not_override_fleet_recommendation(db_session, printer_factory):
    """Stored preferred_slot_id is ignored — recommendation stays fleet-effective.

    Capacity and the weekly schedule sum every model; a single preferred file
    must not pin the recipe recommendation (or the Gantt) to one plate.
    """
    slot_a, slot_b = await _seed_top_two_slots(db_session)
    # Slot C: neither densest nor reliable → never the auto-pick.
    slot_c = await _seed_slot(
        db_session, part_code="TOP", model="X1C", quantity=2, print_time=3600, filename="TOP x2 - override.3mf"
    )
    await _seed_jobs(db_session, slot_c, completed=1, failed=9)  # 0.10 success

    top_part = (await db_session.execute(select(ProductionPart).where(ProductionPart.code == "TOP"))).scalar_one()
    line = (
        await db_session.execute(select(DeviceRecipeLine).where(DeviceRecipeLine.part_id == top_part.id))
    ).scalar_one()
    line.preferred_slot_id = slot_c.id
    await printer_factory(name="X1C-01", model="X1C")
    await db_session.commit()

    view = await get_recipe_view(db_session)
    top = next(ln for ln in view["lines"] if ln["part_code"] == "TOP")

    assert top["preferred_slot_id"] == slot_c.id
    assert top["recommended_slot_id"] != slot_c.id, (
        f"preferred slot C ({slot_c.id}) must not override the effective recommendation "
        f"(A={slot_a.id}, B={slot_b.id}); got {top['recommended_slot_id']}"
    )
    assert top["recommended_slot_id"] == slot_b.id
