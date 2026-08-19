# Fork Plan

Working agreement between Nicolas and Claude for customizing this fork of Bambuddy.

**How to use this file:** describe intended changes under "Planned changes" in your own
words. Claude reads this before starting work, asks about anything ambiguous, and does
not implement anything not listed here. When a change ships, move it to "Done" with the
branch/commit that delivered it.

---

## Context

_Why this fork exists and what "my use case" means. Fill in._

- Hardware in use (printer models, count, AMS setup):
- How it's deployed (Docker / bare metal / other):
- What upstream Bambuddy does that doesn't fit:
- Do we intend to stay mergeable with upstream `main`? (yes / no / best effort):

---

## Ground rules for this fork

The general workflow (branch naming, commit granularity, session cadence, quality bar,
what to ask before doing) lives in `~/.claude/CLAUDE.md` and applies here unchanged.
This section records only the parts that are **specific to this fork** or that override
the standing workflow.

- **Upstream mergeability:** No. This fork is its own thing — upstream files get edited
  directly, upstream tests get changed or deleted when a change invalidates them, and no
  extra indirection is added for the sake of clean merges. Pulling from
  `maziggy/bambuddy` is expected to be painful and that is accepted.
- **Branch base:** branch from `main` unless the unit depends on an open branch. Fork
  work never lands directly on `main`.
- **Push / PR policy:** _TBD — see "Open decisions" below._
- **Done means:** `./test_all.sh` green plus a frontend build, per the standing quality
  bar. Anything extra a specific unit needs goes in that unit's Acceptance line.

---

## Open decisions

Answer these once; they shape every unit after.

1. ~~**Stay mergeable with upstream?**~~ → **No.** Answered 2026-08-16; see Ground rules.
2. **Where does `origin` point** — your own fork, or upstream? →
3. **When do branches get pushed?** Options: never until you say so (current default,
   and what I have been doing); push each branch once its unit is done and tests pass;
   push after every commit as an off-machine backup. →
4. **PRs at all,** or do finished branches just get merged locally into `main`? →
5. **Will `Nicolas-Cilia/Backoffice-Printing` be public or private?** This is the one
   with consequences outside the repo: publishing is distribution under AGPL-3.0, which
   brings attribution and source-availability obligations (entry #7). Private changes
   nothing legally. →

---

## Planned changes

Each entry: what, why, and how we'll know it works. Keep them small enough to be one
branch each. Status: `idea` → `agreed` → `in progress` → `done`.

Every entry heading carries a status marker, kept in step with its **Status:** line:

| Marker | Meaning |
| --- | --- |
| ✅ | Done — shipped and verified |
| 🟠 | In progress — started, or partly delivered |
| 🔵 | Not started — an idea, or agreed but not begun |

### 1. Remove the MakerWorld tab and page ✅

- **Status:** done
- **Area:** frontend
- **What:** Drop MakerWorld from the sidebar navigation, remove the `/makerworld` route
  and permission gate, and delete `MakerworldPage.tsx` and its test. Backend MakerWorld
  endpoints and the `makerworld:*` permissions are left in place, as are the other
  MakerWorld touchpoints (archive "View on MakerWorld" links, the project-page modal,
  the import API client) — those are separate features, not the tab.
- **Why:** I never use MakerWorld and it's the first thing I misclick under Projects.
- **Acceptance:** MakerWorld gone from the sidebar; `/makerworld` no longer resolves;
  every other tab still routes; frontend tests and build pass.
- **Open questions:** resolved — full removal of tab + route + page; the backend side
  stays for now. Worth a later unit if we want the API surface gone too.
- **Branch:** `ui/remove-makerworld-tab`

### 2. Remove the Archives tab 🟠

- **Status:** 2a done; 2b–2d not started
- **Area:** frontend (+ backend, depending on how deep we go)
- **What:** Same treatment as MakerWorld — tab, route and page gone. Unlike MakerWorld,
  Archives is not a leaf feature, so "everywhere" splits into layers we can stop between:
  - **2a — UI removal.** _Done 2026-08-16._ Sidebar entry, `/archives` route,
    `ArchivesPage.tsx`, `EditArchiveModal`, `PurgeArchivesModal`,
    `PendingUploadsPanel`, and their tests, plus the pending-uploads badge on the
    Archives nav entry.
  - **2b — Cross-feature references.** ~40 other components read archives: Projects,
    Queue, Stats, Calendar, File Manager, GCode viewer, SpoolBuddy, backup/restore. Each
    needs a decision — drop the feature, or keep it reading archive data that no longer
    has a page.
  - **2c — Backend.** `api/routes/archives.py`, `archive_purge.py`, the schemas, the
    services, and the `archives:*` permissions.
  - **2d — Data model.** Dropping `print_archives` itself.
- **Why:** _fill in — this one matters more than usual, see open questions._
- **Acceptance:** depends where we stop. For 2a: Archives gone from the sidebar,
  `/archives` dead, full suite and build pass, and every other page still loads —
  particularly Stats, Queue and Projects, which read archive data.
- **Open questions:**
  - **How deep?** 2a alone is a clean afternoon and reversible. 2d is not: nine tables
    carry FKs to `print_archives`, and `print_queue` + `active_print_spoolman` cascade on
    delete, so dropping the table deletes queue rows with it. Recommend stopping at 2a,
    or 2a+2c at most.
  - **What do you actually want gone** — the page, or print history as a concept? If
    print history should stay and you just never open the tab, 2a is the whole job.
  - Stats is largely computed from archive rows. If archives stop being written, Stats
    goes blank. Is that acceptable, or does Stats need to survive?
  - Same question for the Calendar view and the print-log timeline.
- **Branch:** `ui/remove-archives-tab` (2a), further units branch off as needed
- **Follow-ups raised by 2a:**
  - `ArchivesPage` privately owned twelve components — verified against upstream
    `a28bdc54`, where each had exactly one importer. Ten were deleted with it. Two are
    kept, unimported, for rehoming later: see entry #5.
  - `PendingUploadsPanel` — the review UI for virtual-printer uploads — was among the
    ten deleted. If you use virtual printers with review enabled, that flow now has no
    UI (the backend endpoints are untouched). Decide whether to rebuild it elsewhere or
    drop the feature.

### 3. Remove Projects 🟠

- **Status:** 3a-3c done 2026-08-17; 3d deliberately not done
- **Area:** frontend + backend
- **What:** Same layered shape as Archives, because Projects is likewise a data spine
  rather than a leaf:
  - **3a — UI removal.** Sidebar entry, the `/projects` and `/projects/:id` routes,
    `ProjectsPage.tsx`, `ProjectDetailPage.tsx`, and their tests. Note
    `ProjectPageModal` and `BatchProjectModal` are already orphaned by 2a, so they get
    swept up here regardless.
  - **3b — Cross-feature references.** Roughly 10 other frontend files read projects:
    File Manager (folders carry a `project_id`), `SliceModal`, `PrintModal`,
    `ForecastPanel`, `BackupModal`, `ModelViewer`, `HMSErrorModal`,
    `BulkEditSpoolsModal`, Settings and System Info. Each needs a keep-or-drop call —
    in particular the File Manager's project association, which is how files get
    grouped today.
  - **3c — Backend.** `api/routes/projects.py`, the project schemas and services, and
    the `projects:*` permissions.
  - **3d — Data model.** Dropping `projects` and `project_bom_items`.
- **Why:** _fill in._
- **Acceptance:** met — Projects gone from the sidebar, both routes dead, backend API and
  models removed, full frontend + backend suites and the build pass, and a fresh database
  and a copy of the live database both initialise and start cleanly.
- **How it went / decisions taken:**
  - **3d was not done, by choice.** `projects` and `project_bom_items` still exist in the
    database with their rows intact; nothing reads them. Reversible by `git revert`.
    (Your `projects` table had 0 rows, so nothing was at stake either way.)
  - **`ForecastPanel` was a false positive** in the scoping above — its "project" hits are
    `projectedEmptyDate` / `buildProjectionSeries`, i.e. forecasting. Untouched.
  - **File Manager folder links are now archive-only.** The link modal offered
    project *or* archive; the project half is gone.
  - The API-key permission `can_manage_projects` and the `projects:*` permissions were
    removed along with the feature.
  - **`_safe_execute` re-raises non-idempotency errors**, so leaving the
    `ALTER TABLE projects …` migrations in place would have crashed startup on a *fresh*
    install once the table stopped being created. They had to go, and did.
  - Two historical SQLite `print_queue` rebuild blocks still mention `projects(id)`.
    Left alone: they are gated on an old schema, so they only ever run on databases where
    that table exists.
  - Backup/restore still copies the on-disk `projects/` attachments directory, since it
    is not gated on the UI categories. Consistent with keeping data.
- **Branch:** `feat/remove-projects`

### 4. Replace the Bambuddy logo with the Backoffice Printing logo ✅

- **Status:** done 2026-08-16
- **Area:** frontend (+ static assets, docs)
- **What:** Swap the Bambuddy wordmark for the Backoffice Printing logo (the running
  mascot in sunglasses, "backoffice" in white, "printing" in cyan). Places it appears:
  - **Five code references**, all resolving to the same two files —
    [Layout.tsx:479](frontend/src/components/Layout.tsx#L479) and
    [Layout.tsx:505](frontend/src/components/Layout.tsx#L505) (expanded and collapsed
    sidebar), [LoginPage.tsx:709](frontend/src/pages/LoginPage.tsx#L709),
    [SetupPage.tsx:82](frontend/src/pages/SetupPage.tsx#L82), and
    [StreamOverlayPage.tsx:291](frontend/src/pages/StreamOverlayPage.tsx#L291), which is
    hardcoded to the dark variant regardless of theme.
  - **The asset files themselves**, duplicated in two trees:
    `frontend/public/img/` (source) and `static/img/` (build output, committed). Both
    hold `bambuddy_logo_dark.png`, `bambuddy_logo_dark_transparent.png` and
    `bambuddy_logo_light.png`.
  - **Favicons and PWA icons:** `favicon.png`, `favicon-16x16.png`, `favicon-32x32.png`,
    `apple-touch-icon.png`, `android-chrome-192x192.png`, `android-chrome-512x512.png`,
    referenced from `frontend/index.html` and `frontend/public/manifest.json`.
  - **README.md**, which uses `static/img/bambuddy_logo_dark.png`.
- **Why:** Rebranding this fork to Backoffice Printing.
- **Acceptance:** new logo shows in both sidebar states, on Login, on Setup and on the
  stream overlay, in both light and dark themes; favicon and installed-PWA icon updated;
  no stale Bambuddy artwork left in either asset tree; build passes.
- **Resolved during implementation:**
  - Source asset: `~/Downloads/ATO Backoffice Printing Logo.png`, 1897x829 RGBA.
  - **Light-mode variant not needed.** The artwork's heavy black outlines keep it
    legible on white, so one asset serves both themes and the dark/light ternaries were
    removed rather than repointed.
  - **Favicon** uses the whole mascot, not a head crop — the face merges into the body,
    so any head crop cut through the chin. Icons sit on the logo's own cyan (`#00c2fc`)
    for contrast on any tab bar.
  - Two references the entry originally missed: `frontend/public/sw.js` precaches the
    logo, and its cache version needed bumping so existing clients refetch the icons.
- **Still open:** the *name* "Bambuddy" is untouched — page titles, manifest, headings
  and copy. This entry covered artwork only. A text rename would be its own entry.
- **Branch:** `ui/backoffice-printing-logo`

### 5. Rehome the print calendar and the print log 🔵

- **Status:** deferred — agreed to do, not scheduled
- **Area:** frontend
- **What:** Give `CalendarView` and `PrintLogModal` a home somewhere in the app. Both
  were view modes of the Archives page (`grid | list | calendar | log`) and were kept
  through 2a specifically for this, unimported, each carrying a comment saying so. Their
  data source is untouched: `print_archives` is still written and the print-log
  endpoints still serve.
- **Why:** These are the two parts of Archives worth keeping. Everything else that page
  owned was deleted.
- **Acceptance:** both reachable from the UI again, reading live data, with tests.
  `PrintLogModal` still has its test; `CalendarView` has none and would need one.
- **Open questions:**
  - Where do they go? Candidates: Stats (natural fit for both), Printers, or a new
    combined "History" page that replaces what Archives did without the rest of it.
  - Entry #9 wants `QueueTimelineView` kept for the same combined view. Note it is the
    odd one out: the calendar and log look *backwards* at completed prints, while the
    timeline looks *forwards* at pending queue items — and it has no data at all if the
    queue is removed. See #9's open questions.
  - One host for both, or split them?
  - `CalendarView` takes an `Archive[]` prop and the removed page did the fetching, so
    whatever hosts it has to own that query.
- **Branch:** `feat/rehome-print-calendar-and-log`

### 6. Point GitHub links at the fork 🔵

- **Status:** idea
- **Area:** frontend, backend, docs, install scripts
- **What:** Repoint references from `maziggy/bambuddy` to
  `https://github.com/Nicolas-Cilia/Backoffice-Printing`. There are 583 matches across
  the repo, but they fall into four groups that want different treatment:
  - **6a — Functional, drives behaviour.** These change what the app *does*, not just
    where a link goes:
    - `backend/app/core/config.py:11` — `GITHUB_REPO = "maziggy/bambuddy"`, which the
      in-app update check queries for releases.
    - `backend/app/api/routes/updates.py:230` — validates that a release asset URL
      belongs to the expected repo before downloading. Must stay in step with the above.
    - `backend/app/services/firmware_check.py` (2), `notification_service.py` (1) —
      outbound `User-Agent` strings.
  - **6b — User-visible links.** `Layout.tsx:673` and `:778` (sidebar GitHub icon and
    the About dialog), `SettingsPage.tsx:2719` (release-tag fallback link),
    `StreamOverlayPage.tsx`, `.github/ISSUE_TEMPLATE/bug_report.yml`. Small and
    unambiguous — this is the part that actually matters day to day.
  - **6c — Docs and install scripts.** `README.md` (12), `CONTRIBUTING.md` (7),
    `DOCKERHUB.md` (5), `install/install.sh`, `install/docker-install.sh`,
    `install/README.md`, `docker-compose.yml`, `docker-publish-daily-beta.sh`,
    `spoolbuddy/install/install.sh`, `slicer-api/README.md`, `docs/*`.
  - **6d — `CHANGELOG.md` (516 matches).** Upstream's historical release notes, where
    the links point at the upstream issues and PRs those entries describe.
    **Recommend leaving entirely alone** — rewriting them would make upstream's history
    cite a repo that never had those issues. Our own history goes in
    `FORK_CHANGELOG.md`.
- **Why:** The fork lives at a different URL; links and update checks should follow it.
- **Acceptance:** sidebar and About links open the fork; `grep -rn "maziggy/bambuddy"`
  returns only `CHANGELOG.md` (assuming 6d is skipped); full suite and build pass. Tests
  in `BugReportBubble.test.tsx`, `StreamOverlayPage.test.tsx`, `SettingsPage.test.tsx`,
  `test_bug_report.py`, `test_notification_service.py` and `test_updates_api.py` assert
  on the current URL and will need updating in the same unit.
- **Open questions:**
  - **The update check is the real decision.** Repointing `GITHUB_REPO` makes the app
    check *your* fork for new versions. If the fork publishes no releases, in-app update
    checking goes quiet — arguably correct for a private fork, since upstream releases
    would no longer match your code anyway. Alternative: leave `GITHUB_REPO` on upstream
    so you still get notified of their releases, and repoint only the link groups.
    Which?
  - Does the repo at that URL exist and is it public? Bug-report and issue-template
    links assume issues are enabled.
  - `maziggy/orca-slicer-api` is referenced in a `config.py` comment — a different
    upstream project, not the Bambuddy repo. Leave it.
- **Branch:** `fix/point-github-links-at-fork`

### 7. Fork attribution and licensing notices in the docs ✅

- **Status:** done 2026-08-19 — docs rewritten on `docs/fork-attribution` (not committed
  in this unit)
- **Area:** docs
- **What:** Make the top-level docs say plainly what this repo is: a personal rework of
  Bambuddy, still AGPL-3.0, not affiliated with or endorsed by upstream.
  - **`README.md`** — replace upstream's marketing header with a fork notice: what this
    is, that it is based on [maziggy/bambuddy](https://github.com/maziggy/bambuddy),
    that it is modified, that it is for personal use and offered as-is, and that it
    remains AGPL-3.0. Then strip what belongs to upstream and would be wrong here:
    GitHub Sponsors, Ko-fi and sponsors-portal badges, the North Pole 3D Printing
    "Backed by" block, Discord, and `demo.bambuddy.cool`. Document the actual sidebar
    and the native + Docker install paths.
  - **`CONTRIBUTING.md`** — rewrite for how this checkout is developed; outside
    contributions are not expected.
  - **`SECURITY.md`** — private advisory on this repo; no fake SLAs or version support
    table; keep the CI security-stance rules.
  - **`CODE_OF_CONDUCT.md`** — this repository, GitHub reporting, no Discord.
  - **Keep `LICENSE` exactly as it is**, and keep upstream's copyright notices.
- **Why:** The docs previously read as though this *is* upstream Bambuddy. Distribution
  under AGPL-3.0 needs a clear fork notice and credit.
- **Acceptance:** met in the files listed above. README opens with the fork notice;
  funding / Discord / demo / wiki / screenshot gallery are gone; `LICENSE` untouched;
  nothing claims upstream support or endorsement. Docker Compose `--build` is documented
  as a first-class intended path, not a leftover.
- **How it went / decisions taken:**
  - Scope for this unit was the five GitHub community tabs plus `FORK_PLAN` /
    `FORK_CHANGELOG`. `BACKERS.md`, `DOCKERHUB.md`, `UPDATING.md`, issue templates,
    and in-app `GITHUB_REPO` / GitHub URLs were left alone (the last is entry #6).
  - Native Mac (venv + uvicorn :8000, Vite :5173 in dev) is documented as what
    currently works. Docker stays in the README because it is planned to work, with
    `--build` from source so we do not promise unpublished GHCR/Docker Hub tags.
  - `FORK_CHANGELOG.md` remains the dated change notice for modified files (AGPL
    §5(a)); no per-file "modified from upstream" headers were added.
- **Branch:** `docs/fork-attribution`

### 8. Change the green accent to Atos Blue ✅

- **Status:** done 2026-08-17 — `#07bcec`
- **Area:** frontend
- **What:** Replace Bambuddy's green accent with Atos Blue. Most of this is one line,
  because the accent is a design token rather than scattered literals:
  - **8a — The tokens.** `frontend/tailwind.config.js:13-15` defines `bambu.green`
    (`#00ae42`), `green-light` (`#00c64d`) and `green-dark` (`#009438`). The class
    `bambu-green` is used **1864 times across 136 files**, so retuning these three
    values recolours nearly the whole UI at once. Also `--accent: #00ae42` in
    `frontend/src/index.css` (lines 59 and 250, light and dark blocks).
  - **8b — Browser/PWA chrome.** `theme_color` in `frontend/public/manifest.json:9` and
    the `theme-color` meta in `frontend/index.html:13`, both `#00ae42`. These set the
    Android status bar and installed-app colour.
  - **8c — Hardcoded greens.** ~276 occurrences of literal `#00ae42` and Tailwind
    `green-400/500/600` classes that the token does not cover. These need reading one by
    one, because they are not all "accent" — see the open question below.
  - **8d — Keep the token *name* or rename it?** Leaving it called `bambu-green` while
    it renders blue is confusing; renaming to `brand`/`accent` touches all 136 files.
    Suggest retuning the value now and renaming later (or never).
- **Why:** Rebranding to Backoffice Printing, matching the logo.
- **Acceptance:** no green accent anywhere in the UI; status colours still legible and
  still meaningful; installed-PWA and mobile browser chrome updated; full suite and
  build pass. Worth an actual visual pass over Printers, Queue and Stats rather than
  trusting tests.
- **How it actually went.** The scoping above was pessimistic: the app already has a
  proper accent-theming system, so almost none of the 1864 token uses needed touching.
  - `index.css` maps `--color-bambu-green: var(--accent)` in its `@theme` block, so
    every `bambu-green` class resolves through one variable at runtime.
  - Semantic colours were *already* separated as `--status-ok` / `--status-error` /
    `--status-warning`, commented "always green for success/online/ok". The
    leave-semantic-green decision was therefore mostly free.
  - There is a user-facing accent picker (green/teal/blue/orange/purple/red). Rather
    than retune "green" to mean blue, a new `atos` accent was added and made the
    default; upstream's six stay selectable.
  - `tailwind.config.js` turned out to be **dead for colours** — Tailwind v4 only reads
    a JS config via `@config`, and there is none. Editing it alone would have done
    nothing. Updated anyway so the two files don't disagree.
- **Known issue, not addressed:** white text on `#07bcec` is **2.23:1**, below WCAG AA's
  4.5:1. This is pre-existing in kind — white on the old green `#00ae42` was 2.94:1, also
  failing — so accent buttons kept white text rather than restyling every button in this
  unit. Near-black on the blue would be 9.41:1. Worth its own entry if you want it fixed.
- **Still green, deliberately:** `--status-ok` and the semantic greens in `amsHelpers.ts`
  (spool fill "good"), `FilamentMapping.tsx` (match traffic light), `StatsPage.tsx:311`
  (accuracy within 5%), plus all Tailwind `green-N` utility classes, which are
  success/health states rather than brand.
- **Branch:** `ui/atos-blue-accent`

### 9. Remove the Queue tab, keep printing 🔵

- **Status:** agreed and confirmed 2026-08-17 — not started
- **Area:** frontend
- **What:** Remove the Queue **tab** only. The queue machinery — backend routes, models,
  `print_scheduler.py`, `PrintModal` — all stays, because that is what makes printing
  work.
  - **9a — UI removal.** Sidebar entry, `/queue` route, `QueuePage.tsx` (~3k lines),
    `QueueStatsBar`, the pending-queue badge in `Layout`, and their tests.
  - **Kept deliberately:** `QueueTimelineView` (unimported and annotated, for entry #5);
    `PrinterQueueWidget`, which shows the next pending job on each printer card and
    becomes the only place queued work is visible; `PrintModal`; the entire backend.
- **Why:** The Queue tab is not how prints get started here. The workflow is: print a
  specific file from the Files tab, every time.
- **Printing needs no new work — it already does exactly this.** The File Manager has a
  per-file print button
  ([FileManagerPage.tsx:2438](frontend/src/pages/FileManagerPage.tsx#L2438)) that opens
  `PrintModal` with that file's `libraryFileId`, plus a bulk print action for selected
  sliced files. Both post a queue item that the scheduler dispatches. The queue stays as
  plumbing; it just stops having a page.
- **Acceptance:** Queue gone from the sidebar, `/queue` dead, and printing a file from
  the Files tab still reaches the printer end to end. Full suite and build pass.
- **Decisions taken:**
  - **Losing queue management is accepted.** No reordering, editing, cancelling or
    rescheduling of pending jobs, and no cross-printer view of what is waiting. Printing
    is the only requirement.
  - This settles the depth question: **backend stays.** Removing it would remove printing
    outright — every print goes `PrintModal` → `POST /queue/` → scheduler → printer, and
    the printer endpoints only cover stop / pause / resume.
- **Open questions:**
  - Does the pending-queue badge on the sidebar disappear entirely, or move onto the
    Printers tab?
  - Virtual printers and slicer pipelines also enqueue. Unaffected mechanically, but
    their queued output becomes as invisible as anything else pending.
- **Branch:** `ui/remove-queue-tab`

### 10. Remove in-app updating ✅

- **Status:** done 2026-08-17 — verified in the running app
- **Area:** backend, frontend
- **What:** Delete the update checker and the in-app updater outright. This install is a
  single Mac mini running natively (venv + uvicorn) and is never distributed, so updating
  is a deliberate `git pull` on the host after changes are pushed to GitHub.
  - `backend/app/api/routes/updates.py` reduced from 931 lines to just
    `GET /updates/version`, which the sidebar and Settings use to show the version.
    `GET /updates/check`, `POST /updates/apply` and `GET /updates/status` are gone,
    along with every helper behind them (GitHub release polling, rate-limit tracking,
    Docker / HA-addon / Windows-installer detection, the git and pip subprocess drivers).
  - Settings lose `check_updates` and `include_beta_updates`; `check_printer_firmware`
    stays, since Bambu Lab *printer* firmware is a different feature.
  - Frontend loses the update banner, the sidebar update button, the Settings update
    panel (check-now, install, release notes, per-deployment CTAs) and the API client
    functions and types behind them. The Settings section keeps the version and the
    printer-firmware toggle.
- **Why:** The updater ran `git fetch` + **`git reset --hard`** in the app directory and
  rewrote `origin` when it did not match `GITHUB_REPO`. On a fork that is a footgun with
  no upside — one click could repoint the checkout at upstream and discard every local
  change. There is also no release stream of ours worth polling GitHub for.
- **Acceptance:** met. Backend suite 8137 passed / 0 failed, frontend 2492, parity clean.
  Verified against the running server: `/updates/check` and `/updates/status` 404,
  `POST /updates/apply` 405 (no route), `/updates/version` still answers, SpoolBuddy's
  device firmware check still routes, and the served bundle contains zero references to
  `updates/check`, `updates/apply` or `check_updates`.
- **Deliberately not done:** `GITHUB_REPO` still reads `maziggy/bambuddy` — it is now
  only used to label the version response, and nothing acts on it. Retargeting it is
  entry #6's business. `docker-compose.yml` still references upstream's ghcr image;
  harmless here because deployment is native, and it belongs to #6 too.
- **Branch:** `fix/disable-upstream-updates`



### 11. Hide Bambu Cloud, Orca Cloud and K-profiles from the Profiles tab 🔵

- **Status:** agreed and scoped 2026-08-17 — **UI only, backend stays intact**
- **Area:** frontend
- **What:** `ProfilesPage.tsx` declares
  `type ProfileTab = 'cloud' | 'orca_cloud' | 'local' | 'kprofiles'`. Remove three of
  those four tabs and their panels, leaving **local presets** as the only tab. Every
  backend route, service, model and permission stays exactly where it is.
  - Tabs/panels to remove: `cloud` (Bambu Cloud presets), `orca_cloud` (Orca Cloud
    presets), `kprofiles` (`KProfilesView`).
  - Keep: the `local` tab and everything it needs.
- **Why:** These are not used; they are clutter on a page that only needs local presets.
  Keeping the backend means nothing can break underneath and it is trivially reversible.
- **Acceptance:** Profiles page opens on local presets with no other tabs; nothing else
  in the app changes; full suites and build pass.
- **Deliberately NOT done (contrast with entries #3 and #12):** no backend removal. The
  cloud routes/services, the k-profile models and the `kprofiles:*` / `cloud:*`
  permissions all remain. In particular **k-profiles stay attached to spools** —
  `SpoolFormModal`, `AssignSpoolModal`, `ConfigureAmsSlotModal` and `BulkEditSpoolsModal`
  keep working untouched, which is exactly why the UI-only shape is the safe one here.
- **Open questions:**
  - The Profiles nav entry is gated on `kprofiles:read`
    ([Layout.tsx](frontend/src/components/Layout.tsx)). With the k-profiles tab gone that
    gate is odd but harmless — repoint it at a local-presets permission, or leave it?
  - If only one tab remains, should the tab strip render at all, or should the page just
    show local presets with no tabs?
- **Branch:** `ui/trim-profiles-tabs`

### 12. Remove smart plugs 🟠

- **Status:** 12a/12b done 2026-08-17, pending suite confirmation; 12c not done (tables kept)
- **Area:** frontend + backend
- **What:** Remove smart-plug support from Settings and from every UI that surfaces it.
  - **12a — UI.** `AddSmartPlugModal`, `SmartPlugCard`, the Settings smart-plug section,
    the **switchbar** in `Layout` (`SwitchbarPopover` exists to toggle plugs), the
    SpoolBuddy quick menu entry, and the Backup/Restore category.
  - **12b — Backend.** `api/routes/smart_plugs.py`, `services/smart_plug_manager.py`,
    `services/plug_energy_history.py`, the `smart_plug` and
    `smart_plug_energy_snapshot` models, and the `plugs:*` permissions — 18 backend
    files reference `SmartPlug`.
  - **12c — Data model.** Dropping the two tables. Same rule as before: leave them.
- **Why:** _fill in._
- **Acceptance:** no smart-plug UI anywhere; Stats still renders; printing and the
  scheduler unaffected; full suites and build pass.
- **How it went:**
  - **Nothing was configured**, so nothing was lost: 0 smart plugs, 0 energy snapshots,
    0 archives carrying energy data in the live DB.
  - **Energy tracking is gone, as expected.** `archives/stats` no longer reads live plug
    counters or hourly snapshots; it sums the `PrintLogEntry` energy columns, which were
    themselves only ever written from plug readings. Historical rows keep their values;
    new prints record nothing. The `energy_tracking_mode` setting is now ignored.
    **The energy UI (Quick Stats tiles, Stats page, the cost-per-kWh setting) is left in
    place and will read zero** — stripping it is a follow-up if you want it.
  - **The scheduler lost three plug behaviours**: powering an offline printer on before
    dispatch, `auto_off_after` power-off after a job, and auto-off-after-drying. Queue
    items still carry the `auto_off_after` flag; it now does nothing.
  - Obico's `pause_and_off` failure action now only pauses.
  - `homeassistant.py` was deleted with the plugs — it existed to drive them. The HA
    *notification provider* is self-contained in `notification_service` and still works.
  - Same migration hazard as entry #3: ~88 `ALTER TABLE smart_plugs` statements would
    have crashed a fresh install once the table stopped being created. Removed. The two
    guarded SQLite rebuild blocks stay — they only run where the table already exists.
- **Branch:** `feat/remove-smart-plugs`

### 13. Remove virtual printers 🔵

- **Status:** idea
- **Area:** frontend + backend
- **What:** Remove the virtual-printer feature — the fake printer Bambuddy advertises to
  Bambu Studio / OrcaSlicer so a slicer can "print" straight into Bambuddy.
  - **13a — UI.** `VirtualPrinterSettings`, `VirtualPrinterList`, `VirtualPrinterCard`,
    `VirtualPrinterAddDialog`, `VirtualPrinterDiagnosticModal` — all rendered from the
    Settings page — plus their tests. (`VirtualKeyboard` is unrelated despite the name.)
  - **13b — Backend.** `api/routes/virtual_printers.py`, the `virtual_printer` model, and
    **`services/virtual_printer/` — ~9.3k lines across 12 modules**: an MQTT server and
    bridge, an FTP server, a bind server, a TCP proxy (1872 lines), certificate handling,
    Tailscale cert integration and diagnostics. 21 backend files reference it.
  - **13c — Data model.** Dropping the `virtual_printers` table. Same rule as before:
    leave it, remove the code.
  - **13d — Deploy config.** `docker-compose.yml` exposes a large block of ports purely
    for VPs (MQTT 8883, FTP 990, bind 3000/3002, RTSP 322, the 50000-50029 passive-FTP
    slice, A1/P1S 2024-2026). Those comments and mappings can go too.
- **Why:** _fill in._
- **Acceptance:** no virtual-printer UI or routes; the app still starts with no listeners
  bound on the VP ports; printing to real printers unaffected; full suites and build pass.
- **Open questions:**
  - **How do files reach Bambuddy today?** VPs are one intake path — you slice in
    Studio/Orca, hit print, and it lands here. The other is uploading to the Files tab.
    If you use the VP path, removing it changes your workflow; if you upload files
    directly (which is what entry #9 assumes), this is dead weight.
  - **This is the largest removal on the list by far** — ~9.3k lines of network servers.
    It is also the most self-contained: it is a set of listeners plus a model, not a data
    spine like Archives or Projects. Worth doing in two commits (UI first, then services)
    so a bisect is meaningful.
  - Entry #2a already removed `PendingUploadsPanel`, the review UI for VP uploads in
    *review* mode. If VPs go, that follow-up question in entry #2 disappears with them.
  - VP modes include `proxy`, which sits in front of a real printer and forwards its
    camera/FTP. Confirm you are not using proxy mode for anything — that one is not just
    an intake path.
- **Branch:** `feat/remove-virtual-printers`

### 14. Production file slots 🟠

- **Status:** implemented, pending human commit — v1 code is on
  `feat/production-file-slots` (uncommitted). Agreed 2026-08-17, branched off `dev`
  (depends on the file-manager landing/sections work already merged there). This wrap-up
  unit documented the work and filled two frontend filename parser cases; it did not add
  features. Not moved to Done until committed.
- **Area:** backend + frontend
- **What:** Governed production files on top of File Manager. A Production section holds
  printer-model folders (`X1C`, `A1M`, `A1`, `H2D`, `H2S`). Each folder contains part
  instances of conceptual parts (`TOP`, `BOT`, `KNB`, `BUT`) with quantity slots (`x1`,
  `x2`, …). A slot has exactly one active 3MF, a locked print-settings contract, and
  version history (`CODE [xQTY] - MAJOR.REVISION.MINOR - PRINTER`). Replacing a file
  diffs the new 3MF against the contract and warns before swapping. Adding a new
  part/slot is allowed but higher friction than replace.
- **Why:** Keep one live variant per production part so an old revision cannot sit next
  to a new one and get printed by accident.
- **Acceptance:** Production section + printer folders bootstrap; add/replace flows
  parse filenames and 3MF settings; replace shows a param diff and requires an explicit
  proceed / accept-new-baseline; generic library upload into a production folder is
  rejected; full suites and build pass.
  - Met in code and in the tests listed below. Combo-plate/multi-object remains v2.
  - Production backend tests: 36 passed (filename, settings, bootstrap, printer-model
    migration, production API). Library API (folder bootstrap + 409 block): 73 passed.
  - Frontend: `check:i18n` parity; `tsc --noEmit` clean; production-related vitest
    59 passed; full frontend vitest 2493 passed.
  - `ruff check` / `ruff format --check` clean on production-touched backend files.
  - Broader backend pytest (no xdist, ignore `test_bambu_ftp.py`): **8191 passed**.
  - Not a full `./test_all.sh`: `./test_backend.sh` died on ruff format of unrelated
    `library_sections.py` then on pytest `-n` (no xdist in this venv).
    `./test_frontend.sh` lint was red on unused `afterEach`/`vi` in
    `FileManagerPage.test.tsx` (removed). Docker, security, bambu FTP, a live browser
    pass, and a frontend production build / `static/assets` refresh were not run here.
- **Deliberately not done (v2):** combo plates where two parts on one plate have
  different object-level settings.
- **Branch:** `feat/production-file-slots`

### 15. Profile parameter tracking 🟠

- **Status:** 15a + source-label + **15b (part process sections + replace +
  upload-into-section)** + **H2D/H2S layer-height cap** + **Unfiled
  processes** on `feat/profile-parameter-tracking`. **Local preset
  download** on stacked `feat/profile-download`.
- **Area:** backend + frontend
- **What:** Apply the production print-settings contract to local slicer **process**
  presets on the Profiles tab, analogous to File Manager production tracking.
  - **15a — Read-only contract display.** Extract `CONTRACT_KEYS` from process preset
    JSON and show File Manager spec chips + spec modal on process cards. Filament and
    printer presets skipped. No import-mismatch flow.
  - **Source-label fix.** Import stored every preset as `orcaslicer`, so Bambu Studio
    exports showed as "Orcaslicer". Detect `bambu` vs `orcaslicer` from file type
    (`.bbscfg`/`.bbsflmt` vs `.orca_filament`) and payload markers (`@BBL`, Bambu
    printer ids, Bambu Studio fields). Correct existing rows on list/detail. UI
    shows **Bambu Lab** / **Orca Slicer**.
  - **15b — Part process sections + replace/diff + upload.** User-named sections
    (not the production TOP/KNB/BOT catalog). Attach one process per printer;
    first process seeds `locked_parameters`. Later adds/replaces
    `diff_parameters` against that baseline. Replace preview + proceed (keep
    baseline, mark mismatch) or accept-new-baseline (section contract ← incoming,
    clear that slot's mismatch and recompute the others). Upload a process file
    onto a section (`POST .../sections/{id}/import`); duplicate library names
    update the existing row; occupied printer slots return `needs_replace` for
    the existing replace modal. Matches spec / mismatch chips open the same
    Current print specs panel as File Manager.
  - **H2D / H2S layer-height cap.** Those printers max out at 0.24 mm. When
    the section baseline is thicker (e.g. 0.28 from X1C) and the incoming
    H2D/H2S/H2D Pro process is 0.24, treat it as a match — the printer's
    equivalent of the spec. 0.16 vs 0.28 is still a mismatch; 0.24 vs a
    locked 0.20 is a mismatch (they could have used 0.20). X1C / A1 / P1S
    stay strict. Implemented as `diff_parameters(..., printer_model=None)`
    so File Manager production diffs are unchanged unless a model is passed.
  - **Unfiled processes.** Profiles no longer lists every process in an
    **All processes** column. **Unfiled processes** shows only process
    presets that are not `active_preset_id` on any part-section slot.
    The user picks an existing section to move into (same attach /
    replace / Proceed anyway gates as upload). Filed processes stay
    only in their section.
  - **Local preset download** (branch `feat/profile-download`, stacked
    on this tip). `GET /local-presets/{id}/download` returns the stored
    resolved `setting` JSON as an attachment named `{sanitized-name}.json`
    (re-importable via the existing import path). Download control on
    Unfiled process cards, filament/printer cards, and part-section slot
    cards. `settings:read` is enough. Plain JSON rather than `.bbscfg`;
    section zip skipped. Page-level Import Profiles drop zone removed
    (Unfiled dump). Slot **Replace** uploads a process file into the
    section (`?slot_id=`) and uses the existing replace-confirm modal.
- **Why:** Catch accidental process-preset drift the same way production file replace
  catches 3MF settings drift. Group the same part's processes across printers.
- **Acceptance (15a):** process cards show compact spec summary when `locked_parameters`
  is present; list API does not include the full `setting` blob; filament/printer cards
  unchanged; extract-from-process unit tests and LocalProfilesView test pass.
- **Acceptance (15b):** create a named section; add 0.20 X1C then 0.28 A1 and see
  mismatch on layer_height; replace proceed keeps baseline; accept_baseline updates
  it. Upload a process JSON into an empty section (seeds contract); second printer
  with a different layer_height flags mismatch; same printer again returns
  `needs_replace` (not a second slot); filament-only upload is 400; duplicate
  name updates and attaches. Isolated `profile_part_*` tables. Process library
  cards stay. No auto-seeded TOP/KNB/BOT. Combo plates out of scope. UI heading
  **Part process sections**, add control **Add process sections**.
  H2S/H2D 0.24 vs a 0.28 section baseline Matches spec; H2S 0.16 still needs
  Proceed anyway. **Unfiled processes** (not All processes): heading + count,
  collapsed by default, move-to-section picker; attached presets leave Unfiled.
- **Acceptance (download):** Unfiled process / filament / printer / slot cards
  show a download control; `GET /local-presets/{id}/download` returns JSON
  + filename header; missing id is 404; file re-imports via existing import.
- **Deliberately not done:** combo plates; filament/printer presets; a display
  toggle; per-slot overrides UI. Library page import still skips duplicate names.
- **Branch:** `feat/profile-parameter-tracking` (download: `feat/profile-download`)

---

## Explicitly out of scope

_Things we've decided NOT to change, so they don't get re-litigated._

- 

---

## Done

| Change | Branch | Landed | Notes |
| --- | --- | --- | --- |
| 1. Remove the MakerWorld tab and page | `ui/remove-makerworld-tab` | 2026-08-16 | Frontend only; backend endpoints and `makerworld:*` permissions untouched |
| 2a. Remove the Archives tab, route and page | `ui/remove-archives-tab` | 2026-08-16 | UI layer only; backend, `archives:*` permissions and `print_archives` untouched. Orphaned the pending-uploads review UI — see entry #2 |
| 4. Replace the logo and app icons | `ui/backoffice-printing-logo` | 2026-08-16 | Artwork only; the name "Bambuddy" is unchanged throughout the app |
| Fix the Security Audit workflow for a private fork | `fix/security-workflow-private-repo` | 2026-08-17 | CI-only; unverified until pushed |
| 8. Atos Blue accent (`#07bcec`) | `ui/atos-blue-accent` | 2026-08-17 | New default accent; semantic greens deliberately unchanged; white-on-accent contrast still below AA |
| 3a-3c. Remove Projects | `feat/remove-projects` | 2026-08-17 | Code removed; `projects` / `project_bom_items` tables kept with rows intact |
| 10. Remove in-app updating | `fix/disable-upstream-updates` | 2026-08-17 | Only `GET /updates/version` and the two version helpers SpoolBuddy needs survive |
| 7. Fork attribution in GitHub docs | `docs/fork-attribution` | 2026-08-19 | README, CONTRIBUTING, CoC, SECURITY rewritten; LICENSE untouched; Docker kept as intended `--build` path |
