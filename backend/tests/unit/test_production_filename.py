"""Unit tests for production file-slot filename parsing and version helpers."""

from backend.app.services.production_filename import (
    ParsedProductionFilename,
    format_production_filename,
    is_newer,
    normalize_production_printer,
    normalize_production_printer_code,
    parse_production_filename,
    suggest_next_revision,
    version_tuple,
)


class TestParseProductionFilename:
    def test_omitted_quantity_is_one(self):
        parsed = parse_production_filename("TOP - 1.13.2 - X1C")
        assert parsed == ParsedProductionFilename(
            code="TOP",
            quantity=1,
            major=1,
            revision=13,
            minor=2,
            printer="X1C",
        )

    def test_explicit_quantity(self):
        parsed = parse_production_filename("TOP x2 - 1.13.2 - X1C")
        assert parsed is not None
        assert parsed.code == "TOP"
        assert parsed.quantity == 2
        assert parsed.version_tuple == (1, 13, 2)
        assert parsed.printer == "X1C"

    def test_a1_mini_alias_maps_to_a1m(self):
        parsed = parse_production_filename("TOP - 1.13.2 - A1 Mini")
        assert parsed is not None
        assert parsed.printer == "A1M"

    def test_strips_3mf_and_gcode_3mf_extensions(self):
        assert parse_production_filename("TOP - 1.13.2 - X1C.3mf") is not None
        parsed = parse_production_filename("TOP x2 - 1.13.2 - X1C.gcode.3mf")
        assert parsed is not None
        assert parsed.quantity == 2
        assert parsed.printer == "X1C"

    def test_uppercases_code(self):
        parsed = parse_production_filename("top - 1.13.2 - X1C")
        assert parsed is not None
        assert parsed.code == "TOP"

    def test_rejects_missing_printer_suffix(self):
        assert parse_production_filename("TOP - 1.13.2") is None
        assert parse_production_filename("TOP x2 - 1.13.2") is None
        assert parse_production_filename("TOP - 1.13.2 -") is None

    def test_format_round_trip_omits_x1(self):
        parsed = parse_production_filename("TOP - 1.13.2 - X1C")
        assert parsed is not None
        assert (
            format_production_filename(
                parsed.code,
                parsed.quantity,
                parsed.major,
                parsed.revision,
                parsed.minor,
                parsed.printer,
            )
            == "TOP - 1.13.2 - X1C"
        )
        assert format_production_filename("TOP", 2, 1, 13, 2, "X1C") == "TOP x2 - 1.13.2 - X1C"


class TestNormalizeProductionPrinter:
    def test_a1_mini_and_a1m(self):
        assert normalize_production_printer("A1 Mini") == "A1M"
        assert normalize_production_printer("A1M") == "A1M"
        assert normalize_production_printer("Bambu Lab A1 Mini") == "A1M"

    def test_x1_carbon_alias(self):
        assert normalize_production_printer("X1 Carbon") == "X1C"
        assert normalize_production_printer("Bambu Lab X1 Carbon") == "X1C"
        assert normalize_production_printer("X1C") == "X1C"

    def test_folder_code_compacts_free_form(self):
        assert normalize_production_printer_code("A1 Mini") == "A1M"
        assert normalize_production_printer_code("p1s") == "P1S"
        assert normalize_production_printer_code("  ") == ""


class TestVersionHelpers:
    def test_suggest_next_revision_bumps_revision_and_resets_minor(self):
        assert suggest_next_revision(1, 13, 2) == (1, 14, 0)
        assert version_tuple(1, 13, 2) == (1, 13, 2)

    def test_is_newer(self):
        assert is_newer((1, 14, 0), (1, 13, 2)) is True
        assert is_newer((1, 13, 2), (1, 13, 2)) is False
        assert is_newer((1, 13, 1), (1, 13, 2)) is False
        parsed = parse_production_filename("TOP - 1.14.0 - X1C")
        current = parse_production_filename("TOP - 1.13.2 - X1C")
        assert parsed is not None and current is not None
        assert is_newer(parsed, current) is True
