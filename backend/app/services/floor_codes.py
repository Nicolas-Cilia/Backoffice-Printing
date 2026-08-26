"""Floor scanning codes: the station catalog and their printable labels.

Phase 1a of the Floor system (``docs/floor-plan.md`` §3.3/§10). Two concerns
live here because they share one source of truth — the exact ``BBS-`` payload
strings:

- **The station catalog.** What stations exist and what string each one's QR
  encodes. Phase 1b's scan routing resolves a scanned payload back to a
  station through :func:`station_for_payload`, so the catalog must stay the
  only place those strings are written down. A QR taped to a physical shelf
  cannot be re-printed cheaply — treat these payloads as durable.
- **Label rendering.** A deliberately plain layout (title, QR, payload text)
  at a caller-chosen physical size.

Why not reuse the spool label templates in ``label_renderer``: those are
built around spool data (colour swatch, material, brand) at six *fixed*
sizes. A station label is a different shape of thing — three fields, and an
operator-chosen size. The genuinely shared parts (QR generation, which
carries the #1870 thermal-printer module-size tuning, and text truncation)
are imported from that module rather than duplicated.

Station names are intentionally *not* translated: the printed label is a
physical object matched against the workflow written in ``floor-plan.md``,
and "WIP" or "Move" on a shelf should read the same as the doc regardless of
the operator's UI language.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Literal

from reportlab.lib.colors import HexColor, black
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as rl_canvas

from backend.app.services.label_renderer import qr_png_bytes, truncate_to_width

# Prefix for every station QR. Phase 1b's scan router keys off this to tell a
# station scan apart from printer (``BBP-``) / part (``BBD-``) codes (§4).
STATION_PREFIX = "BBS-"

TITLE_FONT = "Helvetica-Bold"
PAYLOAD_FONT = "Courier"

# Physical size bounds for a printable label, in millimetres. The floor is
# 40-80 mm in practice (§3.3); the wider range here just keeps a custom size
# from producing a PDF with no room for a scannable QR (or an absurd page).
MIN_LABEL_MM = 20.0
MAX_LABEL_MM = 200.0

# Cap one request's page count. Station labels come five at a time today;
# this only guards against a malformed bulk request.
MAX_LABELS_PER_REQUEST = 100


@dataclass(frozen=True)
class FloorStation:
    """One scannable station on the floor."""

    slug: str
    name: str
    description: str
    # Whether this station takes a floor-wide lock (§2.4): at most one open
    # session across every device. True for all but Cleanup, where parallel
    # work on separate machines is normal. Note this is *not* the same as
    # "one session per device" — that rule is universal and holds regardless.
    exclusive: bool = True
    # Which Codes-page tab this station's printable label sits under (§3.3).
    # Purely a presentation grouping — every station here is identical
    # session-machinery-wise (open/close/switch, `exclusive`, scan dispatch
    # keyed by slug) regardless of category. "station" covers the original
    # workflow-mode benches (WIP/+Storage/Move/Harvest/Cleanup); "location"
    # covers QC checkpoints a part passes through (Fit Check/Rework) — an
    # operator's mental model the label sheet should match, even though
    # nothing in the backend actually treats the two groups differently.
    category: Literal["station", "location"] = "station"

    @property
    def payload(self) -> str:
        """The exact string this station's QR encodes."""
        return f"{STATION_PREFIX}{self.slug}"


# The stations from §5. Slugs match the payload examples in §4 verbatim.
FLOOR_STATIONS: tuple[FloorStation, ...] = (
    FloorStation(
        slug="wip",
        name="WIP",
        description="Production shelf. Scan filament SKUs to add kg to WIP.",
    ),
    FloorStation(
        slug="storage-receive",
        name="+ Storage",
        description="Warehouse shelf. Scan filament SKUs to add kg to storage.",
    ),
    FloorStation(
        slug="storage-move",
        name="Move",
        description="Queue kg to move off storage; scan WIP to complete the move.",
    ),
    FloorStation(
        slug="harvest",
        name="Harvest",
        description="Label parts while clearing the bed.",
    ),
    FloorStation(
        slug="fit-check",
        name="Fit Check",
        description="Mandatory checkpoint before Cleanup. Scan each part to record it as checked.",
        # No floor-wide lock (§2.4/§5.4a): parallel fit-check benches are
        # normal work, same reasoning as Cleanup below.
        exclusive=False,
        category="location",
    ),
    FloorStation(
        slug="rework",
        name="Rework",
        description="Optional shelf for parts that need rework before Cleanup.",
        # No floor-wide lock (§2.4/§5.4b), same reasoning as Fit Check.
        exclusive=False,
        category="location",
    ),
    FloorStation(
        slug="cleanup",
        name="Cleanup",
        description="Log defects at support removal.",
        # The one station without a floor-wide lock (§5.5): two benches
        # clearing supports at once is ordinary parallel work, and their
        # scans never touch the same record.
        exclusive=False,
    ),
)

_STATIONS_BY_PAYLOAD: dict[str, FloorStation] = {s.payload: s for s in FLOOR_STATIONS}
_STATIONS_BY_SLUG: dict[str, FloorStation] = {s.slug: s for s in FLOOR_STATIONS}
# Older printed labels remain valid after the name change. They resolve to
# the canonical Rework location but are no longer offered for new printing.
_STATIONS_BY_PAYLOAD[f"{STATION_PREFIX}sanding"] = _STATIONS_BY_SLUG["rework"]


def station_for_payload(payload: str) -> FloorStation | None:
    """Resolve a scanned string to a station, or ``None`` if it isn't one.

    Exact match only. A pistol emits the payload verbatim, so accepting
    near-misses would risk opening the wrong station from a damaged scan —
    an unknown code (§9: error flash, no state change) is the safer answer.
    """
    return _STATIONS_BY_PAYLOAD.get(payload.strip())


def station_for_slug(slug: str) -> FloorStation | None:
    """Resolve a station slug, or ``None``. Used for stored session rows,
    which key on the slug rather than the printed payload."""
    return _STATIONS_BY_SLUG.get(slug.strip())


@dataclass
class CodeLabel:
    """One printable code label: a QR plus the two lines of text around it."""

    payload: str
    title: str


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _draw_code_label(c: rl_canvas.Canvas, w: float, h: float, label: CodeLabel) -> None:
    """Render one label filling the page box (0, 0, w, h).

    Vertical stack, top to bottom: title, QR, payload. Everything is centred
    horizontally and sized off the label's own dimensions so a 20 mm and a
    200 mm label both stay legible rather than one being tuned and the other
    accidental.
    """
    pad = min(w, h) * 0.06
    inner_w = w - 2 * pad
    inner_h = h - 2 * pad

    title_size = _clamp(inner_h * 0.16, 5.0, 22.0)
    payload_size = _clamp(inner_h * 0.085, 4.0, 10.0)
    title_gap = title_size * 0.35
    payload_gap = payload_size * 0.45

    # Whatever vertical room the two text rows leave is the QR's, capped by
    # width so it stays square and inside the label.
    qr_available_h = inner_h - title_size - title_gap - payload_size - payload_gap
    qr_size = max(0.0, min(inner_w, qr_available_h))

    # Cut guide: these print on office paper and get cut out by hand (§3.3),
    # so a hairline edge is worth more than a clean bleed.
    c.setStrokeColor(HexColor(0xCCCCCC))
    c.setLineWidth(0.3)
    c.rect(0.5, 0.5, w - 1, h - 1, stroke=1, fill=0)

    center_x = w / 2

    payload_y = pad
    qr_y = payload_y + payload_size + payload_gap
    title_y = qr_y + qr_size + title_gap

    c.setFillColor(black)

    c.setFont(TITLE_FONT, title_size)
    c.drawCentredString(center_x, title_y, truncate_to_width(c, label.title, TITLE_FONT, title_size, inner_w))

    if qr_size > 0:
        png = qr_png_bytes(label.payload)
        if png:
            from reportlab.lib.utils import ImageReader

            c.drawImage(
                ImageReader(io.BytesIO(png)),
                center_x - qr_size / 2,
                qr_y,
                width=qr_size,
                height=qr_size,
                mask="auto",
            )

    c.setFont(PAYLOAD_FONT, payload_size)
    c.drawCentredString(center_x, payload_y, truncate_to_width(c, label.payload, PAYLOAD_FONT, payload_size, inner_w))


def render_code_labels(labels: list[CodeLabel], *, width_mm: float, height_mm: float) -> bytes:
    """Render ``labels`` to a PDF, one label per page, at the given size.

    Raises ``ValueError`` for sizes outside [MIN_LABEL_MM, MAX_LABEL_MM] —
    the route surfaces that as a 400 rather than emitting a PDF whose QR is
    too small to scan.
    """
    for value, axis in ((width_mm, "width"), (height_mm, "height")):
        if not MIN_LABEL_MM <= value <= MAX_LABEL_MM:
            raise ValueError(f"Label {axis} must be between {MIN_LABEL_MM:g} and {MAX_LABEL_MM:g} mm, got {value:g}")

    page_w, page_h = width_mm * mm, height_mm * mm
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(page_w, page_h))
    c.setTitle("Bambuddy floor code labels")

    for label in labels:
        _draw_code_label(c, page_w, page_h, label)
        c.showPage()

    c.save()
    return buf.getvalue()


__all__ = [
    "STATION_PREFIX",
    "MIN_LABEL_MM",
    "MAX_LABEL_MM",
    "MAX_LABELS_PER_REQUEST",
    "FloorStation",
    "FLOOR_STATIONS",
    "station_for_payload",
    "station_for_slug",
    "CodeLabel",
    "render_code_labels",
]
