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

**Fit Check and Rework are not in this table.** They are locations, not
stations (§5.4a/§5.4b) — no session, so no lock question even arises. Two
devices can each have their own part pending a location at once with no
conflict; that is a local prompt on each screen, not a claim on shared
state.

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
| Station QRs (`BBS-…`) | App → Codes → browser print | Shelf, bench, harvest area, fit-check bench, rework bench |
| Printer QRs (`BBP-…`) | App → Codes | Each 3D printer |
| Error QRs (`BBF-…`) | App → Codes | Cleanup bench |
| Command QRs (`BBX-…`) | App → Codes | Cleanup bench (multi, rework) |
| Rework reason QRs (`BBR-…`) | App → Codes | Rework bench |
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

Harvest, fit check, rework and cleanup are **not** separate bookmark URLs
for operators. The **station QR** selects harvest vs fit check vs rework vs
cleanup vs WIP vs storage. The scan page is one harness.

`/floor/inventory` is deliberately named for **inventory**, not filament.
Other categories (motherboards, components) are expected later and will join
this page as siblings. What that does *not* mean is a generalized schema
today — see §6.3 for where the line is drawn.

### 3.2 What stays unchanged

Printers, Queue, Files, Profiles, Inventory, Filaments, Settings—no QR
controls added to those pages.

### 3.3 Codes page (office)

Four tabs: Station labels, Locations, Printer labels, Error labels.

**Station labels** — WIP, + Storage, Move, Harvest, Cleanup (each `BBS-…`).
Fit Check and Rework are **not** in this tab — see Locations below.

**Locations** — Fit Check and Rework (each `BBS-…`, same catalog and print
pipeline as Station labels, split out by a `category` field on the station
entry, §5.4a/§5.4b). Printed and scanned identically to a station QR; the
only difference is what scanning one *does* — no session opens.

**Printer labels** — one row per 3D printer already in the app (`BBP-{printer_id}`).
Print → preview (QR + name + payload) → size → browser print dialog.

**Error labels** — seeded horizontal / vertical / other; add new types (display
name + `BBF-` slug with autofill, editable); built-in commands multi + rework
(print only, no “add command” in v1).

**Rework reason labels (`BBR-…`) are printed from the Error labels tab.**
They use the same user-managed error-label registry as Discard, so operators
can add, remove, and print the reasons that apply to Rework and Discard.
The `BBR-…` labels are retained for compatibility with the original fixed
reason flow, but new installations use the editable Error labels catalog.
Codes page has no section for them), left for a follow-up rather than
building a fourth catalog + tab in the same pass that fixed the station/
location interaction bug.

Print size: 40 / 60 / 80 mm or custom W×H. Last size remembered. Not a label
printer driver in v1—browser print to office paper, cut and tape.

Part stickers (`BBD-…`) and factory filament SKUs are **never** printed here.

---

## 4. Scan routing (prefixes)

The USB pistol types a string and Enter. Backend (or frontend router) classifies:

| Prefix | Example | Role |
| --- | --- | --- |
| `BBS-` | `BBS-wip`, `BBS-storage-receive`, `BBS-storage-move`, `BBS-harvest`, `BBS-cleanup` | Station: open/close session, set mode. `BBS-fit-check`/`BBS-rework` are printed the same way but are **locations**, not sessions — see below |
| `BBP-` | `BBP-12` | Printer identity (harvest only) |
| `BBD-` | `BBD-000042` | Unique physical part (harvest link, cleanup lookup; also the first scan of the Fit Check / Rework location flow, §5.4a/§5.4b) |
| `BBF-` | `BBF-horizontal`, `BBF-warping` | Defect type (cleanup) |
| `BBX-` | `BBX-multi`, `BBX-rework` | Cleanup commands (v1: only these two) |
| `BBR-` | `BBR-doesnt_fit`, `BBR-other` | Rework reason (why the part needs rework) — the part after `BBR-` is the reason code verbatim, not a slug translated elsewhere |
| Factory barcode | digits/alphanumeric from vendor | Filament SKU → kg delta for a tracking product |

**`BBS-fit-check` and `BBS-rework` are not stations.** They print and
resolve as `BBS-…` payloads (same Codes-page mechanism, §3.3), but scanning
one never opens/closes/switches a session — dispatch for them is not on
(open station × prefix) the way every other station is. See §5.4a/§5.4b for
the actual flow: scan a part, then scan the location.

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

**Two ways in, and both work.** Harvest mode is an *ergonomic* choice, not a
functional gate:

1. **Scan the Harvest station QR**, then the printer's QR. Gives the lean
   bed-clearing screen: big text, part count, nothing else competing for
   attention during repetitive work.
2. **Scan the printer's QR straight from idle.** Gives the printer info page
   (§5.6) — and part scans from there bind exactly the same way.

This is deliberate. The operator is standing at the machine with a full bed;
the printer QR is *on the printer*, while the Harvest label is taped
somewhere else. Requiring the station scan first asks for an unnatural step
before the obvious one, which is precisely how it gets skipped — and a
skipped harvest mode used to mean part scans silently going nowhere. Now
forgetting it costs a leaner screen, not data.

**Parts bind to the job, not just the printer.** The printer QR is how the
app *finds* the work: it resolves to that printer's latest finished job, and
the part links to that `print_archives` row. The archive carries the model,
filament, settings and timing, so a part traced back weeks later says which
run produced it. Bound only to a printer, the answer would degrade to
"printer 12 made this, at some point".

**The floor-wide harvest lock (§2.4) is claimed when harvesting actually
begins** — on opening the Harvest station, or on the **first part scan** from
the info page. Merely *looking* at a printer takes no lock, or routine info
lookups would block real bed-clearing.

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

### 5.4a Fit Check

**Fit Check is a location, not a station.** This was wrong in an earlier
pass of this doc, which described it as an open/close session like Harvest
or Cleanup — corrected after review. There is **no session, no floor-wide
lock, no open/close** for Fit Check at all. Its `BBS-fit-check` QR is
printed and resolved exactly like a station payload (Codes page, §3.3), but
scanning it never claims anything server-side.

**Purpose:** A mandatory QC checkpoint after harvest. Every part must pass
through Fit Check before it is eligible for Cleanup — a part cannot go
printer → Cleanup directly. This is a hard gate, not a convention: Cleanup
**refuses** the scan of any part with no Fit Check record (§5.5, §9).

**Flow — scan a part, then scan a location:**

1. Scan part `BBD-…` with nothing else going on (idle, no station open, no
   printer being viewed) → the screen shows the sticker code and prompts
   for a location. Nothing is written yet; this is a client-side "pending
   part" prompt, not a server call.
2. Scan `BBS-fit-check` → **commits**: records a `fit_checked` event against
   that part and returns to idle. One scan-pair, no confirmation step — the
   common case is "checked, fine," and it must be the shortest path, same
   reasoning as Cleanup's good-part path (§5.5).
3. **Re-scanning** an already fit-checked part (part, then `BBS-fit-check`
   again) is not an error: it appends another `fit_checked` event (the
   history is append-only, same as every other part event) rather than
   refusing or amending. There is no pass/fail outcome recorded here to
   amend — see below.

**Scanning `BBS-fit-check` with no part pending** is refused — "scan a part
first" — rather than silently doing nothing or reading as an unknown code.

**No pass/fail outcome in v1.** Fit Check records only that the checkpoint
happened, not a verdict. A part that does not fit is handled physically by
sending it to Rework (§5.4b) — that is a bench decision, not a system
transition, since Rework is independent of Fit Check's result (see 5.4b).
Recording a verdict here would duplicate the "why" question that Rework
already asks, for the one path (doesn't fit → send it to Rework) that matters; other
reasons a part visits Rework never touch Fit Check at all.

**Screen:** Idle "Scan a code" as usual. After a part scan: the sticker code
and "Scan a location." After the location scan commits: part model / printer
(same fields Cleanup shows on lookup), then back to idle.

**Abandoning the pending part.** Scanning anything other than a location
code while a part is pending (a station QR, a printer, another part) simply
proceeds as that scan normally would — there is no special "cancel" action,
because there is no session to clean up. The pending part is just dropped.

**No floor-wide lock, because there is nothing to lock.** Two devices can
each have their own part pending at once with no conflict — they are
independent local prompts, not competing claims on shared state.

### 5.4b Rework

**Also a location, not a station** — same correction as §5.4a, and the same
consequence: no session, no lock, `BBS-rework` is a printable payload with
no open/close behavior.

**Purpose:** An optional bench for parts that need surface work before
Cleanup, for **any** reason — not only a failed Fit Check. Independent of
Fit Check: a part can visit Rework whether or not it has been fit-checked
yet, and in either order. Rework is **not** a gate — most parts never visit
it, and Cleanup does not require a Rework record the way it requires a Fit
Check one (§5.4a).

**Flow — scan a part, scan the location, scan why:**

1. Scan part `BBD-…` with nothing else going on → pending-part prompt, same
   as Fit Check's step 1.
2. Scan `BBS-rework` → **not** a commit. This is a pure state transition on
   the scan page: the screen now shows "Rework — scan a reason." Nothing is
   written to the server by this scan on its own.
3. Scan a reason code `BBR-…` → **commits**: saves a `rework` event on the
   part with the reason code, and returns to idle. This is the only point in
   Rework's flow that writes anything.
4. `BBR-other` → **keyboard** types a note instead of (or alongside) the
   seeded reason, same as Cleanup's `BBF-other`.

**Rework reasons come from the editable Error labels catalog.** Operators can
add or remove the labels used by Rework and Discard, print the selected labels,
and optionally add a short note after scanning `other`.

**Abandoning a pending part or a pending reason** works the same way as Fit
Check (§5.4a): scanning anything else just proceeds as that scan normally
would, dropping whatever was pending. Scanning a different part while
awaiting a reason restarts the flow on the new part.

**Scanning `BBS-rework` or a `BBR-…` code with nothing pending** is refused
— "scan a part first" / "scan a part into Rework first."

**After the reason is recorded, the part proceeds directly to Cleanup** — no
forced return to Fit Check. Rework is trusted to have fixed whatever the
reason named.

**No floor-wide lock**, same reasoning as Fit Check — there is no session to
lock.

### 5.5 Cleanup

**Purpose:** Record the outcome of every part at support removal —
**including the good ones**.

**Gated on Fit Check (§5.4a).** A part `BBD-…` scanned at Cleanup with no
`fit_checked` event anywhere in its history is **refused**: error flash and
tone, screen says which station is missing ("needs Fit Check first"),
nothing is recorded. This is the one hard sequencing rule in the whole
harvest → … → cleanup chain — everything else (Rework included) is ordering
by convention, not by enforcement.

**Every part is scanned.** An earlier draft said good parts were not, to
keep bench work down. That is reversed (§11.2): if only defects are scanned,
a part with no cleanup record is indistinguishable from one nobody has
inspected yet, and a daily yield figure built on that denominator cannot be
trusted — an unfinished inspection backlog reads as a great yield day.
Scanning the good ones roughly doubles the work at this bench and buys a
capacity number that means something.

**Open:** Scan Cleanup station QR.

**Flow:**

1. Scan part `BBD-…` → show **which printer** (and ideally part model).
2. **Good part:** no further scan — the part is recorded good and the
   station returns to waiting. This is the common case, so it must be the
   shortest path: one scan, no confirmation step.
3. Optional: scan `BBX-rework` (if not trash).
4. Defect path:
   - **One defect:** scan `BBF-horizontal` / vertical / other → save → confirmation → **waiting for part**
   - **Several defects:** `BBX-multi` → scan each `BBF-…` → `BBX-multi` again → save
   - **Other:** `BBF-other` → **keyboard** types note → save
5. Default disposition for a *defective* part: **trash**. Rework only if
   `BBX-rework` was scanned before the defect.

**Support removal *and* final inspection.** Cleanup is the single bench where
every part's outcome is decided, which is what lets a part with no cleanup
record mean *uninspected* without ambiguity.

**A disposition can always be changed, by re-scanning the part.** The real
sequence is inspect → scan → then handle the part, and handling breaks
things: a part passed as good can snap during support removal or later
post-processing. So re-scanning a part that already has a disposition means
**amend** — the screen shows what is on record ("recorded good, 4 min ago")
and lets the operator change it. No separate mode, and no time limit: the
break is often noticed after moving on to the next parts.

**Amendments append, they do not overwrite** — the same rule as the stock
ledger (§6.4). A part's history reads `good @ 14:32` → `defective/broken @
14:38`, and the current disposition is simply the latest.

The ordering is not bookkeeping, it is **data**:

| Sequence | What happened |
| --- | --- |
| Straight to defective | Came off the bed bad — a **print** failure |
| Good, then defective | Survived printing, broke in post-processing — a **process** failure |

That split matters for §11.2: only print failures should count against a
printer's `(printer × plate variant)` reliability. Post-processing losses
belong to the bench. Overwriting destructively would erase the distinction
and make printers look worse than they are, sending anyone investigating
after the wrong fix.

**Job link immutable, disposition mutable.** A part's link to its print job
is fixed once set (§9: do not relink at harvest). Its disposition is not.
Two different properties, easy to conflate later.

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

### 5.6 Printer scan (info page)

Not a station — a printer QR (`BBP-{id}`) scanned with **no station open**.
It answers "what is this machine doing, and does it need anything from me",
for an operator already standing in front of it.

Everything below comes from data the app already holds; nothing new is
tracked to build it:

| Shown | Source |
| --- | --- |
| Name, model, location | `printers` |
| State — printing / idle / **awaiting plate clear** | `printers.awaiting_plate_clear` and live status |
| **Last finished print** — job name, when, and whether its parts are labeled yet | latest `print_archives` row |
| **Total print hours** | `runtime_seconds` + `print_hours_offset` |
| **Maintenance due or overdue** | `printer_maintenance` intervals vs `last_performed_hours` |
| **Log maintenance performed** | writes `maintenance_history` |

The last-print row doubles as the harvest prompt: a printer *awaiting plate
clear* with an unlabeled finished job is exactly a bed waiting to be
cleared, and saying so is more useful than a separate reminder somewhere
else.

**Part scans from this page bind normally** (§5.4) — the info page is a
different screen, not a different mode. That is what stops a forgotten
Harvest scan from silently discarding work.

**Takes no lock.** Looking at a printer must not block whoever wants to
harvest it; the harvest lock is claimed on the first part scan.

**When there is nothing to harvest** — no finished job, or its parts are
already labeled — the page says so plainly. But it is **not a dead end**: a
part scanned anyway is still recorded against the printer and the time, with
no job attached (§7.2), because by then the sticker is already on the part.
The screen says which printer it went to and that no job was found, so the
operator knows it landed somewhere findable rather than nowhere.

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

**They never expire.** An unresolved scan stays pending until a person
decides about it. Auto-expiring would keep the list tidy by silently
discarding exactly the discrepancy the capture exists to surface — the
tidiness would *be* the bug. The list stays short by making each entry easy
to decide, not by deleting entries nobody got to.

**Each scan records its position in its session**, so the operator can work
out which physical item it was: "the 3rd scan after opening + Storage", with
its timestamp. Returning to a bare unknown barcode hours later is close to
useless; the position is what lets someone walk to the shelf and find the
spool it came from.

**Two ways out, and both are decisions:**

- **Resolve** — assign it to a product, giving the SKU its kg-per-scan.
  Registers the SKU and applies the held kg, as above.
- **Dismiss** — "not stock, do not track". Not every unrecognized scan is
  inventory; a shipping label or pallet barcode gets scanned eventually. No
  ledger row.

**Dismissal is logged** — who dismissed it and when — and the record is kept
rather than deleted. It is a judgement that some barcode is not inventory,
and if stock later fails to reconcile, the dismissals are part of the
answer. A dismissal that vanished would take its own evidence with it.

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

**Every correction records a reason: a structured code, plus optional free
text.** The code comes from a fixed list — miscount, wrong SKU, damaged,
returned, other — so corrections can be counted and compared. That is the
point: if half of them are "wrong SKU" the labels or the SKU registry need
work, and if half are "miscount" the problem is process or training. Free
text alone cannot answer that, because nobody phrases the same reason the
same way twice.

Free text stays available alongside, for the cases the list does not fit —
and is *required* when the code is "other", so that option cannot become a
silent dumping ground that hides a category worth adding.

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
- `archive_id` → finished print (`print_archives`), **nullable** — see below
- `printer_id` — stored in its own right, **not** only reachable via archive
- `labeled_at`
- **Cleanup records (plural, append-only):** outcome (`good` / `defective`),
  defect type where applicable (`BBF-` slug or other text), disposition
  (trash / rework), timestamp, and who recorded it
- **Fit Check and Rework events (plural, append-only, same table):**
  `fit_checked` (§5.4a, no payload) and `rework` (§5.4b, `BBR-` reason code
  or free text) — the same per-part event log that already carries
  `enrolled`/`scanned`/`archived`/`relinked`/etc., not a new table. This is
  what the Part history viewer (§15.8) reads to show the whole sequence for
  one sticker, fit check and rework included, without any schema change.

Does **not** duplicate filament, temps, file path—join archive when needed.

**Disposition is a history, not a field.** A part passed as good can snap
during support removal, so re-scanning it appends a new cleanup record
rather than editing the old one (§5.5). The current outcome is the latest
record; the sequence is what distinguishes a **print** failure (straight to
defective) from a **process** failure (good, then defective) — a split
§11.2's reliability model depends on. A single mutable `disposition` column
would silently destroy it.

**A part is always recorded, even when no job can be found.** If the printer
has no finished job to bind to — never printed, archive already labeled,
auto-archive off, or the archive was deleted — the part is still written,
with `printer_id` and `labeled_at` set and `archive_id` left null.

This is why `printer_id` is stored directly rather than being derived
through the archive: it has to survive the case where there *is* no archive.

The reasoning matches §6.3's unrecognized barcodes. The sticker is already
physically on the part by the time it is scanned. Refusing the scan does not
undo that — it just produces a labeled part the system has never heard of,
which is strictly worse than a partial record. And the partial record is
usually recoverable by hand: printer plus timestamp is normally enough to
identify the run ("what did printer 12 finish around 14:32").

**The operator is told at scan time** — "linked to printer 12, no job found"
— never silently. And parts with a null `archive_id` surface as a
needs-attention list, the same shape as unresolved scans, so they can be
matched to a job later rather than discovered at a stock count.

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
| Part already scanned at harvest | Error flash and tone; do not relink or change the current plate |
| Part re-scanned at cleanup after a disposition was recorded | **Amend** — show the current disposition and its age, let the operator change it. Appends rather than overwrites, so `good → defective` stays visible as a post-processing loss (§5.5) |
| Part scanned but the printer has no finished job to bind to | **Record it anyway** — `printer_id` + `labeled_at`, `archive_id` null (§7.2). Screen says "linked to printer N, no job found". Surfaces in a needs-attention list to be matched later. The sticker is already on the part; refusing would create a labeled part the system never heard of |
| Part scanned at **Cleanup** with no `fit_checked` event on record | **Refused** — error flash and tone, screen says "needs Fit Check first", nothing recorded (§5.4a). The one hard sequencing gate in the chain |
| Part scanned (idle, nothing else going on), then re-scanned into `BBS-fit-check` a second time later | **Logged again**, not an error — appends another `fit_checked` event. There is no verdict to amend (§5.4a) |
| `BBS-fit-check` or `BBS-rework` scanned with no part currently pending | **Refused** — "scan a part first". Neither is a session, so there is nothing to open instead (§5.4a/§5.4b) |
| Part pending a location, then something other than a location is scanned (a station QR, a printer, another part) | **Abandoned, silently** — that scan proceeds exactly as it normally would; the pending part is just dropped, no special "cancelled" message (unlike Move's queue, §5.3, which is server-side and does announce its own abandonment) |
| Part sent to **Rework** (location scanned), then something other than a reason code is scanned | Same as above — the pending "awaiting reason" state is abandoned, nothing was written (Rework's location scan never itself calls the backend, §5.4b) |
| Reason code (`BBR-…`) scanned with no part pending a Rework reason | **Refused** — "scan a part into Rework first" |
| Part scanned into Fit Check or Rework that was never enrolled at Harvest | Error — no such sticker exists yet; enroll it at Harvest first |
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

### Build order (revised)

**Phase numbers are stable identifiers, not positions.** They appear in
branch names, commit messages, PR titles and the §15.8 log, so renumbering
would invalidate that history. The *order they are built in* changed after
phase 1:

> **0 → 1a → 1b → 7 → 8 → 9a → 9b → 9c → 2 → 2b → 3 → 4 → 5 → 6**

**Phase 9 was split into 9a/9b/9c** when Fit Check and Rework were added
(§5.4a, §5.4b) — 9 itself never started, so splitting it costs no history,
unlike renumbering a phase already in flight. 9a (Fit Check) ships before 9c
(Cleanup) because 9c's own gate depends on it — Cleanup cannot refuse an
unchecked part in a world where Fit Check does not exist yet to have checked
it. 9b (Rework) sits between them: it does not gate anything, but it shares
9a's scan-part-then-location plumbing on the scan page, and Cleanup's own
test gate wants to exercise "reworked, then straight to Cleanup" as one of its
scenarios.

**9a/9b were implemented once as station sessions, then corrected.** The
first pass wired Fit Check and Rework through the same open/close/floor-wide-
lock machinery as WIP/Harvest/Cleanup — wrong: neither is a station, and the
real flow is scan-a-part-then-scan-a-location with no session at all. See
§5.4a/§5.4b for the corrected design and §15.8's dated entry for what
changed and why.

Parts and printers come first; filament and stock come last.

**Why this is safe.** Harvest (§5.4) and cleanup (§5.5) do not touch
filament at all — harvest's only mention of it is *"Ignores: filament
SKUs"*. Their real dependencies are the Codes page (1a), station sessions
(1b) and `print_archives`, all of which exist. Nothing in 7/8/9 reads or
writes the stock ledger, so moving the whole filament block after them
changes no behaviour.

**Why it is worth doing.** The filament block (2 → 6) is the only work that
*modifies code that already works and already holds real data* — the
`on_hand_grams` migration touches live Filament Tracking maths. Everything
in 7/8/9 is additive. Doing the additive, independently-valuable work first
means the printer/part loop is running on the floor before any risk is taken
with existing stock numbers.

**Already built ahead of schedule:** phase 8's floor-wide harvest lock
shipped in 1b.1, and its elapsed-time indicator in 1b.2 (generalised to
every station, not just harvest). Phase 8 is correspondingly smaller than
its row below suggests.

The table stays in original numeric order — look a phase up by its number.

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
| **7** | Printer labels tab in Codes (`BBP-{id}`) + the **printer info page** (§5.6): identity, state, last finished print, total print hours, maintenance due, log-maintenance action | Print `BBP-…` from Codes, scan it from idle → info page names the right printer, its latest finished job, and its hours. A printer with maintenance overdue says so; logging it from the page clears it. A printer with no finished job says there is nothing to harvest rather than going blank. Scanning it takes **no** harvest lock. |
| **8** | Harvest part linking, via **both** entries (§5.4): Harvest station → printer, and printer-from-idle → parts. Lock and elapsed-time already shipped in 1b | Printer → `BBD-` parts → printer close. DB: parts → correct **archive**, not just printer. Same-printer rescan closes only (never reopens against a stale plate—see §5.4). **Both entries:** label parts via the Harvest station, and again via a bare printer scan — identical rows result. **No-job case:** scan a part against a printer with no finished job → part still recorded with `printer_id` + `labeled_at`, `archive_id` null, screen says "no job found", and it appears in the needs-attention list (§7.2). **Lock:** taken on first part scan from the info page, not on merely viewing it. |
| **9a** | Fit Check location (§5.4a) — **no session**: scan-part-then-location on the scan page (`awaiting-location` status), `POST /floor/locations/fit-check/part` commits a `fit_checked` event, re-scan appends rather than errors. `BBS-fit-check` refused by the station-scan route (`category == "location"`). | Scan a harvested part at idle → "scan a location" prompt. Scan `BBS-fit-check` → recorded, screen shows part/printer, back to idle. Re-scan same part → logged again, no error. Part never harvested → error. `BBS-fit-check` with nothing pending → "scan a part first". |
| **9b** | Rework location (§5.4b) — same no-session shape as 9a, but three scans: part → `BBS-rework` (pure UI transition, `awaiting-rework-reason` status, no server call) → `BBR-…` reason (or `BBR-other` + keyboard), which is what actually calls `POST /floor/locations/rework/part`. Reasons come from the editable Error labels catalog. | Scan a harvested part → "scan a location". Scan `BBS-rework` → "scan a reason", nothing posted yet. Scan a reason → saved, back to idle. Scan a different part before the reason → first pending part dropped, second one pending. `BBR-other` → keyboard note saved. |
| **9c** | Cleanup outcomes — **every part scanned, good ones included** (§5.5, §11.2), **gated on Fit Check** (§5.4a) | Part scan alone → recorded **good**, one scan, no confirmation step. Part → defect / rework / multi / other → recorded defective with disposition. Trash vs rework. Harvest codes ignored. **Yield check:** label a job's parts, mark some good and some defective, and confirm `good / produced` comes out right for that job — and that a part never scanned at cleanup reads as *uninspected*, not as good. **Amendment:** scan a part good, then re-scan it and mark it defective — the current disposition changes, the earlier one survives, and the pair is distinguishable from a straight-to-defective part (§5.5). **Gate check:** scan a part straight from Harvest, no Fit Check — refused, with the "needs Fit Check first" message. Fit-check it, then Cleanup accepts it. **Rework path:** fit-check a part, send it to Rework with a reason, confirm Cleanup accepts it straight through with no second Fit Check required. |

**Suggested branch strategy:** one feature branch (`feat/floor-stations`) with
sequential commits per phase, or sub-branches merged in order. Codes ships
in slices tied to whichever phase first needs that tab to be printable —
Station labels with phase 1 (§10 row above; the Fit Check and Rework
stations join the same tab whenever 9a/9b need them printable), Printer
labels with phase 7 (harvest needs a printable `BBP-…`). Rework reason
labels (`BBR-…`) are a hard dependency of 9b's own pistol test, the same way
Error labels are a hard dependency of 9c's. General Codes polish (size
picker refinement, error-type editor) isn't a hard dependency of any single
phase and can trail.

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

### 11.2 Direction of travel: true yield, and replenishment that uses it

Also not v1. Recorded because it is where the harvest and cleanup records
are ultimately going, and because two decisions it depends on are cheapest
to make *before* phase 9c builds cleanup.

**The problem.** There is currently no reliable measure of true daily
capacity — how many *good* parts the floor actually produces, as opposed to
how many it starts.

**The data mostly falls out of phases 8 and 9 already.** Harvest records
parts produced against a specific job; cleanup records their disposition.
Yield is then `good / produced`, sliceable by job, printer and day. No extra
capture is needed — but see the good-parts decision below, which is what
makes the denominator trustworthy.

**Failure mode matters more than yield alone.** Whether dense plates are a
good idea depends on how failures cluster:

| Failure mode | Effect on a 3-up plate |
| --- | --- |
| **Independent** (one part warps) | Lose 1 of 3 — batching is nearly free |
| **Correlated** (adhesion, layer shift, runout) | Lose all 3 — batching triples the exposure to one event |

The part records already distinguish these, because parts bind to a specific
job: all-of-a-job defective reads as plate-level, one-of-three as
part-level. The split comes free from the same records.

Density plausibly costs yield for physical reasons — a 1-up prints in the
bed's sweet spot while a 3-up must use the edges, and travel moves between
objects cause stringing a single object never sees. So **yield can beat
throughput**: four 1-part plates may deliver more good parts than two 2-part
plates, even though it burns more machine time.

**Replenishment, when it comes, is not 1:1.** Plates print N-up, so
"consume a part, queue a replacement" cannot work directly. It needs the
same shape as filament reorder — a **reorder point and a batch size per
part**. Consume down to the threshold, then queue plates.

Choosing the split, with plate variants of 1 / 2 / 3 parts:

1. **Minimise plate count.** That is the real cost — each plate is one
   fixed overhead (bed heat, purge, first layer), one bed clear, one
   harvest. Greedy largest-first is optimal for the 1/2/3 set, and having a
   1-part variant means an exact count is always reachable with no
   overproduction.
2. **Among splits with that count, prefer the balanced one.** Total machine
   time is identical either way — 3+1 and 2+2 both cost `2F + 4p` — but 2+2
   *finishes sooner*, because 3+1 leaves one printer idle waiting on the
   longer plate. Only matters when several printers are free.
3. **Then weight by reliability**, per (printer × plate variant), which is
   what can overturn steps 1 and 2 entirely when a dense plate's yield is
   poor enough.

**The trap in step 3:** per-(printer × variant) yield is a lot of cells —
five printers and three variants is fifteen — and each needs a real sample
before it means anything. On a sample of two, one unlucky plate reads as
"printer C is bad at 3-ups". It needs a fallback ladder: use the cell once
it has enough jobs, else printer-level yield, else a flat default. Without
that, the system spends its first months making confident wrong choices,
which is worse than making none — because people believe it.

**Decisions needed before phase 9c builds cleanup:**

- **Good parts are scanned too.** *Settled* — this reverses §5.5's original
  "good parts are not scanned". Every part gets a disposition, so a part
  with no cleanup record unambiguously means *not yet inspected* rather than
  being indistinguishable from good. That distinction is what makes a daily
  capacity figure trustworthy; the cost is roughly double the scanning at
  the cleanup bench.
- **Cleanup is support removal *and* final inspection.** *Settled.* Every
  part passes through it regardless of whether it needed supports, which is
  what lets "no cleanup record" mean *uninspected* without ambiguity.
- **Dispositions are amendable, and amendments append** (§5.5). This yields
  a third measure beyond raw yield: `good → defective` is a
  **post-processing** loss, while straight-to-defective is a **print**
  failure. Only the latter counts against a printer's reliability — a bench
  that snaps 8% of parts during support removal would otherwise make every
  printer look bad and send the investigation somewhere useless.

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
- Whether the printer info page should also surface AMS/filament state once
  the filament phases land, or stay printer-only
- Whether a `good → defective` amendment should capture *which* stage broke
  the part (support removal vs later post-processing), or whether the
  sequence alone is enough (§5.5)
- Whether the reversal reason list (miscount / wrong SKU / damaged /
  returned / other) needs more codes once real corrections accumulate
- **Phase 2's backfill destination.** Migrating `on_hand_grams` puts every
  bucket's existing stock into **storage** (§6.2's assumption: office-typed
  stock is warehouse stock until moved), so on day one Filament Tracking
  shows everything as storage and nothing in WIP until Moves get scanned.
  Almost certainly right, but confirm before running it — it is visible to
  everyone the moment it lands

Settled since first draft: the exact `BBS-` payload strings (pinned in code
and tests by phase 1a); where session state lives (§2.4); the harvest
concurrency rule (§5.4); that the receive tally persists until acknowledged
(§5.2); that storage/WIP appear on **both** the Filament Tracking page and
`/floor/inventory`, sharing one set of components (§6.4); that harvest has
**two equally valid entries** — the Harvest station for a lean bed-clearing
screen, or a printer scan from idle for the info page — with parts binding
to the job either way, so a forgotten station scan costs ergonomics rather
than data (§5.4, §5.6); that cleanup is support removal **and** final
inspection, scans every part including the good ones, and lets a disposition
be amended by re-scanning — appending rather than overwriting, so a part
that broke in post-processing stays distinguishable from one that printed
badly (§5.5, §11.2); that unrecognized barcodes are captured and resolved
rather than rejected, never expire, and carry their position in the session
so the physical item can be found (§6.3); that corrections record a
structured reason plus optional free text (§6.4); that a dedicated
**`floor:scan`** permission guards the whole feature, backfilled on upgrade
to any group holding `printers:control` so existing installs keep working;
and that the ledger stays filament-specific while the inventory page
generalizes (§6.4).

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

**Fit check (required before Cleanup):** part → Fit Check → done. (Not a
station — no "open Fit Check" step; scan the part first, then the location.)

**Rework (only if needed, any time before Cleanup):** part → Rework → reason QR → saved.

**Bad part at cleanup:** Cleanup → part → (rework?) → defect QR → saved → wait. Refused if the part hasn't been through Fit Check yet.

**Office:** register new factory barcode on product; print new station/printer/error/rework-reason QR when needed.

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
Listed in **build order** (§10), not numeric order — phase numbers are
stable identifiers, so the sequence reads top to bottom while the numbers
stay put.

| # | Phase | Status | Branch/PR |
| --- | --- | --- | --- |
| 0 | Floor sidebar + `/floor` landing picker + `/floor/scan` shell | **Done** (merged) | `feat/floor-stations-p0-scan-shell`, [PR #89](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/89) |
| 1a | Minimal Codes — Station labels tab (`/floor/codes`, station catalog, label PDF) | **Done** (merged) | `feat/floor-stations-p1a-codes-stations`, [PR #90](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/90) |
| 1b | Station entities + open/close/switch on `/floor/scan`, **server-side sessions with floor-wide locks + takeover** (§2.4), elapsed time, error tone, dedicated `floor:scan` permission | **Done** (merged): 1b.1 ([PR #93](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/93)), 1b.2 ([PR #94](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/94)), `floor:scan` permission + upgrade backfill ([PR #95](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/95)). Pistol gate **passed** on several gun models | `feat/floor-stations-p1b-station-sessions`, `feat/floor-stations-p1b2-scan-ui`, `feat/floor-scan-permission` |
| **7** | Printer labels tab in Codes + printer info page (§5.6) + open-sessions view on `/floor` | **Done** (merged) | `feat/floor-p7-printer-codes`, [PR #96](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/96) |
| **8** | Harvest part linking (lock and elapsed-time already shipped in 1b) | **In progress** — uncommitted on `feat/floor-p8-harvest-parts`: labeled-part harvest, `/floor/inventory` Part history (match unmatched records, archive, event timeline), unlabeled-build-plate backlog on `/floor`. Local only, not pushed | `feat/floor-p8-harvest-parts` |
| **9a** | Fit Check location, no session — mandatory gate before Cleanup (§5.4a) | **In progress** — backend (`scan_fit_check_part`, `POST /floor/locations/fit-check/part`, `category`-based refusal in `/floor/session/scan`) and frontend (scan-part-then-location flow, Codes page Locations tab) built and tested locally; uncommitted | `feat/floor-p8-harvest-parts` |
| **9b** | Rework location, no session — optional, independent of Fit Check (§5.4b) | **In progress** — same state as 9a: `scan_rework_part`, `POST /floor/locations/rework/part`, editable Error labels, three-scan flow on the scan page; printable labels are available from Codes | `feat/floor-p8-harvest-parts` |
| **9c** | Cleanup outcomes (every part scanned, good included), gated on Fit Check | Not started | — |
| 2 | `filament_stock_movements` ledger + derived storage/WIP + `on_hand_grams` migration | Not started — deferred behind 7/8/9a/9b/9c | — |
| 2b | `/floor/inventory` — movement history + manual corrections (adjust, manual move, reverse); same components on Filament Tracking | Not started | — |
| 3 | SKU registration (office), many SKUs per product | Not started | — |
| 4 | + Storage receive + persisted tally + unresolved-scan capture/resolution | Not started | — |
| 5 | Move → WIP | Not started | — |
| 6 | Point print debit at WIP | Not started | — |
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
- All 7 station QR payloads (WIP, + Storage receive, Move, Harvest, Fit
  Check, Rework, Cleanup) pre-rendered as one PDF, printed once, reused
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
| 9a | Integration: `scan_fit_check_part` writes `fit_checked` regardless of any open session elsewhere; `/floor/session/scan` refuses `BBS-fit-check` (404, `category == "location"`); re-scan appends rather than errors; never-enrolled sticker rejected. Component (frontend): idle part scan → `awaiting-location`; location commits and flashes; no-part-pending location scan refused; abandoning a pending part on an unrelated scan | Scan a harvested part at idle → "scan a location". Scan `BBS-fit-check` → recorded, screen confirms, back to idle. Re-scan → logged again, no error. `BBS-fit-check` scanned bare → "scan a part first". |
| 9b | Integration: `scan_rework_part` writes one `rework` event with the reason, atomically — no partial write from the location-only step, since that step never calls the backend. Component: part → `BBS-rework` → `awaiting-rework-reason` (no request sent yet) → reason → commits; abandoning a pending part or a pending reason by scanning something else | Scan a harvested part → "scan a location". Scan `BBS-rework` → "scan a reason", confirm nothing was posted yet. Scan a reason → saved, back to idle. Scan a different part before the reason → first pending part dropped. `BBR-other` → keyboard note saved. |
| 9c | Integration: cleanup outcome write, defect save, disposition amendment, **and the Fit Check gate** (refused without it, accepted with it, accepted after Rework with no second Fit Check) | Full 9a→9c loop: fit-check a part, then Cleanup accepts it. Separately, skip Fit Check and confirm Cleanup refuses. Sand a part (with a reason), confirm Cleanup accepts it straight through. |

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

**2026-08-25 (in progress):** Corrected a real design mistake in phases
9a/9b, caught after Fit Check was already built and Rework was underway:
both had been implemented as **stations** — open/close session, floor-wide
lock config, the whole 1b session machinery — mirroring Harvest and Cleanup.
That is wrong. Neither is a station. The actual flow, per direct correction:
scan a part, then scan a location, and (for Rework) then a reason — three
scans building up local, client-side state on the scan page, never a server
session. Reworked before Rework compounded the same mistake rather than
after.

What changed, concretely:

1. **No session for Fit Check or Rework at all.** `POST /floor/session/scan`
   now refuses to open one for either (`category == "location"` on the
   `FloorStation` entry, checked in the route — §5.4a). Both still live in
   the same station catalog and print through the same `BBS-…` pipeline as
   real stations (Codes page, §3.3) — only the *scanning* behavior differs,
   not the catalog or the label.
2. **`scan_fit_check_part`/`scan_rework_part` simplified to plain commits.**
   No `device_id`, no session lookup — just the sticker code (and for
   Rework, the reason). `FitCheckScanResult`/`FitCheckScanOutcome` collapsed
   into a shared `LocationScanResult`/`LocationScanOutcome` used by both,
   since they're now the same shape of operation. Routes moved to
   `POST /floor/locations/fit-check/part` and
   `POST /floor/locations/rework/part`.
3. **Rework's location scan is a pure state transition, not a request.**
   Nothing is written when `BBS-rework` is scanned — only when the reason
   is. This is the one place the three-scan flow is asymmetric: Fit Check
   commits on its second scan (the location), Rework only on its third.
4. **Rework reasons use the editable Error labels registry** rather than a
   fixed enum. The same labels are available for Discard, can be added or
   removed by users, and are printable from the Codes page. The legacy
   `BBR-…` reason route remains available for compatibility with existing
   labels.
5. **The scan page's pending state lives entirely in `Status`**, the same
   union already driving every other screen — `awaiting-location` and
   `awaiting-rework-reason` join it. This is what makes "abandon the
   pending part by scanning something else" free: any other scan just
   replaces `status` with whatever it normally means, no special cleanup
   code needed, unlike Move's server-side queue (§5.3) which needed its own
   cancellation message.
6. Doc corrected throughout: §2.4's lock table no longer lists Fit Check/
   Rework (there is no lock question — no session), §4 notes `BBS-fit-check`/
   `BBS-rework` are not station dispatch, §5.4a/§5.4b rewritten around the
   scan-part-then-location flow, §9's mis-scan rows updated, §10/§15.1/§15.5
   updated to describe the corrected shape rather than the retracted one.
7. **What was already right and didn't change:** the Fit Check gate on
   Cleanup (§5.5, §9) — that's about whether a `fit_checked` *event* exists
   for a part, which is independent of how the scan that created it was
   triggered. Rework's independence from Fit Check's outcome, and its lack
   of a loop-back, also stand unchanged (§5.4b) — the earlier session-based
   version got what happens right and only how it's triggered wrong.

Verified: backend `pytest -k floor` (262 passed), frontend floor-scoped
vitest suites (175 passed), tsc/eslint/ruff clean on every touched file. Not
yet re-verified end-to-end in a live browser against a running backend after
this rework (the earlier live check, described below, predates it).

**2026-08-25 (in progress):** Added office-side corrections to Part history
(`/floor/inventory`) for the two "got it wrong at harvest" cases the
matching flow didn't cover: **unlink** a mismatched job link, and
**replace** a damaged or lost sticker. This directly revises the "Leftover
unlink endpoint removed: a linked job is evidence, not editable state" call
in the entry below—unlink is back, but reworked to keep that instinct
rather than abandon it: it is a deliberate, reason-gated action
(`wrong_job` / `wrong_printer` / `other`, free text required for `other`)
that appends an `unlinked` audit event and drops the part back to the
ordinary needs-matching state, rather than a silent overwrite.
`relink_part` itself still refuses unconditionally to touch a part that
already has an `archive_id`—verified unchanged:
`test_matching_only_resolves_an_unlinked_part` still passes byte-for-byte.

Matching itself widened at the same time: `relink_part` no longer
restricts a pick to the printer recorded at harvest—the printer field
itself can be the mistake (a mis-scanned `BBP-` code, or the wrong
machine's plate cleared by hand)—and a new `GET
/floor/inventory/jobs/search` endpoint lets a reviewer search every
completed job, any printer, as the escalation from the existing
same-printer candidate list. Picking a cross-printer job auto-corrects
`printer_id` for free (`relink_part` already set it from the archive).

Sticker replacement is a separate, unrelated action added alongside:
`POST /floor/inventory/parts/{id}/replace-sticker` overwrites
`sticker_code` on the same row (same id, same job link, same event
history) for when the physical `BBD-` label is damaged or falls off, also
reason-gated (`damaged` / `fell_off` / `other`). `sticker_code` stays
globally unique forever per §7.1—the new code is validated the same way a
fresh harvest scan is, and checked against every part, active or archived.

Both actions are office-only (Part history page), not a floor/pistol flow,
and both are blocked on archived parts. No schema change—both write to the
existing append-only `floor_part_events` table, new `unlinked` /
`sticker_replaced` action types with a JSON `details` payload, the same
pattern `archived`/`restored` already use. Frontend: "Unlink job" and
"Replace sticker" actions on a part's detail panel, each behind an inline
reason form; the existing "Match to completed job" panel gained a "Search
all jobs" mode alongside its same-printer dropdown, feeding the same
relink call either way.

Verified: full backend suite 8593 passed, full frontend suite 2853 passed
across 204 files, i18n parity clean. Two pre-existing issues surfaced
during verification and were left alone as out of scope for this
change—both predate this work and sit in files it never touched: a ruff
import-sort failure in `database.py`, and a TypeScript build error in
`FloorScanPage.tsx` (`partFeedbackMessage` missing a return path).

**2026-08-25:** Plan revision, before phase 9 (not started) was built: added
**Fit Check** and **Rework** as two new stations between Harvest and
Cleanup (new §5.4a, §5.4b), and split phase 9 into 9a/9b/9c (§10, §15.1,
§15.5) — splitting cost no history since phase 9 had no commits yet. Key
decisions, each settled in conversation rather than assumed:

1. **Fit Check is a hard gate, Rework is not.** A part scanned at Cleanup
   with no `fit_checked` event is refused outright (§5.5, §9) — the one hard
   sequencing rule added. Rework has no equivalent gate on either side: it
   does not require Fit Check to have happened, and Cleanup does not require
   Rework.
2. **Rework is independent of Fit Check's outcome**, not its fail path.
   Fit Check records no pass/fail verdict at all in v1 — only that the
   checkpoint happened — because the one case a verdict would matter for
   (doesn't fit → send it to Rework) is a bench decision the operator makes physically,
   and Rework's own reason scan already captures "why" for that and every
   other reason a part might need rework.
3. **No loop back to Fit Check after Rework.** Once a reason is recorded at
   Rework, the part goes straight to Cleanup. Rework is trusted to have
   fixed what it named.
4. **Rework's "why" is a scanned reason code**, `BBR-…`, following Cleanup's
   existing `BBF-`/defect-type pattern exactly (seeded set, editable in
   Codes, `BBR-other` opens the keyboard) rather than free text or an
   on-screen picker — one less UI pattern to build, and it stays true to the
   floor's one-scan-at-a-time ergonomics (§1.1: gloved hands, a pistol, no
   dropdowns).
5. **No schema change.** Both stations write to the existing
   `floor_part_events` append-only table (§7.2) — `fit_checked` and
   `rework` join `enrolled`/`scanned`/`archived`/etc. as just more action
   types with a JSON `details` payload. The Part history viewer being built
   in phase 8 (`/floor/inventory`, still uncommitted — see the entry below)
   reads this same table, so Fit Check and Rework events appear in a part's
   timeline for free once 9a/9b land; nothing about the viewer itself needs
   to change.
6. Fit Check and Rework get **no floor-wide lock** (§2.4), matching
   Cleanup's own reasoning: they are bench/inspection work, and parallel
   benches on separate machines are normal, not a data conflict the way two
   people racing to bind the same harvest plate would be.

**2026-08-25 (in progress):** Phase 8 harvest linking plus the office **Part
history** page (`/floor/inventory`) is in the `feat/floor-p8-harvest-parts`
worktree, still uncommitted. Harvest writes `floor_labeled_parts` from both
entry points (§5.4); unmatched records are matched from Part history against
same-printer completed jobs (the harvest job link stays immutable). `/floor`
shows unlabeled *build plates* (jobs with no parts yet), not the old
sticker-level needs-attention list — that matching work lives on Part
history. Leftover unlink endpoint removed: a linked job is evidence, not
editable state. `printer_id` still deviates from the phase 8 contract's
`NOT NULL` as in the earlier 08-25 entry.

**2026-08-25:** Phase 8 (harvest part linking) started on
`feat/floor-p8-harvest-parts`, stacked on `feat/floor-p7-printer-codes`
(local only, not pushed). Adds `floor_labeled_parts`
(`backend/app/models/floor_part.py`) and its service
(`backend/app/services/floor_parts.py`), covering both harvest entry points
from §5.4 (Harvest station → printer → part; printer scan from idle →
part), sticker-code validation, and the needs-attention queue for parts
recorded with no job. `printer_id` deliberately deviates from the phase 8
contract's `NOT NULL`: printers are hard-deletable and that route already
orphans other child rows rather than relying on FK cascade (SQLite runs
with `PRAGMA foreign_keys` off by default), so a nullable, `SET NULL`
`printer_id` lets a deleted printer orphan its parts the same way archives
already are, instead of forcing a cascade-delete of part history the
contract explicitly wants to survive — see the model's docstring. Backend
routes (`floor.py`, `printers.py`) and both service/API test files are
written but **uncommitted, not yet run** — status here reflects code in the
worktree, not a verified or landed state.

**2026-08-25:** Phase 7 built and merged as
[PR #96](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/96)
(`feat/floor-p7-printer-codes` → `feat/floor-stations`): `GET
/floor/printers` + printer-label PDF endpoint, the Printer-labels tab in
`/floor/codes` (generalized from the station-labels picker), and the
printer info page reached by scanning a `BBP-` code with no station open —
live MQTT status, last finished print ordered by `completed_at`, total
print hours and maintenance counts read through the existing maintenance
routes, and a harvest-prompt suppression when live status contradicts a
stale `awaiting_plate_clear` flag (caught via a screenshot showing
"Printing 42%" next to "Bed ready to clear" during manual testing). Also
added the open-sessions view on `/floor` (oldest first, per-row Close, a
24h history flagging takeovers) as a side effect of closing already being a
write rather than a delete, and fixed `open_seconds` to stop growing after
`closed_at` on closed sessions in that history. Two suppression attempts for
Android's on-screen keyboard on the scan page (`inputMode="none"`, a
non-editable keydown-capturing div) both broke real hardware-scanner input
during device testing and were reverted, left as a code comment so neither
gets silently retried. Verified: backend 8598 passed, frontend 2812 passed,
tsc/eslint clean, full station/printer loop driven in-browser against a
live backend on an isolated DB.

**2026-08-24:** Phase 1b.2 (scan-page half of station sessions) and the
`floor:scan` permission built together and merged as
[PR #94](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/94) and
[PR #95](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/95)
(`feat/floor-stations-p1b2-scan-ui`, `feat/floor-scan-permission` →
`feat/floor-stations`). Scanning a `BBS-` label now opens/closes/switches
stations on `/floor/scan`, with a locked-station refusal offering takeover,
"unknown code" vs "not handled yet" as distinct outcomes (recognized
prefix, no handler yet, versus genuinely unrecognized), an error tone on
rejection only (WebAudio, resuming a context suspended by autoplay policy),
device identity as a `localStorage` UUID (not per-tab, so one machine can't
hold two sessions in two tabs), and elapsed time counted from the server's
figure rather than `opened_at` so a drifted kiosk clock can't distort it.
Separately, all six floor endpoints were moved off inherited permissions
(`printers:read` on labels, `inventory:update` — far broader than the job —
on sessions) onto a dedicated `floor:scan`, with Administrators synced via
`ALL_PERMISSIONS` and non-admin groups backfilled from `printers:control` on
startup so the upgrade doesn't silently lock out existing operators;
verified against a real database stripped back to a pre-upgrade state.
API keys are explicitly denied `floor:scan` — a script holding a
floor-wide lock would block real operators, and takeover is built for a
human decision. The Floor nav item, previously ungated, now requires the
permission too. §10's build order was reordered to `0 → 1a → 1b → 7 → 8 →
9 → 2 → 2b → 3 → 4 → 5 → 6` in this pass (see that section for the
reasoning) and §5.4/§5.6/§6.3/§6.4's decisions were recorded. Verified:
backend 8541 passed, frontend 2766 passed across 203 files, ruff/tsc/eslint
clean.

**2026-08-24:** Phase 1b.1 (backend station sessions) built and merged as
[PR #93](https://github.com/Nicolas-Cilia/Backoffice-Printing/pull/93)
(`feat/floor-stations-p1b-station-sessions` → `feat/floor-stations`): the
`floor_station_sessions` table and open/close/switch/takeover service,
enforced by partial unique indexes rather than application checks alone —
one open session per device, one open session per exclusive station
floor-wide (WIP, + Storage, Move, Harvest; cleanup is exempt via its own
exclusivity column rather than a hardcoded exception). A locked-station
scan returns 200 (refusal screen, takeover offered) while an unrecognized
code returns 404 (unknown-code flash) — deliberately not collapsed, since
they send an operator to different places. Takeover ships despite v1 being
single-PC because the realistic deadlock is single-device: a cleared
`localStorage` orphans the old session with no fix otherwise but a
hand-edited database. The race branch is tested: two devices racing the
lock check leaves the loser's *previous* session intact, since a refusal
must cost nothing. Also landed here: the §2 rewrite from 08-24's earlier
entry below. Verified: 36 new tests (21 unit + 15 integration), full
backend suite 8526 passed (+36 from baseline), ruff clean.

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
