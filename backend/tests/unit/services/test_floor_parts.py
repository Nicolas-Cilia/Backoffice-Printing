"""Unit tests for labeled parts (docs/floor-plan.md §5.4 Harvest, §7, §9).

These exercise the resolution logic directly against a db session, the same
style as ``test_floor_sessions.py`` — the harvest lock's mechanics already
have their own tests there; what's new here is the plate binding and part
resolution built on top of it.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.models.floor_part import FloorLabeledPart
from backend.app.services.floor_codes import station_for_slug
from backend.app.services.floor_parts import (
    HarvestPrinterResult,
    LocationScanResult,
    PartScanResult,
    ReplaceStickerReasonCode,
    ReplaceStickerResult,
    SandingReasonCode,
    UnlinkReasonCode,
    archive_part,
    list_needs_attention,
    list_part_events,
    normalize_sticker_code,
    parse_sticker_code,
    relink_part,
    replace_sticker_code,
    scan_fit_check_part,
    scan_harvest_printer,
    scan_part,
    scan_sanding_part,
    search_completed_jobs,
    unlink_part,
)
from backend.app.services.floor_sessions import (
    ScanResult,
    apply_station_scan,
    get_open_session_for_device,
)

DEVICE_A = "device-a"
DEVICE_B = "device-b"

HARVEST = station_for_slug("harvest")
CLEANUP = station_for_slug("cleanup")


async def _open_harvest(db_session, device_id: str):
    await apply_station_scan(db_session, HARVEST, device_id)
    await db_session.commit()


async def _harvest_one_part(db_session, printer_id: int, code: str = "BBD-000001"):
    """Enroll one part via Harvest so a Fit Check/Sanding test has something
    to scan. Leaves no session open afterward — Fit Check and Sanding are
    locations, not stations, so there is nothing to open."""
    await _open_harvest(db_session, DEVICE_A)
    await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer_id}")
    await db_session.commit()
    await scan_part(db_session, DEVICE_A, code)
    await db_session.commit()
    # Re-scanning the same printer closes the plate but not the session;
    # re-scanning Harvest's own station QR closes the session outright, so
    # a location scan right after doesn't appear to still be "inside" it.
    await apply_station_scan(db_session, HARVEST, DEVICE_A)
    await db_session.commit()


class TestNormalizeAndParse:
    def test_normalizes_case_and_whitespace(self):
        assert normalize_sticker_code("  bbd-000123 \n") == "BBD-000123"

    def test_parses_a_well_formed_code(self):
        assert parse_sticker_code("BBD-000123") == "BBD-000123"

    def test_tolerates_whitespace_and_lowercase(self):
        assert parse_sticker_code("  bbd-000123\n") == "BBD-000123"

    @pytest.mark.parametrize(
        "payload",
        [
            "",
            "BBD-",
            "BBD-12345",  # 5 digits
            "BBD-1234567",  # 7 digits
            "BBD-00012a",  # non-digit
            "BBP-000123",  # printer prefix
            "BBS-harvest",  # station prefix
            "000123",  # missing prefix
        ],
    )
    def test_rejects_malformed_codes(self, payload: str):
        assert parse_sticker_code(payload) is None


class TestHarvestPrinterBinding:
    @pytest.mark.asyncio
    async def test_binds_to_the_latest_finished_job(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer_id=printer.id, print_name="Bracket v4", quantity=4)
        await _open_harvest(db_session, DEVICE_A)

        outcome = await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()

        assert outcome.result is HarvestPrinterResult.BOUND
        assert outcome.printer.id == printer.id
        assert outcome.archive.archive_id == archive.id
        assert outcome.archive.print_name == "Bracket v4"
        assert outcome.part_count == 0

        session = await get_open_session_for_device(db_session, DEVICE_A)
        assert session.bound_printer_id == printer.id
        assert session.bound_archive_id == archive.id

    @pytest.mark.asyncio
    async def test_binds_with_no_job_found(self, db_session, printer_factory):
        """§7.2: binding a printer with no finished job is not an error —
        the plate is still open, just with no archive to link parts to."""
        printer = await printer_factory()
        await _open_harvest(db_session, DEVICE_A)

        outcome = await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")

        assert outcome.result is HarvestPrinterResult.BOUND
        assert outcome.archive is None

        session = await get_open_session_for_device(db_session, DEVICE_A)
        assert session.bound_printer_id == printer.id
        assert session.bound_archive_id is None

    @pytest.mark.asyncio
    async def test_rescanning_the_same_printer_closes_the_plate_only(
        self, db_session, printer_factory, archive_factory
    ):
        """§5.4: plate close is not session close — the harvest session stays
        open and unbound, ready for the next printer."""
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()

        outcome = await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()

        assert outcome.result is HarvestPrinterResult.PLATE_CLOSED
        session = await get_open_session_for_device(db_session, DEVICE_A)
        assert session is not None  # the harvest session itself is untouched
        assert session.bound_printer_id is None
        assert session.bound_archive_id is None

    @pytest.mark.asyncio
    async def test_plate_closed_reports_the_final_part_count(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()

        await scan_part(db_session, DEVICE_A, "BBD-000001")
        await scan_part(db_session, DEVICE_A, "BBD-000002")
        await db_session.commit()

        outcome = await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")

        assert outcome.result is HarvestPrinterResult.PLATE_CLOSED
        assert outcome.part_count == 2

    @pytest.mark.asyncio
    async def test_scanning_a_different_printer_closes_and_opens(self, db_session, printer_factory, archive_factory):
        first = await printer_factory()
        second = await printer_factory()
        await archive_factory(printer_id=first.id)
        second_archive = await archive_factory(printer_id=second.id, print_name="Different job")
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{first.id}")
        await db_session.commit()

        outcome = await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{second.id}")
        await db_session.commit()

        assert outcome.result is HarvestPrinterResult.REBOUND
        assert outcome.printer.id == second.id
        assert outcome.archive.archive_id == second_archive.id
        # A fresh plate — never carries over the previous plate's count.
        assert outcome.part_count == 0

        session = await get_open_session_for_device(db_session, DEVICE_A)
        assert session.bound_printer_id == second.id
        assert session.bound_archive_id == second_archive.id

    @pytest.mark.asyncio
    async def test_never_reopens_against_a_stale_plate(self, db_session, printer_factory, archive_factory):
        """A closed plate must never come back bound to the archive it had
        before closing — re-scanning the same printer is always a close."""
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")  # close
        await db_session.commit()

        session = await get_open_session_for_device(db_session, DEVICE_A)
        assert session.bound_printer_id is None
        assert session.bound_archive_id is None

    @pytest.mark.asyncio
    async def test_unknown_printer_code(self, db_session):
        await _open_harvest(db_session, DEVICE_A)

        outcome = await scan_harvest_printer(db_session, DEVICE_A, "BBP-999999")

        assert outcome.result is HarvestPrinterResult.UNKNOWN_PRINTER
        assert outcome.printer is None

    @pytest.mark.asyncio
    async def test_no_session_reports_cleanly(self, db_session, printer_factory):
        printer = await printer_factory()

        outcome = await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")

        assert outcome.result is HarvestPrinterResult.NO_SESSION

    @pytest.mark.asyncio
    async def test_a_non_harvest_session_reports_no_session(self, db_session, printer_factory):
        """This endpoint is only meaningful for a harvest session; a device
        in cleanup calling it should not be handled as if it were harvest."""
        printer = await printer_factory()
        await apply_station_scan(db_session, CLEANUP, DEVICE_A)
        await db_session.commit()

        outcome = await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")

        assert outcome.result is HarvestPrinterResult.NO_SESSION


class TestPartScanFromHarvest:
    @pytest.mark.asyncio
    async def test_labels_a_part_against_the_bound_plate(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer_id=printer.id)
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()

        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001")
        await db_session.commit()

        assert outcome.result is PartScanResult.LABELED
        assert outcome.part.sticker_code == "BBD-000001"
        assert outcome.part.printer_id == printer.id
        assert outcome.part.archive_id == archive.id
        assert outcome.part_count == 1

    @pytest.mark.asyncio
    async def test_part_count_increments_per_plate(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()

        await scan_part(db_session, DEVICE_A, "BBD-000001")
        await db_session.commit()
        outcome = await scan_part(db_session, DEVICE_A, "BBD-000002")

        assert outcome.part_count == 2

    @pytest.mark.asyncio
    async def test_no_job_still_records_the_part(self, db_session, printer_factory):
        """§7.2/§9: a printer with no finished job still gets the part
        written — printer_id + labeled_at set, archive_id null."""
        printer = await printer_factory()
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()

        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001")
        await db_session.commit()

        assert outcome.result is PartScanResult.NO_JOB
        assert outcome.part is not None
        assert outcome.part.printer_id == printer.id
        assert outcome.part.labeled_at is not None
        assert outcome.part.archive_id is None

    @pytest.mark.asyncio
    async def test_no_job_part_appears_in_needs_attention(self, db_session, printer_factory):
        printer = await printer_factory()
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()
        await scan_part(db_session, DEVICE_A, "BBD-000001")
        await db_session.commit()

        parts, total = await list_needs_attention(db_session)

        assert total == 1
        assert parts[0].sticker_code == "BBD-000001"
        assert parts[0].printer_id == printer.id
        assert parts[0].printer_name == printer.name

    @pytest.mark.asyncio
    async def test_labeled_part_does_not_appear_in_needs_attention(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()
        await scan_part(db_session, DEVICE_A, "BBD-000001")
        await db_session.commit()

        parts, total = await list_needs_attention(db_session)

        assert total == 0
        assert parts == []

    @pytest.mark.asyncio
    async def test_harvest_open_but_unbound_ignores_the_scan(self, db_session):
        """No printer scan yet — the operator forgot step 1. Must not write
        against whatever was previously bound, or worse, against nothing."""
        await _open_harvest(db_session, DEVICE_A)

        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001")

        assert outcome.result is PartScanResult.NO_PRINTER
        assert outcome.part is None

    @pytest.mark.asyncio
    async def test_a_different_stations_session_is_ignored(self, db_session, printer_factory, archive_factory):
        """§5.4: harvest 'ignores' other codes; a cleanup session must not
        get a part written against it."""
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await apply_station_scan(db_session, CLEANUP, DEVICE_A)
        await db_session.commit()

        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001")

        assert outcome.result is PartScanResult.NO_PRINTER
        assert outcome.part is None

    @pytest.mark.asyncio
    async def test_already_enrolled_sticker_shows_the_existing_link_and_does_not_relink(
        self, db_session, printer_factory, archive_factory
    ):
        """§9: the job link is immutable. Scanning the same sticker again
        while a *different* plate is bound must not steal it."""
        original_printer = await printer_factory()
        original_archive = await archive_factory(printer_id=original_printer.id)
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{original_printer.id}")
        await db_session.commit()
        await scan_part(db_session, DEVICE_A, "BBD-000001")
        await db_session.commit()

        # Close that plate, bind a different printer, then re-scan the same sticker.
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{original_printer.id}")  # close
        await db_session.commit()
        other_printer = await printer_factory()
        await archive_factory(printer_id=other_printer.id)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{other_printer.id}")
        await db_session.commit()

        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001")

        assert outcome.result is PartScanResult.DUPLICATE
        assert outcome.part is None

        # And the underlying row is untouched.
        result = await db_session.execute(select(FloorLabeledPart).where(FloorLabeledPart.sticker_code == "BBD-000001"))
        row = result.scalar_one()
        assert row.printer_id == original_printer.id
        assert row.archive_id == original_archive.id

        events = await list_part_events(db_session, row.id)
        assert [event.action for event in events] == ["enrolled", "scanned"]
        assert events[1].details == {
            "station_slug": "harvest",
            "printer_id": other_printer.id,
        }

    @pytest.mark.asyncio
    async def test_duplicate_on_the_same_plate_is_rejected(self, db_session, printer_factory, archive_factory):
        """A duplicate must not increment or otherwise alter the plate."""
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()
        await scan_part(db_session, DEVICE_A, "BBD-000001")
        await scan_part(db_session, DEVICE_A, "BBD-000002")
        await db_session.commit()

        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001")

        assert outcome.result is PartScanResult.DUPLICATE
        assert outcome.part_count == 0

    @pytest.mark.asyncio
    async def test_duplicate_is_rejected_without_an_open_plate(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()
        await apply_station_scan(db_session, HARVEST, DEVICE_A)  # close the session entirely
        await db_session.commit()

        outcome = await scan_part(db_session, DEVICE_B, "BBD-000001")

        assert outcome.result is PartScanResult.DUPLICATE
        assert outcome.part_count == 0


class TestPartScanFromPrinterInfoPage:
    """Entry #2 (§5.4): a `BBD-` scan with a printer-id hint and no prior
    harvest session claims the lock itself."""

    @pytest.mark.asyncio
    async def test_first_part_scan_claims_the_harvest_lock(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer_id=printer.id)

        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()

        assert outcome.result is PartScanResult.LABELED
        assert outcome.part.printer_id == printer.id
        assert outcome.part.archive_id == archive.id
        assert outcome.part_count == 1

        session = await get_open_session_for_device(db_session, DEVICE_A)
        assert session is not None
        assert session.station_slug == "harvest"
        assert session.bound_printer_id == printer.id
        assert session.bound_archive_id == archive.id

    @pytest.mark.asyncio
    async def test_both_entry_points_produce_identical_part_rows(self, db_session, printer_factory, archive_factory):
        """The central contract of §5.4: it must not matter which door the
        operator came through.

        Run one at a time — the harvest lock is floor-wide (§5.4), so both
        entry points claiming it simultaneously would just test the lock,
        not this. Device A's session is closed before device B claims it.
        """
        printer = await printer_factory()
        archive = await archive_factory(printer_id=printer.id)

        # Entry #1: station then printer then part.
        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{printer.id}")
        await db_session.commit()
        via_station = await scan_part(db_session, DEVICE_A, "BBD-000001")
        await db_session.commit()
        await apply_station_scan(db_session, HARVEST, DEVICE_A)  # close A's session
        await db_session.commit()

        # Entry #2: printer info page straight to a part, no station scan.
        via_info_page = await scan_part(db_session, DEVICE_B, "BBD-000002", printer_id_hint=printer.id)
        await db_session.commit()

        assert via_station.result is via_info_page.result is PartScanResult.LABELED
        assert via_station.part.printer_id == via_info_page.part.printer_id == printer.id
        assert via_station.part.archive_id == via_info_page.part.archive_id == archive.id

    @pytest.mark.asyncio
    async def test_locked_when_another_device_holds_harvest(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        await _open_harvest(db_session, DEVICE_A)  # A holds harvest already

        outcome = await scan_part(db_session, DEVICE_B, "BBD-000001", printer_id_hint=printer.id)

        assert outcome.result is PartScanResult.LOCKED
        assert outcome.blocking is not None
        assert outcome.blocking.device_id == DEVICE_A
        assert outcome.part is None

        # Nothing was written, and B claimed nothing.
        result = await db_session.execute(select(FloorLabeledPart))
        assert result.scalars().all() == []
        assert await get_open_session_for_device(db_session, DEVICE_B) is None

    @pytest.mark.asyncio
    async def test_no_hint_and_no_session_is_no_printer(self, db_session):
        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001")

        assert outcome.result is PartScanResult.NO_PRINTER
        assert outcome.part is None

    @pytest.mark.asyncio
    async def test_hint_is_ignored_once_a_harvest_session_exists(self, db_session, printer_factory, archive_factory):
        """The hint is entry #2's lock claim only — once a session exists it
        must not silently redirect a part away from the bound plate."""
        bound_printer = await printer_factory()
        bound_archive = await archive_factory(printer_id=bound_printer.id)
        hinted_printer = await printer_factory()
        await archive_factory(printer_id=hinted_printer.id)

        await _open_harvest(db_session, DEVICE_A)
        await scan_harvest_printer(db_session, DEVICE_A, f"BBP-{bound_printer.id}")
        await db_session.commit()

        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=hinted_printer.id)

        assert outcome.result is PartScanResult.LABELED
        assert outcome.part.printer_id == bound_printer.id
        assert outcome.part.archive_id == bound_archive.id

    @pytest.mark.asyncio
    async def test_invalid_code_writes_nothing(self, db_session, printer_factory):
        printer = await printer_factory()

        outcome = await scan_part(db_session, DEVICE_A, "not-a-code", printer_id_hint=printer.id)

        assert outcome.result is PartScanResult.INVALID_CODE
        assert outcome.part is None
        assert await get_open_session_for_device(db_session, DEVICE_A) is None


class TestFitCheckPartScan:
    """§5.4a: a location, not a station — no session, no floor-wide lock.
    `scan_fit_check_part` takes only the payload; it commits unconditionally,
    the same whether any station happens to be open on some device or not."""

    @pytest.mark.asyncio
    async def test_records_a_fit_checked_event(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer_id=printer.id, print_name="Bracket v4")
        await _harvest_one_part(db_session, printer.id)

        outcome = await scan_fit_check_part(db_session, "BBD-000001")
        await db_session.commit()

        assert outcome.result is LocationScanResult.RECORDED
        assert outcome.part.sticker_code == "BBD-000001"
        assert outcome.printer.id == printer.id
        assert outcome.archive.archive_id == archive.id

        part = outcome.part
        events = await list_part_events(db_session, part.id)
        assert [e.action for e in events] == ["enrolled", "fit_checked"]

    @pytest.mark.asyncio
    async def test_rescanning_an_already_checked_part_appends_again(self, db_session, printer_factory):
        printer = await printer_factory()
        await _harvest_one_part(db_session, printer.id)
        await scan_fit_check_part(db_session, "BBD-000001")
        await db_session.commit()

        outcome = await scan_fit_check_part(db_session, "BBD-000001")
        await db_session.commit()

        assert outcome.result is LocationScanResult.RECORDED
        events = await list_part_events(db_session, outcome.part.id)
        assert [e.action for e in events] == ["enrolled", "fit_checked", "fit_checked"]

    @pytest.mark.asyncio
    async def test_unknown_sticker_is_rejected(self, db_session):
        """§9: never enrolled at Harvest — the sticker doesn't exist yet."""
        outcome = await scan_fit_check_part(db_session, "BBD-000001")

        assert outcome.result is LocationScanResult.UNKNOWN_PART

    @pytest.mark.asyncio
    async def test_invalid_code_writes_nothing(self, db_session):
        outcome = await scan_fit_check_part(db_session, "not-a-code")

        assert outcome.result is LocationScanResult.INVALID_CODE
        assert outcome.part is None

    @pytest.mark.asyncio
    async def test_commits_regardless_of_whatever_station_is_open_elsewhere(self, db_session, printer_factory):
        """Not a station, so it is not gated on — or affected by — any real
        station session. WIP being open on some device must not block it."""
        printer = await printer_factory()
        await _harvest_one_part(db_session, printer.id)
        WIP = station_for_slug("wip")
        await apply_station_scan(db_session, WIP, DEVICE_B)
        await db_session.commit()

        outcome = await scan_fit_check_part(db_session, "BBD-000001")

        assert outcome.result is LocationScanResult.RECORDED


class TestSandingPartScan:
    """§5.4b: the third scan of its flow (part, then the Sanding location —
    a pure UI transition with no server call, then this reason). Like Fit
    Check, `scan_sanding_part` is a plain commit with no session concept."""

    @pytest.mark.asyncio
    async def test_records_a_sanding_event_with_the_reason(self, db_session, printer_factory):
        printer = await printer_factory()
        await _harvest_one_part(db_session, printer.id)

        outcome = await scan_sanding_part(db_session, "BBD-000001", SandingReasonCode.DOESNT_FIT)
        await db_session.commit()

        assert outcome.result is LocationScanResult.RECORDED
        events = await list_part_events(db_session, outcome.part.id)
        assert [e.action for e in events] == ["enrolled", "sanding"]
        assert events[-1].details == {"reason_code": "doesnt_fit", "reason_text": None}

    @pytest.mark.asyncio
    async def test_other_reason_carries_free_text(self, db_session, printer_factory):
        printer = await printer_factory()
        await _harvest_one_part(db_session, printer.id)

        outcome = await scan_sanding_part(db_session, "BBD-000001", SandingReasonCode.OTHER, "warped corner")
        await db_session.commit()

        events = await list_part_events(db_session, outcome.part.id)
        assert events[-1].details == {"reason_code": "other", "reason_text": "warped corner"}

    @pytest.mark.asyncio
    async def test_sanding_more_than_once_appends_each_time(self, db_session, printer_factory):
        """No amendment concept here (unlike Cleanup's disposition, §5.5) —
        a part can go back to Sanding more than once, and each visit is its
        own event with its own reason."""
        printer = await printer_factory()
        await _harvest_one_part(db_session, printer.id)
        await scan_sanding_part(db_session, "BBD-000001", SandingReasonCode.ROUGH_SURFACE)
        await db_session.commit()

        outcome = await scan_sanding_part(db_session, "BBD-000001", SandingReasonCode.LAYER_LINES)
        await db_session.commit()

        events = await list_part_events(db_session, outcome.part.id)
        assert [e.action for e in events] == ["enrolled", "sanding", "sanding"]

    @pytest.mark.asyncio
    async def test_unknown_sticker_is_rejected(self, db_session):
        outcome = await scan_sanding_part(db_session, "BBD-000001", SandingReasonCode.OTHER, "note")

        assert outcome.result is LocationScanResult.UNKNOWN_PART

    @pytest.mark.asyncio
    async def test_invalid_code_writes_nothing(self, db_session):
        outcome = await scan_sanding_part(db_session, "not-a-code", SandingReasonCode.OTHER, "note")

        assert outcome.result is LocationScanResult.INVALID_CODE
        assert outcome.part is None


class TestSessionSwitchGuard:
    @pytest.mark.asyncio
    async def test_scanning_a_station_qr_while_the_lock_is_claimed_still_works(self, db_session, printer_factory):
        """A sanity check that claiming the lock via a part scan produces a
        session `apply_station_scan` recognizes normally — e.g. re-scanning
        `BBS-harvest` afterwards closes it like any other harvest session."""
        printer = await printer_factory()
        await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()

        outcome = await apply_station_scan(db_session, HARVEST, DEVICE_A)
        await db_session.commit()

        assert outcome.result is ScanResult.CLOSED


class TestRelinkPart:
    """`relink_part`'s printer guard was removed (docs/floor-plan.md §7's
    matching flow is now printer-agnostic) — these prove a cross-printer
    correction succeeds and updates `printer_id`, while
    `test_matching_only_resolves_an_unlinked_part` in the integration suite
    keeps proving the still-immutable "already linked" guard."""

    @pytest.mark.asyncio
    async def test_succeeds_when_the_archives_printer_differs_from_the_parts(
        self, db_session, printer_factory, archive_factory
    ):
        recorded_printer = await printer_factory()
        other_printer = await printer_factory()
        other_archive = await archive_factory(printer_id=other_printer.id, print_name="Actually this one")
        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=recorded_printer.id)
        await db_session.commit()
        assert outcome.part.printer_id == recorded_printer.id
        assert outcome.part.archive_id is None  # no job on recorded_printer

        part = await relink_part(db_session, outcome.part.id, other_archive.id)
        await db_session.commit()

        assert part is not None
        assert part.archive_id == other_archive.id
        assert part.printer_id == other_printer.id  # corrected to match the archive


class TestUnlinkPart:
    @pytest.mark.asyncio
    async def test_success_clears_the_link_and_writes_an_event(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer_id=printer.id)
        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()
        assert outcome.part.archive_id == archive.id

        part = await unlink_part(db_session, outcome.part.id, UnlinkReasonCode.WRONG_JOB.value, None)
        await db_session.commit()

        assert part is not None
        assert part.archive_id is None
        assert part.printer_id == printer.id  # untouched — see the docstring

        events = await list_part_events(db_session, part.id)
        assert [e.action for e in events] == ["enrolled", "unlinked"]
        assert events[-1].details == {
            "previous_archive_id": archive.id,
            "reason_code": "wrong_job",
            "reason_text": None,
        }

    @pytest.mark.asyncio
    async def test_refuses_on_an_archived_part(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)
        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()
        await archive_part(db_session, outcome.part.id, archived=True)
        await db_session.commit()

        result = await unlink_part(db_session, outcome.part.id, "wrong_job")

        assert result is None

    @pytest.mark.asyncio
    async def test_refuses_when_there_is_nothing_to_unlink(self, db_session, printer_factory):
        printer = await printer_factory()
        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()
        assert outcome.part.archive_id is None  # no job found at harvest

        result = await unlink_part(db_session, outcome.part.id, "wrong_job")

        assert result is None

    @pytest.mark.asyncio
    async def test_refuses_on_a_missing_part(self, db_session):
        result = await unlink_part(db_session, 999999, "wrong_job")

        assert result is None


class TestSearchCompletedJobs:
    @pytest.mark.asyncio
    async def test_returns_matches_across_printers_with_printer_name_populated(
        self, db_session, printer_factory, archive_factory
    ):
        bench_a = await printer_factory(name="Bench A")
        bench_b = await printer_factory(name="Bench B")
        match_a = await archive_factory(printer_id=bench_a.id, print_name="Bracket v4")
        match_b = await archive_factory(printer_id=bench_b.id, print_name="Bracket v5")
        await archive_factory(printer_id=bench_a.id, print_name="Unrelated widget", filename="widget.gcode.3mf")

        results = await search_completed_jobs(db_session, "bracket")

        by_id = {r.id: r for r in results}
        assert set(by_id) == {match_a.id, match_b.id}
        assert by_id[match_a.id].printer_name == "Bench A"
        assert by_id[match_b.id].printer_name == "Bench B"

    @pytest.mark.asyncio
    async def test_empty_query_returns_nothing(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id)

        assert await search_completed_jobs(db_session, "") == []
        assert await search_completed_jobs(db_session, "   ") == []

    @pytest.mark.asyncio
    async def test_respects_the_limit(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory()
        for i in range(5):
            await archive_factory(printer_id=printer.id, print_name=f"Widget {i}", filename=f"widget_{i}.gcode.3mf")

        results = await search_completed_jobs(db_session, "widget", limit=2)

        assert len(results) == 2


class TestReplaceStickerCode:
    @pytest.mark.asyncio
    async def test_success_writes_an_event_with_the_old_and_new_codes(self, db_session, printer_factory):
        printer = await printer_factory()
        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()

        result = await replace_sticker_code(
            db_session, outcome.part.id, "BBD-000002", ReplaceStickerReasonCode.DAMAGED.value, None
        )
        await db_session.commit()

        assert result.result is ReplaceStickerResult.REPLACED
        assert result.part.sticker_code == "BBD-000002"

        events = await list_part_events(db_session, outcome.part.id)
        assert events[-1].action == "sticker_replaced"
        assert events[-1].details == {
            "previous_code": "BBD-000001",
            "new_code": "BBD-000002",
            "reason_code": "damaged",
            "reason_text": None,
        }

    @pytest.mark.asyncio
    async def test_refuses_on_an_archived_part(self, db_session, printer_factory):
        printer = await printer_factory()
        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()
        await archive_part(db_session, outcome.part.id, archived=True)
        await db_session.commit()

        result = await replace_sticker_code(db_session, outcome.part.id, "BBD-000002", "damaged")

        assert result.result is ReplaceStickerResult.ARCHIVED

    @pytest.mark.asyncio
    async def test_refuses_on_a_malformed_code(self, db_session, printer_factory):
        printer = await printer_factory()
        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()

        result = await replace_sticker_code(db_session, outcome.part.id, "not-a-code", "damaged")

        assert result.result is ReplaceStickerResult.INVALID_CODE

    @pytest.mark.asyncio
    async def test_refuses_when_the_new_code_is_already_in_use(self, db_session, printer_factory):
        printer = await printer_factory()
        first = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()
        second = await scan_part(db_session, DEVICE_A, "BBD-000002")
        await db_session.commit()

        result = await replace_sticker_code(db_session, second.part.id, "BBD-000001", "damaged")

        assert result.result is ReplaceStickerResult.CODE_IN_USE
        assert first.part is not None  # unchanged

    @pytest.mark.asyncio
    async def test_refuses_when_the_new_code_is_in_use_by_an_archived_part(self, db_session, printer_factory):
        """§7.1: a code is never reusable, even once its part is archived."""
        printer = await printer_factory()
        first = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()
        await archive_part(db_session, first.part.id, archived=True)
        await db_session.commit()
        second = await scan_part(db_session, DEVICE_A, "BBD-000002")
        await db_session.commit()

        result = await replace_sticker_code(db_session, second.part.id, "BBD-000001", "damaged")

        assert result.result is ReplaceStickerResult.CODE_IN_USE

    @pytest.mark.asyncio
    async def test_refuses_when_the_new_code_equals_the_current_code(self, db_session, printer_factory):
        printer = await printer_factory()
        outcome = await scan_part(db_session, DEVICE_A, "BBD-000001", printer_id_hint=printer.id)
        await db_session.commit()

        result = await replace_sticker_code(db_session, outcome.part.id, "BBD-000001", "damaged")

        assert result.result is ReplaceStickerResult.INVALID_CODE
