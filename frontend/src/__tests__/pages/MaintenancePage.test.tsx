/**
 * Tests for the MaintenancePage component.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { MaintenancePage } from '../../pages/MaintenancePage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockPrinters = [
  {
    id: 1,
    name: 'X1 Carbon',
    model: 'X1C',
    serial_number: '00M09A350100001',
  },
];

const mockMaintenanceTypes = [
  {
    id: 1,
    name: 'Clean Nozzle',
    description: 'Clean the printer nozzle',
    default_interval_hours: 50,
    interval_type: 'hours',
    is_system: true,
    is_deleted: false,
    applies_to_models: ['X1C', 'P1S'],
  },
  {
    id: 2,
    name: 'Lubricate Rods',
    description: 'Lubricate linear rods',
    default_interval_hours: 200,
    interval_type: 'hours',
    is_system: true,
    is_deleted: false,
    applies_to_models: ['X1C', 'P1S'],
  },
];

const mockMaintenanceTasks = [
  {
    id: 1,
    printer_id: 1,
    maintenance_type_id: 1,
    maintenance_type_name: 'Clean Nozzle',
    interval_hours: 50,
    last_completed_at: '2024-01-01T00:00:00Z',
    next_due_at: '2024-01-03T00:00:00Z',
    hours_until_due: 10,
    is_due: false,
    notes: null,
  },
  {
    id: 2,
    printer_id: 1,
    maintenance_type_id: 2,
    maintenance_type_name: 'Lubricate Rods',
    interval_hours: 200,
    last_completed_at: '2023-12-01T00:00:00Z',
    next_due_at: '2023-12-15T00:00:00Z',
    hours_until_due: -100,
    is_due: true,
    notes: 'Use PTFE lubricant',
  },
];

describe('MaintenancePage', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/printers/', () => {
        return HttpResponse.json(mockPrinters);
      }),
      http.get('/api/v1/maintenance/types', () => {
        return HttpResponse.json(mockMaintenanceTypes);
      }),
      http.get('/api/v1/maintenance/', () => {
        return HttpResponse.json(mockMaintenanceTasks);
      }),
      http.get('/api/v1/maintenance/overview', () => {
        // Overview is an array of printer summaries
        return HttpResponse.json([
          {
            printer_id: 1,
            printer_name: 'X1 Carbon',
            due_count: 1,
            warning_count: 0,
            total_print_hours: 100,
            total_maintenance_cost: 0,
            maintenance_items: [
              {
                id: 1,
                maintenance_type_id: 1,
                maintenance_type_name: 'Clean Nozzle',
                interval_hours: 50,
                hours_since_last: 45,
                hours_until_due: 5,
                is_due: false,
                is_warning: false,
                enabled: true,
              },
              {
                id: 2,
                maintenance_type_id: 2,
                maintenance_type_name: 'Lubricate Rods',
                interval_hours: 200,
                hours_since_last: 250,
                hours_until_due: -50,
                is_due: true,
                is_warning: false,
                enabled: true,
              },
            ],
          },
        ]);
      }),
      http.post('/api/v1/maintenance/', async ({ request }) => {
        const body = await request.json() as { name: string };
        return HttpResponse.json({ id: 3, ...body });
      }),
      http.post('/api/v1/maintenance/:id/complete', () => {
        return HttpResponse.json({ success: true });
      }),
      http.get('/api/v1/maintenance/printers/:id/history', () => {
        return HttpResponse.json([]);
      }),
      http.patch('/api/v1/maintenance/history/:id', async ({ request }) => {
        const body = await request.json() as { title?: string; notes?: string | null };
        return HttpResponse.json({
          id: 1,
          printer_maintenance_id: 1,
          printer_id: 1,
          performed_at: '2026-08-20T00:00:00Z',
          hours_at_maintenance: 10,
          notes: body.notes ?? null,
          title: body.title ?? 'Replace nozzle',
          part_url: null,
          cost: null,
          job_name: body.title ?? 'Replace nozzle',
          is_custom: Boolean(body.title),
        });
      }),
      http.delete('/api/v1/maintenance/history/:id', () => {
        return HttpResponse.json({ status: 'deleted' });
      }),
      http.delete('/api/v1/maintenance/types/:id', () => {
        return HttpResponse.json({ status: 'hidden' });
      }),
      http.post('/api/v1/maintenance/printers/:id/jobs', async ({ request }) => {
        const body = await request.json() as { title: string };
        return HttpResponse.json({
          id: 1,
          printer_maintenance_id: 1,
          printer_id: 1,
          performed_at: '2026-08-20T00:00:00Z',
          hours_at_maintenance: 10,
          notes: null,
          title: body.title,
          part_url: null,
          cost: null,
          job_name: body.title,
        });
      }),
    );
  });

  describe('rendering', () => {
    it('renders the page title', async () => {
      render(<MaintenancePage />);

      await waitFor(() => {
        expect(screen.getByText('Maintenance')).toBeInTheDocument();
      });
    });

    it('renders maintenance page content', async () => {
      render(<MaintenancePage />);

      await waitFor(() => {
        // Page should render with printer tabs or tasks
        expect(screen.getByText('Maintenance')).toBeInTheDocument();
      });
    });
  });

  describe('printer tabs', () => {
    it('shows printer tabs when printers exist', async () => {
      render(<MaintenancePage />);

      await waitFor(() => {
        // Should show printer name in tabs
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });
    });

    it('shows maintenance cost and a custom-job log control', async () => {
      render(<MaintenancePage />);

      await waitFor(() => {
        expect(screen.getByText('Maintenance cost')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /log custom job/i })).toBeInTheDocument();
      });
    });

    it('opens a notes-only confirm when resetting a scheduled job', async () => {
      const user = userEvent.setup();
      render(<MaintenancePage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /expand/i }));
      const resetButtons = await screen.findAllByRole('button', { name: /log & reset/i });
      await user.click(resetButtons[0]);
      expect(await screen.findByRole('heading', { name: /reset /i })).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/optional notes/i)).toBeInTheDocument();
      expect(screen.queryByText('Part link (optional)')).not.toBeInTheDocument();
    });

    it('opens a custom job dialog from the printer card', async () => {
      const user = userEvent.setup();
      render(<MaintenancePage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /log custom job/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /log custom job/i }));
      expect(screen.getByPlaceholderText(/replace nozzle/i)).toBeInTheDocument();
      expect(screen.getByText('Part link (optional)')).toBeInTheDocument();
    });

    it('shows printer history after expanding a printer', async () => {
      const user = userEvent.setup();
      server.use(
        http.get('/api/v1/maintenance/printers/:id/history', () => {
          return HttpResponse.json([
            {
              id: 1,
              printer_maintenance_id: 1,
              printer_id: 1,
              performed_at: '2026-08-20T12:00:00Z',
              hours_at_maintenance: 10,
              notes: '0.4mm hardened',
              title: 'Replace nozzle',
              part_url: 'https://shop.example.com/nozzle',
              cost: 12,
              job_name: 'Replace nozzle',
              is_custom: true,
            },
          ]);
        }),
      );
      render(<MaintenancePage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /expand/i }));
      expect(await screen.findByText('Printer log')).toBeInTheDocument();
      expect(screen.getByText('Replace nozzle')).toBeInTheDocument();
      expect(screen.getByText(/0\.4mm hardened/)).toBeInTheDocument();
    });

    it('can edit and delete a printer log entry', async () => {
      const user = userEvent.setup();
      server.use(
        http.get('/api/v1/maintenance/printers/:id/history', () => {
          return HttpResponse.json([
            {
              id: 1,
              printer_maintenance_id: 1,
              printer_id: 1,
              performed_at: '2026-08-20T12:00:00Z',
              hours_at_maintenance: 10,
              notes: '0.4mm hardened',
              title: 'Replace nozzle',
              part_url: 'https://shop.example.com/nozzle',
              cost: 12,
              job_name: 'Replace nozzle',
              is_custom: true,
            },
          ]);
        }),
      );
      render(<MaintenancePage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /expand/i }));
      expect(await screen.findByRole('button', { name: /edit log/i })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /edit log/i }));
      expect(screen.getByDisplayValue('Replace nozzle')).toBeInTheDocument();
      expect(screen.getByText('Part link (optional)')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));
      await user.click(screen.getByRole('button', { name: /delete log/i }));
      expect(await screen.findByRole('heading', { name: /delete log entry/i })).toBeInTheDocument();
    });

    it('lets you hide a default task from settings without restoring all', async () => {
      const user = userEvent.setup();
      render(<MaintenancePage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /settings/i }));
      const hideButtons = await screen.findAllByRole('button', { name: /^hide$/i });
      await user.click(hideButtons[0]);
      expect(await screen.findByRole('heading', { name: /hide /i })).toBeInTheDocument();
      expect(screen.queryByText('Restore Default Tasks')).not.toBeInTheDocument();
    });
  });
});
