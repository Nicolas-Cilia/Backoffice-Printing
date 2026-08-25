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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock, Printer, ScanLine } from 'lucide-react';
import {
  api,
  type FloorLiveStatus,
  type FloorPrinterInfo,
  type FloorSession,
} from '../api/client';
import { getDeviceId } from '../utils/floorDevice';
import { playScanErrorTone } from '../utils/floorSound';
import { formatElapsed, routeScan } from '../utils/floorScan';

/** How long a transient message (error, "closed", "not yet") stays up before
 *  the screen returns to its resting state. */
const FLASH_MS = 3000;
/** The open-station elapsed counter only needs to be minute-accurate (§5.4),
 *  so it ticks slowly — a kiosk runs for days and this is pure display. */
const ELAPSED_TICK_MS = 15000;

type Status =
  | { kind: 'idle' }
  /** A scan the app could not use: unknown code, or a real code whose phase
   *  has not shipped. Both flash red and ring the error tone. */
  | { kind: 'error'; message: string; detail?: string }
  /** Station closed — brief confirmation before returning to idle. */
  | { kind: 'closed'; stationName: string }
  /** Station held by another device: the one status that waits for a decision
   *  instead of timing out. */
  | { kind: 'locked'; stationName: string; payload: string; blocking: FloorSession }
  /** A printer scanned with no station open — the info page (§5.6). Like
   *  `locked`, it persists rather than flashing: the operator is reading it. */
  | { kind: 'printer'; info: FloorPrinterInfo };

export function FloorScanPage() {
  const { t } = useTranslation();
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

  // The session state the Enter handler reads. Same reasoning as valueRef:
  // two scans in quick succession must not both act on the pre-first state.
  const sessionRef = useRef<FloorSession | null>(null);
  sessionRef.current = session;
  const busyRef = useRef(false);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // Always-focused scan field (§3.1): the pistol has no mode switch, so
  // whatever has focus IS the scan target.
  useEffect(() => {
    focusInput();
    const onWindowClick = () => focusInput();
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

  // `locked` is excluded on purpose: it is a prompt, not a flash, and must
  // stay put until the operator takes over or scans something else.
  useEffect(() => {
    if (status.kind !== 'error' && status.kind !== 'closed') return;
    const timer = window.setTimeout(() => setStatus({ kind: 'idle' }), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

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
        setStatus({ kind: 'closed', stationName: resp.station_name });
        return;
      }
      setSession(resp.session);
      setStatus({ kind: 'idle' });
    },
    [],
  );

  const submitStationScan = useCallback(
    async (payload: string) => {
      setBusy(true);
      busyRef.current = true;
      try {
        applyScanResponse(await api.scanFloorStation({ payload, device_id: deviceId }));
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

  const handleScan = useCallback(
    (scanned: string) => {
      // Drop scans fired while a request is in flight rather than queueing
      // them: a double-trigger on the same label would otherwise open and
      // immediately close the station.
      if (busyRef.current) return;

      const route = routeScan(scanned, sessionRef.current?.station_slug ?? null);
      if (route.action === 'ignore') return;
      if (route.action === 'station') {
        void submitStationScan(route.payload);
        return;
      }
      if (route.action === 'printer-info') {
        void submitPrinterScan(route.payload);
        return;
      }
      failScan(t('floor.scanNotYetSupported', 'Not handled yet'), route.value);
    },
    [failScan, submitStationScan, submitPrinterScan, t],
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
        <PrinterInfoPanel info={status.info} onDismiss={() => setStatus({ kind: 'idle' })} t={t} />
      ) : isLocked && status.kind === 'locked' ? (
        <LockedPrompt
          stationName={status.stationName}
          blocking={status.blocking}
          busy={busy}
          onTakeover={handleTakeover}
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

/** The printer info page (§5.6) — what this machine is doing, and whether it
 *  needs anything, for an operator already standing in front of it.
 *
 *  Denser than the rest of the scan page on purpose: this one is read, not
 *  glanced at. It persists until dismissed or another scan replaces it,
 *  because timing it out would yank away something being read. */
function PrinterInfoPanel({
  info,
  onDismiss,
  t,
}: {
  info: FloorPrinterInfo;
  onDismiss: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const last = info.last_print;
  const live = info.live;
  const isPrinting = live?.connected === true && live.state === 'RUNNING';

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
                    {new Date(last.completed_at).toLocaleString()}
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

export default FloorScanPage;
