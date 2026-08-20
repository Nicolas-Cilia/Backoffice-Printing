"""MQTT / main.py hooks for live named-product filament tracking."""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select

from backend.app.main import (
    _archive_name_matches,
    _normalized_print_name,
    _print_progress_value,
    _sync_filament_color_tracking,
    _tracking_slots_from_archive,
)
from backend.app.models.archive import PrintArchive
from backend.app.models.filament_tracking import FilamentColorBucket, FilamentColorUsage, FilamentSlotAssignment
from backend.app.models.library import LibraryFile
from backend.app.services.filament_tracking import (
    _live_runs,
    _printer_tracking_locks,
    _settle_in_progress,
    _settled_jobs,
    clear_live_run,
    get_live_run,
    untracked_live_runs,
)


@pytest.fixture(autouse=True)
def _clear_live_runs():
    _live_runs.clear()
    _settled_jobs.clear()
    _settle_in_progress.clear()
    _printer_tracking_locks.clear()
    yield
    _live_runs.clear()
    _settled_jobs.clear()
    _settle_in_progress.clear()
    _printer_tracking_locks.clear()


def test_print_progress_value_prefers_payload_then_last_progress():
    assert _print_progress_value({"progress": 10, "last_progress": 42}) == 10
    assert _print_progress_value({"last_progress": 42}) == 42
    assert _print_progress_value({}, 7) == 7
    assert _print_progress_value(None) is None
    assert _print_progress_value({"progress": 0, "last_progress": 42}) == 42


def test_first_print_job_name_skips_metadata_plate_gcode():
    from backend.app.main import _first_print_job_name

    assert _first_print_job_name("/data/Metadata/plate_1.gcode", "BOT-x2-1.8.2-X1C") == "BOT-x2-1.8.2-X1C"
    assert _first_print_job_name("BOT-x2-1.8.2-X1C", "/data/Metadata/plate_1.gcode") == "BOT-x2-1.8.2-X1C"


def test_tracking_slots_from_archive_split_estimate_without_3mf():
    archive = SimpleNamespace(
        file_path=None,
        filament_used_grams=200,
        filament_type="PLA",
        filament_color="#FFFFFF",
        plate_id=None,
    )
    slots = _tracking_slots_from_archive(archive)
    assert slots == [{"slot_id": 1, "type": "PLA", "color": "#FFFFFF", "used_g": 200.0}]


def test_tracking_slots_from_archive_does_not_even_split_multicolor():
    archive = SimpleNamespace(
        file_path=None,
        filament_used_grams=200,
        filament_type="PLA,PETG",
        filament_color="#FFFFFF,#000000",
        plate_id=None,
    )
    assert _tracking_slots_from_archive(archive) == []


def test_archive_name_matches_strips_gcode_suffixes():
    assert _normalized_print_name("cache/benchy.gcode.3mf") == "benchy"
    archive = SimpleNamespace(print_name="benchy", filename="benchy.gcode.3mf")
    assert _archive_name_matches(archive, "benchy.gcode")
    assert not _archive_name_matches(archive, "other-model")
    reprint = SimpleNamespace(print_name="panel-reprint", filename="panel-reprint.3mf")
    assert _archive_name_matches(reprint, "cache/panel-reprint.gcode.3mf")
    assert not _archive_name_matches(reprint, "panel-reprint-v2")


async def _assign_white(db_session, printer_factory):
    printer = await printer_factory()
    bucket = FilamentColorBucket(
        color_name="EasyRock White",
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
            ams_id=0,
            tray_id=0,
            bucket_id=bucket.id,
        )
    )
    await db_session.commit()
    return printer, bucket


def _archive(printer_id: int, grams: float = 500):
    return SimpleNamespace(
        id=44,
        file_path=None,
        filament_used_grams=grams,
        filament_type="PLA",
        filament_color="#FFFFFF",
        plate_id=None,
        print_name="panel-reprint",
        started_at=datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc),
        printer_id=printer_id,
        status="printing",
    )


@pytest.mark.asyncio
async def test_sync_live_then_complete_does_not_double_count(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id)
    client = MagicMock()
    client.state.raw_data = {"mapping": [0]}
    client.state.tray_now = 0
    client.state.progress = 50
    client.state.remaining_time = 0
    client._captured_ams_mapping = None

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=50,
            archive=archive,
            ams_mapping=None,
            db=db_session,
        )
        await db_session.refresh(bucket)
        assert bucket.on_hand_grams == 9750
        live = get_live_run(printer.id)
        assert live is not None
        assert live.started_at == archive.started_at

        client.state.progress = 100
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            archive=archive,
            ams_mapping=None,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "completed"
    assert events[0].grams == 500
    assert bucket.on_hand_grams == 9500
    assert _live_runs.get(printer.id) is None


@pytest.mark.asyncio
async def test_sync_reprint_without_send_mapping_uses_mqtt_state(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id, grams=200)
    client = MagicMock()
    client.state.raw_data = {"mapping": [0]}
    client.state.tray_now = 0
    client.state.progress = 100
    client._captured_ams_mapping = None

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            data={"last_progress": 100, "subtask_name": "panel-reprint"},
            archive=archive,
            ams_mapping=None,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == 200
    assert bucket.on_hand_grams == 9800


@pytest.mark.asyncio
async def test_sync_no_3mf_uses_usage_result_grams_unscaled(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id)
    archive.filament_used_grams = None
    client = MagicMock()
    client.state.raw_data = {}
    client.state.tray_now = 0
    client.state.progress = 40
    client._captured_ams_mapping = None

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="failed",
            progress=40,
            archive=archive,
            ams_mapping=None,
            settle=True,
            fallback_slots=[{"slot_id": 1, "used_g": 80.0, "type": "PLA", "color": "#FFFFFF"}],
            fallback_mapping=[0],
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "failed"
    assert events[0].grams == 80
    assert bucket.on_hand_grams == 9920
    clear_live_run(printer.id)


def _client(*, remain: int | None = None, progress: float = 50, mapping=None):
    client = MagicMock()
    raw = {"mapping": mapping if mapping is not None else [0]}
    if remain is not None:
        raw["ams"] = {"ams": [{"id": 0, "tray": [{"id": 0, "remain": remain, "tray_type": "PLA"}]}]}
    client.state.raw_data = raw
    client.state.tray_now = 0
    client.state.progress = progress
    client.state.remaining_time = 0
    client.state.skipped_objects = []
    client._captured_ams_mapping = None
    client._last_valid_progress = progress
    return client


@pytest.mark.asyncio
async def test_sync_live_without_archive_id_then_complete_reuses_keys(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    live_archive = _archive(printer.id)
    live_archive.id = None
    complete_archive = _archive(printer.id)
    complete_archive.id = 88
    client = _client(progress=50)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=50,
            archive=live_archive,
            archive_id=None,
            db=db_session,
        )
        live_events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
        assert len(live_events) == 1
        live_key = live_events[0].source_key
        assert live_key.startswith("track:p")

        client.state.progress = 100
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            archive=complete_archive,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].source_key == live_key
    assert events[0].kind == "completed"
    assert events[0].grams == 500
    assert events[0].archive_id == 88
    assert bucket.on_hand_grams == 9500
    assert _live_runs.get(printer.id) is None


@pytest.mark.asyncio
async def test_sync_live_cache_gcode_then_complete_stem_shares_source_key(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    live_archive = _archive(printer.id)
    live_archive.id = None
    live_archive.print_name = "foo"
    complete_archive = _archive(printer.id)
    complete_archive.id = 88
    complete_archive.print_name = "foo"
    client = _client(progress=50)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=50,
            archive=live_archive,
            archive_id=None,
            data={"gcode_file": "cache/foo.gcode.3mf"},
            db=db_session,
        )
        live_events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
        assert len(live_events) == 1
        live_key = live_events[0].source_key

        client.state.progress = 100
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            archive=complete_archive,
            data={"subtask_name": "foo"},
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].source_key == live_key
    assert events[0].kind == "completed"
    assert events[0].grams == 500
    assert bucket.on_hand_grams == 9500


@pytest.mark.asyncio
async def test_sync_similar_name_does_not_share_source_key(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    first = _archive(printer.id, grams=500)
    first.id = None
    first.print_name = "panel-reprint"
    second = _archive(printer.id, grams=200)
    second.id = None
    second.print_name = "panel-reprint-v2"
    client = _client(progress=50)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=50,
            archive=first,
            archive_id=None,
            data={"gcode_file": "cache/panel-reprint.gcode.3mf"},
            db=db_session,
        )
        first_key = (await db_session.execute(select(FilamentColorUsage))).scalars().one().source_key
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=50,
            archive=second,
            archive_id=None,
            data={"subtask_name": "panel-reprint-v2"},
            db=db_session,
        )

    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    keys = {event.source_key for event in events}
    assert len(events) == 2
    assert len(keys) == 2
    assert first_key in keys


@pytest.mark.asyncio
async def test_sync_does_not_reuse_stale_slots_on_new_run(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    first = _archive(printer.id, grams=500)
    first.id = 1
    second = _archive(printer.id, grams=100)
    second.id = 2
    second.print_name = "other-job"
    client = _client(progress=50)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=50, archive=first, db=db_session)
        await db_session.refresh(bucket)
        assert bucket.on_hand_grams == 9750
        await _sync_filament_color_tracking(printer.id, status="printing", progress=50, archive=second, db=db_session)

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 2
    assert bucket.on_hand_grams == 9700


@pytest.mark.asyncio
async def test_sync_progress_regression_does_not_credit_stock(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id)
    client = _client(progress=80)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=80, archive=archive, db=db_session)
        await db_session.refresh(bucket)
        assert bucket.on_hand_grams == 9600
        client.state.progress = 50
        await _sync_filament_color_tracking(printer.id, status="printing", progress=50, archive=archive, db=db_session)

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == 400
    assert bucket.on_hand_grams == 9600


@pytest.mark.asyncio
async def test_sync_live_after_settle_does_not_overwrite(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id)
    client = _client(progress=100)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id, status="completed", progress=100, archive=archive, settle=True, db=db_session
        )
        await _sync_filament_color_tracking(printer.id, status="printing", progress=90, archive=archive, db=db_session)

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "completed"
    assert events[0].grams == 500
    assert bucket.on_hand_grams == 9500
    assert _live_runs.get(printer.id) is None


@pytest.mark.asyncio
async def test_sync_settle_clears_live_run_even_without_events(db_session, printer_factory):
    from datetime import datetime, timezone

    from backend.app.services.filament_tracking import LiveTrackingRun, cache_live_run

    printer = await printer_factory()
    cache_live_run(
        LiveTrackingRun(
            run_id="p-stale",
            printer_id=printer.id,
            archive_id=None,
            print_name="gone",
            started_at=datetime(2026, 8, 20, tzinfo=timezone.utc),
            slots=[{"slot_id": 1, "used_g": 100}],
            ams_mapping=[0],
        )
    )
    client = _client(remain=None, mapping=None)
    client.state.raw_data = {}
    client.state.tray_now = None
    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="failed",
            progress=0,
            archive=None,
            settle=True,
            db=db_session,
        )
    assert _live_runs.get(printer.id) is None


@pytest.mark.asyncio
async def test_sync_failed_progress_zero_uses_last_valid(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id)
    client = _client(progress=40)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=40, archive=archive, db=db_session)
        await db_session.refresh(bucket)
        assert bucket.on_hand_grams == 9800
        client.state.progress = 0
        await _sync_filament_color_tracking(
            printer.id,
            status="failed",
            progress=0,
            data={"progress": 0, "last_progress": 40},
            archive=archive,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "failed"
    assert events[0].grams == 200
    assert bucket.on_hand_grams == 9800


@pytest.mark.asyncio
async def test_sync_no_3mf_uses_assigned_remain_snapshot(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id)
    archive.file_path = None
    archive.filament_used_grams = None
    client = _client(remain=80, progress=10)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=10, archive=archive, db=db_session)
        await db_session.refresh(bucket)
        assert bucket.on_hand_grams == 10000
        client.state.raw_data["ams"]["ams"][0]["tray"][0]["remain"] = 50
        await _sync_filament_color_tracking(printer.id, status="printing", progress=40, archive=archive, db=db_session)
        await db_session.refresh(bucket)
        assert bucket.on_hand_grams == 9700
        client.state.raw_data["ams"]["ams"][0]["tray"][0]["remain"] = 20
        await _sync_filament_color_tracking(
            printer.id, status="completed", progress=100, archive=archive, settle=True, db=db_session
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "completed"
    assert events[0].grams == 600
    assert bucket.on_hand_grams == 9400


@pytest.mark.asyncio
async def test_overlapping_live_syncs_are_serialized(db_session, printer_factory):
    import asyncio

    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id)
    client = _client(progress=50)
    entered = 0
    max_entered = 0
    original = None

    async def slow_record(*args, **kwargs):
        nonlocal entered, max_entered
        entered += 1
        max_entered = max(max_entered, entered)
        await asyncio.sleep(0.05)
        entered -= 1
        return await original(*args, **kwargs)

    from backend.app.services import filament_tracking as tracking

    original = tracking.record_print_usage
    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        with patch("backend.app.services.filament_tracking.record_print_usage", side_effect=slow_record):
            await asyncio.gather(
                _sync_filament_color_tracking(
                    printer.id, status="printing", progress=50, archive=archive, db=db_session
                ),
                _sync_filament_color_tracking(
                    printer.id, status="printing", progress=50, archive=archive, db=db_session
                ),
            )

    assert max_entered == 1
    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert bucket.on_hand_grams == 9750


async def _assign_two_whites(db_session, printer_factory):
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
    return printer, easyrock, jade


def _client_two_trays(*, remain0: int, remain1: int, progress: float = 50, tray_now: int = 0, mapping=None):
    client = MagicMock()
    client.state.raw_data = {
        "mapping": mapping if mapping is not None else [],
        "ams": {
            "ams": [
                {
                    "id": 0,
                    "tray": [
                        {"id": 0, "remain": remain0, "tray_type": "PLA"},
                        {"id": 1, "remain": remain1, "tray_type": "PLA"},
                    ],
                }
            ]
        },
    }
    client.state.tray_now = tray_now
    client.state.progress = progress
    client.state.remaining_time = 0
    client.state.skipped_objects = []
    client._captured_ams_mapping = None
    client._last_valid_progress = progress
    return client


@pytest.mark.asyncio
async def test_sync_cached_slots_resolve_mapping_on_later_settle(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id)
    client = _client(remain=None, mapping=None, progress=50)
    client.state.raw_data = {}
    client.state.tray_now = None

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=50, archive=archive, db=db_session)
        live_events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
        assert live_events == []
        assert _live_runs[printer.id].slots
        assert not _live_runs[printer.id].ams_mapping

        client.state.raw_data = {"mapping": [0]}
        client.state.tray_now = 0
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            archive=archive,
            ams_mapping=[0],
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "completed"
    assert events[0].grams == 500
    assert bucket.on_hand_grams == 9500


@pytest.mark.asyncio
async def test_sync_mixed_assigned_unassigned_slots(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id, grams=500)
    client = _client(progress=100, mapping=[0, 1])
    slots = [
        {"slot_id": 1, "type": "PLA", "color": "#FFFFFF", "used_g": 250},
        {"slot_id": 2, "type": "PLA", "color": "#FFFFFF", "used_g": 250},
    ]

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        with patch("backend.app.main._tracking_slots_from_archive", return_value=slots):
            await _sync_filament_color_tracking(
                printer.id,
                status="completed",
                progress=100,
                archive=archive,
                ams_mapping=[0, 1],
                settle=True,
                db=db_session,
            )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    buckets = (await db_session.execute(select(FilamentColorBucket))).scalars().all()
    assert len(events) == 1
    assert events[0].bucket_id == bucket.id
    assert events[0].grams == 250
    assert bucket.on_hand_grams == 9750
    assert [row.color_name for row in buckets] == ["EasyRock White"]


@pytest.mark.asyncio
async def test_sync_two_same_hex_products_both_deduct(db_session, printer_factory):
    printer, easyrock, jade = await _assign_two_whites(db_session, printer_factory)
    archive = _archive(printer.id, grams=650)
    client = _client(progress=100, mapping=[0, 1])
    slots = [
        {"slot_id": 1, "type": "PLA", "color": "#FFFFFF", "used_g": 325},
        {"slot_id": 2, "type": "PLA", "color": "#FFFFFF", "used_g": 325},
    ]

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        with patch("backend.app.main._tracking_slots_from_archive", return_value=slots):
            await _sync_filament_color_tracking(
                printer.id,
                status="completed",
                progress=100,
                archive=archive,
                ams_mapping=[0, 1],
                settle=True,
                db=db_session,
            )

    await db_session.refresh(easyrock)
    await db_session.refresh(jade)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    by_id = {row.bucket_id: row.grams for row in events}
    assert by_id[easyrock.id] == 325
    assert by_id[jade.id] == 325
    assert easyrock.on_hand_grams == 9675
    assert jade.on_hand_grams == 7675


@pytest.mark.asyncio
async def test_sync_cancelled_and_aborted_scale_by_last_progress(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id)
    client = _client(progress=40)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=40, archive=archive, db=db_session)
        client.state.progress = 0
        await _sync_filament_color_tracking(
            printer.id,
            status="cancelled",
            progress=0,
            data={"progress": 0, "last_progress": 40},
            archive=archive,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "cancelled"
    assert events[0].grams == 200
    assert bucket.on_hand_grams == 9800

    printer2, bucket2 = await _assign_white(db_session, printer_factory)
    archive2 = _archive(printer2.id)
    archive2.id = 77
    client2 = _client(progress=50)
    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client2
        manager.get_status.return_value = client2.state
        await _sync_filament_color_tracking(
            printer2.id, status="printing", progress=50, archive=archive2, db=db_session
        )
        await _sync_filament_color_tracking(
            printer2.id,
            status="aborted",
            progress=0,
            data={"progress": 0, "last_progress": 50},
            archive=archive2,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket2)
    aborted = (
        (await db_session.execute(select(FilamentColorUsage).where(FilamentColorUsage.printer_id == printer2.id)))
        .scalars()
        .all()
    )
    assert aborted[0].kind == "aborted"
    assert aborted[0].grams == 250
    assert bucket2.on_hand_grams == 9750


@pytest.mark.asyncio
async def test_sync_remain_deltas_do_not_collapse_onto_tray_now(db_session, printer_factory):
    printer, easyrock, jade = await _assign_two_whites(db_session, printer_factory)
    archive = _archive(printer.id)
    archive.file_path = None
    archive.filament_used_grams = None
    client = _client_two_trays(remain0=80, remain1=80, progress=10, tray_now=0, mapping=None)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=10, archive=archive, db=db_session)
        client.state.raw_data["ams"]["ams"][0]["tray"][0]["remain"] = 50
        client.state.raw_data["ams"]["ams"][0]["tray"][1]["remain"] = 20
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            archive=archive,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(easyrock)
    await db_session.refresh(jade)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    by_id = {row.bucket_id: row.grams for row in events}
    assert by_id[easyrock.id] == 300
    assert jade.id not in by_id
    assert easyrock.on_hand_grams == 9700
    assert jade.on_hand_grams == 8000


@pytest.mark.asyncio
async def test_sync_remain_mapping_deducts_observed_trays(db_session, printer_factory):
    printer, easyrock, jade = await _assign_two_whites(db_session, printer_factory)
    archive = _archive(printer.id)
    archive.file_path = None
    archive.filament_used_grams = None
    client = _client_two_trays(remain0=80, remain1=80, progress=10, tray_now=0, mapping=[0, 1])

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=10, archive=archive, db=db_session)
        client.state.raw_data["ams"]["ams"][0]["tray"][0]["remain"] = 50
        client.state.raw_data["ams"]["ams"][0]["tray"][1]["remain"] = 20
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            archive=archive,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(easyrock)
    await db_session.refresh(jade)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    by_id = {row.bucket_id: row.grams for row in events}
    assert by_id[easyrock.id] == 300
    assert by_id[jade.id] == 600
    assert easyrock.on_hand_grams == 9700
    assert jade.on_hand_grams == 7400


@pytest.mark.asyncio
async def test_sync_remain_accumulates_tray_now_history(db_session, printer_factory):
    printer, easyrock, jade = await _assign_two_whites(db_session, printer_factory)
    archive = _archive(printer.id)
    archive.file_path = None
    archive.filament_used_grams = None
    client = _client_two_trays(remain0=80, remain1=80, progress=10, tray_now=0, mapping=None)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=10, archive=archive, db=db_session)
        client.state.tray_now = 1
        client.state.raw_data["ams"]["ams"][0]["tray"][0]["remain"] = 50
        client.state.raw_data["ams"]["ams"][0]["tray"][1]["remain"] = 20
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            archive=archive,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(easyrock)
    await db_session.refresh(jade)
    by_id = {row.bucket_id: row.grams for row in (await db_session.execute(select(FilamentColorUsage))).scalars().all()}
    assert by_id[easyrock.id] == 300
    assert by_id[jade.id] == 600


@pytest.mark.asyncio
async def test_sync_ignores_mismatched_archive_for_sd_card_job(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id, grams=500)
    archive.print_name = "previous-bambuddy-send"
    archive.filename = "previous-bambuddy-send.3mf"
    archive.filament_used_grams = 500
    client = _client(remain=80, progress=10, mapping=None)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=10,
            data={"subtask_name": "sd-card-print", "filename": "sd-card-print.gcode"},
            archive=archive,
            db=db_session,
        )
        client.state.raw_data["ams"]["ams"][0]["tray"][0]["remain"] = 50
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            data={"subtask_name": "sd-card-print", "filename": "sd-card-print.gcode"},
            archive=archive,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == 300
    assert events[0].print_name in ("sd-card-print", "sd-card-print.gcode")
    assert bucket.on_hand_grams == 9700


@pytest.mark.asyncio
async def test_sync_remain_refill_does_not_credit_stock(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id)
    archive.file_path = None
    archive.filament_used_grams = None
    client = _client(remain=80, progress=10)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=10, archive=archive, db=db_session)
        client.state.raw_data["ams"]["ams"][0]["tray"][0]["remain"] = 50
        await _sync_filament_color_tracking(printer.id, status="printing", progress=40, archive=archive, db=db_session)
        await db_session.refresh(bucket)
        assert bucket.on_hand_grams == 9700
        client.state.raw_data["ams"]["ams"][0]["tray"][0]["remain"] = 90
        await _sync_filament_color_tracking(printer.id, status="printing", progress=50, archive=archive, db=db_session)

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert events[0].grams == 300
    assert bucket.on_hand_grams == 9700


@pytest.mark.asyncio
async def test_sync_start_keeps_run_id_when_file_change_refires(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    live_archive = _archive(printer.id)
    live_archive.id = None
    complete_archive = _archive(printer.id)
    complete_archive.id = 91
    client = _client(progress=50)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=50,
            archive=live_archive,
            archive_id=None,
            db=db_session,
        )
        live_key = (await db_session.execute(select(FilamentColorUsage))).scalars().one().source_key
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=60,
            archive=live_archive,
            data={"subtask_name": "panel-reprint"},
            start=True,
            db=db_session,
        )
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            archive=complete_archive,
            settle=True,
            db=db_session,
        )

    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].source_key == live_key
    assert events[0].kind == "completed"
    assert events[0].grams == 500


@pytest.mark.asyncio
async def test_sync_start_after_settle_does_not_skip_same_name_reprint(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    first = _archive(printer.id, grams=500)
    first.id = 1
    first.print_name = "panel-reprint"
    second = _archive(printer.id, grams=200)
    second.id = None
    second.print_name = "panel-reprint"
    client = _client(progress=100)

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id, status="completed", progress=100, archive=first, settle=True, db=db_session
        )
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=50,
            archive=second,
            start=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 2
    assert bucket.on_hand_grams == 9400
    assert _live_runs[printer.id].print_name == "panel-reprint"


@pytest.mark.asyncio
async def test_two_printer_live_syncs_do_not_cross_contaminate(db_session, printer_factory):
    import asyncio

    first, _bucket_a = await _assign_white(db_session, printer_factory)
    second, _bucket_b = await _assign_white(db_session, printer_factory)
    archive_a = _archive(first.id, grams=400)
    archive_a.id = 11
    archive_b = _archive(second.id, grams=200)
    archive_b.id = 22
    client_a = _client(progress=50)
    client_b = _client(progress=50)
    entered: set[int] = set()
    max_together = 0

    async def dummy_record(*args, **kwargs):
        nonlocal max_together
        pid = kwargs["printer_id"]
        entered.add(pid)
        max_together = max(max_together, len(entered))
        await asyncio.sleep(0.05)
        entered.discard(pid)
        return []

    def _client_for(printer_id):
        return client_a if printer_id == first.id else client_b

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.side_effect = _client_for
        manager.get_status.side_effect = lambda printer_id: _client_for(printer_id).state
        with patch("backend.app.services.filament_tracking.record_print_usage", side_effect=dummy_record):
            await asyncio.gather(
                _sync_filament_color_tracking(
                    first.id, status="printing", progress=50, archive=archive_a, db=db_session
                ),
                _sync_filament_color_tracking(
                    second.id, status="printing", progress=50, archive=archive_b, db=db_session
                ),
            )

    assert max_together == 2
    live_a = _live_runs[first.id]
    live_b = _live_runs[second.id]
    assert live_a.run_id != live_b.run_id
    assert live_a.printer_id == first.id
    assert live_b.printer_id == second.id


def _mqtt_reprint_names():
    return {
        "subtask_name": "panel-reprint",
        "gcode_file": "cache/panel-reprint.gcode.3mf",
        "filename": "panel-reprint.gcode.3mf",
    }


@pytest.mark.asyncio
async def test_sync_exact_library_3mf_is_gram_basis_for_reprint(db_session, printer_factory, tmp_path):
    printer, bucket = await _assign_white(db_session, printer_factory)
    threemf = tmp_path / "panel-reprint.3mf"
    threemf.write_bytes(b"3mf")
    db_session.add(LibraryFile(filename="panel-reprint.3mf", file_path=str(threemf), file_type="3mf", file_size=3))
    await db_session.commit()
    archive = _archive(printer.id, grams=500)
    archive.file_path = None
    client = _client(progress=50, mapping=[0])

    with (
        patch("backend.app.main.printer_manager") as manager,
        patch(
            "backend.app.services.filament_tracking.slots_from_3mf_file",
            return_value=[{"slot_id": 1, "used_g": 420, "type": "PLA", "color": "#FFFFFF"}],
        ),
    ):
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=50,
            data=_mqtt_reprint_names(),
            archive=archive,
            ams_mapping=None,
            db=db_session,
        )
        await db_session.refresh(bucket)
        assert bucket.on_hand_grams == 9790

        client.state.progress = 100
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            data=_mqtt_reprint_names(),
            archive=archive,
            ams_mapping=None,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == 420
    assert events[0].kind == "completed"
    assert bucket.on_hand_grams == 9580


@pytest.mark.asyncio
async def test_sync_exact_previous_archive_3mf_is_gram_basis(db_session, printer_factory, tmp_path):
    printer, bucket = await _assign_white(db_session, printer_factory)
    threemf = tmp_path / "panel-reprint.3mf"
    threemf.write_bytes(b"3mf")
    db_session.add(
        PrintArchive(
            printer_id=printer.id,
            filename="panel-reprint.3mf",
            print_name="panel-reprint",
            file_path=str(threemf),
            file_size=3,
            status="completed",
        )
    )
    await db_session.commit()
    live_archive = _archive(printer.id, grams=500)
    live_archive.file_path = None
    live_archive.id = None
    client = _client(progress=100, mapping=[0])

    with (
        patch("backend.app.main.printer_manager") as manager,
        patch(
            "backend.app.services.filament_tracking.slots_from_3mf_file",
            return_value=[{"slot_id": 1, "used_g": 275, "type": "PLA", "color": "#FFFFFF"}],
        ),
    ):
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            data=_mqtt_reprint_names(),
            archive=live_archive,
            archive_id=None,
            ams_mapping=None,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == 275
    assert bucket.on_hand_grams == 9725


@pytest.mark.asyncio
async def test_sync_similar_name_does_not_use_library_3mf(db_session, printer_factory, tmp_path):
    printer, bucket = await _assign_white(db_session, printer_factory)
    threemf = tmp_path / "panel-reprint.3mf"
    threemf.write_bytes(b"3mf")
    db_session.add(LibraryFile(filename="panel-reprint.3mf", file_path=str(threemf), file_type="3mf", file_size=3))
    await db_session.commit()
    archive = _archive(printer.id, grams=500)
    archive.print_name = "panel-reprint-v2"
    archive.filename = "panel-reprint-v2.gcode.3mf"
    archive.file_path = None
    archive.filament_used_grams = None
    client = _client(remain=80, progress=10, mapping=None)

    with (
        patch("backend.app.main.printer_manager") as manager,
        patch(
            "backend.app.services.filament_tracking.slots_from_3mf_file",
            return_value=[{"slot_id": 1, "used_g": 420, "type": "PLA", "color": "#FFFFFF"}],
        ),
    ):
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=10,
            data={"subtask_name": "panel-reprint-v2", "gcode_file": "panel-reprint-v2.gcode.3mf"},
            archive=archive,
            ams_mapping=None,
            db=db_session,
        )
        client.state.raw_data["ams"]["ams"][0]["tray"][0]["remain"] = 50
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            data={"subtask_name": "panel-reprint-v2", "gcode_file": "panel-reprint-v2.gcode.3mf"},
            archive=archive,
            ams_mapping=None,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == 300
    assert events[0].print_name == "panel-reprint-v2"
    assert bucket.on_hand_grams == 9700


@pytest.mark.asyncio
async def test_sync_sd_job_without_match_uses_remain_on_observed_trays(db_session, printer_factory):
    printer, easyrock, jade = await _assign_two_whites(db_session, printer_factory)
    archive = _archive(printer.id)
    archive.print_name = "sd-unknown-job"
    archive.filename = "sd-unknown-job.gcode"
    archive.file_path = None
    archive.filament_used_grams = None
    client = _client_two_trays(remain0=80, remain1=80, progress=10, tray_now=0, mapping=[0])

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=10,
            data={"subtask_name": "sd-unknown-job", "filename": "sd-unknown-job.gcode"},
            archive=archive,
            ams_mapping=None,
            db=db_session,
        )
        client.state.raw_data["ams"]["ams"][0]["tray"][0]["remain"] = 50
        client.state.raw_data["ams"]["ams"][0]["tray"][1]["remain"] = 20
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            data={"subtask_name": "sd-unknown-job", "filename": "sd-unknown-job.gcode"},
            archive=archive,
            ams_mapping=None,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(easyrock)
    await db_session.refresh(jade)
    by_id = {row.bucket_id: row.grams for row in (await db_session.execute(select(FilamentColorUsage))).scalars().all()}
    assert by_id[easyrock.id] == 300
    assert jade.id not in by_id
    assert easyrock.on_hand_grams == 9700
    assert jade.on_hand_grams == 8000


@pytest.mark.asyncio
async def test_sync_hyphen_mqtt_name_uses_spaced_archive_3mf(db_session, printer_factory, tmp_path):
    printer, bucket = await _assign_white(db_session, printer_factory)
    threemf = tmp_path / "BOT x2 - 1.8.2 - X1C.3mf"
    threemf.write_bytes(b"3mf")
    db_session.add(
        PrintArchive(
            printer_id=printer.id,
            filename="BOT x2 - 1.8.2 - X1C.gcode.3mf",
            print_name="BOT x2 - 1.8.2 - X1C",
            file_path=str(threemf),
            file_size=3,
            status="completed",
        )
    )
    await db_session.commit()
    client = _client(progress=35, mapping=[0])
    client.state.subtask_name = "BOT-x2-1.8.2-X1C"
    client.state.gcode_file = "/data/Metadata/plate_1.gcode"

    with (
        patch("backend.app.main.printer_manager") as manager,
        patch(
            "backend.app.services.filament_tracking.slots_from_3mf_file",
            return_value=[{"slot_id": 1, "used_g": 200, "type": "PLA", "color": "#FFFFFF"}],
        ),
    ):
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=35,
            data={
                "subtask_name": "BOT-x2-1.8.2-X1C",
                "gcode_file": "/data/Metadata/plate_1.gcode",
            },
            archive=None,
            archive_id=None,
            ams_mapping=None,
            start=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].printer_id == printer.id
    assert events[0].kind == "printing"
    assert events[0].grams == 70
    assert events[0].print_name == "BOT-x2-1.8.2-X1C"
    assert bucket.on_hand_grams == 9930


@pytest.mark.asyncio
async def test_sync_unassigned_live_job_stays_visible(db_session, printer_factory):
    printer = await printer_factory()
    client = _client(progress=35, mapping=None)
    client.state.subtask_name = "BOT-x2-1.8.2-X1C"

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=35,
            data={"subtask_name": "BOT-x2-1.8.2-X1C", "gcode_file": "/data/Metadata/plate_1.gcode"},
            archive=None,
            archive_id=None,
            start=True,
            db=db_session,
        )

    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert events == []
    live = get_live_run(printer.id)
    assert live is not None
    assert live.print_name == "BOT-x2-1.8.2-X1C"
    visible = untracked_live_runs(set())
    assert any(run.printer_id == printer.id for run in visible)


def _write_slice_3mf(path, xml: str):
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Metadata/slice_info.config", xml)
    path.write_bytes(buf.getvalue())
    return path


@pytest.mark.asyncio
async def test_sync_settle_keeps_3mf_when_remain_also_drops(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id, grams=500)
    client = _client(remain=80, progress=50, mapping=[0])

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=50, archive=archive, db=db_session)
        await db_session.refresh(bucket)
        assert bucket.on_hand_grams == 9750
        client.state.raw_data["ams"]["ams"][0]["tray"][0]["remain"] = 50
        client.state.progress = 100
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            archive=archive,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "completed"
    assert events[0].grams == 500
    assert events[0].estimated is False
    assert bucket.on_hand_grams == 9500


@pytest.mark.asyncio
async def test_sync_settle_without_remain_uses_3mf_and_is_not_estimated(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id, grams=132.85)
    client = _client(remain=None, progress=100, mapping=[0])

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            archive=archive,
            settle=True,
            db=db_session,
        )

    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == pytest.approx(132.9, abs=0.1)
    assert events[0].estimated is False
    assert events[0].kind == "completed"


@pytest.mark.asyncio
async def test_sync_skip_objects_complete_still_charges_full_plate_3mf(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id, grams=133)
    client = _client(remain=-1, progress=45, mapping=[0])

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(printer.id, status="printing", progress=45, archive=archive, db=db_session)
        live = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
        assert len(live) == 1
        assert live[0].estimated is False
        assert live[0].grams == pytest.approx(59.8, abs=0.2)

        client.state.skipped_objects = [1, 2]
        client.state.raw_data = {**client.state.raw_data, "s_obj": [1, 2]}
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=45,
            data={"s_obj": [1, 2]},
            archive=archive,
            db=db_session,
        )
        live = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
        assert len(live) == 1
        assert live[0].estimated is True
        assert live[0].grams == pytest.approx(59.8, abs=0.2)

        client.state.progress = 100
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            data={"s_obj": [1, 2], "raw_data": {**client.state.raw_data, "s_obj": [1, 2]}},
            archive=archive,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == 133
    assert events[0].estimated is True
    assert events[0].kind == "completed"
    assert bucket.on_hand_grams == 9867


@pytest.mark.asyncio
async def test_sync_remain_minus_one_does_not_zero_grams(db_session, printer_factory):
    printer, bucket = await _assign_white(db_session, printer_factory)
    archive = _archive(printer.id, grams=500)
    client = _client(remain=-1, progress=100, mapping=[0])

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="completed",
            progress=100,
            archive=archive,
            settle=True,
            db=db_session,
        )

    await db_session.refresh(bucket)
    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == 500
    assert events[0].grams != 0
    assert events[0].estimated is False
    assert bucket.on_hand_grams == 9500


@pytest.mark.asyncio
async def test_sync_multi_plate_gcode_scopes_to_this_plate(db_session, printer_factory, tmp_path):
    printer, bucket = await _assign_white(db_session, printer_factory)
    threemf = _write_slice_3mf(
        tmp_path / "BOT x2 - 1.8.2 - X1C.3mf",
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
    )
    db_session.add(
        PrintArchive(
            printer_id=printer.id,
            filename="BOT x2 - 1.8.2 - X1C.gcode.3mf",
            print_name="BOT x2 - 1.8.2 - X1C",
            file_path=str(threemf),
            file_size=threemf.stat().st_size,
            status="completed",
        )
    )
    await db_session.commit()
    client = _client(remain=None, progress=45, mapping=[0])
    client.state.subtask_name = "BOT-x2-1.8.2-X1C"
    client.state.gcode_file = "/data/Metadata/plate_1.gcode"

    with patch("backend.app.main.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.get_status.return_value = client.state
        await _sync_filament_color_tracking(
            printer.id,
            status="printing",
            progress=45,
            data={
                "subtask_name": "BOT-x2-1.8.2-X1C",
                "gcode_file": "/data/Metadata/plate_1.gcode",
            },
            archive=None,
            start=True,
            db=db_session,
        )

    events = (await db_session.execute(select(FilamentColorUsage))).scalars().all()
    assert len(events) == 1
    assert events[0].grams == pytest.approx(59.8, abs=0.2)
    assert events[0].grams < 200
    assert events[0].estimated is False
