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
        "brim_object_gap": "0.1",
        "fuzzy_skin": "none",
        "fuzzy_skin_thickness": "0.3",
        "fuzzy_skin_point_distance": "0.8",
        "enable_support": "0",
        "support_type": "normal(auto)",
        "support_style": "default",
        "enable_prime_tower": "0",
        "seam_position": "aligned",
        "curr_bed_type": "Textured PEI Plate",
        "filament_settings_id": ["Bambu PLA Basic @BBL X1C"],
    }
    base.update(overrides)
    return base


def _3mf(
    config: dict | None,
    *,
    include_config: bool = True,
    slice_info_xml: str | None = None,
    extra_files: dict[str, str] | None = None,
) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        if include_config and config is not None:
            zf.writestr("Metadata/project_settings.config", json.dumps(config))
        if slice_info_xml is not None:
            zf.writestr("Metadata/slice_info.config", slice_info_xml)
        if extra_files:
            for path, content in extra_files.items():
                zf.writestr(path, content)
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
        assert contract["brim_object_gap"] == 0.1
        assert contract["fuzzy_skin"] == "none"
        assert contract["fuzzy_skin_thickness"] == 0.3
        assert contract["fuzzy_skin_point_distance"] == 0.8
        assert contract["wall_loops"] == 3
        assert contract["enable_support"] is False
        assert contract["support_style"] == "default"
        assert contract["curr_bed_type"] == "Textured PEI Plate"
        assert contract[MULTI_COLOR_KEY] is False
        assert "nozzles_used" not in contract

    def test_initial_layer_line_width_stays_mm_float(self):
        mm = extract_production_settings(_3mf(_config(initial_layer_line_width="0.42")))
        assert mm["initial_layer_line_width"] == 0.42

        with_unit = extract_production_settings(_3mf(_config(initial_layer_line_width="0.42mm")))
        assert with_unit["initial_layer_line_width"] == 0.42

        percent = extract_production_settings(_3mf(_config(initial_layer_line_width="105%")))
        assert percent["initial_layer_line_width"] == "105%"

    def test_fuzzy_skin_paint_from_triangle_attribute(self):
        painted = (
            '<?xml version="1.0"?>'
            '<model><resources><object id="1" type="model"><mesh>'
            "<triangles>"
            '<triangle v1="0" v2="1" v3="2" paint_fuzzy_skin="8"/>'
            "</triangles>"
            "</mesh></object></resources><build/></model>"
        )
        contract = extract_production_settings(
            _3mf(
                _config(fuzzy_skin="none"),
                extra_files={"3D/Objects/object_1.model": painted},
            )
        )
        assert contract["fuzzy_skin"] == "paint"
        assert contract["fuzzy_skin_thickness"] == 0.3
        assert contract["fuzzy_skin_point_distance"] == 0.8

    def test_fuzzy_skin_paint_from_prusa_slic3rpe_attribute(self):
        painted = (
            '<?xml version="1.0"?>'
            '<model><resources><object id="1" type="model"><mesh>'
            "<triangles>"
            '<triangle v1="0" v2="1" v3="2" slic3rpe:fuzzy_skin="1"/>'
            "</triangles>"
            "</mesh></object></resources><build/></model>"
        )
        contract = extract_production_settings(
            _3mf(
                _config(fuzzy_skin="none"),
                extra_files={"3D/Objects/object_1.model": painted},
            )
        )
        assert contract["fuzzy_skin"] == "paint"

    def test_fuzzy_skin_none_without_paint_stays_none(self):
        mesh = (
            '<?xml version="1.0"?>'
            '<model><resources><object id="1" type="model"><mesh>'
            "<triangles>"
            '<triangle v1="0" v2="1" v3="2"/>'
            "</triangles>"
            "</mesh></object></resources><build/></model>"
        )
        contract = extract_production_settings(
            _3mf(_config(fuzzy_skin="none"), extra_files={"3D/Objects/object_1.model": mesh})
        )
        assert contract["fuzzy_skin"] == "none"

    def test_fuzzy_skin_disabled_not_upgraded_by_paint(self):
        painted = (
            '<?xml version="1.0"?>'
            '<model><resources><object id="1" type="model"><mesh>'
            "<triangles>"
            '<triangle v1="0" v2="1" v3="2" paint_fuzzy_skin="8"/>'
            "</triangles>"
            "</mesh></object></resources><build/></model>"
        )
        contract = extract_production_settings(
            _3mf(
                _config(fuzzy_skin="disabled_fuzzy"),
                extra_files={"3D/Objects/object_1.model": painted},
            )
        )
        assert contract["fuzzy_skin"] == "disabled_fuzzy"

    def test_fuzzy_skin_painted_token_normalizes_to_paint(self):
        contract = extract_production_settings(_3mf(_config(fuzzy_skin="painted")))
        assert contract["fuzzy_skin"] == "paint"

    def test_fuzzy_skin_paint_from_single_quoted_attr_outside_model(self):
        xml = '<triangle v1="0" v2="1" v3="2" paint_fuzzy_skin=\'8F\'/>'
        contract = extract_production_settings(
            _3mf(_config(fuzzy_skin="none"), extra_files={"Metadata/model_settings.config": xml})
        )
        assert contract["fuzzy_skin"] == "paint"

    def test_sliced_smooth_gcode_stays_allow_paint(self):
        gcode = "G1 Z1.0\n"
        for _ in range(3):
            gcode += "; FEATURE: Outer wall\n"
            x = 0.0
            for _pt in range(50):
                x += 2.0
                gcode += f"G1 X{x:.3f} Y0.000 E0.02\n"
            gcode += "; FEATURE: Inner wall\n"
        contract = extract_production_settings(
            _3mf(_config(fuzzy_skin="none"), extra_files={"Metadata/plate_1.gcode": gcode})
        )
        assert contract["fuzzy_skin"] == "none"

    def test_sliced_jagged_gcode_detects_paint(self):
        gcode = "G1 Z1.0\n"
        for _ in range(3):
            gcode += "; FEATURE: Outer wall\n"
            x = 0.0
            y = 0.0
            for i in range(50):
                x += 0.3
                y += 0.12 if i % 2 == 0 else -0.12
                gcode += f"G1 X{x:.3f} Y{y:.3f} E0.02\n"
            gcode += "; FEATURE: Inner wall\n"
        contract = extract_production_settings(
            _3mf(
                _config(fuzzy_skin="none", fuzzy_skin_point_distance="0.3"),
                extra_files={"Metadata/plate_1.gcode": gcode},
            )
        )
        assert contract["fuzzy_skin"] == "paint"

    def test_one_jagged_outer_wall_is_not_enough(self):
        gcode = "G1 Z1.0\n; FEATURE: Outer wall\n"
        x = y = 0.0
        for i in range(50):
            x += 0.3
            y += 0.12 if i % 2 == 0 else -0.12
            gcode += f"G1 X{x:.3f} Y{y:.3f} E0.02\n"
        gcode += "; FEATURE: Inner wall\n"
        contract = extract_production_settings(
            _3mf(_config(fuzzy_skin="none"), extra_files={"Metadata/plate_1.gcode": gcode})
        )
        assert contract["fuzzy_skin"] == "none"

    def test_sliced_customized_fuzzy_settings_stay_none_without_mesh_paint(self):
        config = _config(
            fuzzy_skin="none",
            different_settings_to_system=[
                "brim_type;fuzzy_skin_point_distance;fuzzy_skin_thickness;wall_loops"
            ],
        )
        contract = extract_production_settings(
            _3mf(config, extra_files={"Metadata/plate_1.gcode": "; fuzzy_skin = none\n"})
        )
        assert contract["fuzzy_skin"] == "none"
        assert contract["fuzzy_skin_thickness"] == 0.3

    def test_unsliced_customized_fuzzy_settings_stay_none_without_paint(self):
        config = _config(
            fuzzy_skin="none",
            different_settings_to_system=["fuzzy_skin_thickness;fuzzy_skin_point_distance"],
        )
        contract = extract_production_settings(_3mf(config))
        assert contract["fuzzy_skin"] == "none"

    def test_disabled_fuzzy_not_upgraded_by_sliced_settings(self):
        config = _config(
            fuzzy_skin="disabled_fuzzy",
            different_settings_to_system=["fuzzy_skin_thickness;fuzzy_skin_point_distance"],
        )
        contract = extract_production_settings(
            _3mf(config, extra_files={"Metadata/plate_1.gcode": "G1 X0 Y0\n"})
        )
        assert contract["fuzzy_skin"] == "disabled_fuzzy"

    def test_fuzzy_skin_paint_from_utf16_model(self):
        xml = (
            '<?xml version="1.0"?>'
            '<model><triangles>'
            '<triangle v1="0" v2="1" v3="2" paint_fuzzy_skin="8"/>'
            "</triangles></model>"
        )
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zf:
            zf.writestr("3D/3dmodel.model", "<model/>")
            zf.writestr("Metadata/project_settings.config", json.dumps(_config(fuzzy_skin="none")))
            zf.writestr("3D/Objects/object_1.model", xml.encode("utf-16-le"))
        contract = extract_production_settings(buffer.getvalue())
        assert contract["fuzzy_skin"] == "paint"

    def test_zigzag_infill_normalizes_to_rectilinear(self):
        contract = extract_production_settings(_3mf(_config(sparse_infill_pattern="zig-zag")))
        assert contract["sparse_infill_pattern"] == "rectilinear"

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

    def test_extracts_curr_bed_type_and_falls_back_to_bed_type(self):
        present = extract_production_settings(_3mf(_config(curr_bed_type="Smooth PEI Plate")))
        assert present["curr_bed_type"] == "Smooth PEI Plate"

        fallback_config = _config(bed_type="Engineering Plate")
        fallback_config.pop("curr_bed_type", None)
        fallback = extract_production_settings(_3mf(fallback_config))
        assert fallback["curr_bed_type"] == "Engineering Plate"

        preferred = extract_production_settings(
            _3mf(_config(curr_bed_type="Textured PEI Plate", bed_type="Cool Plate"))
        )
        assert preferred["curr_bed_type"] == "Textured PEI Plate"

    def test_normalizes_bed_type_aliases_and_omits_missing(self):
        short = extract_production_settings(_3mf(_config(curr_bed_type="Smooth PEI")))
        assert short["curr_bed_type"] == "Smooth PEI Plate"

        enum_name = extract_production_settings(_3mf(_config(curr_bed_type="textured_pei")))
        assert enum_name["curr_bed_type"] == "Textured PEI Plate"

        missing_config = _config()
        missing_config.pop("curr_bed_type", None)
        missing = extract_production_settings(_3mf(missing_config))
        assert "curr_bed_type" not in missing

        empty = extract_production_settings(_3mf(_config(curr_bed_type="  ")))
        assert "curr_bed_type" not in empty


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

    def test_extracts_support_style_and_falls_back_to_tree_support_style(self):
        present = extract_production_settings(_3mf(_config(support_style="tree_slim")))
        assert present["support_style"] == "tree_slim"

        fallback_config = _config(tree_support_style="tree_hybrid")
        fallback_config.pop("support_style", None)
        fallback = extract_production_settings(_3mf(fallback_config))
        assert fallback["support_style"] == "tree_hybrid"

        preferred = extract_production_settings(
            _3mf(_config(support_style="tree_slim", tree_support_style="organic"))
        )
        assert preferred["support_style"] == "tree_slim"

    def test_support_style_not_compared_when_supports_off(self):
        locked = extract_production_settings(
            _3mf(_config(enable_support="0", support_style="tree_slim"))
        )
        incoming = extract_production_settings(
            _3mf(_config(enable_support="0", support_style="tree_hybrid"))
        )
        by_key = _diff_by_key(locked, incoming)
        assert "support_style" not in by_key
        assert "support_type" not in by_key

    def test_support_style_compared_when_supports_on(self):
        locked = extract_production_settings(
            _3mf(_config(enable_support="1", support_style="tree_slim"))
        )
        incoming = extract_production_settings(
            _3mf(_config(enable_support=True, support_style="tree_hybrid"))
        )
        by_key = _diff_by_key(locked, incoming)
        assert by_key["support_style"]["match"] is False
        assert by_key["support_style"]["locked"] == "tree_slim"
        assert by_key["support_style"]["incoming"] == "tree_hybrid"

        matching = extract_production_settings(
            _3mf(_config(enable_support="1", support_style="tree_slim"))
        )
        assert _diff_by_key(locked, matching)["support_style"]["match"] is True

    def test_brim_object_gap_not_compared_when_brim_off(self):
        locked = extract_production_settings(
            _3mf(_config(brim_type="no_brim", brim_object_gap="0.1"))
        )
        incoming = extract_production_settings(
            _3mf(_config(brim_type="no_brim", brim_object_gap="0.5"))
        )
        by_key = _diff_by_key(locked, incoming)
        assert "brim_object_gap" not in by_key
        assert by_key["brim_type"]["match"] is True

    def test_brim_object_gap_compared_when_brim_on(self):
        locked = extract_production_settings(
            _3mf(_config(brim_type="auto_brim", brim_object_gap="0.1"))
        )
        incoming = extract_production_settings(
            _3mf(_config(brim_type="auto_brim", brim_object_gap="0.5"))
        )
        row = _diff_by_key(locked, incoming)["brim_object_gap"]
        assert row["match"] is False
        assert row["locked"] == 0.1
        assert row["incoming"] == 0.5

        matching = extract_production_settings(
            _3mf(_config(brim_type="outer_only", brim_object_gap="0.1"))
        )
        assert _diff_by_key(locked, matching)["brim_object_gap"]["match"] is True

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

    def test_bed_type_mismatch_when_plates_differ(self):
        locked = extract_production_settings(_3mf(_config(curr_bed_type="Textured PEI Plate")))
        incoming = extract_production_settings(_3mf(_config(curr_bed_type="Smooth PEI Plate")))
        row = _diff_by_key(locked, incoming)["curr_bed_type"]
        assert row["match"] is False
        assert row["locked"] == "Textured PEI Plate"
        assert row["incoming"] == "Smooth PEI Plate"

        alias_match = extract_production_settings(_3mf(_config(curr_bed_type="Smooth PEI")))
        assert _diff_by_key(incoming, alias_match)["curr_bed_type"]["match"] is True

    def test_missing_incoming_bed_type_is_mismatch(self):
        locked = extract_production_settings(_3mf(_config(curr_bed_type="Textured PEI Plate")))
        incoming_config = _config()
        incoming_config.pop("curr_bed_type", None)
        incoming = extract_production_settings(_3mf(incoming_config))
        row = _diff_by_key(locked, incoming)["curr_bed_type"]
        assert row["match"] is False
        assert row["locked"] == "Textured PEI Plate"
        assert row["incoming"] is None
