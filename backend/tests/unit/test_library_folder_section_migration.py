"""Migration test for the folder-sections feature — library_folders.section_id.

Existing installs have a `library_folders` table predating the `section_id`
column and the brand-new `library_folder_sections` table. `run_migrations`
must add the column (idempotently) without requiring the referenced table to
already exist in the "legacy" fixture — `Base.metadata.create_all()` (which
always runs before `run_migrations` in `init_db`) creates the new table
first, mirroring production startup order.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import run_migrations

LEGACY_LIBRARY_FOLDERS = """
CREATE TABLE library_folders (
    id INTEGER PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    parent_id INTEGER,
    is_external BOOLEAN DEFAULT 0,
    external_readonly BOOLEAN DEFAULT 0,
    external_show_hidden BOOLEAN DEFAULT 0,
    external_path VARCHAR(500),
    project_id INTEGER,
    archive_id INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    from backend.app.core import database as database_module, db_dialect

    monkeypatch.setattr(db_dialect, "is_sqlite", lambda: True)
    monkeypatch.setattr(db_dialect, "is_postgres", lambda: False)
    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)


@pytest.fixture
async def legacy_engine():
    """A modern schema with a pre-folder-sections `library_folders` table
    holding one row, mirroring an install upgrading from before this feature.

    Every other table (including the brand-new `library_folder_sections`,
    which `create_all()` builds since the model is registered) is created in
    its current shape via `create_all()` — `run_migrations` touches dozens of
    unrelated tables and would fail outright if they didn't exist, exactly
    like the other migration tests in this suite (see
    `test_smart_plug_power_flag_migration_2629.py`). Only `library_folders`
    itself is then dropped and recreated in its pre-#folder-sections shape.
    """
    from backend.app.core.database import Base
    from backend.app.models import (  # noqa: F401
        ams_history,
        ams_label,
        api_key,
        archive,
        color_catalog,
        external_link,
        filament,
        group,
        kprofile_note,
        library,
        maintenance,
        notification,
        notification_template,
        pipeline_run,
        print_log,
        print_queue,
        printer,
        production,
        settings,
        slot_preset,
        smart_plug,
        smart_plug_energy_snapshot,
        spool,
        spool_assignment,
        spool_catalog,
        spool_k_profile,
        spool_usage_history,
        spoolbuddy_device,
        user,
        user_email_pref,
        virtual_printer,
    )

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text("DROP TABLE library_folders"))
        await conn.execute(text(LEGACY_LIBRARY_FOLDERS))
        await conn.execute(text("INSERT INTO library_folders (id, name) VALUES (1, 'Widgets')"))
    yield engine
    await engine.dispose()


async def test_column_missing_before_migration(legacy_engine):
    """Sanity check so the assertion below can't pass by accident."""
    async with legacy_engine.begin() as conn:
        columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(library_folders)"))}
    assert "section_id" not in columns


async def test_migration_adds_nullable_section_id(legacy_engine):
    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    async with legacy_engine.begin() as conn:
        columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(library_folders)"))}
        assert "section_id" in columns
        # Existing rows backfill to NULL ("Ungrouped"), never a garbage default.
        result = await conn.execute(text("SELECT section_id FROM library_folders WHERE id = 1"))
        assert result.scalar_one() is None


async def test_migration_is_idempotent(legacy_engine):
    async with legacy_engine.begin() as conn:
        await run_migrations(conn)
    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    async with legacy_engine.begin() as conn:
        columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(library_folders)"))}
    assert "section_id" in columns


async def test_folder_can_be_linked_to_a_section_after_migration(legacy_engine):
    """End-to-end sanity: after the ALTER, a folder row can actually store a
    real section_id (proves the column isn't just present but unusable)."""
    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    async with legacy_engine.begin() as conn:
        await conn.execute(
            text("INSERT INTO library_folder_sections (id, name, name_key, sort_order) VALUES (1, 'Prod', 'prod', 1)")
        )
        await conn.execute(text("UPDATE library_folders SET section_id = 1 WHERE id = 1"))

    async with legacy_engine.connect() as conn:
        result = await conn.execute(text("SELECT section_id FROM library_folders WHERE id = 1"))
        assert result.scalar_one() == 1
