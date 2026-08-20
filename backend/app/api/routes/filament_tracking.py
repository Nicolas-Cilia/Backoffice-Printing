from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.filament_tracking import (
    FilamentColorBucket,
    FilamentColorUsage,
    FilamentSlotAssignment,
)
from backend.app.models.user import User
from backend.app.schemas.filament_tracking import (
    BucketCreate,
    BucketResponse,
    BucketStockUpdate,
    FilamentPlanResponse,
    LiveUsageProductResponse,
    LiveUsageRateResponse,
    MaterialPlanResponse,
    PrinterConsumptionResponse,
    SlotAssignmentCreate,
    SlotAssignmentResponse,
    UsageEventResponse,
)
from backend.app.services.filament_tracking import (
    clamp_lead_time_days,
    collapse_duplicate_live_usage,
    get_or_create_bucket,
    identity_or_none,
    load_live_usage_rate,
    load_plan,
    load_printer_consumption,
    normalize_color_name,
    normalize_effect_type,
    normalize_extra_colors,
    normalize_hex,
    normalize_identity_part,
    normalize_material,
    untracked_live_runs,
)

router = APIRouter(prefix="/filament-tracking", tags=["filament-tracking"])


def _plan_response(plan) -> FilamentPlanResponse:
    return FilamentPlanResponse(
        stage=plan.stage,
        days_observed=plan.days_observed,
        window_label=plan.window_label,
        materials=[
            MaterialPlanResponse(
                bucket_id=m.bucket_id,
                color_name=m.color_name,
                material=m.material,
                brand=m.brand,
                subtype=m.subtype,
                extra_colors=m.extra_colors,
                effect_type=m.effect_type,
                color_hex=m.color_hex,
                on_hand_grams=m.on_hand_grams,
                stock_initialized=m.stock_initialized,
                spool_weight_grams=m.spool_weight_grams,
                spool_equivalent=m.spool_equivalent,
                observed_usage_grams=m.observed_usage_grams,
                daily_rate_grams=m.daily_rate_grams,
                monthly_estimate_grams=m.monthly_estimate_grams,
                projected_remaining_grams=m.projected_remaining_grams,
                recommended_spools=m.recommended_spools,
                days_of_cover=m.days_of_cover,
                days_until_order=m.days_until_order,
                lead_time_days=m.lead_time_days,
                reorder_grams=m.reorder_grams,
                stage=m.stage,
                cost_per_kg=m.cost_per_kg,
                on_hand_value=m.on_hand_value,
                monthly_cost_estimate=m.monthly_cost_estimate,
            )
            for m in plan.materials
        ],
        total_on_hand_grams=plan.total_on_hand_grams,
        total_observed_usage_grams=plan.total_observed_usage_grams,
        total_monthly_estimate_grams=plan.total_monthly_estimate_grams,
        total_on_hand_value=plan.total_on_hand_value,
        total_monthly_cost_estimate=plan.total_monthly_cost_estimate,
        total_recommended_spools=plan.total_recommended_spools,
        soonest_days_until_order=plan.soonest_days_until_order,
        tracking_started_at=plan.tracking_started_at,
    )


@router.get("/plan", response_model=FilamentPlanResponse)
async def get_filament_plan(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_READ),
):
    return _plan_response(await load_plan(db))


@router.get("/buckets", response_model=list[BucketResponse])
async def list_buckets(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_READ),
):
    result = await db.execute(
        select(FilamentColorBucket).order_by(FilamentColorBucket.material, FilamentColorBucket.color_name)
    )
    return list(result.scalars().all())


@router.post("/buckets", response_model=BucketResponse)
async def create_or_add_bucket(
    data: BucketCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_UPDATE),
):
    try:
        bucket = await get_or_create_bucket(
            db,
            color_name=data.color_name,
            material=data.material,
            color_hex=data.color_hex,
            brand=data.brand,
            subtype=data.subtype,
            extra_colors=data.extra_colors,
            effect_type=data.effect_type,
        )
    except IntegrityError:
        raise HTTPException(
            409,
            "A tracking product with this color and material already exists. "
            "If you meant a different brand or subtype, existing databases may "
            "still unique on (color_name, material) until upgraded.",
        ) from None
    added = data.on_hand_grams or 0
    if added > 0:
        bucket.on_hand_grams = (bucket.on_hand_grams or 0) + added
        bucket.stock_initialized = True
    if data.spool_weight_grams:
        bucket.spool_weight_grams = data.spool_weight_grams
    if data.color_hex:
        bucket.color_hex = normalize_hex(data.color_hex)
    bucket.brand = normalize_identity_part(data.brand)
    bucket.subtype = normalize_identity_part(data.subtype)
    bucket.extra_colors = normalize_extra_colors(data.extra_colors)
    bucket.effect_type = normalize_effect_type(data.effect_type)
    if data.cost_per_kg is not None:
        bucket.cost_per_kg = data.cost_per_kg
    bucket.lead_time_days = clamp_lead_time_days(data.lead_time_days)
    if not bucket.stock_initialized and added == 0:
        bucket.on_hand_grams = 0
        bucket.stock_initialized = True
    if bucket.tracking_started_at is None:
        bucket.tracking_started_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(bucket)
    return bucket


@router.patch("/buckets/{bucket_id}", response_model=BucketResponse)
async def update_bucket_stock(
    bucket_id: int,
    data: BucketStockUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_UPDATE),
):
    bucket = await db.get(FilamentColorBucket, bucket_id)
    if not bucket:
        raise HTTPException(404, "Color stock not found")
    if data.on_hand_grams is not None:
        bucket.on_hand_grams = data.on_hand_grams
        bucket.stock_initialized = True
    if data.add_grams:
        bucket.on_hand_grams = max(0.0, (bucket.on_hand_grams or 0) + data.add_grams)
        bucket.stock_initialized = True
    if data.spool_weight_grams is not None:
        bucket.spool_weight_grams = data.spool_weight_grams
    if data.color_hex is not None:
        bucket.color_hex = normalize_hex(data.color_hex)
    if data.color_name is not None:
        bucket.color_name = normalize_color_name(data.color_name)
    if data.material is not None:
        bucket.material = normalize_material(data.material)
    if "brand" in data.model_fields_set:
        bucket.brand = normalize_identity_part(data.brand)
    if "subtype" in data.model_fields_set:
        bucket.subtype = normalize_identity_part(data.subtype)
    if "extra_colors" in data.model_fields_set:
        bucket.extra_colors = normalize_extra_colors(data.extra_colors)
    if "effect_type" in data.model_fields_set:
        bucket.effect_type = normalize_effect_type(data.effect_type)
    if "cost_per_kg" in data.model_fields_set:
        bucket.cost_per_kg = data.cost_per_kg
    if data.lead_time_days is not None:
        bucket.lead_time_days = clamp_lead_time_days(data.lead_time_days)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            409,
            "Another tracking product already uses this color, material, brand, and subtype.",
        ) from None
    await db.refresh(bucket)
    return bucket


@router.delete("/buckets/{bucket_id}")
async def delete_bucket(
    bucket_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_DELETE),
):
    bucket = await db.get(FilamentColorBucket, bucket_id)
    if not bucket:
        raise HTTPException(404, "Color stock not found")
    await db.delete(bucket)
    await db.commit()
    return {"status": "ok"}


def _assignment_response(assignment: FilamentSlotAssignment, bucket: FilamentColorBucket) -> SlotAssignmentResponse:
    return SlotAssignmentResponse(
        id=assignment.id,
        printer_id=assignment.printer_id,
        ams_id=assignment.ams_id,
        tray_id=assignment.tray_id,
        bucket_id=bucket.id,
        color_name=bucket.color_name,
        material=bucket.material,
        brand=identity_or_none(bucket.brand),
        subtype=identity_or_none(bucket.subtype),
        extra_colors=normalize_extra_colors(bucket.extra_colors) or None,
        effect_type=normalize_effect_type(bucket.effect_type) or None,
        color_hex=bucket.color_hex,
    )


@router.get("/assignments", response_model=list[SlotAssignmentResponse])
async def list_slot_assignments(
    printer_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_READ),
):
    query = select(FilamentSlotAssignment, FilamentColorBucket).join(
        FilamentColorBucket, FilamentSlotAssignment.bucket_id == FilamentColorBucket.id
    )
    if printer_id is not None:
        query = query.where(FilamentSlotAssignment.printer_id == printer_id)
    result = await db.execute(
        query.order_by(FilamentSlotAssignment.printer_id, FilamentSlotAssignment.ams_id, FilamentSlotAssignment.tray_id)
    )
    return [_assignment_response(assignment, bucket) for assignment, bucket in result.all()]


@router.post("/assignments", response_model=SlotAssignmentResponse)
async def upsert_slot_assignment(
    data: SlotAssignmentCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_UPDATE),
):
    bucket = await db.get(FilamentColorBucket, data.bucket_id)
    if not bucket:
        raise HTTPException(404, "Tracking product not found")
    result = await db.execute(
        select(FilamentSlotAssignment).where(
            FilamentSlotAssignment.printer_id == data.printer_id,
            FilamentSlotAssignment.ams_id == data.ams_id,
            FilamentSlotAssignment.tray_id == data.tray_id,
        )
    )
    assignment = result.scalar_one_or_none()
    if assignment:
        assignment.bucket_id = bucket.id
    else:
        assignment = FilamentSlotAssignment(
            printer_id=data.printer_id,
            ams_id=data.ams_id,
            tray_id=data.tray_id,
            bucket_id=bucket.id,
        )
        db.add(assignment)
    await db.commit()
    await db.refresh(assignment)
    return _assignment_response(assignment, bucket)


@router.delete("/assignments/{printer_id}/{ams_id}/{tray_id}")
async def delete_slot_assignment(
    printer_id: int,
    ams_id: int,
    tray_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_DELETE),
):
    result = await db.execute(
        select(FilamentSlotAssignment).where(
            FilamentSlotAssignment.printer_id == printer_id,
            FilamentSlotAssignment.ams_id == ams_id,
            FilamentSlotAssignment.tray_id == tray_id,
        )
    )
    assignment = result.scalar_one_or_none()
    if not assignment:
        raise HTTPException(404, "Slot assignment not found")
    await db.delete(assignment)
    await db.commit()
    return {"status": "ok"}


@router.get("/events", response_model=list[UsageEventResponse])
async def list_usage_events(
    limit: int = 40,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_READ),
):
    printer_ids = {
        pid
        for (pid,) in (
            await db.execute(
                select(FilamentColorUsage.printer_id)
                .where(
                    FilamentColorUsage.kind == "printing",
                    FilamentColorUsage.printer_id.is_not(None),
                )
                .distinct()
            )
        ).all()
        if pid is not None
    }
    for pid in printer_ids:
        await collapse_duplicate_live_usage(db, printer_id=pid)

    bucket = aliased(FilamentColorBucket)
    result = await db.execute(
        select(FilamentColorUsage, bucket)
        .join(bucket, FilamentColorUsage.bucket_id == bucket.id)
        .order_by(FilamentColorUsage.occurred_at.desc())
        .limit(max(1, min(limit, 200)))
    )
    rows = []
    for event, stock in result.all():
        rows.append(
            UsageEventResponse(
                id=event.id,
                bucket_id=event.bucket_id,
                color_name=stock.color_name,
                material=stock.material,
                brand=identity_or_none(stock.brand),
                subtype=identity_or_none(stock.subtype),
                extra_colors=normalize_extra_colors(stock.extra_colors) or None,
                effect_type=normalize_effect_type(stock.effect_type) or None,
                color_hex=stock.color_hex,
                grams=event.grams,
                occurred_at=event.occurred_at,
                kind=event.kind,
                progress=event.progress,
                archive_id=event.archive_id,
                printer_id=event.printer_id,
                print_name=event.print_name,
                estimated=bool(getattr(event, "estimated", False)),
            )
        )
    printing_printers = {row.printer_id for row in rows if row.kind == "printing" and row.printer_id is not None}
    for run in untracked_live_runs(printing_printers):
        rows.insert(
            0,
            UsageEventResponse(
                id=-run.printer_id,
                bucket_id=0,
                color_name="Unassigned",
                material="",
                brand=None,
                subtype=None,
                extra_colors=None,
                effect_type=None,
                color_hex=None,
                grams=0.0,
                occurred_at=run.started_at,
                kind="printing",
                progress=run.last_progress or None,
                archive_id=run.archive_id,
                printer_id=run.printer_id,
                print_name=run.print_name,
                estimated=False,
            ),
        )
    return rows


@router.get("/printer-consumption", response_model=list[PrinterConsumptionResponse])
async def list_printer_consumption(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_READ),
):
    return [
        PrinterConsumptionResponse(printer_id=row.printer_id, name=row.name, grams=row.grams)
        for row in await load_printer_consumption(db)
    ]


@router.get("/live-rate", response_model=LiveUsageRateResponse)
async def get_live_usage_rate(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_READ),
):
    rate = await load_live_usage_rate(db)
    return LiveUsageRateResponse(
        grams_per_hour=rate.grams_per_hour,
        grams_last_hour=rate.grams_last_hour,
        grams_so_far=rate.grams_so_far,
        active_jobs=rate.active_jobs,
        warming_up=rate.warming_up,
        products=[
            LiveUsageProductResponse(
                bucket_id=p.bucket_id,
                color_name=p.color_name,
                material=p.material,
                brand=p.brand,
                subtype=p.subtype,
                extra_colors=p.extra_colors,
                effect_type=p.effect_type,
                color_hex=p.color_hex,
                grams_so_far=p.grams_so_far,
                grams_last_hour=p.grams_last_hour,
                grams_per_hour=p.grams_per_hour,
            )
            for p in rate.products
        ],
    )
