"""Stats 2 hardening: slot-metrics + capacity yield/warning integrity (TDD).

These tests lock in four defects that let sparse or missing data masquerade
as confident, healthy signals:

1. A missing ``expected_quantity`` is silently backfilled from ``quantity``,
   producing a fake 100% harvest sample (``harvest_yield == 1.0`` with
   ``using_defaults == False``).
2. The sticker (labeled-part) harvest path never computes a QC yield from
   ``fit_checked`` events, so QC silently stays at the 1.0 default even when
   real harvest samples exist.
3. ``ComponentCapacity`` / the capacity response drops the per-slot
   ``using_defaults`` flag, so a component built entirely from defaults looks
   identical to one backed by real history.
4. A ``LibraryFile`` with no ``print_time`` silently falls back to 3600s with
   no warning / incomplete / assumed-time signal on the component.

They are expected to FAIL against current production code.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.floor_bin import FloorBinBatch
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.production import (
    ProductionPart,
    ProductionPartInstance,
    ProductionSlot,
)
from backend.app.services.capacity_analysis import (
    _DEFAULT_PRINT_TIME_SECONDS,
    _component_to_dict,
    compute_component,
)
from backend.app.services.stats2_slot_metrics import (
    _MIN_HARVEST_SAMPLES,
    SlotMetrics,
    get_slot_metrics_map,
)


async def _seed_slot(
    db,
    *,
    part_code: str,
    model: str,
    quantity: int,
    filename: str,
    print_time: int | None = 3600,
):
    """Create a Production slot backed by a LibraryFile and return (slot, lib)."""
    part = (await db.execute(select(ProductionPart).where(ProductionPart.code == part_code))).scalar_one_or_none()
    if part is None:
        part = ProductionPart(code=part_code, name=part_code)
        db.add(part)
        await db.flush()

    folder = LibraryFolder(name=f"{model}-{part_code}-{filename}", parent_id=None)
    db.add(folder)
    await db.flush()

    metadata: dict = {}
    if print_time is not None:
        metadata["print_time_seconds"] = print_time

    lib = LibraryFile(
        folder_id=folder.id,
        filename=filename,
        file_path=f"library/{filename}",
        file_type="3mf",
        file_size=100,
        file_metadata=metadata,
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
    return slot, lib


@pytest.mark.asyncio
async def test_missing_expected_quantity_does_not_fake_full_harvest(db_session, printer_factory):
    """Bug 1: batches with unknown expected_quantity must NOT become 100% samples.

    A ``FloorBinBatch`` with ``expected_quantity=None`` currently falls back to
    its own ``quantity`` as the denominator, yielding ``actual / actual = 1.0``.
    With enough such batches the slot reports ``harvest_yield == 1.0`` and
    ``using_defaults == False`` — a fabricated perfect yield. Correct behavior
    excludes these batches from the harvest sample set entirely.
    """
    printer = await printer_factory(model="X1C")
    slot, lib = await _seed_slot(db_session, part_code="KNB", model="X1C", quantity=45, filename="KNB x45.3mf")

    archive = PrintArchive(
        printer_id=printer.id,
        library_file_id=lib.id,
        filename="KNB x45.3mf",
        file_path="archives/knb.3mf",
        file_size=100,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()

    # Two harvested bins, both missing expected_quantity -> would each fake a 1.0 rate.
    for _ in range(2):
        db_session.add(
            FloorBinBatch(
                bin_payload="BBN-KNB-1",
                part_code="KNB",
                quantity=45,
                expected_quantity=None,
                archive_id=archive.id,
                printer_id=printer.id,
            )
        )
    await db_session.commit()

    metrics_map = await get_slot_metrics_map(db_session, [slot.id])
    m = metrics_map[slot.id]

    assert m.harvest_samples == 0, (
        "batches missing expected_quantity must be excluded from harvest samples, "
        f"got harvest_samples={m.harvest_samples}, harvest_yield={m.harvest_yield}, "
        f"using_defaults={m.using_defaults}"
    )
    # And the fabricated perfect yield must not be presented as a confident value.
    assert not (m.harvest_samples >= _MIN_HARVEST_SAMPLES and abs(m.harvest_yield - 1.0) < 1e-9), (
        "unknown-expected batches must not yield a confident harvest_yield of 1.0"
    )


@pytest.mark.asyncio
async def test_unlabeled_archives_do_not_zero_harvest_yield(db_session, printer_factory):
    """Completed prints with no labeled parts are not 0% harvest samples.

    Without this guard, slots that printed but have not entered floor labeling
    report harvest_yield=0.0 and zero out device capacity.
    """
    printer = await printer_factory(model="A1 Mini")
    slot, lib = await _seed_slot(db_session, part_code="KNB", model="A1M", quantity=25, filename="KNB x25.3mf")

    for i in range(3):
        db_session.add(
            PrintArchive(
                printer_id=printer.id,
                library_file_id=lib.id,
                filename="KNB x25.3mf",
                file_path=f"archives/knb-empty-{i}.3mf",
                file_size=100,
                status="completed",
            )
        )
    await db_session.commit()

    metrics_map = await get_slot_metrics_map(db_session, [slot.id])
    m = metrics_map[slot.id]

    assert m.harvest_samples == 0
    assert abs(m.harvest_yield - 1.0) < 1e-9
    assert m.using_defaults is True


@pytest.mark.asyncio
async def test_qc_yield_uses_fit_checked_rate_not_default(db_session, printer_factory):
    """Bug 2: labeled-part QC yield must reflect fit_checked/harvested, not 1.0.

    The sticker harvest path builds harvest samples from labeled parts but never
    derives a QC yield from ``fit_checked`` events, so QC silently defaults to
    1.0 even though real harvest data exists. We seed parts where only a subset
    were fit-checked, so a correct QC yield must be < 1.0.
    """
    printer = await printer_factory(model="X1C")
    slot, lib = await _seed_slot(db_session, part_code="TOP", model="X1C", quantity=3, filename="TOP x3.3mf")

    async def _add_archive_with_parts(prefix: str, *, total: int, fit_checked: int):
        archive = PrintArchive(
            printer_id=printer.id,
            library_file_id=lib.id,
            filename="TOP x3.3mf",
            file_path=f"archives/{prefix}.3mf",
            file_size=100,
            status="completed",
        )
        db_session.add(archive)
        await db_session.flush()
        for i in range(total):
            part = FloorLabeledPart(
                sticker_code=f"BBD-{prefix}-{i}",
                printer_id=printer.id,
                archive_id=archive.id,
                part_code="TOP",
            )
            db_session.add(part)
            await db_session.flush()
            if i < fit_checked:
                db_session.add(FloorPartEvent(part_id=part.id, action="fit_checked"))
        return archive

    # >= _MIN_HARVEST_SAMPLES archives so harvest is NOT defaulted; only 4/6 parts fit-checked.
    await _add_archive_with_parts("A", total=3, fit_checked=2)
    await _add_archive_with_parts("B", total=3, fit_checked=2)
    await db_session.commit()

    metrics_map = await get_slot_metrics_map(db_session, [slot.id])
    m = metrics_map[slot.id]

    # Harvest samples must exist (this is the "harvest samples exist" precondition).
    assert m.harvest_samples >= _MIN_HARVEST_SAMPLES, (
        f"expected real harvest samples, got harvest_samples={m.harvest_samples}"
    )
    # QC must reflect the fit_checked rate (4/6 ≈ 0.667), not the silent 1.0 default.
    assert m.qc_yield < 1.0, (
        f"QC yield must reflect fit_checked/harvested, not the default 1.0; got qc_yield={m.qc_yield}"
    )


def test_component_capacity_surfaces_using_defaults():
    """Bug 3: a component built from default (no-history) metrics must say so.

    ``get_slot_metrics_map`` returns ``using_defaults=True`` for slots with no
    history, but ``compute_component`` / the capacity response drop the flag, so
    a defaulted component is indistinguishable from a data-backed one.
    """
    metrics = SlotMetrics(
        slot_id=1,
        print_job_success=1.0,
        harvest_yield=1.0,
        qc_yield=1.0,
        job_samples=0,
        harvest_samples=0,
        using_defaults=True,
    )
    comp = compute_component(
        line={"part_code": "TOP", "part_name": "Top", "qty_per_device": 1},
        slot={
            "slot_id": 1,
            "printer_model": "X1C",
            "quantity": 1,
            "print_time_seconds": 3600,
            "filename": "TOP x1.3mf",
        },
        staffed_seconds=9 * 3600,
        clear_minutes=15,
        fleet={"X1C": 2},
        metrics=metrics,
    )

    signal = getattr(comp, "using_defaults", None)
    if signal is None:
        signal = _component_to_dict(comp).get("using_defaults")
    assert signal is True, (
        "component built from default metrics must expose using_defaults=True "
        "on the ComponentCapacity / capacity response"
    )


def test_missing_print_time_flags_assumed_default():
    """Bug 4: falling back to 3600s must not be silent.

    When the slot's LibraryFile carries no print_time, ``compute_component``
    silently substitutes ``_DEFAULT_PRINT_TIME_SECONDS`` (3600) with no warning,
    no ``incomplete`` flag, and no assumed-time marker. The component must carry
    some signal that the print time was assumed.
    """
    comp = compute_component(
        line={"part_code": "TOP", "part_name": "Top", "qty_per_device": 1},
        slot={
            "slot_id": 1,
            "printer_model": "X1C",
            "quantity": 1,
            # no "print_time_seconds" -> triggers the silent 3600 fallback
            "filename": "TOP x1.3mf",
        },
        staffed_seconds=9 * 3600,
        clear_minutes=15,
        fleet={"X1C": 2},  # printers > 0 so the only possible warning is about print time
        metrics=None,
    )

    # Sanity: it did take the silent fallback.
    assert comp.print_time_seconds == _DEFAULT_PRINT_TIME_SECONDS
    assert comp.active_printers > 0

    d = _component_to_dict(comp)
    signalled = (
        bool(comp.warning)
        or comp.incomplete
        or bool(getattr(comp, "print_time_assumed", False))
        or bool(getattr(comp, "print_time_estimated", False))
        or bool(d.get("print_time_assumed"))
        or bool(d.get("print_time_estimated"))
    )
    assert signalled, (
        "missing print_time must surface as a warning / incomplete / "
        "print_time_assumed flag, not a silent 3600s fallback"
    )
