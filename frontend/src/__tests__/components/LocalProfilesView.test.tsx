/**
 * Tests for LocalProfilesView component.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within, render as rawRender } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { AuthProvider } from '../../contexts/AuthContext';
import { api } from '../../api/client';
import { LocalProfilesView } from '../../components/LocalProfilesView';

const mockLocalPresets = {
  filament: [
    {
      id: 1,
      name: 'Overture PLA Matte @BBL X1C',
      preset_type: 'filament',
      source: 'bambu',
      filament_type: 'PLA',
      filament_vendor: 'Overture',
      nozzle_temp_min: 190,
      nozzle_temp_max: 230,
      pressure_advance: '["0.04"]',
      default_filament_colour: '["#FFAA00"]',
      filament_cost: '24.99',
      filament_density: '1.24',
      compatible_printers: '["Bambu Lab X1 Carbon 0.4 nozzle"]',
      inherits: 'Bambu PLA Basic @BBL X1C',
      version: '2.3.0.4',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 2,
      name: 'eSUN PETG @Bambu Lab H2D',
      preset_type: 'filament',
      source: 'bambu',
      filament_type: 'PETG',
      filament_vendor: null,
      nozzle_temp_min: 220,
      nozzle_temp_max: 250,
      pressure_advance: null,
      default_filament_colour: null,
      filament_cost: null,
      filament_density: null,
      compatible_printers: null,
      inherits: null,
      version: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 4,
      name: 'Generic PLA @Voron 2.4',
      preset_type: 'filament',
      source: 'orcaslicer',
      filament_type: 'PLA',
      filament_vendor: null,
      nozzle_temp_min: null,
      nozzle_temp_max: null,
      pressure_advance: null,
      default_filament_colour: null,
      filament_cost: null,
      filament_density: null,
      compatible_printers: null,
      inherits: null,
      version: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ],
  process: [
    {
      id: 3,
      name: '0.20mm Standard @BBL X1C',
      preset_type: 'process',
      source: 'bambu',
      filament_type: null,
      filament_vendor: null,
      nozzle_temp_min: null,
      nozzle_temp_max: null,
      pressure_advance: null,
      default_filament_colour: null,
      filament_cost: null,
      filament_density: null,
      compatible_printers: null,
      inherits: '0.20mm Standard @BBL X1C',
      version: '2.3.0.4',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      locked_parameters: {
        curr_bed_type: 'Textured PEI Plate',
        layer_height: 0.2,
        sparse_infill_density: 20,
        brim_type: 'auto_brim',
        brim_object_gap: 0.1,
        fuzzy_skin: 'none',
        wall_loops: 3,
        enable_support: false,
      },
    },
  ],
  printer: [],
};

describe('LocalProfilesView', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/local-presets/', () => {
        return HttpResponse.json(mockLocalPresets);
      }),
      http.delete('/api/v1/local-presets/:id', () => {
        return HttpResponse.json({ success: true });
      }),
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json([]);
      }),
    );
  });

  it('renders filament and process columns', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    expect(screen.getByText('eSUN PETG @Bambu Lab H2D')).toBeInTheDocument();
    expect(screen.getByText('Unfiled processes')).toBeInTheDocument();
    expect(screen.queryByText('All processes')).not.toBeInTheDocument();

    const toggle = screen.getByTestId('toggle-unfiled-processes');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('unfiled-processes-list')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('unfiled-processes-list')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByText('0.20mm Standard @BBL X1C')).toBeInTheDocument();
    expect(screen.getByTestId('move-unfiled-process')).toBeInTheDocument();
    expect(screen.getAllByTestId('download-local-preset').length).toBeGreaterThan(0);
    expect(screen.getByText('Unfiled processes')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('unfiled-processes-list')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows material badges from filament_type', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    // PLA badge should appear for the first preset
    const plaBadges = screen.getAllByText('PLA');
    expect(plaBadges.length).toBeGreaterThan(0);
  });

  it('shows vendor from filament_vendor field', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture')).toBeInTheDocument();
    });
  });

  it('parses vendor from name when filament_vendor is null', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('eSUN PETG @Bambu Lab H2D')).toBeInTheDocument();
    });

    // eSUN should be parsed from the name
    expect(screen.getByText('eSUN')).toBeInTheDocument();
  });

  it('filters presets by search query', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: 'PETG' } });

    expect(screen.queryByText('Overture PLA Matte @BBL X1C')).not.toBeInTheDocument();
    expect(screen.getByText('eSUN PETG @Bambu Lab H2D')).toBeInTheDocument();
  });

  it('keeps the search bar visible when no presets match the query (#1470)', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: 'zzz-nothing-matches' } });

    // The search bar must stay mounted so the query can be cleared/edited
    // without a page refresh, and it keeps the typed value.
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search/i)).toHaveValue('zzz-nothing-matches');
    // A no-matches message replaces the columns (not the "import some" empty state).
    expect(screen.getByText(/no presets match your search/i)).toBeInTheDocument();
  });

  it('shows empty state when no presets', async () => {
    server.use(
      http.get('/api/v1/local-presets/', () => {
        return HttpResponse.json({ filament: [], process: [], printer: [] });
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText(/no local presets/i)).toBeInTheDocument();
    });
  });

  it('shows Bambu Lab and Orca Slicer source labels', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    const expandNamed = (name: string) => {
      const heading = screen.getByText(name);
      const card = heading.closest('.bg-bambu-dark');
      expect(card).toBeTruthy();
      const buttons = card!.querySelectorAll('button');
      fireEvent.click(buttons[buttons.length - 1]);
    };

    expandNamed('Overture PLA Matte @BBL X1C');
    expect(screen.getByTestId('preset-source')).toHaveTextContent('Bambu Lab');
    expect(screen.queryByText('Orcaslicer')).not.toBeInTheDocument();

    expandNamed('Generic PLA @Voron 2.4');
    expect(screen.getByTestId('preset-source')).toHaveTextContent('Orca Slicer');
  });

  it('shows Local badge on preset cards', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    const badges = screen.getAllByText(/^Local$/i);
    expect(badges.length).toBeGreaterThan(0);
  });

  it('shows delete confirmation modal', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    // Click first delete button
    const deleteButtons = screen.getAllByTitle(/delete/i);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
    });
  });

  it('does not show a page-level import drop zone', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    expect(screen.queryByText(/import profiles/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/drop \.bbscfg/i)).not.toBeInTheDocument();
  });

  it('downloads a local preset from the card control', async () => {
    const downloadSpy = vi.spyOn(api, 'downloadLocalPreset').mockResolvedValue(undefined);

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    const heading = screen.getByText('Overture PLA Matte @BBL X1C');
    const card = heading.closest('.bg-bambu-dark');
    expect(card).toBeTruthy();
    fireEvent.click(within(card as HTMLElement).getByTestId('download-local-preset'));

    await waitFor(() => {
      expect(downloadSpy).toHaveBeenCalledWith(1);
    });
    downloadSpy.mockRestore();
  });

  it('shows a compact spec summary and full specs on process cards', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByTestId('toggle-unfiled-processes')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-unfiled-processes'));
    expect(screen.getByText('0.20mm Standard @BBL X1C')).toBeInTheDocument();

    const summary = screen.getByTestId('process-spec-summary');
    expect(summary).toHaveTextContent('0.2 mm');
    expect(summary).toHaveTextContent('Bed: Textured PEI');
    expect(summary).toHaveTextContent('20% infill');
    expect(summary).toHaveTextContent('Auto brim · 0.1 mm gap');
    expect(summary).toHaveTextContent('Supports: Off');
    expect(screen.queryByText('Current print specs')).not.toBeInTheDocument();

    fireEvent.click(summary);
    expect(screen.getByText('Current print specs')).toBeInTheDocument();
    expect(screen.getByText(/^Bed$/)).toBeInTheDocument();
    expect(screen.getByText(/^Textured PEI$/)).toBeInTheDocument();
    expect(screen.getByText('Layer height')).toBeInTheDocument();
    expect(screen.getByText('Infill density')).toBeInTheDocument();
    expect(screen.getByText('Walls')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.queryByText('Support type')).not.toBeInTheDocument();
  });

  it('does not show spec summary on filament cards', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    expect(screen.getAllByTestId('process-spec-summary')).toHaveLength(1);
  });

  it('invalidates the slicerPresets query after a delete (#1581)', async () => {
    // Without this invalidation a preset deleted in Local Profiles still
    // shows in the SliceModal until the modal's ['slicerPresets'] query
    // staleTime (60s) expires + a refocus / remount. The bug report:
    // "Removed local profiles still show on the slice menu even tho they
    // have been deleted." We mirror the production provider tree but inject
    // our own QueryClient so we can spy on invalidateQueries.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    rawRender(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ThemeProvider>
              <ToastProvider>
                <LocalProfilesView />
              </ToastProvider>
            </ThemeProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    // Open the delete confirmation, then confirm. The card-level delete
    // icon buttons and the modal's Delete button both expose the accessible
    // name "Delete"; the modal button is the last one to mount, so it's the
    // tail of the findAllByRole result.
    const deleteButtons = screen.getAllByTitle(/delete/i);
    fireEvent.click(deleteButtons[0]);
    await screen.findByText(/are you sure/i);
    const confirmButtons = await screen.findAllByRole('button', { name: /^delete$/i });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(
        invalidateSpy.mock.calls.some(
          ([arg]) => arg && (arg as { queryKey: unknown[] }).queryKey?.[0] === 'slicerPresets',
        ),
      ).toBe(true);
    });
    // Sanity: the local-only invalidation is still there too.
    expect(
      invalidateSpy.mock.calls.some(
        ([arg]) => arg && (arg as { queryKey: unknown[] }).queryKey?.[0] === 'localPresets',
      ),
    ).toBe(true);
  });

  const mockPartSection = {
    id: 10,
    name: 'Top part',
    parameter_tracking: true,
    locked_parameters: {
      layer_height: 0.2,
      sparse_infill_density: 20,
      curr_bed_type: 'Textured PEI Plate',
      wall_loops: 3,
      brim_type: 'auto_brim',
      brim_object_gap: 0.1,
      fuzzy_skin: 'none',
      enable_support: false,
    },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    slots: [
      {
        id: 21,
        printer_model: 'X1C',
        last_mismatch: false,
        spec_status: 'match' as const,
        parameter_diff: [],
        parameter_overrides: null,
        preset: {
          id: 3,
          name: '0.20mm Standard @BBL X1C',
          printer_model: 'X1C',
          locked_parameters: {
            layer_height: 0.2,
            sparse_infill_density: 20,
            curr_bed_type: 'Textured PEI Plate',
            wall_loops: 3,
            brim_type: 'auto_brim',
            brim_object_gap: 0.1,
            fuzzy_skin: 'none',
            enable_support: false,
          },
        },
      },
      {
        id: 22,
        printer_model: 'A1',
        last_mismatch: true,
        spec_status: 'mismatch' as const,
        parameter_diff: [
          { key: 'layer_height', locked: 0.2, incoming: 0.28, match: false },
        ],
        parameter_overrides: null,
        preset: {
          id: 5,
          name: '0.28mm Strength @BBL A1',
          printer_model: 'A1',
          locked_parameters: { layer_height: 0.28 },
        },
      },
    ],
  };

  it('renders part process sections with upload, mismatch chip, and replace controls', async () => {
    server.use(
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json([mockPartSection]);
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Top part')).toBeInTheDocument();
    });

    expect(screen.getByTestId('profile-part-sections')).toBeInTheDocument();
    expect(screen.getByText('Part process sections')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add process sections' })).toBeInTheDocument();
    expect(screen.getByText('0.28mm Strength @BBL A1')).toBeInTheDocument();
    expect(screen.getByText('Last replace had mismatches')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Matches spec' })).toBeInTheDocument();
    expect(screen.queryByTestId('slot-spec-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('add-part-section')).toBeInTheDocument();
    expect(screen.queryByTestId('add-part-process')).not.toBeInTheDocument();
    expect(screen.getByTestId('upload-part-process')).toBeInTheDocument();
    expect(screen.queryByTestId('toggle-unfiled-processes')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('profile-part-slot-replace').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('replace-part-process').length).toBeGreaterThan(0);
    expect(screen.queryByText('Choose a process preset')).not.toBeInTheDocument();
    const slots = screen.getAllByTestId('profile-part-slot');
    expect(slots.length).toBeGreaterThan(0);
    expect(within(slots[0]).getByTestId('download-local-preset')).toBeInTheDocument();

    expect(screen.queryByText('Current print specs')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Matches spec' }));
    expect(screen.getByText('Current print specs')).toBeInTheDocument();
    const specsDialog = screen.getByRole('dialog');
    expect(within(specsDialog).getByText(/^Bed$/)).toBeInTheDocument();
    expect(within(specsDialog).getByText('Layer height')).toBeInTheDocument();
    expect(within(specsDialog).getByText('0.2 mm')).toBeInTheDocument();
    expect(within(specsDialog).getByText('Infill density')).toBeInTheDocument();
    expect(within(specsDialog).getByText('Walls')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Last replace had mismatches' }));
    expect(screen.getByTestId('slot-mismatch-modal')).toBeInTheDocument();
    expect(screen.getByText('1 parameter(s) differ')).toBeInTheDocument();
    expect(screen.getByText('Locked value')).toBeInTheDocument();
    expect(screen.getByText('Incoming value')).toBeInTheDocument();
  });

  it('renames a part process section', async () => {
    const patched: { name?: string }[] = [];
    let current = mockPartSection;
    server.use(
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json([current]);
      }),
      http.patch('/api/v1/profile-parts/sections/:sectionId', async ({ request }) => {
        const body = (await request.json()) as { name: string };
        patched.push(body);
        current = { ...current, name: body.name };
        return HttpResponse.json(current);
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Top part')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rename-part-section'));
    const dialog = screen.getByTestId('rename-part-section-modal');
    expect(within(dialog).getByText('Rename section')).toBeInTheDocument();
    const input = screen.getByTestId('rename-part-section-input');
    expect(input).toHaveValue('Top part');
    fireEvent.change(input, { target: { value: 'Bottom housing' } });
    fireEvent.click(screen.getByTestId('rename-part-section-save'));

    await waitFor(() => {
      expect(patched).toEqual([{ name: 'Bottom housing' }]);
    });
    await waitFor(() => {
      expect(screen.getByText('Bottom housing')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('rename-part-section-modal')).not.toBeInTheDocument();
  });

  it('creates a section with track parameters on by default and can turn it off', async () => {
    const posted: { name?: string; parameter_tracking?: boolean }[] = [];
    server.use(
      http.post('/api/v1/profile-parts/sections', async ({ request }) => {
        const body = (await request.json()) as { name: string; parameter_tracking?: boolean };
        posted.push(body);
        return HttpResponse.json({
          id: 11,
          name: body.name,
          parameter_tracking: body.parameter_tracking ?? true,
          locked_parameters: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          slots: [],
        });
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByTestId('add-part-section')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('add-part-section'));
    const checkbox = screen.getByTestId('track-parameters');
    expect(checkbox).toBeChecked();
    expect(screen.getByText('Track parameters')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Top part'), { target: { value: 'Bottom part' } });
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(posted).toEqual([{ name: 'Bottom part', parameter_tracking: false }]);
    });
  });

  it('hides match chips when parameter tracking is off', async () => {
    server.use(
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json([{ ...mockPartSection, parameter_tracking: false }]);
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Top part')).toBeInTheDocument();
    });

    expect(screen.queryByText('Matches spec')).not.toBeInTheDocument();
    expect(screen.queryByText('Last replace had mismatches')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-part-slot-status')).not.toBeInTheDocument();
    expect(screen.getByTestId('upload-part-process')).toBeInTheDocument();
    expect(screen.getAllByTestId('profile-part-slot-replace').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('download-local-preset').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByTestId('profile-part-slot-own-specs')[0]);
    expect(screen.getByText('Current print specs')).toBeInTheDocument();
  });

  it('does not show a search-miss empty state when the query is empty and processes are in sections', async () => {
    server.use(
      http.get('/api/v1/local-presets/', () => {
        return HttpResponse.json({
          filament: [],
          printer: [],
          process: mockLocalPresets.process,
        });
      }),
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json([mockPartSection]);
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Top part')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search/i);
    expect(searchInput).toHaveValue('');
    expect(screen.queryByText(/no presets match your search/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no local presets/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-part-sections')).toBeInTheDocument();
    expect(screen.queryByTestId('toggle-unfiled-processes')).not.toBeInTheDocument();
  });

  it('opens the replace modal when section upload returns needs_replace', async () => {
    server.use(
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json([mockPartSection]);
      }),
      http.post('/api/v1/profile-parts/sections/:sectionId/import', () => {
        return HttpResponse.json({
          success: true,
          imported: 1,
          skipped: 0,
          errors: [],
          attached: [],
          needs_confirm: [],
          needs_replace: [
            {
              printer_model: 'X1C',
              preset_id: 9,
              preset_name: '0.16mm Optimal @BBL X1C',
              existing_slot_id: 21,
              preview: {
                parameter_diff: [
                  { key: 'layer_height', locked: 0.2, incoming: 0.16, match: false },
                ],
                has_mismatches: true,
                incoming_parameters: { layer_height: 0.16 },
                printer_model: 'X1C',
              },
            },
          ],
          section: mockPartSection,
        });
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByTestId('upload-part-process')).toBeInTheDocument();
    });

    const file = new File(
      [JSON.stringify({ name: '0.16mm Optimal @BBL X1C', type: 'process', layer_height: '0.16' })],
      'process.json',
      { type: 'application/json' },
    );
    fireEvent.change(screen.getByTestId('upload-part-process'), { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Replace process')).toBeInTheDocument();
    });
    expect(screen.getByText('0.16mm Optimal @BBL X1C')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /proceed/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument();
  });

  it('shows proceed anyway or do not upload when a new process mismatches', async () => {
    server.use(
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json([mockPartSection]);
      }),
      http.post('/api/v1/profile-parts/sections/:sectionId/import', () => {
        return HttpResponse.json({
          success: true,
          imported: 1,
          skipped: 0,
          errors: [],
          needs_replace: [],
          attached: [],
          needs_confirm: [
            {
              printer_model: 'H2S',
              preset_id: 8,
              preset_name: 'H2S - Top Settings',
              preview: {
                parameter_diff: [
                  { key: 'layer_height', locked: 0.2, incoming: 0.28, match: false },
                ],
                has_mismatches: true,
                incoming_parameters: { layer_height: 0.28 },
                printer_model: 'H2S',
              },
            },
          ],
          section: mockPartSection,
        });
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByTestId('upload-part-process')).toBeInTheDocument();
    });

    const file = new File(
      [JSON.stringify({ name: 'H2S - Top Settings', type: 'process', layer_height: '0.28' })],
      'h2s.json',
      { type: 'application/json' },
    );
    fireEvent.change(screen.getByTestId('upload-part-process'), { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId('confirm-attach-modal')).toBeInTheDocument();
    });
    expect(screen.getByText('Process does not match spec')).toBeInTheDocument();
    expect(screen.getByText('1 parameter(s) differ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /proceed anyway/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /don't upload/i })).toBeInTheDocument();
    expect(screen.queryByText('H2S - Top Settings')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-attach-cancel'));
    expect(screen.queryByTestId('confirm-attach-modal')).not.toBeInTheDocument();
    expect(screen.queryByText('H2S')).not.toBeInTheDocument();
  });

  it('replace on a slot uploads a file instead of opening the library picker', async () => {
    server.use(
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json([mockPartSection]);
      }),
      http.post('/api/v1/profile-parts/sections/:sectionId/import', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('slot_id')).toBe('21');
        return HttpResponse.json({
          success: true,
          imported: 1,
          skipped: 0,
          errors: [],
          attached: [],
          needs_confirm: [],
          needs_replace: [
            {
              printer_model: 'X1C',
              preset_id: 9,
              preset_name: '0.16mm Optimal @BBL X1C',
              existing_slot_id: 21,
              preview: {
                parameter_diff: [
                  { key: 'layer_height', locked: 0.2, incoming: 0.16, match: false },
                ],
                has_mismatches: true,
                incoming_parameters: { layer_height: 0.16 },
                printer_model: 'X1C',
              },
            },
          ],
          section: mockPartSection,
        });
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getAllByTestId('profile-part-slot-replace').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByTestId('profile-part-slot-replace')[0]);
    expect(screen.queryByText('Choose a process preset')).not.toBeInTheDocument();

    const file = new File(
      [JSON.stringify({ name: '0.16mm Optimal @BBL X1C', type: 'process', layer_height: '0.16' })],
      'process.json',
      { type: 'application/json' },
    );
    fireEvent.change(screen.getAllByTestId('replace-part-process')[0], { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Replace process')).toBeInTheDocument();
    });
    expect(screen.getByText('0.16mm Optimal @BBL X1C')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /proceed/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument();
    expect(screen.queryByText('Choose a process preset')).not.toBeInTheDocument();
  });

  const h2sProcess = {
    id: 8,
    name: '0.24mm Standard @BBL H2S',
    preset_type: 'process',
    source: 'bambu',
    filament_type: null,
    filament_vendor: null,
    nozzle_temp_min: null,
    nozzle_temp_max: null,
    pressure_advance: null,
    default_filament_colour: null,
    filament_cost: null,
    filament_density: null,
    compatible_printers: null,
    inherits: null,
    version: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    locked_parameters: { layer_height: 0.24 },
  };

  it('moves an unfiled process into a chosen section when it matches', async () => {
    const addCalls: unknown[] = [];
    const topAt028 = {
      ...mockPartSection,
      locked_parameters: { ...mockPartSection.locked_parameters, layer_height: 0.28 },
    };
    const h2sSlot = {
      id: 23,
      printer_model: 'H2S',
      last_mismatch: false,
      spec_status: 'match' as const,
      parameter_diff: [
        { key: 'layer_height', locked: 0.28, incoming: 0.24, match: true },
      ],
      parameter_overrides: null,
      preset: {
        id: 8,
        name: h2sProcess.name,
        printer_model: 'H2S',
        locked_parameters: { layer_height: 0.24 },
      },
    };
    let sections = [topAt028];
    server.use(
      http.get('/api/v1/local-presets/', () => {
        return HttpResponse.json({
          ...mockLocalPresets,
          process: [...mockLocalPresets.process, h2sProcess],
        });
      }),
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json(sections);
      }),
      http.post('/api/v1/profile-parts/sections/:sectionId/preview-add', () => {
        return HttpResponse.json({
          parameter_diff: [
            { key: 'layer_height', locked: 0.28, incoming: 0.24, match: true },
          ],
          has_mismatches: false,
          incoming_parameters: { layer_height: 0.24 },
          printer_model: 'H2S',
        });
      }),
      http.post('/api/v1/profile-parts/slots', async ({ request }) => {
        addCalls.push(await request.json());
        sections = [{ ...topAt028, slots: [...topAt028.slots, h2sSlot] }];
        return HttpResponse.json(sections[0]);
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByTestId('toggle-unfiled-processes')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-unfiled-processes'));
    const unfiledList = screen.getByTestId('unfiled-processes-list');
    expect(unfiledList).toHaveTextContent(h2sProcess.name);
    expect(unfiledList).not.toHaveTextContent('0.20mm Standard @BBL X1C');

    fireEvent.click(screen.getByTestId('move-unfiled-process'));
    expect(screen.getByTestId('move-unfiled-section-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('move-unfiled-section-option'));

    await waitFor(() => {
      expect(addCalls).toEqual([{ section_id: 10, preset_id: 8 }]);
    });
    expect(screen.queryByTestId('confirm-attach-modal')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(h2sProcess.name)).toBeInTheDocument();
    });
    expect(screen.getByTestId('section-spec-summary')).toHaveTextContent('0.28 mm');

    const h2sCard = screen.getAllByTestId('profile-part-slot').find((card) =>
      card.textContent?.includes(h2sProcess.name),
    );
    expect(h2sCard).toBeTruthy();
    fireEvent.click(within(h2sCard as HTMLElement).getByRole('button', { name: 'Matches spec' }));
    const specsDialog = screen.getByRole('dialog');
    expect(within(specsDialog).getByText('Layer height')).toBeInTheDocument();
    expect(within(specsDialog).getByText('0.24 mm')).toBeInTheDocument();
    expect(within(specsDialog).queryByText('0.28 mm')).not.toBeInTheDocument();
  });

  it('opens replace when the destination already has that printer', async () => {
    const extraX1c = {
      ...h2sProcess,
      id: 9,
      name: '0.16mm Optimal @BBL X1C',
      locked_parameters: { layer_height: 0.16 },
    };
    server.use(
      http.get('/api/v1/local-presets/', () => {
        return HttpResponse.json({
          ...mockLocalPresets,
          process: [...mockLocalPresets.process, extraX1c],
        });
      }),
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json([mockPartSection]);
      }),
      http.post('/api/v1/profile-parts/slots/:slotId/preview-replace', () => {
        return HttpResponse.json({
          parameter_diff: [
            { key: 'layer_height', locked: 0.2, incoming: 0.16, match: false },
          ],
          has_mismatches: true,
          incoming_parameters: { layer_height: 0.16 },
          printer_model: 'X1C',
        });
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByTestId('toggle-unfiled-processes')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-unfiled-processes'));
    fireEvent.click(screen.getByTestId('move-unfiled-process'));
    fireEvent.click(screen.getByTestId('move-unfiled-section-option'));

    await waitFor(() => {
      expect(screen.getByText('Replace process')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /proceed/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument();
  });

  it('asks to proceed or not move when the destination spec mismatches', async () => {
    const a1Process = {
      ...h2sProcess,
      id: 11,
      name: '0.28mm Strength @BBL P1S',
      locked_parameters: { layer_height: 0.28 },
    };
    server.use(
      http.get('/api/v1/local-presets/', () => {
        return HttpResponse.json({
          ...mockLocalPresets,
          process: [...mockLocalPresets.process, a1Process],
        });
      }),
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json([mockPartSection]);
      }),
      http.post('/api/v1/profile-parts/sections/:sectionId/preview-add', () => {
        return HttpResponse.json({
          parameter_diff: [
            { key: 'layer_height', locked: 0.2, incoming: 0.28, match: false },
          ],
          has_mismatches: true,
          incoming_parameters: { layer_height: 0.28 },
          printer_model: 'P1S',
        });
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByTestId('toggle-unfiled-processes')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-unfiled-processes'));
    fireEvent.click(screen.getByTestId('move-unfiled-process'));
    fireEvent.click(screen.getByTestId('move-unfiled-section-option'));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-attach-modal')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /proceed anyway/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /don't move/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /don't upload/i })).not.toBeInTheDocument();
  });

  it('moves an unfiled process into a non-tracking section without mismatch confirm', async () => {
    const addCalls: unknown[] = [];
    const loose = {
      ...mockPartSection,
      parameter_tracking: false,
      locked_parameters: null,
    };
    const extra = {
      ...h2sProcess,
      id: 12,
      name: '0.28mm Strength @BBL P1S',
      locked_parameters: { layer_height: 0.28 },
    };
    const p1sSlot = {
      id: 24,
      printer_model: 'P1S',
      last_mismatch: false,
      spec_status: 'match' as const,
      parameter_diff: [],
      parameter_overrides: null,
      preset: {
        id: 12,
        name: extra.name,
        printer_model: 'P1S',
        locked_parameters: { layer_height: 0.28 },
      },
    };
    let sections = [loose];
    server.use(
      http.get('/api/v1/local-presets/', () => {
        return HttpResponse.json({
          ...mockLocalPresets,
          process: [...mockLocalPresets.process, extra],
        });
      }),
      http.get('/api/v1/profile-parts/sections', () => {
        return HttpResponse.json(sections);
      }),
      http.post('/api/v1/profile-parts/slots', async ({ request }) => {
        addCalls.push(await request.json());
        sections = [{ ...loose, slots: [...loose.slots, p1sSlot] }];
        return HttpResponse.json(sections[0]);
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByTestId('toggle-unfiled-processes')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-unfiled-processes'));
    fireEvent.click(screen.getByTestId('move-unfiled-process'));
    fireEvent.click(screen.getByTestId('move-unfiled-section-option'));

    await waitFor(() => {
      expect(addCalls).toEqual([{ section_id: 10, preset_id: 12 }]);
    });
    expect(screen.queryByTestId('confirm-attach-modal')).not.toBeInTheDocument();
  });
});
