"""Filename sanitization for local preset download."""

from backend.app.api.routes.local_presets import _download_filename


def test_keeps_printable_name_and_adds_json():
    assert _download_filename("0.20mm Standard @BBL X1C") == "0.20mm Standard @BBL X1C.json"


def test_strips_path_and_reserved_characters():
    assert _download_filename("Foo/Bar:Baz<>.json") == "Foo_Bar_Baz.json"


def test_empty_name_falls_back_to_preset():
    assert _download_filename("") == "preset.json"
    assert _download_filename("...") == "preset.json"
