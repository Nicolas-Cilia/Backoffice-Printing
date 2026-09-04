"""Unit tests for Stats 2 Phase 3b: yield, quality, lead times, plate feedback."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from backend.app.models.archive import PrintArchive
from backend.app.models.floor_bin import FloorBinBatch, FloorBinBatchEvent
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent, FloorPrintStopReason
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.stats_events import PlateTurnaroundEvent
from backend.app.services.device_recipe_service import get_or_create_default_recipe
from backend.app.services.floor_lead_time_analysis import compute_lead_times
from backend.app.services.operator_schedule_service import staffed_minutes_between_local, stub_windows_by_weekday
from backend.app.services.production_yield_analysis import compute_funnel, compute_yield_summary
from backend.app.services.stats2_config import set_stats2_globals
from backend.app.services.stats2_plate_feedback import compute_plate_turnaround_feedback
from backend.app.services.stats2_quality import compute_printer_reliability, compute_quality_reasons


def test_staffed_minutes_between_overnight_stub():
    windows = stub_windows_by_weekday()
    mins = staffed_minutes_between_local(
        datetime(2026, 9, 1, 16, 55),
        datetime(2026, 9, 2, 8, 8),
        windows_by_weekday=windows,
    )
    assert mins == 13.0


def test_staffed_minutes_utc_wall_clock_looks_like_full_day():
    """Regression: treating Pacific overnight as UTC wall clock yields ~7h+, not 13m."""
    windows = stub_windows_by_weekday()
    # 16:55 PDT = 23:55 UTC; 08:08 PDT = 15:08 UTC
    wrong = staffed_minutes_between_local(
        datetime(2026, 9, 1, 23, 55),
        datetime(2026, 9, 2, 15, 8),
        windows_by_weekday=windows,
    )
    assert wrong == 428.0  # Wed 08:00–15:08 UTC


@pytest.mark.asyncio
async def test_lead_times_use_globals_timezone_not_shift_row(db_session, printer_factory):
    """Stale shift.timezone=UTC must not override Stats 2 globals timezone."""
    from backend.app.services.operator_schedule_service import ScheduleShiftIn, replace_schedule
    from backend.app.services.stats2_config import set_stats2_globals

    printer = await printer_factory(model="X1C")
    await set_stats2_globals(db_session, timezone="America/Los_Angeles")
    # Persist shifts with a misleading UTC timezone field (older saves).
    await replace_schedule(
        db_session,
        [
            ScheduleShiftIn(
                day_of_week=d,
                start_time="08:00",
                end_time="17:00",
                operator_count=1,
                timezone="UTC",
                enabled=True,
            )
            for d in range(5)
        ],
    )
    today = datetime.utcnow().date()
    days_since_tue = (today.weekday() - 1) % 7
    tue = today - timedelta(days=days_since_tue if days_since_tue else 7)
    # Pacific 16:55 / 08:08 stored as UTC instants
    finish = datetime(tue.year, tue.month, tue.day, 23, 55, 0)
    wed = tue + timedelta(days=1)
    harvest = datetime(wed.year, wed.month, wed.day, 15, 8, 0)
    archive = PrintArchive(
        printer_id=printer.id,
        filename="TOP x1.3mf",
        print_name="TOP x1",
        file_path="archives/test/top-tz.3mf",
        file_size=100,
        completed_at=finish,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()
    part = FloorLabeledPart(
        sticker_code="BBD-TZ1",
        printer_id=printer.id,
        part_code="TOP",
        archive_id=archive.id,
        labeled_at=harvest,
    )
    db_session.add(part)
    await db_session.flush()
    db_session.add(FloorPartEvent(part_id=part.id, action="enrolled", occurred_at=harvest))
    await db_session.commit()

    result = await compute_lead_times(db_session)
    metric = next(m for m in result["metrics"] if m["metric_id"] == "print_to_linked")
    assert result["timezone"] == "America/Los_Angeles"
    assert metric["median_minutes"] == 13.0


def test_staffed_minutes_between_same_shift():
    windows = stub_windows_by_weekday()
    mins = staffed_minutes_between_local(
        datetime(2026, 9, 1, 10, 0),
        datetime(2026, 9, 1, 11, 30),
        windows_by_weekday=windows,
    )
    assert mins == 90.0


@pytest.mark.asyncio
async def test_yield_and_funnel_from_bin_harvest(db_session, printer_factory):
    printer = await printer_factory(model="X1C")
    batch = FloorBinBatch(
        bin_payload="BBN-BUT-1",
        part_code="BUT",
        quantity=45,
        expected_quantity=47,
        quantity_variance=-2,
        printer_id=printer.id,
    )
    db_session.add(batch)
    await db_session.flush()
    db_session.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="visual_qc_passed",
            details={"passed_quantity": 43},
        )
    )
    db_session.add(FloorBinBatchEvent(batch_id=batch.id, action="wip"))
    db_session.add(FloorBinBatchEvent(batch_id=batch.id, action="consumed", details={"quantity": 10}))
    await db_session.commit()

    summary = await compute_yield_summary(db_session, lookback_days=30)
    but = next(p for p in summary["parts"] if p["part_code"] == "BUT")
    assert but["expected_total"] == 47
    assert but["harvested_total"] == 45
    assert but["qc_passed_total"] == 43
    # wip_total is cumulative units that entered WIP (= QC amount), not remaining
    # after consume — frontend stillInWip = wip_total - shipped_total.
    assert but["wip_total"] == 43
    assert but["shipped_total"] == 10
    assert but["harvest_yield_pct"] is not None
    assert but["harvest_yield_pct"] < 100

    funnel = await compute_funnel(db_session)
    assert funnel["stages"][0]["stage"] == "expected"
    assert any(s["stage"] == "lost" for s in funnel["stages"])


@pytest.mark.asyncio
async def test_yield_bin_source_default_does_not_inflate_expected(db_session, printer_factory):
    """SOURCE_DEFAULT expected (quantity=1) must not inflate expected_total.

    A bin with no expected_quantity and no resolvable archive filename still
    counts harvested/plates/WIP, but expected_total stays 0 for that batch.
    """
    printer = await printer_factory(model="X1C")
    batch = FloorBinBatch(
        bin_payload="BBN-KNB-DEF-1",
        part_code="KNB",
        quantity=12,
        expected_quantity=None,
        archive_id=None,
        printer_id=printer.id,
    )
    db_session.add(batch)
    await db_session.flush()
    db_session.add(
        FloorBinBatchEvent(
            batch_id=batch.id,
            action="visual_qc_passed",
            details={"passed_quantity": 10},
        )
    )
    db_session.add(FloorBinBatchEvent(batch_id=batch.id, action="wip"))
    db_session.add(FloorBinBatchEvent(batch_id=batch.id, action="consumed", details={"quantity": 3}))
    await db_session.commit()

    summary = await compute_yield_summary(db_session, lookback_days=30)
    knb = next(p for p in summary["parts"] if p["part_code"] == "KNB")
    assert knb["harvested_total"] == 12
    assert knb["qc_passed_total"] == 10
    assert knb["wip_total"] == 10  # cumulative QC that entered WIP
    assert knb["shipped_total"] == 3
    assert knb["expected_total"] == 0, (
        f"SOURCE_DEFAULT must not add a fabricated expected=1; got expected_total={knb['expected_total']}"
    )


@pytest.mark.asyncio
async def test_quality_reasons_includes_completed_plate_stop_reason(db_session, printer_factory):
    """Operator plate-failure on a completed print log must appear under print reasons.

    Status stays ``completed`` (not in the fail-status query); FloorPrintStopReason
    is the scrap signal after a successful finish.
    """
    printer = await printer_factory(model="X1C")
    now = datetime.utcnow()
    entry = PrintLogEntry(
        printer_id=printer.id,
        printer_name=printer.name,
        print_name="TOP x4",
        status="completed",
        created_at=now,
        completed_at=now,
    )
    db_session.add(entry)
    await db_session.flush()
    db_session.add(
        FloorPrintStopReason(
            print_log_id=entry.id,
            printer_id=printer.id,
            print_name="TOP x4",
            part_code="TOP",
            reason_code="BBR-warped",
            stopped_at=now,
        )
    )
    await db_session.commit()

    print_hub = await compute_quality_reasons(db_session, category="print")
    reasons = {r["reason"]: r["count"] for r in print_hub["reasons"]}
    assert reasons.get("BBR-warped") == 1, (
        f"completed plate stop reason must appear in print category; got {print_hub['reasons']}"
    )
    assert print_hub["total"] >= 1
    assert print_hub["by_printer"][0]["printer_id"] == printer.id


@pytest.mark.asyncio
async def test_quality_reasons_prefers_scanner_stop_over_empty_failure_reason(db_session, printer_factory):
    """Failed/stopped PrintLogEntry rows must use FloorPrintStopReason when present.

    Auto HMS labeling often leaves failure_reason null ("unclassified" in the pie).
    Operators still classify those stops on the scanner — that reason must win.
    """
    printer = await printer_factory(model="X1C")
    now = datetime.utcnow()
    empty = PrintLogEntry(
        printer_id=printer.id,
        printer_name=printer.name,
        print_name="TOP x2",
        status="failed",
        failure_reason=None,
        created_at=now,
        completed_at=now,
    )
    auto = PrintLogEntry(
        printer_id=printer.id,
        printer_name=printer.name,
        print_name="BOT x1",
        status="stopped",
        failure_reason="User cancelled",
        created_at=now,
        completed_at=now,
    )
    still_empty = PrintLogEntry(
        printer_id=printer.id,
        printer_name=printer.name,
        print_name="KNB x1",
        status="failed",
        failure_reason=None,
        created_at=now,
        completed_at=now,
    )
    db_session.add_all([empty, auto, still_empty])
    await db_session.flush()
    db_session.add(
        FloorPrintStopReason(
            print_log_id=empty.id,
            printer_id=printer.id,
            print_name="TOP x2",
            part_code="TOP",
            reason_code="warping",
            stopped_at=now,
        )
    )
    db_session.add(
        FloorPrintStopReason(
            print_log_id=auto.id,
            printer_id=printer.id,
            print_name="BOT x1",
            part_code="BOT",
            reason_code="first_layer_issue",
            stopped_at=now,
        )
    )
    await db_session.commit()

    print_hub = await compute_quality_reasons(db_session, category="print")
    reasons = {r["reason"]: r["count"] for r in print_hub["reasons"]}
    assert reasons.get("Warping") == 1
    assert reasons.get("First layer issue") == 1
    assert reasons.get("Unclassified") == 1
    assert "User cancelled" not in reasons
    assert print_hub["total"] == 3

    reliability = await compute_printer_reliability(db_session)
    row = next(p for p in reliability["printers"] if p["printer_id"] == printer.id)
    top = {r["reason"]: r["count"] for r in row["top_failure_reasons"]}
    assert top.get("Warping") == 1
    assert top.get("First layer issue") == 1
    assert top.get("Unclassified") == 1


@pytest.mark.asyncio
async def test_quality_reasons_other_stop_uses_reason_text(db_session, printer_factory):
    printer = await printer_factory(model="X1C")
    now = datetime.utcnow()
    entry = PrintLogEntry(
        printer_id=printer.id,
        printer_name=printer.name,
        print_name="TOP x1",
        status="failed",
        failure_reason=None,
        created_at=now,
        completed_at=now,
    )
    db_session.add(entry)
    await db_session.flush()
    db_session.add(
        FloorPrintStopReason(
            print_log_id=entry.id,
            printer_id=printer.id,
            print_name="TOP x1",
            part_code="TOP",
            reason_code="other",
            reason_text="nozzle crash into clip",
            stopped_at=now,
        )
    )
    await db_session.commit()

    print_hub = await compute_quality_reasons(db_session, category="print")
    reasons = {r["reason"]: r["count"] for r in print_hub["reasons"]}
    assert reasons.get("nozzle crash into clip") == 1
    assert "other" not in reasons
    assert "Other" not in reasons
    assert "unclassified" not in reasons
    assert "Unclassified" not in reasons


@pytest.mark.asyncio
async def test_quality_reasons_skips_dismissed_print_failures(db_session, printer_factory):
    """Discarding a floor failure reason must drop the run from Stats 2 counts."""
    from backend.app.services.floor_printers import delete_floor_stop_reason

    printer = await printer_factory(model="X1C")
    now = datetime.utcnow()
    kept = PrintLogEntry(
        printer_id=printer.id,
        printer_name=printer.name,
        print_name="TOP x1",
        status="failed",
        failure_reason=None,
        created_at=now,
        completed_at=now,
    )
    dismissed = PrintLogEntry(
        printer_id=printer.id,
        printer_name=printer.name,
        print_name="BOT x1",
        status="failed",
        failure_reason="warping",
        created_at=now,
        completed_at=now,
    )
    db_session.add_all([kept, dismissed])
    await db_session.flush()
    db_session.add(
        FloorPrintStopReason(
            print_log_id=kept.id,
            printer_id=printer.id,
            print_name="TOP x1",
            part_code="TOP",
            reason_code="filament_issue",
            stopped_at=now,
        )
    )
    stop = FloorPrintStopReason(
        print_log_id=dismissed.id,
        printer_id=printer.id,
        print_name="BOT x1",
        part_code="BOT",
        reason_code="warping",
        stopped_at=now,
    )
    db_session.add(stop)
    await db_session.commit()

    assert await delete_floor_stop_reason(db_session, stop.id) is True
    await db_session.commit()
    await db_session.refresh(dismissed)
    assert dismissed.failure_dismissed_at is not None
    assert dismissed.failure_reason is None

    print_hub = await compute_quality_reasons(db_session, category="print")
    reasons = {r["reason"]: r["count"] for r in print_hub["reasons"]}
    assert reasons.get("Filament issue") == 1
    assert "warping" not in reasons
    assert "Warping" not in reasons
    assert "unclassified" not in reasons
    assert "Unclassified" not in reasons
    assert print_hub["total"] == 1

    reliability = await compute_printer_reliability(db_session)
    row = next(p for p in reliability["printers"] if p["printer_id"] == printer.id)
    assert row["failed"] == 1
    assert row["jobs"] == 1


@pytest.mark.asyncio
async def test_quality_reasons_skips_stale_reconnect_failures(db_session, printer_factory):
    """Reconnect/stale auto-labels must not appear in the By-reason hub."""
    printer = await printer_factory(model="X1C")
    now = datetime.utcnow()
    db_session.add(
        PrintLogEntry(
            printer_id=printer.id,
            printer_name=printer.name,
            print_name="TOP x1",
            status="failed",
            failure_reason="Stale - reconciled after reconnect, end time unknown",
            created_at=now,
            completed_at=now,
        )
    )
    db_session.add(
        PrintLogEntry(
            printer_id=printer.id,
            printer_name=printer.name,
            print_name="BOT x1",
            status="failed",
            failure_reason="Stale - print likely cancelled or failed without status update",
            created_at=now,
            completed_at=now,
        )
    )
    kept = PrintLogEntry(
        printer_id=printer.id,
        printer_name=printer.name,
        print_name="KNB x1",
        status="failed",
        failure_reason=None,
        created_at=now,
        completed_at=now,
    )
    db_session.add(kept)
    await db_session.flush()
    db_session.add(
        FloorPrintStopReason(
            print_log_id=kept.id,
            printer_id=printer.id,
            print_name="KNB x1",
            part_code="KNB",
            reason_code="layer_lines",
            stopped_at=now,
        )
    )
    await db_session.commit()

    print_hub = await compute_quality_reasons(db_session, category="print")
    reasons = {r["reason"]: r["count"] for r in print_hub["reasons"]}
    assert reasons == {"Layer lines": 1}
    assert print_hub["total"] == 1
    assert not any(str(r["reason"]).startswith("Stale -") for r in print_hub["reasons"])

    reliability = await compute_printer_reliability(db_session)
    row = next(p for p in reliability["printers"] if p["printer_id"] == printer.id)
    assert row["failed"] == 1
    assert row["jobs"] == 1
    assert row["top_failure_reasons"] == [{"reason": "Layer lines", "count": 1}]


@pytest.mark.asyncio
async def test_quality_reasons_print_and_discard(db_session, printer_factory):
    printer = await printer_factory(model="X1C")
    now = datetime.utcnow()
    db_session.add(
        PrintLogEntry(
            printer_id=printer.id,
            printer_name=printer.name,
            print_name="TOP x1",
            status="failed",
            failure_reason="adhesionFailure",
            created_at=now,
            completed_at=now,
        )
    )
    db_session.add(
        PrintLogEntry(
            printer_id=printer.id,
            printer_name=printer.name,
            print_name="TOP x1",
            status="cancelled",
            failure_reason="userCancelled",
            created_at=now,
            completed_at=now,
        )
    )
    part = FloorLabeledPart(sticker_code="BBD-Q1", printer_id=printer.id, part_code="TOP")
    db_session.add(part)
    await db_session.flush()
    db_session.add(
        FloorPartEvent(
            part_id=part.id,
            action="discarded",
            details={"reason_code": "BBR-crack"},
            occurred_at=now,
        )
    )
    await db_session.commit()

    print_hub = await compute_quality_reasons(db_session, category="print")
    assert print_hub["total"] == 2
    reasons = {r["reason"] for r in print_hub["reasons"]}
    assert "adhesionFailure" in reasons
    assert "userCancelled" in reasons
    assert print_hub["by_printer"][0]["printer_id"] == printer.id
    assert print_hub["by_part"][0]["part_code"] == "TOP"
    assert print_hub["by_part"][0]["count"] == 2
    assert print_hub["daily"]
    assert print_hub["daily"][0]["date"] == now.date().isoformat()
    assert print_hub["daily"][0]["total"] == 2

    discard_hub = await compute_quality_reasons(db_session, category="discard")
    assert discard_hub["total"] == 1
    assert discard_hub["reasons"][0]["reason"] == "BBR-crack"
    assert discard_hub["by_part"][0]["part_code"] == "TOP"

    all_hub = await compute_quality_reasons(db_session, category="all", include_rows=True)
    assert all_hub["total"] == 3
    assert len(all_hub["rows"]) == 3

    passed_part = FloorLabeledPart(sticker_code="BBD-Q2", printer_id=printer.id, part_code="BOT")
    db_session.add(passed_part)
    await db_session.flush()
    db_session.add(FloorPartEvent(part_id=passed_part.id, action="fit_checked", occurred_at=now))
    db_session.add(
        FloorPartEvent(
            part_id=passed_part.id,
            action="sanding",
            details={"reason_text": "edge"},
            occurred_at=now,
        )
    )
    await db_session.commit()

    passed_hub = await compute_quality_reasons(db_session, category="passed")
    assert passed_hub["total"] == 1
    assert passed_hub["reasons"][0]["reason"] == "fit_checked"
    assert passed_hub["daily"][0]["total"] == 1
    # Sanding is rework, not a pass. ``all`` stays loss-only (2 print + 1 discard + 1 sanding).
    assert (await compute_quality_reasons(db_session, category="all"))["total"] == 4
    alias_hub = await compute_quality_reasons(db_session, category="qc_passed")
    assert alias_hub["total"] == 1


@pytest.mark.asyncio
async def test_quality_reasons_use_error_label_button_names(db_session, printer_factory):
    """On-screen BBF error-label buttons store error_name, not reason_code."""
    printer = await printer_factory(model="X1C")
    now = datetime.utcnow()
    discard_part = FloorLabeledPart(sticker_code="BBD-EL1", printer_id=printer.id, part_code="TOP")
    sanding_part = FloorLabeledPart(sticker_code="BBD-EL2", printer_id=printer.id, part_code="BOT")
    rework_part = FloorLabeledPart(sticker_code="BBD-EL3", printer_id=printer.id, part_code="KNB")
    db_session.add_all([discard_part, sanding_part, rework_part])
    await db_session.flush()
    db_session.add(
        FloorPartEvent(
            part_id=discard_part.id,
            action="discarded",
            details={
                "error_label_id": 12,
                "error_payload": "BBF-horizontal-line",
                "error_name": "Horizontal line",
                "reason_text": None,
            },
            occurred_at=now,
        )
    )
    db_session.add(
        FloorPartEvent(
            part_id=sanding_part.id,
            action="sanding",
            details={
                "error_label_id": 3,
                "error_payload": "BBF-other",
                "error_name": "Other",
                "reason_text": "sharp edge",
            },
            occurred_at=now,
        )
    )
    db_session.add(
        FloorPartEvent(
            part_id=rework_part.id,
            action="rework",
            details={
                "error_label_id": 7,
                "error_payload": "BBF-doesnt-fit",
                "error_name": "Doesn't fit",
                "reason_text": None,
            },
            occurred_at=now,
        )
    )
    await db_session.commit()

    discard_hub = await compute_quality_reasons(db_session, category="discard")
    assert discard_hub["total"] == 1
    assert discard_hub["reasons"][0]["reason"] == "Horizontal line"

    combined = await compute_quality_reasons(db_session, category="rework_sanding")
    reasons = {r["reason"]: r["count"] for r in combined["reasons"]}
    assert reasons == {"Other · sharp edge": 1, "Doesn't fit": 1}
    assert combined["total"] == 2
    by_part = {p["part_code"]: p["count"] for p in combined["by_part"]}
    assert by_part == {"BOT": 1, "KNB": 1}

    sanding_hub = await compute_quality_reasons(db_session, category="sanding", include_rows=True)
    assert sanding_hub["total"] == 1
    assert sanding_hub["reasons"][0]["reason"] == "Other · sharp edge"
    assert sanding_hub["rows"][0]["category"] == "sanding"
    assert sanding_hub["rows"][0]["action"] == "sanding"

    rework_hub = await compute_quality_reasons(db_session, category="rework", include_rows=True)
    assert rework_hub["total"] == 1
    assert rework_hub["reasons"][0]["reason"] == "Doesn't fit"
    assert rework_hub["rows"][0]["category"] == "rework"
    assert rework_hub["rows"][0]["action"] == "rework"


def test_infer_part_code_from_print_names():
    from backend.app.services.stats2_quality import infer_part_code_from_names

    assert infer_part_code_from_names("TOP x4 - 1.13.2 - X1C") == "TOP"
    assert infer_part_code_from_names("BUT x47") == "BUT"
    assert infer_part_code_from_names("TOPPER plate") == "unknown"
    assert infer_part_code_from_names("TOP and BOT mix") == "unknown"
    assert infer_part_code_from_names(None, "") == "unknown"


@pytest.mark.asyncio
async def test_lead_times_wip_to_unit_linked(db_session, printer_factory):
    """WIP→unit_linked (TOP) within one staffed day stays wall-clock aligned under the stub."""
    printer = await printer_factory(model="X1C")
    # Most recent Tuesday 10:00 → 16:00 UTC (inside Mon–Fri 08–17 stub)
    today = datetime.utcnow().date()
    days_since_tue = (today.weekday() - 1) % 7
    tue = today - timedelta(days=days_since_tue if days_since_tue else 7)
    t0 = datetime(tue.year, tue.month, tue.day, 10, 0, 0)
    part = FloorLabeledPart(
        sticker_code="BBD-L1",
        printer_id=printer.id,
        part_code="TOP",
        labeled_at=t0,
    )
    db_session.add(part)
    await db_session.flush()
    db_session.add(FloorPartEvent(part_id=part.id, action="enrolled", occurred_at=t0))
    db_session.add(FloorPartEvent(part_id=part.id, action="fit_checked", occurred_at=t0 + timedelta(hours=1)))
    db_session.add(FloorPartEvent(part_id=part.id, action="wip", occurred_at=t0))  # 10:00
    db_session.add(FloorPartEvent(part_id=part.id, action="unit_linked", occurred_at=t0 + timedelta(hours=6)))  # 16:00
    await db_session.commit()

    result = await compute_lead_times(db_session)
    wip_linked = next(m for m in result["metrics"] if m["metric_id"] == "wip_to_unit_linked")
    assert wip_linked["count"] == 1
    assert wip_linked["median_minutes"] == 360.0  # 10:00→16:00 staffed
    assert wip_linked["median_hours"] == 6.0
    assert "TOP" in wip_linked["by_part_code"]
    assert result["staffed_hours_only"] is True
    assert [m["metric_id"] for m in result["metrics"]] == [
        "print_to_linked",
        "linked_to_qc",
        "qc_to_production",
        "wip_to_unit_linked",
        "finishing_total",
    ]


@pytest.mark.asyncio
async def test_lead_times_print_to_linked_excludes_overnight(db_session, printer_factory):
    """Finish 16:55, linked 08:08 next day → 13 staffed minutes (not ~15h wall)."""
    printer = await printer_factory(model="X1C")
    today = datetime.utcnow().date()
    days_since_tue = (today.weekday() - 1) % 7
    tue = today - timedelta(days=days_since_tue if days_since_tue else 7)
    finish = datetime(tue.year, tue.month, tue.day, 16, 55, 0)
    wed = tue + timedelta(days=1)
    linked = datetime(wed.year, wed.month, wed.day, 8, 8, 0)
    archive = PrintArchive(
        printer_id=printer.id,
        filename="TOP x1.3mf",
        print_name="TOP x1",
        file_path="archives/test/top.3mf",
        file_size=100,
        completed_at=finish,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()
    part = FloorLabeledPart(
        sticker_code="BBD-H1",
        printer_id=printer.id,
        part_code="TOP",
        archive_id=archive.id,
        labeled_at=linked,
    )
    db_session.add(part)
    await db_session.flush()
    db_session.add(FloorPartEvent(part_id=part.id, action="enrolled", occurred_at=linked))
    await db_session.commit()

    result = await compute_lead_times(db_session)
    metric = next(m for m in result["metrics"] if m["metric_id"] == "print_to_linked")
    assert metric["count"] == 1
    assert metric["median_minutes"] == 13.0
    assert metric["median_hours"] == pytest.approx(13 / 60, abs=0.001)


@pytest.mark.asyncio
async def test_lead_times_finishing_support_to_ready(db_session, printer_factory):
    """Finishing (TOP) is first Support Removal → Ready for Production / WIP."""
    printer = await printer_factory(model="X1C")
    today = datetime.utcnow().date()
    days_since_tue = (today.weekday() - 1) % 7
    tue = today - timedelta(days=days_since_tue if days_since_tue else 7)
    t0 = datetime(tue.year, tue.month, tue.day, 9, 0, 0)
    part = FloorLabeledPart(
        sticker_code="BBD-F1",
        printer_id=printer.id,
        part_code="TOP",
        labeled_at=t0,
    )
    db_session.add(part)
    await db_session.flush()
    # QC at 9:00, support at 9:10, ready at 10:00 → finishing = 50 staffed minutes
    db_session.add(FloorPartEvent(part_id=part.id, action="enrolled", occurred_at=t0))
    db_session.add(FloorPartEvent(part_id=part.id, action="fit_checked", occurred_at=t0))
    db_session.add(FloorPartEvent(part_id=part.id, action="support_removed", occurred_at=t0 + timedelta(minutes=10)))
    db_session.add(FloorPartEvent(part_id=part.id, action="overhang_removed", occurred_at=t0 + timedelta(minutes=25)))
    db_session.add(FloorPartEvent(part_id=part.id, action="hot_air_removed", occurred_at=t0 + timedelta(minutes=40)))
    db_session.add(
        FloorPartEvent(part_id=part.id, action="ready_for_production", occurred_at=t0 + timedelta(minutes=60))
    )
    await db_session.commit()

    result = await compute_lead_times(db_session)
    finishing = next(m for m in result["metrics"] if m["metric_id"] == "finishing_total")
    assert finishing["count"] == 1
    assert finishing["median_minutes"] == 50.0
    qc_prod = next(m for m in result["metrics"] if m["metric_id"] == "qc_to_production")
    assert qc_prod["median_minutes"] == 60.0


@pytest.mark.asyncio
async def test_lead_times_count_sanding_as_initial_qc(db_session, printer_factory):
    """Parts that record sanding and never fit_checked still enter Initial QC spans."""
    printer = await printer_factory(model="X1C")
    today = datetime.utcnow().date()
    days_since_tue = (today.weekday() - 1) % 7
    tue = today - timedelta(days=days_since_tue if days_since_tue else 7)
    t0 = datetime(tue.year, tue.month, tue.day, 9, 0, 0)
    part = FloorLabeledPart(
        sticker_code="BBD-S1",
        printer_id=printer.id,
        part_code="TOP",
        labeled_at=t0,
    )
    db_session.add(part)
    await db_session.flush()
    db_session.add(FloorPartEvent(part_id=part.id, action="enrolled", occurred_at=t0))
    db_session.add(FloorPartEvent(part_id=part.id, action="sanding", occurred_at=t0 + timedelta(minutes=30)))
    db_session.add(
        FloorPartEvent(part_id=part.id, action="ready_for_production", occurred_at=t0 + timedelta(minutes=90))
    )
    await db_session.commit()

    result = await compute_lead_times(db_session)
    linked_qc = next(m for m in result["metrics"] if m["metric_id"] == "linked_to_qc")
    qc_prod = next(m for m in result["metrics"] if m["metric_id"] == "qc_to_production")
    assert linked_qc["count"] == 1
    assert linked_qc["median_minutes"] == 30.0
    assert qc_prod["count"] == 1
    assert qc_prod["median_minutes"] == 60.0


@pytest.mark.asyncio
async def test_lead_times_pst_alias_counts_pacific_afternoon(db_session, printer_factory):
    """Invalid 'PST' must resolve to America/Los_Angeles, not silent UTC (zeroed spans)."""
    printer = await printer_factory(model="X1C")
    await set_stats2_globals(db_session, timezone="PST")
    today = datetime.utcnow().date()
    days_since_tue = (today.weekday() - 1) % 7
    tue = today - timedelta(days=days_since_tue if days_since_tue else 7)
    # 19:50–20:16 UTC = 12:50–13:16 Pacific → ~26 staffed minutes
    support = datetime(tue.year, tue.month, tue.day, 19, 50, 0)
    ready = datetime(tue.year, tue.month, tue.day, 20, 16, 0)
    part = FloorLabeledPart(
        sticker_code="BBD-PST1",
        printer_id=printer.id,
        part_code="TOP",
        labeled_at=support,
    )
    db_session.add(part)
    await db_session.flush()
    db_session.add(FloorPartEvent(part_id=part.id, action="support_removed", occurred_at=support))
    db_session.add(FloorPartEvent(part_id=part.id, action="ready_for_production", occurred_at=ready))
    await db_session.commit()

    result = await compute_lead_times(db_session)
    assert result["timezone"] == "America/Los_Angeles"
    finishing = next(m for m in result["metrics"] if m["metric_id"] == "finishing_total")
    assert finishing["median_minutes"] == 26.0


@pytest.mark.asyncio
async def test_plate_feedback_status(db_session, printer_factory):
    printer = await printer_factory(model="X1C")
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    today = datetime.utcnow().date()
    days_since_tue = (today.weekday() - 1) % 7
    tue = today - timedelta(days=days_since_tue if days_since_tue else 7)
    base = datetime(tue.year, tue.month, tue.day, 10, 0, 0)
    for i, clear_min in enumerate((5, 6, 7, 8)):
        finished = base + timedelta(minutes=i * 30)
        db_session.add(
            PlateTurnaroundEvent(
                printer_id=printer.id,
                print_finished_at=finished,
                plate_clear_requested_at=finished,
                plate_clear_confirmed_at=finished + timedelta(minutes=clear_min),
                within_staffed_hours=True,
            )
        )
    await db_session.commit()

    feedback = await compute_plate_turnaround_feedback(db_session)
    assert feedback["expected_plate_clear_minutes"] == 10
    assert feedback["status"] == "ahead"
    assert feedback["staffed_hours_only"]["count"] == 4
    assert feedback["insufficient_data"] is False


@pytest.mark.asyncio
async def test_plate_feedback_overnight_clear_is_staffed_minutes(db_session, printer_factory):
    """Finish 16:55, clear 08:08 → staffed series is 13 min (wall clock stays ~15h)."""
    printer = await printer_factory(model="X1C")
    await set_stats2_globals(db_session, expected_plate_clear_minutes=10)
    today = datetime.utcnow().date()
    days_since_tue = (today.weekday() - 1) % 7
    tue = today - timedelta(days=days_since_tue if days_since_tue else 7)
    finish = datetime(tue.year, tue.month, tue.day, 16, 55, 0)
    wed = tue + timedelta(days=1)
    cleared = datetime(wed.year, wed.month, wed.day, 8, 8, 0)
    # Need ≥3 samples for status; pad with two same-shift 10-min clears
    for i in range(2):
        f = datetime(tue.year, tue.month, tue.day, 10 + i, 0, 0)
        db_session.add(
            PlateTurnaroundEvent(
                printer_id=printer.id,
                print_finished_at=f,
                plate_clear_requested_at=f,
                plate_clear_confirmed_at=f + timedelta(minutes=10),
                within_staffed_hours=True,
            )
        )
    db_session.add(
        PlateTurnaroundEvent(
            printer_id=printer.id,
            print_finished_at=finish,
            plate_clear_requested_at=finish,
            plate_clear_confirmed_at=cleared,
            within_staffed_hours=True,
        )
    )
    await db_session.commit()

    feedback = await compute_plate_turnaround_feedback(db_session)
    staffed = feedback["staffed_hours_only"]
    assert staffed["count"] == 3
    assert staffed["mean_minutes"] == pytest.approx((10 + 10 + 13) / 3, abs=0.1)
    assert staffed["median_minutes"] == 10.0
    # Wall-clock overnight (~15h) pulls the all-clears mean far above staffed
    assert feedback["all_clears"]["mean_minutes"] > 200


@pytest.mark.asyncio
async def test_reliability_empty_fleet_ok(db_session):
    await get_or_create_default_recipe(db_session)
    await db_session.commit()
    result = await compute_printer_reliability(db_session)
    assert "printers" in result
    assert "slots" in result
