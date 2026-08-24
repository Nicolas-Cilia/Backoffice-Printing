"""Path-aware gzip compression for HTTP responses.

The standard deploy exposes uvicorn directly (docker-compose publishes the
container port; there is no reverse proxy layer to compress for us), so
without this middleware every JSON payload — printer list + status, the
filament tracking plan, library listings — and the SPA's multi-megabyte JS
bundle crosses the wire uncompressed. Text/JSON payloads typically shrink
5-10x under gzip.

Starlette's ``GZipMiddleware`` does the actual compressing. This wrapper
adds one thing: a deterministic path-based bypass for routes where gzip is
useless or actively harmful, independent of which starlette release is
installed (requirements allow ``starlette>=1.3.1``; newer releases skip
image/video/font content types on their own, older ones compress
everything):

* Live streams — gzip on an MJPEG camera stream (``multipart/x-mixed-
  replace``) or an SSE progress feed adds per-chunk CPU and buffering
  latency for zero size win (JPEG frames are already compressed).
* Media — thumbnails, covers, photos, timelapse video: already-compressed
  bytes, and video seeking relies on Range/Content-Length semantics.
* File downloads — 3MF and export zips are deflate-compressed containers;
  re-compressing wastes CPU and drops the ``Content-Length`` browsers use
  for download progress bars.
"""

from __future__ import annotations

from starlette.middleware.gzip import GZipMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

# Substring match against the request path, same convention as
# PUBLIC_API_PATTERNS in backend.app.main (browsers load these via
# <img>/<video> src, so the two lists naturally overlap).
GZIP_EXCLUDED_PATH_SUBSTRINGS: tuple[str, ...] = (
    # Live streams
    "/camera/stream",  # MJPEG multipart/x-mixed-replace
    "/camera/snapshot",  # JPEG frames
    "/colors/sync",  # SSE progress feed (text/event-stream)
    # Media
    "/timelapse",
    "/photos/",
    "/thumbnail",  # also matches /plate-thumbnail/
    "/project-image/",
    "/cover",
    "/icon",
    "/qrcode",
    "/obico/cached-frame/",
    # File downloads (3MF/zip containers; keep Content-Length intact)
    "/download",  # also matches /download-zip
    "/export",
    "/dl/",
    # Generated label PDFs — served for printing/saving; clients (and the
    # integration tests) rely on an exact Content-Length
    "/inventory/labels",
    "/spoolman/labels",
    # Static media mounts
    "/img/",
    "/fonts/",
)

# Below this many bytes the gzip header/dictionary overhead eats the win;
# tiny JSON bodies (health checks, single-object responses) pass through.
GZIP_MINIMUM_SIZE = 1024

# zlib level 6 is the classic speed/ratio sweet spot; starlette's default 9
# burns roughly double the CPU for a low single-digit percent size gain.
GZIP_COMPRESS_LEVEL = 6


class PathAwareGZipMiddleware:
    """Gzip HTTP responses except on excluded streaming/media/download paths."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.gzip_app = GZipMiddleware(
            app,
            minimum_size=GZIP_MINIMUM_SIZE,
            compresslevel=GZIP_COMPRESS_LEVEL,
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and any(fragment in scope["path"] for fragment in GZIP_EXCLUDED_PATH_SUBSTRINGS):
            await self.app(scope, receive, send)
            return
        await self.gzip_app(scope, receive, send)
