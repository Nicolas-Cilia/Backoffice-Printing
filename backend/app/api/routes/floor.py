"""Floor scanning routes (``docs/floor-plan.md``).

Phase 1a: the Codes page's Station-labels tab — list the stations, render
their QR labels as a PDF.

Phase 1b: station sessions — open / close / switch by scanning a `BBS-`
payload, with the floor-wide locks of §2.4 and the takeover that recovers a
station nobody is coming back to.

Phase 7: printer codes — the Codes page's Printer-labels tab, and the
printer info page (§5.6) shown when a `BBP-` payload is scanned with no
station open.

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
from backend.app.services.floor_printers import (
    get_printer,
    get_printer_info,
    list_printers_for_labels,
    printer_id_for_payload,
    printer_payload,
)
from backend.app.services.floor_sessions import (
    ScanResult,
    apply_station_scan,
    close_session_by_id,
    close_session_for_device,
    get_open_session_for_device,
    list_open_sessions,
    list_recent_sessions,
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
    # How long the session has been open, or *was* open once closed — not
    # "time since it opened", which would keep growing for finished sessions
    # in the history list.
    #
    # Server-computed so the screen does not depend on the kiosk's clock
    # being right — an unattended PC with a drifted clock would otherwise
    # render a nonsense elapsed time, which is the one number this indicator
    # exists to make trustworthy (§5.4).
    open_seconds: int
    # Null while open. Present for history rows.
    closed_at: datetime | None = None
    # True when another device took the station rather than the holder
    # closing it — the distinction the history exists to show.
    closed_by_takeover: bool = False


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
    # An open session is measured to now; a closed one to when it closed, so
    # a finished session in the history does not keep ageing on screen.
    until = session.closed_at or now
    return SessionResponse(
        id=session.id,
        station_slug=session.station_slug,
        # Fall back to the slug rather than failing: a session row can outlive
        # a catalog entry if a station is ever renamed, and a stale name must
        # not turn a normal scan into a 500.
        station_name=station.name if station else session.station_slug,
        device_id=session.device_id,
        opened_at=session.opened_at,
        open_seconds=max(0, int((until - session.opened_at).total_seconds())),
        closed_at=session.closed_at,
        closed_by_takeover=bool(session.closed_by_takeover),
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


# ── Printer codes and the printer info page (phase 7, §5.6) ───────────────


class FloorPrinterResponse(BaseModel):
    """One printer as offered in the Codes page's Printer-labels tab."""

    id: int
    payload: str
    name: str
    model: str | None
    location: str | None
    is_active: bool


class PrinterLabelRequest(BaseModel):
    """Which printer labels to print, and at what physical size."""

    # Payloads rather than ids, matching the station-label endpoint: the
    # payload is what the QR encodes, so a caller that round-trips it cannot
    # print a label whose code differs from the one it asked for.
    payloads: list[str] = Field(..., min_length=1, max_length=MAX_LABELS_PER_REQUEST)
    width_mm: float = Field(..., ge=MIN_LABEL_MM, le=MAX_LABEL_MM)
    height_mm: float = Field(..., ge=MIN_LABEL_MM, le=MAX_LABEL_MM)


class LiveStatusResponse(BaseModel):
    """What the machine is doing right now, from MQTT."""

    connected: bool
    state: str
    current_print: str | None
    progress: float
    remaining_minutes: int
    layer_num: int
    total_layers: int


class LastPrintResponse(BaseModel):
    archive_id: int
    print_name: str | None
    completed_at: datetime | None
    quantity: int
    has_labeled_parts: bool


class PrinterInfoResponse(BaseModel):
    """The printer info page (§5.6)."""

    id: int
    payload: str
    name: str
    model: str | None
    location: str | None
    serial_number: str
    is_active: bool
    awaiting_plate_clear: bool
    total_print_hours: float
    last_print: LastPrintResponse | None
    maintenance_due_count: int
    maintenance_warning_count: int
    # None when the printer has no MQTT client at all — distinct from
    # connected=False, which means we know it and it is unreachable.
    live: LiveStatusResponse | None


@router.get("/printers", response_model=list[FloorPrinterResponse])
async def list_floor_printers(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[FloorPrinterResponse]:
    """Printers available for labelling, by name."""
    printers = await list_printers_for_labels(db)
    return [
        FloorPrinterResponse(
            id=p.id,
            payload=printer_payload(p.id),
            name=p.name,
            model=p.model,
            location=p.location,
            is_active=p.is_active,
        )
        for p in printers
    ]


@router.post("/labels/printers")
async def render_printer_labels(
    body: PrinterLabelRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> StreamingResponse:
    """Render printer QR labels as a one-label-per-page PDF."""
    labels: list[CodeLabel] = []
    unknown: list[str] = []

    for payload in body.payloads:
        printer_id = printer_id_for_payload(payload)
        printer = await get_printer(db, printer_id) if printer_id is not None else None
        if printer is None:
            unknown.append(payload)
        else:
            labels.append(CodeLabel(payload=printer_payload(printer.id), title=printer.name))

    # Refuse rather than skip, as with station labels: a silently-short PDF
    # is worse than an error, because the missing label is only noticed once
    # someone is standing at the machine.
    if unknown:
        raise HTTPException(400, f"Unknown printer code(s): {', '.join(unknown)}")

    try:
        pdf = render_code_labels(labels, width_mm=body.width_mm, height_mm=body.height_mm)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    logger.info("Rendered %d printer label(s) at %gx%g mm", len(labels), body.width_mm, body.height_mm)

    return StreamingResponse(
        io.BytesIO(pdf),
        media_type="application/pdf",
        headers={
            "Content-Disposition": build_content_disposition(
                "bambuddy-printer-labels.pdf", disposition="inline"
            ),
            "Content-Length": str(len(pdf)),
            "Cache-Control": "no-store",
        },
    )


@router.get("/printers/{payload}/info", response_model=PrinterInfoResponse)
async def get_floor_printer_info(
    payload: str,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> PrinterInfoResponse:
    """The info page for a scanned printer QR (§5.6).

    Keyed by the scanned payload rather than a bare id so the scan page can
    hand over exactly what the pistol emitted, with no client-side parsing
    that could drift from the backend's idea of a valid code.

    Takes **no** harvest lock: looking at a printer must not block whoever
    wants to clear its bed. The lock is claimed on the first part scan
    (§5.4).
    """
    printer_id = printer_id_for_payload(payload)
    if printer_id is None:
        raise HTTPException(404, f"Not a printer code: {payload}")

    info = await get_printer_info(db, printer_id)
    if info is None:
        raise HTTPException(404, f"Unknown printer code: {payload}")

    return PrinterInfoResponse(
        id=info.id,
        payload=info.payload,
        name=info.name,
        model=info.model,
        location=info.location,
        serial_number=info.serial_number,
        is_active=info.is_active,
        awaiting_plate_clear=info.awaiting_plate_clear,
        total_print_hours=info.total_print_hours,
        last_print=(
            LastPrintResponse(
                archive_id=info.last_print.archive_id,
                print_name=info.last_print.print_name,
                completed_at=info.last_print.completed_at,
                quantity=info.last_print.quantity,
                has_labeled_parts=info.last_print.has_labeled_parts,
            )
            if info.last_print
            else None
        ),
        maintenance_due_count=info.maintenance_due_count,
        maintenance_warning_count=info.maintenance_warning_count,
        live=(
            LiveStatusResponse(
                connected=info.live.connected,
                state=info.live.state,
                current_print=info.live.current_print,
                progress=info.live.progress,
                remaining_minutes=info.live.remaining_minutes,
                layer_num=info.live.layer_num,
                total_layers=info.live.total_layers,
            )
            if info.live
            else None
        ),
    )


# ── Session overview (the /floor landing page's open-sessions panel) ──────


class SessionOverviewResponse(BaseModel):
    """Open sessions plus recently closed ones.

    History exists only because closing is a write rather than a delete
    (§2.4) — it is a side effect of that choice, not extra bookkeeping.
    """

    open: list[SessionResponse]
    recent: list[SessionResponse]


@router.get("/sessions", response_model=SessionOverviewResponse)
async def list_floor_sessions(
    hours: int = 24,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> SessionOverviewResponse:
    """Every open session, plus those closed in the last ``hours``.

    The open list is oldest-first: the reason to read it is usually hunting a
    session nobody came back to, and that one belongs at the top.
    """
    return SessionOverviewResponse(
        open=[_to_session_response(s) for s in await list_open_sessions(db)],
        recent=[_to_session_response(s) for s in await list_recent_sessions(db, hours=hours)],
    )


@router.delete("/sessions/{session_id}", response_model=SessionResponse)
async def close_floor_session(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> SessionResponse:
    """Close any session by id, whichever device holds it.

    The escape hatch for a station nobody is coming back to — distinct from
    ``DELETE /floor/session``, which only ever closes the caller's own. A
    404 covers both "no such session" and "already closed", so a double
    click cannot resurrect a row to re-close it.
    """
    session = await close_session_by_id(db, session_id)
    if session is None:
        raise HTTPException(404, "No open session with that id")
    await db.commit()
    return _to_session_response(session)
