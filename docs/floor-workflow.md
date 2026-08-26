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
