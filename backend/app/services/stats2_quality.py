"""Stats 2 quality-reasons hub + printer reliability."""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent, FloorPrintStopReason
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.printer import Printer
from backend.app.models.production import ProductionPart, ProductionSlot
from backend.app.services.floor_printers import format_floor_stop_reason
from backend.app.services.stats2_slot_metrics import get_slot_metrics_map

_DEFAULT_LOOKBACK = 30
_FAIL_STATUSES = frozenset({"failed", "stopped", "cancelled"})
_DEFAULT_PART_CODES = ("TOP", "BOT", "KNB", "BUT")
# Auto-written when reconnect/stale cleanup closes a run — not an operator
# failure classification, so keep them out of the quality / reliability hubs.
_SYSTEM_RECONCILE_REASON_PREFIX = "Stale -"


def _day_key(dt: datetime) -> str:
    return dt.date().isoformat()


def _is_system_reconcile_failure_reason(reason: str | None) -> bool:
    label = (reason or "").strip()
    return label.startswith(_SYSTEM_RECONCILE_REASON_PREFIX)


def _print_failure_reason(
    *,
    failure_reason: str | None,
    stop_reason_code: str | None = None,
    stop_reason_text: str | None = None,
) -> str:
    """Prefer operator scanner classification over auto-derived / empty reasons."""
    if stop_reason_code:
        return format_floor_stop_reason(stop_reason_code, stop_reason_text)
    label = (failure_reason or "").strip()
    return label or "Unclassified"


def _floor_event_reason(details: object, *, fallback: str) -> str:
    """Label for discard / rework / sanding events in the quality hub.

    New on-screen error-label buttons denormalize ``error_name`` (and optional
    ``reason_text`` for Other). Legacy scans store ``reason_code``. Prefer the
    denormalized button name so the pie still works after a label is deleted.
    """
    if not isinstance(details, dict):
        return fallback

    error_name = details.get("error_name")
    reason_code = details.get("reason_code") or details.get("error_code")
    reason_text = details.get("reason_text")

    name = error_name.strip() if isinstance(error_name, str) and error_name.strip() else None
    code = reason_code.strip() if isinstance(reason_code, str) and reason_code.strip() else None
    text = reason_text.strip() if isinstance(reason_text, str) and reason_text.strip() else None

    if name and text:
        return f"{name} · {text}"
    if name:
        return name
    if code:
        return code
    if text:
        return text
    return fallback


def _normalize_part_code(code: object) -> str | None:
    if not isinstance(code, str):
        return None
    normalized = code.strip().upper()
    return normalized or None


def infer_part_code_from_names(*names: str | None, known_codes: Sequence[str] | None = None) -> str:
    """Pick a single production code from print/build-plate names, else ``unknown``.

    Same token boundaries as floor enrollment (``TOP`` must not match ``TOPPER``).
    Ambiguous or empty names stay unclassified rather than guessing.
    """
    codes = [_normalize_part_code(c) for c in (known_codes or _DEFAULT_PART_CODES)]
    codes = [c for c in codes if c]
    if not codes:
        codes = list(_DEFAULT_PART_CODES)

    sources = tuple(n for n in names if isinstance(n, str) and n.strip())
    if not sources:
        return "unknown"

    matches: set[str] = set()
    for code in codes:
        pattern = re.compile(rf"(?<![A-Z0-9]){re.escape(code)}(?![A-Z0-9])")
        if any(pattern.search(name.upper()) for name in sources):
            matches.add(code)
    if len(matches) == 1:
        return next(iter(matches))
    return "unknown"


def resolve_part_code(
    *,
    explicit: object = None,
    names: Sequence[str | None] = (),
    known_codes: Sequence[str] | None = None,
) -> str:
    return _normalize_part_code(explicit) or infer_part_code_from_names(*names, known_codes=known_codes)


async def compute_quality_reasons(
    db: AsyncSession,
    *,
    category: str = "all",
    printer_id: int | None = None,
    lookback_days: int = _DEFAULT_LOOKBACK,
    include_rows: bool = False,
) -> dict:
    """Unified hub: print failures, discards, rework, sanding, QC passed.

    ``category="all"`` is the loss mix only (print + discard + rework +
    sanding). ``rework_sanding`` remains a combined alias. QC passed is a
    separate category so export totals stay loss-reason counts.
    """
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=max(1, lookback_days))
    cat = (category or "all").strip().lower()
    reason_counts: dict[str, int] = defaultdict(int)
    by_printer: dict[str, dict] = {}
    by_part: dict[str, dict] = {}
    daily: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    rows: list[dict] = []

    printers = {p.id: p for p in (await db.execute(select(Printer))).scalars().all()}
    known_codes = [
        code
        for code in (await db.execute(select(ProductionPart.code).order_by(ProductionPart.code))).scalars().all()
        if isinstance(code, str) and code.strip()
    ] or list(_DEFAULT_PART_CODES)

    def _printer_bucket(pid: int | None) -> dict:
        key = str(pid) if pid is not None else "unknown"
        if key not in by_printer:
            name = printers[pid].name if pid in printers else "Unknown"
            by_printer[key] = {"printer_id": pid, "printer_name": name, "count": 0, "reasons": defaultdict(int)}
        return by_printer[key]

    def _part_bucket(code: str) -> dict:
        key = code.strip().upper() if code else "unknown"
        if not key:
            key = "unknown"
        if key not in by_part:
            by_part[key] = {"part_code": key, "count": 0, "reasons": defaultdict(int)}
        return by_part[key]

    def _count_event(
        *,
        reason: str,
        printer_id_value: int | None,
        part_code: str,
        when: datetime | None,
        row: dict | None = None,
    ) -> None:
        reason_counts[reason] += 1
        printer_bucket = _printer_bucket(printer_id_value)
        printer_bucket["count"] += 1
        printer_bucket["reasons"][reason] += 1
        part_bucket = _part_bucket(part_code)
        part_bucket["count"] += 1
        part_bucket["reasons"][reason] += 1
        if when:
            daily[_day_key(when)][reason] += 1
        if include_rows and row is not None:
            rows.append(row)

    if cat in {"print", "all", "failures"}:
        q = (
            select(PrintLogEntry)
            .where(PrintLogEntry.created_at >= since)
            .where(PrintLogEntry.status.in_(list(_FAIL_STATUSES)))
            .where(PrintLogEntry.failure_dismissed_at.is_(None))
        )
        if printer_id is not None:
            q = q.where(PrintLogEntry.printer_id == printer_id)
        fail_entries = list((await db.execute(q)).scalars().all())
        fail_ids = [e.id for e in fail_entries]
        stop_by_log: dict[int, FloorPrintStopReason] = {}
        if fail_ids:
            for stop in (
                (await db.execute(select(FloorPrintStopReason).where(FloorPrintStopReason.print_log_id.in_(fail_ids))))
                .scalars()
                .all()
            ):
                stop_by_log[stop.print_log_id] = stop

        for entry in fail_entries:
            stop = stop_by_log.get(entry.id)
            reason = _print_failure_reason(
                failure_reason=entry.failure_reason,
                stop_reason_code=stop.reason_code if stop else None,
                stop_reason_text=stop.reason_text if stop else None,
            )
            # No operator classification: skip reconnect/stale auto-labels.
            if stop is None and _is_system_reconcile_failure_reason(entry.failure_reason):
                continue
            part_code = resolve_part_code(
                explicit=stop.part_code if stop else None,
                names=(stop.print_name if stop else None, entry.print_name),
                known_codes=known_codes,
            )
            when = entry.completed_at or entry.created_at
            _count_event(
                reason=reason,
                printer_id_value=entry.printer_id,
                part_code=part_code,
                when=when,
                row={
                    "category": "print",
                    "reason": reason,
                    "printer_id": entry.printer_id,
                    "part_code": part_code,
                    "status": entry.status,
                    "print_name": entry.print_name,
                    "at": when.isoformat() if when else None,
                },
            )

        # Plate scrap after a successful finish: operator stop reasons on
        # completed PrintLogEntry rows (not present in the fail-status query).
        stop_q = (
            select(FloorPrintStopReason, PrintLogEntry)
            .join(PrintLogEntry, FloorPrintStopReason.print_log_id == PrintLogEntry.id)
            .where(FloorPrintStopReason.stopped_at >= since)
            .where(PrintLogEntry.status == "completed")
            .where(PrintLogEntry.failure_dismissed_at.is_(None))
        )
        if printer_id is not None:
            stop_q = stop_q.where(FloorPrintStopReason.printer_id == printer_id)
        for stop, entry in (await db.execute(stop_q)).all():
            reason = format_floor_stop_reason(stop.reason_code, stop.reason_text)
            part_code = resolve_part_code(
                explicit=stop.part_code,
                names=(stop.print_name, entry.print_name),
                known_codes=known_codes,
            )
            when = stop.stopped_at or entry.completed_at or entry.created_at
            _count_event(
                reason=reason,
                printer_id_value=stop.printer_id,
                part_code=part_code,
                when=when,
                row={
                    "category": "print",
                    "reason": reason,
                    "printer_id": stop.printer_id,
                    "part_code": part_code,
                    "status": entry.status,
                    "print_name": stop.print_name or entry.print_name,
                    "at": when.isoformat() if when else None,
                },
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
            reason = _floor_event_reason(event.details, fallback="Unclassified")
            part_code = resolve_part_code(explicit=part.part_code, known_codes=known_codes)
            _count_event(
                reason=reason,
                printer_id_value=part.printer_id,
                part_code=part_code,
                when=event.occurred_at,
                row={
                    "category": "discard",
                    "reason": reason,
                    "printer_id": part.printer_id,
                    "part_code": part_code,
                    "sticker_code": part.sticker_code,
                    "at": event.occurred_at.isoformat() if event.occurred_at else None,
                },
            )

    rework_actions: list[str] = []
    if cat in {"rework", "rework_sanding", "all"}:
        rework_actions.append("rework")
    if cat in {"sanding", "rework_sanding", "all"}:
        rework_actions.append("sanding")
    if rework_actions:
        q = (
            select(FloorPartEvent, FloorLabeledPart)
            .join(FloorLabeledPart, FloorPartEvent.part_id == FloorLabeledPart.id)
            .where(FloorPartEvent.action.in_(rework_actions))
            .where(FloorPartEvent.occurred_at >= since)
        )
        if printer_id is not None:
            q = q.where(FloorLabeledPart.printer_id == printer_id)
        for event, part in (await db.execute(q)).all():
            reason = _floor_event_reason(event.details, fallback=event.action)
            part_code = resolve_part_code(explicit=part.part_code, known_codes=known_codes)
            # Prefer the concrete action so separate tabs / export can split;
            # keep the combined alias when the caller asked for rework_sanding.
            row_category = "rework_sanding" if cat == "rework_sanding" else event.action
            _count_event(
                reason=reason,
                printer_id_value=part.printer_id,
                part_code=part_code,
                when=event.occurred_at,
                row={
                    "category": row_category,
                    "action": event.action,
                    "reason": reason,
                    "printer_id": part.printer_id,
                    "part_code": part_code,
                    "at": event.occurred_at.isoformat() if event.occurred_at else None,
                },
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
            part_code = resolve_part_code(explicit=part.part_code, known_codes=known_codes)
            _count_event(
                reason=reason,
                printer_id_value=part.printer_id,
                part_code=part_code,
                when=event.occurred_at,
                row={
                    "category": "passed",
                    "action": event.action,
                    "reason": reason,
                    "printer_id": part.printer_id,
                    "part_code": part_code,
                    "sticker_code": part.sticker_code,
                    "at": event.occurred_at.isoformat() if event.occurred_at else None,
                },
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
    parts_out = []
    for bucket in sorted(by_part.values(), key=lambda b: (-b["count"], b["part_code"])):
        parts_out.append(
            {
                "part_code": bucket["part_code"],
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
        "by_part": parts_out,
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

    # Operator scanner classifications — preferred over auto-derived
    # PrintLogEntry.failure_reason for both mid-print failures and completed
    # plate scrap (same rule as the quality hub).
    stop_reasons: dict[int, str] = {}
    for log_id, reason_code, reason_text in (
        await db.execute(
            select(
                FloorPrintStopReason.print_log_id,
                FloorPrintStopReason.reason_code,
                FloorPrintStopReason.reason_text,
            ).where(FloorPrintStopReason.stopped_at >= since)
        )
    ).all():
        if log_id is None:
            continue
        stop_reasons[int(log_id)] = format_floor_stop_reason(reason_code, reason_text)

    # Per printer job success
    printer_rows = []
    for printer in printers:
        entries = (
            await db.execute(
                select(
                    PrintLogEntry.id,
                    PrintLogEntry.status,
                    PrintLogEntry.failure_reason,
                    PrintLogEntry.failure_dismissed_at,
                )
                .where(PrintLogEntry.printer_id == printer.id)
                .where(PrintLogEntry.created_at >= since)
                .where(PrintLogEntry.status.in_(["completed", "failed", "stopped", "cancelled"]))
            )
        ).all()
        ok = 0
        fail = 0
        top_reasons: dict[str, int] = defaultdict(int)
        for log_id, status, reason, dismissed_at in entries:
            if dismissed_at is not None:
                # Discarded floor reason: plate scrap reverts to success; mid-print
                # failures drop out of the sample entirely.
                if status == "completed":
                    ok += 1
                continue
            stop_label = stop_reasons.get(int(log_id)) if log_id is not None else None
            if status == "completed" and stop_label is None:
                ok += 1
                continue
            if stop_label is None and _is_system_reconcile_failure_reason(reason):
                # Reconnect/stale cleanup — not an operator-classified failure.
                continue
            fail += 1
            if stop_label is not None:
                top_reasons[stop_label] += 1
            else:
                top_reasons[_print_failure_reason(failure_reason=reason)] += 1
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
