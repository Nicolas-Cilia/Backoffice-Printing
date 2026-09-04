"""Stats 2 production yield, funnel, and stage-loss aggregates."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.floor_bin import FloorBinBatch, FloorBinBatchEvent
from backend.app.models.floor_part import FloorLabeledPart, FloorPartEvent
from backend.app.services.expected_quantity import SOURCE_DEFAULT, resolve_expected_quantity
from backend.app.services.production_filename import parse_production_filename

_DEFAULT_LOOKBACK_DAYS = 30


def _pct(actual: float, expected: float) -> float | None:
    if expected <= 0:
        return None
    return round(100.0 * actual / expected, 2)


async def compute_yield_summary(
    db: AsyncSession,
    *,
    lookback_days: int = _DEFAULT_LOOKBACK_DAYS,
    part_code: str | None = None,
) -> dict:
    """Expected vs actual through harvest → QC → WIP → shipped, by part_code."""
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=max(1, lookback_days))
    filter_code = part_code.strip().upper() if part_code else None

    # Accumulators
    expected: dict[str, float] = defaultdict(float)
    harvested: dict[str, float] = defaultdict(float)
    qc_passed: dict[str, float] = defaultdict(float)
    wip: dict[str, float] = defaultdict(float)
    shipped: dict[str, float] = defaultdict(float)
    plates: dict[str, int] = defaultdict(int)

    # Bin path (KNB/BUT bins only). BOT is tracked through the sticker pipeline
    # below; counting BOT bins here too would double-count harvested/plates.
    batches = (await db.execute(select(FloorBinBatch).where(FloorBinBatch.harvested_at >= since))).scalars().all()
    for batch in batches:
        code = (batch.part_code or "").strip().upper()
        if not code:
            continue
        if code == "BOT":
            continue
        if filter_code and code != filter_code:
            continue
        exp = batch.expected_quantity
        if exp is None or exp <= 0:
            resolved = await resolve_expected_quantity(db, batch.archive_id)
            # SOURCE_DEFAULT (quantity=1) is a last-resort fabricator — do not
            # inflate expected_total (mirrors harvest_variance).
            exp = None if resolved.source == SOURCE_DEFAULT else resolved.quantity
        actual = int(batch.quantity or 0)
        if exp is not None and exp > 0:
            expected[code] += exp
        harvested[code] += actual
        plates[code] += 1

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
        if isinstance(qc_details, dict) and isinstance(qc_details.get("passed_quantity"), int):
            qc_passed[code] += max(0, qc_details["passed_quantity"])
        # No visual_qc_passed event → the batch has not been QC-passed. Do NOT
        # pass-through the harvested actual as QC-passed; that fabricates a 100%
        # QC yield for batches that were never inspected.

        events = (
            await db.execute(
                select(FloorBinBatchEvent.action, FloorBinBatchEvent.details)
                .where(FloorBinBatchEvent.batch_id == batch.id)
                .order_by(FloorBinBatchEvent.occurred_at)
            )
        ).all()
        actions = {a for a, _ in events}
        consumed = 0
        for action, details in events:
            if action == "consumed" and isinstance(details, dict):
                consumed += int(details.get("quantity") or details.get("consumed_quantity") or 0)
        qc_for_batch = (
            qc_details["passed_quantity"]
            if isinstance(qc_details, dict) and isinstance(qc_details.get("passed_quantity"), int)
            else actual
        )
        # Cumulative WIP entries (units that entered WIP), not remaining after
        # consume — frontend stillInWip = wip_total - shipped_total.
        if "wip" in actions or "ready_for_production" in actions:
            wip[code] += max(0, int(qc_for_batch))
        shipped[code] += consumed

    # Sticker path (TOP/BOT): group by archive
    parts = (
        (
            await db.execute(
                select(FloorLabeledPart)
                .where(FloorLabeledPart.labeled_at >= since)
                .where(FloorLabeledPart.archived_at.is_(None))
            )
        )
        .scalars()
        .all()
    )
    by_archive: dict[int, list[FloorLabeledPart]] = defaultdict(list)
    for part in parts:
        code = (part.part_code or "").strip().upper()
        if code not in {"TOP", "BOT"}:
            continue
        if filter_code and code != filter_code:
            continue
        if part.archive_id is None:
            continue
        by_archive[int(part.archive_id)].append(part)

    for archive_id, group in by_archive.items():
        code = (group[0].part_code or "").strip().upper()
        resolved = await resolve_expected_quantity(db, archive_id)
        if resolved.source != SOURCE_DEFAULT:
            expected[code] += resolved.quantity
        harvested[code] += len(group)
        plates[code] += 1

        part_ids = [p.id for p in group]
        events = (
            await db.execute(
                select(FloorPartEvent.part_id, FloorPartEvent.action)
                .where(FloorPartEvent.part_id.in_(part_ids))
                .order_by(FloorPartEvent.occurred_at)
            )
        ).all()
        actions_by_part: dict[int, set[str]] = defaultdict(set)
        for pid, action in events:
            actions_by_part[pid].add(action)

        for p in group:
            acts = actions_by_part.get(p.id, set())
            # Only fit_checked is a genuine QC pass; sanding is rework (aligns
            # with stats2_slot_metrics QC counting).
            if "fit_checked" in acts:
                qc_passed[code] += 1
            if "wip" in acts:
                wip[code] += 1
            if "shipped" in acts:
                shipped[code] += 1

    codes = sorted(set(expected) | set(harvested) | {"TOP", "BOT", "KNB", "BUT"})
    if filter_code:
        codes = [filter_code]

    parts_out = []
    for code in codes:
        exp = expected.get(code, 0)
        harv = harvested.get(code, 0)
        qc = qc_passed.get(code, 0)
        w = wip.get(code, 0)
        sh = shipped.get(code, 0)
        plate_n = plates.get(code, 0)
        eff = (harv / plate_n) if plate_n else 0
        # Prefer QC-adjusted effective when available
        if plate_n and qc:
            eff = qc / plate_n
        parts_out.append(
            {
                "part_code": code,
                "plates": plate_n,
                "expected_total": exp,
                "harvested_total": harv,
                "qc_passed_total": qc,
                "wip_total": w,
                "shipped_total": sh,
                "harvest_yield_pct": _pct(harv, exp),
                "qc_yield_pct": _pct(qc, harv),
                "wip_yield_pct": _pct(w, qc if qc else harv),
                "shipped_yield_pct": _pct(sh, w if w else qc),
                "effective_parts_per_plate": round(eff, 2),
            }
        )

    return {
        "lookback_days": lookback_days,
        "as_of": datetime.now(timezone.utc).isoformat(),
        "parts": parts_out,
    }


async def compute_yield_detail(db: AsyncSession, part_code: str, *, lookback_days: int = 30) -> dict:
    summary = await compute_yield_summary(db, lookback_days=lookback_days, part_code=part_code)
    code = part_code.strip().upper()
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=max(1, lookback_days))
    outliers = []

    # BOT flows through the sticker (labeled-part) pipeline in the summary, so
    # its detail outliers must too — only KNB/BUT are bin-tracked here.
    if code in {"KNB", "BUT"}:
        batches = (
            (
                await db.execute(
                    select(FloorBinBatch)
                    .where(FloorBinBatch.part_code == code)
                    .where(FloorBinBatch.harvested_at >= since)
                    .order_by(FloorBinBatch.harvested_at.desc())
                    .limit(50)
                )
            )
            .scalars()
            .all()
        )
        for batch in batches:
            exp = batch.expected_quantity or 0
            if exp <= 0:
                continue
            actual = int(batch.quantity or 0)
            variance = actual - exp
            if abs(variance) >= max(1, int(0.1 * exp)):
                outliers.append(
                    {
                        "archive_id": batch.archive_id,
                        "expected": exp,
                        "actual": actual,
                        "variance": variance,
                        "at": batch.harvested_at.isoformat() if batch.harvested_at else None,
                    }
                )
    else:
        # Sticker archives with harvest shortfall
        archives = (
            (
                await db.execute(
                    select(PrintArchive)
                    .where(PrintArchive.created_at >= since)
                    .order_by(PrintArchive.created_at.desc())
                    .limit(100)
                )
            )
            .scalars()
            .all()
        )
        for archive in archives:
            parsed = parse_production_filename(archive.filename or archive.print_name or "")
            if parsed is None or parsed.code != code:
                continue
            count = (
                await db.execute(
                    select(FloorLabeledPart.id)
                    .where(FloorLabeledPart.archive_id == archive.id)
                    .where(FloorLabeledPart.archived_at.is_(None))
                )
            ).all()
            actual = len(count)
            variance = actual - parsed.quantity
            if abs(variance) >= 1:
                outliers.append(
                    {
                        "archive_id": archive.id,
                        "filename": archive.filename,
                        "expected": parsed.quantity,
                        "actual": actual,
                        "variance": variance,
                        "at": archive.created_at.isoformat() if archive.created_at else None,
                    }
                )

    return {**summary, "part_code": code, "outliers": outliers[:20]}


async def compute_funnel(db: AsyncSession, *, lookback_days: int = 30) -> dict:
    """Print expected → harvested → QC → WIP → shipped → lost."""
    summary = await compute_yield_summary(db, lookback_days=lookback_days)
    totals = {
        "expected": 0.0,
        "harvested": 0.0,
        "qc_passed": 0.0,
        "wip": 0.0,
        "shipped": 0.0,
    }
    for p in summary["parts"]:
        totals["expected"] += p["expected_total"]
        totals["harvested"] += p["harvested_total"]
        totals["qc_passed"] += p["qc_passed_total"]
        totals["wip"] += p["wip_total"]
        totals["shipped"] += p["shipped_total"]
    lost = max(0.0, totals["expected"] - totals["shipped"])
    stages = [
        {"stage": "expected", "count": totals["expected"], "pct_of_expected": 100.0},
        {
            "stage": "harvested",
            "count": totals["harvested"],
            "pct_of_expected": _pct(totals["harvested"], totals["expected"]),
        },
        {
            "stage": "qc_passed",
            "count": totals["qc_passed"],
            "pct_of_expected": _pct(totals["qc_passed"], totals["expected"]),
        },
        {"stage": "wip", "count": totals["wip"], "pct_of_expected": _pct(totals["wip"], totals["expected"])},
        {
            "stage": "shipped",
            "count": totals["shipped"],
            "pct_of_expected": _pct(totals["shipped"], totals["expected"]),
        },
        {"stage": "lost", "count": lost, "pct_of_expected": _pct(lost, totals["expected"])},
    ]
    return {"lookback_days": lookback_days, "stages": stages, "by_part": summary["parts"]}


async def compute_losses(db: AsyncSession, *, lookback_days: int = 30) -> dict:
    funnel = await compute_funnel(db, lookback_days=lookback_days)
    stages = {s["stage"]: s["count"] for s in funnel["stages"]}
    losses = [
        {
            "stage": "print_to_harvest",
            "lost": max(0.0, stages.get("expected", 0) - stages.get("harvested", 0)),
        },
        {
            "stage": "harvest_to_qc",
            "lost": max(0.0, stages.get("harvested", 0) - stages.get("qc_passed", 0)),
        },
        {
            "stage": "qc_to_wip",
            "lost": max(0.0, stages.get("qc_passed", 0) - stages.get("wip", 0)),
        },
        {
            "stage": "wip_to_shipped",
            "lost": max(0.0, stages.get("wip", 0) - stages.get("shipped", 0)),
        },
    ]
    return {"lookback_days": lookback_days, "losses": losses, "funnel": funnel["stages"]}
