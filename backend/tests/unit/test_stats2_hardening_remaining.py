"""Stats 2 hardening — remaining defects (TDD RED → GREEN).

These tests lock in four more defects that let the capacity/recommendation
stack present optimistic or physically-impossible signals:

1. HIGH — the slot recommendation ignores the *fleet*: a slot on a printer
   model with zero eligible active printers can still win the recommendation
   even though it can never actually print. The recommendation must weight each
   slot by ``eligible_printer_count(model, part_code)`` so a slot with no fleet
   never beats a slot that has printers.
2. MEDIUM — the sticker QC yield counts ``sanding`` (rework) events as
   QC-passed. Only ``fit_checked`` is a genuine QC pass.
3. MEDIUM — the bin yield path treats a batch with no ``visual_qc_passed``
   event as fully QC-passed (``qc_passed += actual``), fabricating a perfect QC
   pass-through. A batch with no QC event must not add to ``qc_passed_total``.
4. MEDIUM — ``compute_yield_detail`` for BOT reads bin outliers, disagreeing
   with the yield *summary* which tracks BOT through the sticker pipeline. BOT
   detail outliers must come from the sticker path.

They are expected to FAIL against the current production code.
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.floor_bin import FloorBinBatch
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.production import (
    ProductionPart,
    ProductionPartInstance,
    ProductionSlot,
)
from backend.app.services.capacity_analysis import (
    compute_capacity,
    cycle_seconds,
    eligible_printer_count,
    plates_per_printer_per_day,
    simulate_plates_per_printer_day,
)
from backend.app.services.device_recipe_service import (
    get_or_create_default_recipe,
    get_recipe_view,
)
from backend.app.services.production_yield_analysis import (
    compute_yield_detail,
    compute_yield_summary,
)
from backend.app.services.stats2_config import set_stats2_globals
from backend.app.services.stats2_slot_metrics import (
    _MIN_HARVEST_SAMPLES,
    get_slot_metrics_map,
)

# A representative Monday so the staffed-minutes stub is deterministic.
_MONDAY = date(2026, 3, 2)


async def _seed_slot(db, *, part_code: str, model: str, quantity: int, print_time: int, filename: str):
    """part → instance → slot + active LibraryFile (mirrors phase 3a helper)."""
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

    inst = ProductionPartInstance(part_id=part.id, printer_model=model, folder_id=folder.id, hidden=False)
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


async def _seed_jobs(db, slot: ProductionSlot, *, completed: int, failed: int) -> PrintArchive:
    """Attach print-log history to a slot's active file via a single archive.

    One archive per slot keeps the harvest sampler below its threshold so
    harvest/QC stay defaulted and print-job success is the only differentiator.
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
    return archive


# ── Issue 1 (HIGH): recommendation must be fleet / eligibility aware ────────


@pytest.mark.asyncio
async def test_recommendation_prefers_slot_with_active_fleet(db_session, printer_factory):
    """A high-success, dense slot on a model with ZERO printers must lose.

    TOP has two slots:
      * H2S: qty 5, ~0.95 success  — but there are 0 active H2S printers.
      * X1C: qty 1, ~0.50 success  — with 2 active X1C printers.

    Ignoring the fleet, the H2S slot wins (5 × 0.95 = 4.75 ≫ 1 × 0.50). But H2S
    can never actually print (no printers), so the recommendation must pick the
    X1C slot, which the fleet can actually build.
    """
    await set_stats2_globals(db_session, expected_plate_clear_minutes=15)
    await get_or_create_default_recipe(db_session)

    slot_h2s = await _seed_slot(
        db_session, part_code="TOP", model="H2S", quantity=5, print_time=3600, filename="TOP x5 - H2S.3mf"
    )
    slot_x1c = await _seed_slot(
        db_session, part_code="TOP", model="X1C", quantity=1, print_time=3600, filename="TOP x1 - X1C.3mf"
    )
    # H2S is the reliable/dense slot; X1C is only medium reliability.
    await _seed_jobs(db_session, slot_h2s, completed=19, failed=1)  # 0.95 success
    await _seed_jobs(db_session, slot_x1c, completed=10, failed=10)  # 0.50 success

    # Fleet: 2 active X1C printers, ZERO H2S printers.
    await printer_factory(name="X1C-01", model="X1C")
    await printer_factory(name="X1C-02", model="X1C")
    await db_session.commit()

    view = await get_recipe_view(db_session)
    top = next(ln for ln in view["lines"] if ln["part_code"] == "TOP")

    assert top["recommended_slot_id"] == slot_x1c.id, (
        f"recommendation must weight by eligible fleet: expected X1C slot ({slot_x1c.id}) "
        f"with 2 printers, got {top['recommended_slot_id']} (H2S slot {slot_h2s.id} has 0 printers)"
    )
    assert top["recommended_slot_id"] != slot_h2s.id


# ── Issue 2 (MEDIUM): sticker QC counts fit_checked only, not sanding ───────


@pytest.mark.asyncio
async def test_sticker_qc_yield_excludes_sanding(db_session, printer_factory):
    """Sanding is rework, not a QC pass — it must not inflate the sticker QC yield.

    Two archives of 3 TOP parts each: per archive one part is ``fit_checked``
    (a real QC pass) and one is ``sanding`` (rework). If sanding wrongly counts
    as QC-passed, qc_yield ≈ 2/3; counting only fit_checked gives ≈ 1/3.
    """
    printer = await printer_factory(model="X1C")
    slot = await _seed_slot(
        db_session, part_code="TOP", model="X1C", quantity=3, print_time=3600, filename="TOP x3 - X1C.3mf"
    )

    async def _add_archive(prefix: str) -> None:
        archive = PrintArchive(
            printer_id=printer.id,
            library_file_id=slot.active_file_id,
            filename="TOP x3 - X1C.3mf",
            file_path=f"archives/{prefix}.3mf",
            file_size=100,
            status="completed",
        )
        db_session.add(archive)
        await db_session.flush()
        parts = []
        for i in range(3):
            part = FloorLabeledPart(
                sticker_code=f"BBD-{prefix}-{i}",
                printer_id=printer.id,
                archive_id=archive.id,
                part_code="TOP",
            )
            db_session.add(part)
            await db_session.flush()
            parts.append(part)
        # One genuine QC pass, one rework (sanding), one untouched.
        db_session.add(FloorPartEvent(part_id=parts[0].id, action="fit_checked"))
        db_session.add(FloorPartEvent(part_id=parts[1].id, action="sanding"))
        await db_session.flush()

    await _add_archive("A")
    await _add_archive("B")
    await db_session.commit()

    m = (await get_slot_metrics_map(db_session, [slot.id]))[slot.id]

    assert m.harvest_samples >= _MIN_HARVEST_SAMPLES, (
        f"expected real harvest samples, got harvest_samples={m.harvest_samples}"
    )
    # fit_checked only → 1/3 ≈ 0.333; if sanding counted it would be ≈ 0.667.
    assert m.qc_yield == pytest.approx(1 / 3, abs=0.02), (
        f"QC yield must count fit_checked only (≈0.333), got {m.qc_yield}"
    )
    assert m.qc_yield < 0.5, "sanding (rework) must not count as a QC pass"


# ── Issue 3 (MEDIUM): bin QC must not pass-through actual with no QC event ──


@pytest.mark.asyncio
async def test_bin_qc_no_event_does_not_pass_through_as_qc_passed(db_session, printer_factory):
    """A bin harvested with no ``visual_qc_passed`` event has 0 QC-passed.

    The current code adds the full harvested ``actual`` to ``qc_passed`` when a
    batch has no QC event, fabricating a 100% QC pass-through. A batch with no
    QC event must not contribute to ``qc_passed_total``.
    """
    printer = await printer_factory(model="X1C")
    batch = FloorBinBatch(
        bin_payload="BBN-KNB-1",
        part_code="KNB",
        quantity=45,
        expected_quantity=50,
        printer_id=printer.id,
    )
    db_session.add(batch)
    await db_session.commit()

    summary = await compute_yield_summary(db_session, lookback_days=30)
    knb = next(p for p in summary["parts"] if p["part_code"] == "KNB")

    assert knb["harvested_total"] == 45
    assert knb["qc_passed_total"] == 0, (
        "a bin with no visual_qc_passed event must not pass-through harvested as QC-passed; "
        f"got qc_passed_total={knb['qc_passed_total']}"
    )


# ── Issue 4 (MEDIUM): BOT yield detail outliers use the sticker path ───────


@pytest.mark.asyncio
async def test_bot_yield_detail_outliers_use_sticker_path(db_session, printer_factory):
    """BOT detail outliers must come from the sticker pipeline, not bins.

    The yield *summary* tracks BOT through the sticker (labeled-part) pipeline,
    so the *detail* outliers must too. We seed both a BOT sticker archive with a
    harvest shortfall AND a BOT bin with a variance; only the sticker outlier
    (which carries a ``filename``) may appear.
    """
    printer = await printer_factory(model="X1C")

    # Sticker path: archive says x10 but only 3 labeled parts survive → outlier.
    archive = PrintArchive(
        printer_id=printer.id,
        filename="BOT x10 - 1.0.0 - X1C.3mf",
        print_name="BOT x10",
        file_path="archives/bot_x10.3mf",
        file_size=1000,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()
    for i in range(3):
        db_session.add(
            FloorLabeledPart(
                sticker_code=f"BBD-BOTD-{i}",
                printer_id=printer.id,
                archive_id=archive.id,
                part_code="BOT",
            )
        )

    # Bin path: a BOT bin with a big variance. Must NOT drive BOT detail.
    db_session.add(
        FloorBinBatch(
            bin_payload="BBN-BOT-1",
            part_code="BOT",
            quantity=2,
            expected_quantity=10,
            printer_id=printer.id,
        )
    )
    await db_session.commit()

    detail = await compute_yield_detail(db_session, "BOT", lookback_days=30)
    outliers = detail["outliers"]

    assert outliers, "expected at least the sticker-path outlier for BOT"
    # Sticker-path outliers carry a filename; bin-path outliers do not.
    assert all("filename" in o for o in outliers), (
        f"BOT detail must use the sticker path (outliers carry filename), not bin outliers; got {outliers}"
    )
    assert any(o.get("actual") == 3 and o.get("expected") == 10 for o in outliers), (
        f"expected the sticker shortfall (3 of 10) outlier, got {outliers}"
    )


# ── Fix A (MEDIUM): yield-summary sticker QC must exclude sanding ───────────


@pytest.mark.asyncio
async def test_yield_summary_sticker_qc_excludes_sanding(db_session, printer_factory):
    """Sanding is rework, not a QC pass, in the yield summary sticker path too.

    A TOP archive with 3 labeled parts — one ``fit_checked`` (real QC pass), one
    ``sanding`` (rework), one untouched — must report ``qc_passed_total == 1``.
    The current code counts sanding as a pass and reports 2.
    """
    printer = await printer_factory(model="X1C")
    archive = PrintArchive(
        printer_id=printer.id,
        filename="TOP x3 - 1.0.0 - X1C.3mf",
        print_name="TOP x3",
        file_path="archives/top_x3_qc.3mf",
        file_size=100,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()

    parts = []
    for i in range(3):
        part = FloorLabeledPart(
            sticker_code=f"BBD-TQC-{i}",
            printer_id=printer.id,
            archive_id=archive.id,
            part_code="TOP",
        )
        db_session.add(part)
        await db_session.flush()
        parts.append(part)
    db_session.add(FloorPartEvent(part_id=parts[0].id, action="fit_checked"))
    db_session.add(FloorPartEvent(part_id=parts[1].id, action="sanding"))
    # parts[2] has no QC/rework event at all.
    await db_session.commit()

    summary = await compute_yield_summary(db_session, lookback_days=30)
    top = next(p for p in summary["parts"] if p["part_code"] == "TOP")

    assert top["harvested_total"] == 3
    assert top["qc_passed_total"] == 1, (
        "yield summary must count fit_checked only (1), not fit_checked+sanding (2); "
        f"got qc_passed_total={top['qc_passed_total']}"
    )


# ── Fix B (HIGH): capacity must use schedule-aware overnight clear ──────────


def test_simulate_single_long_print_counts_overnight_steady_state():
    """8h print + 10min clear in a 9h staffed window → ~2 plates/day steady-state.

    Plate 1 clears same afternoon; plate 2 runs overnight and clears next morning.
    Prints may run unstaffed; only start/clear need staff.
    """
    windows = [(8 * 60, 17 * 60)]  # 08:00–17:00 (9h)
    sim = simulate_plates_per_printer_day(8 * 3600, 10, windows)
    assert abs(sim - 2.0) < 0.15, f"expected ~2 plates/day steady-state, got {sim}"


def test_simulate_overnight_print_beats_naive_staffed_only_cycle():
    """Prints may run unstaffed, so steady-state can exceed naive staffed/cycle.

    print 3h, clear 10min, staffed ONLY 08:00–12:00 (4h):
      * start 08:00 → finish 11:00 → clear 11:00–11:10
      * start 11:10 → finish 14:10 (unstaffed OK) → clear next morning 08:00
    Steady-state ≈ 2 plates/day. Naive ``staffed/(print+clear)`` ≈ 1.26 under-counts
    because it charges staffed time for the whole print.
    """
    windows = [(8 * 60, 12 * 60)]  # 08:00–12:00 (4h)
    sim = simulate_plates_per_printer_day(3 * 3600, 10, windows)
    naive = plates_per_printer_per_day(4 * 3600, cycle_seconds(3 * 3600, 10), 1.0)

    assert abs(sim - 2.0) < 0.15, f"overnight-capable sim must clear ~2 plates/day, got {sim}"
    assert naive > 1.25, f"sanity: naive division ~1.26, got {naive}"
    assert sim > naive, "schedule-aware sim must credit unstaffed print runtime"


def test_simulate_packs_multiple_short_prints_within_day():
    """Short prints pack many plates; overnight tail still counts in steady-state.

    60min print + 15min clear in a 540min window: 7 clear same day; an 8th runs
    past close and clears next morning. Steady-state averages ~7.5 plates/day.
    """
    windows = [(8 * 60, 17 * 60)]  # 540 min
    sim = simulate_plates_per_printer_day(3600, 15, windows)
    naive = plates_per_printer_per_day(9 * 3600, cycle_seconds(3600, 15), 1.0)

    assert abs(sim - 7.5) < 0.2, f"expected ~7.5 fully-cleared plates/day, got {sim}"
    assert sim >= 7, f"sim ({sim}) must at least match same-day clears"
    assert naive == pytest.approx(7.2), f"sanity: naive float ~7.2, got {naive}"
    assert sim > naive, "overnight-capable sim credits the plate that clears next morning"


def test_simulate_multiday_print_still_counts_one_per_day():
    """~22h print finishing next morning clears ~1 plate/day (not zero)."""
    windows = [(8 * 60, 17 * 60)]
    sim = simulate_plates_per_printer_day(22 * 3600, 10, windows)
    assert abs(sim - 1.0) < 0.15, f"multi-day print must yield ~1 plate/day, got {sim}"


def test_simulate_unstaffed_day_has_zero_plates():
    """No staffed windows → no plate can be started or cleared."""
    assert simulate_plates_per_printer_day(3600, 15, []) == 0


@pytest.mark.asyncio
async def test_capacity_matches_a1_mini_fleet_to_a1m_slot(db_session, printer_factory):
    """Printers stored as ``A1 Mini`` must count toward ``A1M`` production slots."""
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    await get_or_create_default_recipe(db_session)

    await _seed_slot(
        db_session,
        part_code="KNB",
        model="A1M",
        quantity=25,
        print_time=3600,
        filename="KNB x25 - 1.0.0 - A1M.gcode.3mf",
    )
    # Other recipe lines need slots so the headline is not forced to 0 by incompleteness.
    for code, qty, t in (("TOP", 1, 3600), ("BOT", 1, 3600), ("BUT", 1, 3600)):
        await _seed_slot(
            db_session,
            part_code=code,
            model="X1C",
            quantity=qty,
            print_time=t,
            filename=f"{code} x{qty} - 1.0.0 - X1C.gcode.3mf",
        )

    await printer_factory(name="Mini-1", model="A1 Mini")
    await printer_factory(name="Mini-2", model="A1 Mini")
    await printer_factory(name="X1C-1", model="X1C")
    await db_session.commit()

    assert eligible_printer_count({"A1M": 2}, "A1 Mini", "KNB") == 2
    assert eligible_printer_count({"A1M": 2}, "A1M", "KNB") == 2

    cap = await compute_capacity(db_session, on_date=date(2026, 3, 2))
    assert cap["fleet_by_model"].get("A1M") == 2
    knb = next(c for c in cap["components"] if c["part_code"] == "KNB")
    assert knb["printer_model"] == "A1M"
    assert knb["active_printers"] == 2
    assert knb["devices_from_component"] > 0
    assert knb["warning"] is None
