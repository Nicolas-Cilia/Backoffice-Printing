"""Version endpoint.

This fork removed in-app updating entirely. Upstream shipped an update checker
(`GET /updates/check`) and an in-app updater (`POST /updates/apply`); the latter
ran `git fetch` + `git reset --hard` inside the app directory and rewrote
`origin` whenever it did not already point at the configured repo. On a fork
that is a footgun with no upside: a single click could repoint the checkout at
upstream and hard-reset every local change away, and there is no release stream
of ours worth polling GitHub for.

Updating this install is a deliberate `git pull` on the Mac mini instead.

Only the version endpoint survives, because the sidebar and Settings display it,
along with ``parse_version`` / ``is_newer_version`` — pure comparison helpers
that SpoolBuddy imports to decide whether an ESP device's firmware is out of
date. That is device firmware, not this app, so it keeps working.
"""

import logging
import re

from fastapi import APIRouter

from backend.app.core.config import APP_VERSION, GITHUB_REPO

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/updates", tags=["updates"])


def parse_version(version: str) -> tuple:
    """Parse version string into tuple for comparison.

    Returns (major, minor, patch, micro, is_prerelease, prerelease_num)
    where is_prerelease is 0 for release, 1 for prerelease.
    This ensures releases sort higher than prereleases of same version.

    Examples:
        "0.1.5"    -> (0, 1, 5, 0, 0, 0)   # release
        "0.1.5b7"  -> (0, 1, 5, 0, 1, 7)   # beta 7
        "0.1.5b10" -> (0, 1, 5, 0, 1, 10)  # beta 10
        "0.1.8.1"  -> (0, 1, 8, 1, 0, 0)   # patch release
    """
    # Remove 'v' prefix if present
    version = version.lstrip("v")

    # Strip daily build suffix (e.g., "0.2.2b4-daily.20260313" -> "0.2.2b4")
    version = re.sub(r"-daily\.\d+$", "", version)

    # Match version pattern: major.minor.patch[.micro][b|beta|alpha|rc]N
    match = re.match(r"(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:b|beta|alpha|rc)?(\d+)?", version)

    if match:
        major = int(match.group(1))
        minor = int(match.group(2))
        patch = int(match.group(3))
        micro = int(match.group(4)) if match.group(4) else 0
        prerelease_num = int(match.group(5)) if match.group(5) else 0

        # Check if this is a prerelease (has b/beta/alpha/rc/daily suffix anywhere)
        is_prerelease = 1 if re.search(r"[a-zA-Z]", version) else 0

        return (major, minor, patch, micro, is_prerelease, prerelease_num)

    # Fallback: try simple split
    parts = []
    for part in version.split("."):
        try:
            parts.append(int(part))
        except ValueError:
            num = "".join(c for c in part if c.isdigit())
            parts.append(int(num) if num else 0)

    return tuple(parts) + (0, 0, 0)


def is_newer_version(latest: str, current: str) -> bool:
    """Check if latest version is newer than current.

    Properly handles prerelease versions:
    - 0.1.5 > 0.1.5b7 (release is newer than any beta)
    - 0.1.5b8 > 0.1.5b7 (later beta is newer)
    - 0.1.6b1 > 0.1.5 (next version beta is newer than current release)
    """
    try:
        latest_parsed = parse_version(latest)
        current_parsed = parse_version(current)

        # Compare (major, minor, patch, micro) first
        latest_base = latest_parsed[:4]
        current_base = current_parsed[:4]

        if latest_base > current_base:
            return True
        elif latest_base < current_base:
            return False

        # Same base version - compare prerelease status
        # is_prerelease: 0 = release, 1 = prerelease
        # Release (0) should be "greater" than prerelease (1)
        latest_is_prerelease = latest_parsed[4] if len(latest_parsed) > 4 else 0
        current_is_prerelease = current_parsed[4] if len(current_parsed) > 4 else 0

        if latest_is_prerelease < current_is_prerelease:
            # latest is release, current is prerelease -> latest is newer
            return True
        elif latest_is_prerelease > current_is_prerelease:
            # latest is prerelease, current is release -> latest is NOT newer
            return False

        # Both are same type (both release or both prerelease)
        # Compare prerelease numbers
        latest_prerelease_num = latest_parsed[5] if len(latest_parsed) > 5 else 0
        current_prerelease_num = current_parsed[5] if len(current_parsed) > 5 else 0

        return latest_prerelease_num > current_prerelease_num

    except Exception:
        return False


@router.get("/version")
async def get_version():
    """Get current application version.

    Note: Unauthenticated - needed to display version in UI without login.
    """
    return {
        "version": APP_VERSION,
        "repo": GITHUB_REPO,
    }
