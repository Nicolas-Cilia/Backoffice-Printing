"""Production file-slot HTTP API: bootstrap, folder view, add, preview, replace, history."""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select
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
from backend.app.schemas.production import (
    ParsedProductionFilenameOut,
    ProductionActiveFile,
    ProductionBootstrapResponse,
    ProductionFolderSummary,
    ProductionFolderView,
    ProductionParameterDiff,
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
    )


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
    """Parse the filename, then fill any missing identity fields from the form."""
    parsed = parse_production_filename(filename)
    merged_code = (parsed.code if parsed else None) or _form_code(code)
    merged_qty = parsed.quantity if parsed else quantity
    merged_major = parsed.major if parsed else major
    merged_revision = parsed.revision if parsed else revision
    merged_minor = parsed.minor if parsed else minor
    printer_raw = (parsed.printer if parsed else None) or printer
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


async def _load_production_folder(db: AsyncSession, folder_id: int) -> LibraryFolder:
    folder = (await db.execute(select(LibraryFolder).where(LibraryFolder.id == folder_id))).scalar_one_or_none()
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    if not folder.production_printer_model:
        raise HTTPException(status_code=400, detail="Folder is not a production printer folder")
    return folder


async def _resolve_printer_folder(
    db: AsyncSession,
    *,
    folder_id: int | None,
    printer: str,
    parsed: ParsedProductionFilename | None,
) -> LibraryFolder:
    if folder_id is not None:
        folder = await _load_production_folder(db, folder_id)
        folder_printer = folder.production_printer_model or ""
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


async def _get_or_create_part(db: AsyncSession, code: str) -> ProductionPart:
    part = (await db.execute(select(ProductionPart).where(ProductionPart.code == code))).scalar_one_or_none()
    if part is not None:
        return part
    part = ProductionPart(code=code, name=_DEFAULT_PART_NAMES.get(code, code.title()))
    db.add(part)
    await db.flush()
    return part


async def _load_slot(db: AsyncSession, slot_id: int) -> ProductionSlot:
    slot = (
        await db.execute(
            select(ProductionSlot)
            .where(ProductionSlot.id == slot_id)
            .options(
                selectinload(ProductionSlot.active_file),
                selectinload(ProductionSlot.revisions),
                selectinload(ProductionSlot.instance).selectinload(ProductionPartInstance.part),
                selectinload(ProductionSlot.instance).selectinload(ProductionPartInstance.folder),
            )
        )
    ).scalar_one_or_none()
    if slot is None:
        raise HTTPException(status_code=404, detail="Production slot not found")
    return slot


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
    """Return catalog parts with this printer folder's instances and slots."""
    await bootstrap_production(db)
    folder = await _load_production_folder(db, folder_id)

    parts = (await db.execute(select(ProductionPart))).scalars().all()
    parts = sorted(parts, key=lambda p: (_DEFAULT_CODE_ORDER.get(p.code, 1000), p.code))

    instances = (
        (
            await db.execute(
                select(ProductionPartInstance)
                .where(ProductionPartInstance.folder_id == folder.id)
                .options(
                    selectinload(ProductionPartInstance.slots).selectinload(ProductionSlot.active_file),
                    selectinload(ProductionPartInstance.slots).selectinload(ProductionSlot.revisions),
                )
            )
        )
        .scalars()
        .all()
    )
    instance_by_part = {inst.part_id: inst for inst in instances}

    part_views: list[ProductionPartView] = []
    for part in parts:
        instance = instance_by_part.get(part.id)
        slots = sorted(instance.slots, key=lambda s: s.quantity) if instance else []
        part_views.append(
            ProductionPartView(
                id=part.id,
                code=part.code,
                name=part.name,
                instance_id=instance.id if instance else None,
                locked_parameters=instance.locked_parameters if instance else None,
                slots=[_slot_nested(slot) for slot in slots],
            )
        )

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
    instance = (
        await db.execute(
            select(ProductionPartInstance).where(
                ProductionPartInstance.part_id == part.id,
                ProductionPartInstance.printer_model == folder.production_printer_model,
            )
        )
    ).scalar_one_or_none()

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
            printer_model=folder.production_printer_model or merged_printer,
            folder_id=folder.id,
            locked_parameters=incoming_settings,
        )
        db.add(instance)
        await db.flush()

    library_file = await _save_library_file(
        db,
        content=content,
        filename=filename,
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
        mismatch=False,
        accepted_new_baseline=True,
        created_by_id=current_user.id if current_user else None,
        created_at=datetime.now(timezone.utc),
    )
    db.add(revision_row)
    await db.flush()
    return _slot_response(slot, instance, part, latest=revision_row, active_file=library_file)


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
    printer_matches = parsed is not None and parsed.printer == folder_printer

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
    major: int | None = Form(None),
    revision: int | None = Form(None),
    minor: int | None = Form(None),
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
    folder_printer = folder.production_printer_model or instance.printer_model
    if parsed is not None and parsed.printer != folder_printer:
        raise HTTPException(
            status_code=400,
            detail=f"Filename printer {parsed.printer} does not match folder printer {folder_printer}",
        )

    merged_major = major if major is not None else (parsed.major if parsed else None)
    merged_revision = revision if revision is not None else (parsed.revision if parsed else None)
    merged_minor = minor if minor is not None else (parsed.minor if parsed else None)
    if merged_major is None or merged_revision is None or merged_minor is None:
        raise HTTPException(status_code=400, detail="Missing required production identity: version")

    incoming_settings = extract_production_settings(content)
    diff = diff_parameters(instance.locked_parameters or {}, incoming_settings)
    mismatches = _has_mismatches(diff)
    accept_baseline = resolution == "accept_baseline"

    library_file = await _save_library_file(
        db,
        content=content,
        filename=filename,
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
