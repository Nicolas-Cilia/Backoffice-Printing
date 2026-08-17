"""Version endpoint.

This fork removed in-app updating entirely. Upstream shipped an update checker
(`GET /updates/check`) and an in-app updater (`POST /updates/apply`); the latter
ran `git fetch` + `git reset --hard` inside the app directory and rewrote
`origin` whenever it did not already point at the configured repo. On a fork
that is a footgun with no upside: a single click could repoint the checkout at
upstream and hard-reset every local change away, and there is no release stream
of ours worth polling GitHub for.

Updating this install is a deliberate `git pull` on the Mac mini instead.

Only the version endpoint survives, because the sidebar and Settings display it.
"""

import logging

from fastapi import APIRouter

from backend.app.core.config import APP_VERSION, GITHUB_REPO

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/updates", tags=["updates"])


@router.get("/version")
async def get_version():
    """Get current application version.

    Note: Unauthenticated - needed to display version in UI without login.
    """
    return {
        "version": APP_VERSION,
        "repo": GITHUB_REPO,
    }
