/**
 * Regression: Finished / Failed printers must stay selectable even when
 * awaiting_plate_clear is set — otherwise File Manager print flow shows
 * "No idle printers" and buries them under "Currently printing".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { PrinterSelector } from '../../components/PrintModal/PrinterSelector';

const printers = [
  {
    id: 1,
    name: 'Founders #6',
    model: 'X1C',
    ip_address: '192.168.1.247',
    is_active: true,
    access_code: '',
    serial_number: 's1',
  },
  {
    id: 2,
    name: 'Maduro #5',
    model: 'X1C',
    ip_address: '192.168.1.157',
    is_active: true,
    access_code: '',
    serial_number: 's2',
  },
];

function renderSelector() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PrinterSelector
        printers={printers as never}
        selectedPrinterIds={[]}
        onMultiSelect={vi.fn()}
        allowMultiple
        disableBusy
        assignmentMode="printer"
        slicedForModel="X1C"
      />
    </QueryClientProvider>,
  );
}

describe('PrinterSelector busy/idle with plate clear', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/printers/1/status', () =>
        HttpResponse.json({
          connected: true,
          state: 'FINISH',
          awaiting_plate_clear: true,
        }),
      ),
      http.get('/api/v1/printers/2/status', () =>
        HttpResponse.json({
          connected: true,
          state: 'FAILED',
          awaiting_plate_clear: true,
        }),
      ),
    );
  });

  it('lists Finished/Failed printers as selectable, not under Currently printing', async () => {
    renderSelector();

    await waitFor(() => {
      expect(screen.getByText('Finished — clear plate')).toBeInTheDocument();
      expect(screen.getByText('Failed — clear plate')).toBeInTheDocument();
    });

    expect(screen.queryByText(/No idle printers right now/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Currently printing/i)).not.toBeInTheDocument();

    const finishedBtn = screen.getByRole('button', { name: /Founders #6/i });
    const failedBtn = screen.getByRole('button', { name: /Maduro #5/i });
    expect(finishedBtn).not.toBeDisabled();
    expect(failedBtn).not.toBeDisabled();
  });
});
