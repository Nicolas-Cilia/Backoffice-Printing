/**
 * Floor: stations, filament kg, harvest, cleanup — `/floor/scan` (docs/floor-plan.md).
 *
 * Phase 1b (§2.4, §5): station sessions. A USB barcode pistol types a string
 * and Enter into whatever has focus, so this page keeps one hidden input
 * focused at all times and shows the result as big, glove-readable status text
 * — no dropdowns, no dense tables.
 *
 * Scanning a `BBS-` code opens a station, closes it when rescanned, or
 * switches. The session lives on the **server**, not in this tab, because a
 * station is an exclusive claim and a lock only works if every device sees it.
 * That means a reload resumes the open station rather than stranding it, and a
 * station held elsewhere is refused with an offer to take over.
 *
 * SKU, part, defect and command scans land in later phases; they are reported
 * as recognised-but-not-yet-handled rather than unknown, because "not built
 * yet" and "that code means nothing" send an operator to different places.
 *
 * Phase 8 adds Harvest (§5.4): a lean, big-text screen while the station is
 * open, fed by two endpoints (`BBP-` binds/rebinds/closes a plate, `BBD-`
 * links a part to it) and reachable from two entry points — the Harvest
 * station itself, and a part scan straight from the printer info page
 * (§5.6), which claims the harvest lock on its first scan. Both entry points
 * share one result-handling path (`applyPartScanResponse`) so a `no_job` or
 * `no_job` reads identically regardless of which entry point triggered it.
 *
 * Phase 9a/9b add Fit Check and Rework (§5.4a/§5.4b) — **not** stations, so
 * they add no session handling here at all. The flow is scan a part (from
 * idle, nothing open), then scan a location, and for Rework a reason after
 * that — three scans, tracked entirely as `Status` transitions on this page
 * (`awaiting-location` → `awaiting-rework-reason` → commit), never on the
 * server. Abandoning the flow needs no special code: scanning anything else
 * just replaces `status` with whatever that scan means, the same as every
 * other transition on this page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Lock, Printer, ScanLine } from 'lucide-react';
import {
  api,
  type FloorLiveStatus,
  type FloorPlateArchive,
  type FloorPlatePrinter,
  type FloorInventoryPart,
  type FloorLabeledPart,
  type FloorPrinterInfo,
  type FloorSession,
  type LocationScanResponse,
  type PartScanResponse,
  type PartScanResult,
  type ReworkReasonCode,
} from '../api/client';
import { getDeviceId } from '../utils/floorDevice';
import { playScanErrorTone } from '../utils/floorSound';
import {
  HARVEST_STATION_PAYLOAD,
  HARVEST_STATION_SLUG,
  PREFIX_REASON,
  formatElapsed,
  formatFloorDate,
  routeScan,
} from '../utils/floorScan';

/** How long a transient message (error, "closed", "not yet") stays up before
 *  the screen returns to its resting state. */
const FLASH_MS = 3000;
/** The open-station elapsed counter only needs to be minute-accurate (§5.4),
 *  so it ticks slowly — a kiosk runs for days and this is pure display. */
const ELAPSED_TICK_MS = 15000;
const HARVEST_SUMMARY_MS = 10000;

type Status =
  | { kind: 'idle' }
  /** A scan the app could not use: unknown code, or a real code whose phase
   *  has not shipped. Both flash red and ring the error tone. */
  | { kind: 'error'; message: string; detail?: string }
  /** Station closed — brief confirmation before returning to idle. */
  | { kind: 'closed'; stationName: string }
  /** Station held by another device: the one status that waits for a decision
   *  instead of timing out. Reused for the harvest lock even when the
   *  refusal came from a `BBP-`/`BBD-` scan rather than `BBS-harvest`
   *  itself — same floor-wide lock (§2.4), same takeover path. */
  | { kind: 'locked'; stationName: string; payload: string; blocking: FloorSession }
  /** A printer scanned with no station open — the info page (§5.6). Like
   *  `locked`, it persists rather than flashing: the operator is reading it. */
  | { kind: 'printer'; info: FloorPrinterInfo }
  /** The plate just closed (re-scanning the same printer under Harvest,
   *  §5.4). Brief confirmation of what was on it before the screen returns
   *  to the harvest idle state — plate close is not session close. */
  | { kind: 'plate-closed'; printer: FloorPlatePrinter; archive: FloorPlateArchive | null; partCount: number }
  | { kind: 'harvest-summary'; lines: import('../api/client').HarvestSummaryLine[] }
  /** A part was just scanned with nothing else going on — the first half of
   *  "scan a part, scan a location" (§5.4a/§5.4b). Persists (not a flash)
   *  since it is itself a prompt waiting for the next scan; abandoned by
   *  scanning anything that isn't a location code, same as every other
   *  status transition here. */
  | { kind: 'awaiting-location'; payload: string; part: PartImageIdentity | null }
  /** The part's location was Rework — a pure UI transition, no server call
   *  (§5.4b) — now waiting for the reason that actually commits it. */
  | { kind: 'awaiting-rework-reason'; payload: string; part: PartImageIdentity | null }
  | { kind: 'awaiting-discard-reason'; payload: string; part: PartImageIdentity | null }
  | { kind: 'awaiting-custom-reason'; locationSlug: 'rework' | 'discard'; payload: string; reasonPayload: string; part: PartImageIdentity | null }
  /** Fit Check or Rework just committed — brief confirmation before the
   *  screen returns to idle, same timing as `plate-closed`. */
  | {
      kind: 'location-recorded';
      locationSlug: 'fit-check' | 'rework' | 'discard';
      part: FloorLabeledPart | null;
      printer: FloorPlatePrinter | null;
      archive: FloorPlateArchive | null;
      reasonCode?: string;
    };

type PartImageIdentity = Pick<FloorInventoryPart, 'part_code' | 'section_part_id' | 'part_name' | 'part_source' | 'labeled_at' | 'archived_at' | 'latest_event_action'> & {
  printer_name: string | null;
  printer_id: number | null;
};

function isAlreadyAtLocation(part: PartImageIdentity | null, locationSlug: 'fit-check' | 'rework' | 'discard') {
  if (!part) return false;
  if (locationSlug === 'fit-check') {
    return part.latest_event_action === 'fit_check' || part.latest_event_action === 'fit_checked';
  }
  if (locationSlug === 'rework') {
    return part.latest_event_action === 'rework' || part.latest_event_action === 'sanding';
  }
  return part.latest_event_action === 'discarded';
}

/** The plate currently bound under an open Harvest session (§5.4): which
 *  printer, its resolved job (null = no job found, §7.2), and the running
 *  count of parts labeled against it. Null while Harvest is open but nothing
 *  has been bound yet — the very first thing the flow asks for. */
type HarvestPlate = {
  printer: FloorPlatePrinter;
  archive: FloorPlateArchive | null;
  partCount: number;
} | null;

/** The result of the most recent `BBD-` scan, shown as a brief, deliberately
 *  neutral line. Kept separate from
 *  `Status` because it can overlay either the harvest screen or the printer
 *  info panel, whichever is on top when the scan happens. */
type PartFeedback = {
  result: Extract<PartScanResult, 'labeled' | 'no_job'>;
  part: FloorLabeledPart | null;
  printer: FloorPlatePrinter | null;
  archive: FloorPlateArchive | null;
};

export function FloorScanPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  // A USB pistol fires its whole scan (characters + Enter) far faster than a
  // human types — fast enough that the trailing keydown can land before React
  // has committed the render from the preceding onChange calls. Read from a
  // ref (updated synchronously, same tick as onChange) instead of closing over
  // `value` state, so Enter never sees a stale or partial scan.
  const valueRef = useRef('');

  const deviceId = useMemo(() => getDeviceId(), []);
  const [session, setSession] = useState<FloorSession | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  // Ticks the open-station elapsed display without refetching the session.
  const [now, setNow] = useState(() => Date.now());
  // The bound plate under an open Harvest session (§5.4). Local UI state, not
  // server-resumed: `GET /floor/session` (used on reload) reports only the
  // session, not what it is bound to, so a reload of an already-bound
  // Harvest session shows the "scan the printer" idle flavor rather than
  // reconstructing the plate — the next printer or part scan re-establishes
  // it either way.
  const [harvestPlate, setHarvestPlate] = useState<HarvestPlate>(null);
  // The last `BBD-` scan's outcome, shown as a brief overlay on whichever
  // screen was on top when it happened (the harvest screen or the printer
  // info panel) — see `PartFeedback`.
  const [partFeedback, setPartFeedback] = useState<PartFeedback | null>(null);

  // The session state the Enter handler reads. Same reasoning as valueRef:
  // two scans in quick succession must not both act on the pre-first state.
  const sessionRef = useRef<FloorSession | null>(null);
  sessionRef.current = session;
  const busyRef = useRef(false);
  // Same reasoning again: `handleScan` needs to know whether the printer info
  // page is currently showing (to pass its printer id as the harvest-lock
  // hint, §5.6) without closing over stale `status` state.
  const statusRef = useRef<Status>({ kind: 'idle' });
  statusRef.current = status;
  const customReasonDraftRef = useRef<string | null>(null);
  const customReasonPendingRef = useRef(false);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // Always-focused scan field (§3.1): the pistol has no mode switch, so
  // whatever has focus IS the scan target.
  useEffect(() => {
    focusInput();
    const onWindowClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('button, input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      focusInput();
    };
    window.addEventListener('click', onWindowClick);
    return () => window.removeEventListener('click', onWindowClick);
  }, [focusInput]);

  // Resume whatever this device already holds. The session is server-side
  // precisely so an accidental reload does not lose the open station.
  useEffect(() => {
    let cancelled = false;
    api
      .getFloorSession(deviceId)
      .then((existing) => {
        if (!cancelled) setSession(existing);
      })
      .catch(() => {
        // A failed resume is not worth an error screen: the operator can
        // rescan the station QR, which is one action away.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  // `locked`, `awaiting-location` and `awaiting-rework-reason` are excluded
  // on purpose: each is a prompt waiting for a specific next scan, not a
  // flash. `plate-closed`/`location-recorded` join `error`/`closed` here for
  // the same reason those flash: each is a brief confirmation, not a
  // decision point.
  useEffect(() => {
    if (
      status.kind !== 'error' &&
      status.kind !== 'closed' &&
      status.kind !== 'plate-closed' &&
      status.kind !== 'location-recorded'
    )
      return;
    const timer = window.setTimeout(() => setStatus({ kind: 'idle' }), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (status.kind !== 'harvest-summary') return;
    const timer = window.setTimeout(() => setStatus({ kind: 'idle' }), HARVEST_SUMMARY_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  // A part-scan result overlays whichever screen was on top (harvest or the
  // printer info panel) briefly, then gets out of the way on its own — the
  // steady display (running count, plate job) already carries the durable
  // information, so this is a confirmation, not a thing to dismiss.
  useEffect(() => {
    if (!partFeedback) return;
    const timer = window.setTimeout(() => setPartFeedback(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [partFeedback]);

  const failScan = useCallback((message: string, detail?: string) => {
    // Sound before state: most rejections happen at the storage shelf, out of
    // sight of this screen, where the tone is the only feedback (§2.2).
    playScanErrorTone();
    setStatus({ kind: 'error', message, detail });
  }, []);

  const applyScanResponse = useCallback(
    (resp: Awaited<ReturnType<typeof api.scanFloorStation>>) => {
      if (resp.result === 'locked' && resp.blocking) {
        playScanErrorTone();
        setStatus({
          kind: 'locked',
          stationName: resp.station_name,
          payload: `BBS-${resp.station_slug}`,
          blocking: resp.blocking,
        });
        return;
      }
      if (resp.result === 'closed') {
        setSession(null);
        setHarvestPlate(null);
        setStatus({ kind: 'closed', stationName: resp.station_name });
        return;
      }
      setSession(resp.session);
      // A station-level open or switch always starts with nothing bound —
      // any plate from a previous Harvest run on this device is gone with
      // the session that carried it, whether this device just opened
      // Harvest again or left it for another station entirely.
      setHarvestPlate(null);
      setStatus({ kind: 'idle' });
    },
    [],
  );

  const submitStationScan = useCallback(
    async (payload: string) => {
      setBusy(true);
      busyRef.current = true;
      try {
        const closingHarvest = sessionRef.current?.station_slug === HARVEST_STATION_SLUG && payload === HARVEST_STATION_PAYLOAD;
        const summary = closingHarvest ? await api.getHarvestSummary(sessionRef.current!.id) : null;
        applyScanResponse(await api.scanFloorStation({ payload, device_id: deviceId }));
        if (summary) setStatus({ kind: 'harvest-summary', lines: summary });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A 404 from this endpoint means "not a station code" — the unknown
        // scan of §9. Anything else is a real failure and says so, rather
        // than blaming the label.
        failScan(
          message.includes('Not a station code')
            ? t('floor.scanUnknown', 'Unknown code')
            : t('floor.scanFailed', 'Scan failed'),
          payload,
        );
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [applyScanResponse, deviceId, failScan, t],
  );

  const submitPrinterScan = useCallback(
    async (payload: string) => {
      setBusy(true);
      busyRef.current = true;
      try {
        setStatus({ kind: 'printer', info: await api.getFloorPrinterInfo(payload) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failScan(
          message.includes('printer code')
            ? t('floor.scanUnknown', 'Unknown code')
            : t('floor.scanFailed', 'Scan failed'),
          payload,
        );
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [failScan, t],
  );

  const submitHarvestPrinterScan = useCallback(
    async (payload: string) => {
      setBusy(true);
      busyRef.current = true;
      try {
        const resp = await api.scanHarvestPrinter({ device_id: deviceId, payload });
        // Reflects ground truth unconditionally, same as the part-scan path
        // below — including the defensive `no_session` case, where it
        // corrects a local session this device no longer actually holds.
        setSession(resp.session);

        if (resp.result === 'locked') {
          // Reserved for completeness (contract): the harvest lock is
          // already held by this device whenever a session exists to scan
          // against, so the backend should never actually send this here.
          // Handled the same as a real refusal rather than assumed away.
          if (resp.blocking) {
            playScanErrorTone();
            setStatus({
              kind: 'locked',
              stationName: t('floor.stationHarvest', 'Harvest'),
              payload: HARVEST_STATION_PAYLOAD,
              blocking: resp.blocking,
            });
          } else {
            failScan(t('floor.scanFailed', 'Scan failed'), payload);
          }
          return;
        }
        if (resp.result === 'unknown_printer') {
          failScan(t('floor.scanUnknown', 'Unknown code'), payload);
          return;
        }
        if (resp.result === 'no_session') {
          // The router never produces this action without a harvest session
          // open, so this is defensive rather than reachable in practice —
          // but if it happens, this device holds no plate either.
          setHarvestPlate(null);
          failScan(t('floor.scanFailed', 'Scan failed'), payload);
          return;
        }
        if (resp.result === 'plate_closed') {
          // Re-scanning the same printer closes the plate, not the session
          // (§5.4) — show what was on it, then the harvest screen returns to
          // its "scan a printer" idle flavor once the flash clears.
          setHarvestPlate(null);
          if (resp.printer) {
            setStatus({
              kind: 'plate-closed',
              printer: resp.printer,
              archive: resp.archive,
              partCount: resp.part_count,
            });
          } else {
            setStatus({ kind: 'idle' });
          }
          return;
        }
        // bound / rebound: (re)bind the plate. A rebind's part_count already
        // restarts at 0 server-side (a fresh plate), so this simply mirrors
        // whatever the response says rather than resetting locally.
        if (resp.printer) {
          setHarvestPlate({ printer: resp.printer, archive: resp.archive, partCount: resp.part_count });
        }
        setStatus({ kind: 'idle' });
      } catch {
        failScan(t('floor.scanFailed', 'Scan failed'), payload);
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [deviceId, failScan, t],
  );

  const applyPartScanResponse = useCallback(
    (resp: PartScanResponse) => {
      // Every part-scan outcome reports the session this device holds
      // afterward — including one this very scan just created (info-page
      // entry #2, §5.6) — so later scans route correctly regardless of
      // which screen is on top right now.
      setSession(resp.session);

      if (resp.result === 'locked') {
        if (resp.blocking) {
          playScanErrorTone();
          setStatus({
            kind: 'locked',
            stationName: t('floor.stationHarvest', 'Harvest'),
            payload: HARVEST_STATION_PAYLOAD,
            blocking: resp.blocking,
          });
        } else {
          failScan(t('floor.scanFailed', 'Scan failed'));
        }
        return;
      }
      if (resp.result === 'no_printer') {
        // §5.4: harvest "ignores" a part scan it cannot place — no printer
        // bound, and no info-page hint to claim one from.
        failScan(t('floor.scanPartNoPrinter', 'Scan the printer first'));
        return;
      }
      if (resp.result === 'invalid_code') {
        failScan(t('floor.scanInvalidCode', 'Invalid part code'));
        return;
      }
      if (resp.result === 'duplicate') {
        failScan(t('floor.scanPartDuplicate', 'Part already scanned'));
        return;
      }

      // labeled / no_job both write against the current plate.
      if (resp.printer) {
        // labeled / no_job both write against the *current* plate, so
        // printer/archive here are that plate's own.
        setHarvestPlate({ printer: resp.printer, archive: resp.archive, partCount: resp.part_count });
      }
      setPartFeedback({ result: resp.result, part: resp.part, printer: resp.printer, archive: resp.archive });
    },
    [failScan, t],
  );

  const submitPartScan = useCallback(
    async (payload: string, viewingPrinterId: number | null) => {
      setBusy(true);
      busyRef.current = true;
      try {
        applyPartScanResponse(
          await api.scanFloorPart({ device_id: deviceId, payload, printer_id: viewingPrinterId }),
        );
      } catch {
        failScan(t('floor.scanFailed', 'Scan failed'), payload);
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [applyPartScanResponse, deviceId, failScan, t],
  );

  // Fit Check and Rework are locations, not stations (§5.4a/§5.4b) — no
  // session touched by either commit below, and no device_id sent: the
  // sticker code (and for Rework, the reason) is everything the backend
  // needs, already known locally by the time these are called.
  const applyLocationScanResponse = useCallback(
    (locationSlug: 'fit-check' | 'rework', resp: LocationScanResponse, reasonCode?: string) => {
      if (resp.result === 'invalid_code') {
        failScan(t('floor.scanInvalidCode', 'Invalid part code'));
        return;
      }
      if (resp.result === 'unknown_part') {
        // §9: never enrolled at Harvest — the sticker doesn't exist yet.
        failScan(t('floor.locationUnknownPart', 'Not enrolled — scan it at Harvest first'));
        return;
      }
      if (resp.result === 'already_at_location') {
        failScan(
          locationSlug === 'fit-check'
            ? t('floor.fitCheckAlreadyRecorded', 'Part is already in Fit Check')
            : t('floor.reworkAlreadyRecorded', 'Part is already in Rework'),
        );
        return;
      }
      // recorded: for Fit Check, a first check or a re-check both land here
      // (§5.4a) — there is no verdict to distinguish them by. For Rework,
      // every visit is its own event (§5.4b) — no amendment concept either.
      setStatus({
        kind: 'location-recorded',
        locationSlug,
        part: resp.part,
        printer: resp.printer,
        archive: resp.archive,
        reasonCode: resp.reason ?? reasonCode,
      });
    },
    [failScan, t],
  );

  const submitFitCheckPartScan = useCallback(
    async (payload: string) => {
      setBusy(true);
      busyRef.current = true;
      try {
        applyLocationScanResponse('fit-check', await api.scanFitCheckPart({ payload }));
      } catch {
        failScan(t('floor.scanFailed', 'Scan failed'), payload);
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [applyLocationScanResponse, failScan, t],
  );

  const submitReworkPartScan = useCallback(
    async (payload: string, reasonPayload: string, reasonText?: string | null, showResult = true) => {
      setBusy(true);
      busyRef.current = true;
      try {
        // The reason payload is `BBR-<reason_code>` verbatim — the QR is
        // printed with the backend's own ReworkReasonCode values, so no
        // translation happens here, just stripping the prefix. Not
        // statically checked against the union (it comes from a scan, not
        // a literal) — the backend accepts any non-empty string for this
        // field and stores it as-is (§5.4b), same latitude `BBF-other`-style
        // free-form codes get elsewhere in this app.
        const reasonCode = reasonPayload.slice(PREFIX_REASON.length) as ReworkReasonCode;
        const response = await api.scanReworkPart({ payload, reason_code: reasonCode, reason_text: reasonText });
        if (showResult) applyLocationScanResponse('rework', response, reasonCode);
      } catch {
        failScan(t('floor.scanFailed', 'Scan failed'), payload);
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [applyLocationScanResponse, failScan, t],
  );

  const submitReworkErrorScan = useCallback(
    async (payload: string, errorPayload: string, reasonText?: string | null, showResult = true) => {
      setBusy(true);
      busyRef.current = true;
      try {
        const response = await api.scanReworkError({ payload, error_payload: errorPayload, reason_text: reasonText });
        if (showResult) applyLocationScanResponse('rework', response);
      } catch {
        failScan(t('floor.scanFailed', 'Scan failed'), payload);
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [applyLocationScanResponse, failScan, t],
  );

  const submitDiscardScan = useCallback(
    async (payload: string, errorPayload: string, reasonText?: string | null, showResult = true) => {
      setBusy(true);
      busyRef.current = true;
      try {
        const response = await api.discardFloorPart({ payload, error_payload: errorPayload, reason_text: reasonText });
        if (response.result === 'already_at_location') {
          if (!showResult) return;
          failScan(t('floor.discardAlreadyRecorded', 'Part is already discarded'), payload);
          return;
        }
        if (response.result !== 'recorded') {
          if (!showResult) return;
          failScan(t('floor.scanInvalidCode', 'Invalid part code'), payload);
          return;
        }
        if (showResult) setStatus({ kind: 'location-recorded', locationSlug: 'discard', part: response.part, printer: response.printer, archive: response.archive, reasonCode: response.reason ?? undefined });
      } catch {
        failScan(t('floor.scanFailed', 'Scan failed'), payload);
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [failScan, t],
  );

  const handleScan = useCallback(
    (scanned: string) => {
      // Drop scans fired while a request is in flight rather than queueing
      // them: a double-trigger on the same label would otherwise open and
      // immediately close the station.
      if (busyRef.current) return;

      // Read from refs, not the `status`/`session` state closed over by this
      // render: the same same-tick pistol race `valueRef` exists for (see
      // above) applies to routing, not just to the raw scanned text.
      const viewingPrinterId = statusRef.current.kind === 'printer' ? statusRef.current.info.id : null;
      const route = routeScan(scanned, sessionRef.current?.station_slug ?? null, viewingPrinterId);
      if (route.action === 'ignore') return;
      if (route.action === 'station') {
        void submitStationScan(route.payload);
        return;
      }
      if (route.action === 'printer-info') {
        // A printer-info screen is a read-only inspection, not a station. A
        // repeat scan of the same physical label is therefore the natural
        // hands-free close gesture; a different printer still replaces it.
        if (statusRef.current.kind === 'printer' && statusRef.current.info.payload === route.payload) {
          setStatus({ kind: 'idle' });
          setPartFeedback(null);
          return;
        }
        void submitPrinterScan(route.payload);
        return;
      }
      if (route.action === 'harvest-printer') {
        void submitHarvestPrinterScan(route.payload);
        return;
      }
      if (route.action === 'harvest-part') {
        void submitPartScan(route.payload, route.printerId ?? null);
        return;
      }
      if (route.action === 'part-scanned') {
        // First half of scan-part-then-location (§5.4a/§5.4b). Overwrites
        // whatever was pending before, if anything — scanning a different
        // part just restarts the flow on the new one.
        const pendingCustomReason = statusRef.current.kind === 'awaiting-custom-reason'
          ? statusRef.current
          : null;
        if (pendingCustomReason) {
          const reasonText = customReasonDraftRef.current;
          customReasonDraftRef.current = null;
          customReasonPendingRef.current = false;
          if (pendingCustomReason.locationSlug === 'discard') {
            void submitDiscardScan(pendingCustomReason.payload, pendingCustomReason.reasonPayload, reasonText, false);
          } else if (pendingCustomReason.reasonPayload.toLowerCase() === 'bbr-other') {
            void submitReworkPartScan(pendingCustomReason.payload, pendingCustomReason.reasonPayload, reasonText, false);
          } else {
            void submitReworkErrorScan(pendingCustomReason.payload, pendingCustomReason.reasonPayload, reasonText, false);
          }
        }
        setBusy(true);
        busyRef.current = true;
        void api.getFloorInventoryPartBySticker(route.payload)
          .then((part) => {
            setStatus({
              kind: 'awaiting-location',
              payload: route.payload,
              part: {
                part_code: part.part_code,
                section_part_id: part.section_part_id,
                part_name: part.part_name,
                part_source: part.part_source,
                printer_name: part.printer_name,
                printer_id: part.printer_id,
                labeled_at: part.labeled_at,
                archived_at: part.archived_at,
                latest_event_action: part.latest_event_action,
              },
            });
          })
          .catch(() => setStatus({ kind: 'awaiting-location', payload: route.payload, part: null }))
          .finally(() => {
            setBusy(false);
            busyRef.current = false;
          });
        return;
      }
      if (route.action === 'location') {
        if (statusRef.current.kind === 'awaiting-location') {
          const pendingPayload = statusRef.current.payload;
          const pendingPart = statusRef.current.part;
          if (route.slug === 'fit-check') {
            if (isAlreadyAtLocation(pendingPart, 'fit-check')) {
              failScan(t('floor.fitCheckAlreadyRecorded', 'Part is already in Fit Check'), route.payload);
              return;
            }
            void submitFitCheckPartScan(pendingPayload);
          } else {
            if (isAlreadyAtLocation(pendingPart, 'rework')) {
              failScan(t('floor.reworkAlreadyRecorded', 'Part is already in Rework'), route.payload);
              return;
            }
            // Rework's location scan is a pure state transition — no
            // server call until the reason is known (§5.4b).
            setStatus({ kind: 'awaiting-rework-reason', payload: pendingPayload, part: pendingPart });
          }
          return;
        }
        // No part pending: a location code scanned on its own says so
        // specifically, rather than reading as a generic unknown code.
        failScan(t('floor.locationNoPartPending', 'Scan a part first'), route.payload);
        return;
      }
      if (route.action === 'rework-reason') {
        if (statusRef.current.kind === 'awaiting-rework-reason') {
          if (route.payload.toLowerCase() === 'bbr-other') {
            if (customReasonPendingRef.current) return;
            customReasonPendingRef.current = true;
            customReasonDraftRef.current = null;
            setStatus({
              kind: 'awaiting-custom-reason',
              locationSlug: 'rework',
              payload: statusRef.current.payload,
              reasonPayload: route.payload,
              part: statusRef.current.part,
            });
            return;
          }
          void submitReworkPartScan(statusRef.current.payload, route.payload);
          return;
        }
        failScan(t('floor.reworkReasonNoPartPending', 'Scan a part into Rework first'), route.payload);
        return;
      }
      if (route.action === 'command') {
        if (route.payload === 'BBX-discard' && statusRef.current.kind === 'awaiting-location') {
          if (isAlreadyAtLocation(statusRef.current.part, 'discard')) {
            failScan(t('floor.discardAlreadyRecorded', 'Part is already discarded'), route.payload);
            return;
          }
          setStatus({ kind: 'awaiting-discard-reason', payload: statusRef.current.payload, part: statusRef.current.part });
          return;
        }
        if (route.payload === 'BBX-discard') {
          failScan(t('floor.discardNoPartPending', 'Scan a part first, then Discard'), route.payload);
          return;
        }
        failScan(t('floor.scanNotYetSupported', 'Not handled yet'), route.payload);
        return;
      }
      if (route.action === 'error-label') {
        if (statusRef.current.kind === 'awaiting-rework-reason') {
          if (route.payload.toLowerCase() === 'bbf-other') {
            if (customReasonPendingRef.current) return;
            customReasonPendingRef.current = true;
            customReasonDraftRef.current = null;
            setStatus({
              kind: 'awaiting-custom-reason',
              locationSlug: 'rework',
              payload: statusRef.current.payload,
              reasonPayload: route.payload,
              part: statusRef.current.part,
            });
            return;
          }
          void submitReworkErrorScan(statusRef.current.payload, route.payload);
          return;
        }
        if (statusRef.current.kind === 'awaiting-discard-reason') {
          if (route.payload.toLowerCase() === 'bbf-other') {
            if (customReasonPendingRef.current) return;
            customReasonPendingRef.current = true;
            customReasonDraftRef.current = null;
            setStatus({
              kind: 'awaiting-custom-reason',
              locationSlug: 'discard',
              payload: statusRef.current.payload,
              reasonPayload: route.payload,
              part: statusRef.current.part,
            });
            return;
          }
          void submitDiscardScan(statusRef.current.payload, route.payload);
          return;
        }
        failScan(t('floor.errorReasonNoPartPending', 'Scan a part, then Rework or Discard first'), route.payload);
        return;
      }
      failScan(t('floor.scanNotYetSupported', 'Not handled yet'), route.value);
    },
    [
      failScan,
      submitStationScan,
      submitPrinterScan,
      submitHarvestPrinterScan,
      submitPartScan,
      submitFitCheckPartScan,
      submitReworkPartScan,
      submitReworkErrorScan,
      submitDiscardScan,
      t,
    ],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    valueRef.current = e.target.value;
    setValue(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const scanned = valueRef.current.trim();
    valueRef.current = '';
    setValue('');
    if (!scanned) return;
    handleScan(scanned);
  };

  const handleTakeover = async () => {
    if (status.kind !== 'locked') return;
    setBusy(true);
    busyRef.current = true;
    try {
      applyScanResponse(
        await api.takeoverFloorStation({ payload: status.payload, device_id: deviceId }),
      );
    } catch (err) {
      failScan(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      busyRef.current = false;
      focusInput();
    }
  };

  const handleClose = async () => {
    setBusy(true);
    busyRef.current = true;
    try {
      await api.closeFloorSession(deviceId);
      setSession(null);
      setHarvestPlate(null);
      setPartFeedback(null);
      setStatus({ kind: 'idle' });
    } catch (err) {
      failScan(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      busyRef.current = false;
      focusInput();
    }
  };

  // Count forward from the server's figure rather than recomputing from
  // `opened_at`, so a wrong clock on this PC cannot distort it (§5.4). The
  // baseline resets whenever the session changes, so a freshly opened station
  // starts from its own server-reported age rather than the previous one's.
  const elapsedBaseline = useRef(Date.now());
  useEffect(() => {
    elapsedBaseline.current = Date.now();
  }, [session?.id]);

  const elapsedSeconds = session
    ? session.open_seconds + Math.max(0, Math.floor((now - elapsedBaseline.current) / 1000))
    : 0;

  // Tick every second for the first minute so the counter is visibly live —
  // an operator can see the screen responding rather than frozen. After
  // that the display is minute-granular anyway, so a second-by-second
  // re-render would be wasted work on a kiosk that runs for days.
  const needsSecondTicks = session !== null && elapsedSeconds < 60;
  useEffect(() => {
    if (session === null) return;
    const id = window.setInterval(
      () => setNow(Date.now()),
      needsSecondTicks ? 1000 : ELAPSED_TICK_MS,
    );
    return () => window.clearInterval(id);
    // Keyed on the boolean, not the elapsed value: the interval is rebuilt
    // once when it crosses a minute, not on every tick.
  }, [needsSecondTicks, session]);

  const isError = status.kind === 'error';
  const isLocked = status.kind === 'locked';

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bambu-dark px-6 text-center">
      {/* z-50: above Layout's compact-mode mobile header (z-40) and desktop
          sidebar (z-30) — this page fully covers app chrome regardless of
          viewport width, matching the "sparse: sidebar collapsed or minimal"
          spec (docs/floor-plan.md §3.1).

          Plain <input>, no keyboard-suppression attribute. Two attempts to
          hide Android's on-screen keyboard here (inputMode="none", and a
          non-editable div capturing raw keydown) both broke scan input on
          the real device being tested against — reverted rather than
          shipping a "fix" that cost the feature it was protecting. The
          keyboard popping up is a known, accepted rough edge until a
          working suppression approach is found. */}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={focusInput}
        aria-label={t('floor.scanFieldLabel', 'Scan field')}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="sr-only"
      />

      {loading ? (
        <Loader2 className="w-12 h-12 animate-spin text-bambu-gray" aria-hidden="true" />
      ) : status.kind === 'printer' ? (
        <PrinterInfoPanel
          info={status.info}
          feedback={partFeedback}
          onDismiss={() => setStatus({ kind: 'idle' })}
          t={t}
        />
      ) : isLocked && status.kind === 'locked' ? (
        <LockedPrompt
          stationName={status.stationName}
          blocking={status.blocking}
          busy={busy}
          onTakeover={handleTakeover}
          t={t}
        />
      ) : status.kind === 'plate-closed' ? (
        <PlateClosedFlash printer={status.printer} archive={status.archive} partCount={status.partCount} t={t} />
      ) : status.kind === 'harvest-summary' ? (
        <div className="w-full max-w-2xl text-center">
          <h1 className="text-3xl font-bold text-white">
            {t('floor.harvestCompleteTitle', 'Harvest complete')}
          </h1>
          <p className="text-bambu-gray mt-1">
            {t('floor.harvestCompleteCount', '{{count}} parts linked', {
              count: status.lines.reduce((total, line) => total + line.part_count, 0),
            })}
          </p>
          <div className="mt-6 space-y-2">
            {status.lines.map((line) => (
              <div
                key={`${line.printer_id}-${line.print_name}`}
                className="bg-bambu-dark-secondary rounded-lg p-4 text-white flex justify-between text-left"
              >
                <span>
                  {line.printer_name ?? t('floor.harvestUnknownPrinter', 'Unknown printer')}
                  {' · '}
                  {line.print_name ?? t('floor.harvestNoJob', 'No job')}
                </span>
                <strong>{line.part_count}</strong>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="mt-6 px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['floor-inventory-parts'] });
              navigate('/floor/inventory');
            }}
          >
            {t('floor.harvestViewPartHistory', 'View part history')}
          </button>
        </div>
      ) : status.kind === 'error' && session && session.station_slug === HARVEST_STATION_SLUG ? (
        // The generic block below hides its error text once a session is
        // open (it shows the station name instead, which for every other
        // station is rare enough to be a non-issue) — but Harvest rejects a
        // scan for reasons the operator has to actually read ("scan the
        // printer first", "invalid part code"), so this reproduces the same
        // red flash with the message visible instead of hidden behind it.
        <>
          <ScanLine className="w-16 h-16 mb-6 text-red-500" aria-hidden="true" />
          <p className="text-3xl font-bold text-red-500">{status.message}</p>
          {status.detail && (
            <p className="mt-3 text-lg text-bambu-gray-light font-mono break-all max-w-2xl">
              {status.detail}
            </p>
          )}
        </>
      ) : session && session.station_slug === HARVEST_STATION_SLUG && status.kind === 'idle' ? (
        // The lean harvest screen (§5.4) — the resting state once nothing
        // more urgent (error, lock, printer-info) is on top of it.
        <HarvestScreen
          session={session}
          plate={harvestPlate}
          feedback={partFeedback}
          elapsedSeconds={elapsedSeconds}
          busy={busy}
          onClose={handleClose}
          t={t}
        />
      ) : status.kind === 'awaiting-location' ? (
        // First half of scan-part-then-location, done (§5.4a/§5.4b) — not a
        // station, so nothing about `session` is involved here at all.
        <AwaitingLocationScreen payload={status.payload} part={status.part} t={t} />
      ) : status.kind === 'awaiting-rework-reason' ? (
        <AwaitingReworkReasonScreen payload={status.payload} part={status.part} t={t} />
      ) : status.kind === 'awaiting-discard-reason' ? (
        <AwaitingDiscardReasonScreen payload={status.payload} part={status.part} t={t} />
      ) : status.kind === 'awaiting-custom-reason' ? (
        <AwaitingCustomReasonScreen
          payload={status.payload}
          part={status.part}
          locationSlug={status.locationSlug}
          t={t}
          onDraftChange={(reasonText) => {
            customReasonDraftRef.current = reasonText;
          }}
          onSubmit={(reasonText) => {
            customReasonPendingRef.current = false;
            if (status.locationSlug === 'discard') {
              void submitDiscardScan(status.payload, status.reasonPayload, reasonText);
            } else if (status.reasonPayload.toLowerCase() === 'bbr-other') {
              void submitReworkPartScan(status.payload, status.reasonPayload, reasonText);
            } else {
              void submitReworkErrorScan(status.payload, status.reasonPayload, reasonText);
            }
          }}
        />
      ) : status.kind === 'location-recorded' ? (
        <LocationRecordedFlash
          locationSlug={status.locationSlug}
          part={status.part}
          printer={status.printer}
          archive={status.archive}
          reasonCode={status.reasonCode}
          t={t}
        />
      ) : (
        <>
          <ScanLine
            className={`w-16 h-16 mb-6 transition-colors ${
              isError ? 'text-red-500' : session ? 'text-bambu-green' : 'text-bambu-gray'
            }`}
            aria-hidden="true"
          />

          {session ? (
            <>
              {/* The open station is the loudest thing on screen: on a shared
                  PC the first question anyone has walking up is "what mode is
                  this in", and it must be answerable from a few steps away. */}
              <p className="text-5xl font-bold text-bambu-green">{session.station_name}</p>
              <p className="mt-3 text-lg text-bambu-gray">
                {t('floor.scanOpenFor', 'Open for {{elapsed}}', {
                  elapsed: formatElapsed(elapsedSeconds),
                })}
              </p>
              <button
                type="button"
                onClick={handleClose}
                disabled={busy}
                className="mt-6 px-4 py-2 text-sm rounded-lg bg-bambu-dark-secondary text-bambu-gray hover:text-white transition-colors disabled:opacity-50"
              >
                {t('floor.scanClose', 'Close station')}
              </button>
            </>
          ) : (
            <p className={`text-3xl font-bold ${isError ? 'text-red-500' : 'text-white'}`}>
              {status.kind === 'error'
                ? status.message
                : status.kind === 'closed'
                  ? t('floor.scanClosed', '{{station}} closed', { station: status.stationName })
                  : t('floor.scanIdle', 'Scan a code')}
            </p>
          )}

          {status.kind === 'error' && status.detail && (
            <p className="mt-3 text-lg text-bambu-gray-light font-mono break-all max-w-2xl">
              {status.detail}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Gcode states that mean a job is loaded and in progress. Mirrors
 *  `ACTIVE_PRINT_STATES` in printer_manager.py — kept in step with it so the
 *  floor never calls a printer idle while the backend considers it busy. */
const ACTIVE_PRINT_STATES = ['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'];

/** A word for the machine's current state. The raw gcode state is passed
 *  through from MQTT, so this maps the ones an operator will actually meet
 *  and falls back to showing the raw value rather than inventing one — an
 *  unfamiliar state is better shown verbatim than mislabelled "idle". */
function liveStatusLabel(
  live: FloorLiveStatus | null,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (live === null) return t('floor.printerStatusUnknown', 'Status unavailable');
  if (!live.connected) return t('floor.printerStatusOffline', 'Not connected');
  switch (live.state) {
    case 'RUNNING':
      return t('floor.printerStatusPrinting', 'Printing');
    case 'PAUSE':
      return t('floor.printerStatusPaused', 'Paused');
    case 'IDLE':
      return t('floor.printerStatusIdle', 'Idle');
    case 'FINISH':
      return t('floor.printerStatusFinished', 'Finished');
    case 'FAILED':
      return t('floor.printerStatusFailed', 'Failed');
    case 'PREPARE':
      return t('floor.printerStatusPreparing', 'Preparing');
    case 'SLICING':
      return t('floor.printerStatusSlicing', 'Slicing');
    case 'unknown':
      return t('floor.printerStatusWaiting', 'Waiting for status');
    default:
      return live.state;
  }
}

function StatusDot({ live }: { live: FloorLiveStatus | null }) {
  const color =
    live === null || !live.connected
      ? 'bg-bambu-gray'
      : live.state === 'FAILED'
        ? 'bg-red-500'
        : live.state === 'PAUSE'
          ? 'bg-amber-500'
          : ACTIVE_PRINT_STATES.includes(live.state)
            ? 'bg-bambu-green'
            : 'bg-bambu-gray-light';
  return <span className={`w-3 h-3 rounded-full flex-shrink-0 ${color}`} aria-hidden="true" />;
}

/** Turns a successful part scan into display text plus a tone. Shared by
 *  `HarvestScreen` and `PrinterInfoPanel` — the two screens a `BBD-` scan can
 *  land on (§5.4/§5.6) — so the wording (and the "never red" rule for
 *  `no_job` (§7.2) can't drift between them. */
function partFeedbackMessage(
  feedback: PartFeedback,
  t: ReturnType<typeof useTranslation>['t'],
): { text: string; tone: 'positive' | 'neutral' } {
  if (feedback.result === 'labeled') {
    return {
      text: t('floor.partLabeled', 'Linked · {{model}}', {
        model: feedback.archive?.print_name ?? t('floor.printerUnnamedJob', 'Unnamed job'),
      }),
      tone: 'positive',
    };
  }
  // no_job: the exact phrasing docs/floor-plan.md §7.2/§9 asks for — a plain
  // statement, not an apology, and never styled or sounded as a rejection.
  // Unconditional (not a second `if`): `feedback.result` is a two-value
  // union, but leaving the fallthrough implicit meant TS couldn't prove
  // every path returns, which broke `npm run build` — this fixes that.
  return {
    text: t('floor.partNoJob', 'Linked to printer {{id}}, no job found', {
      id: feedback.printer?.id,
    }),
    tone: 'neutral',
  };
}

/** The 3MF cover image Files already has on file for a scanned part's
 *  Production code (TOP/BOT/KNB/BUT/…, §7), shown next to the result on the
 *  scan page. Renders nothing when there is no code, and hides itself on
 *  load failure — an unknown code and one with no thumbnail on file both
 *  mean "nothing to show", not a broken-image icon. */
function PartCodeThumbnail({ partCode, sectionPartId, className }: { partCode: string | null | undefined; sectionPartId?: number | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [partCode, sectionPartId]);
  if (!partCode || failed) return null;
  return (
    <img
      src={api.getFloorPartCodeThumbnailUrl(partCode, sectionPartId)}
      alt={partCode}
      onError={() => setFailed(true)}
      className={className ?? 'mx-auto h-20 w-20 rounded-lg object-cover bg-bambu-dark-secondary'}
    />
  );
}

function scanStatusLabel(
  part: PartImageIdentity,
  t: ReturnType<typeof useTranslation>['t'],
) {
  if (part.archived_at) return t('floor.inventoryStatusArchived', 'Archived');
  switch (part.latest_event_action) {
    case 'fit_check':
    case 'fit_checked':
      return t('floor.inventoryStatusFitCheckPass', 'Fit Check Pass');
    case 'rework':
    case 'sanding':
      return t('floor.inventoryStatusRework', 'Rework');
    case 'discarded':
      return t('floor.inventoryStatusDiscarded', 'Discarded');
    case 'cleanup':
    case 'cleaned_up':
      return t('floor.inventoryStatusCleanupPass', 'Cleanup Pass');
    case 'wip':
    case 'in_wip':
      return t('floor.inventoryStatusWip', 'In WIP');
    case 'shipped':
      return t('floor.inventoryStatusShipped', 'Shipped');
    default:
      return t('floor.inventoryStatusLinked', 'Linked');
  }
}

function scanStatusClass(part: PartImageIdentity) {
  if (part.archived_at) return 'text-bambu-gray';
  switch (part.latest_event_action) {
    case 'fit_check':
    case 'fit_checked':
      return 'text-green-600 dark:text-green-400';
    case 'rework':
    case 'sanding':
      return 'text-orange-600 dark:text-orange-400';
    case 'discarded':
      return 'text-red-600 dark:text-red-400';
    case 'cleanup':
    case 'cleaned_up':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'wip':
    case 'in_wip':
      return 'text-amber-600 dark:text-amber-400';
    case 'shipped':
      return 'text-sky-600 dark:text-sky-400';
    default:
      return 'text-cyan-600 dark:text-cyan-400';
  }
}

function PartSourceLabel({ part, t }: { part: PartImageIdentity | null; t: ReturnType<typeof useTranslation>['t'] }) {
  if (!part || (!part.part_code && !part.part_name && !part.printer_name && !part.printer_id)) return null;
  return (
    <div className="mb-3 text-center">
      {(part.part_code || part.part_name) && (
        <p className="text-xl font-semibold text-white">
          {[part.part_code, part.part_name].filter(Boolean).join(' · ')}
        </p>
      )}
      {(part.part_source || part.printer_name || part.printer_id) && (
        <p className="mt-1 text-lg text-bambu-gray">
          From {[part.part_source, part.printer_name ?? (part.printer_id ? `Printer ${part.printer_id}` : null)]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {part.labeled_at && (
        <p className="mt-1 text-base text-bambu-gray">
          Registered {formatFloorDate(part.labeled_at, { year: 'numeric', month: '2-digit', day: '2-digit' })}
        </p>
      )}
      {part && (
        <p className={`mt-1 text-base font-medium ${scanStatusClass(part)}`}>
          {scanStatusLabel(part, t)}
        </p>
      )}
    </div>
  );
}

/** The printer info page (§5.6) — what this machine is doing, and whether it
 *  needs anything, for an operator already standing in front of it.
 *
 *  Denser than the rest of the scan page on purpose: this one is read, not
 *  glanced at. It persists until dismissed or another scan replaces it,
 *  because timing it out would yank away something being read. */
function PrinterInfoPanel({
  info,
  feedback,
  onDismiss,
  t,
}: {
  info: FloorPrinterInfo;
  /** The last `BBD-` scan made from this page (§5.6 entry #2), if any and
   *  still within its flash window. */
  feedback: PartFeedback | null;
  onDismiss: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const last = info.last_print;
  const live = info.live;
  const isPrinting = live?.connected === true && live.state === 'RUNNING';
  const feedbackMsg = feedback ? partFeedbackMessage(feedback, t) : null;

  // A finished job still on the bed is exactly "there is something here to
  // harvest", so it leads rather than sitting among the stats.
  //
  // Suppressed while the machine is actually running: `awaiting_plate_clear`
  // should already be false during a print, but if the flag ever goes stale
  // the screen would tell an operator to clear a bed mid-print. Live state
  // wins over a stored flag when the two disagree.
  const readyToHarvest =
    info.awaiting_plate_clear && last !== null && !last.has_labeled_parts && !isPrinting;

  return (
    <div className="w-full max-w-2xl text-left">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <p className="text-4xl font-bold text-white truncate">{info.name}</p>
          <p className="text-bambu-gray mt-1">
            {[info.model, info.location].filter(Boolean).join(' · ') || info.serial_number}
          </p>
        </div>
        <Printer className="w-10 h-10 text-bambu-green flex-shrink-0" aria-hidden="true" />
      </div>

      {/* Status leads: standing at a machine, "is this running" is the first
          question, before anything historical. */}
      <div className="mb-4 flex items-center gap-3">
        <StatusDot live={live} />
        <div className="min-w-0">
          <p className="text-white font-medium">{liveStatusLabel(live, t)}</p>
          {isPrinting && live && (
            <p className="text-sm text-bambu-gray truncate">
              {live.current_print ?? t('floor.printerUnnamedJob', 'Unnamed job')}
              {live.total_layers > 0 && ` · ${live.layer_num}/${live.total_layers}`}
              {live.remaining_minutes > 0 &&
                ` · ${t('floor.printerRemaining', '{{min}} min left', {
                  min: live.remaining_minutes,
                })}`}
            </p>
          )}
        </div>
        {isPrinting && live && (
          <span className="ml-auto text-2xl font-bold text-bambu-green tabular-nums">
            {Math.round(live.progress)}%
          </span>
        )}
      </div>

      {/* A part scan made from this page binds normally (§5.6) — this is
          that scan's result, overlaid here rather than replacing the page,
          because the operator is standing at this same printer either way. */}
      {feedbackMsg && (
        <div
          className={`mb-4 flex items-center gap-3 rounded-lg border px-4 py-3 ${
            feedbackMsg.tone === 'positive'
              ? 'border-bambu-green/40 bg-bambu-green/10'
              : 'border-bambu-dark-tertiary bg-bambu-dark-secondary'
          }`}
        >
          <PartCodeThumbnail partCode={feedback?.part?.part_code} sectionPartId={feedback?.part?.section_part_id} className="h-12 w-12 shrink-0 rounded object-cover bg-bambu-dark" />
          <p className={feedbackMsg.tone === 'positive' ? 'text-bambu-green font-semibold' : 'text-white font-semibold'}>
            {feedbackMsg.text}
          </p>
        </div>
      )}

      {readyToHarvest && (
        <div className="mb-4 rounded-lg border border-bambu-green/40 bg-bambu-green/10 px-4 py-3">
          <p className="text-bambu-green font-semibold">
            {t('floor.printerReadyToHarvest', 'Bed ready to clear')}
          </p>
          <p className="text-sm text-bambu-gray-light mt-0.5">
            {t('floor.printerReadyToHarvestHint', 'Scan part stickers to label this job.')}
          </p>
        </div>
      )}

      <dl className="space-y-3">
        <div className="flex items-baseline justify-between gap-4 border-b border-bambu-dark-secondary pb-3">
          <dt className="text-bambu-gray">{t('floor.printerLastPrint', 'Last finished print')}</dt>
          <dd className="text-white text-right min-w-0">
            {last ? (
              <>
                <span className="font-medium break-words">
                  {last.print_name ?? t('floor.printerUnnamedJob', 'Unnamed job')}
                </span>
                {last.quantity > 1 && (
                  <span className="text-bambu-gray"> × {last.quantity}</span>
                )}
                {last.completed_at && (
                  <span className="block text-sm text-bambu-gray">
                    {formatFloorDate(last.completed_at)}
                  </span>
                )}
              </>
            ) : (
              // Not a dead end (§7.2): a part scanned here is still recorded
              // against the printer and the time, with no job attached.
              <span className="text-bambu-gray">
                {t('floor.printerNoFinishedJob', 'Nothing finished to label')}
              </span>
            )}
          </dd>
        </div>

        <div className="flex items-baseline justify-between gap-4 border-b border-bambu-dark-secondary pb-3">
          <dt className="text-bambu-gray">{t('floor.printerTotalHours', 'Total print hours')}</dt>
          <dd className="text-white font-medium">{info.total_print_hours.toFixed(1)}</dd>
        </div>

        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-bambu-gray">{t('floor.printerMaintenance', 'Maintenance')}</dt>
          <dd className="text-right">
            {info.maintenance_due_count > 0 ? (
              <span className="text-red-500 font-medium">
                {t('floor.printerMaintenanceDue', '{{count}} due', {
                  count: info.maintenance_due_count,
                })}
              </span>
            ) : info.maintenance_warning_count > 0 ? (
              <span className="text-amber-500 font-medium">
                {t('floor.printerMaintenanceSoon', '{{count}} due soon', {
                  count: info.maintenance_warning_count,
                })}
              </span>
            ) : (
              <span className="text-bambu-gray">
                {t('floor.printerMaintenanceOk', 'Nothing due')}
              </span>
            )}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={onDismiss}
        className="mt-8 px-4 py-2 text-sm rounded-lg bg-bambu-dark-secondary text-bambu-gray hover:text-white transition-colors"
      >
        {t('floor.printerDismiss', 'Done')}
      </button>
    </div>
  );
}

function LockedPrompt({
  stationName,
  blocking,
  busy,
  onTakeover,
  t,
}: {
  stationName: string;
  blocking: FloorSession;
  busy: boolean;
  onTakeover: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <>
      <Lock className="w-16 h-16 mb-6 text-amber-500" aria-hidden="true" />
      <p className="text-3xl font-bold text-amber-500">
        {t('floor.scanLocked', '{{station}} is open elsewhere', { station: stationName })}
      </p>
      {/* Elapsed time is the whole basis for the decision: 3m means someone is
          mid-task, 14h means the session was abandoned overnight. */}
      <p className="mt-3 text-lg text-bambu-gray">
        {t('floor.scanLockedFor', 'Open for {{elapsed}} on another device', {
          elapsed: formatElapsed(blocking.open_seconds),
        })}
      </p>
      <button
        type="button"
        onClick={onTakeover}
        disabled={busy}
        className="mt-6 px-5 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="w-4 h-4 animate-spin inline" />
        ) : (
          t('floor.scanTakeover', 'Take over')
        )}
      </button>
      <p className="mt-4 text-sm text-bambu-gray max-w-md">
        {t(
          'floor.scanTakeoverHint',
          'Taking over closes the other session. Anything it had queued is discarded.',
        )}
      </p>
    </>
  );
}

/** The lean harvest screen (§5.4): printer name, the elapsed indicator,
 *  running part count, and the plate's job. Nothing else, on purpose — this
 *  is repetitive gloved work at a machine, not a screen to read closely.
 *
 *  Two flavors depending on whether a plate is bound yet: before the first
 *  printer scan there is nothing to show but the session itself and a
 *  prompt, same shape as any other open station; after it, the printer name
 *  takes over as the loudest thing on screen (§5.4's own wording — "after
 *  printer scan: printer name"), since confirming *which* printer is being
 *  cleared matters more than the station name once that much is settled. */
function HarvestScreen({
  session,
  plate,
  feedback,
  elapsedSeconds,
  busy,
  onClose,
  t,
}: {
  session: FloorSession;
  plate: HarvestPlate;
  /** The last `BBD-` scan made from this screen, if any and still within its
   *  flash window. */
  feedback: PartFeedback | null;
  elapsedSeconds: number;
  busy: boolean;
  onClose: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const feedbackMsg = feedback ? partFeedbackMessage(feedback, t) : null;

  return (
    <div className="w-full max-w-xl">
      <ScanLine className="w-14 h-14 mb-6 mx-auto text-bambu-green" aria-hidden="true" />

      {plate ? (
        <>
          <p className="text-5xl font-bold text-white truncate">{plate.printer.name}</p>
          <p className="mt-2 text-lg text-bambu-gray">
            {t('floor.scanOpenFor', 'Open for {{elapsed}}', { elapsed: formatElapsed(elapsedSeconds) })}
          </p>

          {/* The running count is the number an operator glances at
              repeatedly while clearing a bed — biggest text on the screen. */}
          <p className="mt-10 text-7xl font-bold text-bambu-green tabular-nums">{plate.partCount}</p>
          <p className="text-bambu-gray mt-1">{t('floor.harvestPartCount', 'parts labeled')}</p>

          <p className="mt-8 text-2xl font-medium">
            {plate.archive ? (
              <span className="text-white">
                {plate.archive.print_name ?? t('floor.printerUnnamedJob', 'Unnamed job')}
              </span>
            ) : (
              // Not an error (§7.2): the sticker is on the part either way,
              // and this plate's parts are still being recorded.
              <span className="text-bambu-gray">
                {t('floor.harvestNoJobLine', 'No job found for this printer')}
              </span>
            )}
          </p>
        </>
      ) : (
        <>
          <p className="text-5xl font-bold text-bambu-green">{session.station_name}</p>
          <p className="mt-3 text-lg text-bambu-gray">
            {t('floor.scanOpenFor', 'Open for {{elapsed}}', { elapsed: formatElapsed(elapsedSeconds) })}
          </p>
          <p className="mt-10 text-2xl text-bambu-gray">
            {t('floor.harvestScanPrinter', 'Scan the printer to begin')}
          </p>
        </>
      )}

      {feedbackMsg && (
        <div className="mt-8 flex flex-col items-center gap-2">
          <PartCodeThumbnail partCode={feedback?.part?.part_code} sectionPartId={feedback?.part?.section_part_id} />
          <p
            className={`text-lg ${
              feedbackMsg.tone === 'positive' ? 'text-bambu-green' : 'text-bambu-gray-light'
            }`}
          >
            {feedbackMsg.text}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={onClose}
        disabled={busy}
        className="mt-10 px-4 py-2 text-sm rounded-lg bg-bambu-dark-secondary text-bambu-gray hover:text-white transition-colors disabled:opacity-50"
      >
        {t('floor.scanClose', 'Close station')}
      </button>
    </div>
  );
}

/** First half of scan-part-then-location, done (§5.4a/§5.4b): a part is
 *  pending, waiting for its location. No lookup here — the sticker code is
 *  shown verbatim rather than fetched, keeping this the same "no premature
 *  validation" shape as the rest of the scan page. Persists rather than
 *  flashing: it is itself a prompt, abandoned only by scanning something
 *  else (handled generically — see `handleScan`'s `part-scanned` branch). */
function AwaitingLocationScreen({
  payload,
  part,
  t,
}: {
  payload: string;
  part: PartImageIdentity | null;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <>
      <ScanLine className="w-16 h-16 mb-6 text-bambu-green" aria-hidden="true" />
      <PartCodeThumbnail partCode={part?.part_code} sectionPartId={part?.section_part_id} className="mb-4 h-48 w-48 rounded-xl object-cover bg-bambu-dark-secondary" />
      <PartSourceLabel part={part} t={t} />
      <p className="text-3xl font-bold text-white font-mono">{payload}</p>
      <p className="mt-3 text-2xl text-bambu-gray">
        {t('floor.locationScanLocation', 'Scan a location')}
      </p>
    </>
  );
}

/** Second half of Rework's flow: the part's location was Rework (a pure
 *  UI transition, no server call — §5.4b), now waiting for the reason that
 *  actually commits it. */
function AwaitingReworkReasonScreen({
  payload,
  part,
  t,
}: {
  payload: string;
  part: PartImageIdentity | null;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <>
      <ScanLine className="w-16 h-16 mb-6 text-orange-500" aria-hidden="true" />
      <PartCodeThumbnail partCode={part?.part_code} sectionPartId={part?.section_part_id} className="mb-4 h-48 w-48 rounded-xl object-cover bg-bambu-dark-secondary" />
      <PartSourceLabel part={part} t={t} />
      <p className="text-3xl font-bold text-white font-mono">{payload}</p>
      <p className="mt-1 text-lg text-orange-500">{t('floor.locationRework', 'Rework')}</p>
      <p className="mt-3 text-2xl text-orange-500">{t('floor.reworkScanReason', 'Scan an error label')}</p>
    </>
  );
}

function AwaitingDiscardReasonScreen({ payload, part, t }: { payload: string; part: PartImageIdentity | null; t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <>
      <ScanLine className="w-16 h-16 mb-6 text-red-500" aria-hidden="true" />
      <PartCodeThumbnail partCode={part?.part_code} sectionPartId={part?.section_part_id} className="mb-4 h-48 w-48 rounded-xl object-cover bg-bambu-dark-secondary" />
      <PartSourceLabel part={part} t={t} />
      <p className="text-3xl font-bold text-white font-mono">{payload}</p>
      <p className="mt-1 text-lg text-bambu-gray">{t('floor.discard', 'Discard')}</p>
      <p className="mt-3 text-2xl text-bambu-gray">{t('floor.discardScanReason', 'Scan an error label')}</p>
    </>
  );
}

function AwaitingCustomReasonScreen({
  payload,
  part,
  locationSlug,
  t,
  onDraftChange,
  onSubmit,
}: {
  payload: string;
  part: PartImageIdentity | null;
  locationSlug: 'rework' | 'discard';
  t: ReturnType<typeof useTranslation>['t'];
  onDraftChange: (reasonText: string) => void;
  onSubmit: (reasonText: string | null) => void;
}) {
  const [description, setDescription] = useState('');
  const [showDescription, setShowDescription] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(10);
  const descriptionRef = useRef('');
  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSecondsRemaining((seconds) => {
        if (seconds <= 1) {
          window.clearInterval(timer);
          onSubmitRef.current(descriptionRef.current.trim() || null);
          return 0;
        }
        return seconds - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const accent = locationSlug === 'discard' ? 'text-red-500' : 'text-orange-500';

  return (
    <>
      <ScanLine className={`w-16 h-16 mb-6 ${accent}`} aria-hidden="true" />
      <PartCodeThumbnail partCode={part?.part_code} sectionPartId={part?.section_part_id} className="mb-4 h-48 w-48 rounded-xl object-cover bg-bambu-dark-secondary" />
      <PartSourceLabel part={part} t={t} />
      <p className="text-3xl font-bold text-white font-mono">{payload}</p>
      <p className={`mt-1 text-lg ${accent}`}>
        {locationSlug === 'discard' ? t('floor.discard', 'Discard') : t('floor.locationRework', 'Rework')}
      </p>
      <p className={`mt-3 text-2xl ${accent}`}>
        {t('floor.otherReasonSelected', 'Other reason selected')}
      </p>
      {showDescription && (
        <input
          autoFocus
          value={description}
          onChange={(event) => {
            const value = event.target.value.slice(0, 120);
            descriptionRef.current = value;
            setDescription(value);
            onDraftChange(value);
          }}
          placeholder={t('floor.otherReasonPlaceholder', 'Short description (optional)')}
          maxLength={120}
          className="mt-4 w-72 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-2 text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
        />
      )}
      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setShowDescription((visible) => !visible)}
          className="rounded-lg bg-bambu-dark-secondary px-4 py-2 text-sm text-bambu-gray-light transition-colors hover:text-white"
        >
          {showDescription
            ? t('floor.otherReasonHideDescription', 'Hide description')
            : t('floor.otherReasonAddDescription', 'Add short description')}
        </button>
        <span className="text-sm text-bambu-gray">
          {t('floor.otherReasonAutoContinue', 'Continuing in {{seconds}}s', { seconds: secondsRemaining })}
        </span>
      </div>
    </>
  );
}

/** Brief confirmation after Fit Check or Rework commits (§5.4a/§5.4b),
 *  before the screen returns to idle — same timing as `PlateClosedFlash`. */
function LocationRecordedFlash({
  locationSlug,
  part,
  printer,
  archive,
  reasonCode,
  t,
}: {
  locationSlug: 'fit-check' | 'rework' | 'discard';
  part: FloorLabeledPart | null;
  printer: FloorPlatePrinter | null;
  archive: FloorPlateArchive | null;
  reasonCode?: string;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <>
      <ScanLine
        className={`w-16 h-16 mb-6 ${locationSlug === 'discard' ? 'text-red-500' : locationSlug === 'rework' ? 'text-orange-500' : 'text-bambu-green'}`}
        aria-hidden="true"
      />
      <PartCodeThumbnail partCode={part?.part_code} sectionPartId={part?.section_part_id} className="mb-4 h-20 w-20 rounded-lg object-cover bg-bambu-dark-secondary" />
      <p className="text-4xl font-bold text-white font-mono">{part?.sticker_code ?? ''}</p>
      <p className="mt-2 text-lg text-bambu-gray">
        {[printer?.name, archive?.print_name ?? (printer ? t('floor.printerUnnamedJob', 'Unnamed job') : null)]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <p className={`mt-3 text-lg ${locationSlug === 'discard' ? 'text-red-500' : locationSlug === 'rework' ? 'text-orange-500' : 'text-bambu-green'}`}>
        {locationSlug === 'fit-check'
          ? t('floor.fitCheckRecorded', 'Checked')
          : locationSlug === 'discard'
            ? t('floor.discardRecorded', 'Discarded')
            : reasonCode
              ? t('floor.reworkRecorded', 'Sent to Rework · {{reason}}', { reason: reasonCode })
              : t('floor.reworkRecordedWithoutReason', 'Sent to Rework')}
      </p>
    </>
  );
}

/** Brief confirmation of the plate that just closed (re-scanning the same
 *  printer under Harvest, §5.4) before the screen returns to the harvest
 *  idle state. Plate close is not session close, so this never touches
 *  `session` — only the plate's own printer/archive/count, which are about
 *  to be cleared from local state regardless. */
function PlateClosedFlash({
  printer,
  archive,
  partCount,
  t,
}: {
  printer: FloorPlatePrinter;
  archive: FloorPlateArchive | null;
  partCount: number;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <>
      <ScanLine className="w-16 h-16 mb-6 text-bambu-green" aria-hidden="true" />
      <p className="text-4xl font-bold text-white">{printer.name}</p>
      <p className="mt-2 text-lg text-bambu-gray">
        {archive?.print_name ?? t('floor.printerUnnamedJob', 'Unnamed job')}
      </p>
      <p className="mt-3 text-lg text-bambu-green">
        {t('floor.harvestPlateClosed', 'Plate closed · {{count}} parts', { count: partCount })}
      </p>
    </>
  );
}

export default FloorScanPage;
