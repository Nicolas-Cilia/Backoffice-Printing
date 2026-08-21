/**
 * Tests for the FilamentMapping component's Filament Track Switch (FTS)
 * handling (#1162).
 *
 * The FTS accessory routes any AMS slot to either extruder dynamically. When
 * present (printer status `fila_switch.installed === true`), the per-extruder
 * dropdown filter must be suppressed — otherwise the print modal's filament
 * dropdown is empty since the printer reports info bits 8-11 = 0xE
 * (uninitialized) for every AMS unit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FilamentMapping } from '../../components/PrintModal/FilamentMapping';
import { buildAmsUnitViews } from '../../components/PrintModal/amsUnitViews';
import type { PrinterStatus } from '../../api/client';

const mockFilamentReqs = {
  filaments: [
    // Required filament asks for the LEFT extruder (nozzle_id=1).
    // Without FTS the dropdown filter would only allow slots with extruderId=1.
    { slot_id: 1, type: 'PETG', color: '#00FF00', used_grams: 25, used_meters: 8.5, nozzle_id: 1 },
  ],
};

function createStatus(overrides: Partial<PrinterStatus>): PrinterStatus {
  return {
    id: 1,
    name: 'X2D',
    connected: true,
    state: 'IDLE',
    ams: [
      {
        id: 0,
        // Realistic FTS-installed bundle: AMS reports extruder bits 8-11 = 0xE,
        // so ams_extruder_map ends up empty.
        tray: [
          { id: 0, tray_type: 'PLA', tray_color: 'FF0000', tray_info_idx: 'GFA00', tray_sub_brands: 'Bambu PLA' },
          { id: 1, tray_type: 'PETG', tray_color: '00FF00', tray_info_idx: 'GFG00', tray_sub_brands: 'Bambu PETG' },
        ],
      },
    ],
    vt_tray: [],
    ams_extruder_map: {},
    ...overrides,
  } as PrinterStatus;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FilamentMapping — FTS routing', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/printers/:id/spool-assignments', () => HttpResponse.json([])),
    );
  });

  it('shows all loaded slots in the dropdown when FTS is installed', async () => {
    server.use(
      http.get(
        '/api/v1/printers/:id/status',
        () =>
          HttpResponse.json(
            createStatus({
              fila_switch: {
                installed: true,
                in_slots: [-1, 1],
                out_extruders: [0, 1],
                stat: 0,
                info: 2,
              },
            }),
          ),
      ),
    );

    render(
      <FilamentMapping
        printerId={1}
        filamentReqs={mockFilamentReqs}
        manualMappings={{}}
        onManualMappingChange={() => {}}
        currencySymbol="$"
        defaultCostPerKg={0}
        defaultExpanded
      />,
    );

    // Both PLA and PETG slots must appear in the AMS spool grid despite
    // ams_extruder_map being empty and the requirement asking for nozzle 1.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Bambu PLA/ })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Bambu PETG/ })).toBeInTheDocument();

    // The slot currently fed into a track gets an [L]/[R] badge. AMS-0 slot 1
    // (global tray ID 1) is in fila_switch.in_slots[1], whose track terminates
    // at extruder 1 → the LEFT-nozzle short label appears on that spool.
    const petgSlot = screen.getByRole('button', { name: /Bambu PETG/ });
    expect(petgSlot.getAttribute('aria-label')).toMatch(/\[L\]/);

    // AMS-0 slot 0 (global tray ID 0) is NOT currently fed into any track —
    // FTS routes it on demand, so no badge.
    const plaSlot = screen.getByRole('button', { name: /Bambu PLA/ });
    expect(plaSlot.getAttribute('aria-label')).not.toMatch(/\[[LR]\]/);
  });

  it('renders the per-slot force-color-match checkbox in printer mode (#1717)', async () => {
    // Specific-printer assignment used to render FilamentMapping with no
    // force-color-match UI even though the dispatcher honours the flag. Pin
    // that the checkbox is now mounted and bubbles toggle events up.
    server.use(
      http.get(
        '/api/v1/printers/:id/status',
        () =>
          HttpResponse.json(
            createStatus({
              fila_switch: null,
              ams_extruder_map: { '0': 1 },  // AMS 0 → left nozzle, matching the requirement
            }),
          ),
      ),
    );

    const onForceColorMatchChange = vi.fn();
    render(
      <FilamentMapping
        printerId={1}
        filamentReqs={mockFilamentReqs}
        manualMappings={{}}
        onManualMappingChange={() => {}}
        currencySymbol="$"
        defaultCostPerKg={0}
        defaultExpanded
        forceColorMatch={{}}
        onForceColorMatchChange={onForceColorMatchChange}
      />,
    );

    const checkbox = await waitFor(() => {
      const cb = screen.getByLabelText(/Force color match/i) as HTMLInputElement;
      expect(cb).toBeInTheDocument();
      return cb;
    });
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(onForceColorMatchChange).toHaveBeenCalledTimes(1);
    expect(onForceColorMatchChange).toHaveBeenCalledWith(1, true);
  });

  it('omits the force-color-match checkbox when no handler is provided', async () => {
    // The checkbox is only meaningful when the caller is wired to persist the
    // toggle; absent a handler we must not render dead UI.
    server.use(
      http.get(
        '/api/v1/printers/:id/status',
        () =>
          HttpResponse.json(
            createStatus({
              fila_switch: null,
              ams_extruder_map: { '0': 1 },
            }),
          ),
      ),
    );

    render(
      <FilamentMapping
        printerId={1}
        filamentReqs={mockFilamentReqs}
        manualMappings={{}}
        onManualMappingChange={() => {}}
        currencySymbol="$"
        defaultCostPerKg={0}
        defaultExpanded
      />,
    );

    // Wait for the panel to finish mounting (Re-read button only renders once
    // printer status has loaded and the expanded view is open) before asserting
    // the checkbox is absent — otherwise the queryByLabelText would pass
    // trivially during the loading window.
    await waitFor(() => {
      expect(screen.getByText(/Re-read/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/Force color match/i)).not.toBeInTheDocument();
  });

  it('offers cross-extruder slots in the dropdown without FTS (#1722)', async () => {
    // Before #1722 the dropdown filtered to only slots whose extruder matched
    // the filament's slicer-assigned nozzle. On a dual-nozzle printer with one
    // AMS per side, that prevented the user from picking a slot on the OTHER
    // extruder even when they'd intentionally loaded the required filament
    // there. The fix: trust the user, show every loaded slot regardless of
    // which extruder it's wired to. The L/R badge on the filament row still
    // tells the user what the slicer planned; the printer firmware accepts
    // or rejects the cross-extruder ams_mapping at start-print.
    server.use(
      http.get(
        '/api/v1/printers/:id/status',
        () =>
          HttpResponse.json(
            createStatus({
              fila_switch: null,
              ams_extruder_map: { '0': 0 },  // AMS 0 → right nozzle (extruder 0)
            }),
          ),
      ),
    );

    render(
      <FilamentMapping
        printerId={1}
        filamentReqs={mockFilamentReqs}
        manualMappings={{}}
        onManualMappingChange={() => {}}
        currencySymbol="$"
        defaultCostPerKg={0}
        defaultExpanded
      />,
    );

    // Required nozzle is 1 (LEFT) and AMS 0 is wired to extruder 0 (RIGHT).
    // Both slots must STILL appear so the user can pick them — explicitly the
    // cross-extruder scenario the #1722 fix unblocks.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Bambu PLA/ })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Bambu PETG/ })).toBeInTheDocument();
  });

  it('renders sub-brand + material-disambiguated colour on the required side (#1718)', async () => {
    // Same fix as FilamentOverride: required-side label was rendering the
    // raw 3MF type ("PLA") and the generic getColorName bucket ("Black").
    // After the shared useFilamentLabels hook it must now resolve
    // tray_info_idx → "Bambu PLA Matte" and the material-disambiguated
    // colour catalogue → "Charcoal" — the Specific-Printer panel matched
    // the Any-Model panel that was already correct.
    server.use(
      http.get(
        '/api/v1/printers/:id/status',
        () =>
          HttpResponse.json(
            createStatus({
              fila_switch: null,
              ams_extruder_map: { '0': 1 },
            }),
          ),
      ),
      http.get('/api/v1/cloud/builtin-filaments', () =>
        HttpResponse.json([{ filament_id: 'GFA01', name: 'Bambu PLA Matte' }]),
      ),
      http.get('/api/v1/cloud/filament-id-map', () => HttpResponse.json({})),
      http.get('/api/v1/inventory/colors/by-material', ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('hex') === '#000000' && url.searchParams.get('material') === 'PLA Matte') {
          return HttpResponse.json({ color_name: 'Charcoal' });
        }
        return HttpResponse.json({ color_name: null });
      }),
    );

    const charcoalReqs = {
      filaments: [
        { slot_id: 1, type: 'PLA', color: '#000000', used_grams: 25, used_meters: 8.5, nozzle_id: 1, tray_info_idx: 'GFA01' },
      ],
    };

    render(
      <FilamentMapping
        printerId={1}
        filamentReqs={charcoalReqs}
        manualMappings={{}}
        onManualMappingChange={() => {}}
        currencySymbol="$"
        defaultCostPerKg={0}
        defaultExpanded
      />,
    );

    // Required-side type text picks up the resolved sub-brand.
    await waitFor(() => {
      expect(screen.getByText(/Bambu PLA Matte/)).toBeInTheDocument();
    });
    // The swatch tooltip carries the disambiguated "Charcoal" instead of
    // the generic "Black" bucket; check the title attr on the colour
    // circle's parent span.
    await waitFor(() => {
      const swatch = screen.getByTitle(/Required: Bambu PLA Matte - Charcoal/);
      expect(swatch).toBeInTheDocument();
    });
  });

  it('pins the gram usage so a long name cannot clip it (#2669)', async () => {
    // Long resolved name + gram usage. The name must be the truncating
    // element; the "(25g)" must sit in its own non-truncating, shrink-0 span
    // so it stays visible on narrow/mobile widths.
    server.use(
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json(createStatus({}))),
      http.get('/api/v1/cloud/builtin-filaments', () =>
        HttpResponse.json([{ filament_id: 'GFA01', name: 'Polymaker PLA Matte' }]),
      ),
      http.get('/api/v1/cloud/filament-id-map', () => HttpResponse.json({})),
      http.get('/api/v1/inventory/colors/by-material', () => HttpResponse.json({ color_name: null })),
    );

    render(
      <FilamentMapping
        printerId={1}
        filamentReqs={{
          filaments: [
            { slot_id: 1, type: 'PLA', color: '#000000', used_grams: 25, used_meters: 8.5, nozzle_id: 1, tray_info_idx: 'GFA01' },
          ],
        }}
        manualMappings={{}}
        onManualMappingChange={() => {}}
        currencySymbol="$"
        defaultCostPerKg={0}
        defaultExpanded
      />,
    );

    const grams = await screen.findByText('(25g)');
    // The gram usage never truncates and never shrinks away.
    expect(grams.className).toContain('shrink-0');
    expect(grams.className).not.toContain('truncate');

    // The name is the element that truncates instead.
    const name = await screen.findByText('Polymaker PLA Matte');
    expect(name.className).toContain('truncate');
    // Name and grams are separate siblings, so the name shrinking can't take
    // the grams with it.
    expect(name).not.toBe(grams);
    expect(grams.parentElement).toBe(name.parentElement);
  });

  it('resolves sparse AMS trays by id only (no index fallback)', () => {
    const status = createStatus({
      ams: [
        {
          id: 0,
          // Two trays with non-contiguous ids — length > 1 so not treated as AMS-HT.
          // Index 0 must not receive tray id 2 via a positional fallback.
          tray: [
            { id: 2, tray_type: 'PETG', tray_color: '00FF00', tray_info_idx: 'GFG00', tray_sub_brands: 'Bambu PETG' },
            { id: 3, tray_type: 'PLA', tray_color: 'FF0000', tray_info_idx: 'GFA00', tray_sub_brands: 'Bambu PLA' },
          ],
        },
      ],
    });
    const units = buildAmsUnitViews(status, []);
    expect(units[0].trays).toHaveLength(4);
    expect(units[0].trays[0].tray).toBeNull();
    expect(units[0].trays[1].tray).toBeNull();
    expect(units[0].trays[2].tray?.tray_type).toBe('PETG');
    expect(units[0].trays[3].tray?.tray_type).toBe('PLA');
  });

  it('opens an AMS spool picker from a multi-material mapping chip', async () => {
    server.use(
      http.get('/api/v1/printers/:id/status', () =>
        HttpResponse.json(
          createStatus({
            fila_switch: null,
            ams_extruder_map: {},
          }),
        ),
      ),
    );

    const onManualMappingChange = vi.fn();
    render(
      <FilamentMapping
        printerId={1}
        filamentReqs={{
          filaments: [
            { slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 10, used_meters: 3 },
            { slot_id: 2, type: 'PETG', color: '#00FF00', used_grams: 10, used_meters: 3 },
          ],
        }}
        manualMappings={{}}
        onManualMappingChange={onManualMappingChange}
        currencySymbol="$"
        defaultCostPerKg={0}
        defaultExpanded
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('filament-mapping-summary')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ams-spool-overview')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /PLA/i }));
    expect(await screen.findByTestId('ams-material-picker')).toBeInTheDocument();
    expect(screen.getByText(/Choose which extruder\/color to use for Material 1/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Bambu PETG/ }));
    expect(onManualMappingChange).toHaveBeenCalled();
    const last = onManualMappingChange.mock.calls.at(-1)?.[0] as Record<number, number>;
    expect(last[1]).toBe(1); // PETG is tray id 1
  });
});
