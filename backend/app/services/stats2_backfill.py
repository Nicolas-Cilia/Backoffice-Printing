"""Backfill approximate plate-turnaround rows from PrintLogEntry history.

For each printer, consecutive completed prints yield one approximate row:
finish = print N ``completed_at``, next start = print N+1 ``started_at``.
``plate_clear_confirmed_at`` is set to the next start as a proxy (no live
clear ack existed). Rows are tagged ``source=backfill`` and are **feedback
only** — never used as capacity inputs.

Idempotent: skips pairs that already have a backfill (or live) row with the
same printer + print_finished_at.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_log import PrintLogEntry
from backend.app.models.stats_events import SOURCE_BACKFILL, PlateTurnaroundEvent
from backend.app.services.plate_turnaround import compute_within_staffed_hours


@dataclass(frozen=True)
class BackfillResult:
    printers_scanned: int
    candidates: int
    inserted: int
    skipped_existing: int
    skipped_invalid: int


def _naive(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.replace(tzinfo=None)
    return dt


async def backfill_plate_turnaround_from_print_log(
    db: AsyncSession,
    *,
    lookback_days: int | None = 365,
    dry_run: bool = False,
    max_gap_hours: float = 72.0,
) -> BackfillResult:
    """Create ``source=backfill`` PlateTurnaroundEvent rows from print-log gaps."""
    since = None
    if lookback_days is not None and lookback_days > 0:
        since = datetime.utcnow() - timedelta(days=lookback_days)

    q = (
        select(PrintLogEntry)
        .where(PrintLogEntry.printer_id.is_not(None))
        .where(PrintLogEntry.status == "completed")
        .where(PrintLogEntry.completed_at.is_not(None))
        .where(PrintLogEntry.started_at.is_not(None))
        .order_by(PrintLogEntry.printer_id, PrintLogEntry.completed_at, PrintLogEntry.id)
    )
    if since is not None:
        q = q.where(PrintLogEntry.completed_at >= since)

    entries = (await db.execute(q)).scalars().all()

    by_printer: dict[int, list[PrintLogEntry]] = {}
    for entry in entries:
        pid = int(entry.printer_id)  # type: ignore[arg-type]
        by_printer.setdefault(pid, []).append(entry)

    candidates = 0
    inserted = 0
    skipped_existing = 0
    skipped_invalid = 0
    max_gap = timedelta(hours=max_gap_hours)

    for printer_id, logs in by_printer.items():
        for i in range(len(logs) - 1):
            current = logs[i]
            nxt = logs[i + 1]
            finished = _naive(current.completed_at)
            next_start = _naive(nxt.started_at)
            if finished is None or next_start is None:
                skipped_invalid += 1
                continue
            if next_start <= finished:
                skipped_invalid += 1
                continue
            if next_start - finished > max_gap:
                # Overnight/weekend idle is fine; multi-day gaps are usually
                # downtime, not a plate clear — skip extremes.
                skipped_invalid += 1
                continue

            candidates += 1
            existing = (
                await db.execute(
                    select(PlateTurnaroundEvent.id)
                    .where(PlateTurnaroundEvent.printer_id == printer_id)
                    .where(PlateTurnaroundEvent.print_finished_at == finished)
                    .limit(1)
                )
            ).scalar_one_or_none()
            if existing is not None:
                skipped_existing += 1
                continue

            if dry_run:
                inserted += 1
                continue

            within = compute_within_staffed_hours(finished)
            db.add(
                PlateTurnaroundEvent(
                    printer_id=printer_id,
                    archive_id=current.archive_id,
                    print_finished_at=finished,
                    plate_clear_requested_at=finished,
                    # Proxy: full finish→next-start gap stands in for clear time.
                    plate_clear_confirmed_at=next_start,
                    next_print_started_at=next_start,
                    within_staffed_hours=within,
                    source=SOURCE_BACKFILL,
                )
            )
            inserted += 1

    if not dry_run and inserted:
        await db.flush()

    return BackfillResult(
        printers_scanned=len(by_printer),
        candidates=candidates,
        inserted=inserted,
        skipped_existing=skipped_existing,
        skipped_invalid=skipped_invalid,
    )
