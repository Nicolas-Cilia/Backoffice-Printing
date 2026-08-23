"""Tests for ``backend.app.core.compression`` — path-aware gzip.

The contract under test: JSON/text responses above the minimum size are
gzipped when the client advertises ``Accept-Encoding: gzip``, while
streaming/media/download paths bypass compression entirely so MJPEG
camera streams, SSE feeds, and 3MF downloads keep their exact bytes,
latency profile, and ``Content-Length``.

A minimal FastAPI app stands in for the real one: the middleware only
looks at the request path and delegates the rest to starlette's
``GZipMiddleware``, so spinning up the full Bambuddy app (DB, MQTT,
lifespan) would test starlette's plumbing, not our routing decision.
"""

from __future__ import annotations

import gzip

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from backend.app.core.compression import (
    GZIP_EXCLUDED_PATH_SUBSTRINGS,
    GZIP_MINIMUM_SIZE,
    PathAwareGZipMiddleware,
)

LARGE_PAYLOAD = {"rows": [{"index": i, "name": f"printer-{i}"} for i in range(200)]}


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()

    @app.get("/api/v1/printers")
    async def list_printers():
        return LARGE_PAYLOAD

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/api/v1/printers/1/camera/stream")
    async def camera_stream():
        async def frames():
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + b"\xff\xd8" * 2048

        return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame")

    @app.get("/api/v1/archives/1/download")
    async def download():
        # Stands in for a 3MF (zip container) download body.
        return StreamingResponse(iter([b"PK\x03\x04" + b"\x00" * 4096]), media_type="application/octet-stream")

    app.add_middleware(PathAwareGZipMiddleware)
    return TestClient(app)


class TestCompressedPaths:
    def test_large_json_is_gzipped(self, client: TestClient):
        response = client.get("/api/v1/printers", headers={"Accept-Encoding": "gzip"})
        assert response.status_code == 200
        assert response.headers.get("Content-Encoding") == "gzip"
        # httpx transparently decompresses; the JSON must round-trip intact.
        assert response.json() == LARGE_PAYLOAD

    def test_small_json_below_minimum_size_stays_identity(self, client: TestClient):
        response = client.get("/health", headers={"Accept-Encoding": "gzip"})
        assert response.status_code == 200
        assert "Content-Encoding" not in response.headers
        assert len(response.content) < GZIP_MINIMUM_SIZE

    def test_no_accept_encoding_stays_identity(self, client: TestClient):
        response = client.get("/api/v1/printers", headers={"Accept-Encoding": "identity"})
        assert response.status_code == 200
        assert "Content-Encoding" not in response.headers
        assert response.json() == LARGE_PAYLOAD


class TestExcludedPaths:
    def test_camera_stream_bypasses_gzip(self, client: TestClient):
        response = client.get(
            "/api/v1/printers/1/camera/stream",
            headers={"Accept-Encoding": "gzip"},
        )
        assert response.status_code == 200
        assert "Content-Encoding" not in response.headers
        assert response.content.startswith(b"--frame")

    def test_download_bypasses_gzip(self, client: TestClient):
        response = client.get("/api/v1/archives/1/download", headers={"Accept-Encoding": "gzip"})
        assert response.status_code == 200
        assert "Content-Encoding" not in response.headers
        assert response.content.startswith(b"PK\x03\x04")

    def test_exclusion_list_covers_streaming_and_media_routes(self):
        """Route families that must never be compressed. Substring style
        matches PUBLIC_API_PATTERNS in backend.app.main — if a fragment
        is renamed there, this pins the compression side of the pair."""
        for fragment in ("/camera/stream", "/timelapse", "/thumbnail", "/dl/", "/download"):
            assert fragment in GZIP_EXCLUDED_PATH_SUBSTRINGS


class TestTransparency:
    def test_gzipped_body_decompresses_to_original(self, client: TestClient):
        """Belt-and-braces: decode the raw stream manually rather than
        trusting httpx's transparent decompression."""
        with client.stream("GET", "/api/v1/printers", headers={"Accept-Encoding": "gzip"}) as response:
            raw = b"".join(response.iter_raw())
        assert raw[:2] == b"\x1f\x8b"  # gzip magic
        decompressed = gzip.decompress(raw)
        assert b"printer-199" in decompressed
