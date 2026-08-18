"""Unit tests for the production 3MF settings contract extract/diff."""

import io
import json
import zipfile

from backend.app.services.production_settings import (
    MULTI_COLOR_KEY,
    diff_parameters,
    extract_production_settings,
)


def _config(**overrides) -> dict:
    base = {
        "layer_height": "0.2",
        "initial_layer_line_width": "100%",
        "sparse_infill_density": "20%",
        "sparse_infill_pattern": "grid",
        "wall_loops": "3",
        "brim_type": "auto_brim",
        "brim_width": "5",
        "fuzzy_skin": "none",
        "fuzzy_skin_thickness": "0.3",
        "fuzzy_skin_point_distance": "0.8",
        "enable_support": "0",
        "support_type": "normal(auto)",
        "enable_prime_tower": "0",
        "seam_position": "aligned",
        "filament_settings_id": ["Bambu PLA Basic @BBL X1C"],
    }
    base.update(overrides)
    return base


def _3mf(
    config: dict | None,
    *,
    include_config: bool = True,
    slice_info_xml: str | None = None,
) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        if include_config and config is not None:
            zf.writestr("Metadata/project_settings.config", json.dumps(config))
        if slice_info_xml is not None:
            zf.writestr("Metadata/slice_info.config", slice_info_xml)
    return buffer.getvalue()


def _diff_by_key(locked: dict, incoming: dict) -> dict[str, dict]:
    return {row["key"]: row for row in diff_parameters(locked, incoming)}


_H2D_LEFT_SLICE = """<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <filament id="1" type="PLA" color="#FF0000" used_g="5.0" group_id="0"/>
  </plate>
</config>"""

_H2D_RIGHT_SLICE = """<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <filament id="1" type="PLA" color="#FF0000" used_g="5.0" group_id="1"/>
  </plate>
</config>"""

_H2D_BOTH_SLICE = """<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <filament id="1" type="PLA" color="#FF0000" used_g="5.0" group_id="0"/>
    <filament id="2" type="PLA" color="#00FF00" used_g="3.0" group_id="1"/>
  </plate>
</config>"""


def _h2d_config(**extra) -> dict:
    settings = {
        "physical_extruder_map": ["1", "0"],
        "filament_settings_id": ["Bambu PLA Basic @BBL H2D"],
    }
    settings.update(extra)
    return settings


class TestExtractProductionSettings:
    def test_extracts_infill_brim_fuzzy_skin_and_layer_height(self):
        contract = extract_production_settings(_3mf(_config()))

        assert contract["layer_height"] == 0.2
        assert contract["sparse_infill_density"] == 20
        assert contract["sparse_infill_pattern"] == "grid"
        assert contract["brim_type"] == "auto_brim"
        assert contract["brim_width"] == 5
        assert contract["fuzzy_skin"] == "none"
        assert contract["fuzzy_skin_thickness"] == 0.3
        assert contract["fuzzy_skin_point_distance"] == 0.8
        assert contract["wall_loops"] == 3
        assert contract["enable_support"] is False
        assert contract[MULTI_COLOR_KEY] is False
        assert "nozzles_used" not in contract

    def test_unwraps_list_values(self):
        contract = extract_production_settings(_3mf(_config(layer_height=["0.16"])))
        assert contract["layer_height"] == 0.16

    def test_h2d_left_right_both_from_nozzle_mapping(self):
        left = extract_production_settings(_3mf(_h2d_config(), slice_info_xml=_H2D_LEFT_SLICE))
        right = extract_production_settings(_3mf(_h2d_config(), slice_info_xml=_H2D_RIGHT_SLICE))
        both = extract_production_settings(
            _3mf(_h2d_config(filament_settings_id=["PLA", "PLA"]), slice_info_xml=_H2D_BOTH_SLICE)
        )

        # physical_extruder_map ["1","0"]: group 0 → MQTT 1 (left), group 1 → MQTT 0 (right)
        assert left["nozzles_used"] == "left"
        assert right["nozzles_used"] == "right"
        assert both["nozzles_used"] == "both"


class TestDiffParameters:
    def test_percent_infill_matches_numeric(self):
        locked = extract_production_settings(_3mf(_config(sparse_infill_density="20%")))
        incoming = extract_production_settings(_3mf(_config(sparse_infill_density=20)))
        row = _diff_by_key(locked, incoming)["sparse_infill_density"]
        assert row["match"] is True
        assert row["locked"] == 20
        assert row["incoming"] == 20

    def test_support_type_not_compared_when_supports_off(self):
        locked = extract_production_settings(_3mf(_config(enable_support="0", support_type="normal(auto)")))
        incoming = extract_production_settings(_3mf(_config(enable_support="0", support_type="tree(auto)")))
        by_key = _diff_by_key(locked, incoming)
        assert "support_type" not in by_key
        assert by_key["enable_support"]["match"] is True

    def test_support_type_compared_when_supports_on(self):
        locked = extract_production_settings(_3mf(_config(enable_support="1", support_type="normal(auto)")))
        incoming = extract_production_settings(_3mf(_config(enable_support=True, support_type="tree(auto)")))
        by_key = _diff_by_key(locked, incoming)
        assert by_key["enable_support"]["match"] is True
        assert by_key["support_type"]["match"] is False
        assert by_key["support_type"]["locked"] == "normal(auto)"
        assert by_key["support_type"]["incoming"] == "tree(auto)"

        matching = extract_production_settings(_3mf(_config(enable_support="1", support_type="normal(auto)")))
        assert _diff_by_key(locked, matching)["support_type"]["match"] is True

    def test_missing_key_is_mismatch(self):
        locked = extract_production_settings(_3mf(_config()))
        incoming = {k: v for k, v in locked.items() if k != "sparse_infill_density"}
        row = _diff_by_key(locked, incoming)["sparse_infill_density"]
        assert row["match"] is False
        assert row["locked"] == 20
        assert row["incoming"] is None

    def test_prime_tower_gated_for_single_color(self):
        locked = extract_production_settings(_3mf(_config(enable_prime_tower="0")))
        incoming = extract_production_settings(_3mf(_config(enable_prime_tower="1")))
        assert MULTI_COLOR_KEY in locked
        assert locked[MULTI_COLOR_KEY] is False
        assert "enable_prime_tower" not in _diff_by_key(locked, incoming)

    def test_prime_tower_compared_when_multi_color(self):
        locked = extract_production_settings(
            _3mf(_config(enable_prime_tower="1", filament_settings_id=["PLA Basic", "PLA Matte"]))
        )
        incoming = extract_production_settings(
            _3mf(_config(enable_prime_tower="0", filament_settings_id=["PLA Basic", "PLA Matte"]))
        )
        row = _diff_by_key(locked, incoming)["enable_prime_tower"]
        assert row["match"] is False
        assert row["locked"] is True
        assert row["incoming"] is False

    def test_nozzles_used_compared_for_dual_nozzle(self):
        locked = extract_production_settings(_3mf(_h2d_config(), slice_info_xml=_H2D_LEFT_SLICE))
        incoming = extract_production_settings(_3mf(_h2d_config(), slice_info_xml=_H2D_BOTH_SLICE))
        row = _diff_by_key(locked, incoming)["nozzles_used"]
        assert row["match"] is False
        assert row["locked"] == "left"
        assert row["incoming"] == "both"
