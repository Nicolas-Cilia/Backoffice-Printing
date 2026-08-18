import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { ReplaceProductionFileModal } from '../../../components/production/ReplaceProductionFileModal';
import { AddProductionFileModal } from '../../../components/production/AddProductionFileModal';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import type { ProductionPartView, ProductionReplacePreview } from '../../../api/client';

const mockPreview: ProductionReplacePreview = {
  parsed_filename: {
    code: 'TOP',
    quantity: 1,
    major: 1,
    revision: 14,
    minor: 0,
    printer: 'X1C',
    version: '1.14.0',
  },
  current_version: '1.13.2',
  incoming_version: '1.14.0',
  version_is_newer: true,
  suggested_next_version: '1.14.0',
  parameter_diff: [
    { key: 'nozzle_diameter', locked: 0.4, incoming: 0.4, match: true },
    { key: 'layer_height', locked: 0.2, incoming: 0.16, match: false },
  ],
  has_mismatches: true,
  printer_matches_folder: true,
};

const emptyParts: ProductionPartView[] = [
  { id: 1, code: 'TOP', name: 'Top', instance_id: null, locked_parameters: null, slots: [] },
];

const partsWithX1Contract: ProductionPartView[] = [
  {
    id: 1,
    code: 'TOP',
    name: 'Top',
    instance_id: 10,
    locked_parameters: { layer_height: 0.2 },
    slots: [
      {
        id: 5,
        quantity: 1,
        major: 1,
        revision: 0,
        minor: 0,
        version: '1.0.0',
        active_file: {
          id: 42,
          filename: 'TOP - 1.0.0 - X1C.3mf',
          thumbnail_path: null,
          file_size: 10,
          print_time_seconds: null,
          sliced_for_model: 'X1C',
        },
        has_overrides: false,
        last_mismatch: false,
        parameter_overrides: null,
      },
    ],
  },
];

describe('ReplaceProductionFileModal', () => {
  beforeEach(() => {
    server.use(
      http.post('/api/v1/production/slots/:id/preview-replace', () => {
        return HttpResponse.json(mockPreview);
      }),
    );
  });

  it('keeps the Choose file dropzone label on a theme-aware hover class', () => {
    render(
      <ReplaceProductionFileModal
        slotId={7}
        currentVersion="1.13.2"
        printerModel="X1C"
        onClose={vi.fn()}
        onReplaced={vi.fn()}
      />,
    );

    const pickFile = screen.getByRole('button', { name: /Choose file/i });
    expect(pickFile.className).toContain('hover:text-white');
  });

  it('shows a green/red diff table after preview-replace', async () => {
    const user = userEvent.setup();
    render(
      <ReplaceProductionFileModal
        slotId={7}
        currentVersion="1.13.2"
        printerModel="X1C"
        onClose={vi.fn()}
        onReplaced={vi.fn()}
      />,
    );

    expect(screen.getByText('Replace')).toBeInTheDocument();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['3mf'], 'TOP - 1.14.0 - X1C.gcode.3mf', { type: 'application/octet-stream' });
    await user.upload(input, file);

    await waitFor(() => {
      expect(screen.getByText('nozzle_diameter')).toBeInTheDocument();
      expect(screen.getByText('Layer height')).toBeInTheDocument();
    });
    expect(screen.getByText('0.2 mm')).toBeInTheDocument();
    expect(screen.getByText('0.16 mm')).toBeInTheDocument();
    expect(screen.getByText('Proceed anyway')).toBeInTheDocument();
    expect(screen.getByText('Accept as new baseline')).toBeInTheDocument();
    expect(screen.getByText('1 parameter(s) differ')).toBeInTheDocument();
  });
});

describe('AddProductionFileModal', () => {
  it('keeps the Choose file dropzone label on a theme-aware hover class', () => {
    render(
      <AddProductionFileModal
        folderId={9}
        printerModel="X1C"
        parts={emptyParts}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    const pickFile = screen.getByRole('button', { name: /Choose file/i });
    expect(pickFile.className).toContain('hover:text-white');
  });

  it('fills identity from the filename and requires new-slot confirmation', async () => {
    const user = userEvent.setup();
    render(
      <AddProductionFileModal
        folderId={9}
        printerModel="X1C"
        parts={emptyParts}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['3mf'], 'KNB x2 - 1.0.0 - X1C.gcode.3mf', { type: 'application/octet-stream' });
    await user.upload(input, file);

    await waitFor(() => {
      expect(screen.getByDisplayValue('KNB')).toBeInTheDocument();
      expect(screen.getByDisplayValue('2')).toBeInTheDocument();
    });
    expect(screen.getByText(/This will create a new production slot/)).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create slot' });
    expect(create).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    expect(create).not.toBeDisabled();
  });

  it('does not warn that the slot exists until a file is chosen', async () => {
    const user = userEvent.setup();
    render(
      <AddProductionFileModal
        folderId={9}
        printerModel="A1"
        parts={partsWithX1Contract}
        initialCode="TOP"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const colliding = new File(['3mf'], 'TOP x1 - 1.13.2 - A1.gcode.3mf', { type: 'application/octet-stream' });
    await user.upload(input, colliding);

    await waitFor(() => {
      expect(screen.getByText(/already exists/)).toBeInTheDocument();
    });
  });

  it('previews the shared contract when adding a second quantity', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/production/slots/preview', () => HttpResponse.json(mockPreview)),
    );

    render(
      <AddProductionFileModal
        folderId={9}
        printerModel="X1C"
        parts={partsWithX1Contract}
        initialCode="TOP"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['3mf'], 'TOP x2 - 1.14.0 - X1C.gcode.3mf', { type: 'application/octet-stream' });
    await user.upload(input, file);

    await waitFor(() => {
      expect(screen.getByText('Layer height')).toBeInTheDocument();
    });
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
    expect(screen.getByText(/share one print-settings contract/)).toBeInTheDocument();
    expect(screen.getByText('Proceed anyway')).toBeInTheDocument();
    expect(screen.getByText('Accept as new baseline')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
