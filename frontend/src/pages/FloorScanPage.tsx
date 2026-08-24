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
import { Loader2, Lock, ScanLine } from 'lucide-react';
import { api, type FloorSession } from '../api/client';
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
  | { kind: 'locked'; stationName: string; payload: string; blocking: FloorSession };

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

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

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
      failScan(t('floor.scanNotYetSupported', 'Not handled yet'), route.value);
    },
    [failScan, submitStationScan, t],
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

  const isError = status.kind === 'error';
  const isLocked = status.kind === 'locked';

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bambu-dark px-6 text-center">
      {/* z-50: above Layout's compact-mode mobile header (z-40) and desktop
          sidebar (z-30) — this page fully covers app chrome regardless of
          viewport width, matching the "sparse: sidebar collapsed or minimal"
          spec (docs/floor-plan.md §3.1). */}
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
