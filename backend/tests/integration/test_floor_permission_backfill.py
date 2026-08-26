"""Upgrade path for floor:scan (docs/floor-plan.md §12).

Bambuddy installs are already running with configured groups, and the Floor
feature is new — so no existing group carries floor:scan. Two mechanisms have
to cover that on upgrade, and these tests pin both:

  1. Administrators are synced to ALL_PERMISSIONS on every startup, so a newly
     added enum member reaches them with no migration of its own.
  2. Non-admin groups need an explicit backfill, keyed off printers:control.

Without (2), the scan page 403s for every operator until an administrator
grants the permission by hand — which presents as "the new feature is broken"
rather than "you need permission".
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.core import database as _database_module
from backend.app.core.database import seed_default_groups
from backend.app.models.group import Group


async def _set_perms(group_name: str, perms: list[str]) -> None:
    """Force a group's permission list, simulating a pre-upgrade install."""
    async with _database_module.async_session() as session:
        grp = (await session.execute(select(Group).where(Group.name == group_name))).scalar_one_or_none()
        assert grp is not None, f"group {group_name} not pre-seeded"
        grp.permissions = perms
        await session.commit()


async def _get_perms(group_name: str) -> set[str]:
    async with _database_module.async_session() as session:
        grp = (await session.execute(select(Group).where(Group.name == group_name))).scalar_one_or_none()
        assert grp is not None
        return set(grp.permissions or [])


async def _make_group(name: str, perms: list[str]) -> None:
    async with _database_module.async_session() as session:
        session.add(Group(name=name, description="test", permissions=perms, is_system=False))
        await session.commit()


# ``async_client`` is depended upon (even where unused) so pytest-asyncio uses
# the same event loop as the conftest fixture — see the note in
# test_read_permission_backfill_migration.py.


class TestFloorScanBackfill:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operators_gain_floor_scan_on_upgrade(self, async_client: AsyncClient):
        """The case that matters: an install running today, whose Operators
        group predates the Floor feature entirely."""
        await seed_default_groups()
        await _set_perms("Operators", ["printers:read", "printers:control", "queue:read_own"])

        await seed_default_groups()

        assert "floor:scan" in await _get_perms("Operators")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_administrators_gain_floor_scan_without_a_dedicated_backfill(self, async_client: AsyncClient):
        """Covered by the ALL_PERMISSIONS sync, not by the printers:control
        rule — so it holds even for an admin group with an odd permission set."""
        await seed_default_groups()
        await _set_perms("Administrators", ["settings:read"])

        await seed_default_groups()

        assert "floor:scan" in await _get_perms("Administrators")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_a_custom_group_with_printer_control_gains_it(self, async_client: AsyncClient):
        """Hand-made roles are the ones most likely to be missed by a
        name-based migration, so the rule keys off a permission instead."""
        await seed_default_groups()
        await _make_group("Bench Staff", ["printers:read", "printers:control"])

        await seed_default_groups()

        assert "floor:scan" in await _get_perms("Bench Staff")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_a_view_only_group_does_not_gain_it(self, async_client: AsyncClient):
        """A session claims a station and locks other devices out, so it is a
        write. Read-only roles must not silently acquire it."""
        await seed_default_groups()
        await _make_group("Front Desk", ["printers:read", "queue:read_own"])

        await seed_default_groups()

        assert "floor:scan" not in await _get_perms("Front Desk")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_backfill_is_idempotent(self, async_client: AsyncClient):
        """Runs on every startup, so a long-lived install must not accumulate
        duplicate entries in the JSON permission list."""
        await seed_default_groups()
        await seed_default_groups()
        await seed_default_groups()

        async with _database_module.async_session() as session:
            grp = (await session.execute(select(Group).where(Group.name == "Operators"))).scalar_one_or_none()
            assert grp is not None
            assert (grp.permissions or []).count("floor:scan") == 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_backfill_preserves_hand_added_permissions(self, async_client: AsyncClient):
        """Additive only — an administrator's manual grants must survive."""
        await seed_default_groups()
        await _make_group("Bench Staff", ["printers:control", "camera:view"])

        await seed_default_groups()

        perms = await _get_perms("Bench Staff")
        assert {"printers:control", "camera:view", "floor:scan"} <= perms
