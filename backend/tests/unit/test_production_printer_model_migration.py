"""Migration test for library_folders.production_printer_model (production file-slots).

Existing installs have a `library_folders` table predating this column.
`run_migrations` must add it idempotently. `Base.metadata.create_all()`
(which always runs before `run_migrations` in `init_db`) creates current
tables first, then this test drops `library_folders` and recreates it in
its pre-column shape — mirroring production startup order.
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
    archive_id INTEGER,
    section_id INTEGER,
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
    async with legacy_engine.begin() as conn:
        columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(library_folders)"))}
    assert "production_printer_model" not in columns


async def test_migration_adds_nullable_production_printer_model(legacy_engine):
    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    async with legacy_engine.begin() as conn:
        columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(library_folders)"))}
        assert "production_printer_model" in columns
        result = await conn.execute(text("SELECT production_printer_model FROM library_folders WHERE id = 1"))
        assert result.scalar_one() is None


async def test_migration_is_idempotent(legacy_engine):
    async with legacy_engine.begin() as conn:
        await run_migrations(conn)
    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    async with legacy_engine.begin() as conn:
        columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(library_folders)"))}
    assert "production_printer_model" in columns
