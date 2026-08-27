#!/usr/bin/env python3
"""Seed the local database with sample data for development / demos.

This populates the app with data that normally requires real hardware so the
UI has something to show and code changes can be exercised end-to-end:

- Offline printers (a small mixed Bambu farm). They will show as offline/
  never-connecting because there is no real hardware behind the IPs — that is
  expected and intended.
- Storage locations and a filament inventory (spools, some low on stock).
- Per-printer maintenance items with a mix of OK / warning / overdue status.
- Print history (completed + a few failed runs) so the Stats page is populated.

The script is idempotent: every run first removes rows it previously created
(identified by stable sample markers) and then re-inserts a clean sample set.
It never touches non-sample rows.

Usage (from the repository root, with the venv active):

    python scripts/seed_sample_data.py          # reset + insert sample data
    python scripts/seed_sample_data.py --clear   # remove sample data only

It writes to the same database the backend uses (SQLite ``bambuddy.db`` at the
repo root by default, or ``DATABASE_URL`` / ``DATA_DIR`` if configured), so the
running app picks the data up on the next page refresh.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

# Allow running as `python scripts/seed_sample_data.py` from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import delete, select  # noqa: E402

from backend.app.api.routes.maintenance import (  # noqa: E402
    _should_apply_to_printer,
    ensure_default_types,
    get_printer_total_hours,
)
from backend.app.core.database import async_session, init_db  # noqa: E402
from backend.app.models.archive import PrintArchive  # noqa: E402
from backend.app.models.location import Location  # noqa: E402
from backend.app.models.maintenance import (  # noqa: E402
    MaintenanceHistory,
    MaintenanceType,
    PrinterMaintenance,
)
from backend.app.models.print_log import PrintLogEntry  # noqa: E402
from backend.app.models.printer import Printer  # noqa: E402
from backend.app.models.spool import Spool  # noqa: E402


def _utcnow_naive() -> datetime:
    """DB columns store naive datetimes; keep sample timestamps naive-UTC."""
    return datetime.now(UTC).replace(tzinfo=None)


# Stable markers so re-runs (and --clear) only ever affect sample rows.
SEED_SERIAL_PREFIX = "SEED"
SEED_LOCATION_TAG = "sample-seed"
SEED_SPOOL_NOTE = "[sample-seed]"
SEED_ARCHIVE_PATH_PREFIX = "sample-seed/"


def _name_key(name: str) -> str:
    return name.strip().lower()


# --- Sample definitions ------------------------------------------------------

PRINTERS = [
    {
        "name": "Farm-01 X1C",
        "serial_number": "SEED01X1C0000001",
        "ip_address": "10.20.0.11",
        "access_code": "00000001",
        "model": "X1C",
        "location": "Main Floor",
        "offset_hours": 312.5,
    },
    {
        "name": "Farm-02 P1S",
        "serial_number": "SEED02P1S0000002",
        "ip_address": "10.20.0.12",
        "access_code": "00000002",
        "model": "P1S",
        "location": "Main Floor",
        "offset_hours": 148.0,
    },
    {
        "name": "Farm-03 A1",
        "serial_number": "SEED03A10000003",
        "ip_address": "10.20.0.13",
        "access_code": "00000003",
        "model": "A1",
        "location": "Prototype Bench",
        "offset_hours": 76.0,
    },
    {
        "name": "Farm-04 A1 mini",
        "serial_number": "SEED04A1M000004",
        "ip_address": "10.20.0.14",
        "access_code": "00000004",
        "model": "A1 Mini",
        "location": "Prototype Bench",
        "offset_hours": 421.0,
    },
]

LOCATIONS = ["Drybox A", "Shelf B1", "Drawer C2"]

# (material, subtype, color_name, rgba, brand, label_g, used_g, cost/kg, location)
SPOOLS = [
    ("PLA", "Basic", "Jade White", "F5F5F5FF", "Bambu Lab", 1000, 120.0, 24.99, "Shelf B1"),
    ("PLA", "Matte", "Charcoal", "2B2B2BFF", "Bambu Lab", 1000, 640.0, 24.99, "Shelf B1"),
    ("PLA", "Silk", "Gold", "D4AF37FF", "Polymaker", 1000, 910.0, 29.99, "Drawer C2"),
    ("PETG", "Basic", "Signal Red", "C0392BFF", "Prusament", 1000, 350.0, 32.50, "Drybox A"),
    ("PETG", "Basic", "Cyan", "17A2B8FF", "Overture", 1000, 60.0, 21.99, "Drybox A"),
    ("ABS", "Basic", "Black", "1A1A1AFF", "Bambu Lab", 1000, 780.0, 27.99, "Drybox A"),
    ("TPU", "95A", "Neon Green", "39FF14FF", "SUNLU", 1000, 205.0, 26.50, "Drawer C2"),
    ("ASA", "Basic", "Grey", "808080FF", "Polymaker", 1000, 970.0, 34.00, "Drybox A"),
]

# Sample print jobs used to build history. (name, filament_type, grams, minutes,
# layer_height, status). Distributed across printers and recent dates below.
PRINT_JOBS = [
    ("Benchy", "PLA", 12.5, 48, 0.20, "completed"),
    ("Voron Gantry Clip", "ABS", 34.0, 92, 0.20, "completed"),
    ("Phone Stand", "PETG", 58.0, 165, 0.24, "completed"),
    ("Cable Chain x10", "PETG", 96.0, 288, 0.20, "completed"),
    ("Articulated Dragon", "PLA", 145.0, 640, 0.16, "completed"),
    ("Enclosure Bracket", "ASA", 72.0, 210, 0.28, "completed"),
    ("Gridfinity Bins x6", "PLA", 210.0, 520, 0.20, "completed"),
    ("Flexi Keychain", "TPU", 8.0, 41, 0.20, "completed"),
    ("Fan Duct", "ABS", 22.0, 78, 0.20, "failed"),
    ("Vase Mode Pot", "PLA", 61.0, 190, 0.30, "completed"),
    ("Tool Holder", "PETG", 88.0, 250, 0.24, "completed"),
    ("Prototype Housing", "ASA", 130.0, 470, 0.20, "failed"),
]


async def clear_sample_data(session) -> dict[str, int]:
    """Remove all rows previously created by this script. Returns counts."""
    counts: dict[str, int] = {}

    # Archives (history) by sample file_path prefix.
    res = await session.execute(select(PrintArchive).where(PrintArchive.file_path.like(f"{SEED_ARCHIVE_PATH_PREFIX}%")))
    archives = list(res.scalars().all())
    archive_ids = [a.id for a in archives]

    # Print-log entries drive the Stats page. Delete ours before the archives
    # (archive deletion only SET NULLs archive_id, which would orphan them).
    res = await session.execute(select(Printer).where(Printer.serial_number.like(f"{SEED_SERIAL_PREFIX}%")))
    seeded_printers = list(res.scalars().all())
    seeded_printer_ids = [p.id for p in seeded_printers]
    log_conditions = []
    if archive_ids:
        log_conditions.append(PrintLogEntry.archive_id.in_(archive_ids))
    if seeded_printer_ids:
        log_conditions.append(PrintLogEntry.printer_id.in_(seeded_printer_ids))
    if log_conditions:
        from sqlalchemy import or_

        del_res = await session.execute(delete(PrintLogEntry).where(or_(*log_conditions)))
        counts["print_log_entries"] = del_res.rowcount or 0
    else:
        counts["print_log_entries"] = 0

    for a in archives:
        await session.delete(a)
    counts["archives"] = len(archives)

    # Sample spools by note marker.
    res = await session.execute(select(Spool).where(Spool.note.like(f"%{SEED_SPOOL_NOTE}%")))
    spools = list(res.scalars().all())
    for s in spools:
        await session.delete(s)
    counts["spools"] = len(spools)

    # Printers by serial prefix. Maintenance items/history cascade via the ORM
    # relationships (delete-orphan) once the printer is loaded.
    if seeded_printer_ids:
        # Delete maintenance history + items explicitly (belt and suspenders —
        # covers rows whose printer_id may be set independently).
        await session.execute(delete(MaintenanceHistory).where(MaintenanceHistory.printer_id.in_(seeded_printer_ids)))
        await session.execute(delete(PrinterMaintenance).where(PrinterMaintenance.printer_id.in_(seeded_printer_ids)))
    for p in seeded_printers:
        await session.delete(p)
    counts["printers"] = len(seeded_printers)

    # Sample locations by identifier tag.
    res = await session.execute(select(Location).where(Location.identifier == SEED_LOCATION_TAG))
    locations = list(res.scalars().all())
    for loc in locations:
        await session.delete(loc)
    counts["locations"] = len(locations)

    await session.commit()
    return counts


async def insert_sample_data(session) -> dict[str, int]:
    counts: dict[str, int] = {}
    now = _utcnow_naive()

    # Locations -------------------------------------------------------------
    # name / name_key are globally unique. Reuse a same-named location if one
    # already exists (real user data) instead of failing the whole seed; only
    # count/own the ones we create.
    location_by_name: dict[str, Location] = {}
    created_locations = 0
    for name in LOCATIONS:
        existing = await session.execute(select(Location).where(Location.name_key == _name_key(name)))
        loc = existing.scalar_one_or_none()
        if loc is None:
            loc = Location(name=name, name_key=_name_key(name), identifier=SEED_LOCATION_TAG)
            session.add(loc)
            created_locations += 1
        location_by_name[name] = loc
    await session.flush()
    counts["locations"] = created_locations

    # Printers --------------------------------------------------------------
    printers: list[Printer] = []
    for spec in PRINTERS:
        printer = Printer(
            name=spec["name"],
            serial_number=spec["serial_number"],
            ip_address=spec["ip_address"],
            access_code=spec["access_code"],
            model=spec["model"],
            location=spec["location"],
            is_active=True,
            print_hours_offset=spec["offset_hours"],
            runtime_seconds=0,
        )
        session.add(printer)
        printers.append(printer)
    await session.flush()
    counts["printers"] = len(printers)

    # Maintenance -----------------------------------------------------------
    await ensure_default_types(session)
    res = await session.execute(
        select(MaintenanceType).where(MaintenanceType.is_system.is_(True), MaintenanceType.is_deleted.is_(False))
    )
    system_types = list(res.scalars().all())

    maint_items = 0
    maint_history = 0
    for printer in printers:
        total_hours = await get_printer_total_hours(session, printer.id)
        # Vary how "used up" each interval is so the page shows OK/warning/overdue.
        # step cycles the fraction of the interval already elapsed.
        for idx, mtype in enumerate(t for t in system_types if not getattr(t, "is_adhoc", False)):
            if not _should_apply_to_printer(mtype.name, printer.model):
                continue
            interval = mtype.default_interval_hours or 100.0
            # Fraction of the interval consumed since last service: cycles
            # 0.4 (OK) -> 0.95 (warning, <=10% left) -> 1.25 (overdue).
            fraction = (0.4, 0.95, 1.25)[idx % 3]
            hours_since = interval * fraction
            last_hours = max(0.0, total_hours - hours_since)
            # Approximate a calendar date for "last performed" (~1 print hour/day).
            last_at = now - timedelta(days=min(120, hours_since))
            item = PrinterMaintenance(
                printer_id=printer.id,
                maintenance_type_id=mtype.id,
                enabled=True,
                last_performed_hours=last_hours,
                last_performed_at=last_at,
            )
            session.add(item)
            await session.flush()
            maint_items += 1
            # Add one history entry so the log isn't empty.
            session.add(
                MaintenanceHistory(
                    printer_maintenance_id=item.id,
                    printer_id=printer.id,
                    performed_at=last_at,
                    hours_at_maintenance=last_hours,
                    title=mtype.name,
                    notes="Sample maintenance log entry.",
                )
            )
            maint_history += 1
    counts["maintenance_items"] = maint_items
    counts["maintenance_history"] = maint_history

    # Spools ----------------------------------------------------------------
    for material, subtype, color, rgba, brand, label_g, used_g, cost, loc_name in SPOOLS:
        loc = location_by_name.get(loc_name)
        session.add(
            Spool(
                material=material,
                subtype=subtype,
                color_name=color,
                rgba=rgba,
                brand=brand,
                label_weight=label_g,
                core_weight=250,
                weight_used=used_g,
                cost_per_kg=cost,
                location_id=loc.id if loc else None,
                storage_location=loc_name,
                category="Production",
                note=f"Demo spool {SEED_SPOOL_NOTE}",
                last_used=now - timedelta(days=2),
            )
        )
    counts["spools"] = len(SPOOLS)

    # Print history ---------------------------------------------------------
    # Each job creates a PrintArchive (file-level history, shown in Files /
    # archives) and a PrintLogEntry (event-level, which the Stats page
    # aggregates over).
    archives = 0
    log_entries = 0
    for i, (job_name, fil_type, grams, minutes, layer_h, status) in enumerate(PRINT_JOBS):
        printer = printers[i % len(printers)]
        completed = now - timedelta(days=(i * 3) + 1, hours=(i % 5))
        started = completed - timedelta(minutes=minutes)
        cost = round(grams / 1000.0 * 26.0, 2)
        energy = round(minutes / 60.0 * 0.11, 3)
        energy_cost = round(energy * 0.30, 2)
        slug = job_name.lower().replace(" ", "_")
        archive = PrintArchive(
            printer_id=printer.id,
            filename=f"{slug}.3mf",
            file_path=f"{SEED_ARCHIVE_PATH_PREFIX}{slug}.3mf",
            file_size=1024 * (200 + i * 37),
            print_name=job_name,
            print_time_seconds=minutes * 60,
            filament_used_grams=grams,
            filament_type=fil_type,
            layer_height=layer_h,
            sliced_for_model=printer.model,
            status=status,
            started_at=started,
            completed_at=completed,
            cost=cost,
            energy_kwh=energy,
            energy_cost=energy_cost,
            quantity=1,
            failure_reason="Spaghetti / layer shift" if status == "failed" else None,
            extra_data={"seed": True},
        )
        session.add(archive)
        await session.flush()
        archives += 1

        session.add(
            PrintLogEntry(
                archive_id=archive.id,
                print_name=job_name,
                printer_name=printer.name,
                printer_id=printer.id,
                status=status,
                started_at=started,
                completed_at=completed,
                duration_seconds=minutes * 60,
                filament_type=fil_type,
                filament_used_grams=grams,
                cost=cost,
                energy_kwh=energy,
                energy_cost=energy_cost,
                failure_reason="Spaghetti / layer shift" if status == "failed" else None,
                created_at=completed,
            )
        )
        log_entries += 1
    counts["archives"] = archives
    counts["print_log_entries"] = log_entries

    await session.commit()
    return counts


async def main(clear_only: bool) -> None:
    # Ensure schema + migrations are applied before touching tables.
    await init_db()

    async with async_session() as session:
        removed = await clear_sample_data(session)
        removed_summary = ", ".join(f"{k}={v}" for k, v in removed.items())
        print(f"Cleared existing sample data: {removed_summary}")

        if clear_only:
            print("Done (clear only).")
            return

        added = await insert_sample_data(session)
        added_summary = ", ".join(f"{k}={v}" for k, v in added.items())
        print(f"Inserted sample data: {added_summary}")
        print("Done. Refresh the app to see the sample data.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed sample data for local development.")
    parser.add_argument(
        "--clear",
        action="store_true",
        help="Only remove previously seeded sample data; do not insert new rows.",
    )
    args = parser.parse_args()
    asyncio.run(main(clear_only=args.clear))
