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
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');
      await scan('BBS-initial-qc-pass');
      await screen.findByText('Fit Check Pass');

      await act(async () => {
        vi.advanceTimersByTime(3100);
      });

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
      vi.useRealTimers();
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
        station_slug: 'wip',
        station_name: 'WIP',
        session: WIP_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');
      await scan('BBD-000042');
      await screen.findByText('Scan a location');

      await scan('BBS-wip');

      expect(await screen.findByText('WIP')).toBeInTheDocument();
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
