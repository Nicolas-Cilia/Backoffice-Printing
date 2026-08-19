"""Unit tests for process-preset → printer short-code identity."""

from backend.app.services.profile_part_printer import (
    canonical_printer_code,
    extract_printer_tag,
    is_unknown_printer,
    printer_model_from_preset,
    unknown_printer_model,
)


def test_extract_bbl_short_code():
    assert extract_printer_tag("0.20mm Standard @BBL X1C") == "X1C"


def test_extract_bambu_lab_long_form():
    assert extract_printer_tag("0.28mm Standard @Bambu Lab A1 0.4 nozzle") == "A1"


def test_extract_a1_mini_token():
    assert extract_printer_tag("0.20mm Standard @BBL A1 Mini") == "A1 Mini"


def test_canonical_maps_a1m_to_a1_mini():
    assert canonical_printer_code("A1M") == "A1 Mini"
    assert canonical_printer_code("Bambu Lab X1 Carbon") == "X1C"


def test_name_tag_wins_over_compatible_printers():
    assert (
        printer_model_from_preset(
            name="0.20mm Standard @BBL X1C",
            compatible_printers='["Bambu Lab A1 0.4 nozzle"]',
            preset_id=9,
        )
        == "X1C"
    )


def test_compatible_printers_fallback():
    assert (
        printer_model_from_preset(
            name="Custom Process",
            compatible_printers='["Bambu Lab H2D 0.4 nozzle"]',
            preset_id=9,
        )
        == "H2D"
    )


def test_unknown_is_unique_per_preset():
    first = printer_model_from_preset(name="Mystery", compatible_printers=None, preset_id=3)
    second = printer_model_from_preset(name="Other", compatible_printers=None, preset_id=4)
    assert first == unknown_printer_model(3)
    assert second == unknown_printer_model(4)
    assert first != second
    assert is_unknown_printer(first)
    assert not is_unknown_printer("X1C")
