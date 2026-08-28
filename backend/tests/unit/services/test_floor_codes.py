"""Unit tests for the floor station catalog and code-label renderer.

The payload assertions here are deliberately literal. A ``BBS-`` string is
printed onto a QR that gets taped to a physical shelf — changing one silently
strands every label already on the floor, so the exact strings from
``docs/floor-plan.md`` §4 are pinned rather than derived.
"""

from __future__ import annotations

import re

import pytest

from backend.app.services.floor_codes import (
    FLOOR_STATIONS,
    MAX_LABEL_MM,
    MIN_LABEL_MM,
    STATION_PREFIX,
    CodeLabel,
    render_code_labels,
    station_for_payload,
)


def _page_count(pdf: bytes) -> int:
    """Count page objects in a reportlab PDF ("/Type /Pages" is the tree root,
    so the negative lookahead keeps it out of the count)."""
    return len(re.findall(rb"/Type\s*/Page[^s]", pdf))


class TestStationCatalog:
    def test_payloads_match_the_documented_strings(self):
        """Pins §4's payload table. If a slug must change, the labels already
        on the floor have to be reprinted — that should be a deliberate edit
        to this test, never an incidental refactor."""
        assert {s.payload for s in FLOOR_STATIONS} == {
            "BBS-harvest",
            "BBS-initial-qc-pass",
            "BBS-rework",
            "BBS-ready-for-production-inventory",
            "BBS-production-wip",
            "BBS-bin-empty",
            "BBS-support-removal",
            "BBS-overhang-removal",
            "BBS-hot-air-removal",
        }

    def test_every_station_carries_the_station_prefix(self):
        assert all(s.payload.startswith(STATION_PREFIX) for s in FLOOR_STATIONS)

    def test_slugs_and_names_are_unique(self):
        assert len({s.slug for s in FLOOR_STATIONS}) == len(FLOOR_STATIONS)
        assert len({s.name for s in FLOOR_STATIONS}) == len(FLOOR_STATIONS)

    def test_all_current_floor_codes_are_present(self):
        assert len(FLOOR_STATIONS) == 9

    def test_fit_check_and_rework_carry_no_floor_wide_lock(self):
        """Parallel fit-check and rework benches on separate machines are
        normal work for both."""
        by_slug = {s.slug: s for s in FLOOR_STATIONS}
        assert by_slug["fit-check"].exclusive is False
        assert by_slug["rework"].exclusive is False

    def test_category_splits_locations_from_stations(self):
        """§3.3: item→location destinations print under the Codes page's
        Locations tab, session stations under Station labels."""
        by_slug = {s.slug: s for s in FLOOR_STATIONS}
        assert {s.slug for s in FLOOR_STATIONS if s.category == "location"} == {
            "fit-check",
            "rework",
            "ready-for-production-inventory",
            "production-wip",
            "bin-empty",
            "support-removal",
            "overhang-removal",
            "hot-air-removal",
        }
        assert by_slug["harvest"].category == "station"
        # Filament WIP / + Storage / Move stay out of the catalog until their
        # SKU-move flows ship.
        for slug in ("wip", "storage-receive", "storage-move"):
            assert slug not in by_slug

    def test_item_location_destinations_carry_no_floor_wide_lock(self):
        """None of the item→location destinations is a session — parallel
        benches are normal work, so none takes the floor-wide lock."""
        by_slug = {s.slug: s for s in FLOOR_STATIONS}
        for slug in (
            "ready-for-production-inventory",
            "production-wip",
            "bin-empty",
            "support-removal",
            "overhang-removal",
            "hot-air-removal",
        ):
            assert by_slug[slug].exclusive is False
            assert by_slug[slug].category == "location"


class TestStationLookup:
    def test_resolves_a_known_payload(self):
        station = station_for_payload("BBS-harvest")
        assert station is not None
        assert station.name == "Harvest"

    def test_resolves_the_legacy_fit_check_payload(self):
        station = station_for_payload("BBS-fit-check")
        assert station is not None
        assert station.name == "Initial QC Pass"

    def test_tolerates_surrounding_whitespace(self):
        """A pistol can emit a trailing character depending on its suffix
        configuration; a stray space must not read as an unknown code."""
        assert station_for_payload("  BBS-harvest \n") is not None

    @pytest.mark.parametrize(
        "payload",
        [
            "",
            "BBS-",
            "BBS-nope",
            "BBP-12",  # printer code, not a station
            "bbs-wip",  # case matters — pistols emit verbatim
            "BBS-wip-extra",
        ],
    )
    def test_rejects_non_station_payloads(self, payload: str):
        assert station_for_payload(payload) is None


class TestRenderCodeLabels:
    def test_renders_one_page_per_label(self):
        labels = [CodeLabel(payload=s.payload, title=s.name) for s in FLOOR_STATIONS]
        pdf = render_code_labels(labels, width_mm=60, height_mm=60)

        assert pdf.startswith(b"%PDF-")
        assert _page_count(pdf) == len(labels)

    def test_embeds_an_image_for_the_qr(self):
        pdf = render_code_labels([CodeLabel(payload="BBS-wip", title="WIP")], width_mm=60, height_mm=60)
        assert b"/Image" in pdf

    @pytest.mark.parametrize(
        ("width", "height"),
        [
            (MIN_LABEL_MM, MIN_LABEL_MM),  # smallest allowed
            (40, 40),  # documented presets (§3.3)
            (60, 60),
            (80, 80),
            (80, 40),  # wide: QR is height-constrained
            (40, 80),  # tall: QR is width-constrained
            (MAX_LABEL_MM, MAX_LABEL_MM),  # largest allowed
        ],
    )
    def test_renders_across_the_supported_size_range(self, width: float, height: float):
        """Layout is computed from the label's own dimensions, so every size
        in range must produce a real PDF rather than only the tuned one."""
        pdf = render_code_labels([CodeLabel(payload="BBS-wip", title="WIP")], width_mm=width, height_mm=height)
        assert pdf.startswith(b"%PDF-")
        assert _page_count(pdf) == 1

    @pytest.mark.parametrize(
        ("width", "height"),
        [
            (MIN_LABEL_MM - 1, 60),
            (60, MIN_LABEL_MM - 1),
            (MAX_LABEL_MM + 1, 60),
            (60, MAX_LABEL_MM + 1),
            (0, 0),
            (-10, 60),
        ],
    )
    def test_rejects_sizes_outside_the_supported_range(self, width: float, height: float):
        """Too small and the QR stops being scannable; the route turns this
        into a 400 rather than shipping an unusable label."""
        with pytest.raises(ValueError):
            render_code_labels([CodeLabel(payload="BBS-wip", title="WIP")], width_mm=width, height_mm=height)

    def test_empty_label_list_still_produces_a_valid_pdf(self):
        pdf = render_code_labels([], width_mm=60, height_mm=60)
        assert pdf.startswith(b"%PDF-")
        assert _page_count(pdf) == 0

    def test_long_title_does_not_raise(self):
        """Titles are truncated to the label width rather than overflowing."""
        pdf = render_code_labels(
            [CodeLabel(payload="BBS-wip", title="A" * 200)],
            width_mm=40,
            height_mm=40,
        )
        assert pdf.startswith(b"%PDF-")
