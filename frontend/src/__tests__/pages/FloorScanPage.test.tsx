import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { FloorScanPage } from '../../pages/FloorScanPage';
import { server } from '../mocks/server';
import * as floorSound from '../../utils/floorSound';

const WIP_SESSION = {
  id: 1,
  station_slug: 'wip',
  station_name: 'WIP',
  device_id: 'this-device',
  opened_at: '2026-08-24T10:00:00',
  open_seconds: 0,
};

/** No session on load — the common case at the start of a shift. */
function mockNoSession() {
  server.use(http.get('/api/v1/floor/session', () => HttpResponse.json(null)));
}

/** Captures the scan POST body so tests can assert what was actually sent. */
function mockScan(response: unknown, status = 200) {
  const captured: { body: Record<string, unknown> | null } = { body: null };
  server.use(
    http.post('/api/v1/floor/session/scan', async ({ request }) => {
      captured.body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(response, { status });
    }),
  );
  return captured;
}

async function scan(text: string) {
  const input = screen.getByLabelText('Scan field');
  // fireEvent, not userEvent: a pistol dispatches the whole scan with no yield
  // between the last keystroke and Enter, which is the race the page's ref
  // handling exists for.
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('FloorScanPage (Phase 1b sessions)', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    vi.mocked(localStorage.setItem).mockReset();
    // jsdom has no WebAudio; the util degrades silently, but spying keeps the
    // assertions about *when* a tone fires honest.
    vi.spyOn(floorSound, 'playScanErrorTone').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resuming a session', () => {
    it('shows the idle prompt when this device holds nothing', async () => {
      mockNoSession();
      render(<FloorScanPage />);

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
      expect(screen.getByLabelText('Scan field')).toHaveFocus();
    });

    it('resumes an already-open station after a reload', async () => {
      // The session lives server-side precisely so an accidental F5 does not
      // strand an open station nobody can see (§2.4).
      server.use(
        http.get('/api/v1/floor/session', () =>
          HttpResponse.json({ ...WIP_SESSION, open_seconds: 4500 }),
        ),
      );
      render(<FloorScanPage />);

      expect(await screen.findByText('WIP')).toBeInTheDocument();
      expect(screen.getByText('Open for 1h 15m')).toBeInTheDocument();
    });

    it('falls back to idle when the session lookup fails', async () => {
      // Rescanning the station QR is one action away, so a failed resume is
      // not worth an error screen.
      server.use(
        http.get('/api/v1/floor/session', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })),
      );
      render(<FloorScanPage />);

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
    });
  });

  describe('opening, closing and switching', () => {
    it('opens a station and shows it prominently with elapsed time', async () => {
      mockNoSession();
      const captured = mockScan({
        result: 'opened',
        station_slug: 'wip',
        station_name: 'WIP',
        session: WIP_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(await screen.findByText('WIP')).toBeInTheDocument();
      expect(screen.getByText('Open for 0s')).toBeInTheDocument();
      // The payload is round-tripped, not a slug derived client-side.
      expect(captured.body).toMatchObject({ payload: 'BBS-wip' });
      expect(captured.body?.device_id).toBeTruthy();
    });

    it('counts up second by second while under a minute', async () => {
      // The point of second-granularity: an operator can see the screen is
      // live rather than frozen. A 15s tick would jump 0s → 15s and look
      // stuck in between.
      mockNoSession();
      mockScan({
        result: 'opened',
        station_slug: 'wip',
        station_name: 'WIP',
        session: WIP_SESSION,
        blocking: null,
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBS-wip');
        await screen.findByText('Open for 0s');

        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(screen.getByText('Open for 1s')).toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(2000);
        });
        expect(screen.getByText('Open for 3s')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('switches to minutes once past the first minute', async () => {
      mockNoSession();
      mockScan({
        result: 'opened',
        station_slug: 'wip',
        station_name: 'WIP',
        // Opened 58s ago, so the boundary is two ticks away.
        session: { ...WIP_SESSION, open_seconds: 58 },
        blocking: null,
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBS-wip');
        await screen.findByText('Open for 58s');

        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(screen.getByText('Open for 59s')).toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(screen.getByText('Open for 1m')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('confirms a close and returns to idle', async () => {
      mockNoSession();
      mockScan({
        result: 'closed',
        station_slug: 'wip',
        station_name: 'WIP',
        session: null,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(await screen.findByText('WIP closed')).toBeInTheDocument();
    });

    it('shows the new station after a switch', async () => {
      mockNoSession();
      mockScan({
        result: 'switched',
        station_slug: 'storage-receive',
        station_name: '+ Storage',
        session: { ...WIP_SESSION, id: 2, station_slug: 'storage-receive', station_name: '+ Storage' },
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-storage-receive');

      expect(await screen.findByText('+ Storage')).toBeInTheDocument();
    });

    it('closes the session from the on-screen control', async () => {
      server.use(
        http.get('/api/v1/floor/session', () => HttpResponse.json(WIP_SESSION)),
        http.delete('/api/v1/floor/session', () => HttpResponse.json(WIP_SESSION)),
      );
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('WIP');

      await user.click(screen.getByRole('button', { name: 'Close station' }));

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
    });
  });

  describe('a station held by another device', () => {
    const lockedResponse = {
      result: 'locked',
      station_slug: 'wip',
      station_name: 'WIP',
      session: null,
      blocking: { ...WIP_SESSION, device_id: 'other-device', open_seconds: 50400 },
    };

    it('refuses with the holder and elapsed time, and offers takeover', async () => {
      mockNoSession();
      mockScan(lockedResponse);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(await screen.findByText('WIP is open elsewhere')).toBeInTheDocument();
      // Elapsed time is the whole basis for the decision: 14h reads as
      // abandoned overnight, where 3m would read as someone mid-task.
      expect(screen.getByText('Open for 14h 0m on another device')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take over' })).toBeEnabled();
    });

    it('rings the error tone, since the refusal may happen out of sight', async () => {
      mockNoSession();
      mockScan(lockedResponse);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      await screen.findByText('WIP is open elsewhere');
      expect(floorSound.playScanErrorTone).toHaveBeenCalled();
    });

    it('takes the station over and opens it here', async () => {
      mockNoSession();
      mockScan(lockedResponse);
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/session/takeover', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            result: 'opened',
            station_slug: 'wip',
            station_name: 'WIP',
            session: WIP_SESSION,
            blocking: null,
          });
        }),
      );
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');
      await user.click(await screen.findByRole('button', { name: 'Take over' }));

      expect(await screen.findByText('Open for 0s')).toBeInTheDocument();
      expect(captured.body).toMatchObject({ payload: 'BBS-wip' });
    });

    it('warns that taking over discards the other session', async () => {
      mockNoSession();
      mockScan(lockedResponse);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(await screen.findByText(/closes the other session/)).toBeInTheDocument();
    });
  });

  describe('scans the app cannot use', () => {
    it('reports an unrecognised code as unknown', async () => {
      mockNoSession();
      mockScan({ detail: 'Not a station code: BBS-nope' }, 404);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-nope');

      expect(await screen.findByText('Unknown code')).toBeInTheDocument();
      expect(screen.getByText('BBS-nope')).toBeInTheDocument();
      expect(floorSound.playScanErrorTone).toHaveBeenCalled();
    });

    it('distinguishes a recognised prefix whose phase has not shipped', async () => {
      // "Not built yet" and "that code means nothing" send an operator to
      // different places, so they must not render identically (§4).
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBD-000042');

      expect(await screen.findByText('Not handled yet')).toBeInTheDocument();
      expect(screen.getByText('BBD-000042')).toBeInTheDocument();
    });

    it.each([
      ['BBD-000042', 'part'],
      ['BBF-warping', 'defect'],
      ['BBX-rework', 'command'],
      ['4001234567890', 'factory SKU'],
    ])('treats %s (%s) as not-yet-handled rather than unknown', async (payload) => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan(payload);

      expect(await screen.findByText('Not handled yet')).toBeInTheDocument();
    });

    it('ignores a bare Enter with no scanned content', async () => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      fireEvent.keyDown(screen.getByLabelText('Scan field'), { key: 'Enter' });

      expect(screen.getByText('Scan a code')).toBeInTheDocument();
    });

    it('surfaces a real backend failure without blaming the label', async () => {
      mockNoSession();
      mockScan({ detail: 'database is on fire' }, 500);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(await screen.findByText('Scan failed')).toBeInTheDocument();
    });
  });

  describe('scanning a printer from idle (info page, §5.6)', () => {
    const INFO = {
      id: 12,
      payload: 'BBP-12',
      name: 'Bench A',
      model: 'X1C',
      location: 'Line 1',
      serial_number: '00M09A000000001',
      is_active: true,
      awaiting_plate_clear: true,
      total_print_hours: 412.6,
      last_print: {
        archive_id: 88,
        print_name: 'Bracket v3',
        completed_at: '2026-08-24T14:32:00',
        quantity: 6,
        has_labeled_parts: false,
      },
      maintenance_due_count: 0,
      maintenance_warning_count: 0,
      live: {
        connected: true,
        state: 'IDLE',
        current_print: null,
        progress: 0,
        remaining_minutes: 0,
        layer_num: 0,
        total_layers: 0,
      },
    };

    function mockInfo(overrides: Record<string, unknown> = {}) {
      server.use(
        http.get('/api/v1/floor/printers/:payload/info', () =>
          HttpResponse.json({ ...INFO, ...overrides }),
        ),
      );
    }

    it('shows the printer, its last finished job and its hours', async () => {
      mockNoSession();
      mockInfo();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Bench A')).toBeInTheDocument();
      expect(screen.getByText(/Bracket v3/)).toBeInTheDocument();
      expect(screen.getByText('412.6')).toBeInTheDocument();
      expect(screen.getByText('X1C · Line 1')).toBeInTheDocument();
    });

    it('leads with the harvest prompt when a finished job is still on the bed', async () => {
      mockNoSession();
      mockInfo();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Bed ready to clear')).toBeInTheDocument();
    });

    it('does not prompt to harvest a job whose parts are already labeled', async () => {
      mockNoSession();
      mockInfo({ last_print: { ...INFO.last_print, has_labeled_parts: true } });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      await screen.findByText('Bench A');
      expect(screen.queryByText('Bed ready to clear')).not.toBeInTheDocument();
    });

    it('says plainly when there is nothing finished to label', async () => {
      mockNoSession();
      mockInfo({ last_print: null, awaiting_plate_clear: false });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Nothing finished to label')).toBeInTheDocument();
    });

    it('surfaces overdue maintenance', async () => {
      mockNoSession();
      mockInfo({ maintenance_due_count: 2 });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('2 due')).toBeInTheDocument();
    });

    it('distinguishes due-soon from overdue', async () => {
      mockNoSession();
      mockInfo({ maintenance_due_count: 0, maintenance_warning_count: 1 });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('1 due soon')).toBeInTheDocument();
    });

    it('takes no session, so looking does not lock the printer', async () => {
      // §5.6: the harvest lock is claimed on the first part scan, not on
      // merely viewing — otherwise routine lookups would block bed-clearing.
      mockNoSession();
      mockInfo();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');
      await screen.findByText('Bench A');

      expect(screen.queryByRole('button', { name: 'Close station' })).not.toBeInTheDocument();
    });

    it('stays up instead of timing out, since it is being read', async () => {
      mockNoSession();
      mockInfo();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBP-12');
      await screen.findByText('Bench A');

      vi.useFakeTimers({ shouldAdvanceTime: true });
      act(() => {
        vi.advanceTimersByTime(30000);
      });
      vi.useRealTimers();

      expect(screen.getByText('Bench A')).toBeInTheDocument();
    });

    it('returns to idle when dismissed', async () => {
      mockNoSession();
      mockInfo();
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBP-12');

      await user.click(await screen.findByRole('button', { name: 'Done' }));

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
    });

    it('leads with the live status', async () => {
      // Standing at a machine, "is this running" is the first question.
      mockNoSession();
      mockInfo();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Idle')).toBeInTheDocument();
    });

    it('shows progress, job, layers and time left while printing', async () => {
      mockNoSession();
      mockInfo({
        live: {
          connected: true,
          state: 'RUNNING',
          current_print: 'Bracket v3',
          progress: 42.4,
          remaining_minutes: 37,
          layer_num: 120,
          total_layers: 300,
        },
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Printing')).toBeInTheDocument();
      expect(screen.getByText('42%')).toBeInTheDocument();
      expect(screen.getByText(/120\/300/)).toBeInTheDocument();
      expect(screen.getByText(/37 min left/)).toBeInTheDocument();
    });

    it.each([
      ['PAUSE', 'Paused'],
      ['FINISH', 'Finished'],
      ['FAILED', 'Failed'],
      ['PREPARE', 'Preparing'],
      ['SLICING', 'Slicing'],
      ['unknown', 'Waiting for status'],
    ])('labels the %s state as %s', async (state, label) => {
      mockNoSession();
      mockInfo({
        live: {
          connected: true,
          state,
          current_print: null,
          progress: 0,
          remaining_minutes: 0,
          layer_num: 0,
          total_layers: 0,
        },
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText(label)).toBeInTheDocument();
    });

    it('shows an unrecognised state verbatim rather than mislabelling it', async () => {
      // A state we have not mapped is better shown raw than called "idle".
      mockNoSession();
      mockInfo({
        live: {
          connected: true,
          state: 'CALIBRATING',
          current_print: null,
          progress: 0,
          remaining_minutes: 0,
          layer_num: 0,
          total_layers: 0,
        },
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('CALIBRATING')).toBeInTheDocument();
    });

    it('says not connected when the printer is unreachable', async () => {
      mockNoSession();
      mockInfo({
        live: {
          connected: false,
          state: 'unknown',
          current_print: null,
          progress: 0,
          remaining_minutes: 0,
          layer_num: 0,
          total_layers: 0,
        },
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Not connected')).toBeInTheDocument();
    });

    it('distinguishes no-status-at-all from not-connected', async () => {
      // live === null means we have no client for it, which is a different
      // fact from "we know it and it is unreachable".
      mockNoSession();
      mockInfo({ live: null });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Status unavailable')).toBeInTheDocument();
    });

    it('still renders the rest of the panel without live status', async () => {
      mockNoSession();
      mockInfo({ live: null });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Bench A')).toBeInTheDocument();
      expect(screen.getByText('412.6')).toBeInTheDocument();
    });

    it('does not tell an operator to clear a bed mid-print', async () => {
      // awaiting_plate_clear should already be false during a run, but a
      // stale flag must not produce a contradictory screen. Live state wins.
      mockNoSession();
      mockInfo({
        awaiting_plate_clear: true,
        live: {
          connected: true,
          state: 'RUNNING',
          current_print: 'Bracket v3',
          progress: 10,
          remaining_minutes: 90,
          layer_num: 30,
          total_layers: 300,
        },
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Printing')).toBeInTheDocument();
      expect(screen.queryByText('Bed ready to clear')).not.toBeInTheDocument();
    });

    it('reports an unknown printer as an unknown code', async () => {
      mockNoSession();
      server.use(
        http.get('/api/v1/floor/printers/:payload/info', () =>
          HttpResponse.json({ detail: 'Unknown printer code: BBP-999' }, { status: 404 }),
        ),
      );
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-999');

      expect(await screen.findByText('Unknown code')).toBeInTheDocument();
      expect(floorSound.playScanErrorTone).toHaveBeenCalled();
    });
  });

  describe('pistol input handling', () => {
    it('reads the just-typed value when Enter fires in the same tick', async () => {
      // A pistol fires characters and Enter with no yield between, before
      // React has re-rendered — the handler must read the ref, not a stale
      // state closure.
      mockNoSession();
      const captured = mockScan({
        result: 'opened',
        station_slug: 'wip',
        station_name: 'WIP',
        session: WIP_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      await waitFor(() => expect(captured.body).not.toBeNull());
      expect(captured.body).toMatchObject({ payload: 'BBS-wip' });
    });

    it('clears the field after each scan', async () => {
      mockNoSession();
      mockScan({
        result: 'opened',
        station_slug: 'wip',
        station_name: 'WIP',
        session: WIP_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(screen.getByLabelText('Scan field')).toHaveValue('');
    });

    it('keeps focus on the scan field after a click elsewhere', async () => {
      mockNoSession();
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      const input = screen.getByLabelText('Scan field');
      await user.click(document.body);

      await waitFor(() => expect(input).toHaveFocus());
    });
  });

  describe('transient message timing', () => {
    // Fake timers are installed *before* render, with shouldAdvanceTime so the
    // MSW round trips still resolve. Installing them afterwards would leave the
    // component's setTimeout scheduled on the real clock, and advancing the
    // fake one would prove nothing — the persistence test below would pass even
    // if `locked` wrongly auto-cleared.
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reverts an error to idle after a few seconds', async () => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBD-000042');
      expect(await screen.findByText('Not handled yet')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(screen.getByText('Scan a code')).toBeInTheDocument();
    });

    it('leaves the takeover prompt up instead of timing it out', async () => {
      // A refusal is a decision point, not a flash: timing it out would drop
      // the operator back to idle with the station still held elsewhere.
      mockNoSession();
      mockScan({
        result: 'locked',
        station_slug: 'wip',
        station_name: 'WIP',
        session: null,
        blocking: { ...WIP_SESSION, device_id: 'other', open_seconds: 600 },
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');
      expect(await screen.findByText('WIP is open elsewhere')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(30000);
      });

      expect(screen.getByText('WIP is open elsewhere')).toBeInTheDocument();
    });
  });
});
