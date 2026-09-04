# Stats 2 — capacity vs feedback

Stats 2 answers **device-level** print capacity and floor readiness questions. It lives at `/stats2` and `/api/v1/stats2/*`.

## Capacity (headline KPI)

**Question:** If demand were unlimited, how many **complete devices** could we print per staffed day on the **shared** printer fleet?

**Headline answer:** `devices_per_day_realistic` / `devices_per_day_theoretical` are **schedulable** — they come from the same weekly print packer as the Gantt (integer plate starts, shared lanes, printer time blocks). The default what-if target is this schedulable realistic number.

**What-if over ask:** when the target exceeds what the packer can start, the print-plan response lists every **short part** (`short_parts[]`: packed vs needed) and a **minimum extra printers** estimate for models that printed that part (else eligible models). Extras scale ``printers × target / capacity_ceiling`` under the **current operator schedule** — the measured schedulable devices/day from overview, not unconstrained dedicated-fleet rates (those inflate the denominator and can report 0 extras for mild over-asks). Do **not** scale by ``needed/packed`` from the over-ask pack (that understates part throughput vs the eligible fleet and inflates counts). Per-part extras are independent lower bounds — shared models (e.g. X1C on TOP+BOT) must not be summed blindly. `binding_print_part` remains the worst short part for packer priority.

When the UI runs an explicit what-if, the API **re-packs once** with those extras as hypothetical lanes (`hypothetical_fleet`, negative `printer_id`s, dashed rows on the Gantt). The lane list scrolls vertically so large boosts do not stretch the page. Capacity measurement never uses the boosted pack.

**Per-part breakdown** (`components[]`) still uses a dedicated-fleet estimate (each recipe part assumes the full eligible printer count for its model). That can overstate complete-device throughput when models are shared (A1/A1M → TOP+KNB; X1C/H2* → all four). Those unconstrained totals are also returned as:

- `devices_per_day_realistic_unconstrained`
- `devices_per_day_theoretical_unconstrained`

**Inputs (operator-controlled):**

- Weekly staffed hours (`OperatorSchedule`, or Mon–Fri 08:00–17:00 stub when empty)
- `expected_plate_clear_minutes` — assumed bed cleanup between plates **while staffed**
- Optional printer time blocks (respected by the packer / schedulable KPI)
- Device recipe (BOM): Part Models (TOP/BOT/KNB/BUT) × `qty_per_device`
- Production slots per part (print time, qty/plate, printer model)
- Active printer fleet eligible for that slot’s model + part
- Optional historical yields: print job success, harvest yield, QC yield (default **1.0** when data is sparse) — used for slot ranking and dedicated-fleet diagnostics

**Not used for capacity:**

- Historical plate clear times (`PlateTurnaroundEvent`)
- Low-demand idle on beds (would understate true throughput)

**Dedicated-fleet diagnostic (per recipe line, then min):**

```
plates/printer/day = schedule-aware overnight simulation (fractional steady-state)
effective_parts/plate = qty_per_plate × harvestYield × qcYield
parts/day = active_printers × plates/printer/day × effective_parts/plate
devices/day from part = parts/day ÷ qty_per_device
devices/day_unconstrained = min(devices/day from part)
```

**Schedulable headline:** pack production files onto real printer lanes for a representative week.

- `devices_per_day_theoretical` = complete devices from **physical** plate starts on the first staffed day (matches the Gantt; 100% yield).
- `devices_per_day_realistic` = **expected** complete devices after applying each started plate’s print-job success × harvest × QC yields (`est_good_parts`), then taking the binding (min) part.
- `yield_drag` (on capacity / overview) breaks the theoretical → expected gap into sequential **whole-device** losses: **print failures → harvest scrap → QC rejects**. Losses are floored so they always sum to `floor(theoretical) − floor(expected)`. Hidden in the UI when the gap is under 1 whole device.

**Fleet preference:** parts that can run on A1/A1M (TOP/KNB) prefer those compact fleets when they can start **as soon as** any other eligible fleet (within ~15 minutes). If compact is busy until evening but H2D/X1C can start now, TOP spills to the free shared printer (so El Jefe is not left idle all day). When scoring spilled options, only same-model printers free in the same time band count as a “parallel wave,” and earlier starts win ties — so a free H2D at 10:00 is not beaten by four X1Cs that only free mid-afternoon. BOT/BUT always use H2S and X1C in parallel.

**Capacity headline:** schedulable devices are found by binary-searching the largest feasible target (a single huge probe ask is non-monotonic and can under-count). The reported number is BOM-limited packed parts on the first staffed day, matching the Gantt.

The Capacity trend chart overlays **actually shipped** (devices/day from TOP `shipped` floor events or `FloorProductUnit` links — whichever is larger that day) so estimated ceiling can be compared with floor outcomes. Shipped never feeds the capacity formula.

Configure schedule / line start / clear minutes / BOM under **Settings → Queue** (Stats 2 capacity card) or the Configuration widget on `/stats2`.

## Feedback (cleanup target vs reality)

**Question:** Is our configured clear-time assumption realistic?

Uses `PlateTurnaroundEvent` actuals (finish → clear confirmed), **staffed-hours finishes only** when judging ahead / on target / behind.

Optional one-shot backfill from print-log gaps:

```bash
python scripts/backfill_stats2_plate_turnaround.py --dry-run
python scripts/backfill_stats2_plate_turnaround.py
```

Backfill rows are tagged `source=backfill`. They approximate finish → next-start as clear time for early feedback when live clear acks are sparse. **Still never feed capacity math.**

## Readiness (separate from capacity)

**Question:** With stock on the floor *right now*, how many devices can we assemble?

Ready now = Staged for Prod + In WIP. Upstream = Initial QC only. Rework/sanding is separate. Linked is display-only (excluded).

## Buffer stock timeline (advisory Gantt only)

**Question:** If we keep ready-on-hand above min targets, what does this week’s schedule look like?

Second timeline on `/stats2` (toggle **Buffer stock** next to the day pills). Same packer as capacity; **not** used by `devices_per_day_*`.

- Config: `ready_buffer_targets` (defaults **BUT 80**, **KNB 50**; TOP/BOT 0 = off). Editable under Stats 2 / Settings → Queue.
- When `ready_now < target`, catch-up ask is **whole plates** (e.g. 10 short with BUT×47 → ask 47).
- Debt is front-loaded onto the next staffed days; shared printers spend time on catch-up instead of other parts that day.
- Jobs tagged `rationale=inventory_buffer`. Does not auto-queue printers.

API: `GET /api/v1/stats2/schedule/print-plan?timeline_mode=buffer`

## Export

```
GET /api/v1/stats2/export?format=csv&lookback_days=30
GET /api/v1/stats2/export?format=xlsx&lookback_days=30
```

Requires `stats:read`. Includes capacity, readiness, build plan, yield, quality reasons, lead times, and plate-turnaround feedback.
