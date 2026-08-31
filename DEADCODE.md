# Dead Code Audit Report

## Summary

Initial audit found ~6,200 LOC of confirmed-unused code. **Highest-confidence orphans have been deleted** in this cleanup pass (~4,500+ LOC). Lower-confidence items (unused frontend API client wrappers; test-only utilities with dedicated unit tests) remain listed below for a follow-up.

| Status | Category |
|--------|----------|
| **Deleted** | Orphan FE modules + tests, scaffold SVGs, `backend/app/i18n`, SpoolBuddy `tag_parser`, `FTPTLSProxy`, `VirtualPrinterMQTTServer`, unused helpers/schemas/exports |
| **Deferred** | ~117 unused `api.*` client methods, `pendingUploadsApi`, test-only helpers (`assert_under`, `get_trace_id`, etc.) |

---

## Deleted in this pass

### Frontend files removed

- `components/BackupModal.tsx` (+ test)
- `components/CalendarView.tsx`
- `components/RestoreModal.tsx` (+ test)
- `components/VirtualPrinterSettings.tsx` (+ test)
- `components/PrintLogModal.tsx` (+ test)
- `components/PrintLogTable.tsx`
- `components/spoolbuddy/TagDetectedModal.tsx` (+ test)
- `components/spoolbuddy/WeightDisplay.tsx` (+ test)
- `hooks/useLongPress.ts` (+ test)
- `utils/filamentPresets.ts` (+ test)
- `assets/react.svg`, `public/vite.svg`

### Frontend symbols removed (files kept)

- `utils/date.ts`: `formatMediaTime`, `formatDurationFromHours`
- `utils/amsHelpers.ts`: `getMinDateTime`
- `utils/slicer.ts`: `openArchiveInSlicer`
- `utils/preheatFilamentTargets.ts`: `normalizePreheatFilamentType`, `deriveChamberTargetForTrays`
- `utils/productionFilename.ts`: `PRODUCTION_PRINTER_MODELS`
- `hooks/useCameraStreamToken.ts`: `useCameraStreamToken`
- `pages/CameraTokensPage.tsx`: default export wrapper (tests now use `CameraTokensSection`)

### Backend / SpoolBuddy removed

- Entire `backend/app/i18n/` package
- `spoolbuddy/daemon/tag_parser.py` (+ test)
- `FTPTLSProxy` (~628 LOC) from `virtual_printer/tcp_proxy.py`
- `VirtualPrinterMQTTServer` (~133 LOC) from `virtual_printer/mqtt_server.py`
- Unused helpers: `record_slot_usage`, `family_color_name`, `seed_printer_folder_defaults`, `count_spools_at_location_by_name`, `convert_ams_slot_to_location`, `get_other_interfaces`, `build_camera_url`, `active_broadcaster_keys`, `_validate_camera_url`, `_luminance`, `_ams_id_from_global`, `RequireAdmin`, `RequirePermission`
- Unused types: `SpoolmanSpool`, `SpoolmanFilament`, `FileCreate`, `ProjectPageUpdate`, notification `*Config` schemas, `TemplateVariableInfo`, `EmailOTPEnableRequest`, `PurgePreviewRequest`, `PrinterMaintenanceBase`/`Create`, `MaintenanceHistoryCreate`

---

## Remaining (deferred — not deleted)

### Frontend API client (~690 LOC)

Unused `api.*` methods (~117), `pendingUploadsApi`, `discoveryApi.getStatus`, `spoolbuddyApi.getCalibration`.  
Safe for this UI, but may be intentional client SDK surface or used outside the repo.

### Backend helpers only exercised by unit tests

| Symbol | File |
|--------|------|
| `assert_under` | `utils/safe_path.py` |
| `clear_plate_metadata_cache` | `utils/threemf_tools.py` |
| `extract_bed_type_from_3mf` | `utils/threemf_tools.py` |
| `active_task_count` | `core/tasks.py` |
| `get_trace_id` | `core/trace.py` |
| `run_pragma` | `core/db_dialect.py` |

Deleting these requires updating/removing their dedicated tests.

### Explicitly excluded

- Stock-alert firing methods (`on_stock_reorder_alert` / `on_stock_break_alert`) — UI/DB still wire them
- Backend `/pending-uploads` routes — live API entry points
- Ops `scripts/*.py`
- Orphaned i18n keys overlapping live `backup.*` (needs careful key-diff)

---

## Verification Notes

- Targeted Vitest: `CameraTokensPage`, `useCameraStreamToken`, `AppRoutes`, `productionFilename` — **36/36 passed**
- Python `compileall` on all edited backend modules — **OK**
- Removed unused `random` import left behind by `FTPTLSProxy` deletion
- Did **not** remove unused API client wrappers in this pass

---

## Estimated Impact

| Bucket | ~LOC |
|--------|------|
| Deleted this pass | **~4,500+** |
| Remaining deferred | **~800–1,000** |
