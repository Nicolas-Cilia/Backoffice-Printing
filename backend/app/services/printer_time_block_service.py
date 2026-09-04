"""Recurring weekly printer time blocks — must-be-free windows for Stats 2 packing."""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.printer import Printer
from backend.app.models.printer_time_block import PrinterTimeBlock
from backend.app.services.stats2_config import hhmm_to_minutes, minutes_to_hhmm


class TimeBlockIn(BaseModel):
    """One reserved window in a printer's weekly template."""

    day_of_week: int = Field(ge=0, le=6)
    start_time: str
    end_time: str
    label: str | None = None
    enabled: bool = True


@dataclass(frozen=True)
class TimeBlockRow:
    id: int
    printer_id: int
    printer_name: str
    printer_model: str | None
    day_of_week: int
    start_time: str
    end_time: str
    label: str | None
    enabled: bool

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "printer_id": self.printer_id,
            "printer_name": self.printer_name,
            "printer_model": self.printer_model,
            "day_of_week": self.day_of_week,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "label": self.label,
            "enabled": self.enabled,
        }


def _validate_block(block: TimeBlockIn) -> None:
    if not (0 <= block.day_of_week <= 6):
        raise ValueError("day_of_week must be between 0 (Monday) and 6 (Sunday)")
    start = hhmm_to_minutes(block.start_time)
    end = hhmm_to_minutes(block.end_time)
    if start is None or end is None:
        raise ValueError("start_time and end_time must be HH:MM (24h)")
    if start >= end:
        raise ValueError("start_time must be before end_time (same-day blocks only)")
    if block.label is not None and len(block.label) > 128:
        raise ValueError("label must be at most 128 characters")


def blocks_for_day(
    blocks: list[PrinterTimeBlock] | list[TimeBlockRow],
    day_of_week: int,
) -> list[tuple[int, int, str | None]]:
    """Return ``(start_min, end_min, label)`` for ``day_of_week``."""
    out: list[tuple[int, int, str | None]] = []
    for b in blocks:
        if b.day_of_week != day_of_week or not b.enabled:
            continue
        start = hhmm_to_minutes(b.start_time)
        end = hhmm_to_minutes(b.end_time)
        if start is None or end is None or start >= end:
            continue
        out.append((start, end, b.label))
    out.sort(key=lambda t: t[0])
    return out


def intervals_by_printer_day(
    rows: list[PrinterTimeBlock] | list[TimeBlockRow],
) -> dict[int, dict[int, list[tuple[int, int, str | None]]]]:
    """``printer_id → day_of_week → [(start_min, end_min, label), ...]`` for enabled rows."""
    indexed: dict[int, dict[int, list[tuple[int, int, str | None]]]] = {}
    for b in rows:
        if not b.enabled:
            continue
        start = hhmm_to_minutes(b.start_time)
        end = hhmm_to_minutes(b.end_time)
        if start is None or end is None or start >= end:
            continue
        indexed.setdefault(b.printer_id, {}).setdefault(b.day_of_week, []).append((start, end, b.label))
    for by_day in indexed.values():
        for dow in by_day:
            by_day[dow].sort(key=lambda t: t[0])
    return indexed


def project_blocks_for_packing_day(
    by_dow: dict[int, list[tuple[int, int, str | None]]],
    *,
    day_of_week: int,
    horizon_days: int = 3,
) -> list[tuple[int, int]]:
    """Project weekly blocks onto absolute minutes from packing-day midnight.

    Day 0 = today (``day_of_week``), day 1 = tomorrow, etc. Returns ``(start, end)``
    without labels for overlap checks.
    """
    projected: list[tuple[int, int]] = []
    for offset in range(max(0, int(horizon_days))):
        dow = (day_of_week + offset) % 7
        base = offset * 24 * 60
        for start, end, _label in by_dow.get(dow, []):
            projected.append((start + base, end + base))
    projected.sort(key=lambda t: t[0])
    return projected


def intervals_overlap(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    """Half-open ``[a_start, a_end)`` vs ``[b_start, b_end)``."""
    return a_start < b_end and b_start < a_end


def next_start_avoiding_blocks(
    cursor: int,
    windows: list[tuple[int, int]],
    blocks: list[tuple[int, int]],
    *,
    print_min: int,
    clear_minutes: int,
    next_clear_start_fn,
    day_limit: int,
    max_attempts: int = 48,
) -> int | None:
    """Earliest staffed start >= ``cursor`` whose ``[start, clear_end)`` misses all blocks.

    ``next_clear_start_fn(finish, windows, clear_minutes) -> (clear_start, clear_end)``.
    """
    from backend.app.services.capacity_analysis import _next_staffed_start

    attempt = 0
    start_guess = cursor
    while attempt < max_attempts:
        attempt += 1
        start = _next_staffed_start(start_guess, windows)
        if start is None or start >= day_limit:
            return None
        end = start + max(1, int(print_min))
        _clear_start, clear_end = next_clear_start_fn(end, windows, clear_minutes)
        overlaps = False
        bump_to: int | None = None
        for b_start, b_end in blocks:
            if intervals_overlap(start, clear_end, b_start, b_end):
                overlaps = True
                # Jump to after this block (and keep the farthest bump if several hit).
                bump_to = b_end if bump_to is None else max(bump_to, b_end)
        if not overlaps:
            return start
        assert bump_to is not None
        if bump_to <= start_guess:
            start_guess = start + 1
        else:
            start_guess = bump_to
    return None


async def list_blocks(db: AsyncSession, *, enabled_only: bool = False) -> list[TimeBlockRow]:
    q = (
        select(PrinterTimeBlock, Printer.name, Printer.model)
        .join(Printer, Printer.id == PrinterTimeBlock.printer_id)
        .order_by(Printer.name, PrinterTimeBlock.day_of_week, PrinterTimeBlock.start_time)
    )
    if enabled_only:
        q = q.where(PrinterTimeBlock.enabled.is_(True))
    rows = (await db.execute(q)).all()
    return [
        TimeBlockRow(
            id=block.id,
            printer_id=block.printer_id,
            printer_name=name,
            printer_model=model,
            day_of_week=block.day_of_week,
            start_time=block.start_time,
            end_time=block.end_time,
            label=block.label,
            enabled=block.enabled,
        )
        for block, name, model in rows
    ]


async def list_blocks_for_printer(db: AsyncSession, printer_id: int) -> list[PrinterTimeBlock]:
    result = await db.execute(
        select(PrinterTimeBlock)
        .where(PrinterTimeBlock.printer_id == printer_id)
        .order_by(PrinterTimeBlock.day_of_week, PrinterTimeBlock.start_time)
    )
    return list(result.scalars().all())


async def replace_blocks_for_printer(
    db: AsyncSession,
    printer_id: int,
    rows: list[TimeBlockIn],
) -> list[PrinterTimeBlock]:
    """Replace one printer's weekly template. Does not commit."""
    printer = (await db.execute(select(Printer).where(Printer.id == printer_id))).scalar_one_or_none()
    if printer is None:
        raise ValueError(f"printer {printer_id} not found")

    for row in rows:
        _validate_block(row)

    await db.execute(delete(PrinterTimeBlock).where(PrinterTimeBlock.printer_id == printer_id))
    created: list[PrinterTimeBlock] = []
    for row in rows:
        block = PrinterTimeBlock(
            printer_id=printer_id,
            day_of_week=row.day_of_week,
            start_time=minutes_to_hhmm(hhmm_to_minutes(row.start_time) or 0),
            end_time=minutes_to_hhmm(hhmm_to_minutes(row.end_time) or 0),
            label=(row.label.strip() if row.label and row.label.strip() else None),
            enabled=bool(row.enabled),
        )
        db.add(block)
        created.append(block)
    await db.flush()
    return created
