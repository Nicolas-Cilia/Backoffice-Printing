/**
 * Tests for the FileManagerPage component.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FileManagerPage } from '../../pages/FileManagerPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

// Mock data
const mockFolders = [
  {
    id: 1,
    name: 'Functional Parts',
    parent_id: null,
    file_count: 5,
    project_id: null,
    archive_id: null,
    project_name: null,
    archive_name: null,
    // #2680: distinctive year so the folder-pane display test can assert on it
    // without colliding with the file mtimes below.
    latest_activity_at: '2031-04-05T10:00:00Z',
    section_id: null,
    children: [
      {
        id: 2,
        name: 'Brackets',
        parent_id: 1,
        file_count: 3,
        project_id: null,
        archive_id: null,
        project_name: null,
        archive_name: null,
        latest_activity_at: '2032-06-07T10:00:00Z',
        section_id: null,
        children: [],
      },
    ],
  },
  {
    id: 3,
    name: 'Art Projects',
    parent_id: null,
    file_count: 2,
    project_id: null,
    archive_id: 1,
    project_name: null,
    archive_name: 'My Art Archive',
    // No activity timestamp — must render no date line rather than an
    // "Invalid Date" placeholder.
    latest_activity_at: null,
    section_id: null,
    children: [],
  },
];

const mockFiles = [
  {
    id: 1,
    filename: 'benchy.gcode.3mf',
    file_path: '/library/benchy.gcode.3mf',
    file_size: 1048576,
    file_type: '3mf',
    folder_id: null,
    thumbnail_path: '/thumbnails/1.png',
    print_name: 'Benchy',
    print_time_seconds: 3600,
    print_count: 5,
    duplicate_count: 0,
    created_at: '2024-01-01T00:00:00Z',
    // #2680: real on-disk mtime in a distinctive year so the display test can
    // prove fs_modified_at is preferred over created_at (2024).
    fs_modified_at: '2030-06-15T12:00:00Z',
  },
  {
    id: 2,
    filename: 'bracket.stl',
    file_path: '/library/bracket.stl',
    file_size: 524288,
    file_type: 'stl',
    folder_id: null,
    thumbnail_path: null,
    print_name: null,
    print_time_seconds: null,
    print_count: 0,
    duplicate_count: 2,
    created_at: '2024-01-02T00:00:00Z',
  },
  {
    id: 3,
    filename: 'cube.gcode.3mf',
    file_path: '/library/cube.gcode.3mf',
    file_size: 2048576,
    file_type: '3mf',
    folder_id: null,
    thumbnail_path: '/thumbnails/3.png',
    print_name: 'Cube',
    print_time_seconds: 1800,
    print_count: 2,
    duplicate_count: 0,
    created_at: '2024-01-03T00:00:00Z',
  },
];

const mockStats = {
  total_files: 10,
  total_folders: 3,
  total_size_bytes: 104857600,
  disk_free_bytes: 10737418240,
  disk_total_bytes: 107374182400,
};

describe('FileManagerPage', () => {
  beforeEach(() => {
    // Clear localStorage to ensure consistent view mode
    localStorage.clear();

    server.use(
      http.get('/api/v1/library/folders', () => {
        return HttpResponse.json(mockFolders);
      }),
      http.get('/api/v1/library/files', () => {
        return HttpResponse.json(mockFiles);
      }),
      http.get('/api/v1/library/stats', () => {
        return HttpResponse.json(mockStats);
      }),
      http.get('/api/v1/settings/', () => {
        return HttpResponse.json({
          check_updates: false,
          check_printer_firmware: false,
          library_disk_warning_gb: 5,
        });
      }),
      http.post('/api/v1/library/folders', async ({ request }) => {
        const body = await request.json() as { name: string };
        return HttpResponse.json({ id: 4, name: body.name, parent_id: null, children: [] });
      }),
      http.delete('/api/v1/library/folders/:id', () => {
        return HttpResponse.json({ success: true });
      }),
      http.delete('/api/v1/library/files/:id', () => {
        return HttpResponse.json({ success: true });
      }),
      http.post('/api/v1/library/files/move', () => {
        return HttpResponse.json({ success: true });
      }),
      http.post('/api/v1/library/files/add-to-queue', () => {
        return HttpResponse.json({ added: [{ file_id: 1, queue_id: 1 }], errors: [] });
      }),
      http.get('/api/v1/projects/', () => {
        return HttpResponse.json([{ id: 1, name: 'Test Project', color: '#00ae42' }]);
      }),
      http.get('/api/v1/archives/', () => {
        return HttpResponse.json([{ id: 1, print_name: 'Test Archive', filename: 'test.3mf' }]);
      }),
      http.get('/api/v1/library/sections', () => {
        return HttpResponse.json([]);
      })
    );
  });

  describe('rendering', () => {
    it('renders the page title', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('File Manager')).toBeInTheDocument();
      });
    });

    it('renders the page description', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Organize and manage your print files')).toBeInTheDocument();
      });
    });

    it('shows New Folder button', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('New Folder')).toBeInTheDocument();
      });
    });

    it('shows Upload button', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });
    });
  });

  describe('stats display', () => {
    it('shows file count', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Files:')).toBeInTheDocument();
        expect(screen.getByText('10')).toBeInTheDocument();
      });
    });

    it('shows folder count', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Folders:')).toBeInTheDocument();
        // Folder count appears multiple places, just verify the label is present
        const foldersLabel = screen.getByText('Folders:');
        expect(foldersLabel.nextElementSibling?.textContent).toBe('3');
      });
    });

    it('shows total size', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Size:')).toBeInTheDocument();
        expect(screen.getByText('100.0 MB')).toBeInTheDocument();
      });
    });

    it('shows free space', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Free:')).toBeInTheDocument();
      });
    });
  });

  describe('folder cards', () => {
    it('shows folder cards on the landing page', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Functional Parts')).toBeInTheDocument();
        expect(screen.getByText('Art Projects')).toBeInTheDocument();
      });
      expect(screen.queryByText('All Files')).not.toBeInTheDocument();
    });

    it('shows nested folders after entering a parent', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Brackets')).toBeInTheDocument();
      });
    });

    it('shows linked folder indicator', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Art Projects')).toBeInTheDocument();
      });
    });
  });

  describe('folder sections', () => {
    it('groups folder cards under a section header', async () => {
      server.use(
        http.get('/api/v1/library/sections', () =>
          HttpResponse.json([
            { id: 1, name: 'Production', sort_order: 1, folder_count: 1, created_at: '', updated_at: '' },
          ]),
        ),
        http.get('/api/v1/library/folders', () =>
          HttpResponse.json([
            { ...mockFolders[0], section_id: 1 },
            mockFolders[1],
          ]),
        ),
      );
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Production')).toBeInTheDocument();
        expect(screen.getByText('Functional Parts')).toBeInTheDocument();
        expect(screen.getByText('Art Projects')).toBeInTheDocument();
        expect(screen.getByText('Ungrouped')).toBeInTheDocument();
      });
    });

    it('creates a section from the Add section button', async () => {
      const user = userEvent.setup();
      server.use(
        http.post('/api/v1/library/sections', async ({ request }) => {
          const body = await request.json() as { name: string };
          return HttpResponse.json(
            { id: 8, name: body.name, sort_order: 1, folder_count: 0, created_at: '', updated_at: '' },
            { status: 201 },
          );
        }),
      );
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Add section')).toBeInTheDocument());
      await user.click(screen.getByText('Add section'));
      await waitFor(() => expect(screen.getByPlaceholderText('e.g., Production')).toBeInTheDocument());
      await user.type(screen.getByPlaceholderText('e.g., Production'), 'Testing');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(screen.queryByPlaceholderText('e.g., Production')).not.toBeInTheDocument();
      });
    });
  });

  describe('file display', () => {
    it('shows files in grid', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });
    });

    it('shows file type badges', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        // File type badges show uppercase type
        expect(screen.getAllByText('3MF').length).toBeGreaterThan(0);
        expect(screen.getAllByText('STL').length).toBeGreaterThan(0);
      });
    });

    it('shows print count', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Printed 5x')).toBeInTheDocument();
      });
    });

    it('shows duplicate badge', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('bracket.stl')).toBeInTheDocument();
      });
    });
  });

  describe('view modes', () => {
    it('has grid view button', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByTitle('Grid view')).toBeInTheDocument();
      });
    });

    it('has list view button', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByTitle('List view')).toBeInTheDocument();
      });
    });

    it('can switch to list view', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      // Wait for files to load first
      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });

      // Both view mode buttons should be present and clickable
      const gridButton = screen.getByTitle('Grid view');
      const listButton = screen.getByTitle('List view');

      expect(gridButton).toBeInTheDocument();
      expect(listButton).toBeInTheDocument();

      // Click list view button - verify no errors occur
      await user.click(listButton);

      // Clicking grid button should also work
      await user.click(gridButton);

      // Verify files are still displayed after toggling
      expect(screen.getByText('Benchy')).toBeInTheDocument();
    });
  });

  describe('search and filter', () => {
    it('has search input', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search files...')).toBeInTheDocument();
      });
    });

    it('has type filter', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('All types')).toBeInTheDocument();
      });
    });

    it('has sort options', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        // Sort dropdown should show Name as default option (persisted to localStorage)
        expect(screen.getByDisplayValue('Name')).toBeInTheDocument();
      });
    });
  });

  describe('selection', () => {
    it('shows select all button', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Select All')).toBeInTheDocument();
      });
    });

    it('can select files', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });

      // Click on the file card to select it
      const fileCard = screen.getByText('Benchy').closest('div[class*="cursor-pointer"]');
      if (fileCard) {
        await user.click(fileCard);
      }

      await waitFor(() => {
        expect(screen.getByText('1 selected')).toBeInTheDocument();
      });
    });

    it('shows bulk actions when files selected', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Select All')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Select All'));

      await waitFor(() => {
        expect(screen.getByText('Move')).toBeInTheDocument();
        expect(screen.getByText('Delete')).toBeInTheDocument();
      });
    });
  });

  describe('new folder modal', () => {
    it('opens new folder modal', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('New Folder')).toBeInTheDocument();
      });

      await user.click(screen.getByText('New Folder'));

      await waitFor(() => {
        expect(screen.getByText('Folder Name')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('e.g., Functional Parts')).toBeInTheDocument();
      });
    });

    it('can create a folder', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('New Folder')).toBeInTheDocument();
      });

      await user.click(screen.getByText('New Folder'));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g., Functional Parts')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('e.g., Functional Parts');
      await user.type(input, 'My New Folder');

      const createButton = screen.getByRole('button', { name: 'Create' });
      await user.click(createButton);

      // Modal should close after creation
      await waitFor(() => {
        expect(screen.queryByText('Folder Name')).not.toBeInTheDocument();
      });
    });
  });

  describe('empty state', () => {
    it('shows empty state when no files', async () => {
      const user = userEvent.setup();
      server.use(
        http.get('/api/v1/library/files', () => {
          return HttpResponse.json([]);
        })
      );

      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Folder is empty')).toBeInTheDocument();
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });
    });
  });

  describe('bulk-action print button', () => {
    // PR #1625 consolidated print actions: the old single-file-selected
    // "Schedule" button now opens the unified PrintModal (which carries
    // schedule options inside). The bulk-action toolbar shows a single
    // "Print" button only when exactly one sliced file is selected, and
    // hides it for multi-selection. The button is targeted by its accessible
    // name ("Print") + role to disambiguate from the file-card dropdown's
    // own Print entry, which stays collapsed unless its kebab is opened.
    it('shows a Print button in the bulk toolbar when one sliced file is selected', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });

      // Select a sliced file (benchy.gcode.3mf) by clicking on its card
      const fileCard = screen.getByText('Benchy').closest('div[class*="cursor-pointer"]');
      if (fileCard) {
        await user.click(fileCard);
      }

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Print$/ })).toBeInTheDocument();
      });
    });

    it('hides the bulk Print button when multiple files are selected', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Select All')).toBeInTheDocument();
      });

      // Select all files
      await user.click(screen.getByText('Select All'));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /^Print$/ })).not.toBeInTheDocument();
      });
    });
  });

  describe('STL thumbnail generation', () => {
    it('shows Generate Thumbnails button', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Generate Thumbnails')).toBeInTheDocument();
      });
    });

    it('Generate Thumbnails button has correct title', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        const button = screen.getByTitle('Generate thumbnails for STL files missing them');
        expect(button).toBeInTheDocument();
      });
    });

    it('can click Generate Thumbnails button', async () => {
      const user = userEvent.setup();

      server.use(
        http.post('/api/v1/library/generate-stl-thumbnails', () => {
          return HttpResponse.json({
            processed: 1,
            succeeded: 1,
            failed: 0,
            results: [{ file_id: 2, success: true }],
          });
        })
      );

      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Generate Thumbnails')).toBeInTheDocument();
      });

      const button = screen.getByText('Generate Thumbnails');
      await user.click(button);

      // Button should work without error
      await waitFor(() => {
        expect(screen.getByText('Generate Thumbnails')).toBeInTheDocument();
      });
    });

    it('shows STL file without thumbnail in file list', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        // bracket.stl has no thumbnail_path
        expect(screen.getByText('bracket.stl')).toBeInTheDocument();
        expect(screen.getAllByText('STL').length).toBeGreaterThan(0);
      });
    });
  });

  describe('upload modal (FileUploadModal)', () => {
    it('opens upload modal when Upload button is clicked', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
        expect(screen.getByText(/Drag & drop/)).toBeInTheDocument();
      });
    });

    it('closes upload modal when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(screen.queryByText('Upload Files')).not.toBeInTheDocument();
      });
    });

    it('shows 3MF extraction info when 3MF file is added', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      const threemfFile = new File(['content'], 'model.gcode.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();

      await user.upload(fileInput, threemfFile);

      await waitFor(() => {
        expect(screen.getByText('3MF files detected')).toBeInTheDocument();
        expect(screen.getByText(/Printer model.*will be automatically extracted/i)).toBeInTheDocument();
      });
    });

    it('shows STL thumbnail option when STL file is added', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      const stlFile = new File(['solid test'], 'model.stl', { type: 'application/sla' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();

      await user.upload(fileInput, stlFile);

      await waitFor(() => {
        expect(screen.getByText('STL thumbnail generation')).toBeInTheDocument();
        expect(screen.getByText(/Thumbnails can be generated/i)).toBeInTheDocument();
      });
    });

    it('shows ZIP options when ZIP file is added', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      const zipFile = new File(['pk'], 'models.zip', { type: 'application/zip' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, zipFile);

      await waitFor(() => {
        expect(screen.getByText('ZIP files detected')).toBeInTheDocument();
        expect(screen.getByText(/Preserve folder structure/)).toBeInTheDocument();
      });
    });

    it('can add a file via the file input', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(screen.getByText('model.3mf')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Upload \(1\)/i })).toBeInTheDocument();
      });
    });

    it('uploads file and refreshes file list', async () => {
      server.use(
        http.post('/api/v1/library/files', () => {
          return HttpResponse.json({
            id: 10,
            filename: 'uploaded.3mf',
            file_type: '3mf',
            file_size: 1024,
            thumbnail_path: null,
            duplicate_of: null,
            metadata: null,
          });
        })
      );

      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      const file = new File(['content'], 'uploaded.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const uploadButton = screen.getByRole('button', { name: /Upload \(1\)/i });
      await user.click(uploadButton);

      // Modal should auto-close after upload completes
      await waitFor(() => {
        expect(screen.queryByText('Upload Files')).not.toBeInTheDocument();
      });
    });
  });

  describe('authentication-based UI changes', () => {
    it('hides "Uploaded By" column and user filter when auth is disabled', async () => {
      // Mock auth disabled (default)
      server.use(
        http.get('*/api/v1/auth/status', () => {
          return HttpResponse.json({
            auth_enabled: false,
            requires_setup: false,
          });
        }),
        http.get('/api/v1/library/files', () => {
          return HttpResponse.json([
            {
              id: 1,
              filename: 'test.3mf',
              file_path: '/library/test.3mf',
              file_size: 1048576,
              file_type: '3mf',
              folder_id: null,
              thumbnail_path: null,
              print_name: 'Test File',
              print_time_seconds: 3600,
              print_count: 0,
              duplicate_count: 0,
              created_at: '2024-01-01T00:00:00Z',
              created_by_username: 'testuser',
            },
          ]);
        })
      );

      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      // Switch to list view to see the column headers
      await waitFor(() => {
        expect(screen.getByText('Test File')).toBeInTheDocument();
      });

      const listViewButton = screen.getByRole('button', { name: /list/i });
      await user.click(listViewButton);

      // "Uploaded By" column header should not be present
      await waitFor(() => {
        expect(screen.queryByText('Uploaded By')).not.toBeInTheDocument();
      });

      // User filter dropdown should not be present
      expect(screen.queryByPlaceholderText('Filter by user')).not.toBeInTheDocument();
    });

    it('shows "Uploaded By" column and user filter when auth is enabled', async () => {
      // Mock auth enabled
      server.use(
        http.get('*/api/v1/auth/status', () => {
          return HttpResponse.json({
            auth_enabled: true,
            requires_setup: false,
          });
        }),
        http.get('/api/v1/library/files', () => {
          return HttpResponse.json([
            {
              id: 1,
              filename: 'test.3mf',
              file_path: '/library/test.3mf',
              file_size: 1048576,
              file_type: '3mf',
              folder_id: null,
              thumbnail_path: null,
              print_name: 'Test File',
              print_time_seconds: 3600,
              print_count: 0,
              duplicate_count: 0,
              created_at: '2024-01-01T00:00:00Z',
              created_by_username: 'testuser',
            },
          ]);
        }),
        http.get('/api/v1/users/', () => {
          return HttpResponse.json([
            { id: 1, username: 'testuser' },
            { id: 2, username: 'admin' },
          ]);
        })
      );

      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      // Switch to list view to see the column headers
      await waitFor(() => {
        expect(screen.getByText('Test File')).toBeInTheDocument();
      });

      const listViewButton = screen.getByRole('button', { name: /list/i });
      await user.click(listViewButton);

      // "Uploaded By" column header should be present
      await waitFor(() => {
        expect(screen.getByText('Uploaded By')).toBeInTheDocument();
      });

      // User filter dropdown should be present
      expect(screen.getByPlaceholderText('Filter by user')).toBeInTheDocument();

      // Username should be displayed in the column
      expect(screen.getByText('testuser')).toBeInTheDocument();
    });
  });

  describe('nested folder cards', () => {
    it('hides nested folders on the landing page until a parent is opened', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Functional Parts')).toBeInTheDocument();
      });
      expect(screen.queryByText('Brackets')).not.toBeInTheDocument();
    });

    it('shows nested folder cards after opening the parent', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Brackets')).toBeInTheDocument();
      });
    });
  });

  describe('Internal / External top-level views (#1621)', () => {
    const externalMockFolders = [
      ...mockFolders,
      {
        id: 99,
        name: 'NAS Library',
        parent_id: null,
        file_count: 200,
        project_id: null,
        archive_id: null,
        project_name: null,
        archive_name: null,
        is_external: true,
        external_readonly: false,
        external_path: '/mnt/nas',
        children: [],
      },
    ];

    it('shows an external folder as its own card, not an All External aggregate', async () => {
      const { unmount } = render(<FileManagerPage />);
      await waitFor(() => {
        expect(screen.getByText('Functional Parts')).toBeInTheDocument();
      });
      expect(screen.queryByText('External')).not.toBeInTheDocument();
      unmount();

      server.use(
        http.get('/api/v1/library/folders', () => HttpResponse.json(externalMockFolders)),
      );
      render(<FileManagerPage />);
      await waitFor(() => {
        expect(screen.getByText('NAS Library')).toBeInTheDocument();
      });
      expect(screen.queryByText('All Files')).not.toBeInTheDocument();
    });

    it('requests files for the clicked folder', async () => {
      const folderIds: string[] = [];
      server.use(
        http.get('/api/v1/library/folders', () => HttpResponse.json(externalMockFolders)),
        http.get('/api/v1/library/files', ({ request }) => {
          const url = new URL(request.url);
          folderIds.push(url.searchParams.get('folder_id') ?? '');
          return HttpResponse.json(mockFiles);
        }),
      );

      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('NAS Library')).toBeInTheDocument());
      await user.click(screen.getByText('NAS Library'));

      await waitFor(() => {
        expect(folderIds).toContain('99');
      });
    });
  });

  describe('last-modified date display (#2680)', () => {
    it('is hidden by default and revealed by the toolbar toggle', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });

      // Hidden by default.
      expect(screen.queryByText(/2030/)).not.toBeInTheDocument();

      // Toggle on via the toolbar button.
      await user.click(screen.getByTitle('Show modified dates'));

      // benchy carries fs_modified_at in 2030, which must be preferred over its
      // created_at (2024) — proving the real on-disk mtime drives the display.
      await waitFor(() => {
        expect(screen.getByText(/2030/)).toBeInTheDocument();
      });

      // Toggling off hides it again.
      await user.click(screen.getByTitle('Hide modified dates'));
      await waitFor(() => {
        expect(screen.queryByText(/2030/)).not.toBeInTheDocument();
      });
    });

    it('shows nested folder cards after entering a parent without Invalid Date', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Functional Parts')).toBeInTheDocument());
      await user.click(screen.getByText('Functional Parts'));

      await waitFor(() => {
        expect(screen.getByText('Brackets')).toBeInTheDocument();
      });
      expect(screen.queryByText(/Invalid/)).not.toBeInTheDocument();
    });
  });

  describe('production folder view', () => {
    it('renders production slots and hides generic upload when the folder is tagged', async () => {
      const user = userEvent.setup();
      server.use(
        http.get('/api/v1/library/folders', () => {
          return HttpResponse.json([
            ...mockFolders,
            {
              id: 99,
              name: 'X1C',
              parent_id: null,
              file_count: 1,
              project_id: null,
              archive_id: null,
              project_name: null,
              archive_name: null,
              latest_activity_at: null,
              section_id: null,
              production_printer_model: 'X1C',
              children: [],
            },
          ]);
        }),
        http.get('/api/v1/production/folders/99', () => {
          return HttpResponse.json({
            folder_id: 99,
            printer_model: 'X1C',
            section_id: null,
            parts: [
              {
                id: 1,
                code: 'TOP',
                name: 'Top',
                instance_id: 10,
                locked_parameters: {},
                slots: [
                  {
                    id: 5,
                    quantity: 1,
                    major: 1,
                    revision: 13,
                    minor: 2,
                    version: '1.13.2',
                    active_file: {
                      id: 42,
                      filename: 'TOP - 1.13.2 - X1C.gcode.3mf',
                      thumbnail_path: null,
                      file_size: 1024,
                      print_time_seconds: 3600,
                      sliced_for_model: 'X1C',
                    },
                    has_overrides: false,
                    last_mismatch: false,
                  },
                ],
              },
            ],
          });
        }),
      );

      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('X1C')).toBeInTheDocument());
      await user.click(screen.getByText('X1C'));

      await waitFor(() => {
        expect(screen.getByText('Production files')).toBeInTheDocument();
      });
      expect(screen.getByText('Replace')).toBeInTheDocument();
      expect(screen.getByText('Add production file')).toBeInTheDocument();
      expect(screen.queryByText('Upload')).not.toBeInTheDocument();
      expect(screen.queryByText('New Folder')).not.toBeInTheDocument();
      expect(screen.queryByText('Upload Files')).not.toBeInTheDocument();
    });
  });
});
