"""Resolve a local process preset to a stored printer short code (X1C, A1 Mini, …)."""

from __future__ import annotations

import json
import re
from typing import Any

from backend.app.utils.printer_models import PRINTER_MODEL_MAP, normalize_printer_model

_NOZZLE_SUFFIX_RE = re.compile(r"^(.*?)\s+([\d.]+)\s*nozzle\s*$", re.IGNORECASE)
_TRAILING_PAREN_RE = re.compile(r"\s*\([^)]*\)\s*$")
_BBL_MARKER = "@BBL "
_BAMBU_LAB_PREFIX_RE = re.compile(r"^Bambu Lab\s+(.+)$", re.IGNORECASE)

_UNKNOWN_PREFIX = "unknown:"


def is_unknown_printer(printer_model: str) -> bool:
    """True when the stored code is a per-preset unknown, not a shared printer."""
    return printer_model.startswith(_UNKNOWN_PREFIX)


def unknown_printer_model(preset_id: int) -> str:
    """Unique unknown key so two unidentified printers are not the same slot."""
    return f"{_UNKNOWN_PREFIX}{preset_id}"


def extract_printer_tag(preset_name: str) -> str | None:
    """Pull a printer token from ``@BBL`` / ``@Bambu Lab`` on a preset name.

    Mirrors ``extractPrinterTag`` in ``frontend/src/utils/slicerPrinterMatch.ts``
    (token only; nozzle size is discarded for slot identity).
    """
    cleaned = _TRAILING_PAREN_RE.sub("", preset_name or "").strip()
    idx = cleaned.find(_BBL_MARKER)
    if idx >= 0:
        rest = cleaned[idx + len(_BBL_MARKER) :].strip()
        token = _strip_nozzle_suffix(rest)
        return token or None
    at = cleaned.rfind("@")
    if at < 0:
        return None
    suffix = cleaned[at + 1 :].strip()
    match = _BAMBU_LAB_PREFIX_RE.match(suffix)
    if match:
        token = _strip_nozzle_suffix(match.group(1))
        return token or None
    return None


def canonical_printer_code(token: str | None) -> str | None:
    """Map a name fragment or long form to a PRINTER_MODEL_MAP short code."""
    if not token:
        return None
    text = token.strip()
    if not text:
        return None

    direct = _lookup_model_map(text)
    if direct:
        return direct

    prefixed = text if _BAMBU_LAB_PREFIX_RE.match(text) else f"Bambu Lab {text}"
    mapped = _lookup_model_map(prefixed)
    if mapped:
        return mapped

    for long_name, short in PRINTER_MODEL_MAP.items():
        suffix = long_name.removeprefix("Bambu Lab ").strip()
        if text.casefold() == suffix.casefold() or text.casefold() == short.casefold():
            return short

    normalized = normalize_printer_model(prefixed)
    if normalized:
        for short in PRINTER_MODEL_MAP.values():
            if normalized.casefold() == short.casefold():
                return short
        return normalized
    return None


def first_compatible_printer(compatible_printers: str | list | None) -> str | None:
    """First entry from a JSON-array string or list of printer preset names."""
    entries = _compatible_entries(compatible_printers)
    return entries[0] if entries else None


def printer_model_from_preset(
    *,
    name: str | None,
    compatible_printers: str | list | None,
    preset_id: int,
) -> str:
    """Resolve slot printer identity.

    Order: ``@BBL`` / ``@Bambu Lab`` name tag → ``normalize_printer_model`` /
    ``PRINTER_MODEL_MAP`` → first ``compatible_printers`` entry → unique
    ``unknown:{preset_id}``.
    """
    tag = extract_printer_tag(name or "")
    code = canonical_printer_code(tag)
    if code:
        return code

    first = first_compatible_printer(compatible_printers)
    if first:
        stripped = _strip_nozzle_suffix(_TRAILING_PAREN_RE.sub("", first).strip())
        code = canonical_printer_code(stripped)
        if code:
            return code

    return unknown_printer_model(preset_id)


def _strip_nozzle_suffix(value: str) -> str:
    match = _NOZZLE_SUFFIX_RE.match(value.strip())
    return match.group(1).strip() if match else value.strip()


def _lookup_model_map(raw: str) -> str | None:
    if raw in PRINTER_MODEL_MAP:
        return PRINTER_MODEL_MAP[raw]
    folded = raw.casefold()
    for key, short in PRINTER_MODEL_MAP.items():
        if key.casefold() == folded:
            return short
    return None


def _compatible_entries(value: Any) -> list[str]:
    if value is None:
        return []
    parsed: Any = value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            return [text]
    if isinstance(parsed, list):
        return [str(item) for item in parsed if item]
    if parsed:
        return [str(parsed)]
    return []
