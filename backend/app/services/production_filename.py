"""Parse and format production file-slot names: ``CODE [xQTY] - M.R.m - PRINTER``."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from backend.app.utils.printer_models import PRINTER_MODEL_ID_MAP, normalize_printer_model

# Printer suffix is last and may contain spaces (e.g. "A1 Mini"). Quantity omitted means x1.
_PRODUCTION_FILENAME_RE = re.compile(
    r"^(?P<code>[A-Z]+)(?:\s*x(?P<qty>\d+))?\s*-\s*(?P<major>\d+)\.(?P<revision>\d+)\.(?P<minor>\d+)\s*-\s*(?P<printer>.+)$",
    re.IGNORECASE,
)

_STRIP_EXTENSIONS = (".gcode.3mf", ".3mf", ".gcode")

# Compact (uppercase, no spaces/hyphens) aliases → production folder codes.
# A1 Mini is stored as A1M here even though printer_models.py uses "A1 Mini".
_PRODUCTION_PRINTER_COMPACT = {
    "A1M": "A1M",
    "A1MINI": "A1M",
    "BAMBULABA1M": "A1M",
    "BAMBULABA1MINI": "A1M",
    "X1C": "X1C",
    "X1CARBON": "X1C",
    "BAMBULABX1CARBON": "X1C",
    "BAMBULABX1C": "X1C",
    "A1": "A1",
    "BAMBULABA1": "A1",
    "H2D": "H2D",
    "BAMBULABH2D": "H2D",
    "H2S": "H2S",
    "BAMBULABH2S": "H2S",
}

_DISPLAY_TO_PRODUCTION = {
    "A1 Mini": "A1M",
}


def _compact_printer(raw: str) -> str:
    return raw.strip().upper().replace(" ", "").replace("-", "").replace("_", "")


def normalize_production_printer(raw: str | None) -> str:
    """Map a printer label to a production folder code (X1C, A1M, A1, H2D, H2S).

    ``A1 Mini`` / ``A1M`` both become ``A1M``. Unknown values are returned stripped,
    after the shared 3MF model normalizer when it recognizes them.
    """
    if raw is None:
        return ""
    text = str(raw).strip()
    if not text:
        return ""

    compact = _compact_printer(text)
    if compact in _PRODUCTION_PRINTER_COMPACT:
        return _PRODUCTION_PRINTER_COMPACT[compact]

    mapped = normalize_printer_model(text)
    if mapped in _DISPLAY_TO_PRODUCTION:
        return _DISPLAY_TO_PRODUCTION[mapped]
    if mapped:
        production = _PRODUCTION_PRINTER_COMPACT.get(_compact_printer(mapped))
        if production:
            return production
        return mapped

    id_mapped = PRINTER_MODEL_ID_MAP.get(text)
    if id_mapped in _DISPLAY_TO_PRODUCTION:
        return _DISPLAY_TO_PRODUCTION[id_mapped]
    if id_mapped:
        production = _PRODUCTION_PRINTER_COMPACT.get(_compact_printer(id_mapped))
        return production or id_mapped

    return text


def _strip_production_extension(name: str) -> str:
    lower = name.lower()
    for ext in _STRIP_EXTENSIONS:
        if lower.endswith(ext):
            return name[: -len(ext)]
    return name


@dataclass(frozen=True)
class ParsedProductionFilename:
    """Identity encoded in a production 3MF filename."""

    code: str
    quantity: int
    major: int
    revision: int
    minor: int
    printer: str

    @property
    def version_tuple(self) -> tuple[int, int, int]:
        return (self.major, self.revision, self.minor)


def version_tuple(major: int, revision: int, minor: int) -> tuple[int, int, int]:
    """Return ``(major, revision, minor)`` for comparisons."""
    return (major, revision, minor)


def _coerce_version(value: tuple[int, int, int] | ParsedProductionFilename) -> tuple[int, int, int]:
    if isinstance(value, ParsedProductionFilename):
        return value.version_tuple
    return value


def is_newer(
    a: tuple[int, int, int] | ParsedProductionFilename,
    b: tuple[int, int, int] | ParsedProductionFilename,
) -> bool:
    """Return True if version ``a`` is strictly newer than version ``b``."""
    return _coerce_version(a) > _coerce_version(b)


def suggest_next_revision(major: int, revision: int, minor: int) -> tuple[int, int, int]:
    """Bump revision and reset minor: ``1.13.2`` → ``1.14.0``."""
    return (major, revision + 1, 0)


def parse_production_filename(name: str) -> ParsedProductionFilename | None:
    """Parse a production filename. Returns None when the printer suffix or version is missing."""
    if not name or not str(name).strip():
        return None

    stem = _strip_production_extension(Path(str(name)).name).strip()
    match = _PRODUCTION_FILENAME_RE.fullmatch(stem)
    if match is None:
        return None

    printer = normalize_production_printer(match.group("printer"))
    if not printer:
        return None

    qty_raw = match.group("qty")
    return ParsedProductionFilename(
        code=match.group("code").upper(),
        quantity=int(qty_raw) if qty_raw else 1,
        major=int(match.group("major")),
        revision=int(match.group("revision")),
        minor=int(match.group("minor")),
        printer=printer,
    )


def format_production_filename(
    code: str,
    quantity: int,
    major: int,
    revision: int,
    minor: int,
    printer: str,
) -> str:
    """Build a canonical production filename stem (no extension). Omits `` x1``."""
    printer_code = normalize_production_printer(printer) or printer.strip()
    qty_part = f" x{quantity}" if quantity != 1 else ""
    return f"{code.strip().upper()}{qty_part} - {major}.{revision}.{minor} - {printer_code}"
