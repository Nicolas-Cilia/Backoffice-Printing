# Floor: stations, filament kg, harvest, cleanup

Complete planning document for the production-floor scanning system in Backoffice
Printing. Agreed in design sessions (August 2026). Implementation branch:
`feat/floor-stations`.

This is the source of truth for **what** we are building, **where** it lives in
the app, **how** the floor workflow runs, and **in what order** we ship and test
it.

---

## 1. Purpose

### 1.1 Problems we are solving

**Physical parts lose identity after the print.** Today the app knows what ran on
which printer, but a part on the support-removal bench is anonymous. We need to
tie a sticker on the part back to **that printer** and **that finished job**, so
defects can be logged against real print history.

**Filament stock is not tied to physical shelves.** Filament Tracking already
tracks named products (`FilamentColorBucket`) and subtracts grams when printers
run. We need **where** kg live: warehouse storage vs production WIP, updated by
scanning factory barcodes on spools and boxes—not by typing counts in a form.

**The floor cannot use normal app UI.** Operators wear gloves, hold parts, and
use a USB barcode pistol. The scan surface must be one focused page, big status
text, and prefix-based routing—not dropdowns and dense tables.

### 1.2 What we are not replacing

- **Inventory spools** (per-spool RFID, AMS, Spoolman) stay as they are.
- **Filament Tracking** usage engine (print progress → subtract grams from the
  assigned product) stays; we split stock into storage vs WIP and aim debit at
  WIP.
- **Printers page** stays the place to add/edit printers—no QR UI there.
- **Mixed/combo plates**, Android scanners, and full failure analytics are out
  of v1.

---

## 2. Physical layout

### 2.1 Benches and PCs

| Physical place | PC bookmarks | Pistol scans |
| --- | --- | --- |
| **Printer line** (clearing beds) | `/floor/scan` | Printer QRs, part Data Matrix |
| **Support cleanup** | same URL | Part Data Matrix, defect/command QRs |
| **WIP shelf** | same URL | WIP station QR, factory SKU barcodes |
| **Warehouse / storage shelf** | same URL | + Storage QR, Move QR, factory SKU barcodes |
| **Office** | Sidebar → **Floor** → **Codes** | Print station/printer/error QRs (paper printer) |

Kiosk PCs bookmark the **explicit** `/floor/scan` URL, not the bare `/floor`
shorthand — a kiosk should never see a picker screen on reload. `/floor`
itself is a small landing page (§3.1) reached by clicking **Floor** in the
sidebar: two destinations, Scan and Codes. It exists so an office user
navigating normally (not from a fixed kiosk bookmark) has a way to *reach*
Codes at all — before this, nothing in the app linked to `/floor/codes`.

Two (or more) pistols can share one logged-in app **at one bench**—the table
above is one PC per physical place, so "shared" means two pistols feeding one
`/floor/scan` tab at, say, the printer line, not one session shared across
benches. Session/station state is per browser tab; two benches never see or
stomp each other's station mode. Each scan is a string + Enter; the
**prefix** decides meaning. No mode switch on the keyboard.

### 2.2 Labels on the floor (what we print vs what we buy)

| Label | Source | Stuck on |
| --- | --- | --- |
| Station QRs (`BBS-…`) | App → Codes → browser print | Shelf, bench, harvest area |
| Printer QRs (`BBP-…`) | App → Codes | Each 3D printer |
| Error QRs (`BBF-…`) | App → Codes | Cleanup bench |
| Command QRs (`BBX-…`) | App → Codes | Cleanup bench (multi, rework) |
| Part Data Matrix (`BBD-…`) | **Bought roll** | Each finished part |
| Filament SKU | **Already on spool/box** | Never printed by us |

---

## 3. App layout

### 3.1 Sidebar

One new top-level item: **Floor** (name may become Operations / Production).
The sidebar item links to `/floor`, not directly to `/floor/scan`.

Under Floor (routes):

| Route | Purpose | UI style |
| --- | --- | --- |
| `/floor` | **Landing page** — picker: Scan / Codes. The sidebar item's destination; not a kiosk bookmark (see §2.1) | Normal app chrome + sidebar |
| `/floor/scan` | **Main floor page** — all pistol input | Sparse: big status, hidden always-focused scan field, sidebar collapsed or minimal |
| `/floor/codes` | Print QRs, register filament SKUs on products | Normal app chrome + sidebar |

Harvest and cleanup are **not** separate bookmark URLs for operators. The
**station QR** selects harvest vs cleanup vs WIP vs storage. The scan page is
one harness.

### 3.2 What stays unchanged

Printers, Queue, Files, Profiles, Inventory, Filaments, Settings—no QR
controls added to those pages.

### 3.3 Codes page (office)

Two main tabs:

**Printer labels** — one row per 3D printer already in the app (`BBP-{printer_id}`).
Print → preview (QR + name + payload) → size → browser print dialog.

**Error labels** — seeded horizontal / vertical / other; add new types (display
name + `BBF-` slug with autofill, editable); built-in commands multi + rework
(print only, no “add command” in v1).

**Station labels** — WIP, + Storage, Move, Harvest, Cleanup (each `BBS-…`).

Print size: 40 / 60 / 80 mm or custom W×H. Last size remembered. Not a label
printer driver in v1—browser print to office paper, cut and tape.

Part stickers (`BBD-…`) and factory filament SKUs are **never** printed here.

---

## 4. Scan routing (prefixes)

The USB pistol types a string and Enter. Backend (or frontend router) classifies:

| Prefix | Example | Role |
| --- | --- | --- |
| `BBS-` | `BBS-wip`, `BBS-storage-receive`, `BBS-storage-move`, `BBS-harvest`, `BBS-cleanup` | Station: open/close session, set mode |
| `BBP-` | `BBP-12` | Printer identity (harvest only) |
| `BBD-` | `BBD-000042` | Unique physical part (harvest link, cleanup lookup) |
| `BBF-` | `BBF-horizontal`, `BBF-warping` | Defect type (cleanup) |
| `BBX-` | `BBX-multi`, `BBX-rework` | Cleanup commands (v1: only these two) |
| Factory barcode | digits/alphanumeric from vendor | Filament SKU → kg delta for a tracking product |

Unknown string: flash error, change nothing.

Station scan while another session is open: close previous, open new (or same
station closes—see per-station rules).

---

## 5. Stations (detailed)

A **station** is a configured mode + optional link to a logical place (WIP shelf,
storage shelf, harvest bench). Scanning its QR is always the first step on that
bench (except harvest can continue with printer QR once harvest mode is active).

### 5.1 WIP

**Purpose:** Production shelf—filament that is “in play” for the line.

**Open:** Scan WIP station QR.

**While open:**

- Scan factory SKU → **add** kg to that product’s **WIP** total (1 kg code → +1 kg,
  10 kg box code → +10 kg).
- Also the **destination** that completes a **Move** from storage (see below).

**Close:** Scan WIP QR again (normal close), or scan another station QR.

**No minus QR on WIP.** Kg leave WIP when printers consume filament (existing
Filament Tracking debit, pointed at WIP).

**Screen:** Station name (e.g. “WIP”), optional product/kg hint after SKU scans.

### 5.2 + Storage (receive)

**Purpose:** Warehouse shelf—incoming shipments.

**Open:** Scan + Storage QR (at the storage location).

**While open:** Scan factory SKU → **add** kg to that product’s **storage** total.

**Close:** Scan + Storage QR again.

**Screen:** “Storage — receiving”, running session totals optional (v1: minimal).

### 5.3 Move (storage → WIP)

**Purpose:** One intentional workflow to pull stock from warehouse to production
without a separate “minus storage” QR.

**Open:** Scan **Move** QR (physically at storage).

**While open:** Scan factory SKU(s)—each scan **queues** kg to move off storage
for that product (same kg weights as receive: 1 vs 10).

**Close / complete:** Scan **WIP** QR (not the SKU again). That atomic step:

- Subtract queued kg from **storage** for each product
- Add same kg to **WIP** for each product
- End move session

If operator scans WIP without Move open, WIP behaves as normal add-only.

**No − Storage QR in v1**—Move + WIP close replaces it.

**Abandoned move:** nothing is subtracted from storage until the WIP-close
step runs, so a queued-but-uncommitted move is safe to drop. If the operator
scans any station other than WIP while a Move session is open (station-switch
rule, §4), the queue is discarded and the scan screen shows **"Move
cancelled — N kg not moved"** for a few seconds before showing the new
station's normal screen, so the operator knows to redo it rather than
assuming it went through.

### 5.4 Harvest

**Purpose:** Label parts while clearing the bed. Next job cannot start until bed
is empty; stickers go on during clear.

**Open:** Scan Harvest station QR (or first action is printer QR once in harvest
mode).

**Flow:**

1. Scan **that printer’s** QR (`BBP-{id}`) → bind session to **that printer’s
   latest finished job** (`print_archives` row).
2. For each part: apply bought Data Matrix sticker, scan `BBD-…` → create/link
   **labeled part** row to that archive. One sticker = one physical part.
   Same-item plates only (every part on plate is same model).
3. **Close plate:** Scan **same printer QR again**, OR scan **different printer
   QR** (closes this plate and opens that printer’s latest job).

   No ambiguity here: a printer cannot produce a second finished job while
   `awaiting_plate_clear` is true (`printer_manager.py`), so within one open
   harvest session the "latest finished job" for a given printer can never
   change. Re-scanning the same printer QR is always just a close—there is no
   second plate it could be reopening against. A later visit to that same
   printer (after it has finished another job and is awaiting clear again)
   is a fresh `Scan printer QR` per step 1, which naturally picks up the new
   latest job.

**Screen:**

- After printer scan: **printer name**, plus **"open Nm"** / **"open Nh"**
  elapsed-time indicator next to it (session `opened_at` is already stored
  server-side per §8, so this is a pure read—no new tracking, no polling, no
  auto-close). Harmless and unremarkable while an operator is actively
  clearing a bed (open 2m); becomes the exact stale-session signal when it
  isn't (open 14h), without any timeout/detection logic behind it.
- After each part scan: **part model** (job’s `print_name` / print name from archive)
- Optional: part count this session

**Ignores:** `BBF-`, `BBX-`, filament SKUs, other station QRs without closing.

**Forgotten close:** No auto-close and no notification in v1—next printer
scan closes the leftover session (same printer = one extra scan; different
printer = closes and opens). The elapsed-time indicator above is the only
v1 mitigation: it makes a stale session visible to whoever's next at that
screen (or checking from the office), rather than fixing it automatically.
Risk without that indicator: part scans without a printer scan first attach
to whatever session happens to be open, however old—training: always printer
first. Full detection/warnings (e.g. flagging it elsewhere in the app, not
just on the scan screen itself) stay out of v1 (§11).

### 5.5 Cleanup

**Purpose:** Log defects at support removal. **Good parts are not scanned.**

**Open:** Scan Cleanup station QR.

**Flow:**

1. Scan part `BBD-…` → show **which printer** (and ideally part model).
2. Optional: scan `BBX-rework` (if not trash).
3. Defect path:
   - **One defect:** scan `BBF-horizontal` / vertical / other → save → confirmation → **waiting for part**
   - **Several defects:** `BBX-multi` → scan each `BBF-…` → `BBX-multi` again → save
   - **Other:** `BBF-other` → **keyboard** types note → save
4. Default disposition: **trash**. Rework only if `BBX-rework` was scanned before defect.

**Screen:** After save, back to idle (“Scan a part”). **No running tally** on
station (reports later).

**Ignores:** `BBP-` printer QRs.

---

## 6. Filament products and SKUs

### 6.1 Tracking product (existing)

Filament Tracking already uses `FilamentColorBucket`: a named product (color name,
material, brand, subtype, …) with `on_hand_grams`. Printer AMS slots assign to
a bucket; prints subtract grams via `FilamentColorUsage` and MQTT/archive hooks.

### 6.2 What we add

**Ledger table, not raw columns.** A new `filament_stock_movements` table,
same event-log shape as the existing `FilamentColorUsage` (bucket_id, grams,
occurred_at, kind, source_key for idempotency)—one row per kg-affecting
event, ever:

| Column | Notes |
| --- | --- |
| `id` | PK |
| `bucket_id` | FK → `filament_color_buckets`, cascade delete |
| `direction` | `receive` \| `move_out` \| `move_in` \| `consume` \| `manual_adjust` |
| `grams` | positive; `direction` gives the sign |
| `occurred_at` | server default now |
| `source_key` | unique—same idempotency pattern as `FilamentColorUsage.source_key` (a re-sent scan or a retried webhook can't double-count) |
| `sku_id` | FK → new SKU registry row, nullable (null for `consume`/`manual_adjust`) |
| `session_id` | FK → station scan session, nullable (null for `manual_adjust` from the office UI) |

`storage_grams` and `wip_grams` are **derived**, not stored as independently
writable columns: `storage_grams = SUM(grams) WHERE direction IN
(receive) - SUM(grams) WHERE direction = move_out`, and equivalently for
`wip_grams` from `move_in`/`consume`. In practice these are cached columns
on `FilamentColorBucket`, recomputed transactionally inside the same
transaction as each ledger insert (same pattern as `on_hand_grams` today,
just now written from one place—the ledger insert—instead of scattered
across every mutation site). This also answers §12's "session audit log"
question for free: the ledger *is* the audit log, no separate table needed.

**`on_hand_grams` is deprecated as an independently-set field.** It becomes
`storage_grams + wip_grams` everywhere it's read (Filament Tracking's cover
days, order-in countdown, monthly estimate, and any other reader). Every
code path that currently writes `on_hand_grams` directly is migrated to
insert a `filament_stock_movements` row instead:

- **Existing Filament Tracking "Add stock" / "Edit stock" modal** (typed kg,
  no scanning) keeps working exactly as it does today from the operator's
  point of view—but under the hood it now inserts a `manual_adjust` ledger
  row (into `storage_grams`, the assumption being office-typed stock is
  warehouse stock until moved) instead of writing `on_hand_grams` directly.
  One ledger, two entry paths: scan flow for the floor, typed entry for the
  office/corrections. No UI change required in that modal for this to work.
- **Print debit (existing engine):** when a print completes (or live usage
  settles), insert a `consume` row against `wip_grams`—same
  `FilamentColorUsage` write that already happens today, plus this one.
  Printer already knows product via `FilamentSlotAssignment`.

**SKU registration** (office, on the filament product):

- Factory barcode on spool or box (we do not print it)
- Maps to: this tracking product + **kg per scan** (1 for single spool, 10 for
  box of ten, etc.)
- Multiple SKUs per product allowed
- Unknown barcode at shelf → error

**Receive (+ Storage):** insert one `receive` row per scan, `grams = sku_kg`.

**Move → WIP close:** insert one `move_out` row per queued product (against
storage) and one `move_in` row (against WIP) per product, same amounts, in
the same transaction that closes the Move session.

We do **not** create a new Inventory spool row per SKU scan.

---

## 7. Labeled parts (harvest / cleanup)

### 7.1 Part identity

- Code: `BBD-000000` through `BBD-999999` (6 digits; bought roll)
- First harvest scan **enrolls** the code
- One code = one physical part forever; re-scan shows existing link, does not steal

### 7.2 Part record (new table, conceptual)

- `sticker_code` (unique)
- `archive_id` → finished print (`print_archives`)
- `printer_id` (denormalized or via archive)
- `labeled_at`
- Defect records (cleanup): type (`BBF-` slug or other text), disposition
  (trash / rework), timestamp

Does **not** duplicate filament, temps, file path—join archive when needed.

### 7.3 Cleanup defect types

**Seeded:** horizontal line, vertical line, other (`BBF-horizontal`, etc.)

**Add in Codes:** display name + editable `BBF-` slug (autofill from name).

**Commands (v1, built-in only):** `BBX-multi`, `BBX-rework`. New BBX behaviors = v2.

---

## 8. Data and reporting (v1 scope)

**Stored in v1:** labeled parts, defect events, `filament_stock_movements`
(the storage/WIP ledger—see §6.2, doubles as the audit trail), SKU registry,
station scan sessions.

**Not in v1 UI:** failure-by-printer charts, cleanup shift tallies on scan screen,
operator QRs. Data should be queryable later from the same tables.

---

## 9. Mis-scans and edge cases (v1)

| Situation | Behavior |
| --- | --- |
| Unknown scan string | Error flash, no state change |
| Defect / rework / multi without part in cleanup | Ignore |
| Part scan with no cleanup part in front | Ignore (or error) |
| Part already linked at harvest | Show link, do not relink to new job |
| SKU scan outside open station session | Error |
| Move open, scan WIP | Complete move |
| Move open, scan anything other than WIP | Discard queued kg (nothing was committed), show "Move cancelled — N kg not moved", switch to the new station |
| Harvest session open, scan cleanup station | Close harvest, open cleanup |

Undo: control on station screen (v1). Undo QR on bench can wait.

---

## 10. Build order and test gates

Ship in thin vertical slices. **Pistol test** at every gate before the next phase.

| Phase | Build | Test gate (manual + pistol) |
| --- | --- | --- |
| **0** | Floor sidebar item (→ `/floor` landing page, Scan/Codes picker) + `/floor/scan` shell (always-focused input, status text). Codes button on the picker disabled/"coming soon" until Codes exists. | Type garbage → error. Page stable. Sidebar → `/floor` shows the picker; Scan navigates to the shell; Codes is visibly disabled, not a dead link. |
| **1** | Station entities + print station QR (`BBS-…`) for WIP, + Storage, Move | Print one QR. Scan → correct station/mode. Scan again → closed. Other station → switch. |
| **2** | `filament_stock_movements` ledger + derived `storage_grams`/`wip_grams` on `FilamentColorBucket`; migrate `on_hand_grams` readers (Filament Tracking cover/order-in/monthly-estimate math) to the derived sum; existing Add/Edit stock modal writes a `manual_adjust` row instead of `on_hand_grams` directly | Existing Filament Tracking page behaves identically for a user typing stock by hand—cover days, order-in, monthly estimate unchanged for a bucket with no Floor activity yet. `on_hand_grams` column removed or frozen; nothing else in the app still writes it directly. |
| **3** | SKU registration on filament tracking product | Register real box/spool barcode → product + kg. |
| **4** | + Storage receive | + Storage → SKU → storage kg up (via `receive` ledger row). Unknown SKU → error. Close session. |
| **5** | Move → WIP | Move → SKUs → WIP QR → storage down, WIP up (`move_out`/`move_in` rows, one transaction). Abandoned move (switch to non-WIP station) discards the queue and shows the cancellation message. |
| **6** | Point print debit at WIP | Finish print on assigned product → WIP kg down (`consume` row, existing tracking hooks). |
| **7** | Printer QRs in Codes + harvest printer bind | Print `BBP-…`. Scan → printer name + latest finished job. |
| **8** | Harvest part linking + elapsed-time indicator | Printer → `BBD-` parts → printer close. DB: parts → correct archive. Same-printer rescan closes only (never reopens against a stale plate—see §5.4). Leave a session open, reload the page—elapsed time shown next to the printer name and increases correctly. |
| **9** | Cleanup defects | Part → defect / rework / multi / other. Trash vs rework. Harvest codes ignored. |

**Suggested branch strategy:** one feature branch (`feat/floor-stations`) with
sequential commits per phase, or sub-branches merged in order. Codes UI polish
(size picker, error editor) can trail phase 1 once minimal print works.

**CI:** frontend lint/tsc/tests + backend ruff/pytest for each phase touching
those layers.

---

## 11. Explicitly not in v1

- Mixed / combo build plates
- Android scanner (USB pistol only)
- Auto-close harvest plate by object count from slice
- Timeout-as-close for any session
- Queue of unlabeled finished jobs (label while clearing bed)
- Forgotten-close **detection**: no auto-close, no notifications, no alerts
  surfaced anywhere outside the scan screen itself (§5.4's elapsed-time
  indicator is passive display only—reading an existing timestamp, not new
  detection/warning logic—and stays in v1)
- Cleanup station tallies (“4 horizontal today”)
- Failure analytics / printer defect reports UI
- Minus QR on WIP
- − Storage QR (Move + WIP instead)
- New `BBX-` commands or user-defined command actions
- QR controls on Printers tab
- Creating Inventory `spool` rows per SKU scan
- Syncing WIP kg to AMS slot readings
- Operator / person QRs

---

## 12. Open naming / polish (safe to defer)

- Sidebar label: Floor vs Operations vs Production
- Exact `BBS-` payload strings for each station type
- Whether harvest requires scanning Harvest station QR before first printer QR
- Display of storage/WIP kg on Filaments page vs Floor-only

---

## 13. Related docs and code

- Filament Tracking: `backend/app/models/filament_tracking.py`,
  `backend/app/services/filament_tracking.py`, Inventory → Filaments tab
- Finished prints: `print_archives`, printer `awaiting_plate_clear` (operational
  cousin to “bed must be clear”)
- Inventory locations: `docs/storage-locations.md` (separate from Floor WIP/storage
  **kg ledger**—may share names conceptually but different purpose)
- Fork plan entry: `FORK_PLAN.md` §16 (summary + branch)

---

## 14. One-page workflow recap

**Receive shipment to warehouse:** + Storage → scan each box/spool barcode → + Storage.

**Stock the line:** Move → scan SKUs → scan WIP.

**Or direct to WIP:** WIP → scan SKUs → WIP.

**Print uses filament:** printers debit WIP kg (automatic).

**Print finishes:** clear bed → Harvest → printer QR → sticker + scan each part → printer QR.

**Bad part at cleanup:** Cleanup → part → (rework?) → defect QR → saved → wait.

**Office:** register new factory barcode on product; print new station/printer/error QR when needed.

---

## 15. Implementation timeline and project tracker

This section is the **living tracker** for building Floor: current status per
phase, the testing/staging approach, and a dated log of what actually
happened (decisions, deviations from plan, blockers). Update §15.1's status
column and append to §15.8 as work lands—this section is expected to drift
from a static plan into a running record, unlike §1–§14 above which describe
the target design.

### 15.1 Phase status

| # | Phase | Status | Branch/PR |
| --- | --- | --- | --- |
| 0 | Floor sidebar + `/floor` landing picker + `/floor/scan` shell | In progress (PR open) | `feat/floor-stations-p0-scan-shell`, [PR #89](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/89) |
| 1 | Station entities + `BBS-` QR (WIP, + Storage, Move) | Not started | — |
| 2 | `filament_stock_movements` ledger + derived storage/WIP + `on_hand_grams` migration | Not started | — |
| 3 | SKU registration (office) | Not started | — |
| 4 | + Storage receive | Not started | — |
| 5 | Move → WIP | Not started | — |
| 6 | Point print debit at WIP | Not started | — |
| 7 | Printer QRs in Codes + harvest bind | Not started | — |
| 8 | Harvest + cleanup + elapsed-time indicator | Not started | — |
| — | Staging dry run (§15.6) | Not started | — |
| — | Production cutover (§15.7) | Not started | — |

Status values: **Not started** / **In progress** / **Blocked** (note why in
§15.8) / **Done**.

### 15.2 Testing infrastructure: disposable staging instance

Built and validated **before** Phase 0 starts, so every later phase's pistol
test gate has somewhere safe to run:

```bash
mkdir -p ~/bambuddy-floor-staging
DATA_DIR=~/bambuddy-floor-staging PORT=8090 \
  venv/bin/python3 -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8090
```

- `DATA_DIR` fully isolates the SQLite DB from the real `bambuddy.db`—no
  shared state, no risk to real inventory/filament/printer data.
- Removal is `rm -rf ~/bambuddy-floor-staging`. Nothing to reconcile back.
- Register 2–3 **virtual printers** in this instance (existing feature,
  `backend/app/services/virtual_printer/`). Their MQTT `gcode_state=FINISH`
  cycle is the same signal real hardware sends—it creates real
  `print_archives` rows and sets `awaiting_plate_clear`, so Harvest (Phase 8)
  is fully pistol-testable without physical printers.
- Real USB pistols work against it identically to production: a pistol just
  types a string into whichever tab has focus. Point a browser tab at
  `localhost:8090/floor/scan` and real hardware + real printed labels test
  the real flow against a throwaway database.
- Physical hardware only enters at Phase 3 (one real factory barcode to
  register) and Phase 8 (bought Data Matrix roll—order early, it has lead
  time). Every other phase is virtual-printer-driven.

### 15.3 Branch and commit strategy

Sub-branches per phase, merged into `feat/floor-stations` in order (not one
mega-branch)—matches §10's own suggestion. Each phase's pistol-test gate
doubles as that sub-PR's review checkpoint, and `feat/floor-stations` stays
in a working state throughout. `feat/floor-stations` itself stays unmerged
into `dev` until Phase 8 passes staging—nothing user-facing activates before
then (no station QRs exist to scan).

CI per phase: frontend lint/tsc/`test:run` + backend `ruff check` / `ruff
format --check` / pytest for whatever that phase touches (same as §10).

### 15.4 Seed data for staging

A checked-in seed script (e.g. `scripts/seed_floor_staging.py`) rather than
manual clicking every time, so every phase starts from the same known state:

- 2–3 virtual printers, one already mid-print (tests "scan printer QR while
  running")
- 2 tracking products with SKUs registered
- One SKU intentionally **not** registered (exercises "unknown barcode →
  error")
- All 5 station QR payloads pre-rendered as one PDF, printed once, reused
  across every phase

### 15.5 Per-phase test gates

| Phase | Automated tests | Pistol test gate |
| --- | --- | --- |
| 0 | Component test: renders, hidden input keeps focus | Type garbage → error, page stable |
| 1 | Integration: station open/close/switch API | Print 1 QR. Scan → correct mode. Scan again → closed. |
| 2 | Unit: ledger math, derived-sum correctness. Regression: existing Filament Tracking cover/order-in numbers unchanged for a bucket with no Floor activity | None (pure backend) |
| 3 | Integration: SKU registration → product + kg mapping | Register 1 real barcode |
| 4 | Integration: receive → storage kg up; unknown SKU → error | + Storage → SKU → storage kg up → close session |
| 5 | Integration: atomic storage-down/WIP-up; abandoned-move discard | Move → SKUs → WIP QR → storage down, WIP up. Also: open Move, scan Cleanup, confirm "Move cancelled" message. |
| 6 | Integration: consume path also writes a ledger row | Virtual printer finishes an assigned-product print → WIP kg down |
| 7 | Integration: printer QR → latest finished job | Print `BBP-…` for a virtual printer, scan → correct job |
| 8 | Integration: part linking, defect save, same-printer-close, abandoned-session display | Full loop on a virtual printer's finished job: printer → parts → close. Then a real defect scan. Leave a session open, reload, confirm elapsed time shows and increments. |

### 15.6 Dry run before production

Once Phase 8 passes on staging: real pistols, real printed labels, pointed
at the staging instance, physically walking the floor bench-to-bench against
either a virtual printer or one disposable real print. Catches ergonomics
issues (label placement, scan-field focus loss, screen readability under
floor lighting) unit tests can't.

### 15.7 Cutover to production

1. Merge `feat/floor-stations` → `dev` → `main`. Nothing activates on its
   own—no station QRs exist until printed.
2. Print the **real** `BBP-{printer_id}` QRs from the production Codes
   page—payloads are printer-specific, staging's virtual-printer IDs won't
   match.
3. Soft-launch on **one bench** first (e.g. WIP + one printer's harvest), not
   the whole floor at once.
4. Roll to the rest of the floor once that bench has run a full day without
   a mis-scan.
5. Ongoing safety valve: the on-station Undo control (§9) is the rollback
   for a bad scan in production—no manual DB edits for routine mistakes.

### 15.8 Progress log

Dated entries, most recent first. Record what happened, not just what was
planned—decisions made, deviations, blockers, and their resolutions.

**2026-08-23:** Phase 0 built and opened as
[PR #89](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/89)
(`feat/floor-stations-p0-scan-shell` → `feat/floor-stations`): sidebar item,
`/floor/scan` shell, every scan flashing unknown per §9. One real bug found
during manual verification (not by the automated suite—jsdom's timing didn't
reproduce it): the Enter handler originally closed over React `value` state,
which a fast enough same-tick input+Enter dispatch could read as stale
before a render committed between them—exactly the shape of a USB pistol's
scan. Fixed by reading from a ref updated synchronously in `onChange`
instead. Also found live: the shell needed an explicit `z-50` to fully cover
Layout's chrome (mobile header, desktop sidebar)—without it "sparse" wasn't
actually sparse at some viewport widths. Verified end-to-end against a
`DATA_DIR`-isolated instance per §15.2, using the browser tool directly
against a live `uvicorn` + `vite` dev pair rather than only unit tests.

**2026-08-23:** Design doc (§1–§14) finalized after review: same-printer
harvest rescan clarified as unambiguous (§5.4), storage/WIP modeled as a
ledger table rather than raw columns (§6.2), `on_hand_grams` deprecated in
favor of a derived sum, abandoned Move sessions discard-and-warn (§5.3), and
a passive elapsed-time indicator added for forgotten harvest sessions
(§5.4/§11). This §15 timeline added: nine build phases with a `DATA_DIR`-
isolated staging instance for testing, virtual printers standing in for
real hardware through Phase 8, and a sub-branch-per-phase strategy. Nothing
implemented yet—Phase 0 not started.
