from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from backend.app.models.filament_tracking import FilamentColorBucket, FilamentColorUsage, FilamentSlotAssignment
from backend.app.services.filament_tracking import (
    LIVE_USAGE_KIND,
    LiveUsageSample,
    PlanBucket,
    PlanEvent,
    SlotUsage,
    align_mapping_to_used_slots,
    calibration_stage,
    collapse_duplicate_live_usage,
    compute_live_usage_rate,
    compute_purchase_plan,
    decode_mqtt_slot_mapping,
    find_exact_named_3mf,
    get_or_create_bucket,
    global_tray_to_slot,
    hex_to_basic_color_name,
    infer_elapsed_seconds,
    live_usage_window,
    load_live_usage_rate,
    load_printer_consumption,
    mapping_tray_id,
    mqtt_skipped_object_ids,
    normalize_color_name,
    normalize_effect_type,
    normalize_extra_colors,
    normalize_identity_part,
    normalize_material,
    observed_print_trays,
    parse_mqtt_tray_remain,
    partial_progress_scale,
    print_job_stem,
    printer_tracking_lock,
    record_print_usage,
    remain_delta_grams,
    remain_has_coverage,
    resolve_ams_mapping,
    resolve_print_started_at,
    same_live_tracking_job,
    scale_slots,
    slot_to_global_tray,
    slots_from_3mf_file,
    slots_from_remain_deltas,
    tracking_run_id,
    tracking_slots_from_usage_results,
    usage_kind_for,
    usage_source_key,
)


def test_product_names_stay_distinct():
    assert normalize_color_name("EasyRock White") == "EasyRock White"
    assert normalize_color_name("  Jade White  ") == "Jade White"
    assert normalize_color_name("EasyRock White") != normalize_color_name("Jade White")


def test_print_job_stem_is_exact_basename_equality():
    assert print_job_stem("cache/panel-reprint.gcode.3mf") == "panel-reprint"
    assert print_job_stem("panel-reprint.3mf") == "panel-reprint"
    assert print_job_stem("panel-reprint.gcode") == "panel-reprint"
    assert print_job_stem("PANEL-REPRINT.GCODE.3MF") == "panel-reprint"
    assert print_job_stem("panel-reprint-v2.3mf") == "panel-reprint-v2"
    assert print_job_stem("panel-reprint") != print_job_stem("panel-reprint-v2")
    assert print_job_stem("benchy") != print_job_stem("benchy_v2.3mf")
    assert print_job_stem("") == ""
    assert print_job_stem(".3mf") == ""
    assert print_job_stem("BOT-x2-1.8.2-X1C") == print_job_stem("BOT x2 - 1.8.2 - X1C")
    assert print_job_stem("BOT_x2_-_1.8.2_-_X1C") == print_job_stem("BOT-x2-1.8.2-X1C")
    assert print_job_stem("BOT-x2-1.8.2-X1C") != print_job_stem("BOT-x4-1.8.2-X1C")
    assert print_job_stem("/data/Metadata/plate_1.gcode") == "plate-1"


def test_global_tray_maps_ams_and_external_slots():
    assert global_tray_to_slot(0) == (0, 0)
    assert global_tray_to_slot(5) == (1, 1)
    assert global_tray_to_slot(254) == (255, 0)
    assert global_tray_to_slot(-1) == (255, 0)
    assert mapping_tray_id(1, [5, -1]) == 5
    assert mapping_tray_id(2, [5, -1]) is None
    assert mapping_tray_id(3, [5, -1]) is None
    assert mapping_tray_id(2, [5]) is None
    assert mapping_tray_id(2, align_mapping_to_used_slots([5], [{"slot_id": 2, "used_g": 1}])) == 5


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
    assert usage_kind_for("cancelled") == "cancelled"
    assert usage_kind_for("aborted") == "aborted"
    assert usage_kind_for("canceled") == "cancelled"
    assert usage_kind_for("stopped") == "cancelled"
    assert partial_progress_scale("stopped", 40) == 0.4


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


@pytest.mark.asyncio
async def test_printer_consumption_includes_live_printing_on_that_printer(db_session, printer_factory):
    founders = await printer_factory(name="Founders (6)")
    trump = await printer_factory(name="Trump (4)")
    white = FilamentColorBucket(
        color_name="EasyRock White",
        material="PLA",
        color_hex="FFFFFF",
        on_hand_grams=10000,
        spool_weight_grams=1000,
        stock_initialized=True,
    )
    black = FilamentColorBucket(
        color_name="Black",
        material="PLA",
        color_hex="000000",
        on_hand_grams=10000,
        spool_weight_grams=1000,
        stock_initialized=True,
    )
    db_session.add_all([white, black])
    await db_session.flush()
    db_session.add_all(
        [
            FilamentColorUsage(
                bucket_id=white.id,
                grams=21.1,
                kind=LIVE_USAGE_KIND,
                progress=12,
                printer_id=founders.id,
                print_name="BTN-x47-.2mm-height-.53-width-1.0.0-X1C",
                source_key="track:a5:1:0:0",
            ),
            FilamentColorUsage(
                bucket_id=black.id,
                grams=3.4,
                kind=LIVE_USAGE_KIND,
                progress=12,
                printer_id=founders.id,
                print_name="BTN-x47-.2mm-height-.53-width-1.0.0-X1C",
                source_key="track:a5:2:0:2",
            ),
        ]
    )
    await db_session.commit()

    rows = await load_printer_consumption(db_session)
    by_id = {row.printer_id: row.grams for row in rows}
    assert by_id[founders.id] == pytest.approx(24.5)
    assert by_id[trump.id] == 0
    # Names like "Trump (4)" are labels, not printer_id 4.
    assert {row.printer_id for row in rows} == {founders.id, trump.id}


@pytest.mark.asyncio
async def test_printer_consumption_live_grams_follow_event_printer_id(db_session, printer_factory):
    """kind=printing counts on the usage row's printer_id, not the name suffix."""
    trump = await printer_factory(name="Trump (4)")
    founders = await printer_factory(name="Founders (6)")
    white = FilamentColorBucket(
        color_name="EasyRock White",
        material="PLA",
        color_hex="FFFFFF",
        on_hand_grams=10000,
        spool_weight_grams=1000,
        stock_initialized=True,
    )
    black = FilamentColorBucket(
        color_name="Black",
        material="PLA",
        color_hex="000000",
        on_hand_grams=10000,
        spool_weight_grams=1000,
        stock_initialized=True,
    )
    db_session.add_all([white, black])
    await db_session.flush()
    db_session.add_all(
        [
            FilamentColorUsage(
                bucket_id=white.id,
                grams=21.1,
                kind=LIVE_USAGE_KIND,
                progress=12,
                printer_id=founders.id,
                print_name="BTN-x47-.2mm-height-.53-width-1.0.0-X1C",
                source_key="track:a5:1:0:0",
            ),
            FilamentColorUsage(
                bucket_id=black.id,
                grams=3.4,
                kind=LIVE_USAGE_KIND,
                progress=12,
                printer_id=trump.id,
                print_name="BTN-x47-.2mm-height-.53-width-1.0.0-X1C",
                source_key="track:a5:2:0:2",
            ),
        ]
    )
    await db_session.commit()

    rows = await load_printer_consumption(db_session)
    by_id = {row.printer_id: row.grams for row in rows}
    by_name = {row.name: row.grams for row in rows}
    assert by_id[trump.id] == pytest.approx(3.4)
    assert by_id[founders.id] == pytest.approx(21.1)
    assert by_name["Trump (4)"] == pytest.approx(3.4)
    assert by_name["Founders (6)"] == pytest.approx(21.1)


def test_resolve_mapping_prefers_send_then_mqtt_then_tray_now():
    assert resolve_ams_mapping(ams_mapping=[5, -1]) == [5, -1]
    assert decode_mqtt_slot_mapping([0, 257]) == [0, 5]
    assert decode_mqtt_slot_mapping([4]) == [4]
    assert resolve_ams_mapping(mqtt_mapping=[0]) == [0]
    assert resolve_ams_mapping(mqtt_mapping=[4]) == [4]
    assert resolve_ams_mapping(tray_now=5, slot_count=1) == [5]
    assert resolve_ams_mapping(tray_now=5, slot_count=2) is None
    assert resolve_ams_mapping(tray_now=255, slot_count=1) == [255]
    assert resolve_ams_mapping() is None
    assert slot_to_global_tray(0, 0) == 0
    assert slot_to_global_tray(1, 1) == 5
    assert slot_to_global_tray(255, 0) == 254
    assert (
        tracking_run_id(
            archive_id=12,
            printer_id=1,
            print_name="Benchy",
            started_at=datetime(2026, 8, 20, 17, 0, 0, tzinfo=timezone.utc),
        )
        == "a12-20260820170000"
    )


def test_usage_results_become_unscaled_slots_with_physical_mapping():
    slots, mapping = tracking_slots_from_usage_results(
        [
            {"weight_used": 80.0, "slot_id": None, "ams_id": 0, "tray_id": 0, "material": "PLA"},
            {"weight_used": 0, "ams_id": 0, "tray_id": 1},
        ]
    )
    assert slots == [{"slot_id": 1, "used_g": 80.0, "type": "PLA", "color": None}]
    assert mapping == [0]


async def _white_on_slot0(db_session, printer_factory, on_hand=10000):
    printer = await printer_factory()
    bucket = FilamentColorBucket(
        color_name="EasyRock White",
        material="PLA",
        color_hex="FFFFFF",
        on_hand_grams=on_hand,
        spool_weight_grams=1000,
        stock_initialized=True,
    )
    db_session.add(bucket)
    await db_session.flush()
    db_session.add(
        FilamentSlotAssignment(
            printer_id=printer.id,
            ams_id=0,
            tray_id=0,
            bucket_id=bucket.id,
        )
    )
    await db_session.commit()
    return printer, bucket


@pytest.mark.asyncio
async def test_live_progress_upsert_does_not_double_count(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    started = datetime(2026, 8, 20, 17, 0, 0, tzinfo=timezone.utc)
    slots = [{"slot_id": 1, "used_g": 500, "type": "PLA", "color": "#FFFFFF"}]

    await record_print_usage(
        db_session,
        slots=slots,
        status="printing",
        progress=50,
        archive_id=10,
        printer_id=printer.id,
        print_name="Benchy",
        started_at=started,
        occurred_at=started,
        ams_mapping=[0],
    )
    await db_session.commit()
    await db_session.refresh(bucket)
    assert bucket.on_hand_grams == 9750

    await record_print_usage(
        db_session,
        slots=slots,
        status="printing",
        progress=80,
        archive_id=10,
        printer_id=printer.id,
        print_name="Benchy",
        started_at=started,
        occurred_at=started,
        ams_mapping=[0],
    )
    await db_session.commit()
    await db_session.refresh(bucket)
    assert bucket.on_hand_grams == 9600

    created = await record_print_usage(
        db_session,
        slots=slots,
        status="completed",
        progress=100,
        archive_id=10,
        printer_id=printer.id,
        print_name="Benchy",
        started_at=started,
        occurred_at=started + timedelta(hours=1),
        ams_mapping=[0],
    )
    await db_session.commit()
    await db_session.refresh(bucket)

    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == 500
    assert events[0].kind == "completed"
    assert events[0].source_key == created[0].source_key
    assert bucket.on_hand_grams == 9500


@pytest.mark.asyncio
async def test_reprint_uses_printer_slot_state_without_send_mapping(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    started = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)

    created = await record_print_usage(
        db_session,
        slots=[{"slot_id": 1, "used_g": 200, "type": "PLA", "color": "#FFFFFF"}],
        status="completed",
        progress=100,
        archive_id=None,
        printer_id=printer.id,
        print_name="panel-reprint",
        started_at=started,
        occurred_at=started,
        ams_mapping=None,
        tray_now=0,
    )
    await db_session.commit()
    await db_session.refresh(bucket)

    assert len(created) == 1
    assert created[0].bucket_id == bucket.id
    assert bucket.on_hand_grams == 9800

    again = await record_print_usage(
        db_session,
        slots=[{"slot_id": 1, "used_g": 200, "type": "PLA", "color": "#FFFFFF"}],
        status="completed",
        progress=100,
        archive_id=None,
        printer_id=printer.id,
        print_name="panel-reprint",
        started_at=started,
        occurred_at=started,
        mqtt_mapping=[0],
    )
    await db_session.commit()
    await db_session.refresh(bucket)
    assert again[0].id == created[0].id
    assert bucket.on_hand_grams == 9800


@pytest.mark.asyncio
async def test_unassigned_reprint_slot_is_skipped(db_session, printer_factory):
    printer = await printer_factory()
    created = await record_print_usage(
        db_session,
        slots=[{"slot_id": 1, "used_g": 500, "type": "PLA", "color": "#FFFFFF"}],
        status="completed",
        progress=100,
        archive_id=None,
        printer_id=printer.id,
        print_name="studio-send",
        tray_now=0,
        mqtt_mapping=[0],
    )
    assert created == []
    buckets = (await db_session.execute(select(FilamentColorBucket))).scalars().all()
    assert buckets == []


@pytest.mark.asyncio
async def test_failed_live_settles_scaled_by_progress(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    started = datetime(2026, 8, 20, 19, 0, 0, tzinfo=timezone.utc)
    slots = [{"slot_id": 1, "used_g": 500, "type": "PLA", "color": "#FFFFFF"}]

    await record_print_usage(
        db_session,
        slots=slots,
        status="printing",
        progress=40,
        archive_id=22,
        printer_id=printer.id,
        print_name="Failing",
        started_at=started,
        occurred_at=started,
        ams_mapping=[0],
    )
    await db_session.commit()
    await db_session.refresh(bucket)
    assert bucket.on_hand_grams == 9800

    await record_print_usage(
        db_session,
        slots=slots,
        status="failed",
        progress=40,
        archive_id=22,
        printer_id=printer.id,
        print_name="Failing",
        started_at=started,
        occurred_at=started + timedelta(minutes=20),
        ams_mapping=[0],
    )
    await db_session.commit()
    await db_session.refresh(bucket)

    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "failed"
    assert events[0].grams == 200
    assert events[0].kind != LIVE_USAGE_KIND
    assert bucket.on_hand_grams == 9800


@pytest.mark.asyncio
async def test_cancelled_and_aborted_scale_by_progress(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    started = datetime(2026, 8, 20, 20, 0, 0, tzinfo=timezone.utc)
    slots = [{"slot_id": 1, "used_g": 400, "type": "PLA", "color": "#FFFFFF"}]

    cancelled = await record_print_usage(
        db_session,
        slots=slots,
        status="cancelled",
        progress=25,
        archive_id=30,
        printer_id=printer.id,
        print_name="Cancelled",
        started_at=started,
        occurred_at=started,
        ams_mapping=[0],
    )
    aborted = await record_print_usage(
        db_session,
        slots=slots,
        status="aborted",
        progress=50,
        archive_id=31,
        printer_id=printer.id,
        print_name="Aborted",
        started_at=started + timedelta(hours=1),
        occurred_at=started + timedelta(hours=1),
        ams_mapping=[0],
    )
    await db_session.commit()
    await db_session.refresh(bucket)

    assert cancelled[0].kind == "cancelled"
    assert cancelled[0].grams == 100
    assert aborted[0].kind == "aborted"
    assert aborted[0].grams == 200
    assert bucket.on_hand_grams == 9700


@pytest.mark.asyncio
async def test_reprint_mqtt_snow_mapping_uses_assigned_ams_slot(db_session, printer_factory):
    printer = await printer_factory()
    bucket = FilamentColorBucket(
        color_name="Jade White",
        material="PLA",
        color_hex="FFFFFF",
        on_hand_grams=10000,
        spool_weight_grams=1000,
        stock_initialized=True,
    )
    db_session.add(bucket)
    await db_session.flush()
    db_session.add(
        FilamentSlotAssignment(
            printer_id=printer.id,
            ams_id=1,
            tray_id=1,
            bucket_id=bucket.id,
        )
    )
    await db_session.commit()

    created = await record_print_usage(
        db_session,
        slots=[{"slot_id": 1, "used_g": 150, "type": "PLA", "color": "#FFFFFF"}],
        status="completed",
        progress=100,
        archive_id=None,
        printer_id=printer.id,
        print_name="studio-reprint",
        started_at=datetime(2026, 8, 20, 21, 0, 0, tzinfo=timezone.utc),
        mqtt_mapping=[257],
    )
    await db_session.commit()
    await db_session.refresh(bucket)
    assert len(created) == 1
    assert created[0].bucket_id == bucket.id
    assert bucket.on_hand_grams == 9850


@pytest.mark.asyncio
async def test_live_run_id_stays_stable_when_archive_appears(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    started = datetime(2026, 8, 20, 22, 0, 0, tzinfo=timezone.utc)
    run_id = tracking_run_id(
        archive_id=None,
        printer_id=printer.id,
        print_name="panel-reprint",
        started_at=started,
    )
    slots = [{"slot_id": 1, "used_g": 300, "type": "PLA", "color": "#FFFFFF"}]

    await record_print_usage(
        db_session,
        slots=slots,
        status="printing",
        progress=50,
        archive_id=None,
        printer_id=printer.id,
        print_name="panel-reprint",
        started_at=started,
        occurred_at=started,
        tray_now=0,
        run_id=run_id,
    )
    created = await record_print_usage(
        db_session,
        slots=slots,
        status="completed",
        progress=100,
        archive_id=88,
        printer_id=printer.id,
        print_name="panel-reprint",
        started_at=started,
        occurred_at=started + timedelta(minutes=40),
        tray_now=0,
        run_id=run_id,
    )
    await db_session.commit()
    await db_session.refresh(bucket)

    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "completed"
    assert events[0].grams == 300
    assert events[0].archive_id == 88
    assert events[0].source_key == created[0].source_key
    assert bucket.on_hand_grams == 9700


@pytest.mark.asyncio
async def test_usage_result_fallback_does_not_rescale(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    slots, mapping = tracking_slots_from_usage_results(
        [{"weight_used": 80.0, "slot_id": None, "ams_id": 0, "tray_id": 0, "material": "PLA"}]
    )
    created = await record_print_usage(
        db_session,
        slots=slots,
        status="failed",
        progress=100,
        archive_id=None,
        printer_id=printer.id,
        print_name="no-3mf-reprint",
        ams_mapping=mapping,
    )
    await db_session.commit()
    await db_session.refresh(bucket)
    assert created[0].kind == "failed"
    assert created[0].grams == 80
    assert bucket.on_hand_grams == 9920


def test_single_tray_mapping_pads_to_used_slot_id():
    slots = [{"slot_id": 2, "used_g": 120, "type": "PLA"}]
    assert align_mapping_to_used_slots([5], slots) == [-1, 5]
    assert mapping_tray_id(2, [5]) is None
    assert mapping_tray_id(2, align_mapping_to_used_slots([5], slots)) == 5
    assert align_mapping_to_used_slots(
        [0], [{"slot_id": 1, "used_g": 10}, {"slot_id": 2, "used_g": 10}]
    ) == [0]


def test_remain_delta_helpers_ignore_refills():
    raw = {
        "ams": {"ams": [{"id": 0, "tray": [{"id": 0, "remain": 80, "tray_type": "PLA", "tray_color": "FFFFFF"}]}]},
        "vt_tray": {"id": 254, "remain": 40, "tray_type": "PETG"},
    }
    trays = parse_mqtt_tray_remain(raw)
    assert trays[(0, 0)][0] == 80
    assert trays[(255, 0)][0] == 40
    assert remain_delta_grams(80, 50, 1000) == 300
    assert remain_delta_grams(50, 80, 1000) == 0
    slots, mapping = slots_from_remain_deltas({(0, 0): 80}, {(0, 0): 1000}, {(0, 0): 50})
    assert slots[0]["used_g"] == 300
    assert mapping == [0]
    ignored, empty = slots_from_remain_deltas(
        {(0, 0): 80, (0, 1): 80},
        {(0, 0): 1000, (0, 1): 1000},
        {(0, 0): 50, (0, 1): 20},
        observed_trays={0},
    )
    assert empty == [0]
    assert ignored[0]["used_g"] == 300
    none, none_map = slots_from_remain_deltas(
        {(0, 0): 80},
        {(0, 0): 1000},
        {(0, 0): 50},
        observed_trays=set(),
    )
    assert none == []
    assert none_map is None


def test_observed_print_trays_from_mapping_and_tray_now():
    assert observed_print_trays(tray_now=0) == {0}
    assert observed_print_trays(mqtt_mapping=[0, 1], tray_now=0) == {0, 1}
    assert observed_print_trays(mqtt_mapping=[65535], tray_now=None) == set()
    assert observed_print_trays(mqtt_mapping=[1], tray_now=0, previously_seen={3}) == {0, 1, 3}


def test_same_live_job_keeps_identity_when_archive_appears():
    from datetime import datetime, timezone

    from backend.app.services.filament_tracking import LiveTrackingRun

    started = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc)
    live = LiveTrackingRun(
        run_id="p1-job-20260820120000",
        printer_id=1,
        archive_id=None,
        print_name="panel-reprint",
        started_at=started,
        slots=[{"slot_id": 1, "used_g": 200}],
        ams_mapping=[0],
    )
    assert same_live_tracking_job(live, archive_id=88, print_name="panel-reprint")
    assert same_live_tracking_job(live, archive_id=None, print_name="cache/panel-reprint.gcode.3mf")
    assert same_live_tracking_job(live, archive_id=None, print_name="PANEL-REPRINT.3MF")
    assert not same_live_tracking_job(live, archive_id=None, print_name="panel-reprint-v2")
    live.archive_id = 88
    assert not same_live_tracking_job(live, archive_id=99, print_name="other")
    live.settled = True
    assert not same_live_tracking_job(live, archive_id=88, print_name="panel-reprint")


def test_same_live_job_matches_cache_gcode_path_to_bare_stem():
    from datetime import datetime, timezone

    from backend.app.services.filament_tracking import LiveTrackingRun

    started = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc)
    live = LiveTrackingRun(
        run_id="p1-foo-20260820120000",
        printer_id=1,
        archive_id=None,
        print_name="cache/foo.gcode.3mf",
        started_at=started,
        slots=[{"slot_id": 1, "used_g": 200}],
        ams_mapping=[0],
    )
    assert same_live_tracking_job(live, archive_id=None, print_name="foo")
    assert same_live_tracking_job(live, archive_id=None, print_name="foo.3mf")
    assert not same_live_tracking_job(live, archive_id=None, print_name="foo_v2")


def test_should_skip_live_upsert_matches_exact_stems_not_substrings():
    from backend.app.services.filament_tracking import _settled_jobs, should_skip_live_upsert

    printer_id = 99001
    try:
        _settled_jobs[printer_id] = (None, "cache/foo.gcode.3mf", "run-1")
        assert should_skip_live_upsert(printer_id, archive_id=None, print_name="foo")
        assert should_skip_live_upsert(printer_id, archive_id=None, print_name="foo.3mf")
        _settled_jobs[printer_id] = (None, "panel-reprint", "run-1")
        assert should_skip_live_upsert(
            printer_id, archive_id=None, print_name="cache/panel-reprint.gcode.3mf"
        )
        assert not should_skip_live_upsert(printer_id, archive_id=None, print_name="panel-reprint-v2")
        _settled_jobs[printer_id] = (3, "/data/Metadata/plate_1.gcode", "run-1")
        assert not should_skip_live_upsert(
            printer_id, archive_id=None, print_name="BOT-x2-1.8.2-X1C"
        )
    finally:
        _settled_jobs.pop(printer_id, None)


@pytest.mark.asyncio
async def test_live_progress_regression_does_not_credit_stock(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    started = datetime(2026, 8, 20, 23, 0, 0, tzinfo=timezone.utc)
    slots = [{"slot_id": 1, "used_g": 500, "type": "PLA", "color": "#FFFFFF"}]
    kwargs = {
        "slots": slots,
        "archive_id": 40,
        "printer_id": printer.id,
        "print_name": "Regress",
        "started_at": started,
        "occurred_at": started,
        "ams_mapping": [0],
    }
    await record_print_usage(db_session, status="printing", progress=80, **kwargs)
    await db_session.commit()
    await db_session.refresh(bucket)
    assert bucket.on_hand_grams == 9600

    await record_print_usage(db_session, status="printing", progress=50, **kwargs)
    await db_session.commit()
    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == 400
    assert bucket.on_hand_grams == 9600


@pytest.mark.asyncio
async def test_live_upsert_does_not_overwrite_settled_row(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    started = datetime(2026, 8, 21, 1, 0, 0, tzinfo=timezone.utc)
    slots = [{"slot_id": 1, "used_g": 500, "type": "PLA", "color": "#FFFFFF"}]
    kwargs = {
        "slots": slots,
        "archive_id": 41,
        "printer_id": printer.id,
        "print_name": "Settled",
        "started_at": started,
        "occurred_at": started,
        "ams_mapping": [0],
    }
    await record_print_usage(db_session, status="completed", progress=100, **kwargs)
    await db_session.commit()
    await record_print_usage(db_session, status="printing", progress=90, **kwargs)
    await db_session.commit()
    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "completed"
    assert events[0].grams == 500
    assert bucket.on_hand_grams == 9500


@pytest.mark.asyncio
async def test_single_tray_maps_to_3mf_slot_two(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    created = await record_print_usage(
        db_session,
        slots=[{"slot_id": 2, "used_g": 150, "type": "PLA", "color": "#FFFFFF"}],
        status="completed",
        progress=100,
        archive_id=42,
        printer_id=printer.id,
        print_name="slot-two",
        tray_now=0,
    )
    await db_session.commit()
    await db_session.refresh(bucket)
    assert len(created) == 1
    assert created[0].grams == 150
    assert bucket.on_hand_grams == 9850


@pytest.mark.asyncio
async def test_printer_tracking_lock_serializes_same_printer():
    import asyncio

    order: list[str] = []

    async def hold(label: str):
        async with printer_tracking_lock(7):
            order.append(f"start-{label}")
            await asyncio.sleep(0.02)
            order.append(f"end-{label}")

    await asyncio.gather(hold("a"), hold("b"))
    assert order in (["start-a", "end-a", "start-b", "end-b"], ["start-b", "end-b", "start-a", "end-a"])


def test_live_usage_window_is_exact_when_run_started_within_the_hour():
    now = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
    started = now - timedelta(minutes=30)
    grams_per_hour, last_hour, elapsed = live_usage_window(50, started, now)
    assert elapsed == 1800
    assert last_hour == 50
    assert grams_per_hour == 100


def test_live_usage_window_uses_live_rate_for_runs_older_than_an_hour():
    now = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
    started = now - timedelta(hours=2)
    grams_per_hour, last_hour, elapsed = live_usage_window(200, started, now)
    assert elapsed == 7200
    assert grams_per_hour == 100
    assert last_hour == 100


def test_live_usage_window_catch_up_50g_in_20s_does_not_explode():
    now = datetime(2026, 8, 20, 18, 0, 20, tzinfo=timezone.utc)
    first_write = now - timedelta(seconds=20)
    grams_per_hour, last_hour, elapsed = live_usage_window(50, first_write, now)
    assert elapsed == 20
    assert last_hour == 50
    assert grams_per_hour == 0
    assert grams_per_hour < 200


def test_live_usage_window_30_min_print_52g_is_about_100_gph():
    now = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
    started = now - timedelta(minutes=30)
    grams_per_hour, last_hour, elapsed = live_usage_window(52, started, now)
    assert elapsed == 1800
    assert last_hour == 52
    assert grams_per_hour == 104


def test_infer_elapsed_from_remaining_at_39_percent():
    elapsed = infer_elapsed_seconds(progress=39, remaining_seconds=47 * 60)
    assert elapsed == pytest.approx(47 * 60 * 0.39 / 0.61, rel=0.001)


def test_resolve_print_started_at_prefers_archive_over_first_write():
    now = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
    first_write = now - timedelta(seconds=20)
    archive_start = now - timedelta(minutes=30)
    started = resolve_print_started_at(
        now=now,
        occurred_at=first_write,
        archive_started_at=archive_start,
    )
    assert started == archive_start


def test_resolve_print_started_at_uses_remaining_when_clock_is_latch():
    now = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
    latch = now - timedelta(seconds=30)
    started = resolve_print_started_at(
        now=now,
        occurred_at=latch,
        archive_started_at=latch,
        progress=39,
        remaining_seconds=47 * 60,
    )
    expected = now - timedelta(seconds=47 * 60 * 0.39 / 0.61)
    assert abs((started - expected).total_seconds()) < 2


def test_compute_live_usage_rate_catch_up_does_not_yield_kg_per_hour():
    now = datetime(2026, 8, 20, 18, 0, 20, tzinfo=timezone.utc)
    sample = LiveUsageSample(
        bucket_id=1,
        color_name="EasyRock White",
        material="PLA",
        brand="EasyRock",
        subtype=None,
        extra_colors=None,
        effect_type=None,
        color_hex="FFFFFF",
        grams=50,
        occurred_at=now - timedelta(seconds=20),
        printer_id=11,
    )
    rate = compute_live_usage_rate([sample], as_of=now)
    assert rate.grams_last_hour == 50
    assert rate.grams_so_far == 50
    assert rate.grams_per_hour == 0
    assert rate.warming_up is True
    assert rate.grams_per_hour < 200


def test_compute_live_usage_rate_uses_print_start_not_first_write():
    now = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
    sample = LiveUsageSample(
        bucket_id=1,
        color_name="EasyRock White",
        material="PLA",
        brand="EasyRock",
        subtype=None,
        extra_colors=None,
        effect_type=None,
        color_hex="FFFFFF",
        grams=52,
        occurred_at=now - timedelta(seconds=20),
        printer_id=11,
        started_at=now - timedelta(minutes=30),
    )
    rate = compute_live_usage_rate([sample], as_of=now)
    assert rate.warming_up is False
    assert rate.grams_last_hour == 52
    assert rate.grams_per_hour == 104


def test_compute_live_usage_rate_does_not_stack_duplicate_printer_rows():
    now = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
    started = now - timedelta(minutes=30)
    rows = [
        LiveUsageSample(
            bucket_id=1,
            color_name="EasyRock White",
            material="PLA",
            brand="EasyRock",
            subtype=None,
            extra_colors=None,
            effect_type=None,
            color_hex="FFFFFF",
            grams=56.9,
            occurred_at=now - timedelta(seconds=20),
            printer_id=1,
            started_at=started,
        ),
        LiveUsageSample(
            bucket_id=1,
            color_name="EasyRock White",
            material="PLA",
            brand="EasyRock",
            subtype=None,
            extra_colors=None,
            effect_type=None,
            color_hex="FFFFFF",
            grams=56.9,
            occurred_at=now - timedelta(seconds=5),
            printer_id=1,
            started_at=started,
        ),
    ]
    rate = compute_live_usage_rate(rows, as_of=now)
    assert rate.active_jobs == 1
    assert rate.grams_so_far == 56.9
    assert rate.grams_last_hour == 56.9
    assert rate.grams_per_hour == 113.8


def test_compute_live_usage_rate_sums_named_products_not_hex_buckets():
    now = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
    easyrock = LiveUsageSample(
        bucket_id=1,
        color_name="EasyRock White",
        material="PLA",
        brand="EasyRock",
        subtype=None,
        extra_colors=None,
        effect_type=None,
        color_hex="FFFFFF",
        grams=40,
        occurred_at=now - timedelta(minutes=20),
        printer_id=11,
    )
    jade = LiveUsageSample(
        bucket_id=2,
        color_name="Jade White",
        material="PLA",
        brand="Bambu Lab",
        subtype=None,
        extra_colors=None,
        effect_type=None,
        color_hex="FFFFFF",
        grams=80,
        occurred_at=now - timedelta(minutes=40),
        printer_id=12,
    )
    rate = compute_live_usage_rate([easyrock, jade], as_of=now)
    assert rate.active_jobs == 2
    assert rate.grams_last_hour == 120
    assert rate.grams_per_hour == 240
    assert [p.color_name for p in rate.products] == ["EasyRock White", "Jade White"]
    assert rate.products[0].grams_per_hour == 120
    assert rate.products[1].grams_per_hour == 120


def test_compute_live_usage_rate_adds_same_product_across_printers():
    now = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
    samples = [
        LiveUsageSample(
            bucket_id=1,
            color_name="EasyRock White",
            material="PLA",
            brand="EasyRock",
            subtype=None,
            extra_colors=None,
            effect_type=None,
            color_hex="FFFFFF",
            grams=30,
            occurred_at=now - timedelta(minutes=30),
            printer_id=1,
        ),
        LiveUsageSample(
            bucket_id=1,
            color_name="EasyRock White",
            material="PLA",
            brand="EasyRock",
            subtype=None,
            extra_colors=None,
            effect_type=None,
            color_hex="FFFFFF",
            grams=30,
            occurred_at=now - timedelta(minutes=30),
            printer_id=2,
        ),
    ]
    rate = compute_live_usage_rate(samples, as_of=now)
    assert rate.active_jobs == 2
    assert len(rate.products) == 1
    assert rate.products[0].grams_so_far == 60
    assert rate.products[0].grams_per_hour == 120
    assert rate.grams_per_hour == 120


@pytest.mark.asyncio
async def test_load_live_usage_rate_uses_live_upserts_not_settled(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    started = datetime(2026, 8, 20, 17, 30, 0, tzinfo=timezone.utc)
    now = started + timedelta(minutes=30)
    slots = [{"slot_id": 1, "used_g": 200, "type": "PLA", "color": "#FFFFFF"}]
    await record_print_usage(
        db_session,
        slots=slots,
        status="printing",
        progress=50,
        archive_id=88,
        printer_id=printer.id,
        print_name="LiveRate",
        started_at=started,
        occurred_at=started,
        ams_mapping=[0],
    )
    await db_session.commit()

    rate = await load_live_usage_rate(db_session, as_of=now)
    assert rate.active_jobs == 1
    assert rate.grams_so_far == 100
    assert rate.grams_last_hour == 100
    assert rate.grams_per_hour == 200
    assert rate.products[0].color_name == "EasyRock White"

    await record_print_usage(
        db_session,
        slots=slots,
        status="completed",
        progress=100,
        archive_id=88,
        printer_id=printer.id,
        print_name="LiveRate",
        started_at=started,
        occurred_at=now,
        ams_mapping=[0],
    )
    await db_session.commit()
    settled = await load_live_usage_rate(db_session, as_of=now)
    assert settled.active_jobs == 0
    assert settled.grams_per_hour == 0
    assert settled.products == []


@pytest.mark.asyncio
async def test_load_live_usage_rate_uses_archive_start_not_first_write(db_session, printer_factory):
    from backend.app.models.archive import PrintArchive

    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    started = datetime(2026, 8, 20, 17, 30, 0, tzinfo=timezone.utc)
    now = started + timedelta(minutes=30)
    latch = now - timedelta(seconds=20)
    archive = PrintArchive(
        printer_id=printer.id,
        filename="trump.3mf",
        print_name="Trump",
        file_path="/tmp/trump.3mf",
        file_size=1,
        status="printing",
        started_at=started,
    )
    db_session.add(archive)
    await db_session.flush()
    db_session.add(
        FilamentColorUsage(
            bucket_id=bucket.id,
            grams=52,
            occurred_at=latch,
            kind=LIVE_USAGE_KIND,
            progress=39,
            archive_id=archive.id,
            printer_id=printer.id,
            print_name="Trump",
            source_key="test:trump-catchup",
        )
    )
    await db_session.commit()

    rate = await load_live_usage_rate(db_session, as_of=now)
    assert rate.active_jobs == 1
    assert rate.grams_so_far == 52
    assert rate.grams_last_hour == 52
    assert rate.warming_up is False
    assert rate.grams_per_hour == 104
    assert rate.grams_per_hour < 200


@pytest.mark.asyncio
async def test_mixed_assigned_and_unassigned_slots_skip_unassigned(db_session, printer_factory):
    printer = await printer_factory()
    easyrock = FilamentColorBucket(
        color_name="EasyRock White",
        material="PLA",
        color_hex="FFFFFF",
        on_hand_grams=10000,
        spool_weight_grams=1000,
        stock_initialized=True,
    )
    db_session.add(easyrock)
    await db_session.flush()
    db_session.add(
        FilamentSlotAssignment(printer_id=printer.id, ams_id=0, tray_id=0, bucket_id=easyrock.id)
    )
    await db_session.commit()

    created = await record_print_usage(
        db_session,
        slots=[
            {"slot_id": 1, "used_g": 300, "type": "PLA", "color": "#FFFFFF"},
            {"slot_id": 2, "used_g": 200, "type": "PLA", "color": "#FFFFFF"},
        ],
        status="completed",
        progress=100,
        archive_id=50,
        printer_id=printer.id,
        print_name="MixedSlots",
        ams_mapping=[0, 1],
    )
    await db_session.commit()
    await db_session.refresh(easyrock)

    assert len(created) == 1
    assert created[0].bucket_id == easyrock.id
    assert created[0].grams == 300
    assert easyrock.on_hand_grams == 9700
    buckets = (await db_session.execute(select(FilamentColorBucket))).scalars().all()
    assert [b.color_name for b in buckets] == ["EasyRock White"]


@pytest.mark.asyncio
async def test_two_same_hex_named_products_both_deduct(db_session, printer_factory):
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
    db_session.add_all(
        [
            FilamentSlotAssignment(printer_id=printer.id, ams_id=0, tray_id=0, bucket_id=easyrock.id),
            FilamentSlotAssignment(printer_id=printer.id, ams_id=0, tray_id=1, bucket_id=jade.id),
        ]
    )
    await db_session.commit()

    created = await record_print_usage(
        db_session,
        slots=[
            {"slot_id": 1, "used_g": 400, "type": "PLA", "color": "#FFFFFF"},
            {"slot_id": 2, "used_g": 250, "type": "PLA", "color": "#FFFFFF"},
        ],
        status="completed",
        progress=100,
        archive_id=51,
        printer_id=printer.id,
        print_name="TwoWhites",
        ams_mapping=[0, 1],
    )
    await db_session.commit()
    await db_session.refresh(easyrock)
    await db_session.refresh(jade)

    assert {row.bucket_id for row in created} == {easyrock.id, jade.id}
    assert {row.grams for row in created} == {400, 250}
    assert easyrock.on_hand_grams == 9600
    assert jade.on_hand_grams == 7750


@pytest.mark.asyncio
async def test_length_one_mapping_does_not_drain_every_used_slot(db_session, printer_factory):
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
    db_session.add_all(
        [
            FilamentSlotAssignment(printer_id=printer.id, ams_id=0, tray_id=0, bucket_id=easyrock.id),
            FilamentSlotAssignment(printer_id=printer.id, ams_id=0, tray_id=1, bucket_id=jade.id),
        ]
    )
    await db_session.commit()

    created = await record_print_usage(
        db_session,
        slots=[
            {"slot_id": 1, "used_g": 200, "type": "PLA", "color": "#FFFFFF"},
            {"slot_id": 2, "used_g": 200, "type": "PLA", "color": "#FFFFFF"},
        ],
        status="completed",
        progress=100,
        archive_id=52,
        printer_id=printer.id,
        print_name="AmbiguousMap",
        ams_mapping=[0],
    )
    await db_session.commit()
    await db_session.refresh(easyrock)
    await db_session.refresh(jade)

    assert len(created) == 1
    assert created[0].bucket_id == easyrock.id
    assert created[0].grams == 200
    assert easyrock.on_hand_grams == 9800
    assert jade.on_hand_grams == 8000


@pytest.mark.asyncio
async def test_remain_delta_rows_keep_their_own_tray_ids(db_session, printer_factory):
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
    db_session.add_all(
        [
            FilamentSlotAssignment(printer_id=printer.id, ams_id=0, tray_id=0, bucket_id=easyrock.id),
            FilamentSlotAssignment(printer_id=printer.id, ams_id=0, tray_id=1, bucket_id=jade.id),
        ]
    )
    await db_session.commit()

    slots, mapping = slots_from_remain_deltas(
        {(0, 0): 80, (0, 1): 80},
        {(0, 0): 1000, (0, 1): 1000},
        {(0, 0): 50, (0, 1): 20},
    )
    assert mapping == [0, 1]
    created = await record_print_usage(
        db_session,
        slots=slots,
        status="completed",
        progress=100,
        archive_id=None,
        printer_id=printer.id,
        print_name="RemainTwo",
        ams_mapping=mapping,
        tray_now=0,
    )
    await db_session.commit()
    await db_session.refresh(easyrock)
    await db_session.refresh(jade)
    by_id = {row.bucket_id: row.grams for row in created}
    assert by_id[easyrock.id] == 300
    assert by_id[jade.id] == 600
    assert easyrock.on_hand_grams == 9700
    assert jade.on_hand_grams == 7400


@pytest.mark.asyncio
async def test_zero_progress_settle_closes_live_printing_rows(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    started = datetime(2026, 8, 20, 16, 0, 0, tzinfo=timezone.utc)
    slots = [{"slot_id": 1, "used_g": 500, "type": "PLA", "color": "#FFFFFF"}]
    kwargs = {
        "slots": slots,
        "archive_id": 60,
        "printer_id": printer.id,
        "print_name": "ZeroSettle",
        "started_at": started,
        "occurred_at": started,
        "ams_mapping": [0],
    }
    await record_print_usage(db_session, status="printing", progress=50, **kwargs)
    await db_session.commit()
    live = await load_live_usage_rate(db_session, as_of=started + timedelta(minutes=10))
    assert live.active_jobs == 1

    await record_print_usage(db_session, status="failed", progress=0, **kwargs)
    await db_session.commit()
    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "failed"
    assert events[0].grams == 0
    assert bucket.on_hand_grams == 10000
    settled = await load_live_usage_rate(db_session, as_of=started + timedelta(minutes=10))
    assert settled.active_jobs == 0
    assert settled.products == []


async def _write_3mf(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"3mf")
    return path


@pytest.mark.asyncio
async def test_find_exact_named_3mf_uses_library_not_similar_name(db_session, tmp_path):
    from backend.app.models.library import LibraryFile

    exact = await _write_3mf(tmp_path / "panel-reprint.3mf")
    similar = await _write_3mf(tmp_path / "panel-reprint-v2.3mf")
    db_session.add_all(
        [
            LibraryFile(filename="panel-reprint.3mf", file_path=str(exact), file_type="3mf", file_size=3),
            LibraryFile(filename="panel-reprint-v2.3mf", file_path=str(similar), file_type="3mf", file_size=3),
        ]
    )
    await db_session.commit()

    found = await find_exact_named_3mf(
        db_session,
        names=["cache/panel-reprint.gcode.3mf"],
        base_dir=tmp_path,
    )
    assert found == exact

    v2 = await find_exact_named_3mf(
        db_session,
        names=["panel-reprint-v2"],
        base_dir=tmp_path,
    )
    assert v2 == similar

    missing = await find_exact_named_3mf(
        db_session,
        names=["unknown-sd-job.gcode"],
        base_dir=tmp_path,
    )
    assert missing is None


@pytest.mark.asyncio
async def test_find_exact_named_3mf_prefers_library_then_recent_archive(db_session, printer_factory, tmp_path):
    from backend.app.models.archive import PrintArchive
    from backend.app.models.library import LibraryFile

    printer = await printer_factory()
    library_path = await _write_3mf(tmp_path / "library" / "panel-reprint.3mf")
    archive_path = await _write_3mf(tmp_path / "archives" / "panel-reprint.3mf")
    older = datetime(2026, 1, 1, tzinfo=timezone.utc)
    newer = datetime(2026, 8, 1, tzinfo=timezone.utc)
    db_session.add(
        LibraryFile(
            filename="panel-reprint.3mf",
            file_path=str(library_path),
            file_type="3mf",
            file_size=3,
            created_at=older,
        )
    )
    db_session.add(
        PrintArchive(
            printer_id=printer.id,
            filename="panel-reprint.3mf",
            print_name="panel-reprint",
            file_path=str(archive_path),
            file_size=3,
            status="completed",
            created_at=newer,
        )
    )
    await db_session.commit()

    found = await find_exact_named_3mf(
        db_session,
        names=["panel-reprint.3mf"],
        base_dir=tmp_path,
        printer_id=printer.id,
    )
    assert found == library_path

    lib = (await db_session.execute(select(LibraryFile))).scalar_one()
    lib.deleted_at = newer
    await db_session.commit()

    found_archive = await find_exact_named_3mf(
        db_session,
        names=["panel-reprint"],
        base_dir=tmp_path,
        printer_id=printer.id,
    )
    assert found_archive == archive_path


def _write_slice_3mf(path, xml: str):
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Metadata/slice_info.config", xml)
    path.write_bytes(buf.getvalue())
    return path


def test_slots_from_3mf_file_refuses_whole_file_when_plate_unknown(tmp_path):
    xml = """<?xml version="1.0" encoding="UTF-8"?>
    <config>
        <plate>
            <metadata key="index" value="1"/>
            <filament id="1" used_g="132.85" type="PLA" color="#FFFFFF"/>
        </plate>
        <plate>
            <metadata key="index" value="2"/>
            <filament id="1" used_g="132.85" type="PLA" color="#FFFFFF"/>
        </plate>
        <plate>
            <metadata key="index" value="3"/>
            <filament id="1" used_g="132.85" type="PLA" color="#FFFFFF"/>
        </plate>
        <plate>
            <metadata key="index" value="4"/>
            <filament id="1" used_g="132.85" type="PLA" color="#FFFFFF"/>
        </plate>
    </config>
    """
    path = _write_slice_3mf(tmp_path / "multi.3mf", xml)
    assert slots_from_3mf_file(path, plate_id=None) == []
    plate = slots_from_3mf_file(path, plate_id=1)
    assert len(plate) == 1
    assert plate[0]["used_g"] == pytest.approx(132.85)


@pytest.mark.asyncio
async def test_multi_plate_live_45_percent_does_not_charge_whole_file(db_session, printer_factory, tmp_path):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    slots = slots_from_3mf_file(
        _write_slice_3mf(
            tmp_path / "bot.3mf",
            """<?xml version="1.0" encoding="UTF-8"?>
            <config>
                <plate>
                    <metadata key="index" value="1"/>
                    <filament id="1" used_g="132.85" type="PLA" color="#FFFFFF"/>
                </plate>
                <plate>
                    <metadata key="index" value="2"/>
                    <filament id="1" used_g="400" type="PLA" color="#FFFFFF"/>
                </plate>
                <plate>
                    <metadata key="index" value="3"/>
                    <filament id="1" used_g="400" type="PLA" color="#FFFFFF"/>
                </plate>
                <plate>
                    <metadata key="index" value="4"/>
                    <filament id="1" used_g="400" type="PLA" color="#FFFFFF"/>
                </plate>
            </config>
            """,
        ),
        plate_id=1,
    )
    created = await record_print_usage(
        db_session,
        slots=slots,
        status="printing",
        progress=45,
        archive_id=None,
        printer_id=printer.id,
        print_name="BOT-x2-1.8.2-X1C",
        ams_mapping=[0],
    )
    await db_session.commit()
    assert len(created) == 1
    assert created[0].grams == pytest.approx(59.8, abs=0.2)
    assert created[0].grams < 132.85
    assert created[0].estimated is False


@pytest.mark.asyncio
async def test_collapse_duplicate_printing_rows_keeps_latest_grams(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    started = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
    db_session.add_all(
        [
            FilamentColorUsage(
                bucket_id=bucket.id,
                grams=56.9,
                kind=LIVE_USAGE_KIND,
                progress=43,
                printer_id=printer.id,
                print_name="BOT-x2-1.8.2-X1C",
                source_key="track:p1-BOT-x2-1.8.2-X1C-20260820193604:1:0:0",
                occurred_at=started,
                estimated=True,
            ),
            FilamentColorUsage(
                bucket_id=bucket.id,
                grams=59.8,
                kind=LIVE_USAGE_KIND,
                progress=45,
                printer_id=printer.id,
                print_name="BOT-x2-1.8.2-X1C",
                source_key="track:p1-BOT-x2-1.8.2-X1C-20260820194602:1:0:0",
                occurred_at=started,
                estimated=True,
            ),
        ]
    )
    bucket.on_hand_grams = 10000 - 56.9 - 59.8
    await db_session.commit()

    kept = await collapse_duplicate_live_usage(
        db_session, printer_id=printer.id, print_name="BOT-x2-1.8.2-X1C"
    )
    await db_session.commit()
    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(kept) == 1
    assert len(events) == 1
    assert events[0].grams == pytest.approx(59.8)
    assert bucket.on_hand_grams == pytest.approx(9940.2)

    live = await load_live_usage_rate(db_session, as_of=started + timedelta(minutes=30))
    assert live.grams_so_far == pytest.approx(59.8)


@pytest.mark.asyncio
async def test_unmapped_minus_one_does_not_dump_onto_ext(db_session, printer_factory):
    printer, bucket = await _white_on_slot0(db_session, printer_factory)
    db_session.add(
        FilamentSlotAssignment(printer_id=printer.id, ams_id=255, tray_id=0, bucket_id=bucket.id)
    )
    await db_session.commit()
    created = await record_print_usage(
        db_session,
        slots=[
            {"slot_id": 1, "used_g": 132.85, "type": "PLA"},
            {"slot_id": 2, "used_g": 400, "type": "PLA"},
        ],
        status="printing",
        progress=45,
        archive_id=None,
        printer_id=printer.id,
        print_name="BOT-x2-1.8.2-X1C",
        ams_mapping=[0, -1],
    )
    await db_session.commit()
    await db_session.refresh(bucket)
    assert len(created) == 1
    assert created[0].grams == pytest.approx(59.8, abs=0.2)
    assert bucket.on_hand_grams == pytest.approx(9940.2, abs=0.2)


def test_remain_has_coverage_requires_observed_tray_snapshot():
    start = {(0, 0): 80, (0, 1): 80}
    current = {(0, 0): 50, (0, 1): 20}
    assert remain_has_coverage(start, current, {0})
    assert not remain_has_coverage(start, current, set())
    assert not remain_has_coverage({}, current, {0})
    assert not remain_has_coverage(start, {}, {0})


def test_mqtt_skipped_object_ids_reads_s_obj():
    assert mqtt_skipped_object_ids({"s_obj": [1, 2]}) == [1, 2]
    assert mqtt_skipped_object_ids({"raw_data": {"s_obj": [9]}}, {"s_obj": [9]}) == [9]
    assert mqtt_skipped_object_ids({"remain": -1}) == []
    assert mqtt_skipped_object_ids(None, {}) == []
