"""Stats 2 API: schedule/BOM config + capacity/readiness/schedule endpoints."""

from __future__ import annotations

import io
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.schemas.stats2 import (
    BuildPlanResponse,
    CapacityHistoryResponse,
    CapacityResponse,
    DeviceRecipeOut,
    DeviceRecipePutRequest,
    DiscoveredSlotOut,
    EffectiveScheduleResponse,
    OverviewResponse,
    PrinterTimeBlockOut,
    PrinterTimeBlockPutRequest,
    PrinterTimeBlocksResponse,
    PrintPlanResponse,
    ReadinessResponse,
    ScheduleGlobals,
    SchedulePutRequest,
    ScheduleResponse,
    ScheduleShift,
    VariantCompareResponse,
)
from backend.app.services import device_recipe_service, operator_schedule_service, printer_time_block_service
from backend.app.services.capacity_analysis import (
    compute_build_plan,
    compute_capacity,
    compute_capacity_history,
    compute_overview,
    compute_variant_compare,
)
from backend.app.services.floor_lead_time_analysis import (
    compute_lead_time_detail,
    compute_lead_times,
    export_lead_times_csv_rows,
)
from backend.app.services.operator_schedule_service import ScheduleShiftIn
from backend.app.services.printer_time_block_service import TimeBlockIn
from backend.app.services.production_yield_analysis import (
    compute_funnel,
    compute_losses,
    compute_yield_detail,
    compute_yield_summary,
)
from backend.app.services.stats2_config import get_stats2_globals, set_stats2_globals, shop_today
from backend.app.services.stats2_export import build_stats2_export
from backend.app.services.stats2_filament import compute_filament_stats
from backend.app.services.stats2_plate_feedback import compute_plate_turnaround_feedback
from backend.app.services.stats2_print_plan import compute_print_plan
from backend.app.services.stats2_quality import compute_printer_reliability, compute_quality_reasons
from backend.app.services.stats2_readiness import compute_readiness
from backend.app.utils.http import build_content_disposition

router = APIRouter(prefix="/stats2", tags=["stats2"])


def _shift_out(row) -> ScheduleShift:
    return ScheduleShift(
        id=getattr(row, "id", None) if not isinstance(row, dict) else row.get("id"),
        day_of_week=row.day_of_week if not isinstance(row, dict) else row["day_of_week"],
        start_time=row.start_time if not isinstance(row, dict) else row["start_time"],
        end_time=row.end_time if not isinstance(row, dict) else row["end_time"],
        operator_count=row.operator_count if not isinstance(row, dict) else row["operator_count"],
        timezone=row.timezone if not isinstance(row, dict) else row["timezone"],
        enabled=row.enabled if not isinstance(row, dict) else row["enabled"],
    )


@router.get("/schedule", response_model=ScheduleResponse)
async def get_schedule(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> ScheduleResponse:
    shifts = await operator_schedule_service.get_schedule(db)
    globals_ = await get_stats2_globals(db)
    return ScheduleResponse(
        shifts=[_shift_out(s) for s in shifts],
        globals=ScheduleGlobals(
            expected_plate_clear_minutes=globals_.expected_plate_clear_minutes,
            production_line_start_time=globals_.production_line_start_time,
            pre_line_buffer_minutes=globals_.pre_line_buffer_minutes,
            timezone=globals_.timezone,
            ready_buffer_targets=dict(globals_.ready_buffer_targets),
        ),
    )


@router.put("/schedule", response_model=ScheduleResponse)
async def put_schedule(
    body: SchedulePutRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> ScheduleResponse:
    try:
        shifts_in = [
            ScheduleShiftIn(
                day_of_week=s.day_of_week,
                start_time=s.start_time,
                end_time=s.end_time,
                operator_count=s.operator_count,
                timezone=s.timezone,
                enabled=s.enabled,
            )
            for s in body.shifts
        ]
        await operator_schedule_service.replace_schedule(db, shifts_in)
        if body.globals is not None:
            await set_stats2_globals(
                db,
                expected_plate_clear_minutes=body.globals.expected_plate_clear_minutes,
                production_line_start_time=body.globals.production_line_start_time,
                pre_line_buffer_minutes=body.globals.pre_line_buffer_minutes,
                timezone=body.globals.timezone,
                ready_buffer_targets=body.globals.ready_buffer_targets,
            )
        await db.commit()
    except ValueError as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await get_schedule(db)


@router.get("/schedule/effective", response_model=EffectiveScheduleResponse)
async def get_schedule_effective(
    on_date: date | None = Query(None, alias="date"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> EffectiveScheduleResponse:
    target = on_date or await shop_today(db)
    effective = await operator_schedule_service.get_effective_schedule(db, target)
    return EffectiveScheduleResponse(
        date=effective.date,
        timezone=effective.timezone,
        shifts=[_shift_out(s) for s in effective.shifts],
        line_start_time=effective.line_start_time,
        pre_line_buffer_minutes=effective.pre_line_buffer_minutes,
        ready_deadline_time=effective.ready_deadline_time,
        expected_plate_clear_minutes=effective.expected_plate_clear_minutes,
        is_staffed=effective.is_staffed,
        day_of_week=effective.day_of_week,
        windows=effective.windows,
        peak_operator_count=effective.peak_operator_count,
        total_staffed_minutes=effective.total_staffed_minutes,
        staffed_now=effective.staffed_now,
        using_default_stub=effective.using_default_stub,
    )


@router.get("/device-recipe", response_model=DeviceRecipeOut)
async def get_device_recipe(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> DeviceRecipeOut:
    payload = await device_recipe_service.get_recipe_view(db)
    await db.commit()
    return DeviceRecipeOut.model_validate(payload)


@router.put("/device-recipe", response_model=DeviceRecipeOut)
async def put_device_recipe(
    body: DeviceRecipePutRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> DeviceRecipeOut:
    try:
        payload = await device_recipe_service.replace_recipe_lines(
            db,
            [
                {
                    "part_code": line.part_code,
                    "qty_per_device": line.qty_per_device,
                    "preferred_slot_id": line.preferred_slot_id,
                }
                for line in body.lines
            ],
        )
        await db.commit()
    except ValueError as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return DeviceRecipeOut.model_validate(payload)


@router.get("/device-recipe/discovered-slots", response_model=list[DiscoveredSlotOut])
async def get_discovered_slots(
    part_code: str = Query(..., min_length=1),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> list[DiscoveredSlotOut]:
    slots = await device_recipe_service.discover_slots_for_part_code(db, part_code)
    return [DiscoveredSlotOut.model_validate(s) for s in slots]


# ── Phase 3a ──────────────────────────────────────────────────────────────


@router.get("/overview", response_model=OverviewResponse)
async def get_overview(
    on_date: date | None = Query(None, alias="date"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> OverviewResponse:
    payload = await compute_overview(db, on_date=on_date)
    return OverviewResponse.model_validate(payload)


@router.get("/capacity", response_model=CapacityResponse)
async def get_capacity(
    on_date: date | None = Query(None, alias="date"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> CapacityResponse:
    payload = await compute_capacity(db, on_date=on_date)
    return CapacityResponse.model_validate(payload)


@router.get("/capacity/history", response_model=CapacityHistoryResponse)
async def get_capacity_history(
    days: int = Query(14, ge=1, le=90),
    end_date: date | None = Query(None, alias="end"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> CapacityHistoryResponse:
    payload = await compute_capacity_history(db, days=days, end_date=end_date)
    return CapacityHistoryResponse.model_validate(payload)


@router.get("/readiness", response_model=ReadinessResponse)
async def get_readiness(
    on_date: date | None = Query(None, alias="date"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> ReadinessResponse:
    payload = await compute_readiness(db, on_date=on_date)
    return ReadinessResponse.model_validate(payload)


@router.get("/device-recipe/build-plan", response_model=BuildPlanResponse)
async def get_build_plan(
    on_date: date | None = Query(None, alias="date"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> BuildPlanResponse:
    payload = await compute_build_plan(db, on_date=on_date)
    return BuildPlanResponse.model_validate(payload)


@router.get("/device-recipe/variant-compare", response_model=VariantCompareResponse)
async def get_variant_compare(
    part_code: str = Query(..., min_length=1),
    on_date: date | None = Query(None, alias="date"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> VariantCompareResponse:
    payload = await compute_variant_compare(db, part_code, on_date=on_date)
    return VariantCompareResponse.model_validate(payload)


@router.get("/schedule/print-plan", response_model=PrintPlanResponse)
async def get_print_plan(
    week_start: date | None = Query(None),
    target_devices: float | None = Query(None, ge=0),
    schedulable_ceiling: float | None = Query(
        None,
        ge=0,
        description="Measured schedulable devices/day (from /capacity). Used for short-part printer extras.",
    ),
    timeline_mode: str = Query(
        "capacity",
        description="capacity = target×BOM Gantt (default). buffer = catch up ready stock to min targets.",
    ),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> PrintPlanResponse:
    mode = (timeline_mode or "capacity").strip().lower()
    if mode not in ("capacity", "buffer"):
        raise HTTPException(status_code=400, detail="timeline_mode must be 'capacity' or 'buffer'")
    payload = await compute_print_plan(
        db,
        week_start=week_start,
        target_devices=target_devices,
        timeline_mode=mode,
        schedulable_ceiling=schedulable_ceiling,
        # Re-pack with virtual lanes only for explicit what-if asks — never for
        # capacity binary-search probes inside measure_schedulable_devices.
        allow_hypothetical_fleet=target_devices is not None,
    )
    return PrintPlanResponse.model_validate(payload)


@router.get("/printer-time-blocks", response_model=PrinterTimeBlocksResponse)
async def get_printer_time_blocks(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
) -> PrinterTimeBlocksResponse:
    rows = await printer_time_block_service.list_blocks(db)
    return PrinterTimeBlocksResponse(blocks=[PrinterTimeBlockOut.model_validate(r.to_dict()) for r in rows])


@router.put("/printer-time-blocks/{printer_id}", response_model=PrinterTimeBlocksResponse)
async def put_printer_time_blocks(
    printer_id: int,
    body: PrinterTimeBlockPutRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> PrinterTimeBlocksResponse:
    try:
        await printer_time_block_service.replace_blocks_for_printer(
            db,
            printer_id,
            [
                TimeBlockIn(
                    day_of_week=b.day_of_week,
                    start_time=b.start_time,
                    end_time=b.end_time,
                    label=b.label,
                    enabled=b.enabled,
                )
                for b in body.blocks
            ],
        )
        await db.commit()
    except ValueError as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    rows = await printer_time_block_service.list_blocks(db)
    return PrinterTimeBlocksResponse(blocks=[PrinterTimeBlockOut.model_validate(r.to_dict()) for r in rows])


# ── Phase 3b ──────────────────────────────────────────────────────────────


@router.get("/yield")
async def get_yield(
    lookback_days: int = Query(30, ge=1, le=365),
    part_code: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    return await compute_yield_summary(db, lookback_days=lookback_days, part_code=part_code)


@router.get("/yield/{part_code}")
async def get_yield_detail(
    part_code: str,
    lookback_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    return await compute_yield_detail(db, part_code, lookback_days=lookback_days)


@router.get("/funnel")
async def get_funnel(
    lookback_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    return await compute_funnel(db, lookback_days=lookback_days)


@router.get("/losses")
async def get_losses(
    lookback_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    return await compute_losses(db, lookback_days=lookback_days)


@router.get("/quality-reasons")
async def get_quality_reasons(
    category: str = Query("all"),
    printer_id: int | None = Query(None),
    lookback_days: int = Query(30, ge=1, le=365),
    include_rows: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    return await compute_quality_reasons(
        db,
        category=category,
        printer_id=printer_id,
        lookback_days=lookback_days,
        include_rows=include_rows,
    )


@router.get("/failures")
async def get_failures(
    printer_id: int | None = Query(None),
    lookback_days: int = Query(30, ge=1, le=365),
    include_rows: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    return await compute_quality_reasons(
        db,
        category="print",
        printer_id=printer_id,
        lookback_days=lookback_days,
        include_rows=include_rows,
    )


@router.get("/printers/reliability")
async def get_printer_reliability(
    lookback_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    return await compute_printer_reliability(db, lookback_days=lookback_days)


@router.get("/plate-turnaround/feedback")
async def get_plate_turnaround_feedback(
    lookback_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    return await compute_plate_turnaround_feedback(db, lookback_days=lookback_days)


@router.get("/filament")
async def get_filament(
    lookback_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    return await compute_filament_stats(db, lookback_days=lookback_days)


@router.get("/lead-times")
async def get_lead_times(
    lookback_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    return await compute_lead_times(db, lookback_days=lookback_days)


@router.get("/lead-times/export")
async def get_lead_times_export(
    lookback_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    rows = await export_lead_times_csv_rows(db, lookback_days=lookback_days)
    return {"rows": rows, "lookback_days": lookback_days}


@router.get("/lead-times/{metric_id}")
async def get_lead_time_detail(
    metric_id: str,
    lookback_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    return await compute_lead_time_detail(db, metric_id, lookback_days=lookback_days)


@router.get("/export")
async def export_stats2(
    format: str = Query("csv", description="csv or xlsx"),
    lookback_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.STATS_READ),
):
    """Download a multi-section Stats 2 capacity/analytics report."""
    if format not in ("csv", "xlsx"):
        raise HTTPException(status_code=400, detail="Format must be 'csv' or 'xlsx'")
    try:
        file_bytes, filename, content_type = await build_stats2_export(db, format=format, lookback_days=lookback_days)
    except ImportError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return StreamingResponse(
        io.BytesIO(file_bytes),
        media_type=content_type,
        headers={"Content-Disposition": build_content_disposition(filename)},
    )
