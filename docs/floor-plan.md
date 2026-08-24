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

### 2.1 Hardware (v1)

**One PC with one screen, and one wireless USB pistol.** That is the whole
kit. Everything in this doc is designed against it; anything richer is a
later stage (§2.3), not an assumption v1 may lean on.

The screen sits in the **printer / cleanup / WIP area** — one physical zone
covering the printer line, the support-cleanup bench and the WIP shelf. The
warehouse / storage shelf is the one place the operator goes *away* from the
screen, taking the wireless pistol with them.

| Physical place | Screen visible? | Pistol scans |
| --- | --- | --- |
| **Printer line** (clearing beds) | Yes — screen is here | Printer QRs, part Data Matrix |
| **Support cleanup** | Yes — screen is here | Part Data Matrix, defect/command QRs |
| **WIP shelf** | Yes — screen is here | WIP station QR, factory SKU barcodes |
| **Warehouse / storage shelf** | **No** — out of sight of the screen | + Storage QR, Move QR, factory SKU barcodes |
| **Office** | Own desk PC | Print station/printer/error QRs (paper printer) |

The floor PC bookmarks the **explicit** `/floor/scan` URL, not the bare
`/floor` shorthand — it should never see a picker screen on reload. `/floor`
itself is a small landing page (§3.1) reached by clicking **Floor** in the
sidebar: two destinations, Scan and Codes. It exists so an office user
navigating normally (not from the floor PC's fixed bookmark) has a way to
*reach* Codes at all — before this, nothing in the app linked to
`/floor/codes`.

Each scan is a string + Enter; the **prefix** decides meaning (§4). No mode
switch on the keyboard, and no mode switch on the gun.

### 2.2 Scanning out of sight of the screen

The storage shelf is out of the screen's line of sight, so scans made there
land **blind**: the operator hears the gun's decode beep but cannot see
whether the app accepted the scan. The gun beeps on a successful *decode*,
which says nothing about whether the payload meant anything to the app — an
unregistered SKU beeps exactly like a good one. Blind scanning is therefore
treated as a first-class case, not an edge case.

| Flow | Scanned at | Blind? | Commits immediately? | What protects it |
| --- | --- | --- | --- | --- |
| Harvest | Printer line | No | Yes | Screen is right there |
| Cleanup | Cleanup bench | No | Yes | Screen is right there |
| Move — queue kg | Storage shelf | **Yes** | **No** | Nothing leaves storage until the WIP scan (§5.3); the queue is reviewed on screen before committing |
| Move — complete | WIP shelf | No | Yes | Operator is back at the screen, reading the queue they are about to commit |
| + Storage receive | Storage shelf | **Yes** | **Yes** | Error tone + end-of-session summary (below) |

**Move is safe by construction.** The blind half commits nothing, the
operator carries the spools back to the WIP shelf anyway, and the completing
scan happens in front of the screen. This only holds if the screen **lists
the queued products and kg while a Move session is open**, so the WIP scan is
a confirmed action rather than a leap of faith. That display is a hard
requirement, not a nicety (§5.3).

**+ Storage receive is the one genuinely exposed flow** — blind *and*
committing. The intended fix is a **second screen at the storage shelf**
(§2.3), which removes the blindness entirely rather than compensating for
it. Until that exists, two mitigations carry v1:

- **Error tone.** A distinct sound on a *rejected* scan, so a bad SKU is
  audible over the gun's own decode beep. Success stays silent; the gun
  already beeps, and a second confirming sound would just train the operator
  to ignore both.
- **Session summary.** When the operator returns to the screen, the receive
  session shows what it accepted and rejected (e.g. "14 accepted, 2
  rejected") so a blind mistake surfaces at the end of the run rather than at
  the next stock count.

Both are deliberately cheap. They are a **bridge until the storage screen
lands**, not a permanent ergonomic layer worth deep investment — no
voice prompts, no confirm-and-repeat handshakes, no scan-to-verify passes.

### 2.3 Later stages (not v1)

Recorded so the constraints are not re-derived later. None is in scope.

- **A second screen at the storage shelf.** The intended resolution for the
  one blind-and-committing flow (+ Storage receive, §2.2). Needs no new
  concepts: it is another machine on `/floor/scan` with its own device
  identity, so it holds its own station (+ Storage) while the WIP screen
  holds another — the floor-wide locks in §2.4 permit that, since they are
  per *station*, not one session for the whole floor. It also needs its own
  pistol; the two screens must never share one. Cheapest of the three and
  the only one that retires a real risk, so it is the natural next hardware
  step after v1.
- **Android scanner gun with a browser** (Zebra TC-series, Honeywell
  CT-series, pistol-grip Android units), *in addition to* the PC. Compatible
  with this design **only if the device's scan engine is configured as a
  keyboard wedge with an Enter suffix** — it then types into the focused
  field exactly like the USB pistol, needing no code change. The alternative
  engine mode delivers scans as Android intents, which a web page cannot
  receive without a native wrapper app. Adding a second device also makes
  concurrent sessions real, which is why the harvest lock in §2.4 is defined
  now rather than later.
- **Additional fixed PCs** per area, reducing how much of the floor is blind.

### 2.4 Session state ownership and concurrency

**Sessions live on the server.** Not in the browser tab. A station session is
an exclusive claim, and a claim only means anything if every device can see
it — so the source of truth is a `floor_station_sessions` row, and the
client reads it rather than owning it.

Two rules, and they compose:

1. **One open session per device.** A device is in exactly one station mode
   at a time, or none. This is what makes station switching coherent:
   scanning a new station QR closes the device's current session and opens
   the new one, atomically.
2. **One open session per station, floor-wide — except cleanup.** WIP,
   + Storage, Move and Harvest are each claimed by at most one device across
   the whole floor. A second device scanning that station's QR is
   **refused**, and told which device holds it and for how long.

**Cleanup is the exception, and needs no special case.** It carries no
floor-wide lock, so its only constraint is rule 1 — which already says one
session per device. That is exactly the desired behavior: two people cannot
share one machine for cleanup, two machines running cleanup at once is
fine.

| Station | Floor-wide lock | Effect |
| --- | --- | --- |
| WIP | Yes | One person adding to WIP at a time |
| + Storage (receive) | Yes | Two people receiving at once creates ambiguity about who scanned what |
| Move | Yes | One queue at a time |
| Harvest | Yes | Two people linking parts to jobs is a data conflict (§5.4) |
| **Cleanup** | **No** | Per-device only — parallel cleanup on separate machines is normal work |

**Why two pistols must never share one screen.** The cleanup rule
generalizes: a pistol types into whatever has focus, so two pistols feeding
one input field interleave their characters and produce garbage. This is a
property of the hardware, not of any station. One screen, one pistol,
always. An earlier draft of this doc claimed two pistols could share a
bench — that was wrong and is retracted.

**Device identity.** A UUID generated on first use and kept in
`localStorage`, so it is stable per machine and per browser profile rather
than per tab. Per-tab identity would let one machine open two cleanup
sessions in two tabs, which is the jumbling case above. It is an identity
for the lock, not a security boundary.

**Abandoned sessions must be recoverable.** A floor-wide lock deadlocks the
floor if someone leaves WIP open and goes home. §11 rules out closing
sessions on a timer, so instead the refusal is **actionable**: the screen
names the holding device and how long the session has been open (§5.4's
elapsed-time indicator, now useful at every station), and offers to **take
over** — closing the stale session and opening yours. Deliberate and
visible, rather than automatic and silent.

Takeover is not only for contention between two people. The likelier v1
failure is **one machine losing its own identity** — `localStorage` cleared,
a different browser profile, a reinstall — after which the old session sits
open holding the station forever and the only remaining fix is editing the
database by hand. That is why takeover ships in v1 despite there being just
one device to contend with.

**Keep the takeover UI deliberately thin.** A refusal line naming the holder
and its elapsed time, plus a confirm. That is the whole feature. **No
session-management screen and no admin view of open sessions** — those wait
until a second device exists to make them worth anything (§11). The lock and
its recovery path are the load-bearing parts; the surface around them is
not, and building it early would be scope with no reader.

**What this costs.** Scanning now depends on the server being reachable,
where per-tab state would have degraded gracefully. Accepted: from phase 4
onward every meaningful scan writes to the server anyway, so local-only
station state would have been a false comfort. The Move *queue* is the one
piece that could have stayed client-side, and it does not — it belongs to
its session row, so the operator sees the same queue after a reload or from
the office.

### 2.5 Labels on the floor (what we print vs what we buy)

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
| `/floor` | **Landing page** — picker: Scan / Codes / Inventory. The sidebar item's destination; not a kiosk bookmark (see §2.1) | Normal app chrome + sidebar |
| `/floor/scan` | **Main floor page** — all pistol input | Sparse: big status, hidden always-focused scan field, sidebar collapsed or minimal |
| `/floor/codes` | Print QRs, register filament SKUs on products | Normal app chrome + sidebar |
| `/floor/inventory` | **Stock by location** (storage vs WIP), movement history, and manual corrections (§6.3) | Normal app chrome + sidebar |

Harvest and cleanup are **not** separate bookmark URLs for operators. The
**station QR** selects harvest vs cleanup vs WIP vs storage. The scan page is
one harness.

`/floor/inventory` is deliberately named for **inventory**, not filament.
Other categories (motherboards, components) are expected later and will join
this page as siblings. What that does *not* mean is a generalized schema
today — see §6.3 for where the line is drawn.

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

**This station is filament WIP, and only filament.** The production-line WIP
where finished parts are booked in (§11.1) is a *separate station* with its
own QR — not this one wearing a second hat. Keeping them apart means this
station stays factory-SKU-only, and the part-production station can be added
later without touching it.

**Close:** Scan WIP QR again (normal close), or scan another station QR.

**No minus QR on WIP.** Kg leave WIP when printers consume filament (existing
Filament Tracking debit, pointed at WIP).

**Screen:** Station name (e.g. “WIP”), optional product/kg hint after SKU scans.

### 5.2 + Storage (receive)

**Purpose:** Warehouse shelf—incoming shipments.

**Open:** Scan + Storage QR (at the storage location).

**While open:** Scan factory SKU → **add** kg to that product’s **storage** total.

**Close:** Scan + Storage QR again.

**Screen:** “Storage — receiving”, plus a running session tally.

**Blind flow (v1).** This is scanned at the storage shelf, out of sight of
the screen, and it **commits on every scan** — the one flow that is both
(§2.2). Until a storage screen exists (§2.3), v1 carries two cheap
mitigations:

- A distinct **error tone** on a rejected scan, audible over the gun's own
  decode beep. Accepted scans stay silent.
- A **session tally** the operator reads on returning to the screen —
  accepted count, rejected count, and which payloads were rejected — so a
  blind mistake surfaces at the end of the run instead of at the next stock
  count. This is why session totals are no longer "optional".

**The tally persists until acknowledged.** It is a stored record, not screen
state: it survives reload, tab close and shift change, and stays visible
until an operator explicitly marks it read. A tally that vanished with the
tab would defeat its own purpose — the whole point is that nobody saw the
rejection when it happened.

- Stored per receive session: accepted count, rejected count, the rejected
  payloads, and who acknowledged it when.
- Surfaced as a banner on `/floor/scan` and a badge on the `/floor` landing,
  so an unread tally from yesterday's shipment cannot quietly disappear.
- **Warns, does not block.** An unacknowledged tally never prevents opening
  the next receive session; mid-shipment friction would just train operators
  to dismiss it blind, which is the failure it exists to catch.
- Acknowledging is a read receipt, not a fix. The correction itself happens
  in `/floor/inventory` (§6.3).

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

**The queue must be visible before it is committed.** The queueing half is
scanned blind at the storage shelf; the completing WIP scan happens at the
WIP shelf, in front of the screen (§2.2). So while a Move session is open
the screen **lists every queued product and its kg**, and that list is what
the operator checks before scanning WIP. This is a hard requirement, not a
nicety — it is the only verification the blind half ever gets, and it is
what makes scanning out of sight of the screen safe here. Without it the
WIP scan is a leap of faith.

Because nothing commits until that scan, a misscan at the shelf costs
nothing: the operator sees the wrong line on screen and simply does not
complete the move (or cancels and redoes it).

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

**One harvest session floor-wide** — the general station lock in §2.4, not a
special case. Only one harvest session may be open at a time, on any
printer, across the whole floor: not one per printer. A second device
scanning a printer QR is **refused**, and the screen names the holding
device and how long the session has been open (the elapsed-time indicator
above), with the option to take over.

Rationale for floor-wide rather than per-printer: two people linking `BBD-`
parts at once is a data conflict worth preventing outright, and bed-clearing
is not a task the floor runs in parallel today. If that changes, relaxing
this to one-session-per-printer is a narrowing of the lock, which is a
smaller change than introducing one.

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

**The one station with no floor-wide lock** (§2.4). Several machines can run
cleanup at the same time — that is normal parallel work, and the sessions
never touch the same record because each part is scanned once, at one bench.

What is still forbidden is **two pistols on one machine**: they type into the
same focused field and their scans interleave into garbage. That falls out of
the universal one-session-per-device rule without needing a rule of its own —
a second cleanup session cannot be opened on a device that already has one.

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
- **Multiple SKUs per product** — the mapping is many-to-one. Vendors change
  barcodes between batches, sell regional variants, and label a box
  differently from the spools inside it. Each SKU carries its own kg-per-scan,
  so a box code and a spool code for the same product coexist naturally
- Unknown barcode at shelf → **captured as an unresolved scan**, not
  discarded (§6.3)

**Receive (+ Storage):** insert one `receive` row per scan, `grams = sku_kg`.

**Move → WIP close:** insert one `move_out` row per queued product (against
storage) and one `move_in` row (against WIP) per product, same amounts, in
the same transaction that closes the Move session.

We do **not** create a new Inventory spool row per SKU scan.

### 6.3 Unrecognized barcodes (mis-scan handling)

A product can carry several SKUs (§6.2), and new ones appear without warning
— a new batch, a different box code, a regional variant. At the storage
shelf this happens **blind** (§2.2), so the naive answer, rejecting the scan,
is the worst one available: the spool is physically on the shelf, the system
never hears about it, and the discrepancy surfaces weeks later at a stock
count with no way to reconstruct what happened.

**So an unrecognized barcode is captured, never discarded.** The scan is
recorded as an *unresolved scan* — payload, timestamp, and which session it
belonged to. It applies no kg yet, because the app genuinely does not know
what was scanned. But it is not lost, and it is not the operator's job to
remember it.

**Resolving one is a single action, and it does three things.** From the
tally (§5.2) or from `/floor/inventory`, the operator picks the product the
barcode belongs to. That:

1. **Registers the SKU permanently**, with its kg-per-scan — so the next
   spool from that batch just works, and the problem is self-extinguishing
2. **Applies the held kg**, inserting the ledger rows that were pending
3. **Resolves every other pending scan of the same payload at once** — ten
   spools of a new batch scanned in one run are one decision, not ten

This is why the rejected list in the receive tally is not a shaming list. It
**is the resolution queue** — the same records, seen from the session that
produced them.

**Timestamps.** The resulting ledger row is dated to the **original scan**,
because that is when the stock physically arrived. The resolution time is
recorded separately on the unresolved-scan record, so the audit trail shows
both "this arrived Tuesday" and "we worked out what it was on Friday"
without conflating them.

**Dismissal.** Not every unrecognized scan is stock — a shipping label or a
pallet barcode will get scanned eventually. Those are dismissed: marked
not-stock, no ledger row, kept for the record rather than deleted.

**Never guessed.** The app does not infer a product from an unfamiliar
barcode by similarity, prefix, or the rest of the session. A wrong guess
writes silent, plausible, wrong stock — strictly worse than an open question.

**In a Move session**, an unresolved scan appears as an unresolved line in
the on-screen queue (§5.3). Because Move commits nothing until the WIP scan,
the operator resolves it right there at the screen before completing, or
completes the recognized lines and leaves it pending. Either way nothing is
silently dropped.

### 6.4 Manual corrections and movement history

The pistol flows will get things wrong — wrong spool scanned, a scan
repeated, physical stock that never matched the system. Because the ledger
is **append-only**, correcting is always *writing*, never editing or
deleting:

| Operator action | Ledger effect |
| --- | --- |
| Edit a storage or WIP quantity | New `manual_adjust` row for the delta, with a reason |
| Move storage → WIP by hand | New `move_out` + `move_in` pair, one transaction, flagged as manual |
| Undo a specific past movement | New **reversal** row cancelling it, referencing the original |

Nothing is ever mutated or removed. That is what keeps "why does storage say
43 kg" answerable six weeks later, and it is the only way a blind-scan
mistake can be traced rather than papered over.

**Undo targets a movement, not a total.** The primary correction is "that
receive of 10 kg last Tuesday was wrong" — so a **movement history** view is
required, per bucket, showing each row with its direction, kg, time, source
(scan session vs manual) and originating SKU, with a reverse action on each.
Reversing twice is refused; the reversal is itself a visible row.

**Two surfaces, one set of components:**

- **Filament Tracking page** (existing) — gains the storage/WIP split and
  the same correction actions, so the page people already use for stock
  stays the whole picture rather than becoming half of one
- **`/floor/inventory`** (new) — floor-facing: stock by location, movement
  history, unresolved scans (§6.3), and corrections

Both render the same correction components against the same endpoints; the
difference is surrounding context, not behavior. Two implementations of
"adjust stock" would drift, and the divergence would be invisible until the
numbers disagreed.

**On future inventory categories.** `/floor/inventory` is named and
structured for inventory generally — motherboards, components and the like
are expected to join it as sibling categories. That extensibility is
deliberately **in the page shell and navigation only**. The ledger stays
`filament_stock_movements`, filament-specific, because filament is
continuous (kg), bound to `FilamentColorBucket`, and auto-debited by prints,
while discrete serial-tracked components share almost none of that. A
polymorphic stock table serving both would be mostly-null columns and a type
discriminator in every query. When components arrive they get their own
table behind the same page. Generalizing a UI shell is cheap and
reversible; generalizing a schema on speculation is neither.

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

**Leaves room for a lifecycle.** v1 records only that a part exists and was
labeled. The intended direction (§11.1) adds states — `produced`, `shipped`
— set when the part is scanned into WIP, each with its own timestamp. Not
built now; noted so the v1 table is not shaped in a way that forbids it.

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
| Unknown scan string | Error flash, no state change. **Plus error tone** — most rejections happen at the storage shelf where the flash cannot be seen (§2.2) |
| Defect / rework / multi without part in cleanup | Ignore |
| Part scan with no cleanup part in front | Ignore (or error) |
| Part already linked at harvest | Show link, do not relink to new job |
| SKU scan outside open station session | Error |
| Move open, scan WIP | Complete move |
| Move open, scan anything other than WIP | Discard queued kg (nothing was committed), show "Move cancelled — N kg not moved", switch to the new station |
| Harvest session open, scan cleanup station | Close harvest, open cleanup |
| Second device scans a station QR that is already open elsewhere (WIP, + Storage, Move, Harvest) | **Refused** — floor-wide lock (§2.4). Screen names the holding device and elapsed time, and offers **take over**, which closes the stale session and opens yours |
| Second device scans the **Cleanup** QR while cleanup runs elsewhere | **Allowed** — cleanup has no floor-wide lock. Parallel cleanup on separate machines is normal work (§5.5) |
| Same device scans a station QR while it already holds a different station | Switch — closes this device's current session, opens the new one, atomically. Refused only if the target station is locked by *another* device |
| Receive scan rejected while out of sight of the screen | Error tone, and the rejection is counted in the session tally the operator reads on returning (§5.2) |

Undo: control on station screen (v1). Undo QR on bench can wait.

---

## 10. Build order and test gates

Ship in thin vertical slices. **Pistol test** at every gate before the next phase.

| Phase | Build | Test gate (manual + pistol) |
| --- | --- | --- |
| **0** | Floor sidebar item (→ `/floor` landing page, Scan/Codes picker) + `/floor/scan` shell (always-focused input, status text). Codes button on the picker disabled/"coming soon" until Codes exists. | Type garbage → error. Page stable. Sidebar → `/floor` shows the picker; Scan navigates to the shell; Codes is visibly disabled, not a dead link. |
| **1** | **1a:** Minimal Codes — Station labels tab only (`BBS-…`, print/preview/size picker), reachable from the `/floor` picker's now-enabled Codes button. **1b:** Station entities + station open/close/switch handling in `/floor/scan` for WIP, + Storage, Move (§2.4); open-station screen with elapsed time; **error tone** on a rejected scan (§2.2). Router dispatches on **(open station × scanned prefix)** — required by harvest (`BBP-` then `BBD-`) and cleanup (`BBD-`, `BBF-`, `BBX-`), both of which already accept several prefix families. Sessions are **server-side** with the locks in §2.4, so this phase adds the `floor_station_sessions` table, its endpoints, and takeover. 1a is a hard prerequisite for 1b's own test gate—there is no other way to get a printable `BBS-` QR. | Print one QR (via 1a's Codes). Scan → correct station/mode. Scan again → closed. Other station → switch. Reload mid-session → station still open, elapsed time correct. Garbage scan → error flash **and** audible tone with the screen turned away. |
| **2** | `filament_stock_movements` ledger + derived `storage_grams`/`wip_grams` on `FilamentColorBucket`; migrate `on_hand_grams` readers (Filament Tracking cover/order-in/monthly-estimate math) to the derived sum; existing Add/Edit stock modal writes a `manual_adjust` row instead of `on_hand_grams` directly | Existing Filament Tracking page behaves identically for a user typing stock by hand—cover days, order-in, monthly estimate unchanged for a bucket with no Floor activity yet. `on_hand_grams` column removed or frozen; nothing else in the app still writes it directly. |
| **2b** | **`/floor/inventory`** — stock by location, per-bucket **movement history**, and manual corrections (adjust, manual move, reverse a movement) per §6.4; same correction components wired into the existing Filament Tracking page, which gains the storage/WIP split | Adjust storage by hand → ledger row, derived totals move. Manual move storage → WIP → paired rows, one transaction. Reverse a movement → compensating row, totals return to their prior value, both rows visible in history. Reversing the same row twice is refused. Both surfaces produce identical results. |
| **3** | SKU registration on filament tracking product — **many SKUs per product**, each with its own kg-per-scan (§6.2) | Register real box/spool barcode → product + kg. Register a *second* barcode against the same product → both scan correctly, at their own kg. |
| **4** | + Storage receive **+ persisted session tally** (§5.2) **+ unresolved-scan capture and resolution** (§6.3) | + Storage → SKU → storage kg up (via `receive` ledger row). Close session. **Walk the blind flow for real:** scan a known SKU and an unregistered one at the shelf without looking at the screen, return, and confirm the tally persists, names the unrecognized payload, and survives a reload until acknowledged. **Resolve it:** assign that payload to a product → SKU registered, held kg applied dated to the original scan, and a second spool of the same batch scans clean with no further prompting. **Dismiss** a junk barcode → no ledger row. |
| **5** | Move → WIP, **with the queued list shown on screen while the session is open** (§5.3), unresolved lines included | Move → SKUs → WIP QR → storage down, WIP up (`move_out`/`move_in` rows, one transaction). Abandoned move (switch to non-WIP station) discards the queue and shows the cancellation message. **Queue check:** scan spools at storage, walk back, confirm the screen lists exactly what was scanned *before* scanning WIP. **Unrecognized in a move:** queue an unregistered barcode, confirm it shows as an unresolved line, resolve it at the screen, then complete — the resolved kg move with the rest. |
| **6** | Point print debit at WIP | Finish print on assigned product → WIP kg down (`consume` row, existing tracking hooks). |
| **7** | Printer QRs in Codes + harvest printer bind | Print `BBP-…`. Scan → printer name + latest finished job. |
| **8** | Harvest part linking + elapsed-time indicator + **server-side floor-wide harvest lock** (§5.4) | Printer → `BBD-` parts → printer close. DB: parts → correct archive. Same-printer rescan closes only (never reopens against a stale plate—see §5.4). Leave a session open, reload the page—elapsed time shown next to the printer name and increases correctly. **Lock:** open harvest, then attempt to open it from a second browser tab—refused, naming the open printer and its elapsed time. |
| **9** | Cleanup defects | Part → defect / rework / multi / other. Trash vs rework. Harvest codes ignored. |

**Suggested branch strategy:** one feature branch (`feat/floor-stations`) with
sequential commits per phase, or sub-branches merged in order. Codes ships
in slices tied to whichever phase first needs that tab to be printable —
Station labels with phase 1 (§10 row above), Printer labels with phase 7
(harvest needs a printable `BBP-…`). Error labels and general Codes polish
(size picker refinement, error-type editor) aren't a hard dependency of any
single phase and can trail once cleanup (phase 9) needs `BBF-…`/`BBX-…`
printed for its own pistol test.

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
- **Session-management screen / admin view of open sessions.** Takeover in
  v1 is a refusal line plus a confirm and nothing more (§2.4). A screen
  listing who holds what only earns its keep once there are several devices
  to look across
- **Part lifecycle and bill-of-materials consumption** — see §11.1 below

### 11.1 Direction of travel: parts consume a bill of materials

Not v1, and not to be built now, but recorded because it is the intended
shape of the system and one detail of it constrains what we build today.

The eventual model: scanning a finished part into the **production line**
marks it **produced** (later, **shipped**), and that transition **deducts
that product's bill of materials from inventory** — so many grams of
filament, one motherboard, two brackets, whatever the recipe says. Stock
stops being something anyone maintains by hand and becomes a consequence of
production.

**This gets its own station, separate from filament WIP.** The `BBS-wip`
station in §5.1 tracks filament kg and stays factory-SKU-only. Booking
finished parts in is a different job at a different place, so it gets its
own QR rather than overloading WIP with a second meaning. That keeps the
two independent: neither has to change for the other to arrive.

**What it implies later, for reference:**

- A **recipe** per product: which inventory items and how much per unit
- Part records gain a **lifecycle** (`produced`, `shipped`) with timestamps,
  which §7.2 leaves room for
- Component categories get their own movement ledgers, consumed by the same
  transaction that marks a part produced — a BOM engine writing to several
  ledgers at once, one transaction per part

**Bearing on the schema decision in §6.4:** this genuinely weakens one of
the arguments made there. That section reasoned that filament's auto-debit
from the print engine "has no analog for discrete components" — under a BOM
model components *would* be auto-consumed too. The conclusion still stands
(separate per-category ledgers work fine for a BOM engine writing
transactionally across them, and a polymorphic table still forfeits the
`bucket_id` foreign key), but it stands on the integrity argument alone, not
on that one. Worth knowing if the question is ever reopened.

---

## 12. Open naming / polish (safe to defer)

- Sidebar label: Floor vs Operations vs Production
- Whether harvest requires scanning Harvest station QR before first printer QR
- Whether reversal needs a reason code or free text is enough
- Whether unresolved scans should expire if never resolved, or accumulate
  indefinitely

Settled since first draft: the exact `BBS-` payload strings (pinned in code
and tests by phase 1a); where session state lives (§2.4); the harvest
concurrency rule (§5.4); that the receive tally persists until acknowledged
(§5.2); that storage/WIP appear on **both** the Filament Tracking page and
`/floor/inventory`, sharing one set of components (§6.4); that unrecognized
barcodes are captured and resolved rather than rejected (§6.3); that the
ledger stays filament-specific while the inventory page generalizes (§6.4).

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
| 1a | Minimal Codes — Station labels tab (`/floor/codes`, station catalog, label PDF) | In progress (PR open) | `feat/floor-stations-p1a-codes-stations`, [PR #90](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/90) |
| 1b | Station entities + open/close/switch on `/floor/scan` (WIP, + Storage, Move), **server-side sessions with floor-wide locks + takeover** (§2.4), elapsed time, error tone | Not started | — |
| 2 | `filament_stock_movements` ledger + derived storage/WIP + `on_hand_grams` migration | Not started | — |
| 2b | `/floor/inventory` — movement history + manual corrections (adjust, manual move, reverse); same components on Filament Tracking | Not started | — |
| 3 | SKU registration (office), many SKUs per product | Not started | — |
| 4 | + Storage receive + persisted tally + unresolved-scan capture/resolution | Not started | — |
| 5 | Move → WIP | Not started | — |
| 6 | Point print debit at WIP | Not started | — |
| 7 | Printer QRs in Codes + harvest bind | Not started | — |
| 8 | Harvest part linking + elapsed-time indicator + floor-wide harvest lock | Not started | — |
| 9 | Cleanup defects | Not started | — |
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
| 1 | Integration: station open / close / switch **API**, including the floor-wide lock (second device refused, cleanup exempt) and takeover. Unit: scan classification by (station × prefix). Component: the scan page opens, closes and switches stations, shows the refusal with elapsed time, and rings the error tone on a rejected scan. Component: Codes Station-labels tab renders a printable `BBS-…` QR (preview + size picker) | Print 1 QR from Codes. Scan → correct mode. Scan again → closed. Reload → still open. Open the same station in a second browser profile → refused, naming the holder; take over → first screen falls back to idle. |
| 2 | Unit: ledger math, derived-sum correctness. Regression: existing Filament Tracking cover/order-in numbers unchanged for a bucket with no Floor activity | None (pure backend) |
| 2b | Unit: reversal math (a reversed movement nets to zero; double-reversal refused). Integration: adjust / manual move / reverse each write the right rows and leave derived totals correct. Component: both surfaces render the same correction components | Adjust stock by hand, move by hand, reverse a movement — totals land where expected on both pages |
| 3 | Integration: SKU registration → product + kg mapping; two SKUs on one product each resolve at their own kg | Register 1 real barcode, then a second one for the same product |
| 4 | Integration: receive → storage kg up. Unresolved scan captured, survives reload, resolves to a product (SKU registered + held kg applied at the original scan time), bulk-resolves same-payload siblings, dismissal writes no ledger row. Tally persists until acknowledged | + Storage → known SKU and an unregistered one, blind → return, read tally, resolve, rescan the batch clean |
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

**2026-08-24:** Phase 1b was started and then **stopped before any code
landed**, to settle hardware assumptions the plan had left implicit. The
doc had quietly assumed one PC per physical place (old §2.1), and everything
downstream inherited it. Reality for v1 is **one PC with one screen plus one
wireless pistol**, with the screen in the printer / cleanup / WIP zone and
the storage shelf out of its line of sight. Rewrote §2 around that. What
came out of it:

1. **Blind scanning is a real case, not an edge case** (new §2.2). Mapped
   every flow by whether the screen is visible and whether the scan commits.
   Only one flow is both blind *and* committing: + Storage receive. Move is
   blind but commits nothing until the operator is back at the screen, so it
   is safe by construction — *provided* the screen lists the queued kg
   before the WIP scan, which is now a hard requirement in §5.3 rather than
   an unstated assumption.
2. **Mitigations for the one exposed flow** are deliberately cheap (error
   tone, end-of-session tally) and explicitly a bridge: the intended fix is
   a second screen at the storage shelf, which retires the problem instead
   of compensating for it. Recorded so nobody over-invests in blind-scanning
   ergonomics.
3. **Session state ownership is now explicit** (new §2.4), and was revised
   twice in one session. First pass: per-tab for WIP/+Storage/Move, with
   harvest the lone server-side exception. That was then **superseded** —
   *every* station except cleanup takes a floor-wide lock, so all session
   state moves to the server. Cleanup is the exception and needs no special
   rule: with no floor-wide lock, the universal one-session-per-device rule
   already gives "two people can't share a machine, two machines are fine".
   Consequences: phase 1b gains a backend (table, endpoints, takeover);
   abandoned sessions now deadlock the floor unless recoverable, so refusals
   are actionable rather than automatic (§11 still forbids timeout-closing);
   and the doc's original "station open/close/switch API" gate was right all
   along — item 5 below retracted it on reasoning that no longer holds.
4. **Android scanner guns deferred** but their constraint recorded (§2.3):
   compatible only in keyboard-wedge mode with an Enter suffix; intent mode
   needs a native wrapper a web page cannot provide.
5. ~~Corrected §15.5's phase-1 gate, which called for a "station
   open/close/switch API" — there is no server session in 1b.~~
   **Retracted** later the same session (see item 3): floor-wide locks put
   the session on the server after all, so the original gate stood and has
   been restored.

Cost of stopping: one deleted scratch file, no commits. Cheaper than
discovering in phase 5 that the Move queue was never displayed.

Same session, second half — stock correction and mis-scan handling, which
the plan had barely covered:

6. **The receive tally persists until acknowledged** (§5.2), so it is a
   stored record rather than screen state. A tally that died with the tab
   would defeat its own purpose: nobody saw the rejection when it happened.
   Warns but never blocks — mid-shipment friction just trains operators to
   dismiss it blind.
7. **Unrecognized barcodes are captured, not rejected** (new §6.3). Products
   legitimately carry several SKUs and new ones appear without warning, and
   at the storage shelf this happens blind. Rejecting meant the spool sat on
   the shelf while the system never heard about it. Now the scan is held,
   and resolving it once registers the SKU, applies the held kg dated to the
   original scan, and clears every sibling scan of the same payload. The
   tally's rejected list *is* the resolution queue — same records, different
   viewpoint. Never guessed by similarity: silent plausible wrong stock is
   worse than an open question.
8. **Manual corrections get their own phase, 2b, deliberately placed before
   receive** (§6.4, §10). Phase 4 commits real stock from scans nobody can
   see the result of; shipping that before any way to fix a mistake would
   leave the first bad scan with no remedy. Append-only throughout — edit,
   manual move and undo all *write* rows, and undo targets a specific
   movement rather than a total, which is what forces the per-bucket
   movement-history view.
9. **`/floor/inventory` added** (§3.1), sharing correction components with
   the existing Filament Tracking page rather than reimplementing them —
   two implementations of "adjust stock" would drift invisibly until the
   numbers disagreed.
10. **Declined to generalize the ledger schema** for future inventory
    categories, having first suggested it was cheap to do early. It is not:
    a polymorphic table loses the `bucket_id` foreign key and its cascade
    delete, trading a working integrity constraint for an unspecified
    feature, and filament's auto-debit path from the print engine has no
    analog for discrete components anyway. Adding a second table later is
    purely additive. The rule applied: generalize what is expensive to
    change (routes, navigation, mental model — hence the generic
    `/floor/inventory` name and shell), keep specific what is cheap to add
    alongside (a table).
11. **Recorded the BOM direction** (§11.1): eventually a finished part
    scanned in is marked produced/shipped and deducts its bill of materials.
    Not being built. Booking parts in gets its **own station**, separate
    from filament WIP — an intermediate draft had it overloading the `BBS-wip`
    station and claimed that forced a router constraint; that was wrong, and
    the two stay independent. The router does still dispatch on **(open
    station × prefix)**, but because harvest and cleanup already accept
    several prefix families each in v1, not because of anything BOM-related.
    Separately, BOM does weaken one argument in item 10 — components *would*
    be auto-consumed under it — though that conclusion holds on the
    foreign-key argument alone.

**2026-08-23:** Phase 1a built on `feat/floor-stations-p1a-codes-stations`
(stacked on the phase 0 branch): `/floor/codes` with the Station labels tab,
a backend station catalog, and a station-label PDF endpoint. Decisions taken
along the way: (1) the station catalog lives in the **backend**
(`services/floor_codes.py`) rather than as a frontend constant, because phase
1b's scan router has to resolve a scanned payload back to a station and the
`BBS-` strings must have exactly one home — they're printed onto QRs that get
taped to physical shelves, so they're effectively immutable once deployed;
(2) labels render as a **server-side PDF** rather than CSS print, reusing
`label_renderer`'s QR helper (which carries the #1870 thermal-printer
module-size tuning) instead of duplicating it — the two genuinely shared
helpers were promoted from private to public there; (3) `/floor/labels` was
added to the gzip exclusion list, matching the existing spool-label PDF
entries, so `Content-Length` stays exact. The label layout was verified by
actually rendering PDFs and looking at them (40/60/80 mm square and 80×40
wide) rather than trusting the geometry math. Printer and Error tabs show as
disabled rather than hidden, same honesty as phase 0's Codes button.

**2026-08-23:** Considered folding the whole Codes page into Phase 0 while
it was fresh in mind. Decided against it—Codes (§3.3: three tabs, size
picker, error-type editor, print preview) is real feature scope, not shell
work, and merging it into Phase 0 would blur the thin-vertical-slice
discipline the plan otherwise follows. Instead, split Phase 1 into 1a
(minimal Codes—Station labels tab only, just enough to print one `BBS-…`
QR) and 1b (station entities), since 1b's own test gate literally cannot
run without a printed station QR. `qrcode.react` is already a dependency
(used in `ApiKeyQRCodeModal.tsx`), so QR rendering itself isn't new work.
Printer and Error/Command label tabs stay tied to the phases that actually
need them printable (7 and 9 respectively)—not built ahead of need. §10
Phase 1 row, its notes, §15.1, and §15.5 updated to make this explicit
instead of the old vague "Codes UI polish can trail phase 1."

**2026-08-23:** Added `/floor` as a real landing page (Scan/Codes picker),
pushed to the same PR #89. Gap found by inspecting the running app: nothing
linked to `/floor/codes` at all, even though §2.1's Office row ("Floor →
Codes") implied a click-through path existed. Resolved the resulting tension
with the kiosk-bookmark note (`/floor/scan` *or* `/floor` were documented as
interchangeable): floor-bench PCs now bookmark `/floor/scan` explicitly, and
the sidebar item points at the new `/floor` picker instead. Codes stays
visibly disabled ("Coming soon") rather than linking to a route that doesn't
exist yet. §2.1 and §3.1 updated to match.

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
