from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from backend.app.models.filament_tracking import FilamentColorBucket, FilamentColorUsage, FilamentSlotAssignment
from backend.app.services.filament_tracking import (
    PlanBucket,
    PlanEvent,
    SlotUsage,
    calibration_stage,
    compute_purchase_plan,
    get_or_create_bucket,
    global_tray_to_slot,
    hex_to_basic_color_name,
    load_printer_consumption,
    mapping_tray_id,
    normalize_color_name,
    normalize_effect_type,
    normalize_extra_colors,
    normalize_identity_part,
    normalize_material,
    partial_progress_scale,
    record_print_usage,
    scale_slots,
)


def test_product_names_stay_distinct():
    assert normalize_color_name("EasyRock White") == "EasyRock White"
    assert normalize_color_name("  Jade White  ") == "Jade White"
    assert normalize_color_name("EasyRock White") != normalize_color_name("Jade White")


def test_global_tray_maps_ams_and_external_slots():
    assert global_tray_to_slot(0) == (0, 0)
    assert global_tray_to_slot(5) == (1, 1)
    assert global_tray_to_slot(254) == (255, 0)
    assert global_tray_to_slot(-1) == (255, 0)
    assert mapping_tray_id(1, [5, -1]) == 5
    assert mapping_tray_id(2, [5, -1]) == -1
    assert mapping_tray_id(3, [5, -1]) is None


def test_hex_to_basic_color_name_white_and_black():
    assert hex_to_basic_color_name("FFFFFF") == "White"
    assert hex_to_basic_color_name("#000000") == "Black"
    assert hex_to_basic_color_name("#00000000") == "Clear"


def test_normalize_material_uppercases():
    assert normalize_material(" pla ") == "PLA"
    assert normalize_material(None) == "UNKNOWN"


def test_identity_parts_normalize_blank_consistently():
    assert normalize_identity_part(None) == ""
    assert normalize_identity_part("  Bambu  Lab ") == "Bambu Lab"
    assert normalize_extra_colors(None) == ""
    assert normalize_extra_colors("#EC984C, 6CD4BC") == "ec984c,6cd4bc"
    assert normalize_effect_type(" Sparkle ") == "sparkle"
    assert normalize_effect_type(None) == ""


def test_failed_print_scales_each_slot_by_progress():
    slots = [
        SlotUsage(color_hex="FFFFFF", color_name="White", material="PLA", grams=800),
        SlotUsage(color_hex="000000", color_name="Black", material="PLA", grams=200),
    ]
    scaled = scale_slots(slots, "failed", 50)
    assert [s.grams for s in scaled] == [400.0, 100.0]
    assert partial_progress_scale("completed", 12) == 1.0
    assert partial_progress_scale("cancelled", 0) == 0.0


def test_plan_collecting_hides_monthly_estimate():
    now = datetime(2026, 8, 18, tzinfo=timezone.utc)
    plan = compute_purchase_plan(
        [
            PlanBucket(
                id=1,
                color_name="White",
                material="PLA",
                color_hex="FFFFFF",
                on_hand_grams=100_000,
                spool_weight_grams=1000,
                stock_initialized=True,
                tracking_started_at=now - timedelta(hours=2),
            )
        ],
        [
            PlanEvent(1, 500, now - timedelta(hours=1), "completed"),
        ],
        as_of=now,
    )
    assert plan.stage == "collecting"
    assert plan.materials[0].monthly_estimate_grams == 0
    assert plan.total_recommended_spools == 0
    assert plan.materials[0].days_until_order is None
    assert plan.soonest_days_until_order is None


def test_plan_week_stage_extrapolates_and_recommends_spools():
    now = datetime(2026, 8, 18, tzinfo=timezone.utc)
    started = now - timedelta(days=10)
    events = [PlanEvent(1, 1000, started + timedelta(days=day), "completed") for day in range(3, 10)]
    plan = compute_purchase_plan(
        [
            PlanBucket(
                id=1,
                color_name="White",
                material="PLA",
                color_hex="FFFFFF",
                on_hand_grams=2000,
                spool_weight_grams=1000,
                stock_initialized=True,
                tracking_started_at=started,
            )
        ],
        events,
        as_of=now,
    )
    assert plan.stage == "week"
    white = plan.materials[0]
    assert white.daily_rate_grams == 1000
    assert white.monthly_estimate_grams == 30_000
    assert white.recommended_spools == 30
    assert white.lead_time_days == 7
    assert white.reorder_grams == 7000
    assert white.days_of_cover == 2
    assert white.days_until_order == 0
    assert plan.soonest_days_until_order == 0


def test_plan_orders_when_stock_only_lasts_through_shipping():
    now = datetime(2026, 8, 18, tzinfo=timezone.utc)
    started = now - timedelta(days=10)
    events = [PlanEvent(1, 1000, started + timedelta(days=day), "completed") for day in range(3, 10)]
    plan = compute_purchase_plan(
        [
            PlanBucket(
                id=1,
                color_name="White",
                material="PLA",
                color_hex="FFFFFF",
                on_hand_grams=8000,
                spool_weight_grams=1000,
                stock_initialized=True,
                tracking_started_at=started,
            )
        ],
        events,
        as_of=now,
    )
    assert plan.materials[0].recommended_spools == 0


def test_plan_uses_per_product_lead_times():
    now = datetime(2026, 8, 18, tzinfo=timezone.utc)
    started = now - timedelta(days=10)
    events = [PlanEvent(1, 1000, started + timedelta(days=day), "completed") for day in range(3, 10)] + [
        PlanEvent(2, 1000, started + timedelta(days=day), "completed") for day in range(3, 10)
    ]
    plan = compute_purchase_plan(
        [
            PlanBucket(
                id=1,
                color_name="EasyRock White",
                material="PLA",
                color_hex="FFFFFF",
                on_hand_grams=8000,
                spool_weight_grams=1000,
                stock_initialized=True,
                tracking_started_at=started,
                lead_time_days=7,
            ),
            PlanBucket(
                id=2,
                color_name="Jade White",
                material="PLA",
                color_hex="FFFFFF",
                on_hand_grams=8000,
                spool_weight_grams=1000,
                stock_initialized=True,
                tracking_started_at=started,
                lead_time_days=14,
            ),
        ],
        events,
        as_of=now,
    )
    easyrock = next(m for m in plan.materials if m.color_name == "EasyRock White")
    jade = next(m for m in plan.materials if m.color_name == "Jade White")
    assert easyrock.lead_time_days == 7
    assert easyrock.recommended_spools == 0
    assert easyrock.days_of_cover == 8
    assert easyrock.days_until_order == 1
    assert jade.lead_time_days == 14
    assert jade.reorder_grams == 14000
    assert jade.recommended_spools == 30
    assert jade.days_of_cover == 8
    assert jade.days_until_order == 0
    assert plan.soonest_days_until_order == 0


def test_plan_includes_stock_value_from_cost():
    now = datetime(2026, 8, 18, tzinfo=timezone.utc)
    started = now - timedelta(days=10)
    events = [PlanEvent(1, 1000, started + timedelta(days=day), "completed") for day in range(3, 10)]
    plan = compute_purchase_plan(
        [
            PlanBucket(
                id=1,
                color_name="White",
                material="PLA",
                color_hex="FFFFFF",
                on_hand_grams=2000,
                spool_weight_grams=1000,
                stock_initialized=True,
                tracking_started_at=started,
                cost_per_kg=20,
            )
        ],
        events,
        as_of=now,
    )
    white = plan.materials[0]
    assert white.cost_per_kg == 20
    assert white.on_hand_value == 40.0
    assert white.monthly_cost_estimate == 600.0
    assert plan.total_on_hand_value == 40.0
    assert plan.total_monthly_cost_estimate == 600.0


def test_failed_usage_counts_toward_observed_rate():
    now = datetime(2026, 8, 18, tzinfo=timezone.utc)
    started = now - timedelta(days=8)
    plan = compute_purchase_plan(
        [
            PlanBucket(
                id=1,
                color_name="Black",
                material="PETG",
                color_hex="000000",
                on_hand_grams=5000,
                spool_weight_grams=1000,
                stock_initialized=True,
                tracking_started_at=started,
            )
        ],
        [
            PlanEvent(1, 200, now - timedelta(days=2), "failed"),
            PlanEvent(1, 500, now - timedelta(days=1), "completed"),
        ],
        as_of=now,
    )
    assert plan.materials[0].observed_usage_grams == 700


def test_calibration_stage_boundaries():
    assert calibration_stage(0.5) == "collecting"
    assert calibration_stage(1) == "day"
    assert calibration_stage(6.9) == "day"
    assert calibration_stage(7) == "week"
    assert calibration_stage(29.9) == "week"
    assert calibration_stage(30) == "month"


@pytest.mark.asyncio
async def test_print_usage_subtracts_assigned_product_only(db_session, printer_factory):
    printer = await printer_factory()
    easyrock = FilamentColorBucket(
        color_name="EasyRock White",
        material="PLA",
        color_hex="FFFFFF",
        on_hand_grams=10000,
        spool_weight_grams=1000,
        stock_initialized=True,
    )
    jade = FilamentColorBucket(
        color_name="Jade White",
        material="PLA",
        color_hex="FFFFFF",
        on_hand_grams=8000,
        spool_weight_grams=1000,
        stock_initialized=True,
    )
    db_session.add_all([easyrock, jade])
    await db_session.flush()
    db_session.add(
        FilamentSlotAssignment(
            printer_id=printer.id,
            ams_id=0,
            tray_id=0,
            bucket_id=easyrock.id,
        )
    )
    await db_session.commit()

    created = await record_print_usage(
        db_session,
        slots=[{"slot_id": 1, "used_g": 500, "type": "PLA", "color": "#FFFFFF"}],
        status="completed",
        progress=100,
        archive_id=1,
        printer_id=printer.id,
        print_name="Benchy",
        ams_mapping=[0],
    )
    await db_session.commit()
    await db_session.refresh(easyrock)
    await db_session.refresh(jade)

    assert len(created) == 1
    assert created[0].bucket_id == easyrock.id
    assert easyrock.on_hand_grams == 9500
    assert jade.on_hand_grams == 8000


@pytest.mark.asyncio
async def test_unassigned_slot_does_not_create_family_bucket(db_session, printer_factory):
    printer = await printer_factory()
    created = await record_print_usage(
        db_session,
        slots=[{"slot_id": 1, "used_g": 500, "type": "PLA", "color": "#FFFFFF"}],
        status="completed",
        progress=100,
        archive_id=2,
        printer_id=printer.id,
        print_name="Unassigned",
        ams_mapping=[0],
    )
    assert created == []
    buckets = (await db_session.execute(select(FilamentColorBucket))).scalars().all()
    assert buckets == []


@pytest.mark.asyncio
async def test_get_or_create_treats_brand_subtype_as_distinct_sku(db_session):
    basic = await get_or_create_bucket(
        db_session,
        color_name="White",
        material="PLA",
        color_hex="FFFFFF",
        brand="Bambu",
        subtype="Basic",
    )
    matte = await get_or_create_bucket(
        db_session,
        color_name="White",
        material="PLA",
        color_hex="FFFFFF",
        brand="Bambu",
        subtype="Matte",
    )
    again = await get_or_create_bucket(
        db_session,
        color_name="White",
        material="PLA",
        color_hex="FFFFFF",
        brand="Bambu",
        subtype="Basic",
    )
    await db_session.flush()
    assert basic.id != matte.id
    assert again.id == basic.id
    buckets = (await db_session.execute(select(FilamentColorBucket))).scalars().all()
    assert len(buckets) == 2


@pytest.mark.asyncio
async def test_printer_consumption_sums_usage_per_printer(db_session, printer_factory):
    first = await printer_factory()
    second = await printer_factory()
    bucket = FilamentColorBucket(
        color_name="White",
        material="PLA",
        color_hex="FFFFFF",
        on_hand_grams=10000,
        spool_weight_grams=1000,
        stock_initialized=True,
    )
    db_session.add(bucket)
    await db_session.flush()
    db_session.add_all(
        [
            FilamentColorUsage(
                bucket_id=bucket.id,
                grams=200,
                kind="completed",
                printer_id=first.id,
                source_key="test:printer-a",
            ),
            FilamentColorUsage(
                bucket_id=bucket.id,
                grams=50,
                kind="failed",
                printer_id=first.id,
                source_key="test:printer-a-fail",
            ),
            FilamentColorUsage(
                bucket_id=bucket.id,
                grams=80,
                kind="completed",
                printer_id=second.id,
                source_key="test:printer-b",
            ),
        ]
    )
    await db_session.commit()

    rows = await load_printer_consumption(db_session)
    by_id = {row.printer_id: row.grams for row in rows}
    assert by_id[first.id] == 250
    assert by_id[second.id] == 80
    assert rows[0].printer_id == first.id
