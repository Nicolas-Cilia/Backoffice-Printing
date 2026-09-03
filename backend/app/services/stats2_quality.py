"""Stats 2 quality-reasons hub + printer reliability."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent, FloorPrintStopReason
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.printer import Printer
from backend.app.models.production import ProductionSlot
from backend.app.services.stats2_slot_metrics import get_slot_metrics_map

_DEFAULT_LOOKBACK = 30
_FAIL_STATUSES = frozenset({"failed", "stopped", "cancelled"})


def _day_key(dt: datetime) -> str:
    return dt.date().isoformat()


async def compute_quality_reasons(
    db: AsyncSession,
    *,
    category: str = "all",
    printer_id: int | None = None,
    lookback_days: int = _DEFAULT_LOOKBACK,
    include_rows: bool = False,
) -> dict:
    """Unified hub: print failures, discards, rework/sanding, QC passed.

    ``category="all"`` is the loss mix only (print + discard + rework). QC
    passed is a separate category so export totals stay loss-reason counts.
    """
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=max(1, lookback_days))
    cat = (category or "all").strip().lower()
    reason_counts: dict[str, int] = defaultdict(int)
    by_printer: dict[str, dict] = {}
    daily: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    rows: list[dict] = []

    printers = {p.id: p for p in (await db.execute(select(Printer))).scalars().all()}

    def _printer_bucket(pid: int | None) -> dict:
        key = str(pid) if pid is not None else "unknown"
        if key not in by_printer:
            name = printers[pid].name if pid in printers else "Unknown"
            by_printer[key] = {"printer_id": pid, "printer_name": name, "count": 0, "reasons": defaultdict(int)}
        return by_printer[key]

    if cat in {"print", "all", "failures"}:
        q = (
            select(PrintLogEntry)
            .where(PrintLogEntry.created_at >= since)
            .where(PrintLogEntry.status.in_(list(_FAIL_STATUSES)))
        )
        if printer_id is not None:
            q = q.where(PrintLogEntry.printer_id == printer_id)
        for entry in (await db.execute(q)).scalars().all():
            reason = (entry.failure_reason or "unclassified").strip() or "unclassified"
            reason_counts[reason] += 1
            bucket = _printer_bucket(entry.printer_id)
            bucket["count"] += 1
            bucket["reasons"][reason] += 1
            when = entry.completed_at or entry.created_at
            if when:
                daily[_day_key(when)][reason] += 1
            if include_rows:
                rows.append(
                    {
                        "category": "print",
                        "reason": reason,
                        "printer_id": entry.printer_id,
                        "status": entry.status,
                        "print_name": entry.print_name,
                        "at": when.isoformat() if when else None,
                    }
                )

        # Plate scrap after a successful finish: operator stop reasons on
        # completed PrintLogEntry rows (not present in the fail-status query).
        stop_q = (
            select(FloorPrintStopReason, PrintLogEntry)
            .join(PrintLogEntry, FloorPrintStopReason.print_log_id == PrintLogEntry.id)
            .where(FloorPrintStopReason.stopped_at >= since)
            .where(PrintLogEntry.status == "completed")
        )
        if printer_id is not None:
            stop_q = stop_q.where(FloorPrintStopReason.printer_id == printer_id)
        for stop, entry in (await db.execute(stop_q)).all():
            reason = (stop.reason_code or "unclassified").strip() or "unclassified"
            reason_counts[reason] += 1
            bucket = _printer_bucket(stop.printer_id)
            bucket["count"] += 1
            bucket["reasons"][reason] += 1
            when = stop.stopped_at or entry.completed_at or entry.created_at
            if when:
                daily[_day_key(when)][reason] += 1
            if include_rows:
                rows.append(
                    {
                        "category": "print",
                        "reason": reason,
                        "printer_id": stop.printer_id,
                        "status": entry.status,
                        "print_name": stop.print_name or entry.print_name,
                        "at": when.isoformat() if when else None,
                    }
                )

    if cat in {"discard", "all"}:
        q = (
            select(FloorPartEvent, FloorLabeledPart)
            .join(FloorLabeledPart, FloorPartEvent.part_id == FloorLabeledPart.id)
            .where(FloorPartEvent.action == "discarded")
            .where(FloorPartEvent.occurred_at >= since)
        )
        if printer_id is not None:
            q = q.where(FloorLabeledPart.printer_id == printer_id)
        for event, part in (await db.execute(q)).all():
            details = event.details if isinstance(event.details, dict) else {}
            reason = (
                details.get("reason_code") or details.get("error_code") or details.get("reason_text") or "unclassified"
            )
            reason = str(reason).strip() or "unclassified"
            reason_counts[reason] += 1
            bucket = _printer_bucket(part.printer_id)
            bucket["count"] += 1
            bucket["reasons"][reason] += 1
            daily[_day_key(event.occurred_at)][reason] += 1
            if include_rows:
                rows.append(
                    {
                        "category": "discard",
                        "reason": reason,
                        "printer_id": part.printer_id,
                        "part_code": part.part_code,
                        "sticker_code": part.sticker_code,
                        "at": event.occurred_at.isoformat() if event.occurred_at else None,
                    }
                )

    if cat in {"rework_sanding", "all"}:
        q = (
            select(FloorPartEvent, FloorLabeledPart)
            .join(FloorLabeledPart, FloorPartEvent.part_id == FloorLabeledPart.id)
            .where(FloorPartEvent.action.in_(("rework", "sanding")))
            .where(FloorPartEvent.occurred_at >= since)
        )
        if printer_id is not None:
            q = q.where(FloorLabeledPart.printer_id == printer_id)
        for event, part in (await db.execute(q)).all():
            details = event.details if isinstance(event.details, dict) else {}
            reason = details.get("reason_code") or details.get("reason_text") or event.action
            reason = str(reason).strip() or event.action
            reason_counts[reason] += 1
            bucket = _printer_bucket(part.printer_id)
            bucket["count"] += 1
            bucket["reasons"][reason] += 1
            daily[_day_key(event.occurred_at)][reason] += 1
            if include_rows:
                rows.append(
                    {
                        "category": "rework_sanding",
                        "action": event.action,
                        "reason": reason,
                        "printer_id": part.printer_id,
                        "part_code": part.part_code,
                        "at": event.occurred_at.isoformat() if event.occurred_at else None,
                    }
                )

    if cat in {"passed", "qc_passed"}:
        # Genuine QC pass only — sanding is rework (see production_yield_analysis).
        q = (
            select(FloorPartEvent, FloorLabeledPart)
            .join(FloorLabeledPart, FloorPartEvent.part_id == FloorLabeledPart.id)
            .where(FloorPartEvent.action == "fit_checked")
            .where(FloorPartEvent.occurred_at >= since)
        )
        if printer_id is not None:
            q = q.where(FloorLabeledPart.printer_id == printer_id)
        for event, part in (await db.execute(q)).all():
            reason = "fit_checked"
            reason_counts[reason] += 1
            bucket = _printer_bucket(part.printer_id)
            bucket["count"] += 1
            bucket["reasons"][reason] += 1
            daily[_day_key(event.occurred_at)][reason] += 1
            if include_rows:
                rows.append(
                    {
                        "category": "passed",
                        "action": event.action,
                        "reason": reason,
                        "printer_id": part.printer_id,
                        "part_code": part.part_code,
                        "sticker_code": part.sticker_code,
                        "at": event.occurred_at.isoformat() if event.occurred_at else None,
                    }
                )

    reasons_out = [{"reason": r, "count": c} for r, c in sorted(reason_counts.items(), key=lambda kv: (-kv[1], kv[0]))]
    printers_out = []
    for bucket in sorted(by_printer.values(), key=lambda b: -b["count"]):
        printers_out.append(
            {
                "printer_id": bucket["printer_id"],
                "printer_name": bucket["printer_name"],
                "count": bucket["count"],
                "reasons": [
                    {"reason": r, "count": c} for r, c in sorted(bucket["reasons"].items(), key=lambda kv: -kv[1])
                ],
            }
        )
    daily_out = [
        {
            "date": day,
            "reasons": [{"reason": r, "count": c} for r, c in reasons.items()],
            "total": sum(reasons.values()),
        }
        for day, reasons in sorted(daily.items())
    ]

    payload = {
        "category": cat,
        "lookback_days": lookback_days,
        "printer_id": printer_id,
        "total": sum(reason_counts.values()),
        "reasons": reasons_out,
        "by_printer": printers_out,
        "daily": daily_out,
        "as_of": datetime.now(timezone.utc).isoformat(),
    }
    if include_rows:
        payload["rows"] = rows
    return payload


async def compute_printer_reliability(
    db: AsyncSession,
    *,
    lookback_days: int = _DEFAULT_LOOKBACK,
) -> dict:
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=max(1, lookback_days))
    printers = (await db.execute(select(Printer).where(Printer.is_active.is_(True)))).scalars().all()

    # Completed archives operators later marked as plate scrap still count as
    # failures (same rule as slot metrics / quality hub).
    plate_fail_reasons = {
        int(log_id): (reason_code or "plate_failure")
        for log_id, reason_code in (
            await db.execute(
                select(FloorPrintStopReason.print_log_id, FloorPrintStopReason.reason_code)
                .join(PrintLogEntry, FloorPrintStopReason.print_log_id == PrintLogEntry.id)
                .where(FloorPrintStopReason.stopped_at >= since)
                .where(PrintLogEntry.status == "completed")
            )
        ).all()
        if log_id is not None
    }

    # Per printer job success
    printer_rows = []
    for printer in printers:
        entries = (
            await db.execute(
                select(PrintLogEntry.id, PrintLogEntry.status, PrintLogEntry.failure_reason)
                .where(PrintLogEntry.printer_id == printer.id)
                .where(PrintLogEntry.created_at >= since)
                .where(PrintLogEntry.status.in_(["completed", "failed", "stopped", "cancelled"]))
            )
        ).all()
        ok = 0
        fail = 0
        top_reasons: dict[str, int] = defaultdict(int)
        for log_id, status, reason in entries:
            if status == "completed" and log_id not in plate_fail_reasons:
                ok += 1
                continue
            fail += 1
            if status == "completed" and log_id in plate_fail_reasons:
                top_reasons[plate_fail_reasons[log_id]] += 1
            else:
                top_reasons[(reason or "unclassified")] += 1
        total = ok + fail
        printer_rows.append(
            {
                "printer_id": printer.id,
                "printer_name": printer.name,
                "model": printer.model,
                "jobs": total,
                "completed": ok,
                "failed": fail,
                "job_success": (ok / total) if total else None,
                "top_failure_reasons": [
                    {"reason": r, "count": c} for r, c in sorted(top_reasons.items(), key=lambda kv: -kv[1])[:5]
                ],
            }
        )

    # Per-slot variant metrics (reuse capacity metrics)
    slots = (await db.execute(select(ProductionSlot).where(ProductionSlot.active_file_id.is_not(None)))).scalars().all()
    metrics = await get_slot_metrics_map(db, [s.id for s in slots], lookback_days=lookback_days)
    slot_rows = []
    for slot in slots:
        m = metrics.get(slot.id)
        if m is None:
            continue
        # Resolve filename via archive join optional — use active_file_id only
        archive_name = None
        if slot.active_file_id:
            arch = (
                await db.execute(
                    select(PrintArchive.filename)
                    .where(PrintArchive.library_file_id == slot.active_file_id)
                    .order_by(PrintArchive.created_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            archive_name = arch
        slot_rows.append(
            {
                "slot_id": slot.id,
                "quantity": slot.quantity,
                "filename": archive_name,
                "print_job_success": m.print_job_success,
                "harvest_yield": m.harvest_yield,
                "qc_yield": m.qc_yield,
                "effective_parts_per_plate": round(slot.quantity * m.harvest_yield * m.qc_yield, 2),
                "job_samples": m.job_samples,
                "using_defaults": m.using_defaults,
            }
        )
    slot_rows.sort(key=lambda r: (-(r["print_job_success"] or 0), -r["effective_parts_per_plate"]))

    return {
        "lookback_days": lookback_days,
        "printers": sorted(printer_rows, key=lambda r: (-(r["job_success"] or 0), -r["jobs"])),
        "slots": slot_rows,
        "as_of": datetime.now(timezone.utc).isoformat(),
    }
