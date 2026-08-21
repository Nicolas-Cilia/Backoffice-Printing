/**
 * Arrange button + custom printer order on the Printers tab.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { ArrangePrintersModal } from '../../components/ArrangePrintersModal';
import { clampArrangeDrag } from '../../utils/arrangePrinters';
import {
  applyPrinterCustomOrder,
  mergePrinterCustomOrder,
  movePrinterInOrder,
  PRINTER_CUSTOM_ORDER_KEY,
} from '../../utils/printerCustomOrder';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockPrinters = [
  {
    id: 1,
    name: 'X1 Carbon',
    ip_address: '192.168.1.100',
    serial_number: '00M09A350100001',
    access_code: '12345678',
    model: 'X1C',
    enabled: true,
    is_active: true,
    nozzle_diameter: 0.4,
    nozzle_type: 'hardened_steel',
    location: 'Workshop',
    auto_archive: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'P1S Backup',
    ip_address: '192.168.1.101',
    serial_number: '00W00A123456789',
    access_code: '87654321',
    model: 'P1S',
    enabled: false,
    is_active: true,
    nozzle_diameter: 0.4,
    nozzle_type: 'stainless_steel',
    location: null,
    auto_archive: true,
    created_at: '2024-01-02T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
  },
];

const mockPrinterStatus = {
  connected: true,
  state: 'IDLE',
  awaiting_plate_clear: false,
  progress: 0,
  layer_num: 0,
  total_layers: 0,
  temperatures: { nozzle: 25, bed: 25, chamber: 25 },
  remaining_time: 0,
  filename: null,
  wifi_signal: -50,
  vt_tray: [],
};

function cardIds(): string[] {
  return [...document.querySelectorAll('[id^="printer-card-"]')].map((el) => el.id);
}

function arrangeRowIds(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll('[data-testid^="arrange-printer-"]')].map(
    (el) => el.getAttribute('data-testid') || '',
  );
}

describe('printer custom order helpers', () => {
  it('moves a printer within the list', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(movePrinterInOrder(items, 1, 1).map((p) => p.id)).toEqual([2, 1, 3]);
    expect(movePrinterInOrder(items, 1, -1).map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it('applies a saved id order and appends unknown printers', () => {
    const items = [{ id: 3 }, { id: 1 }, { id: 2 }];
    expect(applyPrinterCustomOrder(items, [1, 2]).map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it('merges a filtered reorder without pinning hidden printers to the end', () => {
    expect(mergePrinterCustomOrder([3, 1], [1, 2, 3, 4], [1, 2, 3, 4])).toEqual([3, 2, 1, 4]);
    expect(mergePrinterCustomOrder([1, 2, 3, 4], [], [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });
});

describe('clampArrangeDrag', () => {
  const row = { top: 100, bottom: 140 };
  const list = { top: 80, bottom: 200 };

  it('zeros horizontal movement', () => {
    expect(clampArrangeDrag({ x: 400, y: 10, scaleX: 1, scaleY: 1 }, row, list).x).toBe(0);
  });

  it('does not let a row travel past the bottom of the list', () => {
    expect(clampArrangeDrag({ x: 0, y: 500, scaleX: 1, scaleY: 1 }, row, list).y).toBe(60);
  });

  it('does not let a row travel past the top of the list', () => {
    expect(clampArrangeDrag({ x: 0, y: -500, scaleX: 1, scaleY: 1 }, row, list).y).toBe(-20);
  });
});

describe('ArrangePrintersModal', () => {
  it('opens with printers and applies keyboard reorder on close', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();

    render(
      <ArrangePrintersModal
        isOpen
        title="Group 1"
        printers={[
          { id: 1, name: 'X1 Carbon', model: 'X1C' },
          { id: 2, name: 'P1S Backup', model: 'P1S' },
        ]}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Group 1')).toBeInTheDocument();
    expect(within(dialog).getByText('X1 Carbon')).toBeInTheDocument();
    expect(within(dialog).getByText('P1S Backup')).toBeInTheDocument();
    expect(within(screen.getByTestId('arrange-printer-1')).getByTestId('arrange-position')).toHaveTextContent('1');
    expect(within(screen.getByTestId('arrange-printer-2')).getByTestId('arrange-position')).toHaveTextContent('2');

    const handles = within(dialog).getAllByRole('button', { name: 'Reorder' });
    fireEvent.keyDown(handles[0], { key: 'ArrowDown' });

    expect(within(screen.getByTestId('arrange-printer-2')).getByTestId('arrange-position')).toHaveTextContent('1');
    expect(within(screen.getByTestId('arrange-printer-1')).getByTestId('arrange-position')).toHaveTextContent('2');

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onApply).toHaveBeenCalledWith([2, 1]);
  });

  it('Escape after a reorder cancels and does not apply', async () => {
    const onApply = vi.fn();
    render(
      <ArrangePrintersModal
        isOpen
        title="Group 1"
        printers={[
          { id: 1, name: 'X1 Carbon', model: 'X1C' },
          { id: 2, name: 'P1S Backup', model: 'P1S' },
        ]}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    const handles = within(dialog).getAllByRole('button', { name: 'Reorder' });
    fireEvent.keyDown(handles[0], { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onApply).not.toHaveBeenCalled();
  });

  it('overlay click after a reorder cancels and does not apply', () => {
    const onApply = vi.fn();
    render(
      <ArrangePrintersModal
        isOpen
        title="Group 1"
        printers={[
          { id: 1, name: 'X1 Carbon', model: 'X1C' },
          { id: 2, name: 'P1S Backup', model: 'P1S' },
        ]}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    const handles = within(dialog).getAllByRole('button', { name: 'Reorder' });
    fireEvent.keyDown(handles[0], { key: 'ArrowDown' });
    fireEvent.click(screen.getByTestId('arrange-printers-overlay'));

    expect(onApply).not.toHaveBeenCalled();
  });

  it('X close after a reorder cancels and does not apply', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <ArrangePrintersModal
        isOpen
        title="Group 1"
        printers={[
          { id: 1, name: 'X1 Carbon', model: 'X1C' },
          { id: 2, name: 'P1S Backup', model: 'P1S' },
        ]}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    const handles = within(dialog).getAllByRole('button', { name: 'Reorder' });
    fireEvent.keyDown(handles[0], { key: 'ArrowDown' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('PrintersPage arrange', () => {
  const storage: Record<string, string> = {};

  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key];
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => storage[key] ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      storage[key] = value;
    });
    vi.mocked(localStorage.removeItem).mockImplementation((key: string) => {
      delete storage[key];
    });

    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json(mockPrinters)),
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json(mockPrinterStatus)),
      http.get('/api/v1/settings/', () => HttpResponse.json({ require_plate_clear: true })),
      http.get('/api/v1/settings/ui-preferences', () => HttpResponse.json({ require_plate_clear: true })),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
    );
  });

  it('opens the arrange modal, reorders, and persists the card order', async () => {
    const user = userEvent.setup();
    render(<PrintersPage />);

    expect(await screen.findByText('X1 Carbon')).toBeInTheDocument();
    expect(screen.getByText('P1S Backup')).toBeInTheDocument();
    expect(cardIds()).toEqual(['printer-card-2', 'printer-card-1']);

    await user.click(screen.getByRole('button', { name: 'Arrange' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Group 1')).toBeInTheDocument();
    expect(within(dialog).getByText('P1S Backup')).toBeInTheDocument();
    expect(within(dialog).getByText('X1 Carbon')).toBeInTheDocument();
    expect(within(screen.getByTestId('arrange-printer-2')).getByTestId('arrange-position')).toHaveTextContent('1');
    expect(within(screen.getByTestId('arrange-printer-1')).getByTestId('arrange-position')).toHaveTextContent('2');

    const handles = within(dialog).getAllByRole('button', { name: 'Reorder' });
    fireEvent.keyDown(handles[0], { key: 'ArrowDown' });
    await waitFor(() => {
      expect(arrangeRowIds(dialog)).toEqual(['arrange-printer-1', 'arrange-printer-2']);
      expect(within(screen.getByTestId('arrange-printer-1')).getByTestId('arrange-position')).toHaveTextContent('1');
      expect(within(screen.getByTestId('arrange-printer-2')).getByTestId('arrange-position')).toHaveTextContent('2');
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(cardIds()).toEqual(['printer-card-1', 'printer-card-2']);
    });
    expect(JSON.parse(storage[PRINTER_CUSTOM_ORDER_KEY] || '[]')).toEqual([1, 2]);
    expect(storage.printerSortBy).toBe('custom');
  });

  it('Escape after a reorder closes without persisting the order', async () => {
    const user = userEvent.setup();
    render(<PrintersPage />);

    expect(await screen.findByText('X1 Carbon')).toBeInTheDocument();
    expect(cardIds()).toEqual(['printer-card-2', 'printer-card-1']);

    await user.click(screen.getByRole('button', { name: 'Arrange' }));
    const dialog = await screen.findByRole('dialog');
    const handles = within(dialog).getAllByRole('button', { name: 'Reorder' });
    fireEvent.keyDown(handles[0], { key: 'ArrowDown' });
    await waitFor(() => {
      expect(arrangeRowIds(dialog)).toEqual(['arrange-printer-1', 'arrange-printer-2']);
    });
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(cardIds()).toEqual(['printer-card-2', 'printer-card-1']);
    expect(storage[PRINTER_CUSTOM_ORDER_KEY]).toBeUndefined();
    expect(storage.printerSortBy).toBeUndefined();
  });

  it('overlay click after a reorder closes without persisting the order', async () => {
    const user = userEvent.setup();
    render(<PrintersPage />);

    expect(await screen.findByText('X1 Carbon')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Arrange' }));
    const dialog = await screen.findByRole('dialog');
    const handles = within(dialog).getAllByRole('button', { name: 'Reorder' });
    fireEvent.keyDown(handles[0], { key: 'ArrowDown' });
    await waitFor(() => {
      expect(arrangeRowIds(dialog)).toEqual(['arrange-printer-1', 'arrange-printer-2']);
    });
    fireEvent.click(screen.getByTestId('arrange-printers-overlay'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(cardIds()).toEqual(['printer-card-2', 'printer-card-1']);
    expect(storage[PRINTER_CUSTOM_ORDER_KEY]).toBeUndefined();
  });

  it('X close after a reorder closes without persisting the order', async () => {
    const user = userEvent.setup();
    render(<PrintersPage />);

    expect(await screen.findByText('X1 Carbon')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Arrange' }));
    const dialog = await screen.findByRole('dialog');
    const handles = within(dialog).getAllByRole('button', { name: 'Reorder' });
    fireEvent.keyDown(handles[0], { key: 'ArrowDown' });
    await waitFor(() => {
      expect(arrangeRowIds(dialog)).toEqual(['arrange-printer-1', 'arrange-printer-2']);
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(cardIds()).toEqual(['printer-card-2', 'printer-card-1']);
    expect(storage[PRINTER_CUSTOM_ORDER_KEY]).toBeUndefined();
  });

  it('keeps the saved arrangement after a remount', async () => {
    storage[PRINTER_CUSTOM_ORDER_KEY] = JSON.stringify([1, 2]);
    storage.printerSortBy = 'custom';

    render(<PrintersPage />);

    expect(await screen.findByText('X1 Carbon')).toBeInTheDocument();
    await waitFor(() => {
      expect(cardIds()).toEqual(['printer-card-1', 'printer-card-2']);
    });
  });
});
