# Floor workflow decision

This is the agreed operating model for Floor inventory and part handling. It
supersedes the older Cleanup-station workflow described in `floor-plan.md`.

## Locations and stations

- **Receiving**: batch-receive filament and stocked components into Storage.
- **Move Inventory**: stage a batch at its source location, then send it to a
  selected destination.
- **Filament WIP**: the printer-area filament stock, tracked by weight.
- **Production WIP**: passed printed parts and production components waiting
  for the production line.
- **Fit Check**, **Rework**, and **Discard**: the printed-part quality flow.

## Workflows

### Receive filament

`Receiving → scan filament spool/SKU → scan more → close Receiving`

Adds filament into Storage. Receiving is an open batch session, so the
operator scans the station once, receives multiple items, then closes it.

### Restock printer-area filament

`Move Inventory → scan filament spools/SKUs → Filament WIP → Finish transfer`

Subtracts the selected filament from Storage and adds its weight to Filament
WIP.

### Move components to assembly

`Move Inventory → scan component packages/SKUs → Production WIP → Finish transfer`

Subtracts the selected component quantities from Storage and adds them to
Production WIP.

### Finish a printed part

`Part sticker → Production WIP`

Records **Final QC passed** and moves the individually tracked part into the
production-part bin.

## Movement rules

The Move Inventory flow is the same for filament and components. The item
catalog decides how each item is tracked:

- Filament is weight-based.
- Components are quantity-based, normally using a package quantity defined by
  their SKU.
- Individually tagged items can be supported later.

Scanning a WIP destination only selects that destination; it does not commit
or close the transfer. The operator may keep adding items to the pending batch
without reopening Move Inventory. A `Finish transfer` QR at the destination
commits the batch and closes the Move session.

Destination validation prevents an incorrect transfer:

- Filament WIP accepts filament only.
- Production WIP accepts production components and final-QC-passed printed
  parts.

## Part Assembly Linking

Assembly linking binds a bought **product serial** to the two printed housings
that make up a finished product — one **TOP** and one **BOT**. It happens in
three waves; the notes below cover Waves 1 and 2.

### Product serial format

A product serial is exactly **six alphanumeric characters, no hyphen, with at
least one letter** (`^[A-Z0-9]{6}$` after trim + uppercase, plus `/[A-Z]/`) —
e.g. `XG2SNP`, `8TBDT9`. All-numeric barcodes stay ordinary SKUs, and
hyphenated floor codes (`BBD-…`, `BBN-…`) never match, so a serial can never
collide with a sticker or bin code.

### Kit assignment (Wave 1)

When a **TOP** reaches Production WIP for the first time it consumes one **KNB**
and one **BUT** unit from the single In-WIP fill of each type on the line (no
partial consume — the whole WIP commit is refused if either type is missing).
That kit (the knob and button bin fills) is what a linked unit reports back.

### Link ceremony (Wave 2)

At the kiosk, from idle:

1. Scan an **unlinked** product serial → the screen prompts *"Scan a top or a
   bottom"*.
2. Scan the first housing (a TOP or a BOT) → *"Scan the other housing"*.
3. Scan the second housing → the unit is written and both housings ship.

Rules:

- Eligibility: the **TOP** must be In WIP with a kit assigned; the **BOT** must
  be In WIP; neither may already be on another unit.
- Scanning **two tops** or **two bottoms** is a hard error — the serial stays
  pending, nothing is written.
- **Cancel** (or scanning a different serial) aborts the ceremony with no write.
- Scanning a TOP then a BOT **without a serial first** never pairs them.
- Scanning an **already-linked** serial is a read-only lookup: it shows the
  serial, top, bottom, and knob/button kit, with an **Unlink** control. No
  ceremony, no write. Scanning either **housing sticker** at idle does the
  same lookup via `GET /floor/units/by-part/{sticker}` (404 → normal
  item→location pending flow).

### Shipped on link

A successful link writes `unit_linked` then **`shipped`** on both housings
(the existing `shipped` status Inventory Fulfilled uses). Once shipped, further
item→location scans on those stickers are refused (lookup only) until the unit
is unlinked.

### Unlink

Unlinking a unit frees the serial and both stickers: it writes `unit_unlinked`
then restores both housings to **`wip`**, so the same serial and pair can be
linked again (the TOP keeps its kit, so no re-consume).

### APIs

- `POST /floor/units/link { serial, top_sticker, bottom_sticker }`
- `GET /floor/units/by-serial/{code}` — already-linked lookup (404 when free)
- `GET /floor/units/by-part/{sticker}` — the unit a housing belongs to
- `POST /floor/units/{id}/unlink`
- `GET /floor/inventory/units` — list (the Wave 3 Serials tab reads this)

### Serials tab & replace (Wave 3)

Inventory gains a third **Serials** tab (`/inventory?tab=serials`) beside Parts
and Bins. It lists every linked unit — serial, both `BBD-` stickers, the knob
and button bins, and when it linked — with a search over serial or either
sticker. Opening a row shows the assembly card, from which the office can:

- **Unlink** (confirm) — `POST /floor/units/{id}/unlink`, freeing the serial and
  returning both housings to WIP.
- **Replace top / replace bottom** — pick the new housing's sticker on screen
  (not a pistol scan) and confirm.
- **Replace knob / replace button** — pick any past or current eligible harvest
  fill (`FloorBinBatch` with remaining > 0, In WIP or Ready-for-Production) of
  that type. Restores +1 on the previous fill and consumes −1 on the new one
  (same inventory rules as floor kit reassign). The assembly card's knob/button
  links open that exact batch's Part history record, not the live Bins tab.

A TOP/BOT row on the Parts tab shows a chip with the product serial it belongs
to, linking through to that unit's assembly card.

**Replace** — `POST /floor/units/{id}/replace { top_sticker?, bottom_sticker? }`:

- The serial is kept; only the named slot(s) change.
- A new **TOP** must be In WIP with a kit assigned; a new **BOT** must be In
  WIP; neither may already be on another unit (same eligibility as a fresh
  link). Any refusal writes nothing.
- The new housing is re-shipped (`unit_linked` → `shipped`); the old housing is
  freed back to WIP (`unit_unlinked` → `wip`) so it can be reused. The unit
  stays linked throughout — replacing a shipped unit's housing leaves the unit
  linked, with the new housing shipped and the old one back In WIP.
- `404` when the unit id is unknown; every other refusal is a `200` carrying the
  reason (`top_not_eligible`, `bottom_already_linked`, `no_change`, …).

**Replace kit** — `POST /floor/units/{id}/replace-kit { slot, batch_id }`:

- `slot` is `KNB` or `BUT`; `batch_id` is any eligible harvest of that type.
- Moves the TOP part's kit FK; restores the previous fill and consumes the new
  one. `404` when the unit is unknown; other refusals are `200` (`no_kit`,
  `no_target`, `invalid_slot`).