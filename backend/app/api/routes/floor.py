"""Floor scanning routes (``docs/floor-plan.md``).

Phase 1a: the Codes page's Station-labels tab — list the stations, render
their QR labels as a PDF.

Phase 1b: station sessions — open / close / switch by scanning a `BBS-`
payload, with the floor-wide locks of §2.4 and the takeover that recovers a
station nobody is coming back to.

Phase 7: printer codes — the Codes page's Printer-labels tab, and the
printer info page (§5.6) shown when a `BBP-` payload is scanned with no
station open.

Phase 8: harvest binding and labeled parts (§5.4, §7) — binding a harvest
plate to a printer's latest finished job, enrolling `BBD-` part stickers
against it from either harvest entry point, and the needs-attention list for
parts with no job to show for them.

The rest of the scan routing (SKUs, defects) lands here in later phases;
this module is the Floor feature's backend entry point.
"""

from __future__ import annotations

import io
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.library import to_absolute_path
from backend.app.core.auth import RequireCameraStreamTokenIfAuthEnabled, RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.floor_part import FloorErrorLabel
from backend.app.models.floor_session import FloorStationSession
from backend.app.models.printer import Printer
from backend.app.models.user import User
from backend.app.services.floor_bins import (
    BIN_LOCATION_SLUGS,
    BinScanOutcome,
    BinScanResult,
    discard_bin,
    list_bin_batch_events,
    list_bin_job_candidates,
    list_floor_bin_history,
    list_floor_bin_management,
    list_floor_bins,
    override_bin_quantity,
    relink_bin,
    resolve_bin_for_flow,
    scan_bin_at_location,
    scan_bin_empty,
    scan_bin_fit_check,
    scan_bin_wip,
    scan_harvest_bin,
    unlink_bin,
)
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
from backend.app.services.floor_parts import (
    PART_LOCATION_SLUGS,
    HarvestPrinterResult,
    LocationScanOutcome,
    LocationScanResult,
    PartScanResult,
    ReplaceStickerReasonCode,
    ReplaceStickerResult,
    SetPartCodeResult,
    SetPartStatusResult,
    UnlinkReasonCode,
    archive_part,
    clear_part_code,
    delete_part,
    discard_part,
    dismiss_build_plate,
    find_part_code_thumbnail,
    get_harvest_summary,
    get_inventory_part_by_sticker,
    list_dismissed_build_plates,
    list_inventory_parts,
    list_needs_attention,
    list_part_code_options,
    list_part_events,
    list_part_job_candidates,
    list_unlabeled_build_plates,
    relink_part,
    replace_sticker_code,
    restore_build_plate,
    scan_fit_check_part,
    scan_harvest_printer,
    scan_part,
    scan_part_at_location,
    scan_rework_error,
    scan_rework_part,
    search_completed_jobs,
    set_part_code,
    set_part_status,
    unlink_part,
)
from backend.app.services.floor_printers import (
    FLOOR_STOP_REASON_CODES,
    LastPrint,
    delete_floor_stop_reason,
    get_printer,
    get_printer_info,
    list_floor_stop_reasons,
    list_printers_for_labels,
    printer_id_for_payload,
    printer_payload,
    record_floor_stop_reason,
    update_floor_stop_reason,
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
    # "station" (WIP/+Storage/Move/Harvest) vs "location" (Fit
    # Check/Rework) — which Codes-page tab this label prints under (§3.3).
    category: str


class StationLabelRequest(BaseModel):
    """Which station labels to print, and at what physical size."""

    # Payloads rather than slugs: the payload is what the QR encodes and what
    # a pistol will emit, so a caller that round-trips it here can't silently
    # print a label whose code differs from the one it asked for.
    payloads: list[str] = Field(..., min_length=1, max_length=MAX_LABELS_PER_REQUEST)
    width_mm: float = Field(..., ge=MIN_LABEL_MM, le=MAX_LABEL_MM)
    height_mm: float = Field(..., ge=MIN_LABEL_MM, le=MAX_LABEL_MM)


class ErrorLabelRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    slug: str = Field(..., min_length=1, max_length=64, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class ErrorLabelResponse(BaseModel):
    id: int
    name: str
    slug: str
    payload: str


def _to_error_label_response(label: FloorErrorLabel) -> ErrorLabelResponse:
    return ErrorLabelResponse(id=label.id, name=label.name, slug=label.slug, payload=f"BBF-{label.slug}")


@router.get("/error-labels", response_model=list[ErrorLabelResponse])
async def list_error_labels(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[ErrorLabelResponse]:
    labels = (await db.execute(select(FloorErrorLabel).order_by(FloorErrorLabel.name))).scalars().all()
    return [_to_error_label_response(label) for label in labels]


@router.post("/error-labels", response_model=ErrorLabelResponse, status_code=201)
async def create_error_label(
    body: ErrorLabelRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> ErrorLabelResponse:
    label = FloorErrorLabel(name=body.name.strip(), slug=body.slug.strip().lower())
    db.add(label)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "An error label with that name or code already exists") from exc
    await db.refresh(label)
    return _to_error_label_response(label)


@router.delete("/error-labels/{label_id}", status_code=204)
async def delete_error_label(
    label_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> None:
    label = await db.get(FloorErrorLabel, label_id)
    if label is None:
        raise HTTPException(404, "Error label not found")
    await db.delete(label)
    await db.commit()


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
            category=station.category,
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


@router.post("/labels/errors")
async def render_error_labels(
    body: StationLabelRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> StreamingResponse:
    labels_by_payload = {
        f"BBF-{label.slug}": CodeLabel(payload=f"BBF-{label.slug}", title=label.name)
        for label in (await db.execute(select(FloorErrorLabel))).scalars()
    }
    labels_by_payload["BBX-discard"] = CodeLabel(payload="BBX-discard", title="Discard")
    labels = [labels_by_payload[payload] for payload in body.payloads if payload in labels_by_payload]
    unknown = [payload for payload in body.payloads if payload not in labels_by_payload]
    if unknown:
        raise HTTPException(400, f"Unknown error code(s): {', '.join(unknown)}")
    try:
        pdf = render_code_labels(labels, width_mm=body.width_mm, height_mm=body.height_mm)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return StreamingResponse(
        io.BytesIO(pdf),
        media_type="application/pdf",
        headers={
            "Content-Disposition": build_content_disposition("bambuddy-error-labels.pdf", disposition="inline"),
            "Content-Length": str(len(pdf)),
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

    `category == "location"` entries (Fit Check, Rework — §5.4a/§5.4b) are
    printed and resolved through this same catalog, but they are not
    sessions: nothing opens or closes for them, so this route refuses them
    the same as an unrecognized code. The scan-part-then-location flow that
    actually handles them lives in ``/floor/locations/part``, never here.
    """
    station = station_for_payload(body.payload)
    if station is None or station.category == "location":
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

    `category == "location"` entries are never sessions (see `scan_station`
    above) — structurally unreachable in practice since nothing ever opens
    one to take over, but refused the same way for consistency.
    """
    station = station_for_payload(body.payload)
    if station is None or station.category == "location":
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


class FloorBinResponse(BaseModel):
    """One permanent shared KNB/BUT bin label."""

    payload: str
    bin_number: int
    part_code: str
    part_name: str


class BinLabelRequest(StationLabelRequest):
    pass


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
    part_code: str | None = None


class RecentStoppedPrintResponse(BaseModel):
    print_log_id: int
    archive_id: int | None
    print_name: str | None
    part_code: str | None
    status: str
    stopped_at: datetime
    reason_code: str | None
    reason_text: str | None


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
    recent_stopped_print: RecentStoppedPrintResponse | None


class FloorStopReasonRequest(BaseModel):
    reason_code: str = Field(..., min_length=1, max_length=64)
    reason_text: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def validate_reason(self) -> FloorStopReasonRequest:
        if self.reason_code not in FLOOR_STOP_REASON_CODES:
            raise ValueError(f"reason_code must be one of {list(FLOOR_STOP_REASON_CODES)}")
        if self.reason_code == "other" and not (self.reason_text or "").strip():
            raise ValueError("reason_text is required when reason_code is 'other'")
        return self


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
            "Content-Disposition": build_content_disposition("bambuddy-printer-labels.pdf", disposition="inline"),
            "Content-Length": str(len(pdf)),
            "Cache-Control": "no-store",
        },
    )


@router.get("/bins", response_model=list[FloorBinResponse])
async def list_floor_bins_route(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[FloorBinResponse]:
    """List the six permanent shared bin labels."""
    return [
        FloorBinResponse(
            payload=bin_item.payload,
            bin_number=bin_item.bin_number,
            part_code=bin_item.part_code,
            part_name=bin_item.part_name,
        )
        for bin_item in await list_floor_bins(db)
    ]


@router.post("/labels/bins")
async def render_bin_labels(
    body: BinLabelRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> StreamingResponse:
    """Render reusable KNB/BUT bin labels as a one-label-per-page PDF."""
    available = {item.payload: item for item in await list_floor_bins(db)}
    unknown = [payload for payload in body.payloads if payload.strip() not in available]
    if unknown:
        raise HTTPException(400, f"Unknown bin code(s): {', '.join(unknown)}")
    labels = [
        CodeLabel(
            payload=available[payload.strip()].payload,
            title=f"{available[payload.strip()].part_name} {available[payload.strip()].bin_number}",
        )
        for payload in body.payloads
    ]
    try:
        pdf = render_code_labels(labels, width_mm=body.width_mm, height_mm=body.height_mm)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return StreamingResponse(
        io.BytesIO(pdf),
        media_type="application/pdf",
        headers={
            "Content-Disposition": build_content_disposition("bambuddy-bin-labels.pdf", disposition="inline"),
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
                part_code=info.last_print.part_code,
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
        recent_stopped_print=(
            RecentStoppedPrintResponse(
                print_log_id=info.recent_stopped_print.print_log_id,
                archive_id=info.recent_stopped_print.archive_id,
                print_name=info.recent_stopped_print.print_name,
                part_code=info.recent_stopped_print.part_code,
                status=info.recent_stopped_print.status,
                stopped_at=info.recent_stopped_print.stopped_at,
                reason_code=info.recent_stopped_print.reason_code,
                reason_text=info.recent_stopped_print.reason_text,
            )
            if info.recent_stopped_print
            else None
        ),
    )


@router.post("/printers/{printer_id}/stopped-print/reason", response_model=RecentStoppedPrintResponse)
async def record_stopped_print_reason(
    printer_id: int,
    body: FloorStopReasonRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> RecentStoppedPrintResponse:
    try:
        stopped = await record_floor_stop_reason(
            db,
            printer_id,
            body.reason_code,
            body.reason_text,
        )
    except LookupError as exc:
        raise HTTPException(409, str(exc)) from exc
    return RecentStoppedPrintResponse(
        print_log_id=stopped.print_log_id,
        archive_id=stopped.archive_id,
        print_name=stopped.print_name,
        part_code=stopped.part_code,
        status=stopped.status,
        stopped_at=stopped.stopped_at,
        reason_code=stopped.reason_code,
        reason_text=stopped.reason_text,
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


# ── Harvest and labeled parts (phase 8, §5.4, §7) ──────────────────────────


class PlatePrinterResponse(BaseModel):
    """The slim printer identity a harvest/part scan response needs — not
    the full ``FloorPrinterResponse`` used by the Codes page, which carries
    label-printing fields (model, location, is_active) these screens don't."""

    id: int
    name: str


class PlateArchiveResponse(BaseModel):
    """The slim archive summary a harvest/part scan response needs."""

    id: int
    print_name: str | None
    completed_at: datetime | None
    quantity: int
    part_code: str | None = None


class LabeledPartResponse(BaseModel):
    """One enrolled sticker (§7.2)."""

    id: int
    sticker_code: str
    printer_id: int | None
    archive_id: int | None
    part_code: str | None
    section_part_id: int | None
    part_name: str | None = None
    part_source: str | None = None
    labeled_at: datetime


class HarvestPrinterScanRequest(BaseModel):
    """A `BBP-` scan made while this device holds an open harvest session."""

    device_id: str = Field(..., min_length=1, max_length=64)
    payload: str = Field(..., min_length=1, max_length=256)


class HarvestScanResponse(BaseModel):
    """What a harvest printer scan did, and the plate it left open (if any)."""

    result: HarvestPrinterResult
    session: SessionResponse | None = None
    printer: PlatePrinterResponse | None = None
    archive: PlateArchiveResponse | None = None
    part_count: int = 0
    # Populated only on the (structurally near-unreachable) `locked` result.
    blocking: SessionResponse | None = None


class PartScanRequest(BaseModel):
    """A `BBD-` scan. ``printer_id`` is the printer-info-page hint (§5.4 entry
    #2) — ignored once this device already holds a harvest session."""

    device_id: str = Field(..., min_length=1, max_length=64)
    payload: str = Field(..., min_length=1, max_length=256)
    printer_id: int | None = None


class PartScanResponse(BaseModel):
    """What a part scan did."""

    result: PartScanResult
    part: LabeledPartResponse | None = None
    printer: PlatePrinterResponse | None = None
    archive: PlateArchiveResponse | None = None
    part_count: int = 0
    session: SessionResponse | None = None
    blocking: SessionResponse | None = None


class BinBatchResponse(BaseModel):
    id: int
    payload: str
    bin_number: int
    printer_id: int | None
    printer_name: str | None
    archive_id: int | None
    print_name: str | None
    part_code: str
    quantity: int
    qc_passed_quantity: int | None
    remaining_quantity: int
    status: str
    harvested_at: datetime


class BinBatchEventResponse(BaseModel):
    id: int
    action: str
    details: dict | None
    occurred_at: datetime


class BinJobCandidateResponse(BaseModel):
    id: int
    print_name: str
    completed_at: datetime | None


class FloorBinManagementResponse(BaseModel):
    payload: str
    bin_number: int
    part_code: str
    part_name: str
    status: str
    batch: BinBatchResponse | None


class BinQuantityOverrideRequest(BaseModel):
    payload: str = Field(..., min_length=1, max_length=256)
    remaining_quantity: int = Field(..., ge=0, le=100_000)


class BinUnlinkRequest(BaseModel):
    payload: str = Field(..., min_length=1, max_length=256)


class BinRelinkRequest(BaseModel):
    archive_id: int


class BinScanRequest(BaseModel):
    device_id: str = Field(..., min_length=1, max_length=64)
    payload: str = Field(..., min_length=1, max_length=256)
    quantity: int | None = Field(default=None, ge=1, le=100_000)
    printer_id: int | None = None


class BinFlowRequest(BaseModel):
    payload: str = Field(..., min_length=1, max_length=256)


class BinQcRequest(BaseModel):
    payload: str = Field(..., min_length=1, max_length=256)
    passed_quantity: int | None = Field(default=None, ge=0, le=100_000)


class BinScanResponse(BaseModel):
    result: BinScanResult
    bin: FloorBinResponse | None = None
    batch: BinBatchResponse | None = None
    printer: PlatePrinterResponse | None = None
    session: SessionResponse | None = None
    blocking: SessionResponse | None = None
    archive: PlateArchiveResponse | None = None


def _to_plate_printer(printer: Printer | None) -> PlatePrinterResponse | None:
    return PlatePrinterResponse(id=printer.id, name=printer.name) if printer else None


def _to_plate_archive(archive: LastPrint | None) -> PlateArchiveResponse | None:
    if archive is None:
        return None
    return PlateArchiveResponse(
        id=archive.archive_id,
        print_name=archive.print_name,
        completed_at=archive.completed_at,
        quantity=archive.quantity,
        part_code=archive.part_code,
    )


def _to_bin_response(bin_item) -> FloorBinResponse | None:
    if bin_item is None:
        return None
    return FloorBinResponse(
        payload=bin_item.payload,
        bin_number=bin_item.bin_number,
        part_code=bin_item.part_code,
        part_name=bin_item.part_name,
    )


def _to_bin_batch_response(batch) -> BinBatchResponse | None:
    if batch is None:
        return None
    printer = batch.printer
    archive = batch.archive
    return BinBatchResponse(
        id=batch.id,
        payload=batch.payload,
        bin_number=batch.bin_number,
        printer_id=printer.id if printer else None,
        printer_name=printer.name if printer else None,
        archive_id=archive.archive_id if archive else None,
        print_name=archive.print_name if archive else None,
        part_code=batch.part_code,
        quantity=batch.quantity,
        qc_passed_quantity=batch.qc_passed_quantity,
        remaining_quantity=batch.remaining_quantity,
        status=batch.status,
        harvested_at=batch.harvested_at,
    )


def _to_bin_scan_response(outcome: BinScanOutcome) -> BinScanResponse:
    return BinScanResponse(
        result=outcome.result,
        bin=_to_bin_response(outcome.bin),
        batch=_to_bin_batch_response(outcome.batch),
        printer=_to_plate_printer(outcome.printer),
        session=_to_session_response(outcome.session) if outcome.session else None,
        blocking=_to_session_response(outcome.blocking) if outcome.blocking else None,
        archive=_to_plate_archive(outcome.archive),
    )


def _to_bin_management_response(item) -> FloorBinManagementResponse:
    return FloorBinManagementResponse(
        payload=item.bin.payload,
        bin_number=item.bin.bin_number,
        part_code=item.bin.part_code,
        part_name=item.bin.part_name,
        status=item.status,
        batch=_to_bin_batch_response(item.batch),
    )


@router.get("/inventory/bins", response_model=list[FloorBinManagementResponse])
async def list_inventory_bins(
    include_history: bool = False,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[FloorBinManagementResponse]:
    """Show current assignments, or every historical fill when requested."""
    items = await (list_floor_bin_history(db) if include_history else list_floor_bin_management(db))
    return [_to_bin_management_response(item) for item in items]


@router.get("/inventory/bins/batches/{batch_id}/events", response_model=list[BinBatchEventResponse])
async def get_inventory_bin_batch_events(
    batch_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[BinBatchEventResponse]:
    events = await list_bin_batch_events(db, batch_id)
    if events is None:
        raise HTTPException(404, "Bin batch not found")
    return [BinBatchEventResponse(**event.__dict__) for event in events]


@router.get("/inventory/bins/batches/{batch_id}/job-candidates", response_model=list[BinJobCandidateResponse])
async def get_inventory_bin_job_candidates(
    batch_id: int,
    printer_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[BinJobCandidateResponse]:
    candidates = await list_bin_job_candidates(db, batch_id, printer_id)
    if candidates is None:
        raise HTTPException(404, "Bin batch not found")
    return [BinJobCandidateResponse(**candidate.__dict__) for candidate in candidates]


@router.post("/inventory/bins/batches/{batch_id}/relink", response_model=BinScanResponse)
async def relink_inventory_bin(
    batch_id: int,
    body: BinRelinkRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> BinScanResponse:
    outcome = await relink_bin(db, batch_id, body.archive_id)
    if outcome is None:
        raise HTTPException(404, "Unlinked bin batch or completed job not found")
    await db.commit()
    return _to_bin_scan_response(outcome)


@router.post("/inventory/bins/quantity-override", response_model=BinScanResponse)
async def override_inventory_bin_quantity(
    body: BinQuantityOverrideRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> BinScanResponse:
    """Override a bin fill's remaining count from Inventory management."""
    outcome = await override_bin_quantity(db, body.payload, body.remaining_quantity)
    await db.commit()
    return _to_bin_scan_response(outcome)


@router.post("/inventory/bins/unlink", response_model=BinScanResponse)
async def unlink_inventory_bin(
    body: BinUnlinkRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> BinScanResponse:
    """Release a bin assignment while retaining its audit history."""
    outcome = await unlink_bin(db, body.payload)
    await db.commit()
    return _to_bin_scan_response(outcome)


@router.post("/harvest/bin", response_model=BinScanResponse)
async def scan_harvest_bin_route(
    body: BinScanRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> BinScanResponse:
    """Scan a reusable KNB/BUT bin and optionally save its harvested count."""
    outcome = await scan_harvest_bin(db, body.device_id, body.payload, body.quantity, body.printer_id)
    await db.commit()
    return _to_bin_scan_response(outcome)


@router.post("/bins/resolve", response_model=BinScanResponse)
async def resolve_floor_bin_route(
    body: BinFlowRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> BinScanResponse:
    outcome = await resolve_bin_for_flow(db, body.payload)
    return _to_bin_scan_response(outcome)


@router.post("/locations/fit-check/bin", response_model=BinScanResponse)
async def scan_fit_check_bin_route(
    body: BinQcRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> BinScanResponse:
    """Record the visual QC checkpoint for the latest bin batch."""
    outcome = await scan_bin_fit_check(db, body.payload, body.passed_quantity)
    await db.commit()
    return _to_bin_scan_response(outcome)


@router.post("/wip/bin", response_model=BinScanResponse)
async def scan_wip_bin_route(
    body: BinFlowRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> BinScanResponse:
    """Admit a bin batch to WIP only after visual QC has passed."""
    outcome = await scan_bin_wip(db, body.payload)
    await db.commit()
    return _to_bin_scan_response(outcome)


@router.post("/bins/empty", response_model=BinScanResponse)
async def scan_empty_bin_route(
    body: BinFlowRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> BinScanResponse:
    """Close a consumed WIP fill so the shared bin can be reused."""
    outcome = await scan_bin_empty(db, body.payload)
    await db.commit()
    return _to_bin_scan_response(outcome)


@router.post("/bins/discard", response_model=BinScanResponse)
async def discard_bin_route(
    body: BinFlowRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> BinScanResponse:
    """Discard a bin's active fill entirely from the floor kiosk: unlinks it
    from its printer/job and clears its quantity in one commit (§ bin
    discard). The kiosk gates this behind its own two-scan confirmation
    before ever calling this route — no reason is collected, unlike part
    discard."""
    outcome = await discard_bin(db, body.payload)
    await db.commit()
    return _to_bin_scan_response(outcome)


@router.post("/harvest/printer", response_model=HarvestScanResponse)
async def scan_harvest_printer_route(
    body: HarvestPrinterScanRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> HarvestScanResponse:
    """Bind, rebind, or close a harvest plate (§5.4).

    Requires the device to already hold an open harvest session — reached
    either by scanning `BBS-harvest` first, or, per entry #2, by a prior
    `POST /floor/parts/scan` that claimed the lock from the printer info
    page. A device with no harvest session gets `no_session` cleanly rather
    than an error; the client should not be calling this in that state.
    """
    outcome = await scan_harvest_printer(db, body.device_id, body.payload)
    await db.commit()

    logger.info(
        "Harvest printer scan: device=%s payload=%s result=%s",
        body.device_id,
        body.payload,
        outcome.result,
    )

    return HarvestScanResponse(
        result=outcome.result,
        session=_to_session_response(outcome.session) if outcome.session else None,
        printer=_to_plate_printer(outcome.printer),
        archive=_to_plate_archive(outcome.archive),
        part_count=outcome.part_count,
        blocking=_to_session_response(outcome.blocking) if outcome.blocking else None,
    )


@router.post("/parts/scan", response_model=PartScanResponse)
async def scan_part_route(
    body: PartScanRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> PartScanResponse:
    """Enroll (or look up) one `BBD-` sticker (§7, §9).

    Handles both harvest entry points identically: a device already in
    harvest mode writes against its bound plate; a device with no session at
    all can claim the harvest lock here directly, using ``printer_id`` as
    the info-page hint (§5.4 entry #2). The hint is ignored once a session
    exists — see ``floor_parts.scan_part``'s docstring.
    """
    outcome = await scan_part(db, body.device_id, body.payload, printer_id_hint=body.printer_id)
    await db.commit()
    presentation = (
        await get_inventory_part_by_sticker(db, outcome.part.sticker_code) if outcome.part is not None else None
    )

    logger.info(
        "Part scan: device=%s payload=%s result=%s",
        body.device_id,
        body.payload,
        outcome.result,
    )

    return PartScanResponse(
        result=outcome.result,
        part=(
            LabeledPartResponse(
                id=outcome.part.id,
                sticker_code=outcome.part.sticker_code,
                printer_id=outcome.part.printer_id,
                archive_id=outcome.part.archive_id,
                part_code=outcome.part.part_code,
                section_part_id=outcome.part.section_part_id,
                part_name=presentation.part_name if presentation else None,
                part_source=presentation.part_source if presentation else None,
                labeled_at=outcome.part.labeled_at,
            )
            if outcome.part
            else None
        ),
        printer=_to_plate_printer(outcome.printer),
        archive=_to_plate_archive(outcome.archive),
        part_count=outcome.part_count,
        session=_to_session_response(outcome.session) if outcome.session else None,
        blocking=_to_session_response(outcome.blocking) if outcome.blocking else None,
    )


@router.get("/parts/thumbnail/{code}")
async def get_part_code_thumbnail(
    code: str,
    section_part_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    _: None = RequireCameraStreamTokenIfAuthEnabled,
):
    """Serve the 3MF cover image registered for a Production part code, if
    Files has one on file for it (§7). 404 whether the code is unknown or
    just has no thumbnail — the scan page treats both as "nothing to show",
    not an error."""
    thumbnail_path = await find_part_code_thumbnail(db, code, section_part_id)
    abs_thumb_path = to_absolute_path(thumbnail_path)
    if abs_thumb_path is None or not abs_thumb_path.is_file():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(
        str(abs_thumb_path),
        media_type="image/png",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


class PartCodeOptionResponse(BaseModel):
    code: str
    name: str


@router.get("/parts/codes", response_model=list[PartCodeOptionResponse])
async def list_floor_part_codes(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[PartCodeOptionResponse]:
    """The Production catalog (§7), for Part history's "assign a part code"
    picker on a part harvest couldn't resolve one for."""
    return [PartCodeOptionResponse(code=o.code, name=o.name) for o in await list_part_code_options(db)]


# ── Fit Check and Rework (phase 9a/9b, §5.4a/§5.4b) ───────────────────────
#
# Neither is a station (see `scan_station`'s docstring above) — no session,
# no device/floor-wide state on this side either. Each route below is a pure
# commit: the scan page tracks which part is "pending" a location, or which
# part is pending a Rework reason, entirely in its own local state, and
# only calls these once it already has everything a write needs.


class LocationPartScanResponse(BaseModel):
    """What a scan-part-then-location commit did (Fit Check or Rework)."""

    result: LocationScanResult
    part: LabeledPartResponse | None = None
    printer: PlatePrinterResponse | None = None
    archive: PlateArchiveResponse | None = None
    reason: str | None = None


def _to_location_response(outcome: LocationScanOutcome) -> LocationPartScanResponse:
    return LocationPartScanResponse(
        result=outcome.result,
        part=(
            LabeledPartResponse(
                id=outcome.part.id,
                sticker_code=outcome.part.sticker_code,
                printer_id=outcome.part.printer_id,
                archive_id=outcome.part.archive_id,
                part_code=outcome.part.part_code,
                section_part_id=outcome.part.section_part_id,
                labeled_at=outcome.part.labeled_at,
            )
            if outcome.part
            else None
        ),
        printer=_to_plate_printer(outcome.printer),
        archive=_to_plate_archive(outcome.archive),
        reason=outcome.reason,
    )


class FitCheckScanRequest(BaseModel):
    """The `BBD-…` sticker the scan page already has pending for Fit Check."""

    payload: str = Field(..., min_length=1, max_length=256)


@router.post("/locations/fit-check/part", response_model=LocationPartScanResponse)
async def scan_fit_check_part_route(
    body: FitCheckScanRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> LocationPartScanResponse:
    """Commit "this part is at Fit Check" (§5.4a) — the second of two scans
    (part, then this location), with nothing held open in between on the
    server."""
    outcome = await scan_fit_check_part(db, body.payload)
    await db.commit()
    logger.info("Fit check: payload=%s result=%s", body.payload, outcome.result)
    return _to_location_response(outcome)


class PartLocationScanRequest(BaseModel):
    """A pending `BBD-…` part plus the item→location location it was scanned
    into (Support/Overhang/Hot Air removal, Ready-for-Production, or WIP)."""

    payload: str = Field(..., min_length=1, max_length=256)
    location_slug: str = Field(..., min_length=1, max_length=64)


@router.post("/locations/part", response_model=LocationPartScanResponse)
async def scan_part_location_route(
    body: PartLocationScanRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> LocationPartScanResponse:
    """Commit a part into one of the item→location pipeline locations.

    The universal scan-item-then-location pattern for parts: the scan page
    holds the pending sticker locally, then this route records the location
    with all the TOP-vs-BOT finishing rules applied server-side. Fit Check
    and Rework keep their own dedicated routes and are refused here (404) so
    their special handling (reasons, no ordering) cannot be bypassed.
    """
    if body.location_slug not in PART_LOCATION_SLUGS:
        raise HTTPException(404, f"Not a part location: {body.location_slug}")
    outcome = await scan_part_at_location(db, body.payload, body.location_slug)
    await db.commit()
    logger.info("Part location: payload=%s location=%s result=%s", body.payload, body.location_slug, outcome.result)
    return _to_location_response(outcome)


class BinLocationScanRequest(BaseModel):
    """A pending `BBN-…` bin plus the item→location location it was scanned
    into (Ready-for-Production, Production WIP, or Empty Bin)."""

    payload: str = Field(..., min_length=1, max_length=256)
    location_slug: str = Field(..., min_length=1, max_length=64)


@router.post("/locations/bin", response_model=BinScanResponse)
async def scan_bin_location_route(
    body: BinLocationScanRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> BinScanResponse:
    """Commit a bin into one of the item→location pipeline locations.

    The bin half of the universal pattern, replacing the old open-WIP-session
    bin path: scan the bin, then the location QR. Initial QC keeps its own
    quantity-carrying route and is refused here (404)."""
    if body.location_slug not in BIN_LOCATION_SLUGS:
        raise HTTPException(404, f"Not a bin location: {body.location_slug}")
    outcome = await scan_bin_at_location(db, body.payload, body.location_slug)
    await db.commit()
    logger.info("Bin location: payload=%s location=%s result=%s", body.payload, body.location_slug, outcome.result)
    return _to_bin_scan_response(outcome)


class ReworkScanRequest(BaseModel):
    """The pending part plus the reason scan that completes Rework's flow
    (§5.4b) — the Rework *location* scan itself is a pure UI transition on
    the scan page and never reaches the backend on its own."""

    payload: str = Field(..., min_length=1, max_length=256)
    reason_code: str = Field(..., min_length=1, max_length=32)
    reason_text: str | None = Field(default=None, max_length=500)


class ErrorPartScanRequest(BaseModel):
    payload: str = Field(..., min_length=1, max_length=256)
    error_payload: str = Field(..., min_length=5, max_length=80)
    reason_text: str | None = Field(default=None, max_length=120)


@router.post("/locations/sanding/part", response_model=LocationPartScanResponse, deprecated=True)
@router.post("/locations/rework/part", response_model=LocationPartScanResponse)
async def scan_rework_part_route(
    body: ReworkScanRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> LocationPartScanResponse:
    """Commit "this part is at Rework, because …" (§5.4b) — the third scan
    of its flow (part, Rework location, reason); this is the only point at
    which anything is written."""
    outcome = await scan_rework_part(db, body.payload, body.reason_code, body.reason_text)
    await db.commit()
    logger.info("Rework: payload=%s reason=%s result=%s", body.payload, body.reason_code, outcome.result)
    return _to_location_response(outcome)


@router.post("/locations/rework/error", response_model=LocationPartScanResponse)
async def scan_rework_error_route(
    body: ErrorPartScanRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> LocationPartScanResponse:
    outcome = await scan_rework_error(db, body.payload, body.error_payload, body.reason_text)
    await db.commit()
    return _to_location_response(outcome)


@router.post("/parts/discard", response_model=LocationPartScanResponse)
async def discard_part_route(
    body: ErrorPartScanRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> LocationPartScanResponse:
    outcome = await discard_part(db, body.payload, body.error_payload, body.reason_text)
    await db.commit()
    return _to_location_response(outcome)


class NeedsAttentionPartResponse(BaseModel):
    """One part with no job to show for it (§7.2, §9)."""

    id: int
    sticker_code: str
    printer_id: int | None
    printer_name: str | None
    labeled_at: datetime


class NeedsAttentionResponse(BaseModel):
    parts: list[NeedsAttentionPartResponse]
    total: int


class UnlabeledBuildPlateResponse(BaseModel):
    id: int
    print_name: str | None
    printer_name: str | None
    completed_at: datetime | None


class DismissedBuildPlateResponse(BaseModel):
    id: int
    print_name: str | None
    printer_name: str | None
    completed_at: datetime | None
    dismissed_at: datetime | None


class HarvestSummaryLineResponse(BaseModel):
    printer_id: int | None
    printer_name: str | None
    print_name: str | None
    part_count: int
    bin_quantity: int


@router.get("/harvest/sessions/{session_id}/summary", response_model=list[HarvestSummaryLineResponse])
async def harvest_session_summary(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[HarvestSummaryLineResponse]:
    return [HarvestSummaryLineResponse(**line) for line in await get_harvest_summary(db, session_id)]


class InventoryPartResponse(BaseModel):
    id: int
    sticker_code: str
    printer_id: int | None
    printer_name: str | None
    archive_id: int | None
    part_code: str | None
    section_part_id: int | None
    part_name: str | None = None
    part_source: str | None = None
    print_name: str | None
    labeled_at: datetime
    archived_at: datetime | None
    released_at: datetime | None
    latest_event_action: str | None
    latest_event_reason: str | None


class PrintFailureReasonResponse(BaseModel):
    id: int
    printer_id: int
    printer_name: str | None
    archive_id: int | None
    print_name: str | None
    part_code: str | None
    reason_code: str
    reason_text: str | None
    stopped_at: datetime


class RelinkPartRequest(BaseModel):
    archive_id: int


class UnlinkPartRequest(BaseModel):
    reason_code: str
    reason_text: str | None = None

    @model_validator(mode="after")
    def validate_reason(self) -> UnlinkPartRequest:
        valid_codes = {code.value for code in UnlinkReasonCode}
        if self.reason_code not in valid_codes:
            raise ValueError(f"reason_code must be one of {sorted(valid_codes)}")
        if self.reason_code == UnlinkReasonCode.OTHER and not (self.reason_text or "").strip():
            raise ValueError("reason_text is required when reason_code is 'other'")
        return self


class ReplaceStickerRequest(BaseModel):
    new_sticker_code: str
    reason_code: str
    reason_text: str | None = None

    @model_validator(mode="after")
    def validate_reason(self) -> ReplaceStickerRequest:
        valid_codes = {code.value for code in ReplaceStickerReasonCode}
        if self.reason_code not in valid_codes:
            raise ValueError(f"reason_code must be one of {sorted(valid_codes)}")
        if self.reason_code == ReplaceStickerReasonCode.OTHER and not (self.reason_text or "").strip():
            raise ValueError("reason_text is required when reason_code is 'other'")
        return self


class InventoryPartEventResponse(BaseModel):
    id: int
    action: str
    details: dict | None
    occurred_at: datetime


class DeleteInventoryPartResponse(BaseModel):
    deleted: bool


class PartJobCandidateResponse(BaseModel):
    id: int
    print_name: str
    completed_at: datetime | None


class JobSearchResultResponse(BaseModel):
    id: int
    print_name: str
    printer_id: int | None
    printer_name: str | None
    completed_at: datetime | None


@router.get("/inventory/print-failures", response_model=list[PrintFailureReasonResponse])
async def get_print_failure_reasons(
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[PrintFailureReasonResponse]:
    capped_limit = max(1, min(limit, 100))
    return [
        PrintFailureReasonResponse(**record.__dict__)
        for record in await list_floor_stop_reasons(db, limit=capped_limit)
    ]


@router.patch("/inventory/print-failures/{reason_id}", response_model=PrintFailureReasonResponse)
async def edit_print_failure_reason(
    reason_id: int,
    body: FloorStopReasonRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> PrintFailureReasonResponse:
    updated = await update_floor_stop_reason(
        db,
        reason_id,
        body.reason_code,
        body.reason_text,
    )
    if updated is None:
        raise HTTPException(404, "Print failure reason not found")
    return PrintFailureReasonResponse(**updated.__dict__)


@router.delete("/inventory/print-failures/{reason_id}", status_code=204)
async def discard_print_failure_reason(
    reason_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> None:
    if not await delete_floor_stop_reason(db, reason_id):
        raise HTTPException(404, "Print failure reason not found")


@router.get("/inventory/parts", response_model=list[InventoryPartResponse])
async def get_inventory_parts(
    include_archived: bool = False,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[InventoryPartResponse]:
    return [
        InventoryPartResponse(**part.__dict__)
        for part in await list_inventory_parts(db, include_archived=include_archived)
    ]


@router.get("/inventory/parts/by-sticker/{sticker_code}", response_model=InventoryPartResponse)
async def get_inventory_part_by_sticker_route(
    sticker_code: str,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> InventoryPartResponse:
    part = await get_inventory_part_by_sticker(db, sticker_code)
    if part is None:
        raise HTTPException(404, "Part not found")
    return InventoryPartResponse(**part.__dict__)


@router.post("/inventory/parts/{part_id}/archive", response_model=InventoryPartResponse)
async def set_part_archived(
    part_id: int,
    archived: bool = True,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> InventoryPartResponse:
    part = await archive_part(db, part_id, archived=archived)
    if part is None:
        raise HTTPException(404, "Part not found")
    await db.commit()
    rows = await list_inventory_parts(db, include_archived=True)
    return next(InventoryPartResponse(**row.__dict__) for row in rows if row.id == part_id)


@router.delete("/inventory/parts/{part_id}", response_model=DeleteInventoryPartResponse)
async def delete_inventory_part(
    part_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> DeleteInventoryPartResponse:
    if not await delete_part(db, part_id):
        raise HTTPException(404, "Part not found")
    await db.commit()
    return DeleteInventoryPartResponse(deleted=True)


@router.post("/inventory/parts/{part_id}/relink", response_model=InventoryPartResponse)
async def relink_inventory_part(
    part_id: int,
    body: RelinkPartRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> InventoryPartResponse:
    part = await relink_part(db, part_id, body.archive_id)
    if part is None:
        raise HTTPException(404, "Part or completed job not found")
    await db.commit()
    rows = await list_inventory_parts(db, include_archived=True)
    return next(InventoryPartResponse(**row.__dict__) for row in rows if row.id == part_id)


@router.post("/inventory/parts/{part_id}/unlink", response_model=InventoryPartResponse)
async def unlink_inventory_part(
    part_id: int,
    body: UnlinkPartRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> InventoryPartResponse:
    part = await unlink_part(db, part_id, body.reason_code, body.reason_text)
    if part is None:
        # Deliberately a single catch-all, same terse style as `relink`'s
        # 404 above — not distinguishing "missing part" from "archived" from
        # "already unlinked" here keeps this endpoint's contract as simple as
        # relink's, and none of those cases needs a different client action.
        raise HTTPException(404, "Part not found or has nothing to unlink")
    await db.commit()
    rows = await list_inventory_parts(db, include_archived=True)
    return next(InventoryPartResponse(**row.__dict__) for row in rows if row.id == part_id)


@router.get("/inventory/parts/{part_id}/events", response_model=list[InventoryPartEventResponse])
async def get_inventory_part_events(
    part_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[InventoryPartEventResponse]:
    events = await list_part_events(db, part_id)
    if events is None:
        raise HTTPException(404, "Part not found")
    return [InventoryPartEventResponse(**event.__dict__) for event in events]


@router.get("/inventory/parts/{part_id}/job-candidates", response_model=list[PartJobCandidateResponse])
async def get_inventory_part_job_candidates(
    part_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[PartJobCandidateResponse]:
    candidates = await list_part_job_candidates(db, part_id)
    if candidates is None:
        raise HTTPException(404, "Part not found")
    return [PartJobCandidateResponse(**candidate.__dict__) for candidate in candidates]


@router.get("/inventory/jobs/search", response_model=list[JobSearchResultResponse])
async def search_inventory_jobs(
    q: str,
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[JobSearchResultResponse]:
    """The cross-printer escalation from `job-candidates` above (§ relink
    docstring): used when the recorded printer itself is wrong, so the
    reviewer needs every completed job, not just one printer's."""
    results = await search_completed_jobs(db, q, limit=limit)
    return [JobSearchResultResponse(**result.__dict__) for result in results]


@router.post("/inventory/parts/{part_id}/replace-sticker", response_model=InventoryPartResponse)
async def replace_inventory_part_sticker(
    part_id: int,
    body: ReplaceStickerRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> InventoryPartResponse:
    outcome = await replace_sticker_code(db, part_id, body.new_sticker_code, body.reason_code, body.reason_text)
    if outcome.result is ReplaceStickerResult.NOT_FOUND:
        raise HTTPException(404, "Part not found")
    if outcome.result is ReplaceStickerResult.ARCHIVED:
        raise HTTPException(400, "Part is archived")
    if outcome.result is ReplaceStickerResult.INVALID_CODE:
        raise HTTPException(400, "New sticker code is invalid or unchanged")
    if outcome.result is ReplaceStickerResult.CODE_IN_USE:
        raise HTTPException(409, "New sticker code is already in use")
    await db.commit()
    rows = await list_inventory_parts(db, include_archived=True)
    return next(InventoryPartResponse(**row.__dict__) for row in rows if row.id == part_id)


class SetPartCodeRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=32)


class SetPartStatusRequest(BaseModel):
    status: str = Field(..., min_length=1, max_length=32)


@router.post("/inventory/parts/{part_id}/status", response_model=InventoryPartResponse)
async def set_inventory_part_status(
    part_id: int,
    body: SetPartStatusRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> InventoryPartResponse:
    """Manually override a part's workflow status.

    The service normalizes and validates the value, then records it as an
    ordinary status event so the override remains visible in Part history.
    """
    outcome = await set_part_status(db, part_id, body.status)
    if outcome.result is SetPartStatusResult.NOT_FOUND:
        raise HTTPException(404, "Part not found")
    if outcome.result is SetPartStatusResult.ARCHIVED:
        raise HTTPException(400, "Part is archived")
    if outcome.result is SetPartStatusResult.INVALID_STATUS:
        raise HTTPException(400, "Status must be one of the supported part statuses")
    await db.commit()
    rows = await list_inventory_parts(db, include_archived=True)
    return next(InventoryPartResponse(**row.__dict__) for row in rows if row.id == part_id)


@router.post("/inventory/parts/{part_id}/part-code", response_model=InventoryPartResponse)
async def set_inventory_part_code(
    part_id: int,
    body: SetPartCodeRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> InventoryPartResponse:
    """Assign a Production part code to a part harvest couldn't resolve one
    for (§7) — only fills a gap; an already-set code must stay as recorded
    at harvest, so this refuses rather than overwrites."""
    outcome = await set_part_code(db, part_id, body.code)
    if outcome.result is SetPartCodeResult.NOT_FOUND:
        raise HTTPException(404, "Part not found")
    if outcome.result is SetPartCodeResult.ARCHIVED:
        raise HTTPException(400, "Part is archived")
    if outcome.result is SetPartCodeResult.ALREADY_SET:
        raise HTTPException(400, "Part already has a part code")
    if outcome.result is SetPartCodeResult.UNKNOWN_CODE:
        raise HTTPException(400, "Unknown part code")
    await db.commit()
    rows = await list_inventory_parts(db, include_archived=True)
    return next(InventoryPartResponse(**row.__dict__) for row in rows if row.id == part_id)


@router.delete("/inventory/parts/{part_id}/part-code", response_model=InventoryPartResponse)
async def clear_inventory_part_code(
    part_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> InventoryPartResponse:
    part = await clear_part_code(db, part_id)
    if part is None:
        raise HTTPException(404, "Part not found or archived")
    await db.commit()
    rows = await list_inventory_parts(db, include_archived=True)
    return next(InventoryPartResponse(**row.__dict__) for row in rows if row.id == part_id)


@router.get("/parts/needs-attention", response_model=NeedsAttentionResponse)
async def get_needs_attention(
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> NeedsAttentionResponse:
    """Parts with no job linked, newest first (§7.2, §9): the harvest label
    was applied but no archive could be resolved for it. Surfaced here so
    these can be matched to a job by hand later rather than discovered at a
    stock count."""
    parts, total = await list_needs_attention(db, limit=limit)
    return NeedsAttentionResponse(
        parts=[
            NeedsAttentionPartResponse(
                id=p.id,
                sticker_code=p.sticker_code,
                printer_id=p.printer_id,
                printer_name=p.printer_name,
                labeled_at=p.labeled_at,
            )
            for p in parts
        ],
        total=total,
    )


@router.get("/parts/unlabeled-build-plates", response_model=list[UnlabeledBuildPlateResponse])
async def get_unlabeled_build_plates(
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[UnlabeledBuildPlateResponse]:
    return [UnlabeledBuildPlateResponse(**plate) for plate in await list_unlabeled_build_plates(db, limit=limit)]


@router.post("/parts/unlabeled-build-plates/{archive_id}/dismiss")
async def dismiss_unlabeled_build_plate(
    archive_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> dict[str, str]:
    if not await dismiss_build_plate(db, archive_id):
        raise HTTPException(404, "Completed build plate not found")
    await db.commit()
    return {"status": "dismissed"}


@router.get("/parts/dismissed-build-plates", response_model=list[DismissedBuildPlateResponse])
async def get_dismissed_build_plates(
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> list[DismissedBuildPlateResponse]:
    return [DismissedBuildPlateResponse(**plate) for plate in await list_dismissed_build_plates(db, limit=limit)]


@router.post("/parts/dismissed-build-plates/{archive_id}/restore")
async def restore_dismissed_build_plate(
    archive_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FLOOR_SCAN),
) -> dict[str, str]:
    if not await restore_build_plate(db, archive_id):
        raise HTTPException(404, "Dismissed build plate not found")
    await db.commit()
    return {"status": "restored"}
