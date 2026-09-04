"""Per-slot job success / harvest / QC yields for Stats 2 capacity.

When historical samples are thin, yields default to 1.0 so capacity still
works from schedule + expected clear alone (plan: sparse data ≠ zero capacity).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.floor_bin import FloorBinBatch, FloorBinBatchEvent
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent, FloorPrintStopReason
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.production import ProductionSlot

_SUCCESS_STATUSES = frozenset({"completed"})
_FAIL_STATUSES = frozenset({"failed", "stopped", "cancelled"})
_DEFAULT_LOOKBACK_DAYS = 30
_MIN_JOB_SAMPLES = 3
_MIN_HARVEST_SAMPLES = 2


@dataclass(frozen=True)
class SlotMetrics:
    slot_id: int
    print_job_success: float
    harvest_yield: float
    qc_yield: float
    job_samples: int
    harvest_samples: int
    using_defaults: bool


def _clamp_rate(value: float) -> float:
    if value < 0:
        return 0.0
    if value > 1:
        return 1.0
    return float(value)


async def get_slot_metrics_map(
    db: AsyncSession,
    slot_ids: list[int],
    *,
    lookback_days: int = _DEFAULT_LOOKBACK_DAYS,
    now: datetime | None = None,
) -> dict[int, SlotMetrics]:
    """Aggregate print-job success + harvest/QC yield keyed by production slot."""
    unique_ids = sorted({int(s) for s in slot_ids if s is not None})
    if not unique_ids:
        return {}

    slots = (await db.execute(select(ProductionSlot).where(ProductionSlot.id.in_(unique_ids)))).scalars().all()
    file_to_slot: dict[int, int] = {}
    for slot in slots:
        if slot.active_file_id is not None:
            file_to_slot[int(slot.active_file_id)] = int(slot.id)

    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is not None:
        reference = reference.replace(tzinfo=None)
    since = reference - timedelta(days=max(1, lookback_days))

    job_ok: dict[int, int] = dict.fromkeys(unique_ids, 0)
    job_fail: dict[int, int] = dict.fromkeys(unique_ids, 0)
    harvest_rates: dict[int, list[float]] = {sid: [] for sid in unique_ids}
    qc_rates: dict[int, list[float]] = {sid: [] for sid in unique_ids}

    if file_to_slot:
        file_ids = list(file_to_slot.keys())
        # Completed jobs with an operator plate-failure stop reason are scrap,
        # not successes (status stays "completed" on the print log).
        plate_fail_log_ids = set(
            (
                await db.execute(
                    select(FloorPrintStopReason.print_log_id).where(FloorPrintStopReason.stopped_at >= since)
                )
            )
            .scalars()
            .all()
        )
        rows = (
            await db.execute(
                select(
                    PrintLogEntry.id,
                    PrintLogEntry.status,
                    PrintArchive.library_file_id,
                    PrintLogEntry.failure_dismissed_at,
                )
                .outerjoin(PrintArchive, PrintLogEntry.archive_id == PrintArchive.id)
                .where(PrintArchive.library_file_id.in_(file_ids))
                .where(PrintLogEntry.created_at >= since)
            )
        ).all()
        for log_id, status, library_file_id, dismissed_at in rows:
            if library_file_id is None:
                continue
            sid = file_to_slot.get(int(library_file_id))
            if sid is None:
                continue
            st = (status or "").strip().lower()
            if dismissed_at is not None:
                # Discarded floor reason: completed plate scrap reverts to success;
                # mid-print failures are omitted from slot job rates.
                if st in _SUCCESS_STATUSES:
                    job_ok[sid] += 1
                continue
            if st in _SUCCESS_STATUSES:
                if log_id in plate_fail_log_ids:
                    job_fail[sid] += 1
                else:
                    job_ok[sid] += 1
            elif st in _FAIL_STATUSES:
                job_fail[sid] += 1

        batch_rows = (
            await db.execute(
                select(FloorBinBatch, PrintArchive.library_file_id)
                .join(PrintArchive, FloorBinBatch.archive_id == PrintArchive.id)
                .where(PrintArchive.library_file_id.in_(file_ids))
                .where(FloorBinBatch.harvested_at >= since)
            )
        ).all()
        archives_with_bins: set[int] = set()
        for batch, library_file_id in batch_rows:
            if library_file_id is None:
                continue
            sid = file_to_slot.get(int(library_file_id))
            if sid is None:
                continue
            if batch.archive_id is not None:
                archives_with_bins.add(int(batch.archive_id))
            # A batch whose expected_quantity is unknown/invalid cannot be turned
            # into a harvest sample: backfilling from its own actual quantity
            # fabricates a perfect actual/actual == 1.0 rate. Skip it entirely.
            expected = batch.expected_quantity
            if expected is None or expected <= 0:
                continue
            actual = int(batch.quantity or 0)
            harvest_rates[sid].append(_clamp_rate(actual / expected))
            qc_details = (
                await db.execute(
                    select(FloorBinBatchEvent.details)
                    .where(
                        FloorBinBatchEvent.batch_id == batch.id,
                        FloorBinBatchEvent.action == "visual_qc_passed",
                    )
                    .order_by(FloorBinBatchEvent.occurred_at.desc(), FloorBinBatchEvent.id.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if isinstance(qc_details, dict) and isinstance(qc_details.get("passed_quantity"), int) and actual > 0:
                qc_rates[sid].append(_clamp_rate(int(qc_details["passed_quantity"]) / actual))

        archive_rows = (
            await db.execute(
                select(PrintArchive.id, PrintArchive.library_file_id)
                .where(PrintArchive.library_file_id.in_(file_ids))
                .where(PrintArchive.created_at >= since)
            )
        ).all()
        archive_to_slot = {
            int(aid): file_to_slot[int(lfid)]
            for aid, lfid in archive_rows
            if aid is not None and lfid is not None and int(lfid) in file_to_slot
        }
        sticker_archives = {aid: sid for aid, sid in archive_to_slot.items() if aid not in archives_with_bins}
        if sticker_archives:
            part_counts: dict[int, int] = dict.fromkeys(sticker_archives, 0)
            part_to_archive: dict[int, int] = {}
            part_rows = (
                await db.execute(
                    select(FloorLabeledPart.id, FloorLabeledPart.archive_id)
                    .where(FloorLabeledPart.archive_id.in_(list(sticker_archives.keys())))
                    .where(FloorLabeledPart.archived_at.is_(None))
                )
            ).all()
            for pid, archive_id in part_rows:
                if archive_id in part_counts:
                    part_counts[archive_id] += 1
                    part_to_archive[int(pid)] = int(archive_id)

            # QC for labeled parts: a part is "QC passed" only once it has been
            # fit-checked. Sanding is rework, not a QC pass, so it must NOT count.
            # Count the distinct passing parts per archive so the sticker path
            # derives a real qc_yield instead of the 1.0 default.
            qc_pass_counts: dict[int, int] = dict.fromkeys(sticker_archives, 0)
            if part_to_archive:
                event_rows = (
                    await db.execute(
                        select(FloorPartEvent.part_id)
                        .where(FloorPartEvent.part_id.in_(list(part_to_archive.keys())))
                        .where(FloorPartEvent.action == "fit_checked")
                        .distinct()
                    )
                ).all()
                for (pid,) in event_rows:
                    aid = part_to_archive.get(int(pid))
                    if aid is not None:
                        qc_pass_counts[aid] += 1

            slot_qty = {s.id: max(1, int(s.quantity or 1)) for s in slots}
            for aid, sid in sticker_archives.items():
                expected = slot_qty.get(sid, 1)
                actual = part_counts.get(aid, 0)
                # Archives with no labeled parts are "not harvested yet", not a
                # 0% yield. Counting them zeros capacity for slots that print
                # but have not entered floor labeling.
                if expected <= 0 or actual <= 0:
                    continue
                harvest_rates[sid].append(_clamp_rate(actual / expected))
                qc_rates[sid].append(_clamp_rate(qc_pass_counts.get(aid, 0) / actual))

    out: dict[int, SlotMetrics] = {}
    for sid in unique_ids:
        total_jobs = job_ok[sid] + job_fail[sid]
        if total_jobs >= _MIN_JOB_SAMPLES:
            success = job_ok[sid] / total_jobs
            used_default_success = False
        else:
            success = 1.0
            used_default_success = True

        h_samples = harvest_rates[sid]
        if len(h_samples) >= _MIN_HARVEST_SAMPLES:
            harvest = sum(h_samples) / len(h_samples)
            used_default_harvest = False
        else:
            harvest = 1.0
            used_default_harvest = True

        q_samples = qc_rates[sid]
        if len(q_samples) >= _MIN_HARVEST_SAMPLES:
            qc = sum(q_samples) / len(q_samples)
            used_default_qc = False
        else:
            qc = 1.0
            used_default_qc = True

        out[sid] = SlotMetrics(
            slot_id=sid,
            print_job_success=_clamp_rate(success),
            harvest_yield=_clamp_rate(harvest),
            qc_yield=_clamp_rate(qc),
            job_samples=total_jobs,
            harvest_samples=len(h_samples),
            using_defaults=used_default_success or used_default_harvest or used_default_qc,
        )
    return out
