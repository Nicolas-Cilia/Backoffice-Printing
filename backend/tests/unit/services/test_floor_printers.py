"""Unit tests for printer payload identity (docs/floor-plan.md §4, §5.6).

The payload assertions are deliberately literal, for the same reason as the
station ones: a `BBP-` string is printed onto a QR that gets stuck to a
physical machine. Changing the format silently strands every label already on
the floor.
"""

from __future__ import annotations

import pytest

from backend.app.services.floor_printers import (
    PRINTER_PREFIX,
    printer_id_for_payload,
    printer_payload,
)


class TestPrinterPayload:
    def test_matches_the_documented_format(self):
        """Pins §4's `BBP-{printer_id}` example verbatim."""
        assert printer_payload(12) == "BBP-12"

    def test_carries_the_printer_prefix(self):
        assert printer_payload(1).startswith(PRINTER_PREFIX)

    def test_round_trips(self):
        for printer_id in (1, 7, 42, 1000):
            assert printer_id_for_payload(printer_payload(printer_id)) == printer_id


class TestPrinterLookup:
    def test_resolves_a_known_shape(self):
        assert printer_id_for_payload("BBP-12") == 12

    def test_tolerates_surrounding_whitespace(self):
        # A pistol's configured suffix can append whitespace; a stray space
        # must not turn a good label into an unknown code.
        assert printer_id_for_payload("  BBP-3 \n") == 3

    @pytest.mark.parametrize(
        "payload",
        [
            "",
            "BBP-",
            "BBP-abc",
            "BBP-12x",  # damaged scan, not printer 12
            "BBP--1",
            "BBP-0",  # ids are positive
            "BBP- 12",  # internal space is not a valid id
            "bbp-12",  # case matters — pistols emit verbatim
            "BBS-wip",  # station code
            "BBD-000042",  # part code
            "4001234567890",  # factory SKU
        ],
    )
    def test_rejects_non_printer_payloads(self, payload: str):
        # Guessing at a damaged code risks opening the wrong machine, which
        # would bind parts to the wrong job.
        assert printer_id_for_payload(payload) is None

    def test_does_not_confuse_a_prefix_appearing_mid_payload(self):
        assert printer_id_for_payload("XBBP-12") is None

    def test_large_ids_resolve(self):
        assert printer_id_for_payload("BBP-999999") == 999999
