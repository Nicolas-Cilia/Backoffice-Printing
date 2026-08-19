"""Migration test for library_folder_sections.kind (production-kind sections)."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import run_migrations

LEGACY_SECTIONS = """
CREATE TABLE library_folder_sections (
    id INTEGER PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    name_key VARCHAR(255) NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0,
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
        await conn.execute(text("DROP TABLE library_folder_sections"))
        await conn.execute(text(LEGACY_SECTIONS))
        await conn.execute(
            text(
                "INSERT INTO library_folder_sections (id, name, name_key, sort_order) "
                "VALUES (1, 'Production', 'production', 1), (2, 'Tests', 'tests', 2)"
            )
        )
    yield engine
    await engine.dispose()


async def test_kind_missing_before_migration(legacy_engine):
    async with legacy_engine.begin() as conn:
        columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(library_folder_sections)"))}
    assert "kind" not in columns


async def test_migration_adds_kind_and_backfills_production(legacy_engine):
    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    async with legacy_engine.begin() as conn:
        columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(library_folder_sections)"))}
        assert "kind" in columns
        rows = {
            row[0]: row[1] for row in await conn.execute(text("SELECT name_key, kind FROM library_folder_sections"))
        }
        assert rows["production"] == "production"
        assert rows["tests"] == "normal"
