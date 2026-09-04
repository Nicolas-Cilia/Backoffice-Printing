#!/usr/bin/env python3
"""One-shot backfill of approximate plate-turnaround events from PrintLogEntry.

Derives finish → next-start gaps per printer and inserts
``PlateTurnaroundEvent`` rows with ``source=backfill``.

These rows are for Stats 2 *feedback* (cleanup target vs reality) only.
They are NEVER used as capacity inputs.

Usage (from repo root):

    python scripts/backfill_stats2_plate_turnaround.py
    python scripts/backfill_stats2_plate_turnaround.py --dry-run
    python scripts/backfill_stats2_plate_turnaround.py --lookback-days 180
    python scripts/backfill_stats2_plate_turnaround.py --max-gap-hours 48

Docker:

    docker exec -it bambuddy python scripts/backfill_stats2_plate_turnaround.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


def _load_dotenv() -> Path | None:
    env_file = PROJECT_ROOT / ".env"
    if not env_file.exists():
        return None
    for raw in env_file.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return env_file


_load_dotenv()

from backend.app.core.database import async_session, init_db  # noqa: E402
from backend.app.services.stats2_backfill import backfill_plate_turnaround_from_print_log  # noqa: E402


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Count candidates without writing")
    parser.add_argument(
        "--lookback-days",
        type=int,
        default=365,
        help="Only consider completed prints within this many days (default 365; 0 = all)",
    )
    parser.add_argument(
        "--max-gap-hours",
        type=float,
        default=72.0,
        help="Skip finish→next-start gaps larger than this (default 72h)",
    )
    args = parser.parse_args()
    lookback = None if args.lookback_days == 0 else args.lookback_days

    await init_db()
    async with async_session() as db:
        result = await backfill_plate_turnaround_from_print_log(
            db,
            lookback_days=lookback,
            dry_run=args.dry_run,
            max_gap_hours=args.max_gap_hours,
        )
        if not args.dry_run:
            await db.commit()

    mode = "DRY-RUN" if args.dry_run else "WRITE"
    print(f"[{mode}] printers={result.printers_scanned} candidates={result.candidates}")
    print(
        f"  inserted={result.inserted} skipped_existing={result.skipped_existing} "
        f"skipped_invalid={result.skipped_invalid}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
