"""Pydantic schemas for the production file-slot HTTP API."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ProductionFolderSummary(BaseModel):
    """Printer folder created or adopted by production bootstrap."""

    id: int
    name: str
    production_printer_model: str | None = None


class ProductionBootstrapResponse(BaseModel):
    """Idempotent bootstrap result."""

    section_id: int
    folders: list[ProductionFolderSummary]
    folders_created: int = 0
    folders_existing: int = 0
    parts_created: int = 0
    parts_existing: int = 0


class ProductionActiveFile(BaseModel):
    """Active library file attached to a production slot."""

    id: int
    filename: str
    thumbnail_path: str | None = None
    file_size: int
    print_time_seconds: int | None = None
    sliced_for_model: str | None = None


class ProductionSlotNested(BaseModel):
    """Quantity slot nested under a part in the folder view."""

    id: int
    quantity: int
    major: int
    revision: int
    minor: int
    version: str
    active_file: ProductionActiveFile | None = None
    has_overrides: bool = False
    last_mismatch: bool | None = None
    parameter_overrides: dict[str, Any] | None = None


class ProductionPartView(BaseModel):
    """Catalog part with this folder's instance and slots, if any."""

    id: int
    code: str
    name: str
    instance_id: int | None = None
    locked_parameters: dict[str, Any] | None = None
    slots: list[ProductionSlotNested] = Field(default_factory=list)


class ProductionFolderView(BaseModel):
    """Full production folder payload for the file-slot UI."""

    folder_id: int
    printer_model: str
    section_id: int | None = None
    parts: list[ProductionPartView]


class ProductionSlotResponse(BaseModel):
    """Slot payload returned by add and replace."""

    id: int
    instance_id: int
    part_id: int
    code: str
    name: str
    quantity: int
    major: int
    revision: int
    minor: int
    version: str
    active_file: ProductionActiveFile | None = None
    has_overrides: bool = False
    last_mismatch: bool | None = None
    folder_id: int
    printer_model: str
    locked_parameters: dict[str, Any] | None = None


class ParsedProductionFilenameOut(BaseModel):
    """Identity parsed from a production filename."""

    code: str
    quantity: int
    major: int
    revision: int
    minor: int
    printer: str
    version: str


class ProductionParameterDiff(BaseModel):
    """One contract-key comparison row from ``diff_parameters``."""

    key: str
    locked: Any = None
    incoming: Any = None
    match: bool


class ProductionReplacePreview(BaseModel):
    """Dry-run replace result. Does not persist the incoming file."""

    parsed_filename: ParsedProductionFilenameOut | None = None
    current_version: str
    incoming_version: str | None = None
    version_is_newer: bool
    suggested_next_version: str
    parameter_diff: list[ProductionParameterDiff]
    has_mismatches: bool
    printer_matches_folder: bool


class ProductionPartCreate(BaseModel):
    """Add or un-hide a catalog part on one printer folder."""

    code: str
    name: str = ""


class ProductionPartRemoveResponse(BaseModel):
    """Result of hiding a part on one printer and trashing its files."""

    removed: bool = True
    files_trashed: int = 0


class ProductionRevisionResponse(BaseModel):
    """One historical snapshot of a slot."""

    version: str
    filename: str | None = None
    mismatch: bool
    accepted_new_baseline: bool
    reason: str | None = None
    created_at: datetime
    file_id: int | None = None
