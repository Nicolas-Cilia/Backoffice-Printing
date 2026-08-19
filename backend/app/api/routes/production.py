"""Production file-slot HTTP API: bootstrap, folder view, add, preview, replace, delete, history."""

from __future__ import annotations

import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import inspect as sa_inspect, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.api.routes.library import (
    _clean_3mf_metadata,
    _resolve_upload_destination,
    _stored_file_path,
    _without_print_name,
    calculate_file_hash,
    classify_file_type,
    get_library_thumbnails_dir,
    to_absolute_path,
    to_relative_path,
    validate_print_file_upload,
)
from backend.app.core.auth import require_ownership_permission, require_permission_if_auth_enabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.production import (
    DEFAULT_PARTS,
    ProductionPart,
    ProductionPartInstance,
    ProductionRevision,
    ProductionSlot,
)
from backend.app.models.user import User
from backend.app.schemas.library import TagSummary
from backend.app.schemas.production import (
    ParsedProductionFilenameOut,
    ProductionActiveFile,
    ProductionBootstrapResponse,
    ProductionFolderSummary,
    ProductionFolderView,
    ProductionParameterDiff,
    ProductionPartCreate,
    ProductionPartRemoveResponse,
    ProductionPartView,
    ProductionReplacePreview,
    ProductionRevisionResponse,
    ProductionSlotNested,
    ProductionSlotResponse,
)
from backend.app.services.archive import ThreeMFParser
from backend.app.services.production_bootstrap import bootstrap_production
from backend.app.services.production_filename import (
    ParsedProductionFilename,
    is_newer,
    normalize_production_printer,
    parse_production_filename,
    stored_production_filename,
    suggest_next_revision,
)
from backend.app.services.production_settings import diff_parameters, extract_production_settings
from backend.app.utils.filename import InvalidFilenameError, validate_print_filename

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/production", tags=["production"])

_DEFAULT_PART_NAMES = dict(DEFAULT_PARTS)
_DEFAULT_CODE_ORDER = {code: i for i, (code, _) in enumerate(DEFAULT_PARTS)}
_SLOT_EXISTS_DETAIL = "Use replace for existing production slots"
_VALID_RESOLUTIONS = frozenset({"proceed", "accept_baseline"})
_OWN_FILES_ONLY_DETAIL = "You can only delete your own files"
_CONTRACT_RESOLUTION_DETAIL = (
    "This part already has a print-settings contract. Pass resolution 'proceed' or 'accept_baseline'."
)
_ACTIVE_FILE_WITH_TAGS = selectinload(ProductionSlot.active_file).selectinload(LibraryFile.tags)
_PART_ALREADY_VISIBLE = "This part is already on this printer"
_PART_CODE_RE = re.compile(r"^[A-Z]{1,32}$")


def _format_version(major: int, revision: int, minor: int) -> str:
    return f"{major}.{revision}.{minor}"


def _parsed_out(parsed: ParsedProductionFilename) -> ParsedProductionFilenameOut:
    return ParsedProductionFilenameOut(
        code=parsed.code,
        quantity=parsed.quantity,
        major=parsed.major,
        revision=parsed.revision,
        minor=parsed.minor,
        printer=parsed.printer,
        version=_format_version(parsed.major, parsed.revision, parsed.minor),
    )


def _file_tag_summaries(file: LibraryFile) -> list[TagSummary]:
    """Return chip tags when the relationship is already loaded."""
    if "tags" in sa_inspect(file).unloaded:
        return []
    return [TagSummary(id=tag.id, name=tag.name) for tag in file.tags]


def _active_file_out(file: LibraryFile | None) -> ProductionActiveFile | None:
    if file is None:
        return None
    meta = file.file_metadata or {}
    return ProductionActiveFile(
        id=file.id,
        filename=file.filename,
        thumbnail_path=file.thumbnail_path,
        file_size=file.file_size,
        print_time_seconds=meta.get("print_time_seconds"),
        sliced_for_model=meta.get("sliced_for_model"),
        tags=_file_tag_summaries(file),
    )


def _latest_revision(slot: ProductionSlot) -> ProductionRevision | None:
    if not slot.revisions:
        return None
    return max(slot.revisions, key=lambda r: (r.created_at or datetime.min, r.id or 0))


def _slot_nested(slot: ProductionSlot) -> ProductionSlotNested:
    latest = _latest_revision(slot)
    return ProductionSlotNested(
        id=slot.id,
        quantity=slot.quantity,
        major=slot.major,
        revision=slot.revision,
        minor=slot.minor,
        version=_format_version(slot.major, slot.revision, slot.minor),
        active_file=_active_file_out(slot.active_file),
        has_overrides=bool(slot.parameter_overrides),
        last_mismatch=None if latest is None else latest.mismatch,
        parameter_overrides=slot.parameter_overrides,
    )


def _fuzzy_skin_token(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip().lower().replace("-", "_").replace(" ", "_")


def _refresh_locked_fuzzy_from_active_file(instance: ProductionPartInstance, slots: list[ProductionSlot]) -> bool:
    """Upgrade stored `none` to `paint` when the active sliced 3MF has fuzzy G-code."""
    locked = instance.locked_parameters or {}
    if _fuzzy_skin_token(locked.get("fuzzy_skin")) == "paint":
        return False
    for slot in slots:
        library_file = slot.active_file
        if library_file is None or not library_file.file_path:
            continue
        abs_path = to_absolute_path(library_file.file_path)
        if abs_path is None or not abs_path.is_file():
            continue
        try:
            extracted = extract_production_settings(abs_path.read_bytes())
        except OSError:
            continue
        if _fuzzy_skin_token(extracted.get("fuzzy_skin")) != "paint":
            continue
        updated = dict(locked)
        updated["fuzzy_skin"] = "paint"
        instance.locked_parameters = updated
        return True
    return False


def _unique_slots(slots: list[ProductionSlot]) -> list[ProductionSlot]:
    seen: set[int] = set()
    unique: list[ProductionSlot] = []
    for slot in sorted(slots, key=lambda s: (s.quantity, s.id or 0)):
        if slot.id in seen:
            continue
        seen.add(slot.id)
        unique.append(slot)
    return unique


def _slot_response(
    slot: ProductionSlot,
    instance: ProductionPartInstance,
    part: ProductionPart,
    *,
    latest: ProductionRevision | None,
    active_file: LibraryFile | None,
) -> ProductionSlotResponse:
    return ProductionSlotResponse(
        id=slot.id,
        instance_id=instance.id,
        part_id=part.id,
        code=part.code,
        name=part.name,
        quantity=slot.quantity,
        major=slot.major,
        revision=slot.revision,
        minor=slot.minor,
        version=_format_version(slot.major, slot.revision, slot.minor),
        active_file=_active_file_out(active_file),
        has_overrides=bool(slot.parameter_overrides),
        last_mismatch=None if latest is None else latest.mismatch,
        folder_id=instance.folder_id,
        printer_model=instance.printer_model,
        locked_parameters=instance.locked_parameters,
    )


def _has_mismatches(diff: list[dict[str, Any]]) -> bool:
    return any(not row.get("match", False) for row in diff)


async def _read_upload(file: UploadFile) -> tuple[str, bytes]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename is required")
    filename = file.filename
    try:
        validate_print_filename(filename)
    except InvalidFilenameError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    content = await file.read()
    validate_print_file_upload(filename, content)
    return filename, content


def _form_code(code: str | None) -> str | None:
    cleaned = (code or "").strip().upper()
    return cleaned or None


def _form_printer(printer: str | None) -> str | None:
    cleaned = (printer or "").strip()
    return cleaned or None


def _merge_identity(
    filename: str,
    *,
    code: str | None,
    quantity: int | None,
    major: int | None,
    revision: int | None,
    minor: int | None,
    printer: str | None,
) -> tuple[str, int, int, int, int, str, ParsedProductionFilename | None]:
    """Parse the filename, then apply form overrides for any provided identity fields."""
    parsed = parse_production_filename(filename)
    merged_code = _form_code(code) or (parsed.code if parsed else None)
    merged_qty = quantity if quantity is not None else (parsed.quantity if parsed else None)
    merged_major = major if major is not None else (parsed.major if parsed else None)
    merged_revision = revision if revision is not None else (parsed.revision if parsed else None)
    merged_minor = minor if minor is not None else (parsed.minor if parsed else None)
    printer_raw = _form_printer(printer) or (parsed.printer if parsed else None)
    merged_printer = normalize_production_printer(printer_raw) if printer_raw else ""

    missing: list[str] = []
    if not merged_code:
        missing.append("code")
    if merged_qty is None:
        missing.append("quantity")
    if merged_major is None or merged_revision is None or merged_minor is None:
        missing.append("version")
    if not merged_printer:
        missing.append("printer")
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Missing required production identity: {', '.join(missing)}",
        )
    if merged_qty < 1:
        raise HTTPException(status_code=400, detail="quantity must be at least 1")
    return merged_code, merged_qty, merged_major, merged_revision, merged_minor, merged_printer, parsed


def _stored_upload_filename(
    original_name: str,
    *,
    code: str,
    quantity: int,
    major: int,
    revision: int,
    minor: int,
    printer: str,
) -> str:
    """Library display name: locked identity stem plus the original extension."""
    stored = stored_production_filename(
        original_name,
        code,
        quantity,
        major,
        revision,
        minor,
        printer,
    )
    try:
        validate_print_filename(stored)
    except InvalidFilenameError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return stored


async def _load_production_folder(db: AsyncSession, folder_id: int) -> LibraryFolder:
    folder = (await db.execute(select(LibraryFolder).where(LibraryFolder.id == folder_id))).scalar_one_or_none()
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    if not folder.is_tracking():
        raise HTTPException(status_code=400, detail="Folder is not a production printer folder")
    return folder


def _folder_printer(folder: LibraryFolder) -> str | None:
    printer = (folder.production_printer_model or "").strip()
    return printer or None


def _printer_matches_folder(folder: LibraryFolder, parsed_printer: str | None) -> bool:
    """Filename printer vs folder printer. No folder printer → skip the check."""
    folder_printer = _folder_printer(folder)
    if not folder_printer:
        return True
    return parsed_printer == folder_printer


async def _resolve_printer_folder(
    db: AsyncSession,
    *,
    folder_id: int | None,
    printer: str,
    parsed: ParsedProductionFilename | None,
) -> LibraryFolder:
    if folder_id is not None:
        folder = await _load_production_folder(db, folder_id)
        folder_printer = _folder_printer(folder)
        if folder_printer:
            if parsed is not None and parsed.printer != folder_printer:
                raise HTTPException(
                    status_code=400,
                    detail=(f"Filename printer {parsed.printer} does not match folder printer {folder_printer}"),
                )
            if printer != folder_printer:
                raise HTTPException(
                    status_code=400,
                    detail=f"Printer {printer} does not match folder printer {folder_printer}",
                )
        return folder

    folder = (
        (
            await db.execute(
                select(LibraryFolder)
                .where(LibraryFolder.production_printer_model == printer)
                .order_by(LibraryFolder.id)
            )
        )
        .scalars()
        .first()
    )
    if folder is None:
        raise HTTPException(status_code=400, detail=f"No production folder for printer {printer}")
    return folder


async def _save_library_file(
    db: AsyncSession,
    *,
    content: bytes,
    filename: str,
    folder: LibraryFolder,
    owner_id: int | None,
) -> LibraryFile:
    dest, is_external = _resolve_upload_destination(folder, filename)
    with open(dest, "wb") as handle:
        handle.write(content)

    file_hash = calculate_file_hash(dest)
    metadata: dict | None = None
    thumbnail_path: str | None = None
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".3mf":
        try:
            parser = ThreeMFParser(str(dest))
            raw_metadata = parser.parse()
            thumb_data = raw_metadata.get("_thumbnail_data")
            thumb_ext = raw_metadata.get("_thumbnail_ext", ".png")
            if thumb_data:
                thumbs_dir = get_library_thumbnails_dir()
                thumb_filename = f"{uuid.uuid4().hex}{thumb_ext}"
                thumb_path = thumbs_dir / thumb_filename  # SEC-PATH-OK: uuid + ext
                with open(thumb_path, "wb") as handle:
                    handle.write(thumb_data)
                thumbnail_path = str(thumb_path)
            metadata = _clean_3mf_metadata(raw_metadata) or None
        except Exception as exc:
            logger.warning("Failed to parse 3MF %s: %s", filename, exc)

    library_file = LibraryFile(
        folder_id=folder.id,
        is_external=is_external,
        filename=filename,
        file_path=_stored_file_path(dest, is_external),
        file_type=classify_file_type(filename),
        file_size=len(content),
        file_hash=file_hash,
        thumbnail_path=to_relative_path(thumbnail_path) if thumbnail_path else None,
        file_metadata=_without_print_name(metadata),
        created_by_id=owner_id,
    )
    db.add(library_file)
    await db.flush()
    return library_file


async def _get_or_create_part(db: AsyncSession, code: str, name: str | None = None) -> ProductionPart:
    part = (await db.execute(select(ProductionPart).where(ProductionPart.code == code))).scalar_one_or_none()
    if part is not None:
        return part
    part = ProductionPart(code=code, name=name or _DEFAULT_PART_NAMES.get(code, code.title()))
    db.add(part)
    await db.flush()
    return part


async def _get_part_by_code(db: AsyncSession, code: str) -> ProductionPart | None:
    return (await db.execute(select(ProductionPart).where(ProductionPart.code == code))).scalar_one_or_none()


async def _find_part_instance(
    db: AsyncSession,
    *,
    part_id: int,
    folder: LibraryFolder,
    load_slots: bool = False,
) -> ProductionPartInstance | None:
    stmt = select(ProductionPartInstance).where(
        ProductionPartInstance.part_id == part_id,
        ProductionPartInstance.folder_id == folder.id,
    )
    folder_printer = _folder_printer(folder)
    if folder_printer:
        stmt = stmt.where(ProductionPartInstance.printer_model == folder_printer)
    else:
        stmt = stmt.order_by(ProductionPartInstance.id)
    if load_slots:
        stmt = stmt.options(
            selectinload(ProductionPartInstance.part),
            selectinload(ProductionPartInstance.slots).options(
                _ACTIVE_FILE_WITH_TAGS,
                selectinload(ProductionSlot.revisions),
            ),
        )
    return (await db.execute(stmt)).scalars().first()


def _instance_printer_model(folder: LibraryFolder, fallback: str = "") -> str:
    return _folder_printer(folder) or (fallback or "")


def _part_view(instance: ProductionPartInstance) -> ProductionPartView:
    slots = _unique_slots(instance.slots)
    return ProductionPartView(
        id=instance.part.id,
        code=instance.part.code,
        name=instance.part.name,
        instance_id=instance.id,
        locked_parameters=instance.locked_parameters,
        slots=[_slot_nested(slot) for slot in slots],
    )


async def _load_slot(db: AsyncSession, slot_id: int) -> ProductionSlot:
    slot = (
        await db.execute(
            select(ProductionSlot)
            .where(ProductionSlot.id == slot_id)
            .options(
                _ACTIVE_FILE_WITH_TAGS,
                selectinload(ProductionSlot.revisions),
                selectinload(ProductionSlot.instance).selectinload(ProductionPartInstance.part),
                selectinload(ProductionSlot.instance).selectinload(ProductionPartInstance.folder),
            )
        )
    ).scalar_one_or_none()
    if slot is None:
        raise HTTPException(status_code=404, detail="Production slot not found")
    return slot


def _slot_library_file_ids(slot: ProductionSlot) -> set[int]:
    file_ids: set[int] = set()
    if slot.active_file_id is not None:
        file_ids.add(slot.active_file_id)
    for revision in slot.revisions:
        if revision.library_file_id is not None:
            file_ids.add(revision.library_file_id)
    return file_ids


def _assert_can_delete_slot_files(
    *,
    user: User | None,
    can_modify_all: bool,
    files: list[LibraryFile],
    slot: ProductionSlot,
) -> None:
    """Match File Manager: delete_all can trash anything; delete_own only own files."""
    if can_modify_all:
        return
    if user is None:
        raise HTTPException(status_code=403, detail=_OWN_FILES_ONLY_DETAIL)
    if files:
        if any(library_file.created_by_id != user.id for library_file in files):
            raise HTTPException(status_code=403, detail=_OWN_FILES_ONLY_DETAIL)
        return
    owners = {revision.created_by_id for revision in slot.revisions}
    if not owners or any(owner_id != user.id for owner_id in owners):
        raise HTTPException(status_code=403, detail=_OWN_FILES_ONLY_DETAIL)


async def _trash_library_files(db: AsyncSession, files: list[LibraryFile]) -> None:
    """Soft-delete managed files; hard-delete external files. Same as File Manager."""
    now = datetime.now(timezone.utc)
    for library_file in files:
        if library_file.deleted_at is not None:
            continue
        if library_file.is_external:
            abs_thumb_path = to_absolute_path(library_file.thumbnail_path)
            if abs_thumb_path and abs_thumb_path.exists():
                try:
                    abs_thumb_path.unlink()
                except OSError as exc:
                    logger.warning("Failed to delete thumbnail from disk: %s", exc)
            await db.delete(library_file)
        else:
            library_file.deleted_at = now


def _instance_has_contract(instance: ProductionPartInstance | None) -> bool:
    return bool(instance is not None and instance.locked_parameters)


def _apply_shared_contract(
    instance: ProductionPartInstance,
    incoming: dict[str, Any],
    resolution: str | None,
) -> tuple[bool, bool]:
    """Compare incoming settings to the shared part-instance contract.

    Returns ``(mismatch, accepted_new_baseline)``. The first file sets the
    baseline. Later quantity slots (x2, x4, …) must match or pass resolution.
    """
    if not instance.locked_parameters:
        instance.locked_parameters = incoming
        return False, True
    diff = diff_parameters(instance.locked_parameters, incoming)
    if not _has_mismatches(diff):
        return False, False
    if resolution not in _VALID_RESOLUTIONS:
        raise HTTPException(status_code=400, detail=_CONTRACT_RESOLUTION_DETAIL)
    if resolution == "accept_baseline":
        instance.locked_parameters = incoming
        return False, True
    return True, False


def _settings_preview(
    *,
    instance: ProductionPartInstance | None,
    folder: LibraryFolder,
    filename: str,
    content: bytes,
) -> ProductionReplacePreview:
    parsed = parse_production_filename(filename)
    printer_matches = _printer_matches_folder(folder, parsed.printer if parsed else None)
    incoming_settings = extract_production_settings(content)
    if _instance_has_contract(instance):
        diff = diff_parameters(instance.locked_parameters or {}, incoming_settings)
    else:
        diff = []

    current_version = ""
    suggested_next = "1.0.0"
    version_is_newer = False
    slots = _unique_slots(instance.slots) if instance is not None else []
    if slots:
        newest = max(slots, key=lambda s: (s.major, s.revision, s.minor, s.id or 0))
        current_version = _format_version(newest.major, newest.revision, newest.minor)
        suggested_next = _format_version(*suggest_next_revision(newest.major, newest.revision, newest.minor))
        version_is_newer = bool(parsed) and is_newer(parsed, (newest.major, newest.revision, newest.minor))
    incoming_version = _format_version(parsed.major, parsed.revision, parsed.minor) if parsed else None

    return ProductionReplacePreview(
        parsed_filename=_parsed_out(parsed) if parsed else None,
        current_version=current_version,
        incoming_version=incoming_version,
        version_is_newer=version_is_newer,
        suggested_next_version=suggested_next,
        parameter_diff=[ProductionParameterDiff(**row) for row in diff],
        has_mismatches=_has_mismatches(diff),
        printer_matches_folder=printer_matches,
    )


def _normalize_part_identity(code: str, name: str) -> tuple[str, str]:
    stored = (code or "").strip().upper()
    if not _PART_CODE_RE.fullmatch(stored):
        raise HTTPException(status_code=400, detail="Part code must be 1–32 letters (A–Z)")
    cleaned_name = (name or "").strip() or _DEFAULT_PART_NAMES.get(stored, stored.title())
    if len(cleaned_name) > 255:
        raise HTTPException(status_code=400, detail="Part name is too long")
    return stored, cleaned_name


# ============ Endpoints ============


@router.post("/bootstrap", response_model=ProductionBootstrapResponse)
async def post_bootstrap(
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPLOAD)),
):
    """Ensure the Production section, printer folders, and default parts exist."""
    result = await bootstrap_production(db)
    folders = (
        (
            await db.execute(
                select(LibraryFolder).where(LibraryFolder.id.in_(result.folder_ids.values())).order_by(LibraryFolder.id)
            )
        )
        .scalars()
        .all()
    )
    return ProductionBootstrapResponse(
        section_id=result.section_id,
        folders=[
            ProductionFolderSummary(
                id=folder.id,
                name=folder.name,
                production_printer_model=folder.production_printer_model,
            )
            for folder in folders
        ],
        folders_created=result.folders_created,
        folders_existing=result.folders_existing,
        parts_created=result.parts_created,
        parts_existing=result.parts_existing,
    )


@router.get("/folders/{folder_id}", response_model=ProductionFolderView)
async def get_production_folder(
    folder_id: int,
    db: AsyncSession = Depends(get_db),
    _: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.LIBRARY_READ_ALL,
            Permission.LIBRARY_READ_OWN,
        )
    ),
):
    """Return the parts visible on this printer folder (not the full catalog)."""
    await bootstrap_production(db)
    folder = await _load_production_folder(db, folder_id)

    instances = (
        (
            await db.execute(
                select(ProductionPartInstance)
                .where(
                    ProductionPartInstance.folder_id == folder.id,
                    ProductionPartInstance.hidden.is_(False),
                )
                .options(
                    selectinload(ProductionPartInstance.part),
                    selectinload(ProductionPartInstance.slots).options(
                        _ACTIVE_FILE_WITH_TAGS,
                        selectinload(ProductionSlot.revisions),
                    ),
                )
            )
        )
        .scalars()
        .all()
    )
    instances = sorted(
        instances,
        key=lambda inst: (_DEFAULT_CODE_ORDER.get(inst.part.code, 1000), inst.part.code),
    )

    refreshed = False
    part_views: list[ProductionPartView] = []
    for inst in instances:
        slots = _unique_slots(inst.slots)
        if _refresh_locked_fuzzy_from_active_file(inst, slots):
            refreshed = True
        part_views.append(_part_view(inst))
    if refreshed:
        await db.commit()

    return ProductionFolderView(
        folder_id=folder.id,
        printer_model=folder.production_printer_model or "",
        section_id=folder.section_id,
        parts=part_views,
    )


@router.post("/slots", response_model=ProductionSlotResponse)
async def create_slot(
    file: UploadFile = File(...),
    folder_id: int | None = Form(None),
    code: str | None = Form(None),
    quantity: int | None = Form(None),
    major: int | None = Form(None),
    revision: int | None = Form(None),
    minor: int | None = Form(None),
    printer: str | None = Form(None),
    resolution: str | None = Form(None),
    reason: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPLOAD)),
):
    """Add a new production slot. Existing (instance, quantity) pairs must use replace."""
    await bootstrap_production(db)
    filename, content = await _read_upload(file)
    merged_code, merged_qty, merged_major, merged_revision, merged_minor, merged_printer, parsed = _merge_identity(
        filename,
        code=code,
        quantity=quantity,
        major=major,
        revision=revision,
        minor=minor,
        printer=printer,
    )
    folder = await _resolve_printer_folder(db, folder_id=folder_id, printer=merged_printer, parsed=parsed)

    part = await _get_or_create_part(db, merged_code)
    instance = await _find_part_instance(
        db,
        part_id=part.id,
        folder=folder,
    )

    if instance is not None:
        existing_slot = (
            await db.execute(
                select(ProductionSlot).where(
                    ProductionSlot.instance_id == instance.id,
                    ProductionSlot.quantity == merged_qty,
                )
            )
        ).scalar_one_or_none()
        if existing_slot is not None:
            raise HTTPException(status_code=409, detail=_SLOT_EXISTS_DETAIL)

    incoming_settings = extract_production_settings(content)
    if instance is None:
        instance = ProductionPartInstance(
            part_id=part.id,
            printer_model=_instance_printer_model(folder, merged_printer),
            folder_id=folder.id,
            locked_parameters=incoming_settings,
            hidden=False,
        )
        db.add(instance)
        await db.flush()
        mismatch = False
        accepted_new_baseline = True
    else:
        instance.hidden = False
        mismatch, accepted_new_baseline = _apply_shared_contract(instance, incoming_settings, resolution)

    stored_name = _stored_upload_filename(
        filename,
        code=merged_code,
        quantity=merged_qty,
        major=merged_major,
        revision=merged_revision,
        minor=merged_minor,
        printer=merged_printer,
    )
    library_file = await _save_library_file(
        db,
        content=content,
        filename=stored_name,
        folder=folder,
        owner_id=current_user.id if current_user else None,
    )

    slot = ProductionSlot(
        instance_id=instance.id,
        quantity=merged_qty,
        active_file_id=library_file.id,
        major=merged_major,
        revision=merged_revision,
        minor=merged_minor,
    )
    db.add(slot)
    await db.flush()

    revision_row = ProductionRevision(
        slot_id=slot.id,
        library_file_id=library_file.id,
        major=merged_major,
        revision=merged_revision,
        minor=merged_minor,
        parameters=incoming_settings,
        mismatch=mismatch,
        accepted_new_baseline=accepted_new_baseline,
        reason=reason,
        created_by_id=current_user.id if current_user else None,
        created_at=datetime.now(timezone.utc),
    )
    db.add(revision_row)
    await db.flush()
    return _slot_response(slot, instance, part, latest=revision_row, active_file=library_file)


@router.post("/slots/preview", response_model=ProductionReplacePreview)
async def preview_create_slot(
    file: UploadFile = File(...),
    folder_id: int | None = Form(None),
    code: str | None = Form(None),
    quantity: int | None = Form(None),
    major: int | None = Form(None),
    revision: int | None = Form(None),
    minor: int | None = Form(None),
    printer: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.LIBRARY_READ_ALL,
            Permission.LIBRARY_READ_OWN,
        )
    ),
):
    """Compare an incoming first-or-next quantity file against the shared part contract."""
    await bootstrap_production(db)
    filename, content = await _read_upload(file)
    merged_code, _merged_qty, _major, _revision, _minor, merged_printer, parsed = _merge_identity(
        filename,
        code=code,
        quantity=quantity,
        major=major,
        revision=revision,
        minor=minor,
        printer=printer,
    )
    folder = await _resolve_printer_folder(db, folder_id=folder_id, printer=merged_printer, parsed=parsed)
    part = await _get_part_by_code(db, merged_code)
    instance = None
    if part is not None:
        instance = await _find_part_instance(
            db,
            part_id=part.id,
            folder=folder,
            load_slots=True,
        )
    return _settings_preview(instance=instance, folder=folder, filename=filename, content=content)


@router.post("/folders/{folder_id}/parts", response_model=ProductionPartView)
async def add_folder_part(
    folder_id: int,
    body: ProductionPartCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPLOAD)),
):
    """Add or un-hide a catalog part on this printer only."""
    await bootstrap_production(db)
    folder = await _load_production_folder(db, folder_id)
    code, name = _normalize_part_identity(body.code, body.name)
    part = await _get_or_create_part(db, code, name)
    instance = await _find_part_instance(
        db,
        part_id=part.id,
        folder=folder,
        load_slots=True,
    )
    if instance is not None and not instance.hidden:
        raise HTTPException(status_code=409, detail=_PART_ALREADY_VISIBLE)
    if instance is None:
        instance = ProductionPartInstance(
            part_id=part.id,
            printer_model=_instance_printer_model(folder),
            folder_id=folder.id,
            locked_parameters=None,
            hidden=False,
        )
        db.add(instance)
        await db.flush()
        return ProductionPartView(
            id=part.id,
            code=part.code,
            name=part.name,
            instance_id=instance.id,
            locked_parameters=None,
            slots=[],
        )
    instance.hidden = False
    await db.flush()
    return _part_view(instance)


@router.delete("/folders/{folder_id}/parts/{part_id}", response_model=ProductionPartRemoveResponse)
async def remove_folder_part(
    folder_id: int,
    part_id: int,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.LIBRARY_DELETE_ALL,
            Permission.LIBRARY_DELETE_OWN,
        )
    ),
):
    """Hide a part on this printer. Slot files go to trash; the instance/contract is kept."""
    user, can_modify_all = auth_result
    folder = await _load_production_folder(db, folder_id)
    instance = (
        await db.execute(
            select(ProductionPartInstance)
            .where(
                ProductionPartInstance.folder_id == folder.id,
                ProductionPartInstance.part_id == part_id,
                ProductionPartInstance.hidden.is_(False),
            )
            .options(
                selectinload(ProductionPartInstance.slots).options(
                    selectinload(ProductionSlot.revisions),
                    _ACTIVE_FILE_WITH_TAGS,
                ),
            )
        )
    ).scalar_one_or_none()
    if instance is None:
        raise HTTPException(status_code=404, detail="Part is not on this printer")

    slots = _unique_slots(instance.slots)
    file_ids: set[int] = set()
    for slot in slots:
        file_ids |= _slot_library_file_ids(slot)
    files: list[LibraryFile] = []
    if file_ids:
        files = list((await db.execute(select(LibraryFile).where(LibraryFile.id.in_(file_ids)))).scalars().all())
    if slots:
        if files:
            _assert_can_delete_slot_files(user=user, can_modify_all=can_modify_all, files=files, slot=slots[0])
        else:
            for slot in slots:
                _assert_can_delete_slot_files(user=user, can_modify_all=can_modify_all, files=[], slot=slot)

    for slot in slots:
        await db.delete(slot)
    instance.hidden = True
    await db.flush()
    await _trash_library_files(db, files)
    await db.flush()
    return ProductionPartRemoveResponse(removed=True, files_trashed=len(files))


@router.post("/slots/{slot_id}/preview-replace", response_model=ProductionReplacePreview)
async def preview_replace(
    slot_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.LIBRARY_READ_ALL,
            Permission.LIBRARY_READ_OWN,
        )
    ),
):
    """Compare an incoming file against the slot contract without committing."""
    slot = await _load_slot(db, slot_id)
    instance = slot.instance
    folder = instance.folder
    filename, content = await _read_upload(file)
    parsed = parse_production_filename(filename)

    current_version = _format_version(slot.major, slot.revision, slot.minor)
    suggested = suggest_next_revision(slot.major, slot.revision, slot.minor)
    incoming_version = _format_version(parsed.major, parsed.revision, parsed.minor) if parsed else None
    version_is_newer = bool(parsed) and is_newer(parsed, (slot.major, slot.revision, slot.minor))

    folder_printer = (folder.production_printer_model if folder else instance.printer_model) or ""
    printer_matches = (
        _printer_matches_folder(folder, parsed.printer if parsed else None)
        if folder is not None
        else parsed is not None and parsed.printer == folder_printer
    )

    incoming_settings = extract_production_settings(content)
    diff = diff_parameters(instance.locked_parameters or {}, incoming_settings)

    return ProductionReplacePreview(
        parsed_filename=_parsed_out(parsed) if parsed else None,
        current_version=current_version,
        incoming_version=incoming_version,
        version_is_newer=version_is_newer,
        suggested_next_version=_format_version(*suggested),
        parameter_diff=[ProductionParameterDiff(**row) for row in diff],
        has_mismatches=_has_mismatches(diff),
        printer_matches_folder=printer_matches,
    )


@router.post("/slots/{slot_id}/replace", response_model=ProductionSlotResponse)
async def replace_slot(
    slot_id: int,
    file: UploadFile = File(...),
    resolution: str = Form(...),
    reason: str | None = Form(None),
    code: str | None = Form(None),
    quantity: int | None = Form(None),
    major: int | None = Form(None),
    revision: int | None = Form(None),
    minor: int | None = Form(None),
    printer: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPLOAD)),
):
    """Replace a slot's active file. Old library files are kept."""
    if resolution not in _VALID_RESOLUTIONS:
        raise HTTPException(status_code=400, detail="resolution must be 'proceed' or 'accept_baseline'")

    slot = await _load_slot(db, slot_id)
    instance = slot.instance
    part = instance.part
    folder = instance.folder
    if folder is None:
        raise HTTPException(status_code=400, detail="Production instance has no folder")

    filename, content = await _read_upload(file)
    parsed = parse_production_filename(filename)
    if parsed is not None and not _printer_matches_folder(folder, parsed.printer):
        folder_printer = _folder_printer(folder) or ""
        raise HTTPException(
            status_code=400,
            detail=f"Filename printer {parsed.printer} does not match folder printer {folder_printer}",
        )

    form_printer = _form_printer(printer)
    folder_printer = _folder_printer(folder)
    printer_raw = form_printer or (parsed.printer if parsed else None) or folder_printer or instance.printer_model
    merged_code = _form_code(code) or part.code
    merged_qty = quantity if quantity is not None else slot.quantity
    merged_major = major if major is not None else (parsed.major if parsed else slot.major)
    merged_revision = revision if revision is not None else (parsed.revision if parsed else slot.revision)
    merged_minor = minor if minor is not None else (parsed.minor if parsed else slot.minor)
    merged_printer = normalize_production_printer(printer_raw) if printer_raw else ""
    if not merged_printer:
        raise HTTPException(status_code=400, detail="Missing required production identity: printer")
    if merged_qty < 1:
        raise HTTPException(status_code=400, detail="quantity must be at least 1")

    incoming_settings = extract_production_settings(content)
    diff = diff_parameters(instance.locked_parameters or {}, incoming_settings)
    mismatches = _has_mismatches(diff)
    accept_baseline = resolution == "accept_baseline"

    stored_name = _stored_upload_filename(
        filename,
        code=merged_code,
        quantity=merged_qty,
        major=merged_major,
        revision=merged_revision,
        minor=merged_minor,
        printer=merged_printer,
    )
    library_file = await _save_library_file(
        db,
        content=content,
        filename=stored_name,
        folder=folder,
        owner_id=current_user.id if current_user else None,
    )

    now = datetime.now(timezone.utc)
    for previous in slot.revisions:
        if previous.superseded_at is None:
            previous.superseded_at = now

    if accept_baseline:
        instance.locked_parameters = incoming_settings
        mismatch = False
    else:
        mismatch = mismatches

    slot.active_file_id = library_file.id
    slot.major = merged_major
    slot.revision = merged_revision
    slot.minor = merged_minor
    slot.active_file = library_file

    revision_row = ProductionRevision(
        slot_id=slot.id,
        library_file_id=library_file.id,
        major=merged_major,
        revision=merged_revision,
        minor=merged_minor,
        parameters=incoming_settings,
        mismatch=mismatch,
        accepted_new_baseline=accept_baseline,
        reason=reason,
        created_by_id=current_user.id if current_user else None,
        created_at=datetime.now(timezone.utc),
    )
    db.add(revision_row)
    await db.flush()
    return _slot_response(slot, instance, part, latest=revision_row, active_file=library_file)


@router.delete("/slots/{slot_id}")
async def delete_slot(
    slot_id: int,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.LIBRARY_DELETE_ALL,
            Permission.LIBRARY_DELETE_OWN,
        )
    ),
):
    """Remove a production slot and trash its active file plus revision history files.

    The part instance and locked_parameters are kept so a later add of the same
    part on this printer still has the contract. Managed library files go to
    File Manager trash (``deleted_at``); restore is possible from /files/trash.
    """
    user, can_modify_all = auth_result
    slot = await _load_slot(db, slot_id)
    file_ids = _slot_library_file_ids(slot)
    files: list[LibraryFile] = []
    if file_ids:
        files = list((await db.execute(select(LibraryFile).where(LibraryFile.id.in_(file_ids)))).scalars().all())
    _assert_can_delete_slot_files(user=user, can_modify_all=can_modify_all, files=files, slot=slot)

    await db.delete(slot)
    await db.flush()
    await _trash_library_files(db, files)
    await db.flush()
    return {"deleted": True}


@router.get("/slots/{slot_id}/history", response_model=list[ProductionRevisionResponse])
async def slot_history(
    slot_id: int,
    db: AsyncSession = Depends(get_db),
    _: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.LIBRARY_READ_ALL,
            Permission.LIBRARY_READ_OWN,
        )
    ),
):
    """List a slot's revisions, newest first."""
    slot = (await db.execute(select(ProductionSlot.id).where(ProductionSlot.id == slot_id))).scalar_one_or_none()
    if slot is None:
        raise HTTPException(status_code=404, detail="Production slot not found")

    revisions = (
        (
            await db.execute(
                select(ProductionRevision)
                .where(ProductionRevision.slot_id == slot_id)
                .options(selectinload(ProductionRevision.library_file))
                .order_by(ProductionRevision.created_at.desc(), ProductionRevision.id.desc())
            )
        )
        .scalars()
        .all()
    )
    return [
        ProductionRevisionResponse(
            version=_format_version(row.major, row.revision, row.minor),
            filename=row.library_file.filename if row.library_file else None,
            mismatch=row.mismatch,
            accepted_new_baseline=row.accepted_new_baseline,
            reason=row.reason,
            created_at=row.created_at,
            file_id=row.library_file_id,
        )
        for row in revisions
    ]
