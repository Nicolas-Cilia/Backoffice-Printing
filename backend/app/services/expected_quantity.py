"""Stats 2 (Phase 2) expected-quantity resolution.

``resolve_expected_quantity`` answers "how many of this part did we *expect*
this print to yield?" from the source production file, falling back through a
fixed priority so a number always comes back with a labelled provenance:

    1. parse ``PrintArchive.filename``  → ``ParsedProductionFilename.quantity``   (source="filename")
    2. else parse ``PrintArchive.print_name``                                     (source="filename")
    3. else the ``ProductionSlot.quantity`` for the slot whose active file is
       this archive's ``library_file_id``                                         (source="production_slot")
    4. else 1                                                                      (source="default")

Deliberately does NOT use ``PrintArchive.quantity`` — that column is the 3MF
object count, which is what *actually* came off the plate, and using it as the
"expected" would make the variance trivially zero by construction.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.production import ProductionSlot
from backend.app.services.production_filename import _strip_production_extension, parse_production_filename

# Provenance labels for the resolved expected quantity.
SOURCE_FILENAME = "filename"
SOURCE_PRODUCTION_SLOT = "production_slot"
SOURCE_DEFAULT = "default"


@dataclass(frozen=True)
class ExpectedQuantity:
    """Resolved expected quantity with its provenance and parsed stem (if any)."""

    quantity: int
    source: str
    # The extension-stripped filename stem that was parsed, when the number came
    # from a filename/print_name parse. None for slot/default sources.
    parsed_stem: str | None = None


def _stem(name: str | None) -> str | None:
    if not name or not str(name).strip():
        return None
    return _strip_production_extension(Path(str(name)).name).strip() or None


async def resolve_expected_quantity(db: AsyncSession, archive_id: int | None) -> ExpectedQuantity:
    """Resolve the expected part quantity for ``archive_id`` (see module docstring)."""
    if archive_id is None:
        return ExpectedQuantity(quantity=1, source=SOURCE_DEFAULT)

    archive = await db.get(PrintArchive, archive_id)
    if archive is None:
        return ExpectedQuantity(quantity=1, source=SOURCE_DEFAULT)

    # 1 + 2: filename, then print_name — both follow the production convention.
    for candidate in (archive.filename, archive.print_name):
        parsed = parse_production_filename(candidate) if candidate else None
        if parsed is not None:
            return ExpectedQuantity(
                quantity=parsed.quantity,
                source=SOURCE_FILENAME,
                parsed_stem=_stem(candidate),
            )

    # 3: production slot quantity via the archive's dispatched library file.
    if archive.library_file_id is not None:
        slot_qty = (
            await db.execute(
                select(ProductionSlot.quantity)
                .where(ProductionSlot.active_file_id == archive.library_file_id)
                .order_by(ProductionSlot.id)
                .limit(1)
            )
        ).scalar_one_or_none()
        if slot_qty is not None:
            return ExpectedQuantity(quantity=int(slot_qty), source=SOURCE_PRODUCTION_SLOT)

    # 4: nothing resolvable.
    return ExpectedQuantity(quantity=1, source=SOURCE_DEFAULT)
