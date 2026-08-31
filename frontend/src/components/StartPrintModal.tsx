import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  FileBox,
  Folder,
  HardDrive,
  Loader2,
  Printer,
  Search,
  SortAsc,
  SortDesc,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import type { LibraryFileListItem, LibraryFolderTree } from '../api/client';
import { FileUploadModal } from './FileUploadModal';
import { PrintModal } from './PrintModal';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { formatDuration, parseUTCDate } from '../utils/date';
import { formatFileSize } from '../utils/file';

type SortField = 'name' | 'date' | 'size';
type SortDirection = 'asc' | 'desc';

const SECTION_LABEL_CLASS =
  'text-[10px] uppercase tracking-wider text-bambu-gray font-medium';

interface ChosenPrintFile {
  id: number;
  filename: string;
  slicedForModel?: string | null;
  thumbnailPath?: string | null;
  fileSize?: number | null;
  printTimeSeconds?: number | null;
  fileType?: string | null;
  /** True when this file was uploaded for this print (not picked from library). */
  fromUpload: boolean;
}

export interface StartPrintModalProps {
  printerName: string;
  printerModel: string | null;
  /** When set, choosing a file embeds print options in the right panel for this printer. */
  printerId: number | null;
  /** A just-dropped upload to show in the right-side print panel immediately. */
  initialFile?: Omit<ChosenPrintFile, 'fromUpload'>;
  onClose: () => void;
  onSuccess?: () => void;
}

function isPrintableFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.gcode') || lower.includes('.gcode.');
}

function findFolderPath(
  items: LibraryFolderTree[],
  id: number,
  trail: LibraryFolderTree[] = [],
): LibraryFolderTree[] | null {
  for (const item of items) {
    const next = [...trail, item];
    if (item.id === id) return next;
    const found = findFolderPath(item.children, id, next);
    if (found) return found;
  }
  return null;
}

function flattenFolderOptions(
  items: LibraryFolderTree[],
  prefix = '',
): Array<{ id: number; label: string }> {
  const out: Array<{ id: number; label: string }> = [];
  for (const item of items) {
    const label = prefix ? `${prefix} / ${item.name}` : item.name;
    out.push({ id: item.id, label });
    if (item.children?.length) {
      out.push(...flattenFolderOptions(item.children, label));
    }
  }
  return out;
}

function FolderCardGrid({
  folders,
  onSelect,
  disabled,
}: {
  folders: LibraryFolderTree[];
  onSelect: (id: number) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
      {folders.map((folder) => (
        <button
          key={folder.id}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(folder.id)}
          className="flex flex-col items-start gap-2 p-3 sm:p-4 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary hover:border-bambu-green/50 text-left transition-colors disabled:opacity-50 disabled:pointer-events-none disabled:hover:border-bambu-dark-tertiary"
        >
          <Folder className="w-8 h-8 text-bambu-green" />
          <span className="text-sm text-white font-medium truncate w-full" title={folder.name}>
            {folder.name}
          </span>
          <span className="text-xs text-bambu-gray">
            {folder.file_count} {t('fileManager.files').toLowerCase()}
          </span>
        </button>
      ))}
    </div>
  );
}

function ContentSection({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="space-y-2">
      <div className={SECTION_LABEL_CLASS}>{label}</div>
      {children}
    </div>
  );
}

export function StartPrintModal({
  printerName,
  printerModel,
  printerId,
  initialFile,
  onClose,
  onSuccess,
}: StartPrintModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canUpload = hasPermission('library:upload');
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [chosenFile, setChosenFile] = useState<ChosenPrintFile | null>(() =>
    initialFile ? { ...initialFile, fromUpload: true } : null,
  );
  /** Only for uploads: keep the file in the library after print. */
  const [saveToLibrary, setSaveToLibrary] = useState(false);
  const [saveFolderId, setSaveFolderId] = useState<number | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [isPrintSubmitting, setIsPrintSubmitting] = useState(false);
  const [filamentWarningOpen, setFilamentWarningOpen] = useState(false);
  const [isDiscardingUpload, setIsDiscardingUpload] = useState(false);
  // Keep a discarded upload out of the picker immediately while its soft
  // delete request is completing. This prevents a stale library query from
  // making a temporary print upload look like it was saved.
  const [discardedUploadIds, setDiscardedUploadIds] = useState<Set<number>>(
    () => new Set(),
  );
  /** After a successful queue, PrintModal still calls onClose — skip discard then. */
  const skipDiscardOnCloseRef = useRef(false);
  const saveToLibraryRef = useRef(saveToLibrary);
  saveToLibraryRef.current = saveToLibrary;

  const { data: folders, isLoading: foldersLoading } = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => api.getLibraryFolders(),
  });

  const { data: folderSections = [] } = useQuery({
    queryKey: ['library-sections'],
    queryFn: () => api.getLibraryFolderSections(),
  });

  const { data: libraryStats } = useQuery({
    queryKey: ['library-stats'],
    queryFn: () => api.getLibraryStats(),
  });

  const searchExpandsSubfolders = selectedFolderId !== null && searchQuery.trim().length > 0;
  const { data: files, isLoading: filesLoading } = useQuery({
    queryKey: ['library-files', selectedFolderId, searchExpandsSubfolders],
    queryFn: () =>
      api.getLibraryFiles(
        selectedFolderId,
        selectedFolderId == null,
        undefined,
        searchExpandsSubfolders,
      ),
  });

  const folderPath = useMemo(
    () => (selectedFolderId && folders ? findFolderPath(folders, selectedFolderId) : null),
    [folders, selectedFolderId],
  );
  const childFolders = useMemo(() => {
    if (!folders) return [];
    if (!folderPath) return folders;
    return folderPath[folderPath.length - 1]?.children ?? [];
  }, [folders, folderPath]);

  const filteredFolders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return childFolders;
    return childFolders.filter((folder) => folder.name.toLowerCase().includes(query));
  }, [childFolders, searchQuery]);

  const isAtRoot = selectedFolderId == null;
  const hasNamedSections = isAtRoot && folderSections.length > 0;

  const ungroupedRootFolders = useMemo(() => {
    if (!hasNamedSections) return filteredFolders;
    return filteredFolders.filter((folder) => folder.section_id == null);
  }, [filteredFolders, hasNamedSections]);

  const foldersBySection = useMemo(() => {
    const map: Record<number, LibraryFolderTree[]> = {};
    if (!hasNamedSections) return map;
    for (const folder of filteredFolders) {
      if (folder.section_id == null) continue;
      (map[folder.section_id] ||= []).push(folder);
    }
    return map;
  }, [filteredFolders, hasNamedSections]);

  const filteredAndSortedFiles = useMemo(() => {
    if (!files) return [];
    let result = [...files];
    // Hide an unsaved upload from "Your files" so it doesn't look like we auto-filed it.
    const hiddenUploadIds = new Set(discardedUploadIds);
    if (chosenFile?.fromUpload && !saveToLibrary) hiddenUploadIds.add(chosenFile.id);
    result = result.filter((f) => !hiddenUploadIds.has(f.id));
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (f) =>
          f.filename.toLowerCase().includes(query) ||
          (f.print_name && f.print_name.toLowerCase().includes(query)),
      );
    }
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = (a.print_name || a.filename).localeCompare(b.print_name || b.filename);
          break;
        case 'date':
          comparison =
            (parseUTCDate(a.fs_modified_at ?? a.created_at)?.getTime() ?? 0) -
            (parseUTCDate(b.fs_modified_at ?? b.created_at)?.getTime() ?? 0);
          break;
        case 'size':
          comparison = a.file_size - b.file_size;
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return result;
  }, [files, searchQuery, sortField, sortDirection, chosenFile, saveToLibrary, discardedUploadIds]);

  const folderSaveOptions = useMemo(
    () => (folders ? flattenFolderOptions(folders) : []),
    [folders],
  );

  const isLoading = foldersLoading || filesLoading;
  const hasAnyFolders = filteredFolders.length > 0;
  const hasAnyFiles = filteredAndSortedFiles.length > 0;
  const filePicksDisabled = chosenFile != null || isPrintSubmitting;
  const shellCloseBlocked = isPrintSubmitting || filamentWarningOpen || isDiscardingUpload;

  const checkCompatibility = (slicedFor: string | null | undefined): string | undefined => {
    if (slicedFor && printerModel && slicedFor.toLowerCase() !== printerModel.toLowerCase()) {
      return t(
        'printers.incompatibleFile',
        'This file was sliced for {{slicedFor}}, but this printer is a {{printerModel}}',
        { slicedFor, printerModel },
      );
    }
  };

  const discardEphemeralUpload = async (
    file: ChosenPrintFile | null,
    keepInLibrary = saveToLibraryRef.current,
  ) => {
    if (!file?.fromUpload) return;
    // Only delete if the user chose not to keep it in the library.
    if (keepInLibrary) return;
    setDiscardedUploadIds((previous) => {
      const next = new Set(previous);
      next.add(file.id);
      return next;
    });
    setIsDiscardingUpload(true);
    try {
      await api.deleteLibraryFile(file.id);
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
    } catch {
      setDiscardedUploadIds((previous) => {
        const next = new Set(previous);
        next.delete(file.id);
        return next;
      });
      showToast(
        t('printers.discardUploadFailed', 'Could not discard the temporary upload.'),
        'error',
      );
    } finally {
      setIsDiscardingUpload(false);
    }
  };

  const resetChosenFile = async () => {
    const previous = chosenFile;
    setChosenFile(null);
    setSaveToLibrary(false);
    setSaveFolderId(null);
    // Clearing chosenFile unmounts PrintModal; reset shell flags so close stays usable.
    setFilamentWarningOpen(false);
    setIsPrintSubmitting(false);
    await discardEphemeralUpload(previous);
  };

  const handleClose = async () => {
    if (shellCloseBlocked) return;
    await resetChosenFile();
    onClose();
  };

  const chooseFile = (file: ChosenPrintFile) => {
    if (printerId == null) {
      showToast(
        t('printers.noPrinterSelected', 'No printer selected'),
        'error',
      );
      if (file.fromUpload) {
        api.deleteLibraryFile(file.id).catch(() => {});
      }
      return;
    }
    // Switching files: discard the previous ephemeral upload if it differs.
    const previous = chosenFile;
    if (previous && previous.fromUpload && previous.id !== file.id) {
      void discardEphemeralUpload(previous, saveToLibrary);
    }
    setSaveToLibrary(false);
    setSaveFolderId(null);
    setChosenFile(file);
  };

  const handleSelectFile = (file: LibraryFileListItem) => {
    if (filePicksDisabled) return;
    if (!isPrintableFilename(file.filename)) {
      showToast(
        t('printers.dropNotPrintable', 'Only .gcode and .gcode.3mf files can be printed'),
        'error',
      );
      return;
    }
    const error = checkCompatibility(file.sliced_for_model);
    if (error) {
      showToast(error, 'error');
      return;
    }
    chooseFile({
      id: file.id,
      filename: file.print_name || file.filename,
      slicedForModel: file.sliced_for_model,
      thumbnailPath: file.thumbnail_path,
      fileSize: file.file_size,
      printTimeSeconds: file.print_time_seconds,
      fileType: file.file_type,
      fromUpload: false,
    });
  };

  const applySaveFolder = async (folderId: number | null) => {
    if (!chosenFile?.fromUpload) return;
    setSaveBusy(true);
    try {
      await api.moveLibraryFiles([chosenFile.id], folderId);
      setSaveFolderId(folderId);
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t('fileManager.moveFailed', 'Failed to move file'),
        'error',
      );
    } finally {
      setSaveBusy(false);
    }
  };

  const handleSaveToLibraryChange = async (checked: boolean) => {
    setSaveToLibrary(checked);
    if (!checked) {
      // Park back at root (unfiled) so cleanup after print can remove it.
      if (chosenFile?.fromUpload && saveFolderId != null) {
        await applySaveFolder(null);
      }
      setSaveFolderId(null);
      return;
    }
    // Default destination: root / Your files until the user picks a folder.
    setSaveFolderId(null);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // ConfirmModal owns Escape while the filament warning is open.
      if (filamentWarningOpen || isPrintSubmitting) return;
      void handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // handleClose closes over latest chosenFile / save flags via state in resetChosenFile
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenFile, saveToLibrary, saveFolderId, onClose, filamentWarningOpen, isPrintSubmitting]);

  const renderFolderSections = () => {
    if (!hasNamedSections) {
      if (!hasAnyFolders) return null;
      return (
        <ContentSection label={t('fileManager.folders')} testId="start-print-folders-section">
          <FolderCardGrid
            folders={filteredFolders}
            onSelect={setSelectedFolderId}
            disabled={filePicksDisabled}
          />
        </ContentSection>
      );
    }

    return (
      <>
        {(ungroupedRootFolders.length > 0 || folderSections.length === 0) && (
          <ContentSection
            label={
              folderSections.length > 0
                ? t('fileManager.ungrouped')
                : t('fileManager.folders')
            }
            testId="start-print-folders-section"
          >
            {ungroupedRootFolders.length > 0 ? (
              <FolderCardGrid
                folders={ungroupedRootFolders}
                onSelect={setSelectedFolderId}
                disabled={filePicksDisabled}
              />
            ) : (
              <p className="text-sm text-bambu-gray">{t('fileManager.chooseFolderDescription')}</p>
            )}
          </ContentSection>
        )}
        {folderSections.map((section) => {
          const sectionFolders = foldersBySection[section.id] ?? [];
          if (sectionFolders.length === 0) return null;
          return (
            <ContentSection
              key={section.id}
              label={section.name}
              testId={`start-print-library-section-${section.id}`}
            >
              <FolderCardGrid
                folders={sectionFolders}
                onSelect={setSelectedFolderId}
                disabled={filePicksDisabled}
              />
            </ContentSection>
          );
        })}
      </>
    );
  };

  // This modal renders as a plain nested child of whatever opened it (e.g. a
  // printer card that has its own drop-to-print zone), not through a portal,
  // and the embedded upload dropzone (FileUploadModal) doesn't stop
  // propagation. Left unguarded, dropping a file anywhere in this modal
  // bubbles out to that ancestor's drop handler too — uploading the file a
  // second time and opening a second, out-of-sync copy of this modal on top
  // of itself. Stop every drag/drop event at the modal boundary so it never
  // reaches whatever is behind it.
  const stopBubblingDrag = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    // layout-v4: 5/8 files + 3/8 upload — hard-refresh (Cmd+Shift+R) if HMR misses this
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-2 sm:p-3"
      onClick={() => {
        if (!shellCloseBlocked) void handleClose();
      }}
      onDragEnter={stopBubblingDrag}
      onDragOver={stopBubblingDrag}
      onDragLeave={stopBubblingDrag}
      onDrop={stopBubblingDrag}
    >
      <div
        role="dialog"
        aria-labelledby="start-print-title"
        data-testid="start-print-modal"
        className="bg-bambu-dark-secondary rounded-xl border border-bambu-dark-tertiary w-[min(96vw,1400px)] h-[calc(100vh-1.5rem)] sm:h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-bambu-dark-tertiary flex-shrink-0">
          <h2 id="start-print-title" className="text-lg sm:text-xl font-semibold text-white truncate pr-4">
            {t('printers.startPrintOn', 'Start print on {{name}}', { name: printerName })}
          </h2>
          <button
            type="button"
            onClick={() => void handleClose()}
            disabled={shellCloseBlocked}
            className="p-1.5 text-bambu-gray hover:text-white transition-colors rounded-lg hover:bg-bambu-dark-tertiary disabled:opacity-40 disabled:pointer-events-none"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col lg:grid lg:grid-cols-8 gap-4 p-3 sm:p-4 overflow-y-auto lg:overflow-hidden">
          {/* Your files — ~5/8 */}
          <section
            data-testid="start-print-library"
            aria-labelledby="start-print-files-heading"
            className={`lg:col-span-5 flex flex-col h-full min-h-[22rem] lg:min-h-0 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark overflow-hidden ${
              filePicksDisabled ? 'opacity-60' : ''
            }`}
          >
            <div className="px-4 sm:px-5 pt-4 pb-3 flex-shrink-0 border-b border-bambu-dark-tertiary/80 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <h3 id="start-print-files-heading" className="text-base font-semibold text-white">
                  {t('printers.yourFiles', 'Your files')}
                </h3>
                {libraryStats != null && typeof libraryStats.disk_free_bytes === 'number' && (
                  <div
                    data-testid="start-print-storage"
                    className="flex items-center gap-1.5 text-xs text-bambu-gray flex-shrink-0"
                    title={`${formatFileSize(libraryStats.disk_used_bytes)} / ${formatFileSize(libraryStats.disk_total_bytes)}`}
                  >
                    <HardDrive className="w-3.5 h-3.5 text-bambu-green" />
                    <span>
                      {formatFileSize(libraryStats.disk_free_bytes)} {t('fileManager.free').toLowerCase()}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[10rem]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray" />
                  <input
                    type="text"
                    placeholder={t('fileManager.searchFiles')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    disabled={filePicksDisabled}
                    className="w-full pl-8 pr-3 py-2 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none disabled:opacity-50"
                  />
                </div>
                <select
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value as SortField)}
                  aria-label={t('fileManager.sortBy', 'Sort')}
                  disabled={filePicksDisabled}
                  className="bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg text-white text-sm py-2 px-2.5 focus:border-bambu-green focus:outline-none disabled:opacity-50"
                >
                  <option value="name">{t('common.name')}</option>
                  <option value="date">{t('common.date')}</option>
                  <option value="size">{t('fileManager.size')}</option>
                </select>
                <button
                  type="button"
                  onClick={() => setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
                  disabled={filePicksDisabled}
                  className="p-2 rounded-lg bg-bambu-dark-secondary border border-bambu-dark-tertiary hover:border-bambu-green disabled:opacity-50"
                  title={sortDirection === 'asc' ? t('fileManager.ascending') : t('fileManager.descending')}
                >
                  {sortDirection === 'asc' ? (
                    <SortAsc className="w-4 h-4 text-white" />
                  ) : (
                    <SortDesc className="w-4 h-4 text-white" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-1 px-4 sm:px-5 py-2.5 text-sm flex-shrink-0 bg-bambu-dark-secondary/40">
              <button
                type="button"
                onClick={() => {
                  if (!folderPath || folderPath.length <= 1) {
                    setSelectedFolderId(null);
                    return;
                  }
                  setSelectedFolderId(folderPath[folderPath.length - 2].id);
                }}
                disabled={selectedFolderId == null || filePicksDisabled}
                className="p-1 rounded hover:bg-bambu-dark-tertiary disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label={t('common.back')}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setSelectedFolderId(null)}
                disabled={filePicksDisabled}
                className={`truncate disabled:pointer-events-none ${selectedFolderId == null ? 'text-white' : 'text-bambu-gray hover:text-white'}`}
              >
                {t('printers.yourFiles', 'Your files')}
              </button>
              {folderPath?.map((folder) => (
                <span key={folder.id} className="flex items-center gap-1 min-w-0">
                  <ChevronRight className="w-3.5 h-3.5 text-bambu-gray flex-shrink-0" />
                  <button
                    type="button"
                    onClick={() => setSelectedFolderId(folder.id)}
                    disabled={filePicksDisabled}
                    className="truncate text-bambu-gray hover:text-white disabled:pointer-events-none"
                  >
                    {folder.name}
                  </button>
                </span>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 min-h-0">
              {isLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-8 h-8 text-bambu-green animate-spin" />
                </div>
              ) : !hasAnyFolders && !hasAnyFiles ? (
                <div className="text-center py-16 text-bambu-gray">
                  {t('fileManager.folderIsEmpty')}
                </div>
              ) : (
                <div className="space-y-6">
                  {renderFolderSections()}
                  {hasAnyFiles && (
                    <ContentSection
                      label={
                        isAtRoot && hasNamedSections
                          ? t('fileManager.unfiled')
                          : t('fileManager.files')
                      }
                      testId="start-print-files-section"
                    >
                      <div className="grid grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
                        {filteredAndSortedFiles.map((file) => (
                          <StartPrintFileCard
                            key={file.id}
                            file={file}
                            printable={isPrintableFilename(file.filename)}
                            disabled={filePicksDisabled}
                            onSelect={() => handleSelectFile(file)}
                          />
                        ))}
                      </div>
                    </ContentSection>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Upload / print options — ~3/8 */}
          <section
            data-testid={chosenFile ? 'start-print-options' : 'start-print-upload'}
            aria-labelledby="start-print-upload-heading"
            className="lg:col-span-3 flex flex-col h-full min-h-[22rem] lg:min-h-0 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark overflow-hidden"
          >
            {chosenFile && printerId != null ? (
              <>
                <div className="px-4 sm:px-5 pt-4 pb-3 flex-shrink-0 border-b border-bambu-dark-tertiary/80 space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="w-16 h-16 rounded-lg bg-bambu-dark-secondary border border-bambu-dark-tertiary overflow-hidden flex items-center justify-center flex-shrink-0">
                      {chosenFile.thumbnailPath ? (
                        <img
                          src={api.getLibraryFileThumbnailUrl(chosenFile.id)}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <FileBox className="w-8 h-8 text-bambu-gray/40" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3
                        id="start-print-upload-heading"
                        className="text-sm font-semibold text-white truncate"
                        title={chosenFile.filename}
                      >
                        {chosenFile.filename}
                      </h3>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-bambu-gray">
                        {chosenFile.fileType && (
                          <span className="uppercase">{chosenFile.fileType}</span>
                        )}
                        {chosenFile.fileSize != null && (
                          <span>{formatFileSize(chosenFile.fileSize)}</span>
                        )}
                        {chosenFile.printTimeSeconds != null && chosenFile.printTimeSeconds > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDuration(chosenFile.printTimeSeconds)}
                          </span>
                        )}
                      </div>
                      {chosenFile.slicedForModel && (
                        <div className="mt-1 text-xs text-bambu-gray flex items-center gap-1">
                          <Printer className="w-3 h-3" />
                          {chosenFile.slicedForModel}
                        </div>
                      )}
                    </div>
                  </div>
                  {chosenFile.fromUpload && (
                    <div
                      data-testid="start-print-save-options"
                      className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary/60 px-3 py-2.5 space-y-2"
                    >
                      <label className={`flex items-start gap-2.5 ${isPrintSubmitting || saveBusy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                        <input
                          type="checkbox"
                          checked={saveToLibrary}
                          disabled={saveBusy || isPrintSubmitting}
                          onChange={(e) => void handleSaveToLibraryChange(e.target.checked)}
                          className="mt-0.5 w-4 h-4 rounded border-bambu-gray bg-bambu-dark text-bambu-green focus:ring-bambu-green focus:ring-offset-0"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm text-white">
                            {t('printers.saveToYourFiles', 'Save to your files')}
                          </span>
                          <span className="block text-xs text-bambu-gray mt-0.5">
                            {t(
                              'printers.saveToYourFilesHint',
                              'Off by default — the upload is only used for this print and is not kept in Unfiled.',
                            )}
                          </span>
                        </span>
                      </label>
                      {saveToLibrary && (
                        <div className="pl-6">
                          <label
                            htmlFor="start-print-save-folder"
                            className="block text-xs text-bambu-gray mb-1"
                          >
                            {t('printers.saveLocation', 'Save location')}
                          </label>
                          <select
                            id="start-print-save-folder"
                            data-testid="start-print-save-folder"
                            value={saveFolderId == null ? '' : String(saveFolderId)}
                            disabled={saveBusy || isPrintSubmitting}
                            onChange={(e) => {
                              const value = e.target.value;
                              void applySaveFolder(value === '' ? null : Number(value));
                            }}
                            className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm py-2 px-2.5 focus:border-bambu-green focus:outline-none disabled:opacity-60"
                          >
                            <option value="">
                              {t('printers.yourFiles', 'Your files')} ({t('fileManager.unfiled', 'Unfiled')})
                            </option>
                            {folderSaveOptions.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  <PrintModal
                    key={chosenFile.id}
                    mode="create"
                    libraryFileId={chosenFile.id}
                    archiveName={chosenFile.filename}
                    slicedForModel={chosenFile.slicedForModel}
                    initialSelectedPrinterIds={[printerId]}
                    embedded
                    cleanupLibraryAfterDispatch={chosenFile.fromUpload && !saveToLibrary}
                    onSubmittingChange={setIsPrintSubmitting}
                    onFilamentWarningChange={setFilamentWarningOpen}
                    onClose={() => {
                      if (skipDiscardOnCloseRef.current) {
                        skipDiscardOnCloseRef.current = false;
                        return;
                      }
                      void resetChosenFile();
                    }}
                    onSuccess={() => {
                      // Queue still needs the ephemeral upload for cleanup_library_after_dispatch.
                      skipDiscardOnCloseRef.current = true;
                      setChosenFile(null);
                      setSaveToLibrary(false);
                      setSaveFolderId(null);
                      setFilamentWarningOpen(false);
                      setIsPrintSubmitting(false);
                      onSuccess?.();
                      onClose();
                    }}
                  />
                </div>
              </>
            ) : canUpload ? (
              <>
                <div className="px-4 sm:px-5 pt-4 pb-3 flex-shrink-0 border-b border-bambu-dark-tertiary/80 space-y-2">
                  <div className="flex items-center gap-2">
                    <Upload className="w-4 h-4 text-bambu-green" />
                    <h3 id="start-print-upload-heading" className="text-base font-semibold text-white">
                      {t('fileManager.uploadFiles')}
                    </h3>
                  </div>
                  <p className="text-sm text-bambu-gray leading-relaxed">
                    {t(
                      'printers.uploadToPrintHint',
                      'Drop a printable file here, or pick one from Your files — print options open in this panel.',
                    )}
                  </p>
                </div>
                <div className="flex-1 min-h-0 p-4 sm:p-5 flex flex-col">
                  <FileUploadModal
                    folderId={null}
                    embedded
                    autoUpload
                    multiple={false}
                    accept=".gcode,.3mf"
                    dropZoneHint={t(
                      'printers.printableTypesHint',
                      'Supported: .gcode, .gcode.3mf',
                    )}
                    onClose={() => {}}
                    onUploadComplete={() => {}}
                    validateFile={(file) => {
                      const lower = file.name.toLowerCase();
                      if (!lower.endsWith('.gcode') && !lower.includes('.gcode.')) {
                        return t(
                          'printers.dropNotPrintable',
                          'Only .gcode and .gcode.3mf files can be printed',
                        );
                      }
                    }}
                    onFileUploaded={(uploadedFile) => {
                      const slicedFor = (uploadedFile.metadata as Record<string, unknown> | null)
                        ?.sliced_for_model as string | undefined;
                      const error = checkCompatibility(slicedFor);
                      if (error) {
                        api.deleteLibraryFile(uploadedFile.id).catch(() => {});
                        return error;
                      }
                      chooseFile({
                        id: uploadedFile.id,
                        filename: uploadedFile.filename,
                        slicedForModel: slicedFor ?? null,
                        thumbnailPath: uploadedFile.thumbnail_path,
                        fileSize: uploadedFile.file_size,
                        fileType: uploadedFile.file_type,
                        fromUpload: true,
                      });
                    }}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="px-4 sm:px-5 pt-4 pb-3 flex-shrink-0 border-b border-bambu-dark-tertiary/80 space-y-2">
                  <h3 id="start-print-upload-heading" className="text-base font-semibold text-white">
                    {t('printers.yourFiles', 'Your files')}
                  </h3>
                  <p className="text-sm text-bambu-gray leading-relaxed">
                    {t(
                      'printers.pickFromLibraryHint',
                      'Pick a printable file from Your files — print options open in this panel.',
                    )}
                  </p>
                </div>
                <div className="flex-1 min-h-0 p-4 sm:p-5 flex flex-col items-center justify-center text-center text-sm text-bambu-gray">
                  <FileBox className="w-10 h-10 text-bambu-gray/40 mb-3" />
                  {t('fileManager.noPermissionUpload')}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function StartPrintFileCard({
  file,
  printable,
  disabled,
  onSelect,
}: {
  file: LibraryFileListItem;
  printable: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`group relative flex flex-col overflow-hidden rounded-lg border text-left transition-colors disabled:pointer-events-none disabled:opacity-50 ${
        printable
          ? 'border-bambu-dark-tertiary hover:border-bambu-green/50'
          : 'border-bambu-dark-tertiary opacity-70 hover:opacity-100'
      }`}
    >
      <div className="aspect-square bg-bambu-dark flex items-center justify-center overflow-hidden">
        {file.thumbnail_path ? (
          <img
            src={api.getLibraryFileThumbnailUrl(file.id)}
            alt=""
            className="w-full h-full object-cover"
          />
        ) : (
          <FileBox className="w-10 h-10 text-bambu-gray/30" />
        )}
        <div
          className={`absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded font-medium ${
            file.file_type === 'gcode' || file.file_type === 'gcode.3mf'
              ? 'bg-blue-500/90 text-white'
              : file.file_type === '3mf'
                ? 'bg-bambu-green/90 text-white'
                : 'bg-bambu-gray/90 text-white'
          }`}
        >
          {file.file_type.toUpperCase()}
        </div>
      </div>
      <div className="p-2 bg-bambu-dark-secondary">
        <p className="text-sm text-white truncate" title={file.print_name || file.filename}>
          {file.print_name || file.filename}
        </p>
        <div className="flex items-center gap-2 mt-1 text-xs text-bambu-gray">
          <span>{formatFileSize(file.file_size)}</span>
          {file.print_time_seconds ? (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDuration(file.print_time_seconds)}
            </span>
          ) : null}
        </div>
        {file.sliced_for_model && (
          <div className="mt-1 text-xs text-bambu-gray flex items-center gap-1">
            <Printer className="w-3 h-3" />
            {file.sliced_for_model}
          </div>
        )}
      </div>
    </button>
  );
}
