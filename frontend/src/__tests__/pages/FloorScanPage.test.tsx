import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { FloorScanPage } from '../../pages/FloorScanPage';
import { server } from '../mocks/server';
import * as floorSound from '../../utils/floorSound';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const HARVEST_SESSION = {
  id: 1,
  station_slug: 'harvest',
  station_name: 'Harvest',
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

/** Simulates a wedge scanner when focus is not on the hidden scan input. */
function wedgeScanAtWindow(text: string) {
  for (const char of text) {
    fireEvent.keyDown(window, { key: char, bubbles: true, cancelable: true });
  }
  fireEvent.keyDown(window, { key: 'Enter', bubbles: true, cancelable: true });
}

describe('FloorScanPage (Phase 1b sessions)', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
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
          HttpResponse.json({ ...HARVEST_SESSION, open_seconds: 4500 }),
        ),
      );
      render(<FloorScanPage />);

      expect(await screen.findByText('Harvest')).toBeInTheDocument();
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
        station_slug: 'harvest',
        station_name: 'Harvest',
        session: HARVEST_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-harvest');

      expect(await screen.findByText('Harvest')).toBeInTheDocument();
      expect(screen.getByText('Open for 0s')).toBeInTheDocument();
      // The payload is round-tripped, not a slug derived client-side.
      expect(captured.body).toMatchObject({ payload: 'BBS-harvest' });
      expect(captured.body?.device_id).toBeTruthy();
    });

    it('counts up second by second while under a minute', async () => {
      // The point of second-granularity: an operator can see the screen is
      // live rather than frozen. A 15s tick would jump 0s → 15s and look
      // stuck in between.
      mockNoSession();
      mockScan({
        result: 'opened',
        station_slug: 'harvest',
        station_name: 'Harvest',
        session: HARVEST_SESSION,
        blocking: null,
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBS-harvest');
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
        station_slug: 'harvest',
        station_name: 'Harvest',
        // Opened 58s ago, so the boundary is two ticks away.
        session: { ...HARVEST_SESSION, open_seconds: 58 },
        blocking: null,
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBS-harvest');
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
        station_slug: 'harvest',
        station_name: 'Harvest',
        session: null,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-harvest');

      expect(await screen.findByText('Harvest closed')).toBeInTheDocument();
    });

    it('shows the new station after a switch', async () => {
      // Only Harvest is a session station today, but the page must still
      // honour a `switched` response for any BBS- code routed to the session
      // API (legacy labels like BBS-wip still classify as station client-side).
      server.use(
        http.get('/api/v1/floor/session', () => HttpResponse.json(HARVEST_SESSION)),
      );
      const captured = mockScan({
        result: 'switched',
        station_slug: 'fit-check',
        station_name: 'Initial QC Pass',
        session: { ...HARVEST_SESSION, id: 2, station_slug: 'fit-check', station_name: 'Initial QC Pass' },
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Harvest');

      await scan('BBS-wip');

      expect(await screen.findByText('Initial QC Pass')).toBeInTheDocument();
      expect(captured.body).toMatchObject({ payload: 'BBS-wip' });
    });

    it('closes the session from the on-screen control', async () => {
      server.use(
        http.get('/api/v1/floor/session', () => HttpResponse.json(HARVEST_SESSION)),
        http.delete('/api/v1/floor/session', () => HttpResponse.json(HARVEST_SESSION)),
      );
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Harvest');

      await user.click(screen.getByRole('button', { name: 'Close station' }));

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
    });
  });

  describe('a station held by another device', () => {
    const lockedResponse = {
      result: 'locked',
      station_slug: 'harvest',
      station_name: 'Harvest',
      session: null,
      blocking: { ...HARVEST_SESSION, device_id: 'other-device', open_seconds: 50400 },
    };

    it('refuses with the holder and elapsed time, and offers takeover', async () => {
      mockNoSession();
      mockScan(lockedResponse);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-harvest');

      expect(await screen.findByText('Harvest is open elsewhere')).toBeInTheDocument();
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

      await scan('BBS-harvest');

      await screen.findByText('Harvest is open elsewhere');
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
            station_slug: 'harvest',
            station_name: 'Harvest',
            session: HARVEST_SESSION,
            blocking: null,
          });
        }),
      );
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-harvest');
      await user.click(await screen.findByRole('button', { name: 'Take over' }));

      expect(await screen.findByText('Open for 0s')).toBeInTheDocument();
      expect(captured.body).toMatchObject({ payload: 'BBS-harvest' });
    });

    it('warns that taking over discards the other session', async () => {
      mockNoSession();
      mockScan(lockedResponse);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-harvest');

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
      // different places, so they must not render identically (§4). BBD- is
      // not used for this any more — phase 9a/9b gave it a meaning at idle
      // (see the "fit check and rework" describe block). BBF- is not used
      // for this either any more — it is now recognised (Rework/Discard's
      // error step, see below), just contextually rejected with nothing
      // pending. A factory SKU is still genuinely unimplemented.
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('4001234567890');

      expect(await screen.findByText('Not handled yet')).toBeInTheDocument();
      expect(screen.getByText('4001234567890')).toBeInTheDocument();
    });

    it.each([
      ['BBX-rework', 'command'],
      ['4001234567890', 'factory SKU'],
    ])('treats %s (%s) as not-yet-handled rather than unknown', async (payload) => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan(payload);

      expect(await screen.findByText('Not handled yet')).toBeInTheDocument();
    });

    it('asks for a part first when a defect code is scanned with nothing pending', async () => {
      // BBF- is recognised (it commits Rework's/Discard's error step), just
      // meaningless without a part already pending — a distinct message from
      // both "unknown" and the generic "not handled yet" (§4, §9).
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBF-warping');

      expect(await screen.findByText('Scan a part, then Rework or Discard first')).toBeInTheDocument();
      expect(screen.getByText('BBF-warping')).toBeInTheDocument();
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

      await scan('BBS-harvest');

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
      expect(screen.getByLabelText('Scan field')).toHaveFocus();
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

    it('offers and saves a reason for a recent stopped print', async () => {
      mockNoSession();
      mockInfo({
        recent_stopped_print: {
          print_log_id: 101,
          archive_id: 88,
          print_name: 'Bracket v3',
          part_code: 'TOP',
          status: 'stopped',
          stopped_at: '2026-08-26T11:00:00',
          reason_code: null,
          reason_text: null,
        },
      });
      let captured: Record<string, unknown> | null = null;
      server.use(
        http.post('/api/v1/floor/printers/12/stopped-print/reason', async ({ request }) => {
          captured = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            print_log_id: 101,
            archive_id: 88,
            print_name: 'Bracket v3',
            part_code: 'TOP',
            status: 'stopped',
            stopped_at: '2026-08-26T11:00:00',
            reason_code: 'warping',
            reason_text: null,
          });
        }),
      );
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');
      await user.click(await screen.findByRole('button', { name: 'Log stop reason' }));
      expect(screen.getByRole('button', { name: 'First layer issue' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Layer lines' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Warping' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(captured).toEqual({ reason_code: 'warping', reason_text: null });
      expect(await screen.findByText('Reason logged')).toBeInTheDocument();
    });

    it('offers failure reason logging for a recent failed print', async () => {
      mockNoSession();
      mockInfo({
        recent_stopped_print: {
          print_log_id: 102,
          archive_id: 89,
          print_name: 'Bottom bracket',
          part_code: 'BOTTOM',
          status: 'failed',
          stopped_at: '2026-08-26T11:05:00',
          reason_code: null,
          reason_text: null,
        },
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Recent print failed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Log failure reason' })).toBeInTheDocument();
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

    it('shows only the failed reprint when it happened after the still-unharvested job', async () => {
      // A finished job sat unharvested, then a reprint attempt on top of it
      // failed — the reprint is the more recent event, so it alone should
      // show rather than stacking "Bed ready to clear" on top of it.
      mockNoSession();
      mockInfo({
        recent_stopped_print: {
          print_log_id: 103,
          archive_id: 90,
          print_name: 'Bracket v3 (reprint)',
          part_code: 'BUT',
          status: 'cancelled',
          stopped_at: '2026-08-25T09:00:00',
          reason_code: null,
          reason_text: null,
        },
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Recent print stopped')).toBeInTheDocument();
      expect(screen.queryByText('Bed ready to clear')).not.toBeInTheDocument();
    });

    it('still prompts to clear the bed when the stop reason predates the finished job', async () => {
      mockNoSession();
      mockInfo({
        recent_stopped_print: {
          print_log_id: 104,
          archive_id: 87,
          print_name: 'Older attempt',
          part_code: 'BUT',
          status: 'failed',
          stopped_at: '2026-08-20T09:00:00',
          reason_code: null,
          reason_text: null,
        },
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Bed ready to clear')).toBeInTheDocument();
      expect(screen.queryByText('Recent print failed')).not.toBeInTheDocument();
    });

    it('opens maintenance details from the scanned printer page', async () => {
      mockNoSession();
      mockInfo();
      server.use(
        http.get('/api/v1/maintenance/printers/12', () => HttpResponse.json({
          printer_id: 12,
          printer_name: 'Bench A',
          printer_model: 'X1C',
          total_print_hours: 412.6,
          maintenance_items: [
            {
              id: 7,
              printer_id: 12,
              maintenance_type_id: 1,
              maintenance_type_name: 'Clean Build Plate',
              maintenance_type_icon: 'Square',
              maintenance_type_wiki_url: null,
              enabled: true,
              interval_hours: 25,
              interval_type: 'hours',
              current_hours: 412.6,
              hours_since_maintenance: 30,
              hours_until_due: -5,
              days_since_maintenance: null,
              days_until_due: null,
              is_due: true,
              is_warning: false,
              last_performed_at: null,
            },
          ],
          due_count: 1,
          warning_count: 0,
          total_maintenance_cost: 0,
        })),
        http.get('/api/v1/maintenance/printers/12/history', () => HttpResponse.json([
          {
            id: 9,
            printer_maintenance_id: 7,
            printer_id: 12,
            performed_at: '2026-08-24T14:32:00Z',
            hours_at_maintenance: 382.6,
            notes: 'Wiped plate',
            title: 'Clean Build Plate',
            part_url: null,
            cost: null,
            job_name: 'Clean Build Plate',
            is_custom: false,
          },
        ])),
      );
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBP-12');

      await user.click(await screen.findByRole('button', { name: 'Maintenance' }));

      expect(await screen.findByRole('dialog', { name: 'Bench A' })).toBeInTheDocument();
      expect(screen.getAllByText('Clean Build Plate')).toHaveLength(2);
      expect(screen.getByText(/Wiped plate/)).toBeInTheDocument();
      expect(screen.getByText('1 due')).toBeInTheDocument();
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

  describe('harvest (§5.4, phase 8)', () => {
    const HARVEST_SESSION = {
      id: 5,
      station_slug: 'harvest',
      station_name: 'Harvest',
      device_id: 'this-device',
      opened_at: '2026-08-24T10:00:00',
      open_seconds: 0,
    };

    const PLATE_PRINTER = { id: 12, name: 'P1S-3' };
    const PLATE_ARCHIVE = {
      id: 88,
      print_name: 'bracket_v4',
      completed_at: '2026-08-24T14:32:00',
      quantity: 4,
    };

    /** Resumes an already-open Harvest session on load, so a test can start
     *  straight from "Harvest is open, nothing bound yet". */
    function mockHarvestSession() {
      server.use(http.get('/api/v1/floor/session', () => HttpResponse.json(HARVEST_SESSION)));
    }

    function mockHarvestPrinterScan(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/harvest/printer', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    function mockHarvestBinScan(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/harvest/bin', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    function mockPartScan(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/parts/scan', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    describe('the lean harvest screen, from the station', () => {
      it('shows nothing but the session and a prompt before anything is bound', async () => {
        mockHarvestSession();
        render(<FloorScanPage />);

        expect(await screen.findByText('Harvest')).toBeInTheDocument();
        expect(screen.getByText('Scan the printer to begin')).toBeInTheDocument();
      });

      it('binds the plate on a printer scan: printer, elapsed, count and job', async () => {
        mockHarvestSession();
        mockHarvestPrinterScan({
          result: 'bound',
          session: HARVEST_SESSION,
          printer: PLATE_PRINTER,
          archive: PLATE_ARCHIVE,
          part_count: 0,
          blocking: null,
        });
        render(<FloorScanPage />);
        await screen.findByText('Harvest');

        await scan('BBP-12');

        expect(await screen.findByText('P1S-3')).toBeInTheDocument();
        expect(screen.getByText('bracket_v4')).toBeInTheDocument();
        expect(screen.getByText('0')).toBeInTheDocument();
        expect(screen.getByText('Open for 0s')).toBeInTheDocument();
      });

      it.each(['KNB', 'BUT'] as const)('shows the production 3MF image for a %s plate before bin harvest', async (partCode) => {
        mockHarvestSession();
        mockHarvestPrinterScan({
          result: 'bound',
          session: HARVEST_SESSION,
          printer: PLATE_PRINTER,
          archive: { ...PLATE_ARCHIVE, part_code: partCode },
          part_count: 0,
          blocking: null,
        });
        render(<FloorScanPage />);
        await screen.findByText('Harvest');

        await scan('BBP-12');

        const image = await screen.findByRole('img', { name: partCode });
        expect(image).toHaveAttribute('src', expect.stringContaining(`/floor/parts/thumbnail/${partCode}`));
        expect(screen.getByText(`Scan the matching ${partCode} bin`)).toBeInTheDocument();
      });

      it.each(['KNB', 'BUT'] as const)('shows the production 3MF image while entering %s bin quantity', async (partCode) => {
        mockHarvestSession();
        mockHarvestPrinterScan({
          result: 'bound',
          session: HARVEST_SESSION,
          printer: PLATE_PRINTER,
          archive: { ...PLATE_ARCHIVE, part_code: partCode },
          part_count: 0,
          blocking: null,
        });
        mockHarvestBinScan({
          result: 'ready_for_quantity',
          bin: { payload: `BBN-${partCode}-1`, bin_number: 1, part_code: partCode, part_name: `${partCode} bin` },
          printer: PLATE_PRINTER,
          session: HARVEST_SESSION,
          archive: { ...PLATE_ARCHIVE, part_code: partCode },
          batch: null,
          blocking: null,
        });
        render(<FloorScanPage />);
        await screen.findByText('Harvest');

        await scan('BBP-12');
        await screen.findByText('P1S-3');
        await scan(`BBN-${partCode}-1`);

        expect(await screen.findByText('How many parts were harvested?')).toBeInTheDocument();
        const image = await screen.findByRole('img', { name: partCode });
        expect(image).toHaveAttribute('src', expect.stringContaining(`/floor/parts/thumbnail/${partCode}`));
      });

      it('asks for the quantity that passed visual QC when the bin is scanned again', async () => {
        mockNoSession();
        const qcRequest: { body: Record<string, unknown> | null } = { body: null };
        const batch = {
          id: 91,
          payload: 'BBN-BUT-1',
          bin_number: 1,
          printer_id: 12,
          printer_name: 'P1S-3',
          archive_id: 88,
          print_name: 'button_plate',
          part_code: 'BUT',
          quantity: 25,
          qc_passed_quantity: null,
          remaining_quantity: 25,
          status: 'harvested',
          harvested_at: '2026-08-26T14:35:00',
        };
        server.use(
          http.post('/api/v1/floor/bins/resolve', () => HttpResponse.json({
            result: 'ready_for_qc',
            bin: { payload: 'BBN-BUT-1', bin_number: 1, part_code: 'BUT', part_name: 'Button bin' },
            batch,
            printer: null,
            session: null,
            blocking: null,
            archive: null,
          })),
          http.post('/api/v1/floor/locations/fit-check/bin', async ({ request }) => {
            qcRequest.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              result: 'qc_recorded',
              bin: { payload: 'BBN-BUT-1', bin_number: 1, part_code: 'BUT', part_name: 'Button bin' },
              batch: { ...batch, qc_passed_quantity: 20, remaining_quantity: 20, status: 'visual_qc_passed' },
              printer: null,
              session: null,
              blocking: null,
              archive: null,
            });
          }),
        );
        const user = userEvent.setup();
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');

        await scan('BBN-BUT-1');
        expect(await screen.findByText('Scan this bin again for visual QC')).toBeInTheDocument();

        await scan('BBN-BUT-1');
        expect(await screen.findByText('How many parts passed visual QC?')).toBeInTheDocument();
        await user.type(screen.getByLabelText('Parts passed QC'), '20');
        await user.click(screen.getByRole('button', { name: 'Record QC result' }));

        expect(await screen.findByText('20 / 25 passed QC')).toBeInTheDocument();
        expect(qcRequest.body).toEqual({ payload: 'BBN-BUT-1', passed_quantity: 20 });
      });

      it('shows a bin that already passed visual QC as passed, not as awaiting QC', async () => {
        // Regression: resolving a bin used to show the same "scan again for
        // visual QC" prompt no matter its real status.
        mockNoSession();
        server.use(
          http.post('/api/v1/floor/bins/resolve', () =>
            HttpResponse.json({
              result: 'ready_for_qc',
              bin: { payload: 'BBN-BUT-1', bin_number: 1, part_code: 'BUT', part_name: 'Button bin' },
              batch: {
                id: 91,
                payload: 'BBN-BUT-1',
                bin_number: 1,
                printer_id: 12,
                printer_name: 'P1S-3',
                archive_id: 88,
                print_name: 'button_plate',
                part_code: 'BUT',
                quantity: 25,
                qc_passed_quantity: 20,
                remaining_quantity: 20,
                status: 'visual_qc_passed',
                harvested_at: '2026-08-26T14:35:00',
              },
              printer: null,
              session: null,
              blocking: null,
              archive: null,
            }),
          ),
        );
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');

        await scan('BBN-BUT-1');

        expect(await screen.findByText('Visual QC pass · 20 / 25 passed')).toBeInTheDocument();
        expect(screen.queryByText('Scan this bin again for visual QC')).not.toBeInTheDocument();
      });

      it('does not re-open the QC quantity form for a bin already past QC — it closes to idle', async () => {
        mockNoSession();
        server.use(
          http.post('/api/v1/floor/bins/resolve', () =>
            HttpResponse.json({
              result: 'ready_for_qc',
              bin: { payload: 'BBN-BUT-1', bin_number: 1, part_code: 'BUT', part_name: 'Button bin' },
              batch: {
                id: 91,
                payload: 'BBN-BUT-1',
                bin_number: 1,
                printer_id: 12,
                printer_name: 'P1S-3',
                archive_id: 88,
                print_name: 'button_plate',
                part_code: 'BUT',
                quantity: 25,
                qc_passed_quantity: 20,
                remaining_quantity: 20,
                status: 'wip',
                harvested_at: '2026-08-26T14:35:00',
              },
              printer: null,
              session: null,
              blocking: null,
              archive: null,
            }),
          ),
        );
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBN-BUT-1');
        await screen.findByText('In WIP');

        // Re-scanning the same In-WIP bin dismisses its lookup back to idle
        // (scan-page auto-dismiss) rather than re-resolving it or, crucially,
        // re-opening the QC quantity form — only a not-yet-QC'd bin advances.
        await scan('BBN-BUT-1');

        expect(screen.queryByText('How many parts passed visual QC?')).not.toBeInTheDocument();
        expect(await screen.findByText('Scan a code')).toBeInTheDocument();
      });

      it('names Rework specifically as unsupported for a bin, rather than a generic redirect', async () => {
        mockNoSession();
        server.use(
          http.post('/api/v1/floor/bins/resolve', () =>
            HttpResponse.json({
              result: 'ready_for_qc',
              bin: { payload: 'BBN-BUT-1', bin_number: 1, part_code: 'BUT', part_name: 'Button bin' },
              batch: {
                id: 91,
                payload: 'BBN-BUT-1',
                bin_number: 1,
                printer_id: 12,
                printer_name: 'P1S-3',
                archive_id: 88,
                print_name: 'button_plate',
                part_code: 'BUT',
                quantity: 25,
                qc_passed_quantity: null,
                remaining_quantity: 25,
                status: 'harvested',
                harvested_at: '2026-08-26T14:35:00',
              },
              printer: null,
              session: null,
              blocking: null,
              archive: null,
            }),
          ),
        );
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBN-BUT-1');
        await screen.findByText('Scan this bin again for visual QC');

        await scan('BBS-rework');

        expect(
          await screen.findByText("Bins aren't supported for Rework — scan a part instead"),
        ).toBeInTheDocument();
      });

      it('states plainly when the printer has no finished job, without an error flash or tone', async () => {
        mockHarvestSession();
        mockHarvestPrinterScan({
          result: 'bound',
          session: HARVEST_SESSION,
          printer: PLATE_PRINTER,
          archive: null,
          part_count: 0,
          blocking: null,
        });
        render(<FloorScanPage />);
        await screen.findByText('Harvest');

        await scan('BBP-12');

        const line = await screen.findByText('No job found for this printer');
        expect(line.className).not.toMatch(/text-red-500/);
        expect(floorSound.playScanErrorTone).not.toHaveBeenCalled();
      });

      it('rebinds to a different printer, restarting the count at 0', async () => {
        mockHarvestSession();
        mockHarvestPrinterScan({
          result: 'bound',
          session: HARVEST_SESSION,
          printer: PLATE_PRINTER,
          archive: PLATE_ARCHIVE,
          part_count: 2,
          blocking: null,
        });
        render(<FloorScanPage />);
        await screen.findByText('Harvest');
        await scan('BBP-12');
        await screen.findByText('P1S-3');

        const OTHER_PRINTER = { id: 20, name: 'X1C-2' };
        mockHarvestPrinterScan({
          result: 'rebound',
          session: HARVEST_SESSION,
          printer: OTHER_PRINTER,
          archive: null,
          part_count: 0,
          blocking: null,
        });
        await scan('BBP-20');

        expect(await screen.findByText('X1C-2')).toBeInTheDocument();
        expect(screen.getByText('0')).toBeInTheDocument();
      });

      it('closes the plate on a repeat scan of the same printer, then returns to the scan-printer prompt', async () => {
        // Opened well past the first minute, so the elapsed display's own
        // 1s-tick interval (§5.4) is not also running during the advance
        // below — otherwise two independent fake-timer-driven intervals
        // (that one and the flash's) contend under `shouldAdvanceTime`,
        // which is only asking for flakiness this test has no interest in.
        const session = { ...HARVEST_SESSION, open_seconds: 120 };
        server.use(http.get('/api/v1/floor/session', () => HttpResponse.json(session)));
        mockHarvestPrinterScan({
          result: 'bound',
          session,
          printer: PLATE_PRINTER,
          archive: PLATE_ARCHIVE,
          part_count: 4,
          blocking: null,
        });
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
          render(<FloorScanPage />);
          await screen.findByText('Harvest');
          await scan('BBP-12');
          await screen.findByText('P1S-3');

          mockHarvestPrinterScan({
            result: 'plate_closed',
            session,
            printer: PLATE_PRINTER,
            archive: PLATE_ARCHIVE,
            part_count: 4,
            blocking: null,
          });
          await scan('BBP-12');

          expect(await screen.findByText('Plate closed · 4 parts')).toBeInTheDocument();

          act(() => {
            vi.advanceTimersByTime(3000);
          });

          expect(await screen.findByText('Scan the printer to begin')).toBeInTheDocument();
        } finally {
          vi.useRealTimers();
        }
      });

      it('reports an unresolvable printer code as unknown', async () => {
        mockHarvestSession();
        mockHarvestPrinterScan({
          result: 'unknown_printer',
          session: HARVEST_SESSION,
          printer: null,
          archive: null,
          part_count: 0,
          blocking: null,
        });
        render(<FloorScanPage />);
        await screen.findByText('Harvest');

        await scan('BBP-999');

        expect(await screen.findByText('Unknown code')).toBeInTheDocument();
        expect(floorSound.playScanErrorTone).toHaveBeenCalled();
      });

      it('handles a locked printer-bind result without crashing, though the contract calls it unreachable', async () => {
        mockHarvestSession();
        mockHarvestPrinterScan({
          result: 'locked',
          session: null,
          printer: null,
          archive: null,
          part_count: 0,
          blocking: { ...HARVEST_SESSION, device_id: 'other-device', open_seconds: 120 },
        });
        render(<FloorScanPage />);
        await screen.findByText('Harvest');

        await scan('BBP-12');

        expect(await screen.findByText('Harvest is open elsewhere')).toBeInTheDocument();
      });
    });

    describe('part scans against a bound plate', () => {
      async function bindPlate() {
        mockHarvestSession();
        mockHarvestPrinterScan({
          result: 'bound',
          session: HARVEST_SESSION,
          printer: PLATE_PRINTER,
          archive: PLATE_ARCHIVE,
          part_count: 0,
          blocking: null,
        });
        render(<FloorScanPage />);
        await screen.findByText('Harvest');
        await scan('BBP-12');
        await screen.findByText('P1S-3');
      }

      it('links a part, incrementing the running count, with no error tone', async () => {
        await bindPlate();
        mockPartScan({
          result: 'labeled',
          part: { id: 1, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T14:40:00' },
          printer: PLATE_PRINTER,
          archive: PLATE_ARCHIVE,
          part_count: 1,
          session: HARVEST_SESSION,
          blocking: null,
        });

        await scan('BBD-000042');

        expect(await screen.findByText('1')).toBeInTheDocument();
        expect(screen.getByText('Linked · bracket_v4')).toBeInTheDocument();
        expect(floorSound.playScanErrorTone).not.toHaveBeenCalled();
      });

      it('states the no-job outcome per part, plainly and without the error tone', async () => {
        await bindPlate();
        mockPartScan({
          result: 'no_job',
          part: { id: 2, sticker_code: 'BBD-000043', printer_id: 12, archive_id: null, labeled_at: '2026-08-24T14:41:00' },
          printer: PLATE_PRINTER,
          archive: null,
          part_count: 1,
          session: HARVEST_SESSION,
          blocking: null,
        });

        await scan('BBD-000043');

        const line = await screen.findByText('Linked to printer 12, no job found');
        expect(line.className).not.toMatch(/text-red-500/);
        expect(floorSound.playScanErrorTone).not.toHaveBeenCalled();
      });

      it('rejects an already-enrolled sticker without changing the plate', async () => {
        await bindPlate();
        // Bump the plate to a nonzero count first, to prove a duplicate scan
        // does not disturb it.
        mockPartScan({
          result: 'labeled',
          part: { id: 1, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T14:40:00' },
          printer: PLATE_PRINTER,
          archive: PLATE_ARCHIVE,
          part_count: 3,
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBD-000042');
        await screen.findByText('3');

        mockPartScan({
          result: 'duplicate',
          part: null,
          printer: null,
          archive: null,
          part_count: 3,
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBD-000099');

        expect(await screen.findByText('Part already scanned')).toBeInTheDocument();
        expect(floorSound.playScanErrorTone).toHaveBeenCalled();
      });

      it('errors and rings the tone when no printer is bound yet', async () => {
        mockHarvestSession();
        mockPartScan({
          result: 'no_printer',
          part: null,
          printer: null,
          archive: null,
          part_count: 0,
          session: HARVEST_SESSION,
          blocking: null,
        });
        render(<FloorScanPage />);
        await screen.findByText('Harvest');

        await scan('BBD-000042');

        expect(await screen.findByText('Scan the printer first')).toBeInTheDocument();
        expect(floorSound.playScanErrorTone).toHaveBeenCalled();
      });

      it('flags a malformed part code as invalid, and rings the tone', async () => {
        await bindPlate();
        mockPartScan({
          result: 'invalid_code',
          part: null,
          printer: null,
          archive: null,
          part_count: 0,
          session: HARVEST_SESSION,
          blocking: null,
        });

        await scan('BBD-1');

        expect(await screen.findByText('Invalid part code')).toBeInTheDocument();
        expect(floorSound.playScanErrorTone).toHaveBeenCalled();
      });

      it('refuses a part scan that tries to claim a lock held elsewhere, offering takeover', async () => {
        await bindPlate();
        mockPartScan({
          result: 'locked',
          part: null,
          printer: null,
          archive: null,
          part_count: 0,
          session: null,
          blocking: { ...HARVEST_SESSION, device_id: 'other-device', open_seconds: 600 },
        });

        await scan('BBD-000042');

        expect(await screen.findByText('Harvest is open elsewhere')).toBeInTheDocument();
        expect(floorSound.playScanErrorTone).toHaveBeenCalled();
      });
    });

    describe('part scans from the printer info page (§5.6 entry #2)', () => {
      const HARVEST_INFO = {
        id: 12,
        payload: 'BBP-12',
        name: 'Bench A',
        model: 'X1C',
        location: 'Line 1',
        serial_number: '00M09A000000001',
        is_active: true,
        awaiting_plate_clear: true,
        total_print_hours: 100,
        last_print: null,
        maintenance_due_count: 0,
        maintenance_warning_count: 0,
        live: null,
      };

      function mockHarvestInfo() {
        server.use(
          http.get('/api/v1/floor/printers/:payload/info', () => HttpResponse.json(HARVEST_INFO)),
        );
      }

      it('links a part and shows the result without leaving the info page', async () => {
        mockNoSession();
        mockHarvestInfo();
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBP-12');
        await screen.findByText('Bench A');

        const captured = mockPartScan({
          result: 'labeled',
          part: { id: 1, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T15:00:00' },
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'bracket_v4', completed_at: null, quantity: 1 },
          part_count: 1,
          session: HARVEST_SESSION,
          blocking: null,
        });

        await scan('BBD-000042');

        // Stays on the info page (§5.6: "a different screen, not a different
        // mode") — the operator is still standing at this same printer.
        expect(await screen.findByText('Bench A')).toBeInTheDocument();
        expect(screen.getByText('Linked · bracket_v4')).toBeInTheDocument();
        // The viewed printer's id is sent as the lock-claim hint, since no
        // harvest session existed yet.
        expect(captured.body).toMatchObject({ printer_id: 12, payload: 'BBD-000042' });
        expect(floorSound.playScanErrorTone).not.toHaveBeenCalled();
      });

      it('produces identical no_job rendering to the harvest-station path', async () => {
        mockNoSession();
        mockHarvestInfo();
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBP-12');
        await screen.findByText('Bench A');

        mockPartScan({
          result: 'no_job',
          part: { id: 1, sticker_code: 'BBD-000042', printer_id: 12, archive_id: null, labeled_at: '2026-08-24T15:00:00' },
          printer: { id: 12, name: 'Bench A' },
          archive: null,
          part_count: 1,
          session: HARVEST_SESSION,
          blocking: null,
        });

        await scan('BBD-000042');

        const line = await screen.findByText('Linked to printer 12, no job found');
        expect(line.className).not.toMatch(/text-red-500/);
        expect(floorSound.playScanErrorTone).not.toHaveBeenCalled();
      });

      it('stops sending the printer-id hint once the harvest session already exists', async () => {
        mockNoSession();
        mockHarvestInfo();
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBP-12');
        await screen.findByText('Bench A');

        mockPartScan({
          result: 'labeled',
          part: { id: 1, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T15:00:00' },
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'bracket_v4', completed_at: null, quantity: 1 },
          part_count: 1,
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBD-000042');
        await screen.findByText('Linked · bracket_v4');

        const captured2 = mockPartScan({
          result: 'labeled',
          part: { id: 2, sticker_code: 'BBD-000043', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T15:01:00' },
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'bracket_v4', completed_at: null, quantity: 1 },
          part_count: 2,
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBD-000043');

        await waitFor(() => expect(captured2.body).not.toBeNull());
        // The session this device holds is now Harvest, so the router takes
        // the harvest branch (§5.4) rather than the info-page hint branch —
        // the hint is only for claiming the lock in the first place.
        expect(captured2.body).toMatchObject({ printer_id: null });
      });

      it('does not claim the harvest lock when the very first scan is already enrolled', async () => {
        mockNoSession();
        mockHarvestInfo();
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBP-12');
        await screen.findByText('Bench A');

        mockPartScan({
          result: 'duplicate',
          part: null,
          printer: null,
          archive: null,
          part_count: 0,
          // Nothing was created: already-enrolled short-circuits before the
          // lock-claim step in the resolution order.
          session: null,
          blocking: null,
        });

        await scan('BBD-000099');

        expect(await screen.findByText('Part already scanned')).toBeInTheDocument();
        expect(floorSound.playScanErrorTone).toHaveBeenCalled();
      });

      it('returns to idle scan after Done when a part opened harvest', async () => {
        mockNoSession();
        mockHarvestInfo();
        server.use(
          http.delete('/api/v1/floor/session', () => HttpResponse.json(HARVEST_SESSION)),
        );
        const user = userEvent.setup();
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBP-12');
        await screen.findByText('Bench A');

        mockPartScan({
          result: 'labeled',
          part: { id: 1, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T15:00:00' },
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'bracket_v4', completed_at: null, quantity: 1 },
          part_count: 1,
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBD-000042');
        await screen.findByText('Linked · bracket_v4');

        await user.click(await screen.findByRole('button', { name: 'Done' }));

        expect(await screen.findByText('Scan a code')).toBeInTheDocument();
        expect(screen.queryByText('Harvest')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Close station' })).not.toBeInTheDocument();
        expect(screen.getByLabelText('Scan field')).toHaveFocus();
      });

      it('returns to idle scan when re-scanning the same printer after linking a part', async () => {
        mockNoSession();
        mockHarvestInfo();
        server.use(
          http.delete('/api/v1/floor/session', () => HttpResponse.json(HARVEST_SESSION)),
        );
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBP-12');
        await screen.findByText('Bench A');

        mockPartScan({
          result: 'labeled',
          part: { id: 1, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T15:00:00' },
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'bracket_v4', completed_at: null, quantity: 1 },
          part_count: 1,
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBD-000042');
        await screen.findByText('Linked · bracket_v4');

        await scan('BBP-12');

        expect(await screen.findByText('Scan a code')).toBeInTheDocument();
        expect(screen.queryByText('Harvest')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Close station' })).not.toBeInTheDocument();
      });

      it('accumulates a session link count across multiple part scans', async () => {
        mockNoSession();
        mockHarvestInfo();
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBP-12');
        await screen.findByText('Bench A');

        mockPartScan({
          result: 'labeled',
          part: { id: 1, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T15:00:00' },
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'bracket_v4', completed_at: null, quantity: 1 },
          part_count: 1,
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBD-000042');
        expect(await screen.findByText('Linked · bracket_v4')).toBeInTheDocument();

        mockPartScan({
          result: 'labeled',
          part: { id: 2, sticker_code: 'BBD-000043', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T15:01:00' },
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'bracket_v4', completed_at: null, quantity: 1 },
          part_count: 2,
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBD-000043');

        expect(await screen.findByText('Linked · 2 parts · bracket_v4')).toBeInTheDocument();
        expect(screen.getByText('Bench A')).toBeInTheDocument();
      });

      it('keeps the link message visible after the harvest flash window', async () => {
        mockNoSession();
        mockHarvestInfo();
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
          render(<FloorScanPage />);
          await screen.findByText('Scan a code');
          await scan('BBP-12');
          await screen.findByText('Bench A');

          mockPartScan({
            result: 'labeled',
            part: { id: 1, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T15:00:00' },
            printer: { id: 12, name: 'Bench A' },
            archive: { id: 88, print_name: 'bracket_v4', completed_at: null, quantity: 1 },
            part_count: 1,
            session: HARVEST_SESSION,
            blocking: null,
          });
          await scan('BBD-000042');
          expect(await screen.findByText('Linked · bracket_v4')).toBeInTheDocument();

          act(() => {
            vi.advanceTimersByTime(3100);
          });

          expect(screen.getByText('Linked · bracket_v4')).toBeInTheDocument();
        } finally {
          vi.useRealTimers();
        }
      });

      it('clears the link count when opening a different printer', async () => {
        mockNoSession();
        mockHarvestInfo();
        server.use(
          http.delete('/api/v1/floor/session', () => HttpResponse.json(HARVEST_SESSION)),
          http.get('/api/v1/floor/printers/BBP-13/info', () =>
            HttpResponse.json({ ...HARVEST_INFO, id: 13, payload: 'BBP-13', name: 'Bench B' }),
          ),
        );
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBP-12');
        await screen.findByText('Bench A');

        mockPartScan({
          result: 'labeled',
          part: { id: 1, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T15:00:00' },
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'bracket_v4', completed_at: null, quantity: 1 },
          part_count: 1,
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBD-000042');
        await screen.findByText('Linked · bracket_v4');

        await scan('BBP-12');
        await screen.findByText('Scan a code');

        await scan('BBP-13');
        await screen.findByText('Bench B');

        expect(screen.queryByText(/Linked ·/)).not.toBeInTheDocument();
      });

      it('clears the link message when Done after linking parts', async () => {
        mockNoSession();
        mockHarvestInfo();
        server.use(
          http.delete('/api/v1/floor/session', () => HttpResponse.json(HARVEST_SESSION)),
        );
        const user = userEvent.setup();
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBP-12');
        await screen.findByText('Bench A');

        mockPartScan({
          result: 'labeled',
          part: { id: 1, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T15:00:00' },
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'bracket_v4', completed_at: null, quantity: 1 },
          part_count: 1,
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBD-000042');
        await screen.findByText('Linked · bracket_v4');

        mockPartScan({
          result: 'labeled',
          part: { id: 2, sticker_code: 'BBD-000043', printer_id: 12, archive_id: 88, labeled_at: '2026-08-24T15:01:00' },
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'bracket_v4', completed_at: null, quantity: 1 },
          part_count: 2,
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBD-000043');
        await screen.findByText('Linked · 2 parts · bracket_v4');

        await user.click(await screen.findByRole('button', { name: 'Done' }));

        expect(await screen.findByText('Scan a code')).toBeInTheDocument();
        expect(screen.queryByText(/Linked ·/)).not.toBeInTheDocument();
      });
    });

    describe('bin scans from the printer info page (§5.6 entry #2)', () => {
      const HARVEST_INFO = {
        id: 12,
        payload: 'BBP-12',
        name: 'Bench A',
        model: 'X1C',
        location: 'Line 1',
        serial_number: '00M09A000000001',
        is_active: true,
        awaiting_plate_clear: true,
        total_print_hours: 100,
        last_print: {
          archive_id: 88,
          print_name: 'knob_plate',
          completed_at: '2026-08-24T14:00:00',
          quantity: 24,
          part_code: 'KNB',
          has_labeled_parts: false,
        },
        maintenance_due_count: 0,
        maintenance_warning_count: 0,
        live: null,
      };

      const BIN_BATCH = {
        id: 7,
        payload: 'BBN-KNB-1',
        bin_number: 1,
        printer_id: 12,
        printer_name: 'Bench A',
        archive_id: 88,
        print_name: 'knob_plate',
        part_code: 'KNB' as const,
        quantity: 24,
        qc_passed_quantity: null,
        remaining_quantity: 24,
        status: 'harvested',
        harvested_at: '2026-08-24T15:00:00',
      };

      function mockHarvestInfo() {
        server.use(
          http.get('/api/v1/floor/printers/:payload/info', () => HttpResponse.json(HARVEST_INFO)),
        );
      }

      it('returns to the printer info page with a Linked line after quantity', async () => {
        mockNoSession();
        mockHarvestInfo();
        const user = userEvent.setup();
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBP-12');
        await screen.findByText('Bench A');

        mockHarvestBinScan({
          result: 'ready_for_quantity',
          bin: { payload: 'BBN-KNB-1', bin_number: 1, part_code: 'KNB', part_name: 'Knob bin' },
          batch: null,
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'knob_plate', completed_at: null, quantity: 24, part_code: 'KNB' },
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBN-KNB-1');
        expect(await screen.findByText('How many parts were harvested?')).toBeInTheDocument();

        mockHarvestBinScan({
          result: 'recorded',
          bin: { payload: 'BBN-KNB-1', bin_number: 1, part_code: 'KNB', part_name: 'Knob bin' },
          batch: BIN_BATCH,
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'knob_plate', completed_at: null, quantity: 24, part_code: 'KNB' },
          session: HARVEST_SESSION,
          blocking: null,
        });
        await user.type(screen.getByLabelText('How many parts were harvested?'), '24');
        await user.click(screen.getByRole('button', { name: 'Save quantity' }));

        // Stays on the info page like a part link — not the Harvest station
        // screen that would force a separate close-out.
        expect(await screen.findByText('Linked · 24 parts · knob_plate')).toBeInTheDocument();
        expect(screen.getByText('Bench A')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
        expect(screen.queryByText('Harvest')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Close station' })).not.toBeInTheDocument();
      });

      it('returns to idle scan after Done when a bin opened harvest', async () => {
        mockNoSession();
        mockHarvestInfo();
        server.use(
          http.delete('/api/v1/floor/session', () => HttpResponse.json(HARVEST_SESSION)),
        );
        const user = userEvent.setup();
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBP-12');
        await screen.findByText('Bench A');

        mockHarvestBinScan({
          result: 'ready_for_quantity',
          bin: { payload: 'BBN-KNB-1', bin_number: 1, part_code: 'KNB', part_name: 'Knob bin' },
          batch: null,
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'knob_plate', completed_at: null, quantity: 24, part_code: 'KNB' },
          session: HARVEST_SESSION,
          blocking: null,
        });
        await scan('BBN-KNB-1');
        await screen.findByText('How many parts were harvested?');

        mockHarvestBinScan({
          result: 'recorded',
          bin: { payload: 'BBN-KNB-1', bin_number: 1, part_code: 'KNB', part_name: 'Knob bin' },
          batch: BIN_BATCH,
          printer: { id: 12, name: 'Bench A' },
          archive: { id: 88, print_name: 'knob_plate', completed_at: null, quantity: 24, part_code: 'KNB' },
          session: HARVEST_SESSION,
          blocking: null,
        });
        await user.type(screen.getByLabelText('How many parts were harvested?'), '24');
        await user.click(screen.getByRole('button', { name: 'Save quantity' }));
        await screen.findByText('Linked · 24 parts · knob_plate');

        await user.click(await screen.findByRole('button', { name: 'Done' }));

        expect(await screen.findByText('Scan a code')).toBeInTheDocument();
        expect(screen.queryByText('Harvest')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Close station' })).not.toBeInTheDocument();
        expect(screen.getByLabelText('Scan field')).toHaveFocus();
      });
    });

    describe('closing harvest reports a summary', () => {
      it('reports bins collected instead of zero parts for a bin-only harvest', async () => {
        // KNB/BUT bins are tracked separately from stickered parts — a
        // session that only harvested bins used to summarize as "0 parts
        // linked" even though real quantity was collected.
        mockHarvestSession();
        server.use(
          http.get('/api/v1/floor/harvest/sessions/5/summary', () =>
            HttpResponse.json([
              { printer_id: 12, printer_name: 'P1S-3', print_name: 'bracket_v4', part_count: 0, bin_quantity: 12 },
            ]),
          ),
        );
        mockScan({ result: 'closed', station_slug: 'harvest', station_name: 'Harvest', session: null, blocking: null });
        render(<FloorScanPage />);
        await screen.findByText('Harvest');

        await scan('BBS-harvest');

        expect(await screen.findByText('Harvest complete')).toBeInTheDocument();
        expect(screen.getByText('12 bins collected')).toBeInTheDocument();
        expect(screen.getByText('12 bins')).toBeInTheDocument();
        expect(screen.queryByText(/parts linked/)).not.toBeInTheDocument();
      });

      it('still reports parts linked for a parts-only harvest', async () => {
        mockHarvestSession();
        server.use(
          http.get('/api/v1/floor/harvest/sessions/5/summary', () =>
            HttpResponse.json([
              { printer_id: 12, printer_name: 'P1S-3', print_name: 'bracket_v4', part_count: 4, bin_quantity: 0 },
            ]),
          ),
        );
        mockScan({ result: 'closed', station_slug: 'harvest', station_name: 'Harvest', session: null, blocking: null });
        render(<FloorScanPage />);
        await screen.findByText('Harvest');

        await scan('BBS-harvest');

        expect(await screen.findByText('Harvest complete')).toBeInTheDocument();
        expect(screen.getByText('4 parts linked')).toBeInTheDocument();
        expect(screen.queryByText(/bins collected/)).not.toBeInTheDocument();
      });
    });
  });

  describe('bin discard (floor kiosk)', () => {
    const DISCARD_BATCH = {
      id: 91,
      payload: 'BBN-BUT-1',
      bin_number: 1,
      printer_id: 12,
      printer_name: 'P1S-3',
      archive_id: 88,
      print_name: 'button_plate',
      part_code: 'BUT',
      quantity: 25,
      qc_passed_quantity: null,
      remaining_quantity: 25,
      status: 'harvested',
      harvested_at: '2026-08-26T14:35:00',
    };

    function mockBinResolve(batch: Record<string, unknown> = DISCARD_BATCH) {
      server.use(
        http.post('/api/v1/floor/bins/resolve', () =>
          HttpResponse.json({
            result: 'ready_for_qc',
            bin: { payload: 'BBN-BUT-1', bin_number: 1, part_code: 'BUT', part_name: 'Button bin' },
            batch,
            printer: null,
            session: null,
            blocking: null,
            archive: null,
          }),
        ),
      );
    }

    function mockBinDiscard(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/bins/discard', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    it('warns before discarding and requires Discard to be scanned twice, with no reason step', async () => {
      mockNoSession();
      mockBinResolve();
      const discardCall = mockBinDiscard({
        result: 'discarded',
        bin: { payload: 'BBN-BUT-1', bin_number: 1, part_code: 'BUT', part_name: 'Button bin' },
        batch: { ...DISCARD_BATCH, status: 'empty', remaining_quantity: 0 },
        printer: null,
        session: null,
        blocking: null,
        archive: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBN-BUT-1');
      await screen.findByText('Scan this bin again for visual QC');

      await scan('BBX-discard');
      expect(
        await screen.findByText('This clears the whole bin and unlinks it from this printer.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Scan Discard again to confirm')).toBeInTheDocument();
      // No reason prompt, unlike a part's discard — the first Discard scan
      // must not have committed anything yet either.
      expect(screen.queryByText('Scan an error label')).not.toBeInTheDocument();
      expect(discardCall.body).toBeNull();

      await scan('BBX-discard');

      expect(await screen.findByText('Bin discarded and unlinked')).toBeInTheDocument();
      expect(discardCall.body).toEqual({ payload: 'BBN-BUT-1' });
    });

    it('abandons the discard confirmation if anything else is scanned instead', async () => {
      mockNoSession();
      mockBinResolve();
      const discardCall = mockBinDiscard({ result: 'discarded' });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBN-BUT-1');
      await screen.findByText('Scan this bin again for visual QC');
      await scan('BBX-discard');
      await screen.findByText('Scan Discard again to confirm');

      await scan('BBN-KNB-1');

      expect(discardCall.body).toBeNull();
    });
  });

  describe('fit check and rework (§5.4a/§5.4b, phase 9a/9b) — locations, not stations', () => {
    const RECORDED_PART = { id: 42, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, part_code: 'TOP', labeled_at: '2026-08-24T10:00:00' };
    const RECORDED_PRINTER = { id: 12, name: 'P1S-3' };
    const RECORDED_ARCHIVE = { id: 88, print_name: 'bracket_v4', completed_at: '2026-08-24T14:32:00', quantity: 4 };

    beforeEach(() => {
      // Idle part scans validate against inventory before they can enter the
      // location flow. Keep the existing location-flow tests focused on
      // their respective commit by giving them a linked part by default.
      server.use(
        http.get('/api/v1/floor/inventory/parts/by-sticker/:stickerCode', ({ params }) => HttpResponse.json({
          id: 42,
          sticker_code: params.stickerCode,
          printer_id: 12,
          printer_name: 'P1S-3',
          archive_id: 88,
          part_code: 'TOP',
          section_part_id: null,
          part_name: 'Top Housing',
          part_source: 'Production',
          print_name: 'bracket_v4',
          labeled_at: '2026-08-24T10:00:00',
          archived_at: null,
          released_at: null,
          latest_event_action: null,
          latest_event_reason: null,
        })),
        http.get('/api/v1/floor/inventory/parts/:partId/events', () => HttpResponse.json([
          {
            id: 1,
            action: 'enrolled',
            details: { archive_id: 88 },
            occurred_at: '2026-08-24T10:00:00',
          },
        ])),
      );
    });

    function mockFitCheckScan(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/locations/fit-check/part', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    function mockReworkScan(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/locations/rework/part', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    it('prompts for a location only after confirming the part is registered and linked', async () => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBD-000042');

      expect(await screen.findByText('BBD-000042')).toBeInTheDocument();
      expect(screen.getByText('Scan a location')).toBeInTheDocument();
      // No station opened — this is not a session, so nothing was posted to
      // the station-scan endpoint for it.
      expect(screen.queryByText('WIP')).not.toBeInTheDocument();
    });

    it('shows read-only part history while awaiting a location scan', async () => {
      mockNoSession();
      server.use(
        http.get('/api/v1/floor/inventory/parts/:partId/events', () => HttpResponse.json([
          {
            id: 1,
            action: 'enrolled',
            details: { archive_id: 88 },
            occurred_at: '2026-08-24T10:00:00',
          },
          {
            id: 2,
            action: 'fit_checked',
            details: null,
            occurred_at: '2026-08-24T11:30:00',
          },
          {
            id: 3,
            action: 'wip',
            details: null,
            occurred_at: '2026-08-24T12:00:00',
          },
        ])),
      );
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBD-000042');

      expect(await screen.findByText('History')).toBeInTheDocument();
      expect(await screen.findByText('Fit Check Pass')).toBeInTheDocument();
      expect(screen.getByText('In WIP')).toBeInTheDocument();
      expect(screen.getByText('Sticker enrolled · linked at harvest')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /change status/i })).not.toBeInTheDocument();
    });

    it('commits Initial QC Pass on the location scan that follows, with no device_id involved', async () => {
      mockNoSession();
      const captured = mockFitCheckScan({
        result: 'recorded',
        part: RECORDED_PART,
        printer: RECORDED_PRINTER,
        archive: RECORDED_ARCHIVE,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBD-000042');
      await screen.findByText('Scan a location');
      await scan('BBS-initial-qc-pass');

      expect(await screen.findByText('Fit Check Pass')).toBeInTheDocument();
      expect(screen.getByText('BBD-000042')).toBeInTheDocument();
      expect(captured.body).toEqual({ payload: 'BBD-000042' });
    });

    it('returns to idle once the confirmation flashes out', async () => {
      mockNoSession();
      mockFitCheckScan({ result: 'recorded', part: RECORDED_PART, printer: RECORDED_PRINTER, archive: RECORDED_ARCHIVE });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBD-000042');
        await screen.findByText('Scan a location');
        await scan('BBS-initial-qc-pass');
        await screen.findByText('Fit Check Pass');

        act(() => {
          vi.advanceTimersByTime(3100);
        });

        // Synchronous assert after the flash timer — findByText + fake timers
        // race under parallel load and flake (see harvest plate-closed flash test).
        expect(screen.getByText('Scan a code')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects a location scan with no part pending, specifically rather than as an unknown code', async () => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-initial-qc-pass');

      expect(await screen.findByText('Scan a part first')).toBeInTheDocument();
      expect(floorSound.playScanErrorTone).toHaveBeenCalled();
    });

    it('rejects an unregistered sticker without entering the location flow', async () => {
      mockNoSession();
      server.use(
        http.get('/api/v1/floor/inventory/parts/by-sticker/:stickerCode', () => new HttpResponse(null, { status: 404 })),
      );
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBD-000042');

      expect(await screen.findByText('Part is not registered — scan it at Harvest first')).toBeInTheDocument();
      expect(screen.queryByText('Scan a location')).not.toBeInTheDocument();
    });

    it('rejects a registered sticker that has no print link', async () => {
      mockNoSession();
      server.use(
        http.get('/api/v1/floor/inventory/parts/by-sticker/:stickerCode', ({ params }) => HttpResponse.json({
          id: 42,
          sticker_code: params.stickerCode,
          printer_id: 12,
          printer_name: 'P1S-3',
          archive_id: null,
          part_code: null,
          section_part_id: null,
          part_name: null,
          part_source: null,
          print_name: null,
          labeled_at: '2026-08-24T10:00:00',
          archived_at: null,
          released_at: null,
          latest_event_action: null,
          latest_event_reason: null,
        })),
      );
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBD-000042');

      expect(await screen.findByText('Part is not linked to a print — match it in Part history first')).toBeInTheDocument();
      expect(screen.queryByText('Scan a location')).not.toBeInTheDocument();
    });

    it('abandons a pending part when a station code is scanned instead of a location', async () => {
      mockNoSession();
      mockScan({
        result: 'opened',
        station_slug: 'harvest',
        station_name: 'Harvest',
        session: HARVEST_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');

      await scan('BBS-harvest');

      expect(await screen.findByText('Harvest')).toBeInTheDocument();
      expect(screen.queryByText('Scan a location')).not.toBeInTheDocument();
    });

    it('does not commit on the Rework location scan — it only advances to asking why', async () => {
      mockNoSession();
      const reworkCall = mockReworkScan({ result: 'recorded', part: RECORDED_PART, printer: RECORDED_PRINTER, archive: RECORDED_ARCHIVE });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');

      await scan('BBS-rework');

      expect(await screen.findByText('Scan an error label')).toBeInTheDocument();
      expect(screen.getByText('Rework')).toBeInTheDocument();
      expect(reworkCall.body).toBeNull();
    });

    it('commits Rework on the reason scan, sending the bare reason code', async () => {
      mockNoSession();
      const captured = mockReworkScan({ result: 'recorded', part: RECORDED_PART, printer: RECORDED_PRINTER, archive: RECORDED_ARCHIVE });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');
      await scan('BBS-rework');
      await screen.findByText('Scan an error label');

      await scan('BBR-doesnt_fit');

      expect(await screen.findByText('Sent to Rework · doesnt_fit')).toBeInTheDocument();
      expect(captured.body).toEqual({ payload: 'BBD-000042', reason_code: 'doesnt_fit' });
    });

    it('rejects a reason scan with no part pending in Rework', async () => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBR-other');

      expect(await screen.findByText('Scan a part into Rework first')).toBeInTheDocument();
    });

    it('blocks a bin from being scanned into Rework instead of silently abandoning the pending part', async () => {
      mockNoSession();
      const reworkCall = mockReworkScan({ result: 'recorded', part: RECORDED_PART, printer: RECORDED_PRINTER, archive: RECORDED_ARCHIVE });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');
      await scan('BBS-rework');
      await screen.findByText('Scan an error label');

      await scan('BBN-BUT-1');

      expect(
        await screen.findByText("Bins aren't supported for Rework — scan a part instead"),
      ).toBeInTheDocument();
      expect(reworkCall.body).toBeNull();
    });

    it('blocks a bin from interrupting a part pending at the location prompt', async () => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');

      await scan('BBN-KNB-1');

      expect(
        await screen.findByText('A part is still pending — scan its location, not a bin'),
      ).toBeInTheDocument();
    });
  });

  describe('item→location pipeline (scan item, then location QR)', () => {
    const LOC_PART = { id: 42, sticker_code: 'BBD-000042', printer_id: 12, archive_id: 88, part_code: 'BOT', labeled_at: '2026-08-24T10:00:00' };
    const LOC_PRINTER = { id: 12, name: 'P1S-3' };
    const LOC_ARCHIVE = { id: 88, print_name: 'bracket_v4', completed_at: '2026-08-24T14:32:00', quantity: 4 };

    function mockInventoryPart(partCode: string) {
      server.use(
        http.get('/api/v1/floor/inventory/parts/by-sticker/:stickerCode', ({ params }) => HttpResponse.json({
          id: 42,
          sticker_code: params.stickerCode,
          printer_id: 12,
          printer_name: 'P1S-3',
          archive_id: 88,
          part_code: partCode,
          section_part_id: null,
          part_name: 'Part',
          part_source: 'Production',
          print_name: 'bracket_v4',
          labeled_at: '2026-08-24T10:00:00',
          archived_at: null,
          released_at: null,
          latest_event_action: null,
          latest_event_reason: null,
        })),
      );
    }

    function mockPartLocation(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/locations/part', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    const BIN_BATCH = {
      id: 91,
      payload: 'BBN-KNB-1',
      bin_number: 1,
      printer_id: 12,
      printer_name: 'P1S-3',
      archive_id: 88,
      print_name: 'knob_plate',
      part_code: 'KNB',
      quantity: 25,
      qc_passed_quantity: 25,
      remaining_quantity: 25,
      status: 'visual_qc_passed',
      harvested_at: '2026-08-26T14:35:00',
    };

    function mockBinResolve() {
      server.use(
        http.post('/api/v1/floor/bins/resolve', () => HttpResponse.json({
          result: 'ready_for_qc',
          bin: { payload: 'BBN-KNB-1', bin_number: 1, part_code: 'KNB', part_name: 'Knob bin' },
          batch: BIN_BATCH,
          printer: null,
          session: null,
          blocking: null,
          archive: null,
        })),
      );
    }

    function mockBinLocation(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/locations/bin', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    it('sends a BOT part to Production WIP, posting the item and the location slug', async () => {
      mockNoSession();
      mockInventoryPart('BOT');
      const captured = mockPartLocation({ result: 'recorded', part: LOC_PART, printer: LOC_PRINTER, archive: LOC_ARCHIVE });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');

      await scan('BBS-production-wip');

      expect(await screen.findByText('Added to production WIP')).toBeInTheDocument();
      expect(captured.body).toEqual({ payload: 'BBD-000042', location_slug: 'production-wip' });
    });

    it('stages a part at Ready-for-Production Inventory', async () => {
      mockNoSession();
      mockInventoryPart('BOT');
      const captured = mockPartLocation({ result: 'recorded', part: LOC_PART, printer: LOC_PRINTER, archive: LOC_ARCHIVE });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');

      await scan('BBS-ready-for-production-inventory');

      expect(await screen.findByText('Staged for Production')).toBeInTheDocument();
      expect(captured.body).toEqual({ payload: 'BBD-000042', location_slug: 'ready-for-production-inventory' });
    });

    it('refuses a BOT part at a finishing bench with the wrong-part-type reason', async () => {
      mockNoSession();
      mockInventoryPart('BOT');
      mockPartLocation({ result: 'wrong_part_type', part: null, printer: null, archive: null });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');

      await scan('BBS-support-removal');

      expect(await screen.findByText('Finishing steps apply to TOP parts only')).toBeInTheDocument();
      expect(floorSound.playScanErrorTone).toHaveBeenCalled();
    });

    it('refuses a TOP part at Production WIP before its finishing steps are done', async () => {
      mockNoSession();
      mockInventoryPart('TOP');
      mockPartLocation({ result: 'finishing_required', part: null, printer: null, archive: null });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');

      await scan('BBS-production-wip');

      expect(await screen.findByText('Finish Support, Overhang and Hot Air removal first')).toBeInTheDocument();
    });

    it('refuses a shipped housing at a location until its serial is unlinked', async () => {
      mockNoSession();
      mockInventoryPart('TOP');
      mockPartLocation({ result: 'shipped', part: null, printer: null, archive: null });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');

      await scan('BBS-production-wip');

      expect(
        await screen.findByText('Part is shipped on a product serial — unlink it first'),
      ).toBeInTheDocument();
      expect(floorSound.playScanErrorTone).toHaveBeenCalled();
    });

    it('refuses the Empty Bin location for a pending part without calling the API', async () => {
      mockNoSession();
      mockInventoryPart('BOT');
      const captured = mockPartLocation({ result: 'recorded', part: LOC_PART, printer: LOC_PRINTER, archive: LOC_ARCHIVE });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');

      await scan('BBS-bin-empty');

      expect(await screen.findByText("This location isn't available for parts")).toBeInTheDocument();
      expect(captured.body).toBeNull();
    });

    it('sends a QC-passed bin to Production WIP', async () => {
      mockNoSession();
      mockBinResolve();
      const captured = mockBinLocation({
        result: 'wip_recorded', bin: null, batch: { ...BIN_BATCH, status: 'wip' }, printer: null, session: null, blocking: null, archive: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBN-KNB-1');
      await screen.findByText('Scan WIP when this bin goes into use');

      await scan('BBS-production-wip');

      expect(await screen.findByText('Bin added to WIP')).toBeInTheDocument();
      expect(captured.body).toEqual({ payload: 'BBN-KNB-1', location_slug: 'production-wip' });
    });

    it('refuses a bin at Production WIP when visual QC has not passed', async () => {
      mockNoSession();
      mockBinResolve();
      mockBinLocation({ result: 'qc_required', bin: null, batch: null, printer: null, session: null, blocking: null, archive: null });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBN-KNB-1');
      await screen.findByText('Scan WIP when this bin goes into use');

      await scan('BBS-production-wip');

      expect(await screen.findByText('Visual QC is required before WIP')).toBeInTheDocument();
    });

    it('stages a bin at Ready-for-Production Inventory', async () => {
      mockNoSession();
      mockBinResolve();
      mockBinLocation({
        result: 'ready_for_production_recorded', bin: null, batch: { ...BIN_BATCH, status: 'ready_for_production' }, printer: null, session: null, blocking: null, archive: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBN-KNB-1');
      await screen.findByText('Scan WIP when this bin goes into use');

      await scan('BBS-ready-for-production-inventory');

      expect(await screen.findByText('Bin Staged for Production')).toBeInTheDocument();
    });

    it('releases a bin at the Empty Bin location', async () => {
      mockNoSession();
      mockBinResolve();
      mockBinLocation({
        result: 'empty_recorded', bin: null, batch: { ...BIN_BATCH, status: 'empty', quantity: 0 }, printer: null, session: null, blocking: null, archive: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBN-KNB-1');
      await screen.findByText('Scan WIP when this bin goes into use');

      await scan('BBS-bin-empty');

      expect(await screen.findByText('Bin marked empty and ready to reuse')).toBeInTheDocument();
    });

    it('refuses Empty Bin before the bin has entered WIP', async () => {
      mockNoSession();
      mockBinResolve();
      mockBinLocation({ result: 'empty_requires_wip', bin: null, batch: null, printer: null, session: null, blocking: null, archive: null });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBN-KNB-1');
      await screen.findByText('Scan WIP when this bin goes into use');

      await scan('BBS-bin-empty');

      expect(await screen.findByText('A bin can only be marked empty after it has entered WIP')).toBeInTheDocument();
    });

    it('refuses a TOP finishing bench for a pending bin without calling the API', async () => {
      mockNoSession();
      mockBinResolve();
      const captured = mockBinLocation({ result: 'wip_recorded', bin: null, batch: BIN_BATCH, printer: null, session: null, blocking: null, archive: null });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBN-KNB-1');
      await screen.findByText('Scan WIP when this bin goes into use');

      await scan('BBS-support-removal');

      expect(await screen.findByText("This location isn't available for bins")).toBeInTheDocument();
      expect(captured.body).toBeNull();
    });
  });

  describe('kit reassign on a TOP lookup (Part Assembly Linking, Wave 1)', () => {
    const KIT_PART = {
      id: 42,
      sticker_code: 'BBD-000042',
      printer_id: 12,
      printer_name: 'P1S-3',
      archive_id: 88,
      part_code: 'TOP',
      section_part_id: null,
      part_name: 'Top Housing',
      part_source: 'Production',
      print_name: 'bracket_v4',
      labeled_at: '2026-08-24T10:00:00',
      archived_at: null,
      released_at: null,
      latest_event_action: 'wip',
      latest_event_reason: null,
      kit_knob_batch_id: 91,
      kit_button_batch_id: 92,
    };

    function mockPartLookup(overrides: Record<string, unknown> = {}) {
      server.use(
        http.get('/api/v1/floor/inventory/parts/by-sticker/:stickerCode', ({ params }) =>
          HttpResponse.json({ ...KIT_PART, sticker_code: params.stickerCode, ...overrides }),
        ),
        http.get('/api/v1/floor/inventory/parts/:partId/events', () => HttpResponse.json([])),
      );
    }

    function mockReassign(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/parts/kit/reassign', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    it('offers per-slot reassign controls for a TOP part that already has a kit', async () => {
      mockNoSession();
      mockPartLookup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBD-000042');

      expect(await screen.findByRole('button', { name: 'Reassign knob' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reassign button' })).toBeInTheDocument();
    });

    it('shows no reassign controls for a BOT part with no kit', async () => {
      mockNoSession();
      mockPartLookup({ part_code: 'BOT', kit_knob_batch_id: null, kit_button_batch_id: null });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBD-000042');
      await screen.findByText('Scan a location');

      expect(screen.queryByRole('button', { name: 'Reassign knob' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reassign button' })).not.toBeInTheDocument();
    });

    it('does not start reassign on a bare bin scan — the on-screen tap is required first', async () => {
      mockNoSession();
      mockPartLookup();
      const reassign = mockReassign({ result: 'reassigned' });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByRole('button', { name: 'Reassign knob' });

      await scan('BBN-KNB-1');

      expect(
        await screen.findByText('A part is still pending — scan its location, not a bin'),
      ).toBeInTheDocument();
      expect(reassign.body).toBeNull();
    });

    it('reassigns the knob slot to the next matching bin after tapping Reassign knob', async () => {
      mockNoSession();
      mockPartLookup();
      const reassign = mockReassign({
        result: 'reassigned',
        part: { ...KIT_PART, kit_knob_batch_id: 93 },
        slot: 'KNB',
        previous_batch_id: 91,
        new_batch_id: 93,
        previous_remaining: 10,
        new_remaining: 4,
      });
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');

      await user.click(await screen.findByRole('button', { name: 'Reassign knob' }));
      expect(await screen.findByText('Scan a KNB bin to reassign')).toBeInTheDocument();

      await scan('BBN-KNB-2');

      await waitFor(() => expect(reassign.body).not.toBeNull());
      expect(reassign.body).toEqual({ payload: 'BBD-000042', bin_payload: 'BBN-KNB-2' });
      // The note carries the new fill's remaining count so the operator sees
      // the reassign took without leaving the still-useful part lookup.
      expect(await screen.findByText('Kit reassigned · 4 left')).toBeInTheDocument();
    });

    it('rings the error tone and stays pending when the wrong bin type is scanned', async () => {
      mockNoSession();
      mockPartLookup();
      const reassign = mockReassign({ result: 'reassigned' });
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await user.click(await screen.findByRole('button', { name: 'Reassign knob' }));
      await screen.findByText('Scan a KNB bin to reassign');

      await scan('BBN-BUT-1');

      await waitFor(() => expect(floorSound.playScanErrorTone).toHaveBeenCalled());
      expect(reassign.body).toBeNull();
      // Still pending on the same slot — a wrong bin does not abort reassign.
      expect(screen.getByText('Scan a KNB bin to reassign')).toBeInTheDocument();
    });

    it('cancels reassign mode from the on-screen control', async () => {
      mockNoSession();
      mockPartLookup();
      const reassign = mockReassign({ result: 'reassigned' });
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await user.click(await screen.findByRole('button', { name: 'Reassign knob' }));
      await screen.findByText('Scan a KNB bin to reassign');

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(await screen.findByText('Scan a location')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reassign knob' })).toBeInTheDocument();
      expect(reassign.body).toBeNull();
    });

    it('refuses a location QR while reassign is armed and stays pending', async () => {
      mockNoSession();
      mockPartLookup();
      const reassign = mockReassign({ result: 'reassigned' });
      const locationBody: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/locations/part', async ({ request }) => {
          locationBody.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ result: 'recorded' });
        }),
      );
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await user.click(await screen.findByRole('button', { name: 'Reassign knob' }));
      await screen.findByText('Scan a KNB bin to reassign');

      await scan('BBS-production-wip');

      await waitFor(() => expect(floorSound.playScanErrorTone).toHaveBeenCalled());
      expect(locationBody.body).toBeNull();
      expect(reassign.body).toBeNull();
      expect(screen.getByText('Scan a KNB bin to reassign')).toBeInTheDocument();
    });
  });

  describe('product-serial assembly linking ceremony (Part Assembly Linking, Wave 2)', () => {
    const UNIT = {
      id: 7,
      serial_code: 'XG2SNP',
      top_part_id: 100,
      bottom_part_id: 200,
      top_sticker: 'BBD-000100',
      bottom_sticker: 'BBD-000200',
      top_part_code: 'TOP',
      bottom_part_code: 'BOT',
      knob_batch_id: 91,
      button_batch_id: 92,
      knob_bin_payload: 'BBN-KNB-1',
      button_bin_payload: 'BBN-BUT-1',
      linked_at: '2026-08-28T12:00:00',
    };

    /** by-serial: 404 = free (start ceremony); a unit = already linked. */
    function mockBySerial(unit: unknown | null) {
      server.use(
        http.get('/api/v1/floor/units/by-serial/:code', () =>
          unit === null ? new HttpResponse(null, { status: 404 }) : HttpResponse.json(unit),
        ),
      );
    }

    /** by-part: 404 = free housing (item→location); a unit = already linked. */
    function mockByPart(unit: unknown | null) {
      server.use(
        http.get('/api/v1/floor/units/by-part/:sticker', () =>
          unit === null ? new HttpResponse(null, { status: 404 }) : HttpResponse.json(unit),
        ),
      );
    }

    /** by-sticker part lookup keyed on the sticker → its TOP/BOT code. */
    function mockParts(codesBySticker: Record<string, string>) {
      server.use(
        http.get('/api/v1/floor/inventory/parts/by-sticker/:stickerCode', ({ params }) => {
          const sticker = String(params.stickerCode);
          const code = codesBySticker[sticker];
          if (code === undefined) return new HttpResponse(null, { status: 404 });
          return HttpResponse.json({
            id: sticker === 'BBD-000100' ? 100 : 200,
            sticker_code: sticker,
            printer_id: 12,
            printer_name: 'P1S-3',
            archive_id: 88,
            part_code: code,
            section_part_id: null,
            part_name: code === 'TOP' ? 'Top Housing' : 'Bottom Housing',
            part_source: 'Production',
            print_name: 'bracket_v4',
            labeled_at: '2026-08-24T10:00:00',
            archived_at: null,
            released_at: null,
            latest_event_action: 'wip',
            latest_event_reason: null,
            kit_knob_batch_id: code === 'TOP' ? 91 : null,
            kit_button_batch_id: code === 'TOP' ? 92 : null,
          });
        }),
      );
    }

    function mockLink(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/units/link', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    function mockUnlink(response: unknown, status = 200) {
      const captured: { calls: number } = { calls: 0 };
      server.use(
        http.post('/api/v1/floor/units/:id/unlink', () => {
          captured.calls += 1;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    it('starts the ceremony for an unlinked serial', async () => {
      mockNoSession();
      mockBySerial(null);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('XG2SNP');

      expect(await screen.findByText('Scan a top or a bottom')).toBeInTheDocument();
    });

    it('links a top and a bottom, posting the serial and both stickers', async () => {
      mockNoSession();
      mockBySerial(null);
      mockParts({ 'BBD-000100': 'TOP', 'BBD-000200': 'BOT' });
      const link = mockLink({ result: 'linked', unit: UNIT });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('XG2SNP');
      await screen.findByText('Scan a top or a bottom');
      await scan('BBD-000100');
      expect(await screen.findByText('Scan the other housing')).toBeInTheDocument();
      await scan('BBD-000200');

      await waitFor(() => expect(link.body).not.toBeNull());
      expect(link.body).toEqual({
        serial: 'XG2SNP',
        top_sticker: 'BBD-000100',
        bottom_sticker: 'BBD-000200',
      });
    });

    it('links regardless of housing scan order (bottom first, then top)', async () => {
      mockNoSession();
      mockBySerial(null);
      mockParts({ 'BBD-000100': 'TOP', 'BBD-000200': 'BOT' });
      const link = mockLink({ result: 'linked', unit: UNIT });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('XG2SNP');
      await screen.findByText('Scan a top or a bottom');
      await scan('BBD-000200');
      await screen.findByText('Scan the other housing');
      await scan('BBD-000100');

      await waitFor(() => expect(link.body).not.toBeNull());
      expect(link.body).toEqual({
        serial: 'XG2SNP',
        top_sticker: 'BBD-000100',
        bottom_sticker: 'BBD-000200',
      });
    });

    it('refuses two tops (TOP+TOP) and keeps the serial pending, no write', async () => {
      mockNoSession();
      mockBySerial(null);
      mockParts({ 'BBD-000100': 'TOP', 'BBD-000101': 'TOP' });
      const link = mockLink({ result: 'linked', unit: UNIT });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('XG2SNP');
      await screen.findByText('Scan a top or a bottom');
      await scan('BBD-000100');
      await screen.findByText('Scan the other housing');
      await scan('BBD-000101');

      await waitFor(() => expect(floorSound.playScanErrorTone).toHaveBeenCalled());
      expect(link.body).toBeNull();
      // Still pending — the ceremony is not aborted by the mismatch.
      expect(screen.getByText('Scan the other housing')).toBeInTheDocument();
    });

    it('keeps the ceremony pending when an unregistered housing is scanned', async () => {
      mockNoSession();
      mockBySerial(null);
      server.use(
        http.get('/api/v1/floor/inventory/parts/by-sticker/:stickerCode', () =>
          HttpResponse.json({ detail: 'Not found' }, { status: 404 }),
        ),
      );
      const link = mockLink({ result: 'linked', unit: UNIT });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('XG2SNP');
      await screen.findByText('Scan a top or a bottom');
      await scan('BBD-000999');

      await waitFor(() => expect(floorSound.playScanErrorTone).toHaveBeenCalled());
      expect(link.body).toBeNull();
      expect(screen.getByText('Scan a top or a bottom')).toBeInTheDocument();
    });

    it('shows a read-only card for an already-linked serial and never starts a ceremony', async () => {
      mockNoSession();
      mockBySerial(UNIT);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('XG2SNP');

      expect(await screen.findByText('BBD-000100')).toBeInTheDocument();
      expect(screen.getByText('BBD-000200')).toBeInTheDocument();
      expect(screen.queryByText('Scan a top or a bottom')).not.toBeInTheDocument();
    });

    it('opens the same linked-unit card when an already-linked housing sticker is scanned at idle', async () => {
      mockNoSession();
      mockByPart(UNIT);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBD-000100');

      expect(await screen.findByText('Linked unit')).toBeInTheDocument();
      expect(screen.getByText('XG2SNP')).toBeInTheDocument();
      expect(screen.getByText('BBD-000200')).toBeInTheDocument();
      expect(screen.queryByText('Scan a location')).not.toBeInTheDocument();
    });

    it('dismisses the linked-unit card when the same housing is scanned again', async () => {
      mockNoSession();
      mockByPart(UNIT);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000100');
      await screen.findByText('Linked unit');

      await scan('BBD-000200');

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
      expect(screen.queryByText('Linked unit')).not.toBeInTheDocument();
    });

    it('unlinks from the already-linked card after confirming', async () => {
      mockNoSession();
      mockBySerial(UNIT);
      const unlink = mockUnlink({ result: 'unlinked', unit_id: 7, serial_code: 'XG2SNP' });
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('XG2SNP');
      await screen.findByText('BBD-000100');

      await user.click(await screen.findByRole('button', { name: 'Unlink' }));
      await user.click(await screen.findByRole('button', { name: 'Confirm unlink' }));

      await waitFor(() => expect(unlink.calls).toBe(1));
    });
  });

  describe('bin remaining subtract pad (Part Assembly Linking, Wave 1)', () => {
    const WIP_BATCH = {
      id: 91,
      payload: 'BBN-KNB-1',
      bin_number: 1,
      printer_id: 12,
      printer_name: 'P1S-3',
      archive_id: 88,
      print_name: 'knob_plate',
      part_code: 'KNB',
      quantity: 25,
      qc_passed_quantity: 25,
      remaining_quantity: 5,
      status: 'wip',
      harvested_at: '2026-08-26T14:35:00',
    };

    function mockResolve(batch: Record<string, unknown>) {
      server.use(
        http.post('/api/v1/floor/bins/resolve', () =>
          HttpResponse.json({
            result: 'ready_for_qc',
            bin: { payload: 'BBN-KNB-1', bin_number: 1, part_code: 'KNB', part_name: 'Knob bin' },
            batch,
            printer: null,
            session: null,
            blocking: null,
            archive: null,
          }),
        ),
      );
    }

    function mockAdjust(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/bins/adjust', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    it('shows remaining and a subtract pad for an In-WIP bin with remaining left', async () => {
      mockNoSession();
      mockResolve(WIP_BATCH);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBN-KNB-1');

      expect(await screen.findByText('In WIP')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Subtract' })).toBeInTheDocument();
    });

    it('does not show a subtract pad for a bin still awaiting visual QC', async () => {
      mockNoSession();
      mockResolve({ ...WIP_BATCH, status: 'harvested', qc_passed_quantity: null });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBN-KNB-1');
      await screen.findByText('Scan this bin again for visual QC');

      expect(screen.queryByRole('button', { name: 'Subtract' })).not.toBeInTheDocument();
    });

    it('does not show a subtract pad for a QC-passed bin not yet in WIP', async () => {
      mockNoSession();
      mockResolve({ ...WIP_BATCH, status: 'visual_qc_passed' });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBN-KNB-1');
      await screen.findByText('Scan WIP when this bin goes into use');

      expect(screen.queryByRole('button', { name: 'Subtract' })).not.toBeInTheDocument();
    });

    it('subtracts the chosen amount and refreshes the remaining count', async () => {
      mockNoSession();
      mockResolve(WIP_BATCH);
      const adjust = mockAdjust({
        result: 'adjusted',
        bin: null,
        batch: { ...WIP_BATCH, remaining_quantity: 2 },
        printer: null,
        session: null,
        blocking: null,
        archive: null,
        empty_bin_warning: false,
      });
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBN-KNB-1');
      await screen.findByRole('button', { name: 'Subtract' });

      await user.click(screen.getByRole('button', { name: 'Increase' }));
      await user.click(screen.getByRole('button', { name: 'Increase' }));
      await user.click(screen.getByRole('button', { name: 'Subtract' }));

      await waitFor(() => expect(adjust.body).not.toBeNull());
      expect(adjust.body).toEqual({ payload: 'BBN-KNB-1', subtract: 3 });
      expect(await screen.findByText('2')).toBeInTheDocument();
    });

    it('surfaces the empty-bin warning when the fill is taken to zero', async () => {
      mockNoSession();
      mockResolve({ ...WIP_BATCH, remaining_quantity: 1 });
      mockAdjust({
        result: 'adjusted',
        bin: null,
        batch: { ...WIP_BATCH, remaining_quantity: 0 },
        printer: null,
        session: null,
        blocking: null,
        archive: null,
        empty_bin_warning: true,
      });
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBN-KNB-1');
      await screen.findByRole('button', { name: 'Subtract' });

      await user.click(screen.getByRole('button', { name: 'Subtract' }));

      expect(await screen.findByText('Bin now empty — scan it off the line')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Subtract' })).not.toBeInTheDocument();
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
        station_slug: 'harvest',
        station_name: 'Harvest',
        session: HARVEST_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-harvest');

      await waitFor(() => expect(captured.body).not.toBeNull());
      expect(captured.body).toMatchObject({ payload: 'BBS-harvest' });
    });

    it('clears the field after each scan', async () => {
      mockNoSession();
      mockScan({
        result: 'opened',
        station_slug: 'harvest',
        station_name: 'Harvest',
        session: HARVEST_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-harvest');

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

    it('has a touch-only back control that returns to /floor', async () => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      const back = screen.getByRole('button', { name: 'Back to Floor' });
      expect(back).toHaveAttribute('tabindex', '-1');

      fireEvent.pointerDown(back, { pointerType: 'touch', button: 0 });

      expect(mockNavigate).toHaveBeenCalledWith('/floor');
    });

    it('does not go back when a wedge scanner sends Enter at the back control', async () => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      const back = screen.getByRole('button', { name: 'Back to Floor' });
      back.focus();
      fireEvent.keyDown(back, { key: 'Enter' });
      fireEvent.keyUp(back, { key: 'Enter' });

      expect(mockNavigate).not.toHaveBeenCalled();
      expect(screen.getByText('Scan a code')).toBeInTheDocument();
    });

    it('captures a wedge scan at window level even when the hidden input is not the event target', async () => {
      mockNoSession();
      const captured = mockScan({
        result: 'opened',
        station_slug: 'harvest',
        station_name: 'Harvest',
        session: HARVEST_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      // Idle scan re-focuses the hidden field after pointer input; the pistol
      // still has to work if some other node briefly holds focus, so this
      // fires on window rather than the input.
      wedgeScanAtWindow('BBS-harvest');

      await waitFor(() => expect(captured.body).not.toBeNull());
      expect(captured.body).toMatchObject({ payload: 'BBS-harvest' });
      expect(await screen.findByText('Harvest')).toBeInTheDocument();
    });

    it('does not steal keystrokes while typing in a quantity input', async () => {
      mockNoSession();
      server.use(
        http.post('/api/v1/floor/bins/resolve', () =>
          HttpResponse.json({
            result: 'ready_for_qc',
            bin: { payload: 'BBN-BUT-1', bin_number: 1, part_code: 'BUT', part_name: 'Button bin' },
            batch: {
              id: 91,
              payload: 'BBN-BUT-1',
              bin_number: 1,
              printer_id: 12,
              printer_name: 'P1S-3',
              archive_id: 88,
              print_name: 'button_plate',
              part_code: 'BUT',
              quantity: 25,
              qc_passed_quantity: null,
              remaining_quantity: 25,
              status: 'harvested',
              harvested_at: '2026-08-26T14:35:00',
            },
            printer: null,
            session: null,
            blocking: null,
            archive: null,
          }),
        ),
      );
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBN-BUT-1');
      expect(await screen.findByText('Scan this bin again for visual QC')).toBeInTheDocument();
      await scan('BBN-BUT-1');
      const qtyInput = await screen.findByLabelText('Parts passed QC');
      await user.click(qtyInput);
      await user.type(qtyInput, '20');

      expect(qtyInput).toHaveValue(20);
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

      await scan('4001234567890');
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
        station_slug: 'harvest',
        station_name: 'Harvest',
        session: null,
        blocking: { ...HARVEST_SESSION, device_id: 'other', open_seconds: 600 },
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-harvest');
      expect(await screen.findByText('Harvest is open elsewhere')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(30000);
      });

      expect(screen.getByText('Harvest is open elsewhere')).toBeInTheDocument();
    });
  });

  describe('scan-page auto-dismiss (idle timeout + re-scan)', () => {
    // A TOP that has entered WIP with a kit assigned — the lookup that carries
    // the Reassign knob/button controls (Part Assembly Linking, Wave 1).
    const KIT_TOP = {
      id: 42,
      sticker_code: 'BBD-000042',
      printer_id: 12,
      printer_name: 'P1S-3',
      archive_id: 88,
      part_code: 'TOP',
      section_part_id: null,
      part_name: 'Top Housing',
      part_source: 'Production',
      print_name: 'bracket_v4',
      labeled_at: '2026-08-24T10:00:00',
      archived_at: null,
      released_at: null,
      latest_event_action: 'wip',
      latest_event_reason: null,
      kit_knob_batch_id: 91,
      kit_button_batch_id: 92,
    };

    function mockPartLookup(overrides: Record<string, unknown> = {}) {
      server.use(
        http.get('/api/v1/floor/inventory/parts/by-sticker/:stickerCode', ({ params }) =>
          HttpResponse.json({ ...KIT_TOP, sticker_code: params.stickerCode, ...overrides }),
        ),
        http.get('/api/v1/floor/inventory/parts/:partId/events', () => HttpResponse.json([])),
      );
    }

    function mockReassign(response: unknown, status = 200) {
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/parts/kit/reassign', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status });
        }),
      );
      return captured;
    }

    const WIP_BATCH = {
      id: 91,
      payload: 'BBN-KNB-1',
      bin_number: 1,
      printer_id: 12,
      printer_name: 'P1S-3',
      archive_id: 88,
      print_name: 'knob_plate',
      part_code: 'KNB',
      quantity: 25,
      qc_passed_quantity: 25,
      remaining_quantity: 5,
      status: 'wip',
      harvested_at: '2026-08-26T14:35:00',
    };

    function mockResolve(batch: Record<string, unknown>) {
      server.use(
        http.post('/api/v1/floor/bins/resolve', () =>
          HttpResponse.json({
            result: 'ready_for_qc',
            bin: { payload: 'BBN-KNB-1', bin_number: 1, part_code: 'KNB', part_name: 'Knob bin' },
            batch,
            printer: null,
            session: null,
            blocking: null,
            archive: null,
          }),
        ),
      );
    }

    it('dismisses a TOP-with-kit lookup back to idle after the 10s timeout', async () => {
      mockNoSession();
      mockPartLookup();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBD-000042');
        await screen.findByRole('button', { name: 'Reassign knob' });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_050);
        });

        expect(screen.getByText('Scan a code')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Reassign knob' })).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not dismiss a TOP-with-kit lookup before the 10s timeout', async () => {
      mockNoSession();
      mockPartLookup();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBD-000042');
        await screen.findByRole('button', { name: 'Reassign knob' });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(9_000);
        });

        expect(screen.getByRole('button', { name: 'Reassign knob' })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-scanning the same sticker closes the TOP-with-kit lookup to idle without failing', async () => {
      mockNoSession();
      mockPartLookup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByRole('button', { name: 'Reassign knob' });

      await scan('BBD-000042');

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reassign knob' })).not.toBeInTheDocument();
      // Closing to idle is not an error — no tone, no rejection message.
      expect(floorSound.playScanErrorTone).not.toHaveBeenCalled();
    });

    it('does not auto-dismiss a plain part lookup with no kit assigned', async () => {
      mockNoSession();
      mockPartLookup({ part_code: 'BOT', kit_knob_batch_id: null, kit_button_batch_id: null });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBD-000042');
        await screen.findByText('Scan a location');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_050);
        });

        expect(screen.getByText('Scan a location')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('pauses the dismiss timeout while a kit reassign is armed', async () => {
      mockNoSession();
      mockPartLookup();
      mockReassign({ result: 'reassigned' });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBD-000042');
        fireEvent.click(await screen.findByRole('button', { name: 'Reassign knob' }));
        await screen.findByText('Scan a KNB bin to reassign');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_050);
        });

        // Armed and waiting for a bin — must not silently drop to idle.
        expect(screen.getByText('Scan a KNB bin to reassign')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('resumes the dismiss timeout after a reassign is cancelled', async () => {
      mockNoSession();
      mockPartLookup();
      mockReassign({ result: 'reassigned' });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBD-000042');
        fireEvent.click(await screen.findByRole('button', { name: 'Reassign knob' }));
        await screen.findByText('Scan a KNB bin to reassign');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await screen.findByText('Scan a location');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_050);
        });

        expect(screen.getByText('Scan a code')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('dismisses an In-WIP bin lookup back to idle after the 10s timeout', async () => {
      mockNoSession();
      mockResolve(WIP_BATCH);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBN-KNB-1');
        await screen.findByRole('button', { name: 'Subtract' });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_050);
        });

        expect(screen.getByText('Scan a code')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Subtract' })).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-scanning the same bin closes the In-WIP lookup to idle', async () => {
      mockNoSession();
      mockResolve(WIP_BATCH);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBN-KNB-1');
      await screen.findByRole('button', { name: 'Subtract' });

      await scan('BBN-KNB-1');

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Subtract' })).not.toBeInTheDocument();
    });

    it('does not auto-dismiss a bin still awaiting visual QC', async () => {
      mockNoSession();
      mockResolve({ ...WIP_BATCH, status: 'harvested', qc_passed_quantity: null });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBN-KNB-1');
        await screen.findByText('Scan this bin again for visual QC');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_050);
        });

        expect(screen.getByText('Scan this bin again for visual QC')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('resets the dismiss timeout while adjusting the subtract amount', async () => {
      mockNoSession();
      mockResolve(WIP_BATCH);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<FloorScanPage />);
        await screen.findByText('Scan a code');
        await scan('BBN-KNB-1');
        await screen.findByRole('button', { name: 'Subtract' });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(7_000);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Increase' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(7_000);
        });

        // 14s total elapsed, but only 7s since the last interaction — still up.
        expect(screen.getByRole('button', { name: 'Subtract' })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
