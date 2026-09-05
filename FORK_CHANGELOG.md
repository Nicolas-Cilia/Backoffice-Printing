# Fork Changelog

Changes made in this fork on top of upstream Bambuddy. Upstream's own release notes stay
in `CHANGELOG.md`. Planned work lives in `FORK_PLAN.md`.

## 2026-09-04: CI runs on `dev` pushes and pull requests

`ci.yml` only triggered on `main`, so a PR against `dev` — the integration branch every
change goes through first — ran nothing but the weekly security scans. It now also runs
on pushes and pull requests to `dev`. The "skip for repo owner" comment in the workflow
has no matching condition, so nothing else changes.
## 2026-09-04: Stats 2 line-start guide no longer leaves a ghost row after a what-if reset

User-reported bug: run a what-if ask large enough to add virtual printer lanes, then
Reset to capacity. The virtual lanes disappear but an empty row stays at the bottom of
the weekly schedule, and the blue line-start guide keeps running through it (with a
stray scrollbar when the list is short enough not to nest-scroll).

Root cause: the guide's height came from `scrollHeight` of the lane container, and the
guide was an absolutely positioned child of that same container with that measured
height. Once the container had grown for the extra lanes, the guide itself held it open,
so the measurement could never shrink — a self-referential ratchet.

Fix: the measured ref now wraps only the lane rows (`offsetHeight`), and the guide sits
in a sibling positioning box, so removing lanes shrinks the guide with them. No API or
data changes.

## 2026-08-23: Filament tracking donut rings keep rounded caps on small slices

User-reported bug from a full-project audit: on Filament Tracking's "Consumption by
printer" donut, slices below a fixed 18° threshold got `cornerRadius: 0` and rendered
with square caps instead of round ones. The old fix (a hard threshold) traded "square
caps on tiny slices" for "square caps on tiny slices below 18°" — same failure, smaller
range.

Root cause: Recharts' `Sector` spends `asin(cornerRadius / (innerRadius ± cornerRadius))`
degrees of arc rounding each corner (`getTangentCircle` in its `Sector.js`). When a
slice's arc can't fit both corners at the requested radius, `getSectorWithCorner`
silently falls back to a square-edged path — there is no partial rounding built in.
`ringCornerRadiusForArc` now solves that inequality for the largest `cornerRadius` the
slice's arc actually supports (bounded by the chart's known ~49px inner ring radius) and
shrinks smoothly toward it instead of snapping to 0, so every nonzero slice keeps fully
rounded caps.

### Changes

- `frontend/src/pages/filamentTrackingChart.ts`: replaced the `MIN_SLICE_ANGLE_FOR_CORNER`
  threshold with `ringCornerRadiusForArc`, a geometric clamp derived from Recharts' own
  corner-tangent formula.
- `frontend/src/__tests__/pages/FilamentTrackingPage.test.tsx`: replaced the threshold
  test with one asserting tiny slices get `0 < cornerRadius < RING_CORNER` (not 0), plus a
  geometric invariant test that the chosen radius never exceeds what the slice's arc can
  fit, checked across the full 0.5°–30° range against the rendered chart's known inner
  radius.

### Verified

- Frontend: full vitest suite (2685 tests, 197 files) passes; `tsc --noEmit` and eslint
  clean on touched files; production `vite build` succeeds.
- Not re-verified visually in a browser — the fix is a pure function change backed by a
  geometric proof test against Recharts' actual corner-rounding formula, not a UI
  screenshot.

## 2026-08-23: Gzip compression for JSON and SPA bundle

Found during a full-project performance audit: the standard deploy exposes uvicorn
directly (no reverse proxy layer), and nothing in the app compressed responses — every
JSON payload and the multi-megabyte frontend bundle crossed the wire raw. Measured on a
live instance: `/openapi.json` 981 KB → 126 KB, the main JS chunk 8.4 MB → 2.3 MB.

`PathAwareGZipMiddleware` wraps starlette's `GZipMiddleware` (minimum size 1 KB, zlib
level 6) with a deterministic path bypass for routes where gzip is useless or harmful:
camera MJPEG streams and the SSE color-sync feed (per-chunk latency for zero gain),
thumbnails/covers/photos/timelapse (already-compressed bytes, Range semantics), and
file downloads (3MF/zip containers, keep `Content-Length` for progress bars). It is
registered before the `@app.middleware` decorators so it runs innermost, seeing each
route's real `Content-Length` — outermost placement sat behind the BaseHTTPMiddleware
layers and force-gzipped even 20-byte health checks. Verified end-to-end against a
running instance: large JSON gzipped with accurate `Content-Length` and
`Vary: Accept-Encoding`, tiny JSON left identity, excluded media paths untouched.

### Changes

- `backend/app/core/compression.py`: new — path-aware gzip middleware and exclusion list.
- `backend/app/main.py`: register `PathAwareGZipMiddleware` innermost, before the
  middleware decorators.
- `backend/tests/unit/test_gzip_compression.py`: new — compression, minimum-size,
  identity, and exclusion contracts.

## 2026-08-19: GitHub docs rewritten for this fork

Fork plan entry #7. The five GitHub community tabs now describe this personal rework
instead of upstream Bambuddy: what it is, who wrote most of it, how it runs today, and
that it is not affiliated with or endorsed by maziggy/bambuddy.

`README.md` keeps Bambuddy's shape (logo, pitch, tools, how to run, license) and
replaces the content. Fork notice sits high on the page. Tools match the current
sidebar. Native Mac (venv + uvicorn :8000, Vite :5173 in dev) is the path that works;
Docker Compose `up -d --build` from this repo is documented as a first-class intended
path, without promising unpublished GHCR/Docker Hub tags, daily betas, or Watchtower.
Screenshot gallery, Discord, sponsors, wiki, live demo, Proxy Mode, Virtual Printers,
slicer-api, pipelines, Archives, MakerWorld, Projects, smart plugs, and in-app Update
are not advertised.

`CONTRIBUTING.md` is how this checkout is developed (clone, uvicorn, Vite, compose
`--build`, Ruff, ESLint, i18n, tests). It does not recruit contributors or document
an image-publish pipeline. `CODE_OF_CONDUCT.md` applies to this repository and reports
on GitHub. `SECURITY.md` points private advisories at this repo, drops SLAs and the
0.1.x/0.2.x support table, and keeps the CI security-stance rules.

`LICENSE` was not touched. In-app GitHub URLs / `GITHUB_REPO` are entry #6.

### Changes

- `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`: rewritten.
- `FORK_PLAN.md`: entry #7 marked done on `docs/fork-attribution`.

## 2026-08-19: Download local print profiles

Fork plan entry #15. Local presets can be downloaded from Profiles →
Local Profiles. `GET /local-presets/{id}/download` returns the stored
resolved `setting` JSON with `Content-Disposition: attachment` and a
sanitized `{name}.json` filename (re-importable via the existing
import). Download icon sits next to delete on Unfiled process cards,
filament/printer cards, and part-section slot cards. Read permission
is enough. Bambu `.bbscfg` wrapping and section-as-zip were skipped.

The page-level **Import Profiles** drop zone is gone — it dumped files
into Unfiled. **Upload process** on each part section still imports
and attaches. Slot **Replace** now opens a file picker (same accept
list) and `POST .../sections/{id}/import?slot_id=` so the occupied
printer is replaced, not doubled; mismatch still uses Proceed /
Accept baseline.

### Verified

- Integration: download returns JSON body + filename header; unsafe
  names sanitized; missing id is 404. Section import with `slot_id`
  returns `needs_replace` for that slot and does not add a second slot.
- LocalProfilesView vitest: download control on Unfiled/filament cards
  and part-section slots; click calls `downloadLocalPreset`. Import
  drop zone gone. Slot Replace uploads a file (no “Choose a process
  preset” picker); section Upload process still opens replace-confirm.

### Not run here

Docker, live browser, production frontend build / `static/assets` refresh.

## 2026-08-18: Unfiled processes (replace All processes)

Fork plan entry #15. The Profiles process column is now **Unfiled
processes**: process presets that are not `active_preset_id` on any
part-section slot (client-side: `getLocalPresets().process` minus
preset ids on `getProfilePartSections()` slots). The user picks an
existing section to move into — matching / first-in-empty-section
attaches immediately; mismatch uses Proceed anyway / **Don't move**;
an occupied printer slot opens the existing Replace flow. H2D/H2S
0.24 vs a thicker locked spec is a match (same cap as add/upload).
Filament and printer columns are unchanged.

### Verified

- LocalProfilesView vitest: All processes gone; Unfiled heading +
  collapsed list; filed process omitted; move picker; match attaches;
  occupied slot opens Replace; mismatch shows Don't move.

### Not run here

Docker, live browser, production frontend build / `static/assets` refresh.

## 2026-08-18: H2D/H2S layer-height cap on part sections

Fork plan entry #15. H2D, H2S, and H2D Pro max out at 0.24 mm layer
height. When a part-section baseline is thicker (e.g. 0.28 from X1C), an
incoming process at 0.24 **matches spec** — that printer's equivalent of
the spec, not a skip of the key. Anything other than 0.24 when locked
> 0.24 is still a mismatch; 0.24 vs a locked 0.20 is a mismatch. X1C /
A1 / P1S stay strict. Implemented as optional `printer_model` on
`diff_parameters` (default `None`), so File Manager production 3MF
tracking is unchanged. Combo plates still out of scope.

### Verified

- Unit: H2S/H2D/H2D Pro 0.24 vs locked 0.28 match; H2S 0.16 vs 0.28
  mismatch; X1C/A1/P1S 0.24 vs 0.28 mismatch; H2S 0.24 vs locked 0.20
  mismatch; equal 0.24 still matches.
- Integration: add and upload of H2S 0.24 onto a 0.28-seeded section
  attach as match (no Don't upload / Proceed). H2S 0.16 still needs
  Proceed anyway.

### Not run here

Docker, live browser, production frontend build / `static/assets` refresh.

### Changes

- `backend/app/services/production_settings.py`: `LAYER_HEIGHT_CAPS` and
  `diff_parameters(..., printer_model=None)`.
- `backend/app/api/routes/profile_parts.py`: pass the incoming slot's
  `printer_model` into add / upload / replace / preview diffs.

## 2026-08-18: Profile part process sections + replace/diff + upload

Fork plan entry #15b. Profiles can group process presets into user-named
**part process sections** (example: "Top part") with one slot per printer.
The first attached process seeds the section `locked_parameters` via
`extract_from_process_settings`. Later adds and replaces `diff_parameters`
against that baseline — same `CONTRACT_KEYS` as File Manager production.
Replace preview shows the diff; **Proceed** keeps the baseline and marks
mismatch; **Accept new baseline** writes the incoming contract onto the
section and recomputes other slots.

Upload a process file (`.json`, `.bbscfg`, `.zip`, same accept list as
Profiles import) directly onto a section:
`POST /api/v1/profile-parts/sections/{id}/import`. All preset types in the
archive are imported, but only process presets attach. Filament/printer-only
files return 400. Duplicate library names **update** the existing row on this
path (page-level import still skips). Uploading onto an occupied printer
returns `needs_replace` with a preview; the UI opens the existing Replace
modal (Proceed / Accept baseline) — no second slot.

Matches spec / mismatch chips on printer slots open the same Current print
specs panel as File Manager (`mergeProductionSpecs` of section
`locked_parameters` + slot overrides).

Isolated tables (`profile_part_sections` / `_slots` / `_revisions`). Does not
reuse the production TOP/KNB/BOT catalog and does not auto-seed those codes.
Filament/printer library columns are unchanged. Combo plates out of scope.

### Verified

- Backend integration: seed / mismatch / proceed / accept_baseline; upload
  into empty section; second-printer mismatch; same-printer `needs_replace`;
  filament-only 400; duplicate name updates and attaches; library import
  still skips duplicates.
- Frontend vitest: heading **Part process sections** / add **Add part
  process sections**; upload control; Matches spec chip opens Current print
  specs; `needs_replace` opens the replace modal.

### Not run here

Docker, live browser, production frontend build / `static/assets` refresh.

### Changes

- `backend/app/models/profile_part.py`, `schemas/profile_part.py`,
  `api/routes/profile_parts.py`, `services/profile_part_printer.py`,
  `services/orca_profiles.py` (`on_duplicate="update"` for section import only).
- `frontend/src/components/ProfilePartSections.tsx` plus client types/methods.
- LocalProfilesView shows part process sections above the three preset columns.

## 2026-08-18: Local preset source labels (Bambu Lab vs Orca Slicer)

Fork plan entry #15 source-label fix (not 15b/15c). Import hardcoded
`source="orcaslicer"`, so Bambu Studio presets displayed as "Orcaslicer".

Import now stores `bambu` for `.bbscfg`/`.bbsflmt` and for json/zip with `@BBL`,
Bambu Lab printer ids, or Bambu Studio fields. `.orca_filament` and clear Orca
markers stay `orcaslicer`. List/detail correct existing `orcaslicer` rows that
are clearly Bambu and persist the fix — no manual migration. UI shows
**Bambu Lab** and **Orca Slicer**.

### Changes

- `backend/app/services/orca_profiles.py`: `detect_preset_source` on import;
  `maybe_correct_local_preset_source` on list/detail.
- `frontend/src/components/LocalProfilesView.tsx` plus `sourceLabels` i18n.
- Unit tests for detection; local-presets API and LocalProfilesView label tests.

## 2026-08-18: Process preset print-settings chips

Profiles process cards had no view of the locked print-settings contract that File
Manager already extracts from production 3MFs. The same CONTRACT_KEYS loop now runs
against resolved process-preset JSON (not a zip), and list/detail responses include
`locked_parameters` without dumping the full `setting` blob on the list.

Process cards on the Profiles tab show File Manager-style compact spec chips and open
the same spec-row modal. Filament and printer cards are unchanged. Re-import mismatch
(proceed / accept-new-baseline) is not in this unit.

Verified: extract-from-process unit tests; local-presets API create/list/detail;
LocalProfilesView spec-summary vitest; full frontend vitest 2553 passed; backend
pytest 8259 passed (ignored `test_bambu_ftp.py`, no xdist). `tsc --noEmit` and
eslint on the touched frontend files are clean. Not run: frontend production
build, live browser pass, `ruff check` on all of `production_settings.py`
(pre-existing zip-only lint).

### Changes

- `backend/app/services/production_settings.py`: `extract_from_process_settings` plus
  shared `_contract_from_config` used by the 3MF zip path.
- `backend/app/schemas/local_preset.py`, `backend/app/api/routes/local_presets.py`:
  `locked_parameters` on process preset responses, computed on GET from `setting`.
- `frontend/src/api/client.ts`, `frontend/src/components/LocalProfilesView.tsx`:
  process-card spec chips and spec modal via `productionSpecs.ts`.
- Tests for process-JSON extract, local-presets API wiring, and process-card UI.

## 2026-08-18: Attach tags to library files

Tags already had a catalog (create / rename / delete) and a bulk-assign API,
but File Manager only surfaced attach/detach after multi-selecting files in a
folder. Creating a tag therefore felt disconnected from using it. The existing
`POST /library/tags/bulk-assign` route is enough — no new backend.

Each File Manager card has a labeled Tags control (not a hover-only plus), a
Tags overflow action, and a Tag button on the selection toolbar — including
Unfiled on the landing page. Production slot cards (A1/TOP, etc.) use the
same picker on the live library file. Save replaces that file's tags; chip X
removes one immediately. Multi-select still uses add/remove bulk assign.

Verified: BulkTagsPickerModal, File Manager, and ProductionFolderView tag
vitest; `check:i18n`. Not run: full backend suite, live browser pass.

### Changes

- `frontend/src/components/BulkTagsPickerModal.tsx`: single-file replace mode
  when tagging one file; bulk add/remove unchanged for multi-select.
- `frontend/src/pages/FileManagerPage.tsx`: per-file picker, labeled Tags chip,
  overflow Tags action, Tag button on the landing selection toolbar.
- `frontend/src/components/production/ProductionFolderView.tsx`: Tags on the
  active library file of a production slot.
- `backend/app/schemas/production.py`, `backend/app/api/routes/production.py`:
  include library tags on `active_file`.
- `frontend/src/i18n/locales/*.ts`: `fileManager.tags` strings for the picker.
- Tag vitest for File Manager and production folder view.

## 2026-08-18: Production file slots

Fork plan entry #14. Production parts need exactly one live 3MF per quantity slot so an
old revision cannot sit next to a new one and get printed by accident. File Manager
already had sections and printer-shaped folders; this adds a governed Production section
on top of that, implemented from the v1 spec on `feat/production-file-slots` (still
uncommitted).

Opening File Manager bootstraps a Production section with printer folders (`X1C`, `A1M`,
`A1`, `H2D`, `H2S`). Opening a tagged folder swaps the generic file grid for slot cards
and hides Upload / New Folder. Add parses `CODE [xQTY] - M.R.m - PRINTER` and requires
an explicit "this creates a new slot" confirmation. Replace extracts locked 3MF settings
(infill, brim, fuzzy skin, supports gated off when unused, H2D left/right/both), shows
the diff, and requires Proceed anyway or Accept as new baseline. A second active file
for the same slot 409s; so does a generic library upload/move into a production folder.

Deliberately not done (v2): combo plates where two parts on one plate have different
object-level settings.

Verified: production backend tests 36/36; library API 73/73 (folder bootstrap + 409
block); broader backend pytest 8191/8191 (xdist unavailable, so this was serial and
ignored `test_bambu_ftp.py` the same way `./test_backend.sh` does). Frontend: locale
parity, `tsc --noEmit`, production-related vitest 59/59, full vitest 2493/2493. `ruff
check` / `ruff format --check` clean on production-touched backend files.
`./test_backend.sh` itself did not complete: ruff format would reformat unrelated
`library_sections.py`, then pytest aborted on `-n`. Unused `afterEach`/`vi` imports in
`FileManagerPage.test.tsx` were removed so eslint errors on that file are gone; a
react-hooks warning remains in `ProductionFolderView`. Docker, security, bambu FTP, and
a frontend production build were not run. No live browser pass in this wrap-up unit —
UI coverage is the File Manager production-folder test plus the add/replace modal tests.

### Changes

- `backend/app/models/production.py`, `backend/app/models/__init__.py`: parts,
  printer-bound instances, quantity slots (one `active_file_id`), and revision history.
- `backend/app/models/library.py`, `backend/app/schemas/library.py`,
  `backend/app/core/database.py`: nullable `production_printer_model` on
  `library_folders`, added by the existing `run_migrations` path.
- `backend/app/services/production_filename.py`,
  `backend/app/services/production_settings.py`,
  `backend/app/services/production_bootstrap.py`: filename parse (A1 Mini → A1M;
  missing printer suffix rejected), 3MF contract extract/diff, idempotent section +
  folder + default parts (`TOP`/`BOT`/`KNB`/`BUT`).
- `backend/app/api/routes/production.py`, `backend/app/schemas/production.py`,
  `backend/app/main.py`: bootstrap, folder view, create slot, preview-replace, replace
  (proceed / accept-baseline), history.
- `backend/app/api/routes/library.py`: list-folders bootstraps Production; generic
  upload, zip extract, move, and folder-id update 409 into a production tree.
- `frontend/src/components/production/*`, `frontend/src/pages/FileManagerPage.tsx`,
  `frontend/src/utils/productionFilename.ts`, `frontend/src/api/client.ts`: slot grid,
  add/replace modals, client parser, API helpers.
- `frontend/src/i18n/locales/*.ts`: `fileManager.production` strings, locale-parity
  checked.
- Tests: backend unit/integration for parse, settings, bootstrap, migration, and the
  add/replace/409 flows; frontend parser (including `TOP - 1.13.2 - X1C`, `TOP x2`,
  A1M alias, missing suffix), modals, and File Manager production folder view.

## 2026-08-17: Removed in-app updating

Fork plan entry #10. This install is one Mac mini running natively (venv + uvicorn) and
is never distributed, so updating is a deliberate `git pull` on the host. The in-app
updater was therefore all risk and no benefit — and the risk was real: `POST
/updates/apply` ran `git fetch` followed by **`git reset --hard`** inside the app
directory, and before that rewrote `origin` whenever it did not already point at
`GITHUB_REPO`. One click of the update banner would have repointed the checkout at
upstream and discarded every fork change. It was manual-only, but the banner existed to
invite exactly that click.

`updates.py` goes from 931 lines to ~130. Gone: the release checker, the applier, the
progress endpoint, GitHub release polling and rate-limit tracking, Docker / HA-addon /
Windows-installer detection, and the git and pip subprocess drivers. **Nothing reachable
over HTTP can mutate the working tree any more.**

Kept, and worth noting because it nearly broke: `parse_version` and `is_newer_version`
are pure comparison helpers that `spoolbuddy.py` imports to decide whether an ESP
device's firmware is stale. That is *device* firmware, a different feature from app
self-updating, and removing them took the SpoolBuddy update-check endpoints down with a
503 until they were restored. `GET /updates/version` also stays — the sidebar and
Settings render it. Printer firmware checking (`check_printer_firmware`) is untouched.

Settings lose `check_updates` and `include_beta_updates`, since nothing checks any more.
The Settings "Updates" section keeps the current version and the printer-firmware toggle;
the check-now button, install button, release-notes modal and the per-deployment CTAs
(Docker compose snippet, HA Supervisor notice, Windows installer link) are gone, as are
the sidebar update button and the persistent update banner.

Deliberately not done, both belonging to entry #6: `GITHUB_REPO` still reads
`maziggy/bambuddy` — it now only labels the version response and nothing acts on it — and
`docker-compose.yml` still names upstream's ghcr image, which is inert on a native
install.

Verified: frontend suite (2492 tests), locale parity, `tsc --noEmit` and the backend
suite all pass; the version endpoint still answers and SpoolBuddy's device update checks
still work.

### Changes

- `backend/app/api/routes/updates.py`: reduced to `GET /updates/version` plus the two
  version-comparison helpers SpoolBuddy depends on.
- `backend/app/schemas/settings.py`, `backend/app/api/routes/settings.py`: dropped
  `check_updates` and `include_beta_updates`.
- `frontend/src/components/Layout.tsx`: removed the update-check query, the update banner
  and its dismissal state, both sidebar update buttons, and the `ArrowUpCircle` import.
- `frontend/src/pages/SettingsPage.tsx`: replaced the update panel with a version display;
  removed the update-status poller, the apply mutation and the release-notes modal.
- `frontend/src/api/client.ts`: removed `checkForUpdates`, `applyUpdate`,
  `getUpdateStatus`, the `UpdateCheckResult` / `UpdateStatus` types and the two settings
  fields.
- Tests: deleted `test_updates_api.py`; removed the HA-addon banner-suppression block from
  `Layout.test.tsx` and the deployment-shape CTA block from `SettingsPage.test.tsx`;
  repointed the settings-persistence test at `check_printer_firmware`; dropped the
  `projects` assertion from the system-info test and the four Project/BOM entries from the
  SSRF classification list (both leftovers from entry #3).

## 2026-08-17: Removed Projects (UI, API and models; tables kept)

Fork plan entry #3, layers 3a-3c. Projects is a data spine rather than a leaf feature, so
this went considerably deeper than the Archives removal: 26 backend files, ~240
`project_id` references, and 76 test files touched it.

**The tables were deliberately left in place.** With no Alembic, dropping a model never
drops its table, and wiping `projects` / `project_bom_items` would have meant writing
`DROP TABLE` code that destroys rows irreversibly. Both tables survive with their contents
intact and nothing reading them, so this is revertible with `git revert`. (For the record,
`projects` held 0 rows here, so nothing was ever at stake.) The bill-of-materials feature
goes with Projects, as agreed.

Deleting the `Project` model forced removing the `project_id` foreign keys from five other
models — `archive`, `library` (two), `pending_upload` and `print_queue` — because
SQLAlchemy raises on a FK pointing at a table that no longer exists in its metadata. Those
columns still exist in your database; they are simply no longer mapped.

**The migration code was the real hazard.** `_safe_execute` swallows only idempotency
errors and re-raises everything else, aborting startup. Roughly twenty
`ALTER TABLE projects …` statements would therefore have crashed a *fresh* install the
moment the table stopped being created — a failure that would not appear on any existing
database, including the one this was tested against. They were removed. Two historical
SQLite `print_queue` rebuild blocks still name `projects(id)`; those are gated on an old
schema and only ever run where the table exists, so they were left alone.

Two false positives worth recording, because both look like Projects and are not: the
printer's own MQTT protocol carries a `project_id` field (`bambu_mqtt.py`, and the
support-bundle redaction list), and `ForecastPanel` is about *projections*, not projects.
3MF "project files", "project settings" and the archive project-page are likewise
unrelated and untouched.

Behaviour changes beyond the removal itself:

- **File Manager folder links are archive-only now.** The modal used to offer project or
  archive; the type selector is gone and the flow goes straight to archive selection.
- **`PrintersPage` fetched the last completed print with `getArchives(printer.id, 1, 0)`,
  which was passing `projectId=1, limit=0`** — it wanted `limit=1, offset=0`. Dropping the
  `projectId` parameter makes that call do what its comment always said it did.
- The API-key permission `can_manage_projects` and the four `projects:*` permissions are
  gone, along with the Settings checkbox and badge that exposed them.
- System Info no longer shows a Projects count; the Backup dialog no longer offers a
  Projects category (the on-disk `projects/` attachment directory is still backed up and
  restored, since that copy is not gated on the UI categories).

While repointing a test, I found that the #2731 fix — soft-deleted archives must not be
counted by failure analysis — only ever covered the *project-scoped* path. Printer-scoped
analysis still counts them. That is a pre-existing upstream bug, left as-is because fixing
it is a behaviour change rather than a removal, and recorded in the test file's docstring.

Verified: frontend suite (2497 tests) and backend suite pass, `npm run build`,
`tsc --noEmit`, eslint and i18n parity are clean, and — the checks that matter most here —
a fresh database initialises and the app starts, and a copy of the live database migrates
and starts with `projects` / `project_bom_items` and every `project_id` column still
present.

Also fixed a parity failure this session's accent-colour work introduced: `accentAtos`
carried the English string in all 13 locales, which the parity checker flags as
untranslated. It now has a per-locale translation.

### Changes

- Frontend: deleted `ProjectsPage`, `ProjectDetailPage`, `utils/projectQueries.ts` (itself
  orphaned by the Archives removal) and their tests; removed the nav entry, both routes,
  the project half of the File Manager link modal, the `projectId` prop on `PrintModal`,
  the Backup category, the System Info stat, the Settings API-key permission, and every
  project type, endpoint and query filter in `api/client.ts`.
- i18n: removed the `projects` and `projectDetail` blocks plus nine project keys from all
  13 locales; translated `settings.accentAtos` per locale.
- Backend: deleted `api/routes/projects.py`, `models/project.py`, `models/project_bom.py`
  and `schemas/project.py`; unregistered the router; removed the `project_id` FKs and
  relationships from five models; removed the `projects:*` permissions and the
  `can_manage_projects` API-key scope; stripped project filters, joins and response fields
  from `archives`, `library`, `print_queue`, `pending_uploads`, `support`, `system`,
  `webhook`, the archive and export services, and the print scheduler; removed the project
  migrations from `database.py`.
- Tests: deleted `test_projects_api.py`; dropped four tests of removed filters; re-pointed
  the ownership linked-folder test at an archive link; re-pointed the multipart auth-header
  test at `uploadArchiveTimelapse`; removed the project cover-image URL tests (stream-token
  behaviour is still covered by three other files).

## 2026-08-17: Fixed the CodeQL workflow for a private fork

Follow-up to the Security Audit fix, which is confirmed working: run 32000990834 on
`fix/security-workflow-private-repo` passed all four jobs and produced its artifacts.
CodeQL was the remaining red workflow, and it failed for a different reason than expected.

It never reached the SARIF upload. It failed at **checkout**, with
`fatal: repository 'Nicolas-Cilia/Backoffice-Printing' not found` — the repo plainly does
exist. The cause is that job-level `permissions:` **replace** the workflow-level block
rather than merging with it. The `analyze` job declared only `security-events: write`, so
the job token dropped the workflow's `contents: read` and could not clone a private repo.
On a public repo it would have cloned anonymously and the bug would never have shown.

Fixing the permission alone would only have moved the failure downstream: the upload still
needs Advanced Security, which this private repo does not have. So the job is now skipped
while the repo is private, via `if: ${{ !github.event.repository.private }}` — no red runs,
and it resumes on its own if the repo is ever made public, with the permission bug already
fixed. `actions/checkout` also moves v4 to v6, clearing that job's Node 20 deprecation
warning.

Note the remaining Node 20 warnings in the annotations come from `main`, which still
carries the older workflow files; they are already newer on the feature branches and will
clear as those merge.

Verified: the workflow YAML parses and the job's `if`, permissions and steps read back as
intended. **The run itself is unverified** until this is pushed.

### Changes

- `.github/workflows/codeql.yml`: added `contents: read` to the `analyze` job (with a note
  on why omitting it broke checkout), skipped the job while the repo is private, and
  bumped `actions/checkout` to v6.

## 2026-08-17: Changed the accent colour from green to Atos Blue (#07bcec)

Fork plan entry #8. The entry expected a grind through 1864 token uses; the codebase made
that unnecessary. `index.css` declares `--color-bambu-green: var(--accent)` in its
`@theme` block, so every `bambu-green` class already resolves through a single variable —
and semantic colours were already held separately as `--status-ok` / `--status-error` /
`--status-warning`, explicitly commented "always green for success/online/ok". Keeping
semantic green therefore cost almost nothing.

The app also ships a user-facing accent picker with six choices. Retuning the one called
"green" to render blue would have left the setting lying about itself, so this adds a
seventh, `atos`, and makes it the default for both light and dark. Upstream's six stay
selectable. Anyone whose stored preference is still `green` keeps green until they change
it; an unrecognised stored value now falls through to the `:root` default, which is the
new blue.

`tailwind.config.js` turned out to be dead weight for colours: Tailwind v4 only loads a JS
config through an `@config` directive and there is none, so its `bambu.green` values never
reached the build. Editing that file alone — the obvious first move — would have changed
nothing. It is updated anyway, with a note, so the two sources do not contradict each
other.

**Contrast, stated plainly:** white text on `#07bcec` is 2.23:1, under WCAG AA's 4.5:1.
That is worse than, but the same kind of problem as, the green it replaces (white on
`#00ae42` is 2.94:1, also failing). Accent buttons therefore keep white text here rather
than restyling every button as a side effect of a colour swap. Near-black on this blue
would be 9.41:1 if you want it fixed later.

Verified: frontend suite (2537 tests) passes, locale parity holds at 5721 keys per locale
(one new key everywhere), `tsc --noEmit` and eslint are clean, and the built CSS was
checked directly — `:root` and `.accent-atos` both carry `#07bcec`, and the only `#00ae42`
left in the bundle is the preserved `.accent-green` option. Typechecking caught two things
a grep-and-replace would have missed: the `dark_accent`/`light_accent` union in
`api/client.ts` and an accent-to-button-class map in `PrintersPage`.

### Changes

- `frontend/src/index.css`: `:root` accent defaults are now the blue; added an
  `.accent-atos` block ahead of the upstream accents.
- `frontend/src/contexts/ThemeContext.tsx`: `ThemeAccent` gains `'atos'`; both stored
  defaults change from `'green'`; the class-removal list includes `accent-atos`.
- `frontend/src/pages/SettingsPage.tsx`: new first option in both accent dropdowns.
- `frontend/src/i18n/locales/*.ts` (13 files): added `settings.accentAtos`.
- `frontend/src/api/client.ts`: accent unions accept `'atos'`.
- `frontend/src/pages/PrintersPage.tsx`: added the `atos` accent-button class, bound to
  the accent token rather than a fixed palette step; recoloured the nozzle-side chip.
- `backend/app/schemas/settings.py`: `dark_accent` / `light_accent` default to `"atos"`.
- `frontend/index.html`, `frontend/public/manifest.json`: `theme-color` is now the blue.
- Recoloured brand uses of the literal green: `VirtualKeyboard.css`, `FilamentTrends.tsx`,
  `WifiSignal.tsx`, `GcodeViewer.tsx`, `ModelViewer.tsx`, `FileManagerPage.tsx`,
  `usePrintProgressTitle.ts`, `AmsUnitCard.tsx`, and the four chart colours in
  `StatsPage.tsx`.
- `frontend/tailwind.config.js`: values updated with a note that the file is not what the
  app renders.
- Left green on purpose: `--status-ok`, `amsHelpers.ts` spool fill, `FilamentMapping.tsx`
  match indicator, `StatsPage.tsx:311` accuracy band, and all Tailwind `green-N` classes.

## 2026-08-17: Fixed the Security Audit workflow for a private fork

Every push was failing two jobs. Neither failure was caused by our code, and the two had
different causes that happened to look alike in the annotations.

**Bandit — "Resource not accessible by integration".** The job ended by pushing SARIF to
GitHub code scanning via `codeql-action/upload-sarif`. Code scanning is free on public
repos but needs GitHub Advanced Security on private ones, and this fork is private, so
the API refused the upload. The same missing access produced the two telemetry warnings.
Bandit itself ran fine throughout — only the upload failed. Results now go to a build
artifact instead, and the findings are also printed to the job log, which is arguably
more useful than a Security tab nobody opens. The job no longer requests
`security-events: write` since it no longer writes any.

**Trivy — bare "exit code 1".** This one never reached the scan. `trivy-action` installs
the binary by sparse-checking-out `aquasecurity/trivy@main` and running
`contrib/install.sh`, which downloads from `get.trivy.dev`. That endpoint only serves
recent releases: reproduced locally, the pinned `v0.69.1` returns **404** there, as do
0.67 and 0.68, while 0.73 and 0.74 return 200. `install.sh` logs that 404 at a debug
level the script suppresses, so all CI showed was `exit code 1` immediately after
"found version". Trivy now runs from its official Docker image, which Docker Hub retains
indefinitely, so the same CDN retention window cannot break it again. That also removes
the action's bundled `actions/cache`, which was the Node 20 deprecation warning.

Trivy is pinned to 0.74.0 rather than the previous 0.69.1: the vulnerability DB schema
moves and old binaries eventually cannot read it. Findings still do not fail the build,
matching the previous behaviour.

Verified as far as is possible locally: the `install.sh` 404 was reproduced directly, the
`aquasec/trivy:0.74.0` tag was confirmed to exist for amd64, and the workflow YAML parses
with the expected jobs and permissions. **The run itself is unverified** — that needs a
push to GitHub, which has not happened.

### Changes

- `.github/workflows/security.yml`: Bandit uploads SARIF as an artifact instead of to
  code scanning, and prints findings to the log; Trivy runs from `aquasec/trivy:0.74.0`
  via Docker instead of `aquasecurity/trivy-action`, with image and config results kept
  as artifacts; both jobs drop the now-unneeded `security-events: write`.

## 2026-08-16: Replaced the Bambuddy logo and app icons with Backoffice Printing

Fork plan entry #4, the first step of rebranding this fork. Source artwork was
`ATO Backoffice Printing Logo.png` at 1897x829 RGBA.

The old logo shipped in three variants because the Bambuddy wordmark needed a dark-text
version to survive the light theme. This artwork does not: every white element carries a
heavy black outline, so it reads on white as well as on the dark sidebar. That let the
`resolvedMode === 'dark' ? … : …` ternaries in `Layout`, `LoginPage` and `SetupPage`
collapse to a single `src`, which in turn made `useTheme()` unused in `LoginPage` and
`SetupPage` — both now drop the hook and its import.

App icons use the whole mascot rather than a crop of its head. A head crop was the
obvious choice for legibility at 16px, but the character's face merges into its body with
no neck, so every crop cut through the chin. The full mascot on a solid brand-cyan
(`#00c2fc`) square reads as a character at 32px and guarantees contrast on light and dark
tab bars alike. The Android icons carry extra padding because `manifest.json` serves the
same file for both the `any` and `maskable` purposes, and a maskable icon gets cropped to
the launcher's shape.

The icon filenames are unchanged while their content is not, so the service worker would
have kept serving the old artwork from cache. Its two cache versions are bumped to force
a refetch on next load.

Note this is artwork only — the *name* "Bambuddy" still appears in page titles, the
manifest, headings and copy throughout the app.

Verified: frontend suite (2537 tests) and `npm run build` pass; `tsc --noEmit` and eslint
clean on the touched files.

### Changes

- `frontend/public/img/` and `static/img/`: added `backoffice_printing_logo.png`
  (1105x427, transparent); regenerated `favicon.png`, `favicon-16x16.png`,
  `favicon-32x32.png`, `apple-touch-icon.png`, `android-chrome-192x192.png` and
  `android-chrome-512x512.png` from the mascot on `#00c2fc`; deleted
  `bambuddy_logo_dark.png`, `bambuddy_logo_dark_transparent.png` and
  `bambuddy_logo_light.png`.
- `frontend/src/components/Layout.tsx`: both logo references (expanded and collapsed
  sidebar) point at the new asset; dropped the theme ternary and the now-unused
  `resolvedMode` from the `useTheme()` destructure.
- `frontend/src/pages/LoginPage.tsx`, `frontend/src/pages/SetupPage.tsx`: same swap;
  removed the now-unused `useTheme()` call and its import.
- `frontend/src/pages/StreamOverlayPage.tsx`: repointed the hardcoded logo reference.
- All four: `alt` text now reads "Backoffice Printing".
- `frontend/public/sw.js`: precache the new logo path; bumped `CACHE_NAME` to
  `bambuddy-v31` and `STATIC_CACHE` to `bambuddy-static-v30`.
- `frontend/src/__tests__/pages/StreamOverlayPage.test.tsx`: three `getByAltText`
  assertions and one test name updated to the new alt text.
- `README.md`: header image points at the new logo.

## 2026-08-16: Removed the Archives tab, route and page

Fork plan entry #2, layer 2a only. Archives is not a leaf feature the way MakerWorld
was — `print_archives` is the print-history spine, with foreign keys from nine other
tables and `ON DELETE CASCADE` from `print_queue` and `active_print_spoolman` — so this
removes the UI layer and stops there. The backend routes, the `archives:*` permissions
and the table itself are untouched, which means print history keeps being written and
Stats, Projects and the Queue still compute from it.

What did **not** survive is everything that lived inside the page. Archives had four view
modes — grid, list, calendar and log — so removing it also removed the print calendar and
the print-log view, along with timelapse playback, the finish-photo gallery, archive
comparison and tag management. Those were reachable only from Archives; twelve components
existed solely to serve it, verified against upstream `a28bdc54` where each had exactly
one importer.

Ten of those twelve were deleted. `CalendarView` and `PrintLogModal` were kept — they are
the two worth having back, and entry #5 in the fork plan covers rehoming them. They sit
in the tree unimported, each with a comment at the top explaining why, so a later dead-code
sweep does not remove them. Their data source is untouched, so whatever hosts them will
find live data waiting.

`EditArchiveModal`, `PurgeArchivesModal` and `PendingUploadsPanel` were each rendered
only by `ArchivesPage`, so they came out with it. **`PendingUploadsPanel` is worth
noting:** it was the review UI for virtual-printer uploads awaiting approval, and it now
has no home. Its backend endpoints still exist, so nothing is lost server-side, but the
review flow is unreachable from the UI until it gets placed somewhere else.

The Archives nav entry also carried a pending-uploads count badge. That badge, and the
5-second polling query behind it, are gone; the Queue badge on its own nav entry is
unaffected and keeps its yellow styling.

Verified: frontend suite (2537 tests) and backend suite (8236 tests) pass, as does
`npm run build`; `/archives` no longer resolves; every other tab still routes.

### Changes

- `frontend/src/components/Layout.tsx`: dropped the Archives nav entry, its
  `archives:read*` gate, the pending-uploads count query and badge branch, and the
  now-unused `Archive` icon and `pendingUploadsApi` imports.
- `frontend/src/App.tsx`: removed the `/archives` route and the `ArchivesPage` import.
- `frontend/src/pages/ArchivesPage.tsx`: deleted.
- `frontend/src/components/EditArchiveModal.tsx`: deleted.
- `frontend/src/components/PurgeArchivesModal.tsx`: deleted.
- `frontend/src/components/PendingUploadsPanel.tsx`: deleted.
- Deleted the remaining components `ArchivesPage` privately owned: `TimelapseViewer`,
  `PhotoGalleryModal`, `CompareArchivesModal`, `BatchTagModal`, `TagManagementModal`,
  `QRCodeModal`, `UploadModal`, `ContextMenu`, `ProjectPageModal`, `BatchProjectModal`,
  plus the `ContextMenu`, `TagManagementModal` and `UploadModal` tests.
  `FileUploadModal` and its test are a different component and were left alone.
- `frontend/src/components/CalendarView.tsx`,
  `frontend/src/components/PrintLogModal.tsx`: kept and annotated as deliberately
  unimported, pending entry #5. `PrintLogTable` stays as `PrintLogModal` depends on it.
- `frontend/src/__tests__/pages/ArchivesPage.test.tsx`,
  `__tests__/components/EditArchiveModal.test.tsx`,
  `__tests__/components/PendingUploadsPanel.test.tsx`: deleted.
- `frontend/src/__tests__/components/Layout.test.tsx`: removed the Archives case from
  the granular-read-tier gate tests (#1755) and reworded the block comment; the Files
  and Queue cases still cover the behaviour.
- `frontend/src/__tests__/pages/SettingsPage.test.tsx`: dropped `archives` from the
  three expected sidebar-order arrays.
- `FORK_PLAN.md`: entry #2 marked 2a-done, with the `PendingUploadsPanel` follow-up.

## 2026-08-16: Removed the MakerWorld tab and page

MakerWorld went unused and sat directly under Projects in the sidebar, where it caught
misclicks. Fork plan entry #1 originally scoped this to the nav entry alone, but since
this fork is not tracking upstream, the route and page came out with it rather than
leaving an orphaned page reachable only by URL.

Scope stops at the tab: the backend MakerWorld endpoints and the `makerworld:view` /
`makerworld:import` permissions still exist, as do the other places MakerWorld appears —
the "View on MakerWorld" links on archive cards, the project-page modal, and the import
client in `api/client.ts`. Those are separate features and remain working. Removing the
backend surface would be its own unit.

The sidebar order in Settings picks this up for free, since it derives its list from
`defaultNavItems`. A user whose saved sidebar order still contains `makerworld` is
unaffected — `Layout` already filters saved orders against the known nav ids.

Verified: frontend suite (2619 tests) and `npm run build` pass; `/makerworld` no longer
resolves; every other tab still routes.

### Changes

- `frontend/src/components/Layout.tsx`: dropped the MakerWorld nav entry, its
  `makerworld: 'makerworld:view'` gate in the `navPermissions` map, and the now-unused
  `Globe` icon import.
- `frontend/src/App.tsx`: removed the `/makerworld` route and the `MakerworldPage` import.
- `frontend/src/pages/MakerworldPage.tsx`: deleted.
- `frontend/src/__tests__/pages/MakerworldPage.test.tsx`: deleted.
- `frontend/src/__tests__/components/Layout.test.tsx`: removed the MakerWorld
  permission-gate block (#1175), which asserted the entry renders for users holding
  `makerworld:view` — no longer true by design.
- `frontend/src/__tests__/pages/SettingsPage.test.tsx`: dropped `makerworld` from the
  three expected sidebar-order arrays.
- `FORK_PLAN.md`: entry #1 marked done; recorded that this fork does not track upstream.
