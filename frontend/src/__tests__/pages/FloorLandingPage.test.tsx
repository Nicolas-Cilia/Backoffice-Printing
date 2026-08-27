import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { FloorLandingPage } from '../../pages/FloorLandingPage';
import { server } from '../mocks/server';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const OPEN_SESSION = {
  id: 1,
  station_slug: 'wip',
  station_name: 'WIP',
  device_id: 'someone-else',
  opened_at: '2026-08-24T10:00:00',
  open_seconds: 50400,
  closed_at: null,
  closed_by_takeover: false,
};

function mockSessions(overview: { open?: unknown[]; recent?: unknown[] } = {}) {
  server.use(
    http.get('/api/v1/floor/sessions', () =>
      HttpResponse.json({ open: overview.open ?? [], recent: overview.recent ?? [] }),
    ),
  );
}

describe('FloorLandingPage', () => {
  it('renders the Scan, Part history, and Codes destinations', () => {
    render(<FloorLandingPage />);

    expect(screen.getByRole('heading', { name: 'Floor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Scan' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open Part history' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open Codes' })).toBeEnabled();
  });

  it('navigates to /floor/scan when Scan is opened', async () => {
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await user.click(screen.getByRole('button', { name: 'Open Scan' }));

    expect(mockNavigate).toHaveBeenCalledWith('/floor/scan');
  });

  it('navigates to /floor/codes when Codes is opened', async () => {
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await user.click(screen.getByRole('button', { name: 'Open Codes' }));

    expect(mockNavigate).toHaveBeenCalledWith('/floor/codes');
  });

  it('navigates to /inventory when Part history is opened', async () => {
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await user.click(screen.getByRole('button', { name: 'Open Part history' }));

    expect(mockNavigate).toHaveBeenCalledWith('/inventory');
  });
});

describe('FloorLandingPage QC stat', () => {
  function mockPartsAndBins({
    parts = [],
    events = {},
    bins = [],
  }: { parts?: unknown[]; events?: Record<number, unknown[]>; bins?: unknown[] } = {}) {
    server.use(
      http.get('/api/v1/floor/inventory/parts', () => HttpResponse.json(parts)),
      http.get('/api/v1/floor/inventory/parts/:id/events', ({ params }) =>
        HttpResponse.json(events[Number(params.id)] ?? []),
      ),
      http.get('/api/v1/floor/inventory/bins', () => HttpResponse.json(bins)),
    );
  }

  it('counts a bin awaiting visual QC toward "Awaiting Initial QC Pass"', async () => {
    mockPartsAndBins({
      bins: [
        {
          payload: 'BUT-01',
          bin_number: 1,
          part_code: 'BUT',
          part_name: 'Button',
          status: 'harvested',
          batch: null,
        },
      ],
    });
    render(<FloorLandingPage />);

    const label = await screen.findByText('Awaiting Initial QC Pass');
    await waitFor(() => expect(label.parentElement).toHaveTextContent('1'));
  });

  it('does not count a bin that already passed visual QC', async () => {
    mockPartsAndBins({
      bins: [
        {
          payload: 'BUT-01',
          bin_number: 1,
          part_code: 'BUT',
          part_name: 'Button',
          status: 'visual_qc_passed',
          batch: null,
        },
      ],
    });
    render(<FloorLandingPage />);

    const label = await screen.findByText('Awaiting Initial QC Pass');
    await waitFor(() => expect(label.parentElement).toHaveTextContent('0'));
  });
});

describe('FloorLandingPage open-sessions panel', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    vi.mocked(localStorage.setItem).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists an open station with how long it has been held', async () => {
    mockSessions({ open: [OPEN_SESSION] });
    render(<FloorLandingPage />);

    expect(await screen.findByText('WIP')).toBeInTheDocument();
    // 14h reads as abandoned overnight — the whole basis for closing it.
    expect(screen.getByText(/open 14h 0m/)).toBeInTheDocument();
  });

  it('says whose session it is, not a meaningless device id', async () => {
    // A raw UUID tells a reader nothing; "is this mine or someone else's
    // mid-task" is the question that decides whether to close it.
    mockSessions({ open: [OPEN_SESSION] });
    render(<FloorLandingPage />);

    expect(await screen.findByText(/Another device/)).toBeInTheDocument();
    expect(screen.queryByText(/someone-else/)).not.toBeInTheDocument();
  });

  it('marks a session held by this device', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'floorDeviceId' ? 'my-device' : null,
    );
    mockSessions({ open: [{ ...OPEN_SESSION, device_id: 'my-device' }] });
    render(<FloorLandingPage />);

    expect(await screen.findByText(/This device/)).toBeInTheDocument();
  });

  it('closes a session and refreshes the list', async () => {
    let closed = false;
    server.use(
      http.get('/api/v1/floor/sessions', () =>
        HttpResponse.json({ open: closed ? [] : [OPEN_SESSION], recent: [] }),
      ),
      http.delete('/api/v1/floor/sessions/:id', () => {
        closed = true;
        return HttpResponse.json({ ...OPEN_SESSION, closed_at: '2026-08-24T12:00:00' });
      }),
    );
    const user = userEvent.setup();
    render(<FloorLandingPage />);
    await screen.findByText('WIP');

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(await screen.findByText('No stations are open.')).toBeInTheDocument();
  });

  it('says plainly when nothing is open', async () => {
    mockSessions();
    render(<FloorLandingPage />);

    expect(await screen.findByText('No stations are open.')).toBeInTheDocument();
  });

  it('hides history behind a toggle', async () => {
    const recent = [
      { ...OPEN_SESSION, id: 9, closed_at: '2026-08-24T11:00:00', open_seconds: 120 },
    ];
    mockSessions({ recent });
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await screen.findByText('No stations are open.');
    expect(screen.queryByText(/was open 2m/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Recent history' }));

    expect(await screen.findByText(/was open 2m/)).toBeInTheDocument();
  });

  it('flags a session that was taken over rather than closed', async () => {
    const recent = [
      {
        ...OPEN_SESSION,
        id: 9,
        closed_at: '2026-08-24T11:00:00',
        open_seconds: 120,
        closed_by_takeover: true,
      },
    ];
    mockSessions({ recent });
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await screen.findByText('No stations are open.');
    await user.click(screen.getByRole('button', { name: 'Recent history' }));

    expect(await screen.findByText('taken over')).toBeInTheDocument();
  });

  it('offers no history toggle when there is none', async () => {
    mockSessions();
    render(<FloorLandingPage />);

    await screen.findByText('No stations are open.');
    expect(screen.queryByRole('button', { name: 'Recent history' })).not.toBeInTheDocument();
  });

  it('surfaces a load failure with a retry', async () => {
    server.use(
      http.get('/api/v1/floor/sessions', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    );
    render(<FloorLandingPage />);

    expect(await screen.findByText('Could not load sessions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('does not break the picker cards', async () => {
    mockSessions({ open: [OPEN_SESSION] });
    render(<FloorLandingPage />);

    await screen.findByText('WIP');
    expect(screen.getByRole('button', { name: 'Open Scan' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open Part history' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open Codes' })).toBeEnabled();
  });
});

describe('FloorLandingPage unlabeled build-plates panel', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    vi.mocked(localStorage.setItem).mockReset();
    mockSessions();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const UNLABELED_PLATE = {
    id: 5,
    print_name: 'Cable guide',
    printer_name: 'P1S-3',
    completed_at: '2026-08-24T14:32:00',
  };

  function mockUnlabeledPlates(plates: unknown[] = []) {
    server.use(
      http.get('/api/v1/floor/parts/unlabeled-build-plates', () =>
        HttpResponse.json(plates),
      ),
    );
  }

  it('lists a completed job with no linked parts: job name and printer', async () => {
    mockUnlabeledPlates([UNLABELED_PLATE]);
    render(<FloorLandingPage />);

    expect(await screen.findByText('Cable guide')).toBeInTheDocument();
    expect(screen.getByText('P1S-3')).toBeInTheDocument();
    expect(
      screen.getByText(new Date(`${UNLABELED_PLATE.completed_at}Z`).toLocaleString()),
    ).toBeInTheDocument();
  });

  it('shows newest first, trusting the server order rather than re-sorting', async () => {
    const older = { ...UNLABELED_PLATE, id: 1, print_name: 'Older job', completed_at: '2026-08-20T09:00:00' };
    const newer = { ...UNLABELED_PLATE, id: 2, print_name: 'Newer job', completed_at: '2026-08-24T09:00:00' };
    mockUnlabeledPlates([newer, older]);
    render(<FloorLandingPage />);

    await screen.findByText('Newer job');
    const names = screen.getAllByText(/job$/).map((el) => el.textContent);
    expect(names).toEqual(['Newer job', 'Older job']);
  });

  it('says plainly when nothing is waiting, without reading as an error', async () => {
    mockUnlabeledPlates();
    render(<FloorLandingPage />);

    const empty = await screen.findByText('No build plates are waiting on parts.');
    expect(empty.className).not.toMatch(/text-red-500/);
  });

  it('surfaces a load failure with a retry', async () => {
    server.use(
      http.get('/api/v1/floor/parts/unlabeled-build-plates', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    );
    render(<FloorLandingPage />);

    expect(await screen.findByText('Could not load this list')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('does not disturb the open-sessions panel above it', async () => {
    mockSessions({ open: [OPEN_SESSION] });
    mockUnlabeledPlates([UNLABELED_PLATE]);
    render(<FloorLandingPage />);

    await screen.findByText('WIP');
    expect(await screen.findByText('Cable guide')).toBeInTheDocument();
  });
});

describe('FloorLandingPage non-production list', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    vi.mocked(localStorage.setItem).mockReset();
    mockSessions();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const DISMISSED_PLATE = {
    id: 7,
    print_name: 'Jig block',
    printer_name: 'P1S-2',
    completed_at: '2026-08-24T13:00:00',
    dismissed_at: '2026-08-24T15:00:00',
  };

  function mockDismissedPlates(plates: unknown[] = []) {
    server.use(
      http.get('/api/v1/floor/parts/unlabeled-build-plates', () => HttpResponse.json([])),
      http.get('/api/v1/floor/parts/dismissed-build-plates', () => HttpResponse.json(plates)),
    );
  }

  it('offers a Non-production list control in the panel header', async () => {
    mockDismissedPlates([DISMISSED_PLATE]);
    render(<FloorLandingPage />);

    expect(
      await screen.findByRole('button', { name: 'Non-production list' }),
    ).toBeInTheDocument();
  });

  it('shows the dismissed plates when the control is opened', async () => {
    mockDismissedPlates([DISMISSED_PLATE]);
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await user.click(await screen.findByRole('button', { name: 'Non-production list' }));

    expect(await screen.findByText('Jig block')).toBeInTheDocument();
    expect(screen.getByText('P1S-2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('restores a dismissed plate and drops it from the list', async () => {
    let restored = false;
    server.use(
      http.get('/api/v1/floor/parts/unlabeled-build-plates', () => HttpResponse.json([])),
      http.get('/api/v1/floor/parts/dismissed-build-plates', () =>
        HttpResponse.json(restored ? [] : [DISMISSED_PLATE]),
      ),
      http.post('/api/v1/floor/parts/dismissed-build-plates/:id/restore', () => {
        restored = true;
        return HttpResponse.json({ status: 'restored' });
      }),
    );
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await user.click(await screen.findByRole('button', { name: 'Non-production list' }));
    await screen.findByText('Jig block');

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(screen.queryByText('Jig block')).not.toBeInTheDocument());
  });

  it('says plainly when nothing has been dismissed', async () => {
    mockDismissedPlates();
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await user.click(await screen.findByRole('button', { name: 'Non-production list' }));

    expect(
      await screen.findByText('Nothing has been marked non-production.'),
    ).toBeInTheDocument();
  });
});
