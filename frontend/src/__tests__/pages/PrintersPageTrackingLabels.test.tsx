/**
 * Printers FILAMENTS tracking labels: section note + per-slot Inventory Tracking
 * product under AMS and external slots. Uses the same assignments API as
 * FilamentHoverCard `trackingForSlot` — no second assignment source.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockPrinter = {
  id: 1,
  name: 'X1 Carbon',
  ip_address: '192.168.1.100',
  serial_number: '00M09A350100001',
  access_code: '12345678',
  model: 'X1C',
  enabled: true,
  nozzle_diameter: 0.4,
  nozzle_type: 'hardened_steel',
  location: 'Workshop',
  auto_archive: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const baseTray = {
  tray_color: 'FF0000FF',
  tray_type: 'PLA',
  tray_sub_brands: 'PLA Basic',
  tray_id_name: 'A00-R0',
  tray_info_idx: 'GFA00',
  remain: 80,
  k: 0.02,
  cali_idx: null,
  tag_uid: null,
  tray_uuid: null,
  nozzle_temp_min: 190,
  nozzle_temp_max: 230,
  drying_temp: null,
  drying_time: null,
  state: 11,
};

const mockStatus = {
  connected: true,
  state: 'IDLE',
  progress: 0,
  layer_num: 0,
  total_layers: 0,
  temperatures: { nozzle: 25, bed: 25, chamber: 25 },
  remaining_time: 0,
  filename: null,
  wifi_signal: -50,
  speed_level: 2,
  vt_tray: [{ id: 254, ...baseTray, tray_type: 'PETG', tray_color: '00FF00FF' }],
  ams: [
    {
      id: 0,
      humidity: 30,
      temp: 25,
      is_ams_ht: false,
      serial_number: 'AMS00',
      sw_ver: '1.0.0',
      dry_time: 0,
      dry_status: 0,
      dry_sub_status: 0,
      dry_sf_reason: [],
      module_type: 'ams',
      tray: [
        { id: 0, ...baseTray },
        { id: 1, ...baseTray, tray_color: '0000FFFF', tray_type: 'ABS' },
        { id: 2, ...baseTray, tray_type: '', tray_color: '', remain: -1, state: 9 },
        { id: 3, ...baseTray, tray_type: '', tray_color: '', remain: -1, state: 9 },
      ],
    },
  ],
};

const amsAssignment = {
  id: 1,
  printer_id: 1,
  ams_id: 0,
  tray_id: 0,
  bucket_id: 10,
  color_name: 'White',
  material: 'PLA',
  brand: 'EasyRock',
  subtype: null,
  extra_colors: null,
  effect_type: null,
  color_hex: 'FFFFFF',
};

const externalAssignment = {
  id: 2,
  printer_id: 1,
  ams_id: 255,
  tray_id: 0,
  bucket_id: 11,
  color_name: 'Galaxy',
  material: 'PETG',
  brand: 'Bambu Lab',
  subtype: null,
  extra_colors: null,
  effect_type: null,
  color_hex: '4B0082',
};

describe('PrintersPage — FILAMENTS tracking labels', () => {
  beforeEach(() => {
    localStorage.removeItem('printerCardSize');
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([mockPrinter])),
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json(mockStatus)),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
    );
  });

  it('shows the tracking note and product labels under assigned AMS and external slots', async () => {
    server.use(
      http.get('/api/v1/filament-tracking/assignments', () =>
        HttpResponse.json([amsAssignment, externalAssignment]),
      ),
    );

    render(<PrintersPage />);

    expect(await screen.findByText('Filaments')).toBeInTheDocument();
    expect(
      await screen.findByText('Labels under slots show Inventory Tracking products.'),
    ).toBeInTheDocument();

    const labels = await screen.findAllByTestId('slot-tracking-label');
    expect(labels).toHaveLength(2);
    expect(labels[0]).toHaveTextContent('White · EasyRock · PLA');
    expect(labels[1]).toHaveTextContent('Galaxy · Bambu Lab · PETG');
    expect(screen.queryByText('White · PLA')).not.toBeInTheDocument();

    // Existing AMS type captions stay; tracking labels sit under the slots.
    expect(screen.getAllByText('PLA').length).toBeGreaterThan(0);
    expect(screen.getByText('ABS')).toBeInTheDocument();
    expect(screen.getByText('PETG')).toBeInTheDocument();
    expect(screen.getAllByText('Empty').length).toBeGreaterThan(0);

    // Unassigned AMS slots (ABS + two Empty) do not invent a tracking color.
    expect(screen.queryByText('White · EasyRock · PLA')?.closest('[data-testid="slot-tracking-label"]')).toBeTruthy();
    expect(labels.every((el) => !el.textContent?.includes('ABS'))).toBe(true);
  });

  it('hides the tracking note and slot labels when the printer has no assignments', async () => {
    server.use(
      http.get('/api/v1/filament-tracking/assignments', () => HttpResponse.json([])),
    );

    render(<PrintersPage />);

    expect(await screen.findByText('Filaments')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('PLA')).toBeInTheDocument();
    });
    expect(
      screen.queryByText('Labels under slots show Inventory Tracking products.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('slot-tracking-label')).not.toBeInTheDocument();
  });

  it('shows a tracking product label under an empty AMS slot', async () => {
    const emptyAssignment = {
      ...amsAssignment,
      id: 3,
      tray_id: 2,
      color_name: 'Sparkle White',
      extra_colors: 'FFD700',
      effect_type: 'sparkle',
    };
    server.use(
      http.get('/api/v1/filament-tracking/assignments', () =>
        HttpResponse.json([emptyAssignment]),
      ),
    );

    render(<PrintersPage />);

    expect(
      await screen.findByText('Sparkle White · EasyRock · PLA'),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('slot-tracking-label')).toHaveLength(1);
  });

  it('assigns tracking from an empty AMS slot hover card', async () => {
    server.use(
      http.get('/api/v1/filament-tracking/assignments', () => HttpResponse.json([])),
      http.get('/api/v1/filament-tracking/plan', () =>
        HttpResponse.json({
          stage: 'collecting',
          days_observed: 0,
          window_label: '',
          materials: [
            {
              bucket_id: 12,
              color_name: 'Jade White',
              material: 'PLA',
              brand: 'Bambu Lab',
              subtype: null,
              extra_colors: null,
              effect_type: null,
              color_hex: 'FFFFFF',
            },
          ],
          total_on_hand_grams: 0,
          total_observed_usage_grams: 0,
          total_monthly_estimate_grams: 0,
          total_recommended_spools: 0,
          soonest_days_until_order: null,
          tracking_started_at: null,
        }),
      ),
    );

    render(<PrintersPage />);
    expect(await screen.findByText('Filaments')).toBeInTheDocument();

    const empties = await screen.findAllByText('Empty');
    fireEvent.mouseEnter(empties[0].parentElement?.parentElement as HTMLElement);

    expect(await screen.findByText('Assign tracking product')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Assign tracking product'));

    expect(await screen.findByRole('heading', { name: 'Assign tracking product' })).toBeInTheDocument();
    expect(await screen.findByText('Jade White · Bambu Lab · PLA')).toBeInTheDocument();
  });

  it('unassigns tracking from an empty AMS slot hover card', async () => {
    let deleted = false;
    const emptyAssignment = {
      ...amsAssignment,
      id: 3,
      tray_id: 2,
    };
    server.use(
      http.get('/api/v1/filament-tracking/assignments', () =>
        HttpResponse.json(deleted ? [] : [emptyAssignment]),
      ),
      http.delete('/api/v1/filament-tracking/assignments/:printerId/:amsId/:trayId', () => {
        deleted = true;
        return HttpResponse.json({ status: 'ok' });
      }),
    );

    render(<PrintersPage />);
    expect(await screen.findByText('White · EasyRock · PLA')).toBeInTheDocument();

    const empties = screen.getAllByText('Empty');
    fireEvent.mouseEnter(empties[0].parentElement?.parentElement as HTMLElement);

    expect(await screen.findByText('Unassign tracking')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Unassign tracking'));

    await waitFor(() => {
      expect(deleted).toBe(true);
    });
  });
});
