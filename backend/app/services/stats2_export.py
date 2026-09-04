"""CSV/XLSX export builder for Stats 2 capacity + analytics reports."""

from __future__ import annotations

import csv
import io
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.capacity_analysis import compute_build_plan, compute_capacity, compute_overview
from backend.app.services.floor_lead_time_analysis import export_lead_times_csv_rows
from backend.app.services.production_yield_analysis import compute_funnel, compute_yield_summary
from backend.app.services.stats2_plate_feedback import compute_plate_turnaround_feedback
from backend.app.services.stats2_quality import compute_quality_reasons
from backend.app.services.stats2_readiness import compute_readiness


def _csv_bytes(rows: list[list]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue().encode("utf-8")


def _xlsx_bytes(rows: list[list]) -> bytes:
    try:
        from openpyxl import Workbook
    except ImportError as exc:  # pragma: no cover
        raise ImportError("openpyxl is required for xlsx export") from exc
    wb = Workbook()
    ws = wb.active
    ws.title = "Stats2"
    for row in rows:
        ws.append(row)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


async def build_stats2_export(
    db: AsyncSession,
    *,
    format: str = "csv",
    lookback_days: int = 30,
) -> tuple[bytes, str, str]:
    """Assemble a multi-section Stats 2 report (capacity + readiness + yield + …)."""
    overview = await compute_overview(db)
    capacity = await compute_capacity(db)
    readiness = await compute_readiness(db)
    build_plan = await compute_build_plan(db)
    yield_summary = await compute_yield_summary(db, lookback_days=lookback_days)
    funnel = await compute_funnel(db, lookback_days=lookback_days)
    quality = await compute_quality_reasons(db, lookback_days=lookback_days, category="all")
    lead_rows = await export_lead_times_csv_rows(db, lookback_days=lookback_days)
    feedback = await compute_plate_turnaround_feedback(db, lookback_days=lookback_days)

    rows: list[list] = []
    rows.append(["Stats 2 Capacity Report"])
    rows.append(["Generated at", datetime.utcnow().isoformat() + "Z"])
    rows.append(["Lookback days", lookback_days])
    rows.append([])

    rows.append(["Device capacity"])
    rows.append(["Metric", "Value"])
    cap = overview["capacity"]
    rows.append(["devices_per_day_realistic", cap.get("devices_per_day_realistic")])
    rows.append(["devices_per_day_theoretical", cap.get("devices_per_day_theoretical")])
    rows.append(["binding_part", cap.get("binding_part")])
    rows.append(["staffed_minutes", cap.get("staffed_minutes")])
    rows.append(["expected_plate_clear_minutes", cap.get("expected_plate_clear_minutes")])
    rows.append([])

    rows.append(["Capacity components"])
    rows.append(
        [
            "part_code",
            "filename",
            "printer_model",
            "active_printers",
            "parts_per_day",
            "devices_from_component",
            "print_job_success",
            "harvest_yield",
            "qc_yield",
            "incomplete",
        ]
    )
    for c in capacity.get("components", []):
        rows.append(
            [
                c.get("part_code"),
                c.get("filename"),
                c.get("printer_model"),
                c.get("active_printers"),
                c.get("parts_per_day"),
                c.get("devices_from_component"),
                c.get("print_job_success"),
                c.get("harvest_yield"),
                c.get("qc_yield"),
                c.get("incomplete"),
            ]
        )
    rows.append([])

    rows.append(["Readiness (on-hand)"])
    rows.append(["devices_buildable_now", readiness.get("devices_buildable_now")])
    rows.append(["binding_part", readiness.get("binding_part")])
    rows.append(
        [
            "part_code",
            "ready_now",
            "upstream",
            "in_wip",
            "staged_for_prod",
            "rework_sanding",
            "linked",
            "devices_covered",
        ]
    )
    for p in readiness.get("parts", []):
        rows.append(
            [
                p.get("part_code"),
                p.get("ready_now"),
                p.get("upstream"),
                p.get("in_wip"),
                p.get("staged_for_prod"),
                p.get("rework_sanding"),
                p.get("linked"),
                p.get("devices_covered"),
            ]
        )
    rows.append([])

    rows.append(["Build plan"])
    rows.append(["part_code", "recommended_filename", "qty_per_plate", "plates_per_day", "parts_per_day", "is_binding"])
    for r in build_plan.get("rows", []):
        rows.append(
            [
                r.get("part_code"),
                r.get("recommended_filename"),
                r.get("quantity_per_plate"),
                r.get("plates_per_day"),
                r.get("parts_per_day"),
                r.get("is_binding"),
            ]
        )
    rows.append([])

    rows.append(["Production yield"])
    rows.append(
        [
            "part_code",
            "expected_total",
            "harvested_total",
            "qc_passed_total",
            "wip_total",
            "shipped_total",
            "harvest_yield_pct",
        ]
    )
    for p in yield_summary.get("parts", []):
        rows.append(
            [
                p.get("part_code"),
                p.get("expected_total"),
                p.get("harvested_total"),
                p.get("qc_passed_total"),
                p.get("wip_total"),
                p.get("shipped_total"),
                p.get("harvest_yield_pct"),
            ]
        )
    rows.append([])

    rows.append(["Funnel"])
    rows.append(["stage", "count", "pct_of_expected"])
    for s in funnel.get("stages", []):
        rows.append([s.get("stage"), s.get("count"), s.get("pct_of_expected")])
    rows.append([])

    rows.append(["Quality reasons"])
    rows.append(["reason", "count"])
    for r in quality.get("reasons", []):
        rows.append([r.get("reason"), r.get("count")])
    rows.append([])

    rows.append(["Lead times (by part)"])
    rows.append(["metric_id", "label", "part_code", "count", "median_hours", "p90_hours", "mean_hours"])
    for r in lead_rows:
        rows.append(
            [
                r.get("metric_id"),
                r.get("label"),
                r.get("part_code"),
                r.get("count"),
                r.get("median_hours"),
                r.get("p90_hours"),
                r.get("mean_hours"),
            ]
        )
    rows.append([])

    rows.append(["Plate turnaround feedback (not a capacity input)"])
    rows.append(["expected_plate_clear_minutes", feedback.get("expected_plate_clear_minutes")])
    rows.append(["status", feedback.get("status")])
    staffed = feedback.get("staffed_hours_only") or {}
    rows.append(["staffed_median_minutes", staffed.get("median_minutes")])
    rows.append(["staffed_p90_minutes", staffed.get("p90_minutes")])
    rows.append(["staffed_sample_count", staffed.get("count")])

    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    if format == "xlsx":
        return (
            _xlsx_bytes(rows),
            f"stats2_export_{timestamp}.xlsx",
            ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        )
    return _csv_bytes(rows), f"stats2_export_{timestamp}.csv", "text/csv"
