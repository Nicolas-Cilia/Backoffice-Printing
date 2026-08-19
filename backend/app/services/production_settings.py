"""Extract and diff the locked production print-settings contract from a 3MF or process preset."""

from __future__ import annotations

import json
import math
import re
import zipfile
from io import BytesIO
from typing import Any

import defusedxml.ElementTree as ET

from backend.app.utils.threemf_tools import extract_nozzle_mapping_from_3mf

_PROJECT_SETTINGS = "Metadata/project_settings.config"
_SLICE_INFO = "Metadata/slice_info.config"

# MQTT extruder IDs from extract_nozzle_mapping_from_3mf: 0 = right, 1 = left.
_EXTRUDER_RIGHT = 0
_EXTRUDER_LEFT = 1

MM_EPSILON = 1e-4

# Max printable layer height (mm) for printers that cannot reach a thicker
# section spec. Short codes match PRINTER_MODEL_MAP / profile_part_printer.
# H2D Pro shares the H2D motion stack; H2C is not included.
LAYER_HEIGHT_CAPS: dict[str, float] = {
    "H2D": 0.24,
    "H2D Pro": 0.24,
    "H2S": 0.24,
}

# Stored on the contract for gated comparison; never emitted by diff_parameters.
MULTI_COLOR_KEY = "_multi_color"

# support_style: Bambu/Orca tree *style* (`tree_slim`, `tree_hybrid`, `organic`, …),
# distinct from support_type (`tree(auto)`, `normal(auto)`, …). Some 3MFs store
# the same value on tree_support_style; extract normalizes to support_style.
# curr_bed_type: Bambu process key (sometimes `bed_type`); omitted when absent.
CONTRACT_KEYS: tuple[str, ...] = (
    "curr_bed_type",
    "layer_height",
    "initial_layer_line_width",
    "sparse_infill_density",
    "sparse_infill_pattern",
    "wall_loops",
    "brim_type",
    "brim_width",
    "brim_object_gap",
    "fuzzy_skin",
    "fuzzy_skin_thickness",
    "fuzzy_skin_point_distance",
    "enable_support",
    "support_type",
    "support_style",
    "enable_prime_tower",
    "seam_position",
    "nozzles_used",
)

BOOL_KEYS = frozenset({"enable_support", "enable_prime_tower"})
MM_KEYS = frozenset(
    {
        "layer_height",
        "initial_layer_line_width",
        "brim_width",
        "brim_object_gap",
        "fuzzy_skin_thickness",
        "fuzzy_skin_point_distance",
    }
)
STRING_KEYS = frozenset(
    {
        "curr_bed_type",
        "sparse_infill_pattern",
        "brim_type",
        "fuzzy_skin",
        "support_type",
        "support_style",
        "seam_position",
        "nozzles_used",
    }
)
_SUPPORT_DETAIL_KEYS = frozenset({"support_type", "support_style"})
_BRIM_OFF = frozenset({"no_brim", "none", "off"})
# Process `none` is Bambu's "None (allow paint)". True off is `disabled_fuzzy`.
_FUZZY_SKIN_OFF = frozenset({"none", "off", "0", "false", ""})
_FUZZY_SKIN_PAINT_TOKENS = frozenset({"paint", "painted", "selected", "fuzzy_skin_paint", "paint_only"})
# Bambu/Orca bbs_3mf writes paint_fuzzy_skin="…" on triangles (see bbs_3mf.cpp
# CUSTOM_FUZZY_SKIN_ATTR). Prusa-style 3MF uses slic3rpe:fuzzy_skin. Sliced
# .gcode.3mf files drop the mesh, so paint cannot be inferred from process
# settings — thickness/distance are profile values, painted or not.
_PAINT_FUZZY_SKIN_ATTR_RE = re.compile(
    rb'(?:paint_fuzzy_skin|slic3rpe:fuzzy_skin)\s*=\s*(?:"[^"]+"|\'[^\']+\')',
    re.IGNORECASE,
)
_PAINT_FUZZY_SKIN_UTF16LE = "paint_fuzzy_skin".encode("utf-16-le")
_PAINT_FUZZY_SKIN_UTF16BE = "paint_fuzzy_skin".encode("utf-16-be")
_SKIP_PAINT_SCAN_SUFFIXES = (".gcode", ".png", ".jpg", ".jpeg", ".webp", ".md5")
_PAINT_SCAN_MAX_BYTES = 2_000_000
# Sliced .gcode.3mf paint is baked into outer-wall motion: ~point_distance hops
# with high turning angles. Process settings are identical for allow-paint.
_FUZZY_GCODE_MIN_POINTS = 40
_FUZZY_GCODE_MIN_WALLS = 3
_FUZZY_GCODE_BAND_MIN = 0.45
_FUZZY_GCODE_JAGGED_MIN = 0.45
_FUZZY_GCODE_TURN_RAD = 0.35  # ~20°
_GCODE_XY_RE = re.compile(rb"X(-?\d+(?:\.\d+)?).*Y(-?\d+(?:\.\d+)?)")
_GCODE_Z_RE = re.compile(rb"Z(-?\d+(?:\.\d+)?)")

# Bambu UI "Rectilinear" is stored as zigzag in older Prusa-descended configs.
_INFILL_PATTERN_ALIASES = {
    "zigzag": "rectilinear",
}

# Canonical BambuStudio / OrcaSlicer curr_bed_type strings. Compact keys are
# alphanumeric lowercased so "Smooth PEI", "smooth_pei", and "Smooth PEI Plate"
# collapse to the same plate. Unknown values are kept as-is (never invented).
_BED_TYPE_ALIASES = {
    "texturedpeiplate": "Textured PEI Plate",
    "texturedpei": "Textured PEI Plate",
    "btpte": "Textured PEI Plate",
    "smoothpeiplate": "Smooth PEI Plate",
    "smoothpei": "Smooth PEI Plate",
    "btpeismooth": "Smooth PEI Plate",
    "coolplate": "Cool Plate",
    "pcplate": "Cool Plate",
    "btpc": "Cool Plate",
    "coolplatesupertack": "Cool Plate (SuperTack)",
    "supertackplate": "Cool Plate (SuperTack)",
    "bambucoolplatesupertack": "Cool Plate (SuperTack)",
    "supertack": "Cool Plate (SuperTack)",
    "btsupertack": "Cool Plate (SuperTack)",
    "engineeringplate": "Engineering Plate",
    "btep": "Engineering Plate",
    "hightempplate": "High Temp Plate",
    "hotplate": "High Temp Plate",
    "btpei": "High Temp Plate",
}


def extract_from_process_settings(config: Any) -> dict[str, Any]:
    """Read the production contract from a resolved process-preset dict.

    Reuses the same :data:`CONTRACT_KEYS` loop as a 3MF extract. Skips zip-only
    inference (mesh/G-code fuzzy-skin paint, 3MF nozzle mapping, slice_info
    multi-color). ``filament_settings_id`` still sets :data:`MULTI_COLOR_KEY`
    when it is a list.
    """
    if not isinstance(config, dict) or not config:
        return {}
    contract = _contract_from_config(config)
    filaments = config.get("filament_settings_id")
    if isinstance(filaments, list):
        contract[MULTI_COLOR_KEY] = len(filaments) > 1
    return contract


def extract_production_settings(source: bytes | zipfile.ZipFile) -> dict[str, Any]:
    """Read the production contract from a 3MF (bytes or an open ZipFile).

    Values are normalized to JSON-serializable forms. ``nozzles_used`` is
    derived from dual-nozzle mapping when present. Gating metadata is stored
    under :data:`MULTI_COLOR_KEY`.
    """
    if isinstance(source, zipfile.ZipFile):
        return _extract_from_zip(source)
    try:
        with zipfile.ZipFile(BytesIO(source), "r") as zf:
            return _extract_from_zip(zf)
    except (zipfile.BadZipFile, OSError, ValueError):
        return {}


def diff_parameters(
    locked: dict,
    incoming: dict,
    *,
    printer_model: str | None = None,
) -> list[dict[str, Any]]:
    """Compare two contract dicts.

    Returns ``{key, locked, incoming, match}`` for each applicable contract key.
    Gated keys (``support_type`` / ``support_style`` with supports off,
    ``brim_object_gap`` with brim off, ``enable_prime_tower`` on
    single-color files, ``nozzles_used`` without a dual-nozzle mapping) are
    omitted. A key present on the locked contract but missing on incoming is a
    mismatch.

    ``printer_model`` is optional so File Manager production diffs stay
    unchanged. When it is a :data:`LAYER_HEIGHT_CAPS` printer, ``layer_height``
    also matches if the locked spec is thicker than that printer's cap and
    incoming is at the cap (the printer's equivalent of the spec).
    """
    locked = locked or {}
    incoming = incoming or {}
    rows: list[dict[str, Any]] = []
    for key in CONTRACT_KEYS:
        if not _is_comparable(key, locked, incoming):
            continue
        locked_has = key in locked and locked[key] is not None
        incoming_has = key in incoming and incoming[key] is not None
        if not locked_has and not incoming_has:
            continue
        locked_value = locked.get(key) if locked_has else None
        incoming_value = incoming.get(key) if incoming_has else None
        match = locked_has and incoming_has and _values_match(key, locked_value, incoming_value)
        if (
            not match
            and key == "layer_height"
            and locked_has
            and incoming_has
            and _layer_height_matches_printer_cap(locked_value, incoming_value, printer_model)
        ):
            match = True
        rows.append(
            {
                "key": key,
                "locked": locked_value,
                "incoming": incoming_value,
                "match": match,
            }
        )
    return rows


def _layer_height_matches_printer_cap(
    locked: Any,
    incoming: Any,
    printer_model: str | None,
) -> bool:
    """True when incoming is at a capped printer's max and the spec is thicker."""
    if not printer_model:
        return False
    cap = LAYER_HEIGHT_CAPS.get(printer_model)
    if cap is None:
        return False
    locked_number = _as_number(locked)
    incoming_number = _as_number(incoming)
    if locked_number is None or incoming_number is None:
        return False
    locked_mm = float(locked_number)
    incoming_mm = float(incoming_number)
    return locked_mm > cap + MM_EPSILON and abs(incoming_mm - cap) <= MM_EPSILON


def _contract_from_config(config: dict[str, Any]) -> dict[str, Any]:
    """Normalize CONTRACT_KEYS present on a process/project settings dict.

    ``nozzles_used`` is zip-only (3MF nozzle mapping) and is skipped here.
    """
    contract: dict[str, Any] = {}
    for key in CONTRACT_KEYS:
        if key == "nozzles_used":
            continue
        present, raw = _contract_source_value(key, config)
        if not present:
            continue
        normalized = _normalize_value(key, raw)
        if key == "curr_bed_type" and not normalized:
            continue
        contract[key] = normalized
    return contract


def _extract_from_zip(zf: zipfile.ZipFile) -> dict[str, Any]:
    config = _read_project_settings(zf)
    if not config:
        return {}

    contract = _contract_from_config(config)

    mapping = extract_nozzle_mapping_from_3mf(zf)
    if mapping:
        nozzles = _nozzles_used_from_mapping(mapping)
        if nozzles:
            contract["nozzles_used"] = nozzles

    _apply_fuzzy_skin_paint(zf, contract)
    contract[MULTI_COLOR_KEY] = _is_multi_color_file(zf, config)
    return contract


def _read_project_settings(zf: zipfile.ZipFile) -> dict[str, Any]:
    try:
        if _PROJECT_SETTINGS not in zf.namelist():
            return {}
        data = json.loads(zf.read(_PROJECT_SETTINGS).decode("utf-8"))
    except (KeyError, ValueError, OSError, UnicodeDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _is_multi_color_file(zf: zipfile.ZipFile, config: dict[str, Any]) -> bool:
    used = _count_slice_info_filaments(zf)
    if used is not None:
        return used > 1
    filaments = config.get("filament_settings_id")
    if isinstance(filaments, list):
        return len(filaments) > 1
    return False


def _count_slice_info_filaments(zf: zipfile.ZipFile) -> int | None:
    try:
        if _SLICE_INFO not in zf.namelist():
            return None
        root = ET.fromstring(zf.read(_SLICE_INFO).decode("utf-8"))
    except (KeyError, OSError, UnicodeDecodeError, ET.ParseError, ValueError):
        return None

    counted = 0
    saw_filament = False
    for filament_elem in root.findall(".//filament"):
        saw_filament = True
        used_g = filament_elem.get("used_g")
        if used_g is not None:
            try:
                if float(used_g) > 0:
                    counted += 1
            except (TypeError, ValueError):
                counted += 1
        else:
            counted += 1
    if not saw_filament:
        return None
    return counted


def _nozzles_used_from_mapping(mapping: dict[int, int]) -> str | None:
    unique = {int(extruder) for extruder in mapping.values()}
    has_left = _EXTRUDER_LEFT in unique
    has_right = _EXTRUDER_RIGHT in unique
    if has_left and has_right:
        return "both"
    if has_left:
        return "left"
    if has_right:
        return "right"
    return None


def _unwrap(value: Any) -> Any:
    if isinstance(value, list):
        return _unwrap(value[0]) if value else None
    return value


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _as_number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if text.endswith("%"):
            text = text[:-1].strip()
        elif text.lower().endswith("mm"):
            text = text[:-2].strip()
        try:
            number = float(text)
        except ValueError:
            return None
    else:
        return None
    if number.is_integer():
        return int(number)
    return number


def _normalize_line_width(value: Any) -> Any:
    """Keep `%` literals as strings; parse mm floats (including a `mm` suffix)."""
    if isinstance(value, str):
        text = value.strip()
        if text.endswith("%"):
            return text
        number = _as_number(text)
        if number is not None:
            return number
        return text
    number = _as_number(value)
    if number is not None:
        return number
    return value


def _fuzzy_skin_token(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip().lower().replace("-", "_").replace(" ", "_")


def _normalize_fuzzy_skin(value: Any) -> str:
    text = str(value).strip()
    token = _fuzzy_skin_token(text)
    if token in _FUZZY_SKIN_PAINT_TOKENS:
        return "paint"
    return text


def _normalize_infill_pattern(value: Any) -> str:
    text = str(value).strip()
    compact = "".join(ch for ch in text.lower() if ch.isalnum())
    return _INFILL_PATTERN_ALIASES.get(compact, text)


def _normalize_bed_type(value: Any) -> str | None:
    text = str(value).strip()
    if not text:
        return None
    compact = "".join(ch for ch in text.lower() if ch.isalnum())
    return _BED_TYPE_ALIASES.get(compact, text)


def _bytes_look_like_fuzzy_paint(data: bytes) -> bool:
    if _PAINT_FUZZY_SKIN_ATTR_RE.search(data):
        return True
    if _PAINT_FUZZY_SKIN_UTF16LE in data or _PAINT_FUZZY_SKIN_UTF16BE in data:
        return True
    # UTF-16 with NULs stripped still has to be an assignment with a value,
    # not the process key fuzzy_skin = none in project_settings.
    stripped = data.replace(b"\x00", b"")
    return stripped is not data and _PAINT_FUZZY_SKIN_ATTR_RE.search(stripped) is not None


def _should_scan_member_for_paint(name: str, info: zipfile.ZipInfo) -> bool:
    lower = name.lower()
    if lower.endswith(_SKIP_PAINT_SCAN_SUFFIXES):
        return False
    if info.file_size > _PAINT_SCAN_MAX_BYTES and not lower.endswith(".model"):
        return False
    return True


def _has_fuzzy_skin_paint(zf: zipfile.ZipFile) -> bool:
    """True if any archive member carries Bambu/Prusa fuzzy-skin paint data."""
    for name in zf.namelist():
        try:
            info = zf.getinfo(name)
        except KeyError:
            continue
        if not _should_scan_member_for_paint(name, info):
            continue
        try:
            data = zf.read(name)
        except OSError:
            continue
        if _bytes_look_like_fuzzy_paint(data):
            return True
    return False


def _as_positive_float(value: Any, default: float) -> float:
    number = _as_number(value)
    if number is None:
        return default
    magnitude = abs(float(number))
    return magnitude if magnitude > 0 else default


def _outer_wall_is_fuzzy(points: list[tuple[float, float]], point_distance: float) -> bool:
    if len(points) < _FUZZY_GCODE_MIN_POINTS:
        return False
    dists = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:])]
    if not dists:
        return False
    lo = 0.6 * point_distance
    hi = 1.5 * point_distance
    band = sum(1 for dist in dists if lo <= dist <= hi) / len(dists)
    turns: list[float] = []
    for a, b, c in zip(points, points[1:], points[2:]):
        v1 = (b[0] - a[0], b[1] - a[1])
        v2 = (c[0] - b[0], c[1] - b[1])
        n1 = math.hypot(*v1)
        n2 = math.hypot(*v2)
        if n1 <= 1e-6 or n2 <= 1e-6:
            continue
        dot = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
        turns.append(abs(math.acos(dot)))
    if not turns:
        return False
    jagged = sum(1 for turn in turns if turn > _FUZZY_GCODE_TURN_RAD) / len(turns)
    return band >= _FUZZY_GCODE_BAND_MIN and jagged >= _FUZZY_GCODE_JAGGED_MIN


def _gcode_member_looks_like_fuzzy_paint(
    zf: zipfile.ZipFile, name: str, *, point_distance: float, min_z: float
) -> bool:
    fuzzy_walls = 0
    z = 0.0
    feature: bytes | None = None
    points: list[tuple[float, float]] = []
    try:
        handle = zf.open(name)
    except OSError:
        return False
    with handle:
        for raw in handle:
            if raw.startswith(b"G0 ") or raw.startswith(b"G1 "):
                zm = _GCODE_Z_RE.search(raw)
                if zm:
                    try:
                        z = float(zm.group(1))
                    except ValueError:
                        pass
            if raw.startswith(b"; FEATURE:"):
                if feature == b"Outer wall" and z >= min_z and _outer_wall_is_fuzzy(points, point_distance):
                    fuzzy_walls += 1
                    if fuzzy_walls >= _FUZZY_GCODE_MIN_WALLS:
                        return True
                feature = raw.split(b":", 1)[1].strip()
                points = []
                continue
            if (
                feature == b"Outer wall"
                and raw.startswith(b"G1 ")
                and b"E" in raw
                and b"X" in raw
                and b"Y" in raw
            ):
                xy = _GCODE_XY_RE.search(raw)
                if xy:
                    try:
                        points.append((float(xy.group(1)), float(xy.group(2))))
                    except ValueError:
                        pass
        if feature == b"Outer wall" and z >= min_z and _outer_wall_is_fuzzy(points, point_distance):
            fuzzy_walls += 1
    return fuzzy_walls >= _FUZZY_GCODE_MIN_WALLS


def _gcode_looks_like_fuzzy_paint(zf: zipfile.ZipFile, contract: dict[str, Any]) -> bool:
    """True when sliced G-code outer walls show painted fuzzy-skin jitter."""
    point_distance = _as_positive_float(contract.get("fuzzy_skin_point_distance"), 0.3)
    layer_height = _as_positive_float(contract.get("layer_height"), 0.2)
    min_z = max(layer_height * 1.6, 0.35)
    for name in zf.namelist():
        lower = name.lower()
        if not lower.endswith(".gcode") or lower.endswith(".md5"):
            continue
        if _gcode_member_looks_like_fuzzy_paint(
            zf, name, point_distance=point_distance, min_z=min_z
        ):
            return True
    return False


def _apply_fuzzy_skin_paint(zf: zipfile.ZipFile, contract: dict[str, Any]) -> None:
    """Upgrade process `none` to `paint` from mesh attributes or sliced G-code jitter."""
    token = _fuzzy_skin_token(contract.get("fuzzy_skin"))
    if token not in _FUZZY_SKIN_OFF:
        return
    if _has_fuzzy_skin_paint(zf) or _gcode_looks_like_fuzzy_paint(zf, contract):
        contract["fuzzy_skin"] = "paint"


def _normalize_value(key: str, value: Any) -> Any:
    value = _unwrap(value)
    if value is None:
        return None
    if key == "initial_layer_line_width":
        return _normalize_line_width(value)
    if key == "fuzzy_skin":
        return _normalize_fuzzy_skin(value)
    if key == "sparse_infill_pattern":
        return _normalize_infill_pattern(value)
    if key == "curr_bed_type":
        return _normalize_bed_type(value)
    if key in BOOL_KEYS:
        return _as_bool(value)
    if key in STRING_KEYS:
        return str(value).strip()
    number = _as_number(value)
    if number is not None:
        return number
    return value


def _contract_source_value(key: str, config: dict[str, Any]) -> tuple[bool, Any]:
    """Look up a contract key in project_settings, with style-key fallback."""
    if key == "support_style":
        if "support_style" in config:
            return True, config["support_style"]
        if "tree_support_style" in config:
            return True, config["tree_support_style"]
        return False, None
    if key == "curr_bed_type":
        if "curr_bed_type" in config:
            return True, config["curr_bed_type"]
        if "bed_type" in config:
            return True, config["bed_type"]
        return False, None
    if key in config:
        return True, config[key]
    return False, None


def _is_enabled(value: Any) -> bool:
    if value is None:
        return False
    return _as_bool(value)


def _is_brim_on(value: Any) -> bool:
    if value is None:
        return False
    token = str(value).strip().lower().replace("-", "_").replace(" ", "_")
    return token not in _BRIM_OFF and token != ""


def _is_comparable(key: str, locked: dict, incoming: dict) -> bool:
    if key in _SUPPORT_DETAIL_KEYS:
        return _is_enabled(locked.get("enable_support")) or _is_enabled(incoming.get("enable_support"))
    if key == "brim_object_gap":
        return _is_brim_on(locked.get("brim_type")) or _is_brim_on(incoming.get("brim_type"))
    if key == "enable_prime_tower":
        return bool(locked.get(MULTI_COLOR_KEY)) or bool(incoming.get(MULTI_COLOR_KEY))
    if key == "nozzles_used":
        return locked.get("nozzles_used") is not None or incoming.get("nozzles_used") is not None
    return True


def _values_match(key: str, locked: Any, incoming: Any) -> bool:
    if locked is None or incoming is None:
        return locked is None and incoming is None
    if key in STRING_KEYS:
        return str(locked).casefold() == str(incoming).casefold()
    locked_number = _as_number(locked)
    incoming_number = _as_number(incoming)
    if locked_number is not None and incoming_number is not None:
        if key in MM_KEYS:
            return abs(float(locked_number) - float(incoming_number)) <= MM_EPSILON
        return locked_number == incoming_number
    if key in BOOL_KEYS:
        return _as_bool(locked) is _as_bool(incoming)
    return locked == incoming
