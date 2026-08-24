"""Floor scanning routes (``docs/floor-plan.md``).

Phase 1a: the Codes page's Station-labels tab — list the stations, render
their QR labels as a PDF.

Phase 1b: station sessions — open / close / switch by scanning a `BBS-`
payload, with the floor-wide locks of §2.4 and the takeover that recovers a
station nobody is coming back to.

The rest of the scan routing (SKUs, parts, defects) lands here in later
phases; this module is the Floor feature's backend entry point.
"""

from __future__ import annotations

import io
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.floor_session import FloorStationSession
from backend.app.models.user import User
from backend.app.services.floor_codes import (
    FLOOR_STATIONS,
    MAX_LABEL_MM,
    MAX_LABELS_PER_REQUEST,
    MIN_LABEL_MM,
    CodeLabel,
    render_code_labels,
    station_for_payload,
    station_for_slug,
)
from backend.app.services.floor_sessions import (
    ScanResult,
    apply_station_scan,
    close_session_for_device,
    get_open_session_for_device,
    take_over,
)
from backend.app.utils.http import build_content_disposition

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/floor", tags=["floor"])


class FloorStationResponse(BaseModel):
    slug: str
    payload: str
    name: str
    description: str


class StationLabelRequest(BaseModel):
    """Which station labels to print, and at what physical size."""

    # Payloads rather than slugs: the payload is what the QR encodes and what
    # a pistol will emit, so a caller that round-trips it here can't silently
    # print a label whose code differs from the one it asked for.
    payloads: list[str] = Field(..., min_length=1, max_length=MAX_LABELS_PER_REQUEST)
    width_mm: float = Field(..., ge=MIN_LABEL_MM, le=MAX_LABEL_MM)
    height_mm: float = Field(..., ge=MIN_LABEL_MM, le=MAX_LABEL_MM)


@router.get("/stations", response_model=list[FloorStationResponse])
async def list_floor_stations(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[FloorStationResponse]:
    """The fixed station catalog (§5). Static in v1 — stations are a property
    of the documented workflow, not user-configurable data."""
    return [
        FloorStationResponse(
            slug=station.slug,
            payload=station.payload,
            name=station.name,
            description=station.description,
        )
        for station in FLOOR_STATIONS
    ]


@router.post("/labels/stations")
async def render_station_labels(
    body: StationLabelRequest,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> StreamingResponse:
    """Render station QR labels as a one-label-per-page PDF."""
    stations = []
    unknown = []
    for payload in body.payloads:
        station = station_for_payload(payload)
        if station is None:
            unknown.append(payload)
        else:
            stations.append(station)

    # Refuse rather than skip: a silently-short PDF is worse than an error,
    # because the missing label is only noticed once someone is at the shelf.
    if unknown:
        raise HTTPException(400, f"Unknown station code(s): {', '.join(unknown)}")

    labels = [CodeLabel(payload=s.payload, title=s.name) for s in stations]

    try:
        pdf = render_code_labels(labels, width_mm=body.width_mm, height_mm=body.height_mm)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    logger.info(
        "Rendered %d station label(s) at %gx%g mm",
        len(labels),
        body.width_mm,
        body.height_mm,
    )

    return StreamingResponse(
        io.BytesIO(pdf),
        media_type="application/pdf",
        headers={
            "Content-Disposition": build_content_disposition("bambuddy-station-labels.pdf", disposition="inline"),
            "Content-Length": str(len(pdf)),
            # Re-printing after a size change must not serve the old PDF.
            "Cache-Control": "no-store",
        },
    )


# --- Station sessions (phase 1b, §2.4) --------------------------------------


class SessionResponse(BaseModel):
    """One station session as the scan page needs it."""

    id: int
    station_slug: str
    station_name: str
    device_id: str
    opened_at: datetime
    # Server-computed so the screen does not depend on the kiosk's clock
    # being right — an unattended PC with a drifted clock would otherwise
    # render a nonsense elapsed time, which is the one number this indicator
    # exists to make trustworthy (§5.4).
    open_seconds: int


class ScanRequest(BaseModel):
    """A scanned `BBS-` payload, from a given device."""

    # The payload, not the slug: it is what the pistol emits, so a caller
    # round-tripping it cannot act on a station different from the one whose
    # label was physically scanned.
    payload: str = Field(..., min_length=1, max_length=256)
    device_id: str = Field(..., min_length=1, max_length=64)


class TakeoverRequest(BaseModel):
    """Take a station from whichever device currently holds it."""

    payload: str = Field(..., min_length=1, max_length=256)
    device_id: str = Field(..., min_length=1, max_length=64)


class ScanResponse(BaseModel):
    """What the scan did, and what the screen should now show."""

    result: ScanResult
    station_slug: str
    station_name: str
    # The session now open on this device; null after a close or a refusal.
    session: SessionResponse | None = None
    # Populated only on `locked`: who holds the station, and for how long.
    blocking: SessionResponse | None = None


def _to_session_response(session: FloorStationSession) -> SessionResponse:
    station = station_for_slug(session.station_slug)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return SessionResponse(
        id=session.id,
        station_slug=session.station_slug,
        # Fall back to the slug rather than failing: a session row can outlive
        # a catalog entry if a station is ever renamed, and a stale name must
        # not turn a normal scan into a 500.
        station_name=station.name if station else session.station_slug,
        device_id=session.device_id,
        opened_at=session.opened_at,
        open_seconds=max(0, int((now - session.opened_at).total_seconds())),
    )


@router.get("/session", response_model=SessionResponse | None)
async def get_current_session(
    device_id: str,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> SessionResponse | None:
    """The session this device currently holds, or null.

    The scan page calls this on load: the session lives on the server, so a
    reload (or a crashed browser) resumes the open station rather than
    silently losing it.
    """
    session = await get_open_session_for_device(db, device_id)
    return _to_session_response(session) if session else None


@router.post("/session/scan", response_model=ScanResponse)
async def scan_station(
    body: ScanRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> ScanResponse:
    """Apply one station-QR scan: open, close (same station), or switch.

    A 404 here means the payload is not a station at all — the scan page
    treats that as the unknown-code error flash of §9, so it must stay
    distinguishable from a *locked* station, which is a 200 with
    `result: locked`.
    """
    station = station_for_payload(body.payload)
    if station is None:
        raise HTTPException(404, f"Not a station code: {body.payload}")

    outcome = await apply_station_scan(db, station, body.device_id)
    await db.commit()

    logger.info(
        "Floor scan: device=%s station=%s result=%s",
        body.device_id,
        station.slug,
        outcome.result,
    )

    return ScanResponse(
        result=outcome.result,
        station_slug=station.slug,
        station_name=station.name,
        session=_to_session_response(outcome.session) if outcome.session else None,
        blocking=_to_session_response(outcome.blocking) if outcome.blocking else None,
    )


@router.post("/session/takeover", response_model=ScanResponse)
async def takeover_station(
    body: TakeoverRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> ScanResponse:
    """Close whoever holds this station and open it here.

    Unconditional by design (§2.4): the operator standing at the screen,
    reading how long the session has been open, judges staleness better than
    any timeout the server could apply — and §11 rules out closing sessions
    on a timer.
    """
    station = station_for_payload(body.payload)
    if station is None:
        raise HTTPException(404, f"Not a station code: {body.payload}")

    outcome = await take_over(db, station, body.device_id)
    await db.commit()

    return ScanResponse(
        result=outcome.result,
        station_slug=station.slug,
        station_name=station.name,
        session=_to_session_response(outcome.session) if outcome.session else None,
    )


@router.delete("/session", response_model=SessionResponse | None)
async def close_current_session(
    device_id: str,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> SessionResponse | None:
    """Close whatever this device holds. Null if it held nothing.

    Closing without a scan — the on-screen control, not a QR. Idempotent, so
    a double-click cannot error.
    """
    session = await close_session_for_device(db, device_id)
    if session is None:
        return None
    await db.commit()
    return _to_session_response(session)
