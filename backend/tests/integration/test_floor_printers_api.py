"""Printer codes and the printer info page (docs/floor-plan.md §5.6, phase 7).

Covers the two things an operator does with a printer QR: print it from the
Codes page, and scan it at the machine to see what that machine is doing.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest


@pytest.mark.asyncio
@pytest.mark.integration
class TestListPrinters:
    async def test_lists_printers_with_their_payloads(self, async_client, printer_factory):
        printer = await printer_factory(name="Bench A")

        resp = await async_client.get("/api/v1/floor/printers")

        assert resp.status_code == 200
        row = next(p for p in resp.json() if p["id"] == printer.id)
        assert row["payload"] == f"BBP-{printer.id}"
        assert row["name"] == "Bench A"

    async def test_includes_inactive_printers(self, async_client, printer_factory):
        """A machine disabled in the app is still physically on the floor and
        still wants a label stuck to it."""
        printer = await printer_factory(name="Retired", is_active=False)

        resp = await async_client.get("/api/v1/floor/printers")

        ids = [p["id"] for p in resp.json()]
        assert printer.id in ids

    async def test_ordered_by_name_so_the_sheet_matches_the_screen(self, async_client, printer_factory):
        await printer_factory(name="Zulu")
        await printer_factory(name="Alpha")

        resp = await async_client.get("/api/v1/floor/printers")

        names = [p["name"] for p in resp.json()]
        assert names == sorted(names)


@pytest.mark.asyncio
@pytest.mark.integration
class TestRenderPrinterLabels:
    async def test_renders_a_pdf(self, async_client, printer_factory):
        printer = await printer_factory(name="Bench A")

        resp = await async_client.post(
            "/api/v1/floor/labels/printers",
            json={"payloads": [f"BBP-{printer.id}"], "width_mm": 60, "height_mm": 60},
        )

        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/pdf"
        assert resp.content.startswith(b"%PDF-")
        # Content-Length must be exact — a wrong value truncates the PDF in
        # the browser, which reads as a corrupt label rather than a bug here.
        assert int(resp.headers["content-length"]) == len(resp.content)

    async def test_refuses_an_unknown_printer_rather_than_skipping_it(self, async_client, printer_factory):
        """A silently-short PDF is worse than an error: the missing label is
        only noticed once someone is standing at the machine."""
        printer = await printer_factory()

        resp = await async_client.post(
            "/api/v1/floor/labels/printers",
            json={
                "payloads": [f"BBP-{printer.id}", "BBP-999999"],
                "width_mm": 60,
                "height_mm": 60,
            },
        )

        assert resp.status_code == 400
        assert "BBP-999999" in resp.json()["detail"]

    async def test_rejects_a_station_payload(self, async_client):
        resp = await async_client.post(
            "/api/v1/floor/labels/printers",
            json={"payloads": ["BBS-wip"], "width_mm": 60, "height_mm": 60},
        )

        assert resp.status_code == 400

    @pytest.mark.parametrize(("w", "h"), [(5, 60), (60, 5), (500, 60), (60, 500)])
    async def test_rejects_sizes_outside_the_supported_range(self, async_client, printer_factory, w, h):
        printer = await printer_factory()

        resp = await async_client.post(
            "/api/v1/floor/labels/printers",
            json={"payloads": [f"BBP-{printer.id}"], "width_mm": w, "height_mm": h},
        )

        assert resp.status_code == 422


@pytest.mark.asyncio
@pytest.mark.integration
class TestPrinterInfo:
    async def test_reports_identity_and_state(self, async_client, printer_factory):
        printer = await printer_factory(name="Bench A", model="X1C", location="Line 1")

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == "Bench A"
        assert body["model"] == "X1C"
        assert body["location"] == "Line 1"
        assert body["payload"] == f"BBP-{printer.id}"

    async def test_reports_awaiting_plate_clear(self, async_client, printer_factory):
        """Which is exactly 'there is something here to harvest' (§5.6)."""
        printer = await printer_factory(awaiting_plate_clear=True)

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        assert resp.json()["awaiting_plate_clear"] is True

    async def test_reports_total_print_hours(self, async_client, printer_factory):
        # 7200s runtime + 1.5h offset. Read through the maintenance helper so
        # this figure can never disagree with the maintenance page's.
        printer = await printer_factory(runtime_seconds=7200, print_hours_offset=1.5)

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        assert resp.json()["total_print_hours"] == pytest.approx(3.5)

    async def test_reports_the_last_finished_print(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        archive = await archive_factory(
            printer_id=printer.id,
            print_name="Bracket v3",
            completed_at=datetime(2026, 8, 24, 14, 32),
            quantity=6,
        )

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        last = resp.json()["last_print"]
        assert last["archive_id"] == archive.id
        assert last["print_name"] == "Bracket v3"
        assert last["quantity"] == 6
        # Phase 8 fills this in; until then "nothing labeled" is correct.
        assert last["has_labeled_parts"] is False

    async def test_exposes_and_records_a_recent_stopped_print_reason(
        self, async_client, printer_factory, archive_factory
    ):
        printer = await printer_factory(name="Bench A")
        await archive_factory(
            printer_id=printer.id,
            print_name="TOP bracket",
            run_status="stopped",
        )

        before = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")
        recent = before.json()["recent_stopped_print"]
        assert recent["print_name"] == "TOP bracket"
        assert recent["status"] == "stopped"
        assert recent["reason_code"] is None

        saved = await async_client.post(
            f"/api/v1/floor/printers/{printer.id}/stopped-print/reason",
            json={"reason_code": "warping"},
        )

        assert saved.status_code == 200
        assert saved.json()["reason_code"] == "warping"
        after = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")
        assert after.json()["recent_stopped_print"]["reason_code"] == "warping"
        log = await async_client.get("/api/v1/floor/inventory/print-failures")
        assert log.json()[0]["printer_id"] == printer.id
        assert log.json()[0]["reason_code"] == "warping"

    async def test_requires_text_for_other_stopped_print_reason(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id, run_status="cancelled")

        response = await async_client.post(
            f"/api/v1/floor/printers/{printer.id}/stopped-print/reason",
            json={"reason_code": "other"},
        )

        assert response.status_code == 422

    async def test_exposes_a_recent_failed_print_for_reason_logging(
        self, async_client, printer_factory, archive_factory
    ):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id, print_name="Bottom bracket", run_status="failed")

        response = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        assert response.json()["recent_stopped_print"]["status"] == "failed"

    async def test_records_plate_failure_for_a_completed_unlabeled_print(
        self, async_client, printer_factory, archive_factory, db_session
    ):
        from backend.app.models.settings import Settings
        from backend.app.services.printer_manager import printer_manager

        db_session.add(
            Settings(
                key="floor_part_tracking_started_at",
                value=(datetime.now() - timedelta(hours=1)).isoformat(),
            )
        )
        await db_session.commit()

        printer = await printer_factory(name="Bench Scrap", awaiting_plate_clear=True)
        archive = await archive_factory(
            printer_id=printer.id,
            print_name="Warped TOP",
            completed_at=datetime.now(),
        )
        printer_manager.set_awaiting_plate_clear(printer.id, True)

        before = await async_client.get("/api/v1/floor/parts/unlabeled-build-plates")
        assert any(plate["id"] == archive.id for plate in before.json())

        saved = await async_client.post(
            f"/api/v1/floor/printers/{printer.id}/plate-failure",
            json={"reason_code": "warping"},
        )

        assert saved.status_code == 200
        body = saved.json()
        assert body["reason_code"] == "warping"
        assert body["status"] == "failed"
        assert body["archive_id"] == archive.id
        assert body["print_name"] == "Warped TOP"

        after = await async_client.get("/api/v1/floor/parts/unlabeled-build-plates")
        assert not any(plate["id"] == archive.id for plate in after.json())
        dismissed = await async_client.get("/api/v1/floor/parts/dismissed-build-plates")
        assert any(plate["id"] == archive.id for plate in dismissed.json())
        log = await async_client.get("/api/v1/floor/inventory/print-failures")
        assert log.json()[0]["archive_id"] == archive.id
        assert log.json()[0]["reason_code"] == "warping"
        assert printer_manager.is_awaiting_plate_clear(printer.id) is False

    async def test_plate_failure_requires_text_for_other(self, async_client, printer_factory, archive_factory):
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id, print_name="Other fail")

        response = await async_client.post(
            f"/api/v1/floor/printers/{printer.id}/plate-failure",
            json={"reason_code": "other"},
        )

        assert response.status_code == 422

    async def test_plate_failure_rejects_when_parts_are_already_labeled(
        self, async_client, printer_factory, archive_factory, db_session
    ):
        from backend.app.models.floor_part import FloorLabeledPart

        printer = await printer_factory()
        archive = await archive_factory(printer_id=printer.id, print_name="Already labeled")
        db_session.add(
            FloorLabeledPart(
                sticker_code="BBD-009901",
                printer_id=printer.id,
                archive_id=archive.id,
            )
        )
        await db_session.commit()

        response = await async_client.post(
            f"/api/v1/floor/printers/{printer.id}/plate-failure",
            json={"reason_code": "layer_lines"},
        )

        assert response.status_code == 400

    async def test_picks_the_most_recently_completed_not_the_newest_row(
        self, async_client, printer_factory, archive_factory
    ):
        """Archives can be written out of order — a backfill, a late cloud
        sync. The operator at the machine means the job that finished last."""
        printer = await printer_factory()
        recent = await archive_factory(
            printer_id=printer.id,
            print_name="Finished last",
            completed_at=datetime(2026, 8, 24, 15, 0),
        )
        # Inserted afterwards, but finished earlier.
        await archive_factory(
            printer_id=printer.id,
            print_name="Finished earlier",
            completed_at=datetime(2026, 8, 24, 9, 0),
        )

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        assert resp.json()["last_print"]["archive_id"] == recent.id

    async def test_ignores_another_printers_jobs(self, async_client, printer_factory, archive_factory):
        mine = await printer_factory(name="Mine")
        theirs = await printer_factory(name="Theirs")
        await archive_factory(printer_id=theirs.id, print_name="Not mine")

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{mine.id}/info")

        assert resp.json()["last_print"] is None

    async def test_ignores_unfinished_jobs(self, async_client, printer_factory, archive_factory):
        """Only a completed job has parts on the bed to label."""
        printer = await printer_factory()
        await archive_factory(printer_id=printer.id, status="failed", print_name="Failed run")

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        assert resp.json()["last_print"] is None

    async def test_no_finished_job_is_not_an_error(self, async_client, printer_factory):
        """§5.6: the page says there is nothing to harvest rather than going
        blank or failing — and it is still not a dead end (§7.2)."""
        printer = await printer_factory()

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        assert resp.status_code == 200
        assert resp.json()["last_print"] is None

    async def test_reports_maintenance_counts(self, async_client, printer_factory):
        printer = await printer_factory()

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        body = resp.json()
        assert isinstance(body["maintenance_due_count"], int)
        assert isinstance(body["maintenance_warning_count"], int)

    async def test_live_status_is_null_when_the_printer_has_no_client(self, async_client, printer_factory):
        """Distinct from connected=False: no MQTT client at all means we
        cannot say anything, which the page renders as 'Status unavailable'
        rather than implying idle."""
        printer = await printer_factory()

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        assert resp.status_code == 200
        assert resp.json()["live"] is None

    async def test_reports_live_status_when_connected(self, async_client, printer_factory, monkeypatch):
        printer = await printer_factory()

        class _State:
            connected = True
            state = "RUNNING"
            current_print = "bracket.gcode"
            subtask_name = "Bracket v3"
            progress = 42.0
            remaining_time = 37  # minutes, per mc_remaining_time
            layer_num = 120
            total_layers = 300

        from backend.app.services import printer_manager as pm

        monkeypatch.setattr(pm.printer_manager, "get_status", lambda _pid: _State())

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        live = resp.json()["live"]
        assert live["connected"] is True
        assert live["state"] == "RUNNING"
        # subtask_name preferred over the raw filename — it is the readable one.
        assert live["current_print"] == "Bracket v3"
        assert live["progress"] == 42.0
        assert live["remaining_minutes"] == 37
        assert live["layer_num"] == 120 and live["total_layers"] == 300

    async def test_falls_back_to_the_raw_filename_without_a_subtask_name(
        self, async_client, printer_factory, monkeypatch
    ):
        printer = await printer_factory()

        class _State:
            connected = True
            state = "RUNNING"
            current_print = "bracket.gcode"
            subtask_name = None
            progress = 1.0
            remaining_time = 5
            layer_num = 1
            total_layers = 10

        from backend.app.services import printer_manager as pm

        monkeypatch.setattr(pm.printer_manager, "get_status", lambda _pid: _State())

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        assert resp.json()["live"]["current_print"] == "bracket.gcode"

    async def test_a_broken_mqtt_layer_does_not_break_the_page(self, async_client, printer_factory, monkeypatch):
        """An operator scanning a printer to see its last job must not get an
        error page because MQTT is unhappy."""
        printer = await printer_factory()

        def _boom(_pid):
            raise RuntimeError("mqtt exploded")

        from backend.app.services import printer_manager as pm

        monkeypatch.setattr(pm.printer_manager, "get_status", _boom)

        resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        assert resp.status_code == 200
        assert resp.json()["live"] is None
        # The rest of the panel still renders.
        assert resp.json()["name"] == printer.name

    async def test_unknown_printer_is_a_404(self, async_client):
        resp = await async_client.get("/api/v1/floor/printers/BBP-999999/info")

        assert resp.status_code == 404

    @pytest.mark.parametrize("payload", ["BBS-wip", "BBD-000042", "BBP-abc", "nonsense"])
    async def test_a_non_printer_payload_is_a_404(self, async_client, payload):
        """Distinct from a locked station's 200 — the scan page renders
        'unknown code' for this, not a takeover prompt."""
        resp = await async_client.get(f"/api/v1/floor/printers/{payload}/info")

        assert resp.status_code == 404

    async def test_viewing_a_printer_takes_no_harvest_lock(self, async_client, printer_factory):
        """§5.6: looking must not block whoever wants to clear the bed. The
        device still holds nothing after an info lookup."""
        printer = await printer_factory()

        await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

        session = await async_client.get("/api/v1/floor/session", params={"device_id": "pc-A"})
        assert session.json() is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_recently_completed_beats_null_completed_at(async_client, printer_factory, archive_factory):
    """A legacy archive with no completion timestamp must not outrank a real
    one.

    Insertion order matters: the undated row is created **last** so it holds
    the highest id, meaning it would win any id-based tiebreak. That part the
    test does verify.

    What it does **not** verify is ``nullslast()`` itself. SQLite already
    sorts NULLs last under ``DESC``, so the clause is a no-op here and this
    test passes with or without it. It earns its place on PostgreSQL, which
    defaults to NULLS FIRST and which this codebase also supports — but the
    suite runs on SQLite, so that behaviour is unverified by automated tests
    and rests on the dialect docs. Noted rather than left as a false
    guarantee.
    """
    printer = await printer_factory()
    dated = await archive_factory(
        printer_id=printer.id,
        print_name="Dated",
        completed_at=datetime.now() - timedelta(hours=1),
    )
    await archive_factory(printer_id=printer.id, print_name="No timestamp", completed_at=None)

    resp = await async_client.get(f"/api/v1/floor/printers/BBP-{printer.id}/info")

    assert resp.json()["last_print"]["archive_id"] == dated.id
