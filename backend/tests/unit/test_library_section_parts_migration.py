"""Migration test for section part templates and production parameter_notes columns."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import run_migrations

LEGACY_PRODUCTION_SLOTS = """
CREATE TABLE production_slots (
    id INTEGER PRIMARY KEY,
    instance_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    active_file_id INTEGER,
    major INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    minor INTEGER NOT NULL,
    parameter_overrides JSON,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""

LEGACY_PRODUCTION_REVISIONS = """
CREATE TABLE production_revisions (
    id INTEGER PRIMARY KEY,
    slot_id INTEGER NOT NULL,
    library_file_id INTEGER,
    major INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    minor INTEGER NOT NULL,
    parameters JSON,
    mismatch BOOLEAN DEFAULT 0,
    accepted_new_baseline BOOLEAN DEFAULT 0,
    reason TEXT,
    created_by_id INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    superseded_at DATETIME
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
        await conn.execute(text("DROP TABLE production_revisions"))
        await conn.execute(text("DROP TABLE production_slots"))
        await conn.execute(text(LEGACY_PRODUCTION_SLOTS))
        await conn.execute(text(LEGACY_PRODUCTION_REVISIONS))
    yield engine
    await engine.dispose()


async def test_library_section_parts_exists_after_create_all(legacy_engine):
    async with legacy_engine.begin() as conn:
        tables = {row[0] for row in await conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
    assert "library_section_parts" in tables


async def test_parameter_notes_missing_before_migration(legacy_engine):
    async with legacy_engine.begin() as conn:
        slot_columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(production_slots)"))}
        revision_columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(production_revisions)"))}
    assert "parameter_notes" not in slot_columns
    assert "parameter_notes" not in revision_columns


async def test_migration_adds_parameter_notes_columns(legacy_engine):
    async with legacy_engine.begin() as conn:
        await run_migrations(conn)

    async with legacy_engine.begin() as conn:
        slot_columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(production_slots)"))}
        revision_columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(production_revisions)"))}
    assert "parameter_notes" in slot_columns
    assert "parameter_notes" in revision_columns


async def test_migration_adds_section_part_sort_order(legacy_engine):
    async with legacy_engine.begin() as conn:
        await conn.execute(text("DROP TABLE library_section_parts"))
        await conn.execute(
            text(
                """
                CREATE TABLE library_section_parts (
                    id INTEGER PRIMARY KEY,
                    section_id INTEGER NOT NULL,
                    code VARCHAR(32) NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    locked_parameters JSON,
                    thumbnail_path VARCHAR(500),
                    created_at DATETIME,
                    updated_at DATETIME
                )
                """
            )
        )
        await conn.execute(
            text(
                "INSERT INTO library_section_parts (id, section_id, code, name) VALUES "
                "(1, 1, 'BOT', 'Bottom'), (2, 1, 'TOP', 'Top')"
            )
        )
        await run_migrations(conn)

    async with legacy_engine.begin() as conn:
        columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(library_section_parts)"))}
        rows = (
            await conn.execute(text("SELECT code, sort_order FROM library_section_parts ORDER BY sort_order, code"))
        ).all()
    assert "sort_order" in columns
    assert [(row[0], row[1]) for row in rows] == [("TOP", 0), ("BOT", 1)]
