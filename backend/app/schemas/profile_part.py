"""Pydantic schemas for profile part-section HTTP API."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from backend.app.schemas.production import ProductionParameterDiff


class ProfilePartPresetSummary(BaseModel):
    """Process preset attached to a printer slot."""

    id: int
    name: str
    printer_model: str
    locked_parameters: dict[str, Any] | None = None


class ProfilePartSlotView(BaseModel):
    """Printer slot nested under a part section."""

    id: int
    printer_model: str
    last_mismatch: bool
    spec_status: Literal["mismatch", "match"]
    parameter_diff: list[ProductionParameterDiff] = Field(default_factory=list)
    parameter_overrides: dict[str, Any] | None = None
    preset: ProfilePartPresetSummary | None = None


class ProfilePartSectionView(BaseModel):
    """Section with nested slots and the shared print-settings contract."""

    id: int
    name: str
    locked_parameters: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime
    slots: list[ProfilePartSlotView] = Field(default_factory=list)


class ProfilePartSectionCreate(BaseModel):
    """Create a user-named part section."""

    name: str


class ProfilePartSlotCreate(BaseModel):
    """Attach an existing process preset to a section."""

    section_id: int
    preset_id: int
    resolution: Literal["proceed"] | None = None


class ProfilePartReplaceRequest(BaseModel):
    """Replace the process in a printer slot."""

    preset_id: int
    resolution: Literal["proceed", "accept_baseline"]
    reason: str | None = None


class ProfilePartPreviewReplaceRequest(BaseModel):
    """Dry-run replace against the section contract."""

    preset_id: int


class ProfilePartReplacePreview(BaseModel):
    """Compare an incoming process to the section baseline. Does not persist."""

    parameter_diff: list[ProductionParameterDiff]
    has_mismatches: bool
    incoming_parameters: dict[str, Any]
    printer_model: str


class ProfilePartImportAttached(BaseModel):
    """A newly created printer slot from a section-scoped process upload."""

    slot: ProfilePartSlotView
    spec_status: Literal["mismatch", "match"]
    parameter_diff: list[ProductionParameterDiff] = Field(default_factory=list)


class ProfilePartImportNeedsReplace(BaseModel):
    """Occupied printer slot — UI should open the existing replace modal."""

    printer_model: str
    preset_id: int
    preset_name: str
    existing_slot_id: int
    preview: ProfilePartReplacePreview


class ProfilePartImportNeedsConfirm(BaseModel):
    """New printer slot that mismatches the section baseline — do not attach yet."""

    printer_model: str
    preset_id: int
    preset_name: str
    preview: ProfilePartReplacePreview


class ProfilePartImportResponse(BaseModel):
    """Result of uploading a process file directly into a part section."""

    success: bool
    imported: int
    skipped: int
    errors: list[str] = Field(default_factory=list)
    attached: list[ProfilePartImportAttached] = Field(default_factory=list)
    needs_replace: list[ProfilePartImportNeedsReplace] = Field(default_factory=list)
    needs_confirm: list[ProfilePartImportNeedsConfirm] = Field(default_factory=list)
    section: ProfilePartSectionView
