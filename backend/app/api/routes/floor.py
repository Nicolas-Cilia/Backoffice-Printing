"""Floor scanning routes (``docs/floor-plan.md``).

Phase 1a: the Codes page's Station-labels tab. Two endpoints — list the
stations, and render their QR labels as a PDF.

Station open/close/switch (phase 1b) and the rest of the scan routing land
here later; this module is the Floor feature's backend entry point.
"""

from __future__ import annotations

import io
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.services.floor_codes import (
    FLOOR_STATIONS,
    MAX_LABEL_MM,
    MAX_LABELS_PER_REQUEST,
    MIN_LABEL_MM,
    CodeLabel,
    render_code_labels,
    station_for_payload,
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
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
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
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
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
