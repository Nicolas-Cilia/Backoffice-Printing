"""The floor:scan permission and its upgrade path (docs/floor-plan.md §12).

The upgrade path matters more than the definition here. Bambuddy installs are
already running with configured groups, and the Floor feature is new — so no
existing group carries this permission. Without a backfill the scan page would
403 for every non-admin until an administrator granted it by hand, which
presents as "the new feature is broken" rather than "you need permission".
"""

from __future__ import annotations

from backend.app.core.permissions import (
    ALL_PERMISSIONS,
    DEFAULT_GROUPS,
    PERMISSION_CATEGORIES,
    Permission,
)


class TestFloorPermissionDefinition:
    def test_floor_scan_exists(self):
        assert Permission.FLOOR_SCAN == "floor:scan"

    def test_floor_scan_in_all_permissions(self):
        # ALL_PERMISSIONS is derived from the enum, and the Administrators
        # group is synced to it on every startup — so being here is what
        # grants admins the feature on upgrade, with no migration needed.
        assert "floor:scan" in ALL_PERMISSIONS

    def test_floor_scan_is_assignable_in_the_ui(self):
        # A permission absent from the categories map cannot be granted from
        # the group editor, so it would only ever reach admins.
        assert Permission.FLOOR_SCAN in PERMISSION_CATEGORIES["Floor"]

    def test_floor_scan_is_not_an_inventory_permission(self):
        # The point of a dedicated permission: claiming a station must not
        # require the ability to edit or delete spool inventory.
        for category, perms in PERMISSION_CATEGORIES.items():
            if category == "Floor":
                continue
            assert Permission.FLOOR_SCAN not in perms


class TestFloorPermissionInDefaultGroups:
    def test_administrators_get_it(self):
        assert "floor:scan" in DEFAULT_GROUPS["Administrators"]["permissions"]

    def test_operators_get_it(self):
        # Scanning stations is operator work by definition.
        assert "floor:scan" in DEFAULT_GROUPS["Operators"]["permissions"]

    def test_viewers_do_not(self):
        # A session is a write — it claims a station and locks others out.
        assert "floor:scan" not in DEFAULT_GROUPS["Viewers"]["permissions"]


class TestUpgradeBackfillRule:
    """The backfill keys off printers:control. These pin that rule so the
    trigger cannot be changed without a deliberate decision."""

    def test_operators_hold_the_backfill_trigger(self):
        # If Operators ever lost printers:control, the backfill would silently
        # stop reaching them on upgrade.
        assert "printers:control" in DEFAULT_GROUPS["Operators"]["permissions"]

    def test_viewers_do_not_hold_the_trigger(self):
        # Which is what keeps a Viewer-tier group out of the floor feature
        # when an existing install upgrades.
        assert "printers:control" not in DEFAULT_GROUPS["Viewers"]["permissions"]
