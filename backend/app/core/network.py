"""Small helpers for discovering how to reach this host from the LAN."""

from __future__ import annotations

import logging
import os
import socket

logger = logging.getLogger(__name__)


def primary_lan_ipv4() -> str | None:
    """Best-effort primary LAN IPv4 for this machine.

    Uses a UDP connect trick (no packets sent) so we don't depend on
    ``hostname -I`` or platform-specific tools.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def log_lan_access_urls(*, port: int, host: str | None = None) -> None:
    """Log URLs other devices on the same network can use.

    Only emits when the process is bound to all interfaces (``0.0.0.0`` /
    ``::``). Loopback-only binds are intentionally silent.
    """
    bind_host = (host if host is not None else os.environ.get("HOST", "0.0.0.0")).strip()
    if bind_host not in {"0.0.0.0", "::"}:
        return

    lan_ip = primary_lan_ipv4()
    if not lan_ip:
        logger.info(
            "Listening on all interfaces (port %d). Open http://<this-machine-ip>:%d from other LAN devices.",
            port,
            port,
        )
        return

    logger.info(
        "LAN access: http://%s:%d  (floor tablets / phones on the same Wi‑Fi)",
        lan_ip,
        port,
    )
