import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { FloorCodesPage } from '../../pages/FloorCodesPage';
import { server } from '../mocks/server';

const STATIONS = [
  { slug: 'wip', payload: 'BBS-wip', name: 'WIP', description: 'Production shelf.' },
  {
    slug: 'storage-receive',
    payload: 'BBS-storage-receive',
    name: '+ Storage',
    description: 'Warehouse shelf.',
  },
  { slug: 'harvest', payload: 'BBS-harvest', name: 'Harvest', description: 'Label parts.' },
];

/** Captures the body of the label-render POST so tests can assert what the
 *  page actually asked the backend to print. */
function mockStationsAndCapturePrint() {
  const captured: { body: Record<string, unknown> | null } = { body: null };
  server.use(
    http.get('/api/v1/floor/stations', () => HttpResponse.json(STATIONS)),
    http.post('/api/v1/floor/labels/stations', async ({ request }) => {
      captured.body = (await request.json()) as Record<string, unknown>;
      return new HttpResponse(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), {
        headers: { 'Content-Type': 'application/pdf' },
      });
    }),
  );
  return captured;
}

describe('FloorCodesPage', () => {
  beforeEach(() => {
    // localStorage is a shared vi.fn() spy from the global test setup, so a
    // mockReturnValue set by one test would otherwise answer *every* key in
    // the next one (including the theme, which then tries classList.add on a
    // JSON string). Reset it to "nothing stored" before each test.
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    vi.mocked(localStorage.setItem).mockReset();
    // jsdom implements neither of these; the page opens the returned PDF.
    window.URL.createObjectURL = vi.fn(() => 'blob:mock');
    window.URL.revokeObjectURL = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({} as Window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(localStorage.getItem).mockReset();
  });

  it('lists the stations returned by the API with their payloads', async () => {
    mockStationsAndCapturePrint();
    render(<FloorCodesPage />);

    expect(await screen.findByText('WIP')).toBeInTheDocument();
    expect(screen.getByText('+ Storage')).toBeInTheDocument();
    expect(screen.getByText('BBS-storage-receive')).toBeInTheDocument();
  });

  it('selects every station by default so the common "print the set" case is one click', async () => {
    mockStationsAndCapturePrint();
    render(<FloorCodesPage />);

    await screen.findByText('WIP');
    for (const station of STATIONS) {
      expect(screen.getByRole('checkbox', { name: station.name })).toBeChecked();
    }
    expect(screen.getByRole('button', { name: /Print selected \(3\)/ })).toBeEnabled();
  });

  it('prints the selected payloads at the chosen preset size', async () => {
    const captured = mockStationsAndCapturePrint();
    const user = userEvent.setup();
    render(<FloorCodesPage />);

    await screen.findByText('WIP');
    await user.click(screen.getByRole('checkbox', { name: '+ Storage' }));
    await user.click(screen.getByRole('button', { name: '80 × 80 mm' }));
    await user.click(screen.getByRole('button', { name: /Print selected \(2\)/ }));

    await waitFor(() => expect(captured.body).not.toBeNull());
    // Deselected station is excluded; catalog order is preserved.
    expect(captured.body).toEqual({
      payloads: ['BBS-wip', 'BBS-harvest'],
      width_mm: 80,
      height_mm: 80,
    });
    expect(window.open).toHaveBeenCalled();
  });

  it('supports a non-square custom size', async () => {
    const captured = mockStationsAndCapturePrint();
    const user = userEvent.setup();
    render(<FloorCodesPage />);

    await screen.findByText('WIP');
    await user.click(screen.getByRole('button', { name: 'Custom' }));

    const widthInput = screen.getByLabelText('Width (mm)');
    await user.clear(widthInput);
    await user.type(widthInput, '80');
    const heightInput = screen.getByLabelText('Height (mm)');
    await user.clear(heightInput);
    await user.type(heightInput, '40');

    await user.click(screen.getByRole('button', { name: /Print selected \(3\)/ }));

    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.body).toMatchObject({ width_mm: 80, height_mm: 40 });
  });

  it('blocks printing at a size the backend would reject', async () => {
    mockStationsAndCapturePrint();
    const user = userEvent.setup();
    render(<FloorCodesPage />);

    await screen.findByText('WIP');
    await user.click(screen.getByRole('button', { name: 'Custom' }));

    const widthInput = screen.getByLabelText('Width (mm)');
    await user.clear(widthInput);
    await user.type(widthInput, '5'); // below the 20 mm floor

    expect(await screen.findByText(/Size must be between/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Print selected \(3\)/ })).toBeDisabled();
  });

  it('blocks printing when nothing is selected', async () => {
    mockStationsAndCapturePrint();
    const user = userEvent.setup();
    render(<FloorCodesPage />);

    await screen.findByText('WIP');
    await user.click(screen.getByRole('button', { name: 'Select none' }));

    expect(screen.getByRole('button', { name: /Print selected \(0\)/ })).toBeDisabled();
  });

  // localStorage is a non-persisting spy in the global test setup, so the
  // round trip is covered as two halves: what gets written, and that a
  // written value is honoured on the next mount.
  it('persists the chosen size', async () => {
    mockStationsAndCapturePrint();
    const user = userEvent.setup();
    render(<FloorCodesPage />);

    await screen.findByText('WIP');
    await user.click(screen.getByRole('button', { name: '40 × 40 mm' }));

    await waitFor(() =>
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'floorCodeLabelSize',
        expect.stringContaining('"mode":"40"'),
      ),
    );
  });

  it('restores a previously stored size', async () => {
    mockStationsAndCapturePrint();
    // Key-scoped: the same spy answers the theme and sidebar lookups too.
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'floorCodeLabelSize' ? JSON.stringify({ mode: '40', width: 40, height: 40 }) : null,
    );
    render(<FloorCodesPage />);

    await screen.findByText('WIP');
    // The preset button renders active (green) when it is the stored size.
    expect(screen.getByRole('button', { name: '40 × 40 mm' }).className).toContain('bg-bambu-green');
  });

  it('falls back to the default size when the stored value is corrupt', async () => {
    mockStationsAndCapturePrint();
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'floorCodeLabelSize' ? 'not json{' : null,
    );
    render(<FloorCodesPage />);

    await screen.findByText('WIP');
    expect(screen.getByRole('button', { name: '60 × 60 mm' }).className).toContain('bg-bambu-green');
  });

  it('surfaces a backend failure instead of silently doing nothing', async () => {
    server.use(
      http.get('/api/v1/floor/stations', () => HttpResponse.json(STATIONS)),
      http.post('/api/v1/floor/labels/stations', () =>
        HttpResponse.json({ detail: 'Unknown station code(s): BBS-nope' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    render(<FloorCodesPage />);

    await screen.findByText('WIP');
    await user.click(screen.getByRole('button', { name: /Print selected \(3\)/ }));

    expect(await screen.findByText(/Unknown station code/)).toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('offers a retry when the station list fails to load', async () => {
    server.use(
      http.get('/api/v1/floor/stations', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })),
    );
    render(<FloorCodesPage />);

    expect(await screen.findByText('Could not load stations')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows the not-yet-built tabs as disabled rather than hiding them', async () => {
    mockStationsAndCapturePrint();
    render(<FloorCodesPage />);

    await screen.findByText('WIP');
    const tabs = screen.getByRole('button', { name: 'Station labels' }).parentElement as HTMLElement;
    expect(within(tabs).getByRole('button', { name: 'Printer labels' })).toBeDisabled();
    expect(within(tabs).getByRole('button', { name: 'Error labels' })).toBeDisabled();
  });
});
