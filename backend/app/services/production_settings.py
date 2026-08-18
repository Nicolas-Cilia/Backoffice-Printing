"""Extract and diff the locked production print-settings contract from a 3MF."""

from __future__ import annotations

import json
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

# Stored on the contract for gated comparison; never emitted by diff_parameters.
MULTI_COLOR_KEY = "_multi_color"

# support_style: Bambu/Orca tree *style* (`tree_slim`, `tree_hybrid`, `organic`, …),
# distinct from support_type (`tree(auto)`, `normal(auto)`, …). Some 3MFs store
# the same value on tree_support_style; extract normalizes to support_style.
CONTRACT_KEYS: tuple[str, ...] = (
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
# Bambu/Orca bbs_3mf writes `paint_fuzzy_skin`; Prusa-style 3MF uses slic3rpe:fuzzy_skin.
_PAINT_FUZZY_SKIN_ATTR_RE = re.compile(rb'(?:paint_fuzzy_skin|slic3rpe:fuzzy_skin)="[^"]+"')


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


def diff_parameters(locked: dict, incoming: dict) -> list[dict[str, Any]]:
    """Compare two contract dicts.

    Returns ``{key, locked, incoming, match}`` for each applicable contract key.
    Gated keys (``support_type`` / ``support_style`` with supports off,
    ``brim_object_gap`` with brim off, ``enable_prime_tower`` on
    single-color files, ``nozzles_used`` without a dual-nozzle mapping) are
    omitted. A key present on the locked contract but missing on incoming is a
    mismatch.
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
        rows.append(
            {
                "key": key,
                "locked": locked_value,
                "incoming": incoming_value,
                "match": match,
            }
        )
    return rows


def _extract_from_zip(zf: zipfile.ZipFile) -> dict[str, Any]:
    config = _read_project_settings(zf)
    if not config:
        return {}

    contract: dict[str, Any] = {}
    for key in CONTRACT_KEYS:
        if key == "nozzles_used":
            continue
        present, raw = _contract_source_value(key, config)
        if not present:
            continue
        contract[key] = _normalize_value(key, raw)

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


def _has_fuzzy_skin_paint(zf: zipfile.ZipFile) -> bool:
    """True if any mesh triangle carries Bambu/Prusa fuzzy-skin paint data."""
    for name in zf.namelist():
        if not name.endswith(".model"):
            continue
        try:
            data = zf.read(name)
        except OSError:
            continue
        if _PAINT_FUZZY_SKIN_ATTR_RE.search(data):
            return True
    return False


def _apply_fuzzy_skin_paint(zf: zipfile.ZipFile, contract: dict[str, Any]) -> None:
    """Upgrade process `none` to `paint` when triangles were painted for fuzzy skin."""
    token = _fuzzy_skin_token(contract.get("fuzzy_skin"))
    if token not in _FUZZY_SKIN_OFF:
        return
    if _has_fuzzy_skin_paint(zf):
        contract["fuzzy_skin"] = "paint"


def _normalize_value(key: str, value: Any) -> Any:
    value = _unwrap(value)
    if value is None:
        return None
    if key == "initial_layer_line_width":
        return _normalize_line_width(value)
    if key == "fuzzy_skin":
        return _normalize_fuzzy_skin(value)
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
