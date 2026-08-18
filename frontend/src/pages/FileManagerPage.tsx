import { useState, useCallback, useMemo, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  FolderOpen,
  Layers,
  Loader2,
  Plus,
  Upload,
  Trash2,
  Download,
  MoreVertical,
  ChevronRight,
  ChevronLeft,
  FolderPlus,
  FileBox,
  Clock,
  CalendarClock,
  HardDrive,
  File,
  MoveRight,
  CheckSquare,
  Square,
  LayoutGrid,
  List,
  Search,
  SortAsc,
  SortDesc,
  AlertTriangle,
  Filter,
  X,
  Link2,
  Unlink,
  Cog,
  Play,
  Printer,
  Pencil,
  Image,
  User,
  Box,
  RefreshCw,
  Lock,
  FolderSymlink,
  Tag as TagIcon,
} from 'lucide-react';
import { api } from '../api/client';
import type {
  LibraryFolderTree,
  LibraryFolderSection,
  LibraryFileListItem,
  LibraryFolderCreate,
  LibraryFolderUpdate,
  ExternalFolderCreate,
  AppSettings,
  Archive,
  Permission,
  ProductionActiveFile,
} from '../api/client';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { PrintModal } from '../components/PrintModal';
import { ModelViewerModal } from '../components/ModelViewerModal';
import { SliceModal } from '../components/SliceModal';
import { RunWithPipelineModal } from '../components/RunWithPipelineModal';
import { BulkTagsPickerModal } from '../components/BulkTagsPickerModal';
import { FileUploadModal } from '../components/FileUploadModal';
import { FolderReadmePanel } from '../components/FolderReadmePanel';
import { ProductionFolderView } from '../components/production/ProductionFolderView';
import { LibraryTagsModal } from '../components/LibraryTagsModal';
import { PurgeOldFilesModal } from '../components/PurgeOldFilesModal';
import { useToast } from '../contexts/ToastContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { usePageFileDrop } from '../hooks/usePageFileDrop';
import { useAuth } from '../contexts/AuthContext';
import { formatDuration, parseUTCDate, formatDate } from '../utils/date';
import { formatFileSize } from '../utils/file';

type SortField = 'name' | 'date' | 'size' | 'type' | 'prints';
type SortDirection = 'asc' | 'desc';
type TFunction = (key: string, options?: Record<string, unknown>) => string;

// New Folder Modal
interface NewFolderModalProps {
  parentId: number | null;
  onClose: () => void;
  onSave: (data: LibraryFolderCreate) => void;
  isLoading: boolean;
  t: TFunction;
}

function NewFolderModal({ parentId, onClose, onSave, isLoading, t }: NewFolderModalProps) {
  const [name, setName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ name: name.trim(), parent_id: parentId });
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-sm border border-bambu-dark-tertiary">
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white">{t('fileManager.newFolder')}</h2>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('fileManager.folderName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
              placeholder={t('fileManager.folderNamePlaceholder')}
              autoFocus
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// External Folder Modal
interface ExternalFolderModalProps {
  onClose: () => void;
  onSave: (data: ExternalFolderCreate) => void;
  isLoading: boolean;
  t: TFunction;
}

function ExternalFolderModal({ onClose, onSave, isLoading, t }: ExternalFolderModalProps) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [readonly, setReadonly] = useState(true);
  const [showHidden, setShowHidden] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      name: name.trim(),
      external_path: path.trim(),
      readonly,
      show_hidden: showHidden,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-md border border-bambu-dark-tertiary">
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <FolderSymlink className="w-5 h-5 text-bambu-green" />
            {t('fileManager.linkExternalFolder')}
          </h2>
          <p className="text-sm text-bambu-gray mt-1">{t('fileManager.linkExternalFolderDescription')}</p>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('fileManager.folderName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
              placeholder={t('fileManager.externalFolderNamePlaceholder')}
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('fileManager.externalPath')}
            </label>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green font-mono text-sm"
              placeholder="/mnt/nas/3d-prints"
              required
            />
            <p className="text-xs text-bambu-gray mt-1">{t('fileManager.externalPathHelp')}</p>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={readonly}
                onChange={(e) => setReadonly(e.target.checked)}
                className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
              />
              <span className="text-sm text-white">{t('fileManager.readOnly')}</span>
              <span className="text-xs text-bambu-gray">({t('fileManager.readOnlyHelp')})</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
              />
              <span className="text-sm text-white">{t('fileManager.showHiddenFiles')}</span>
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || !path.trim() || isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('fileManager.linkFolder')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// FAT32/exFAT-illegal chars rejected by Bambu Studio (#1540). Mirrors the
// backend validator in backend/app/utils/filename.py — keep in sync.
const INVALID_FILENAME_CHARS = '<>:"/\\|?*';

function findInvalidFilenameChar(name: string): string | null {
  for (const ch of name) {
    if (INVALID_FILENAME_CHARS.includes(ch)) return ch;
    if (ch.charCodeAt(0) < 0x20) return ch;
  }
  return null;
}

// Rename Modal
interface RenameModalProps {
  type: 'file' | 'folder';
  currentName: string;
  onClose: () => void;
  onSave: (newName: string) => void;
  isLoading: boolean;
  t: TFunction;
}

function RenameModal({ type, currentName, onClose, onSave, isLoading, t }: RenameModalProps) {
  // For files, separate the extension so users can only edit the base name
  // Handle compound extensions like .gcode.3mf
  const fileExtension = type === 'file' ? (currentName.match(/(\.gcode\.3mf|\.3mf|\.gcode)$/i)?.[1] ?? '') : '';
  const baseName = type === 'file' && fileExtension ? currentName.slice(0, -fileExtension.length) : currentName;
  const [name, setName] = useState(baseName);

  const invalidChar = type === 'file' ? findInvalidFilenameChar(name) : null;
  const filenameError = invalidChar
    ? t('fileManager.invalidFilenameChar', { char: invalidChar })
    : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (filenameError) return;
    const fullName = type === 'file' ? name.trim() + fileExtension : name.trim();
    if (name.trim() && fullName !== currentName) {
      onSave(fullName);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-sm border border-bambu-dark-tertiary">
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white">{type === 'file' ? t('fileManager.renameFile') : t('fileManager.renameFolder')}</h2>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('common.name')}
            </label>
            <div className={`flex items-center bg-bambu-dark border rounded focus-within:border-bambu-green ${filenameError ? 'border-red-500' : 'border-bambu-dark-tertiary'}`}>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 bg-transparent px-3 py-2 text-white placeholder-bambu-gray focus:outline-none min-w-0"
                autoFocus
                required
              />
              {fileExtension && (
                <span className="pr-3 text-bambu-gray text-sm select-none whitespace-nowrap">{fileExtension}</span>
              )}
            </div>
            {filenameError && (
              <p className="mt-1 text-xs text-red-700 dark:text-red-400">{filenameError}</p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || name.trim() === baseName || !!filenameError || isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.rename')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Move Files Modal
interface MoveFilesModalProps {
  folders: LibraryFolderTree[];
  selectedFiles: number[];
  currentFolderId: number | null;
  onClose: () => void;
  onMove: (folderId: number | null) => void;
  isLoading: boolean;
  t: TFunction;
}

function MoveFilesModal({ folders, selectedFiles, currentFolderId, onClose, onMove, isLoading, t }: MoveFilesModalProps) {
  const [targetFolder, setTargetFolder] = useState<number | null>(null);

  const flattenFolders = (items: LibraryFolderTree[], depth = 0): { id: number | null; name: string; depth: number }[] => {
    const result: { id: number | null; name: string; depth: number }[] = [];
    for (const item of items) {
      result.push({ id: item.id, name: item.name, depth });
      if (item.children.length > 0) {
        result.push(...flattenFolders(item.children, depth + 1));
      }
    }
    return result;
  };

  const flatFolders = [{ id: null, name: t('fileManager.rootNoFolder'), depth: 0 }, ...flattenFolders(folders)];

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-sm border border-bambu-dark-tertiary">
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white">{t('fileManager.moveFiles', { count: selectedFiles.length })}</h2>
        </div>
        <div className="p-4 space-y-4">
          <div className="max-h-64 overflow-y-auto space-y-1">
            {flatFolders.map((folder) => (
              <button
                key={folder.id ?? 'root'}
                onClick={() => setTargetFolder(folder.id)}
                disabled={folder.id === currentFolderId}
                className={`w-full text-left px-3 py-2 rounded transition-colors flex items-center gap-2 ${
                  targetFolder === folder.id
                    ? 'bg-bambu-green/20 text-bambu-green'
                    : folder.id === currentFolderId
                    ? 'opacity-50 cursor-not-allowed text-bambu-gray'
                    : 'hover:bg-bambu-dark text-white'
                }`}
                style={{ paddingLeft: `${12 + folder.depth * 16}px` }}
              >
                <FolderOpen className="w-4 h-4" />
                {folder.name}
                {folder.id === currentFolderId && <span className="text-xs text-bambu-gray ml-auto">({t('fileManager.current')})</span>}
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => onMove(targetFolder)} disabled={isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.move')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Link Folder Modal
interface LinkFolderModalProps {
  folder: LibraryFolderTree;
  onClose: () => void;
  onLink: (update: LibraryFolderUpdate) => void;
  isLoading: boolean;
  t: TFunction;
}

// Folders could be linked to a project or an archive; this fork removed
// Projects, so archives are the only link target left.
function LinkFolderModal({ folder, onClose, onLink, isLoading, t }: LinkFolderModalProps) {
  const [selectedId, setSelectedId] = useState<number | null>(folder.archive_id || null);

  const { data: archives } = useQuery({
    queryKey: ['archives-for-link'],
    queryFn: () => api.getArchives(undefined, undefined, 100),
  });

  const handleSave = () => {
    onLink({ archive_id: selectedId });
  };

  const handleUnlink = () => {
    onLink({ archive_id: 0 });
  };

  const isLinked = !!folder.archive_id;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-md border border-bambu-dark-tertiary">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Link2 className="w-5 h-5 text-bambu-green" />
            {t('fileManager.linkFolder')}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-bambu-dark rounded">
            <X className="w-5 h-5 text-bambu-gray" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-bambu-gray">
            {t('fileManager.linkFolderDescription', { name: folder.name })}
          </p>

          {/* Selection list */}
          <div className="max-h-64 overflow-y-auto space-y-1 bg-bambu-dark rounded-lg p-2">
            {archives && archives.length > 0 ? (
              archives.map((archive: Archive) => (
                <button
                  key={archive.id}
                  onClick={() => setSelectedId(archive.id)}
                  className={`w-full text-left px-3 py-2 rounded transition-colors flex items-center gap-2 ${
                    selectedId === archive.id
                      ? 'bg-bambu-green/20 text-bambu-green'
                      : 'hover:bg-bambu-dark-tertiary text-white'
                  }`}
                >
                  <FileBox className="w-4 h-4 text-bambu-gray flex-shrink-0" />
                  <span className="truncate">{archive.print_name || archive.filename}</span>
                </button>
              ))
            ) : (
              <p className="text-sm text-bambu-gray text-center py-4">{t('fileManager.noArchivesFound')}</p>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-bambu-dark-tertiary flex justify-between">
          {isLinked && (
            <Button variant="danger" onClick={handleUnlink} disabled={isLoading}>
              <Unlink className="w-4 h-4 mr-2" />
              {t('fileManager.unlink')}
            </Button>
          )}
          <div className={`flex gap-2 ${!isLinked ? 'ml-auto' : ''}`}>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={!selectedId || isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('fileManager.link')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Folder card (replaces the old sidebar tree). Clicking the card enters the
// folder; the kebab keeps rename / link / delete / move-to-section / scan.
interface FolderCardProps {
  folder: LibraryFolderTree;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
  onLink: (folder: LibraryFolderTree) => void;
  onRename: (folder: LibraryFolderTree) => void;
  onScan?: (id: number) => void;
  sections?: LibraryFolderSection[];
  onMoveToSection?: (folderId: number, sectionId: number | null) => void;
  showSectionMove?: boolean;
  hasPermission: (permission: Permission) => boolean;
  t: TFunction;
}

function FolderCard({
  folder,
  onSelect,
  onDelete,
  onLink,
  onRename,
  onScan,
  sections = [],
  onMoveToSection,
  showSectionMove = false,
  hasPermission,
  t,
}: FolderCardProps) {
  const [showActions, setShowActions] = useState(false);
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const hasChildren = folder.children.length > 0;
  const isLinked = !!folder.archive_id;
  const isExternal = folder.is_external;
  const canDeleteFolder =
    hasPermission('library:delete_all') ||
    (hasPermission('library:delete_own') && folder.file_count === 0 && !hasChildren && !isExternal && !isLinked);
  const deleteDisabledTooltip = canDeleteFolder
    ? undefined
    : hasPermission('library:delete_own') && !isExternal && !isLinked
      ? t('fileManager.onlyEmptyFoldersDeletable')
      : t('fileManager.noPermissionDeleteFolder');
  const canUpdate = hasPermission('library:update_all');

  return (
    <div
      className="group relative flex flex-col items-center gap-2 p-4 rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary hover:border-bambu-green/50 hover:bg-bambu-dark transition-colors cursor-pointer text-center"
      onClick={() => onSelect(folder.id)}
    >
      <div className="absolute top-2 right-2" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => { setShowActions(!showActions); setShowMoveMenu(false); }}
          className="p-1 rounded hover:bg-bambu-dark-tertiary opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
          title={t('common.actions')}
          aria-label={t('common.actions')}
        >
          <MoreVertical className="w-4 h-4 text-bambu-gray" />
        </button>
        {showActions && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => { setShowActions(false); setShowMoveMenu(false); }} />
            <div className="absolute right-0 top-full mt-1 z-20 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl py-1 min-w-[160px] text-left">
              <button
                className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                  canUpdate ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                }`}
                onClick={() => { if (canUpdate) { onRename(folder); setShowActions(false); } }}
                disabled={!canUpdate}
              >
                <Pencil className="w-3.5 h-3.5" />
                {t('common.rename')}
              </button>
              {!isExternal && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    canUpdate ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (canUpdate) { onLink(folder); setShowActions(false); } }}
                  disabled={!canUpdate}
                >
                  <Link2 className="w-3.5 h-3.5" />
                  {isLinked ? t('fileManager.changeLink') : t('fileManager.linkTo')}
                </button>
              )}
              {isExternal && onScan && (
                <button
                  className="w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 text-white hover:bg-bambu-dark"
                  onClick={() => { onScan(folder.id); setShowActions(false); }}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('fileManager.scanFolder')}
                </button>
              )}
              {showSectionMove && onMoveToSection && canUpdate && (
                <div className="relative">
                  <button
                    className="w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 text-white hover:bg-bambu-dark"
                    onClick={() => setShowMoveMenu(!showMoveMenu)}
                  >
                    <MoveRight className="w-3.5 h-3.5" />
                    {t('fileManager.moveToSection')}
                  </button>
                  {showMoveMenu && (
                    <div className="absolute left-full top-0 ml-1 z-30 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl py-1 min-w-[140px] max-h-48 overflow-y-auto">
                      <button
                        className={`w-full px-3 py-1.5 text-left text-sm hover:bg-bambu-dark ${
                          folder.section_id == null ? 'text-bambu-green' : 'text-white'
                        }`}
                        onClick={() => { onMoveToSection(folder.id, null); setShowActions(false); setShowMoveMenu(false); }}
                      >
                        {t('fileManager.noSection')}
                      </button>
                      {sections.map((section) => (
                        <button
                          key={section.id}
                          className={`w-full px-3 py-1.5 text-left text-sm hover:bg-bambu-dark ${
                            folder.section_id === section.id ? 'text-bambu-green' : 'text-white'
                          }`}
                          onClick={() => { onMoveToSection(folder.id, section.id); setShowActions(false); setShowMoveMenu(false); }}
                        >
                          {section.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <button
                className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                  canDeleteFolder ? 'text-red-700 dark:text-red-400 hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                }`}
                onClick={() => { if (canDeleteFolder) { onDelete(folder.id); setShowActions(false); } }}
                disabled={!canDeleteFolder}
                title={deleteDisabledTooltip}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {t('common.delete')}
              </button>
            </div>
          </>
        )}
      </div>
      <div className="w-12 h-12 rounded-lg bg-bambu-dark flex items-center justify-center">
        {isExternal ? (
          <FolderSymlink className="w-6 h-6 text-purple-600 dark:text-purple-400" />
        ) : (
          <FolderOpen className="w-6 h-6 text-blue-600 dark:text-blue-400" />
        )}
      </div>
      <span className="text-sm text-white font-medium truncate w-full" title={folder.name}>{folder.name}</span>
      <span className="text-xs text-bambu-gray">
        {folder.file_count} {t('fileManager.files').toLowerCase()}
        {hasChildren ? ` · ${folder.children.length}` : ''}
      </span>
      {isExternal && folder.external_readonly && (
        <span
          title={t('fileManager.readOnly')}
          className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 flex items-center gap-1"
        >
          <Lock className="w-3 h-3" />
          {t('fileManager.readOnly')}
        </span>
      )}
    </div>
  );
}

function FolderCardGrid({
  folders,
  onSelect,
  onDelete,
  onLink,
  onRename,
  onScan,
  sections,
  onMoveToSection,
  showSectionMove,
  hasPermission,
  t,
}: {
  folders: LibraryFolderTree[];
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
  onLink: (folder: LibraryFolderTree) => void;
  onRename: (folder: LibraryFolderTree) => void;
  onScan?: (id: number) => void;
  sections?: LibraryFolderSection[];
  onMoveToSection?: (folderId: number, sectionId: number | null) => void;
  showSectionMove?: boolean;
  hasPermission: (permission: Permission) => boolean;
  t: TFunction;
}) {
  if (folders.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
      {folders.map((folder) => (
        <FolderCard
          key={folder.id}
          folder={folder}
          onSelect={onSelect}
          onDelete={onDelete}
          onLink={onLink}
          onRename={onRename}
          onScan={onScan}
          sections={sections}
          onMoveToSection={onMoveToSection}
          showSectionMove={showSectionMove}
          hasPermission={hasPermission}
          t={t}
        />
      ))}
    </div>
  );
}

function NewSectionModal({
  title,
  initialName = '',
  onClose,
  onSave,
  isLoading,
  t,
}: {
  title: string;
  initialName?: string;
  onClose: () => void;
  onSave: (name: string) => void;
  isLoading: boolean;
  t: TFunction;
}) {
  const [name, setName] = useState(initialName);
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-sm border border-bambu-dark-tertiary">
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSave(name.trim());
          }}
          className="p-4 space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('fileManager.sectionName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
              placeholder={t('fileManager.sectionNamePlaceholder')}
              autoFocus
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function findFolderPath(items: LibraryFolderTree[], id: number, trail: LibraryFolderTree[] = []): LibraryFolderTree[] | null {
  for (const item of items) {
    const next = [...trail, item];
    if (item.id === id) return next;
    const found = findFolderPath(item.children, id, next);
    if (found) return found;
  }
  return null;
}

// Helper to check if a file is sliced (printable)
function isSlicedFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.gcode') || lower.endsWith('.gcode.3mf');
}

// Files that can be fed to the slicer sidecar (model geometry inputs).
// Excludes .gcode.* (already sliced) and any other non-model formats.
function isSliceableFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gcode') || lower.endsWith('.gcode.3mf')) return false;
  return lower.endsWith('.stl') || lower.endsWith('.3mf') || lower.endsWith('.step') || lower.endsWith('.stp');
}

// File Card
interface FileCardProps {
  file: LibraryFileListItem;
  isSelected: boolean;
  isMobile: boolean;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
  onDownload: (id: number) => void;
  onPrint?: (file: LibraryFileListItem) => void;
  onSlice?: (file: LibraryFileListItem) => void;
  onRunPipeline?: (file: LibraryFileListItem) => void;
  useSlicerApi?: boolean;
  onPreview3d?: (file: LibraryFileListItem) => void;
  onRename?: (file: LibraryFileListItem) => void;
  onGenerateThumbnail?: (file: LibraryFileListItem) => void;
  onTagClick?: (tagId: number) => void;
  thumbnailVersion?: number;
  hasPermission: (permission: Permission) => boolean;
  canModify: (resource: 'queue' | 'archives' | 'library', action: 'update' | 'delete' | 'reprint', createdById: number | null | undefined) => boolean;
  authEnabled: boolean;
  showModified: boolean;
  t: TFunction;
}

function FileCard({ file, isSelected, isMobile, onSelect, onDelete, onDownload, onPrint, onSlice, onRunPipeline, useSlicerApi, onPreview3d, onRename, onGenerateThumbnail, onTagClick, thumbnailVersion, hasPermission, canModify, authEnabled, showModified, t }: FileCardProps) {
  const [showActions, setShowActions] = useState(false);

  return (
    <div
      className={`group relative bg-bambu-dark-secondary rounded-lg border transition-all cursor-pointer overflow-hidden ${
        isSelected
          ? 'border-bambu-green ring-1 ring-bambu-green'
          : 'border-bambu-dark-tertiary hover:border-bambu-green/50'
      }`}
      onClick={() => onSelect(file.id)}
    >
      {/* Thumbnail */}
      <div className="aspect-square bg-bambu-dark flex items-center justify-center overflow-hidden">
        {file.thumbnail_path ? (
          <img
            src={`${api.getLibraryFileThumbnailUrl(file.id)}${thumbnailVersion ? ((api.getLibraryFileThumbnailUrl(file.id).includes('?') ? '&' : '?') + `v=${thumbnailVersion}`) : ''}`}
            alt={file.filename}
            className="w-full h-full object-cover"
          />
        ) : (
          <FileBox className="w-12 h-12 text-bambu-gray/30" />
        )}
        {/* File type badge */}
        <div className={`absolute top-2 right-2 text-xs px-1.5 py-0.5 rounded font-medium ${
          file.file_type === '3mf' ? 'bg-bambu-green/90 text-white'
          // Sliced output — share the gcode blue so users see at a glance
          // that the file is already sliced and ready to print (#1543).
          : file.file_type === 'gcode' || file.file_type === 'gcode.3mf' ? 'bg-blue-500/90 text-white'
          : file.file_type === 'stl' ? 'bg-purple-500/90 text-white'
          : 'bg-bambu-gray/90 text-white'
        }`}>
          {file.file_type.toUpperCase()}
        </div>
      </div>

      {/* Info */}
      <div className="p-3">
        <h3 className="text-sm font-medium text-white truncate" title={file.print_name || file.filename}>
          {file.print_name || file.filename}
        </h3>
        <div className="flex items-center gap-3 mt-1 text-xs text-bambu-gray">
          <span>{formatFileSize(file.file_size)}</span>
          {file.print_time_seconds && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDuration(file.print_time_seconds)}
            </span>
          )}
        </div>
        {file.sliced_for_model && (
          <div className="mt-1 text-xs text-bambu-gray flex items-center gap-1">
            <Printer className="w-3 h-3" />
            {file.sliced_for_model}
          </div>
        )}
        {file.print_count > 0 && (
          <div className="mt-1 text-xs text-bambu-green">
            {t('fileManager.printedCount', { count: file.print_count })}
          </div>
        )}
        {authEnabled && file.created_by_username && (
          <div className="mt-1 text-xs text-bambu-gray flex items-center gap-1">
            <User className="w-3 h-3" />
            {file.created_by_username}
          </div>
        )}
        {/* #2680: last-modified date, toggled from the toolbar. Uses the real
            on-disk mtime when known, else the DB created_at. */}
        {showModified && (
          <div className="mt-1 text-xs text-bambu-gray flex items-center gap-1" title={t('fileManager.lastModified')}>
            <CalendarClock className="w-3 h-3" />
            {formatDate(file.fs_modified_at ?? file.created_at)}
          </div>
        )}
        {(file.tags?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
            {file.tags!.map((tg) => (
              <button
                key={tg.id}
                type="button"
                onClick={() => onTagClick?.(tg.id)}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-bambu-green/10 text-bambu-green hover:bg-bambu-green/20 transition-colors max-w-full"
                title={tg.name}
              >
                <TagIcon className="w-2.5 h-2.5 flex-shrink-0" />
                <span className="truncate">{tg.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Actions - always visible on mobile, hover on desktop */}
      <div className={`absolute bottom-2 right-2 transition-opacity ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => setShowActions(!showActions)}
          className="p-1.5 rounded bg-bambu-dark-secondary/90 hover:bg-bambu-dark-tertiary"
        >
          <MoreVertical className="w-4 h-4 text-bambu-gray" />
        </button>
        {showActions && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowActions(false)} />
            <div className="absolute right-0 bottom-8 z-20 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl py-1 min-w-[140px]">
              {onPrint && isSlicedFilename(file.filename) && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    hasPermission('queue:create') ? 'text-bambu-green hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (hasPermission('queue:create')) { onPrint(file); setShowActions(false); } }}
                  disabled={!hasPermission('queue:create')}
                  title={!hasPermission('queue:create') ? t('fileManager.noPermissionAddToQueue') : undefined}
                >
                  <Printer className="w-3.5 h-3.5" />
                  {t('common.print')}
                </button>
              )}
              {onSlice && useSlicerApi && isSliceableFilename(file.filename) && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    hasPermission('library:upload') ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (hasPermission('library:upload')) { onSlice(file); setShowActions(false); } }}
                  disabled={!hasPermission('library:upload')}
                  title={!hasPermission('library:upload') ? t('fileManager.noPermissionSlice') : undefined}
                >
                  <Cog className="w-3.5 h-3.5" />
                  {t('slice.action')}
                </button>
              )}
              {onRunPipeline && useSlicerApi && isSliceableFilename(file.filename) && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    hasPermission('pipelines:run') ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (hasPermission('pipelines:run')) { onRunPipeline(file); setShowActions(false); } }}
                  disabled={!hasPermission('pipelines:run')}
                  title={!hasPermission('pipelines:run') ? t('library.runWithPipeline.noPermission') : undefined}
                >
                  <Play className="w-3.5 h-3.5" />
                  {t('library.runWithPipeline.actionLabel')}
                </button>
              )}
              {onPreview3d && (file.file_type === '3mf' || file.file_type === 'gcode' || file.file_type === 'stl' || file.file_type === 'gcode.3mf') && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    hasPermission('library:read') ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (hasPermission('library:read')) { onPreview3d(file); setShowActions(false); } }}
                  disabled={!hasPermission('library:read')}
                  title={!hasPermission('library:read') ? 'You do not have permission to preview files' : undefined}
                >
                  <Box className="w-3.5 h-3.5" />
                  3D Preview
                </button>
              )}
              <button
                className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                  hasPermission('library:read') ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                }`}
                onClick={() => { if (hasPermission('library:read')) { onDownload(file.id); setShowActions(false); } }}
                disabled={!hasPermission('library:read')}
                title={!hasPermission('library:read') ? t('fileManager.noPermissionDownload') : undefined}
              >
                <Download className="w-3.5 h-3.5" />
                {t('common.download')}
              </button>
              {onRename && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    canModify('library', 'update', file.created_by_id) ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (canModify('library', 'update', file.created_by_id)) { onRename(file); setShowActions(false); } }}
                  disabled={!canModify('library', 'update', file.created_by_id)}
                  title={!canModify('library', 'update', file.created_by_id) ? t('fileManager.noPermissionRenameFile') : undefined}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  {t('common.rename')}
                </button>
              )}
              {onGenerateThumbnail && file.file_type === 'stl' && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    canModify('library', 'update', file.created_by_id) ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (canModify('library', 'update', file.created_by_id)) { onGenerateThumbnail(file); setShowActions(false); } }}
                  disabled={!canModify('library', 'update', file.created_by_id)}
                  title={!canModify('library', 'update', file.created_by_id) ? t('fileManager.noPermissionGenerateThumbnail') : undefined}
                >
                  <Image className="w-3.5 h-3.5" />
                  {t('fileManager.generateThumbnail')}
                </button>
              )}
              <button
                className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                  canModify('library', 'delete', file.created_by_id) ? 'text-red-700 dark:text-red-400 hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                }`}
                onClick={() => { if (canModify('library', 'delete', file.created_by_id)) { onDelete(file.id); setShowActions(false); } }}
                disabled={!canModify('library', 'delete', file.created_by_id)}
                title={!canModify('library', 'delete', file.created_by_id) ? t('fileManager.noPermissionDeleteFile') : undefined}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {t('common.delete')}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Selection checkbox - always visible on mobile, hover on desktop */}
      <div className={`absolute top-2 left-2 w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
        isSelected
          ? 'bg-bambu-green border-bambu-green'
          : `border-white/30 bg-black/30 ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`
      }`}>
        {isSelected && <div className="w-2 h-2 bg-white rounded-sm" />}
      </div>
    </div>
  );
}

export function FileManagerPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission, hasAnyPermission, canModify, authEnabled } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Read folder ID from URL query parameter
  const folderIdFromUrl = searchParams.get('folder');
  const initialFolderId = folderIdFromUrl ? parseInt(folderIdFromUrl, 10) : null;

  // State
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(initialFolderId);
  // The page opens on the folder-card landing grid. Deep links that already
  // specify a folder skip the picker and go straight to that folder.
  const [viewEntered, setViewEntered] = useState(!!initialFolderId);
  const [selectedFiles, setSelectedFiles] = useState<number[]>([]);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [showSectionModal, setShowSectionModal] = useState<'create' | { id: number; name: string } | null>(null);
  const [sectionMenuId, setSectionMenuId] = useState<number | null>(null);
  const [deleteSectionId, setDeleteSectionId] = useState<number | null>(null);
  const [showExternalFolderModal, setShowExternalFolderModal] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [showPurgeModal, setShowPurgeModal] = useState(false);
  // Tag UI state (#1268). selectedTagIds is the AND-style filter applied to
  // the listing; setting it bypasses folder scoping on the server so
  // "every toy" works regardless of which folder is currently selected.
  const [showTagsModal, setShowTagsModal] = useState(false);
  const [showBulkTagsModal, setShowBulkTagsModal] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [linkFolder, setLinkFolder] = useState<LibraryFolderTree | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'file' | 'folder' | 'bulk'; id: number; count?: number } | null>(null);
  const [printFile, setPrintFile] = useState<LibraryFileListItem | null>(null);
  const [sliceFile, setSliceFile] = useState<LibraryFileListItem | null>(null);
  // Slicer Pipelines (#1425 PR B) — file gets "Run with pipeline" action.
  const [runPipelineFile, setRunPipelineFile] = useState<LibraryFileListItem | null>(null);
  const [renameItem, setRenameItem] = useState<{ type: 'file' | 'folder'; id: number; name: string } | null>(null);
  const [thumbnailVersions, setThumbnailVersions] = useState<Record<number, number>>({});
  const [viewerFile, setViewerFile] = useState<LibraryFileListItem | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    return (localStorage.getItem('library-view-mode') as 'grid' | 'list') || 'grid';
  });
  // Folder card sort (#1770). 'name' = alphabetical; 'activity' = most recent
  // file activity inside the folder first. Persisted independently from the
  // file-side sort so each can be tuned to taste.
  const [folderSortField, setFolderSortField] = useState<'name' | 'activity'>(() => {
    const saved = localStorage.getItem('library-folder-sort-field');
    return saved === 'activity' ? 'activity' : 'name';
  });
  const [folderSortDirection, setFolderSortDirection] = useState<'asc' | 'desc'>(() => {
    const saved = localStorage.getItem('library-folder-sort-direction');
    return saved === 'desc' ? 'desc' : 'asc';
  });

  // Filter and sort state (persist sort preferences to localStorage)
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [filterUsername, setFilterUsername] = useState('');
  const [sortField, setSortField] = useState<SortField>(() => {
    const saved = localStorage.getItem('library-sort-field');
    return (saved as SortField) || 'name';
  });
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    const saved = localStorage.getItem('library-sort-direction');
    return (saved as SortDirection) || 'asc';
  });
  // Show/hide the last-modified date on each file card (#2680). Persisted.
  const [showModified, setShowModified] = useState<boolean>(
    () => localStorage.getItem('library-show-modified') === 'true'
  );

  // Mobile detection for touch-friendly UI
  const isMobile = useIsMobile();

  // Update selectedFolderId when URL parameter changes (e.g., navigating from Project or Archive page)
  useEffect(() => {
    const folderParam = searchParams.get('folder');
    if (folderParam) {
      const newFolderId = parseInt(folderParam, 10);
      setSelectedFolderId(newFolderId);
      setViewEntered(true);
    }
  }, [searchParams]);

  // Queries
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings() as Promise<AppSettings>,
  });
  const { data: folders, isLoading: foldersLoading } = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => api.getLibraryFolders(),
  });
  const { data: folderSections = [] } = useQuery({
    queryKey: ['library-sections'],
    queryFn: () => api.getLibraryFolderSections(),
  });

  // Recursive folder tree sort (#1770). Applies the same comparator to the
  // top-level list AND to each level of `children`, so sort order is uniform
  // at every depth of nesting. When sorting by activity, the comparator falls
  // back to a created-at fallback for folders with no files (`latest_activity_at`
  // is null) so they stay grouped at the end / start of the bucket instead of
  // randomly interspersed.
  const sortedFolders = useMemo(() => {
    if (!folders) return folders;
    const sortLevel = (items: LibraryFolderTree[]): LibraryFolderTree[] => {
      const sorted = [...items].sort((a, b) => {
        let comparison = 0;
        if (folderSortField === 'name') {
          comparison = a.name.localeCompare(b.name);
        } else {
          // activity: newest first on 'desc', oldest first on 'asc'.
          // Folders with no activity timestamp sort to the end regardless
          // of direction so an empty folder doesn't elbow a recently-used one.
          const aTs = a.latest_activity_at ? new Date(a.latest_activity_at).getTime() : null;
          const bTs = b.latest_activity_at ? new Date(b.latest_activity_at).getTime() : null;
          if (aTs === null && bTs === null) {
            comparison = a.name.localeCompare(b.name);
          } else if (aTs === null) {
            return 1;
          } else if (bTs === null) {
            return -1;
          } else {
            comparison = aTs - bTs;
          }
        }
        return folderSortDirection === 'asc' ? comparison : -comparison;
      });
      return sorted.map((f) => ({ ...f, children: sortLevel(f.children) }));
    };
    return sortLevel(folders);
  }, [folders, folderSortField, folderSortDirection]);

  const ungroupedRootFolders = useMemo(
    () => (sortedFolders ?? []).filter((f) => f.section_id == null),
    [sortedFolders],
  );
  const foldersBySection = useMemo(() => {
    const map: Record<number, LibraryFolderTree[]> = {};
    for (const folder of sortedFolders ?? []) {
      if (folder.section_id == null) continue;
      (map[folder.section_id] ||= []).push(folder);
    }
    return map;
  }, [sortedFolders]);
  const folderPath = useMemo(
    () => (selectedFolderId && folders ? findFolderPath(folders, selectedFolderId) : null),
    [folders, selectedFolderId],
  );
  const childFolders = folderPath?.[folderPath.length - 1]?.children ?? [];

  const enterFolder = (id: number) => {
    setSelectedFolderId(id);
    setViewEntered(true);
  };
  const goToRoot = () => {
    setSelectedFolderId(null);
    setViewEntered(false);
  };

  // Trash count for the header badge (#1008). Empty/error are silently treated
  // as zero so a broken trash endpoint doesn't break the File Manager.
  const { data: trashCount } = useQuery({
    queryKey: ['library-trash-count'],
    queryFn: async () => {
      try {
        const res = await api.listLibraryTrash(1, 0);
        return res.total;
      } catch {
        return 0;
      }
    },
    staleTime: 30_000,
  });

  // #1268: when a folder is selected and the user has typed a search query,
  // ask the server to expand the result to every descendant folder so the
  // client-side filter can match files in subfolders too. Without this the
  // listing is just the immediate children and "robot.3mf" two levels deep
  // is invisible from the parent. Only kicks in for folder-scoped views —
  // root and the internal/external pseudo-nodes already return the union.
  const searchExpandsSubfolders = selectedFolderId !== null && searchQuery.trim().length > 0;
  // The tag filter overrides folder scoping server-side (#1268 design call),
  // so the FE query key includes it as a peer of folder. Sorted
  // so the cache hits regardless of the order tags were toggled.
  const tagFilterKey = useMemo(() => [...selectedTagIds].sort((a, b) => a - b), [selectedTagIds]);
  // Tag catalog — needed to resolve names for the active-filter chip bar.
  // Cheap query, shared with LibraryTagsModal / BulkTagsPickerModal via the
  // same queryKey so they all invalidate together on tag CRUD.
  const { data: tagCatalog = [] } = useQuery({
    queryKey: ['library-tags'],
    queryFn: api.getLibraryTags,
  });
  const tagsById = useMemo(() => {
    const map = new Map<number, string>();
    for (const t of tagCatalog) map.set(t.id, t.name);
    return map;
  }, [tagCatalog]);
  // Prune the active filter when a tag is removed from the catalog so the
  // listing never stalls on a phantom id. Skipped while the catalog query is
  // still settling (empty array on first paint) — otherwise the user's filter
  // gets cleared the moment the page mounts.
  useEffect(() => {
    if (tagCatalog.length === 0) return;
    setSelectedTagIds((prev) => {
      const next = prev.filter((id) => tagsById.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [tagCatalog.length, tagsById]);

  const toggleTagFilter = useCallback((tagId: number) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }, []);

  const { data: files, isLoading: filesLoading } = useQuery({
    queryKey: ['library-files', selectedFolderId, searchExpandsSubfolders, tagFilterKey],
    queryFn: () =>
      api.getLibraryFiles(
        selectedFolderId,
        false,
        undefined,
        searchExpandsSubfolders,
        tagFilterKey,
      ),
    enabled: viewEntered && selectedFolderId !== null,
  });

  const { data: stats } = useQuery({
    queryKey: ['library-stats'],
    queryFn: () => api.getLibraryStats(),
  });

  // Get users for the username filter autocomplete
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.getUsers(),
  });

  // Get unique file types for filter dropdown
  const fileTypes = useMemo(() => {
    if (!files) return [];
    const types = new Set(files.map((f) => f.file_type));
    return Array.from(types).sort();
  }, [files]);

  // Filter and sort files
  const filteredAndSortedFiles = useMemo(() => {
    if (!files) return [];

    let result = [...files];

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (f) =>
          f.filename.toLowerCase().includes(query) ||
          (f.print_name && f.print_name.toLowerCase().includes(query))
      );
    }

    // Apply type filter
    if (filterType !== 'all') {
      result = result.filter((f) => f.file_type === filterType);
    }

    // Apply username filter
    if (filterUsername.trim()) {
      const query = filterUsername.toLowerCase();
      result = result.filter(
        (f) => f.created_by_username && f.created_by_username.toLowerCase().includes(query)
      );
    }

    // Apply sorting
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = (a.print_name || a.filename).localeCompare(b.print_name || b.filename);
          break;
        case 'date':
          // #2680: sort by real on-disk mtime (matches `ls -t`), falling back to
          // the DB created_at for managed uploads that have no filesystem mtime.
          comparison =
            (parseUTCDate(a.fs_modified_at ?? a.created_at)?.getTime() ?? 0) -
            (parseUTCDate(b.fs_modified_at ?? b.created_at)?.getTime() ?? 0);
          break;
        case 'size':
          comparison = a.file_size - b.file_size;
          break;
        case 'type':
          comparison = a.file_type.localeCompare(b.file_type);
          break;
        case 'prints':
          comparison = a.print_count - b.print_count;
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [files, searchQuery, filterType, filterUsername, sortField, sortDirection]);

  // Check if disk space is low
  const isDiskSpaceLow = useMemo(() => {
    if (!stats || !settings) return false;
    const thresholdBytes = (settings.library_disk_warning_gb || 5) * 1024 * 1024 * 1024;
    return stats.disk_free_bytes < thresholdBytes;
  }, [stats, settings]);

  // Mutations
  const createFolderMutation = useMutation({
    mutationFn: (data: LibraryFolderCreate) => api.createLibraryFolder(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      setShowNewFolderModal(false);
      showToast(t('fileManager.toast.folderCreated'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const createExternalFolderMutation = useMutation({
    mutationFn: async (data: ExternalFolderCreate) => {
      const folder = await api.createExternalFolder(data);
      // Auto-scan after creation
      await api.scanExternalFolder(folder.id);
      return folder;
    },
    onSuccess: (folder) => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      setShowExternalFolderModal(false);
      setSelectedFolderId(folder.id);
      showToast(t('fileManager.toast.externalFolderLinked'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const scanExternalFolderMutation = useMutation({
    mutationFn: (folderId: number) => api.scanExternalFolder(folderId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      showToast(t('fileManager.toast.folderScanned', { added: result.added, removed: result.removed }), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const deleteFolderMutation = useMutation({
    mutationFn: (id: number) => api.deleteLibraryFolder(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      if (selectedFolderId === deleteConfirm?.id) {
        setSelectedFolderId(null);
      }
      setDeleteConfirm(null);
      showToast(t('fileManager.toast.folderDeleted'), 'success');
    },
    onError: (error: Error) => {
      setDeleteConfirm(null);
      showToast(error.message, 'error');
    },
  });

  const deleteFileMutation = useMutation({
    mutationFn: (id: number) => api.deleteLibraryFile(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
      setSelectedFiles((prev) => prev.filter((id) => id !== deleteConfirm?.id));
      setDeleteConfirm(null);
      showToast(t('fileManager.toast.fileDeleted'), 'success');
    },
    onError: (error: Error) => {
      setDeleteConfirm(null);
      showToast(error.message, 'error');
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (fileIds: number[]) => api.bulkDeleteLibrary(fileIds, []),
    onSuccess: (_, fileIds) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
      showToast(t('fileManager.toast.filesDeleted', { count: fileIds.length }), 'success');
      setSelectedFiles([]);
      setDeleteConfirm(null);
    },
    onError: (error: Error) => {
      setDeleteConfirm(null);
      showToast(error.message, 'error');
    },
  });

  const moveFilesMutation = useMutation({
    mutationFn: ({ fileIds, folderId }: { fileIds: number[]; folderId: number | null }) =>
      api.moveLibraryFiles(fileIds, folderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      setSelectedFiles([]);
      setShowMoveModal(false);
      showToast(t('fileManager.toast.filesMoved'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const updateFolderMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: LibraryFolderUpdate }) =>
      api.updateLibraryFolder(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      // Invalidate archive folder queries so other pages see the update
      queryClient.invalidateQueries({ queryKey: ['archive-folders'] });
      setLinkFolder(null);
      const isUnlink = variables.data.archive_id === 0;
      showToast(isUnlink ? t('fileManager.toast.folderUnlinked') : t('fileManager.toast.folderLinked'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const createSectionMutation = useMutation({
    mutationFn: (name: string) => api.createLibraryFolderSection(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-sections'] });
      setShowSectionModal(null);
      showToast(t('fileManager.sectionCreated'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const renameSectionMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.renameLibraryFolderSection(id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-sections'] });
      setShowSectionModal(null);
      showToast(t('fileManager.sectionRenamed'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const deleteSectionMutation = useMutation({
    mutationFn: (id: number) => api.deleteLibraryFolderSection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-sections'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      setDeleteSectionId(null);
      showToast(t('fileManager.sectionDeleted'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const assignSectionMutation = useMutation({
    mutationFn: ({ folderId, sectionId }: { folderId: number; sectionId: number | null }) =>
      api.assignLibraryFolderSection(folderId, sectionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-sections'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      showToast(t('fileManager.folderMovedToSection'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const renameFileMutation = useMutation({
    mutationFn: ({ id, filename }: { id: number; filename: string }) =>
      api.updateLibraryFile(id, { filename }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      setRenameItem(null);
      showToast(t('fileManager.toast.fileRenamed'), 'success');
    },
    onError: (error: Error) => {
      setRenameItem(null);
      showToast(error.message, 'error');
    },
  });

  const renameFolderMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.updateLibraryFolder(id, { name }),
    onSuccess: () => {
      // Invalidate both folders and files - files may display folder info
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      setRenameItem(null);
      showToast(t('fileManager.toast.folderRenamed'), 'success');
    },
    onError: (error: Error) => {
      setRenameItem(null);
      showToast(error.message, 'error');
    },
  });

  const batchThumbnailMutation = useMutation({
    mutationFn: () => api.batchGenerateStlThumbnails({ all_missing: true }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      // Update thumbnail versions for cache busting
      if (result.succeeded > 0) {
        const now = Date.now();
        const newVersions: Record<number, number> = {};
        result.results.forEach((r) => {
          if (r.success) {
            newVersions[r.file_id] = now;
          }
        });
        setThumbnailVersions((prev) => ({ ...prev, ...newVersions }));
      }
      if (result.succeeded > 0 && result.failed === 0) {
        showToast(t('fileManager.toast.thumbnailsGenerated', { count: result.succeeded }), 'success');
      } else if (result.succeeded > 0 && result.failed > 0) {
        showToast(t('fileManager.toast.thumbnailsGeneratedPartial', { succeeded: result.succeeded, failed: result.failed }), 'success');
      } else if (result.processed === 0) {
        showToast(t('fileManager.toast.noStlMissingThumbnails'), 'info');
      } else {
        showToast(t('fileManager.toast.failedToGenerateThumbnails', { error: result.results[0]?.error || 'Unknown error' }), 'error');
      }
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const singleThumbnailMutation = useMutation({
    mutationFn: (fileId: number) => api.batchGenerateStlThumbnails({ file_ids: [fileId] }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      // Update thumbnail version for cache busting
      if (result.succeeded > 0) {
        const fileId = result.results[0]?.file_id;
        if (fileId) {
          setThumbnailVersions((prev) => ({ ...prev, [fileId]: Date.now() }));
        }
        showToast(t('fileManager.toast.thumbnailGenerated'), 'success');
      } else {
        showToast(t('fileManager.toast.failedToGenerateThumbnail', { error: result.results[0]?.error || 'Unknown error' }), 'error');
      }
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  // Helper to check if a file is sliced (printable)
  const isSlicedFile = useCallback((filename: string) => {
    const lower = filename.toLowerCase();
    return lower.endsWith('.gcode') || lower.includes('.gcode.');
  }, []);

  // Get sliced files from selection
  const selectedSlicedFiles = useMemo(() => {
    if (!files) return [];
    return files.filter(f => selectedFiles.includes(f.id) && isSlicedFile(f.filename));
  }, [files, selectedFiles, isSlicedFile]);

  // Handlers
  const handleFileSelect = useCallback((id: number) => {
    // Always toggle selection (multi-select by default)
    setSelectedFiles((prev) => {
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (filteredAndSortedFiles.length > 0) {
      setSelectedFiles(filteredAndSortedFiles.map((f) => f.id));
    }
  }, [filteredAndSortedFiles]);

  const handleDeselectAll = useCallback(() => {
    setSelectedFiles([]);
  }, []);

  const handleUploadComplete = () => {
    queryClient.invalidateQueries({ queryKey: ['library-files'] });
    queryClient.invalidateQueries({ queryKey: ['library-folders'] });
    queryClient.invalidateQueries({ queryKey: ['library-stats'] });
  };

  // Find the selected folder in the tree to check external / production status
  const selectedFolder = useMemo(() => {
    if (!selectedFolderId || !folders) return null;
    const findFolder = (items: LibraryFolderTree[]): LibraryFolderTree | null => {
      for (const item of items) {
        if (item.id === selectedFolderId) return item;
        const found = findFolder(item.children);
        if (found) return found;
      }
      return null;
    };
    return findFolder(folders);
  }, [selectedFolderId, folders]);
  const isProductionFolder = Boolean(selectedFolder?.production_printer_model);

  // Page-wide drag-and-drop upload (#1510). Disabled when the user lacks
  // library:upload so a non-uploader can't accidentally show the overlay,
  // and also disabled while the upload modal itself is open so drags into
  // the modal's own drop zone don't bubble up and flash the page overlay
  // behind it. Production folders use their own Add/Replace flow.
  const canUpload = hasPermission('library:upload');
  const { isDraggingOver, dragHandlers } = usePageFileDrop({
    disabled: !canUpload || showUploadModal || isProductionFolder,
    onFiles: (files) => {
      setDroppedFiles(files);
      setShowUploadModal(true);
    },
  });

  const handleDownload = (id: number) => {
    api.downloadLibraryFile(id).catch((err) => {
      console.error('Library file download failed:', err);
    });
  };

  const handleDeleteConfirm = () => {
    if (!deleteConfirm) return;
    if (deleteConfirm.type === 'file') {
      deleteFileMutation.mutate(deleteConfirm.id);
    } else if (deleteConfirm.type === 'folder') {
      deleteFolderMutation.mutate(deleteConfirm.id);
    } else if (deleteConfirm.type === 'bulk') {
      bulkDeleteMutation.mutate(selectedFiles);
    }
  };

  const isDeleting = deleteFolderMutation.isPending || deleteFileMutation.isPending || bulkDeleteMutation.isPending;

  const handleViewModeChange = (mode: 'grid' | 'list') => {
    setViewMode(mode);
    localStorage.setItem('library-view-mode', mode);
  };

  const isLoading = foldersLoading || filesLoading;

  const handleProductionPrint = (file: ProductionActiveFile) => {
    const lower = file.filename.toLowerCase();
    setPrintFile({
      id: file.id,
      folder_id: selectedFolderId,
      is_external: false,
      filename: file.filename,
      file_type: lower.endsWith('.gcode.3mf') ? 'gcode.3mf' : lower.endsWith('.gcode') ? 'gcode' : '3mf',
      file_size: file.file_size,
      thumbnail_path: file.thumbnail_path,
      print_count: 0,
      duplicate_count: 0,
      created_by_id: null,
      created_by_username: null,
      created_at: '',
      fs_modified_at: null,
      print_name: file.filename,
      print_time_seconds: file.print_time_seconds,
      filament_used_grams: null,
      sliced_for_model: file.sliced_for_model,
    });
  };

  return (
    <div
      className="p-4 md:p-8 min-h-[calc(100vh-64px)] lg:h-[calc(100vh-64px)] flex flex-col relative"
      {...dragHandlers}
    >
      {/* Drag & Drop Overlay — page-wide file upload (#1510) */}
      {isDraggingOver && (
        <div className="fixed inset-0 z-50 bg-bambu-dark/90 flex items-center justify-center pointer-events-none">
          <div className="border-4 border-dashed border-bambu-green rounded-xl p-12 text-center">
            <Upload className="w-16 h-16 mx-auto mb-4 text-bambu-green" />
            <p className="text-2xl font-semibold text-white mb-2">{t('fileManager.dropFilesHere')}</p>
            <p className="text-bambu-gray">{t('fileManager.releaseToUpload')}</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            {viewEntered && (
              <button
                onClick={goToRoot}
                className="text-bambu-gray hover:text-white hover:bg-bambu-dark p-1 rounded transition-colors"
                title={t('fileManager.backToFolders')}
                aria-label={t('fileManager.backToFolders')}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            <FolderOpen className="w-7 h-7 text-bambu-green" />
            {t('fileManager.title')}
          </h1>
          <p className="text-bambu-gray mt-1">
            {t('fileManager.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex items-center bg-bambu-dark rounded-lg p-1">
            <button
              onClick={() => handleViewModeChange('grid')}
              className={`p-1.5 rounded transition-colors ${
                viewMode === 'grid' ? 'bg-bambu-dark-secondary text-white' : 'text-bambu-gray hover:text-white'
              }`}
              title={t('fileManager.gridView')}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleViewModeChange('list')}
              className={`p-1.5 rounded transition-colors ${
                viewMode === 'list' ? 'bg-bambu-dark-secondary text-white' : 'text-bambu-gray hover:text-white'
              }`}
              title={t('fileManager.listView')}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
          <Button
            variant="secondary"
            onClick={() => batchThumbnailMutation.mutate()}
            disabled={batchThumbnailMutation.isPending || !hasAnyPermission('library:update_own', 'library:update_all')}
            title={!hasAnyPermission('library:update_own', 'library:update_all') ? t('fileManager.noPermissionGenerateThumbnail') : t('fileManager.generateThumbnailsForMissing')}
          >
            {batchThumbnailMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Image className="w-4 h-4 mr-2" />
            )}
            {t('fileManager.generateThumbnails')}
          </Button>
          {!isProductionFolder && (
          <Button
            variant="secondary"
            onClick={() => setShowExternalFolderModal(true)}
            disabled={!hasPermission('library:upload')}
            title={!hasPermission('library:upload') ? t('fileManager.noPermissionCreateFolder') : t('fileManager.linkExternalFolder')}
          >
            <FolderSymlink className="w-4 h-4 mr-2" />
            {t('fileManager.linkExternal')}
          </Button>
          )}
          {!isProductionFolder && (
          <Button
            variant="secondary"
            onClick={() => setShowNewFolderModal(true)}
            disabled={!hasPermission('library:upload')}
            title={!hasPermission('library:upload') ? t('fileManager.noPermissionCreateFolder') : undefined}
          >
            <FolderPlus className="w-4 h-4 mr-2" />
            {t('fileManager.newFolder')}
          </Button>
          )}
          {!viewEntered && (
            <Button
              variant="secondary"
              onClick={() => setShowSectionModal('create')}
              disabled={!hasPermission('library:update_all')}
              title={t('fileManager.addSection')}
            >
              <Plus className="w-4 h-4 mr-2" />
              {t('fileManager.addSection')}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => setShowTagsModal(true)}
            title={t('fileManager.tags.manageTitle')}
          >
            <TagIcon className="w-4 h-4 mr-2" />
            {t('fileManager.tags.manage')}
          </Button>
          {hasPermission('library:purge') && (
            <Button
              variant="secondary"
              onClick={() => setShowPurgeModal(true)}
              title={t('libraryPurge.headerTooltip')}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {t('libraryPurge.headerButton')}
            </Button>
          )}
          {(hasAnyPermission('library:delete_own', 'library:delete_all')) && (
            <Link
              to="/files/trash"
              className="inline-flex items-center px-3 py-1.5 text-sm rounded bg-bambu-dark-secondary text-bambu-gray hover:text-white hover:bg-bambu-dark transition-colors"
              title={t('libraryTrash.headerTooltip')}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {t('libraryTrash.headerButton')}
              {typeof trashCount === 'number' && trashCount > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-bambu-green/20 text-bambu-green">
                  {trashCount}
                </span>
              )}
            </Link>
          )}
          {!isProductionFolder && (
          <Button
            onClick={() => setShowUploadModal(true)}
            disabled={!hasPermission('library:upload')}
            title={!hasPermission('library:upload') ? t('fileManager.noPermissionUpload') : undefined}
          >
            <Upload className="w-4 h-4 mr-2" />
            {t('common.upload')}
          </Button>
          )}
        </div>
      </div>

      {/* Disk space warning */}
      {isDiskSpaceLow && stats && settings && (
        <div className="flex items-center gap-3 mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-amber-500 font-medium">{t('fileManager.lowDiskSpaceWarning')}</p>
            <p className="text-xs text-amber-500/80">
              {t('fileManager.lowDiskSpaceDetails', { free: formatFileSize(stats.disk_free_bytes), total: formatFileSize(stats.disk_total_bytes), threshold: settings.library_disk_warning_gb })}
            </p>
          </div>
        </div>
      )}

      {/* Stats bar */}
      {stats && (
        <div className="flex flex-wrap items-center gap-3 sm:gap-6 mb-6 p-3 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary">
          <div className="flex items-center gap-2 text-sm">
            <File className="w-4 h-4 text-bambu-green" />
            <span className="text-bambu-gray">{t('fileManager.files')}:</span>
            <span className="text-white font-medium">{stats.total_files}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <FolderOpen className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span className="text-bambu-gray">{t('fileManager.folders')}:</span>
            <span className="text-white font-medium">{stats.total_folders}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <HardDrive className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            <span className="text-bambu-gray">{t('fileManager.size')}:</span>
            <span className="text-white font-medium">{formatFileSize(stats.total_size_bytes)}</span>
          </div>
          <div className="flex items-center gap-2 text-sm sm:ml-auto">
            <span className="text-bambu-gray">{t('fileManager.free')}:</span>
            <span className={`font-medium ${isDiskSpaceLow ? 'text-amber-500' : 'text-white'}`}>
              {formatFileSize(stats.disk_free_bytes)}
            </span>
          </div>
        </div>
      )}

      {/* Main content */}
      {!viewEntered ? (
        <div className="flex-1 overflow-y-auto min-h-0 space-y-8">
          <div className="flex items-center justify-end gap-2">
            <select
              value={folderSortField}
              onChange={(e) => {
                const v = e.target.value === 'activity' ? 'activity' : 'name';
                setFolderSortField(v);
                localStorage.setItem('library-folder-sort-field', v);
              }}
              className="text-xs px-2 py-1 rounded bg-bambu-dark-secondary border border-bambu-dark-tertiary text-bambu-gray focus:outline-none focus:border-bambu-green"
              title={t('fileManager.folderSort')}
              aria-label={t('fileManager.folderSort')}
            >
              <option value="name">{t('fileManager.folderSortByName')}</option>
              <option value="activity">{t('fileManager.folderSortByActivity')}</option>
            </select>
            <button
              onClick={() => {
                const newValue = folderSortDirection === 'asc' ? 'desc' : 'asc';
                setFolderSortDirection(newValue);
                localStorage.setItem('library-folder-sort-direction', newValue);
              }}
              className="text-bambu-gray hover:text-white hover:bg-bambu-dark-secondary p-1 rounded transition-colors"
              title={folderSortDirection === 'asc' ? t('fileManager.ascending') : t('fileManager.descending')}
              aria-label={folderSortDirection === 'asc' ? t('fileManager.ascending') : t('fileManager.descending')}
            >
              {folderSortDirection === 'asc' ? <SortAsc className="w-3.5 h-3.5" /> : <SortDesc className="w-3.5 h-3.5" />}
            </button>
          </div>
          {foldersLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-bambu-green" />
            </div>
          ) : (
            <>
              {(ungroupedRootFolders.length > 0 || folderSections.length === 0) && (
                <div>
                  {folderSections.length > 0 && (
                    <h2 className="text-sm font-medium text-bambu-gray mb-3">{t('fileManager.ungrouped')}</h2>
                  )}
                  {ungroupedRootFolders.length === 0 ? (
                    <p className="text-sm text-bambu-gray">{t('fileManager.chooseFolderDescription')}</p>
                  ) : (
                    <FolderCardGrid
                      folders={ungroupedRootFolders}
                      onSelect={enterFolder}
                      onDelete={(id) => setDeleteConfirm({ type: 'folder', id })}
                      onLink={setLinkFolder}
                      onRename={(f) => setRenameItem({ type: 'folder', id: f.id, name: f.name })}
                      onScan={(id) => scanExternalFolderMutation.mutate(id)}
                      sections={folderSections}
                      onMoveToSection={(folderId, sectionId) => assignSectionMutation.mutate({ folderId, sectionId })}
                      showSectionMove
                      hasPermission={hasPermission}
                      t={t}
                    />
                  )}
                </div>
              )}
              {folderSections.map((section) => (
                <div key={section.id}>
                  <div className="flex items-center gap-2 mb-3">
                    <Layers className="w-4 h-4 text-bambu-green" />
                    <h2 className="text-sm font-medium text-white">{section.name}</h2>
                    <div className="relative ml-auto">
                      <button
                        onClick={() => setSectionMenuId(sectionMenuId === section.id ? null : section.id)}
                        className="p-1 rounded hover:bg-bambu-dark-secondary text-bambu-gray hover:text-white"
                        title={t('common.actions')}
                        aria-label={t('common.actions')}
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
                      {sectionMenuId === section.id && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={() => setSectionMenuId(null)} />
                          <div className="absolute right-0 top-full mt-1 z-20 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl py-1 min-w-[140px]">
                            <button
                              className="w-full px-3 py-1.5 text-left text-sm text-white hover:bg-bambu-dark flex items-center gap-2"
                              onClick={() => {
                                setShowSectionModal({ id: section.id, name: section.name });
                                setSectionMenuId(null);
                              }}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                              {t('fileManager.renameSection')}
                            </button>
                            <button
                              className="w-full px-3 py-1.5 text-left text-sm text-red-700 dark:text-red-400 hover:bg-bambu-dark flex items-center gap-2"
                              onClick={() => {
                                setDeleteSectionId(section.id);
                                setSectionMenuId(null);
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              {t('fileManager.deleteSection')}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  <FolderCardGrid
                    folders={foldersBySection[section.id] ?? []}
                    onSelect={enterFolder}
                    onDelete={(id) => setDeleteConfirm({ type: 'folder', id })}
                    onLink={setLinkFolder}
                    onRename={(f) => setRenameItem({ type: 'folder', id: f.id, name: f.name })}
                    onScan={(id) => scanExternalFolderMutation.mutate(id)}
                    sections={folderSections}
                    onMoveToSection={(folderId, sectionId) => assignSectionMutation.mutate({ folderId, sectionId })}
                    showSectionMove
                    hasPermission={hasPermission}
                    t={t}
                  />
                  {(foldersBySection[section.id] ?? []).length === 0 && (
                    <p className="text-xs text-bambu-gray">{t('fileManager.emptySection')}</p>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      ) : (
      <div className="flex-1 flex flex-col lg:flex-row gap-4 lg:gap-6 min-h-0">
        {/* Files area + README rail (#2520 item 2). On wide screens the
            README docks as a collapsible right-hand column (rendered after
            the files column, below) so it no longer steals vertical space
            from the file list; on narrow screens it stacks above the list
            via `order-first` and the page itself scrolls. */}
        <div className="flex-1 flex flex-col lg:flex-row min-w-0 min-h-0 gap-4 lg:gap-6">
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {folderPath && folderPath.length > 0 && (
            <nav className="flex flex-wrap items-center gap-1 text-sm mb-4" aria-label="Breadcrumb">
              <button
                onClick={goToRoot}
                className="text-bambu-gray hover:text-white"
              >
                {t('fileManager.folders')}
              </button>
              {folderPath.map((crumb, idx) => (
                <span key={crumb.id} className="flex items-center gap-1">
                  <ChevronRight className="w-3.5 h-3.5 text-bambu-gray" />
                  {idx === folderPath.length - 1 ? (
                    <span className="text-white font-medium">{crumb.name}</span>
                  ) : (
                    <button
                      onClick={() => enterFolder(crumb.id)}
                      className="text-bambu-gray hover:text-white"
                    >
                      {crumb.name}
                    </button>
                  )}
                </span>
              ))}
            </nav>
          )}
          {isProductionFolder && selectedFolderId && selectedFolder?.production_printer_model ? (
            <ProductionFolderView
              folderId={selectedFolderId}
              printerModel={selectedFolder.production_printer_model}
              canUpload={canUpload}
              onPrint={handleProductionPrint}
            />
          ) : (
          <>
          {childFolders.length > 0 && (
            <div className="mb-6">
              <FolderCardGrid
                folders={childFolders}
                onSelect={enterFolder}
                onDelete={(id) => setDeleteConfirm({ type: 'folder', id })}
                onLink={setLinkFolder}
                onRename={(f) => setRenameItem({ type: 'folder', id: f.id, name: f.name })}
                onScan={(id) => scanExternalFolderMutation.mutate(id)}
                hasPermission={hasPermission}
                t={t}
              />
            </div>
          )}
          {/* Tag filter rail (#1268). Lists every catalog tag as a togglable
              chip — active chips are filled green and show an X, inactive
              chips are outlined and toggle ON when clicked. Clicking an active
              chip removes it from the filter. Hidden entirely when the
              catalog is empty so brand-new installs don't see a stray rail. */}
          {tagCatalog.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 p-2 sm:p-3 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary">
              <span className="text-xs text-bambu-gray font-medium shrink-0">
                {t('fileManager.tags.filterLabel')}
              </span>
              {tagCatalog.map((tg) => {
                const active = selectedTagIds.includes(tg.id);
                return (
                  <button
                    key={tg.id}
                    type="button"
                    onClick={() => toggleTagFilter(tg.id)}
                    className={
                      active
                        ? 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-bambu-green/20 text-bambu-green border border-bambu-green/40 hover:bg-bambu-green/30 transition-colors'
                        : 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-bambu-dark text-bambu-gray border border-bambu-dark-tertiary hover:text-white hover:border-bambu-green/40 transition-colors'
                    }
                    title={tg.name}
                  >
                    <TagIcon className="w-3 h-3" />
                    <span>{tg.name}</span>
                    {active && <X className="w-3 h-3" />}
                  </button>
                );
              })}
              {selectedTagIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedTagIds([])}
                  className="ml-auto text-xs text-bambu-gray hover:text-white shrink-0"
                >
                  {t('fileManager.tags.clearAll')}
                </button>
              )}
            </div>
          )}
          {/* External folder info bar */}
          {selectedFolder?.is_external && (
            <div className="flex items-center gap-3 mb-4 p-3 bg-purple-50 dark:bg-purple-500/10 border border-purple-300 dark:border-purple-500/30 rounded-lg">
              <FolderSymlink className="w-5 h-5 text-purple-600 dark:text-purple-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-purple-700 dark:text-purple-300">{t('fileManager.externalFolder')}</span>
                  {selectedFolder.external_readonly && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 flex items-center gap-1">
                      <Lock className="w-3 h-3" />
                      {t('fileManager.readOnly')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-bambu-gray truncate font-mono" title={selectedFolder.external_path || ''}>
                  {selectedFolder.external_path}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => selectedFolderId && scanExternalFolderMutation.mutate(selectedFolderId)}
                disabled={scanExternalFolderMutation.isPending}
                title={t('fileManager.scanFolder')}
              >
                {scanExternalFolderMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                <span className="ml-1.5">{t('fileManager.scanFolder')}</span>
              </Button>
            </div>
          )}
          {/* Search, Filter, Sort toolbar - sticky on mobile for easier access */}
          {files && files.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4 p-2 sm:p-3 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary sticky top-0 z-10 lg:static">
              {/* Search */}
              <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray" />
                <input
                  type="text"
                  placeholder={t('fileManager.searchFiles')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded text-sm text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
                />
                {searchExpandsSubfolders && (
                  <span
                    className="absolute -bottom-4 left-0 text-[10px] text-bambu-gray whitespace-nowrap"
                    title={t('fileManager.searchSubfoldersHint')}
                  >
                    {t('fileManager.searchSubfoldersHint')}
                  </span>
                )}
              </div>

              {/* Type filter */}
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-bambu-gray hidden sm:block" />
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-bambu-green"
                >
                  <option value="all">{t('fileManager.allTypes')}</option>
                  {fileTypes.map((type) => (
                    <option key={type} value={type}>
                      {type.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>

              {/* Username filter with autocomplete - only show when auth is enabled */}
              {authEnabled && (
                <div className="relative">
                  <input
                    type="text"
                    placeholder={t('fileManager.filterByUser', { defaultValue: 'Filter by user' })}
                    value={filterUsername}
                    onChange={(e) => setFilterUsername(e.target.value)}
                    list="usernames-list"
                    className={`w-32 sm:w-40 px-2 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded text-sm text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green ${filterUsername ? 'pr-7' : ''}`}
                    style={filterUsername ? { WebkitAppearance: 'none', MozAppearance: 'textfield' } : undefined}
                  />
                  {filterUsername && (
                    <button
                      onClick={() => setFilterUsername('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-bambu-gray hover:text-white z-10"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                  <datalist id="usernames-list">
                    {users?.map((user) => (
                      <option key={user.id} value={user.username} />
                    ))}
                  </datalist>
                </div>
              )}

              {/* Sort */}
              <div className="flex items-center gap-2">
                <select
                  value={sortField}
                  onChange={(e) => {
                    const newField = e.target.value as SortField;
                    setSortField(newField);
                    localStorage.setItem('library-sort-field', newField);
                  }}
                  className="bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-bambu-green"
                >
                  <option value="name">{t('common.name')}</option>
                  <option value="date">{t('common.date')}</option>
                  <option value="size">{t('fileManager.size')}</option>
                  <option value="type">{t('common.type')}</option>
                  <option value="prints">{t('fileManager.prints')}</option>
                </select>
                <button
                  onClick={() => setSortDirection((d) => {
                    const newDir = d === 'asc' ? 'desc' : 'asc';
                    localStorage.setItem('library-sort-direction', newDir);
                    return newDir;
                  })}
                  className="p-1.5 rounded bg-bambu-dark border border-bambu-dark-tertiary hover:border-bambu-green transition-colors"
                  title={sortDirection === 'asc' ? t('fileManager.ascending') : t('fileManager.descending')}
                >
                  {sortDirection === 'asc' ? (
                    <SortAsc className="w-4 h-4 text-white" />
                  ) : (
                    <SortDesc className="w-4 h-4 text-white" />
                  )}
                </button>
                <button
                  onClick={() => setShowModified((v) => {
                    const next = !v;
                    localStorage.setItem('library-show-modified', String(next));
                    return next;
                  })}
                  className={`p-1.5 rounded bg-bambu-dark border transition-colors ${
                    showModified ? 'border-bambu-green text-bambu-green' : 'border-bambu-dark-tertiary text-white hover:border-bambu-green'
                  }`}
                  title={showModified ? t('fileManager.hideModified') : t('fileManager.showModified')}
                  aria-pressed={showModified}
                >
                  <CalendarClock className="w-4 h-4" />
                </button>
              </div>

              {/* Results count */}
              {(searchQuery || filterType !== 'all' || filterUsername) && (
                <span className="text-sm text-bambu-gray hidden sm:inline">
                  {t('fileManager.resultsCount', { showing: filteredAndSortedFiles.length, total: files.length })}
                </span>
              )}
            </div>
          )}

          {/* Selection toolbar - sticky on mobile below search bar */}
          {filteredAndSortedFiles.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 mb-4 p-2 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary sticky top-[52px] z-10 lg:static">
              {/* Select all / Deselect all */}
              {selectedFiles.length === filteredAndSortedFiles.length && selectedFiles.length > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleDeselectAll}
                >
                  <Square className="w-4 h-4 sm:mr-1" />
                  <span className="hidden sm:inline">{t('fileManager.deselectAll')}</span>
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSelectAll}
                >
                  <CheckSquare className="w-4 h-4 sm:mr-1" />
                  <span className="hidden sm:inline">{t('fileManager.selectAll')}</span>
                </Button>
              )}

              {selectedFiles.length > 0 && (
                <>
                  <span className="text-sm text-bambu-gray ml-2">
                    {t('fileManager.selected', { count: selectedFiles.length })}
                  </span>
                  <div className="hidden sm:block flex-1" />
                  <div className="w-full sm:w-auto flex flex-wrap items-center gap-2 mt-2 sm:mt-0">
                    {selectedSlicedFiles.length === 1 && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setPrintFile(selectedSlicedFiles[0])}
                        disabled={!hasPermission('queue:create')}
                        title={!hasPermission('queue:create') ? t('fileManager.noPermissionAddToQueue') : undefined}
                      >
                        <Printer className="w-4 h-4 sm:mr-1" />
                        <span className="hidden sm:inline">{t('common.print')}</span>
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setShowMoveModal(true)}
                      disabled={!hasAnyPermission('library:update_own', 'library:update_all')}
                      title={!hasAnyPermission('library:update_own', 'library:update_all') ? t('fileManager.noPermissionMoveFiles') : undefined}
                    >
                      <MoveRight className="w-4 h-4 sm:mr-1" />
                      <span className="hidden sm:inline">{t('common.move')}</span>
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setShowBulkTagsModal(true)}
                      disabled={!hasAnyPermission('library:update_own', 'library:update_all')}
                      title={!hasAnyPermission('library:update_own', 'library:update_all') ? t('fileManager.tags.noPermission') : t('fileManager.tags.bulkTooltip')}
                    >
                      <TagIcon className="w-4 h-4 sm:mr-1" />
                      <span className="hidden sm:inline">{t('fileManager.tags.tagAction')}</span>
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        if (selectedFiles.length === 1) {
                          setDeleteConfirm({ type: 'file', id: selectedFiles[0] });
                        } else {
                          setDeleteConfirm({ type: 'bulk', id: 0, count: selectedFiles.length });
                        }
                      }}
                      disabled={!hasAnyPermission('library:delete_own', 'library:delete_all')}
                      title={!hasAnyPermission('library:delete_own', 'library:delete_all') ? t('fileManager.noPermissionDeleteFiles') : undefined}
                    >
                      <Trash2 className="w-4 h-4 sm:mr-1" />
                      <span className="hidden sm:inline">{t('common.delete')}</span>
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleDeselectAll}
                    >
                      <X className="w-4 h-4 sm:mr-1" />
                      <span className="hidden sm:inline">{t('common.clear')}</span>
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* File grid/list */}
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="w-8 h-8 animate-spin text-bambu-green" />
                <p className="text-sm text-bambu-gray">{t('fileManager.loadingFiles')}</p>
              </div>
            </div>
          ) : files?.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center">
              <div className="p-4 bg-bambu-dark rounded-2xl mb-4">
                <FileBox className="w-12 h-12 text-bambu-gray/50" />
              </div>
              <h3 className="text-lg font-medium text-white mb-2">
                {t('fileManager.folderIsEmpty')}
              </h3>
              <p className="text-bambu-gray text-center max-w-md mb-6">
                {t('fileManager.folderEmptyDescription')}
              </p>
              <Button
                onClick={() => setShowUploadModal(true)}
                disabled={!hasPermission('library:upload')}
                title={!hasPermission('library:upload') ? t('fileManager.noPermissionUpload') : undefined}
              >
                <Plus className="w-4 h-4 mr-2" />
                {t('fileManager.uploadFiles')}
              </Button>
            </div>
          ) : filteredAndSortedFiles.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center">
              <div className="p-4 bg-bambu-dark rounded-2xl mb-4">
                <Search className="w-12 h-12 text-bambu-gray/50" />
              </div>
              <h3 className="text-lg font-medium text-white mb-2">{t('fileManager.noMatchingFiles')}</h3>
              <p className="text-bambu-gray text-center max-w-md mb-6">
                {t('fileManager.noMatchingFilesDescription')}
              </p>
              <Button variant="secondary" onClick={() => { setSearchQuery(''); setFilterType('all'); }}>
                {t('fileManager.clearFilters')}
              </Button>
            </div>
          ) : viewMode === 'grid' ? (
            <div className="flex-1 lg:overflow-y-auto">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
                {filteredAndSortedFiles.map((file) => (
                  <FileCard
                    key={file.id}
                    file={file}
                    isSelected={selectedFiles.includes(file.id)}
                    isMobile={isMobile}
                    t={t}
                    onSelect={handleFileSelect}
                    onDelete={(id) => setDeleteConfirm({ type: 'file', id })}
                    onDownload={handleDownload}
                    onPrint={setPrintFile}
                    onSlice={setSliceFile}
                    onRunPipeline={setRunPipelineFile}
                    useSlicerApi={settings?.use_slicer_api ?? false}
                    onPreview3d={(f) => {
                      // Sliced files (.gcode / .gcode.3mf) open the same
                      // full-page gcode viewer the archive card uses, so
                      // the two paths feel consistent. STL / source 3MF
                      // continue to use the in-app 3D model viewer modal.
                      if (isSlicedFilename(f.filename)) {
                        navigate(`/gcode-viewer?library_file=${f.id}`);
                      } else {
                        setViewerFile(f);
                      }
                    }}
                    onRename={(f) => setRenameItem({ type: 'file', id: f.id, name: f.filename })}
                    onGenerateThumbnail={(f) => singleThumbnailMutation.mutate(f.id)}
                    onTagClick={toggleTagFilter}
                    thumbnailVersion={thumbnailVersions[file.id]}
                    hasPermission={hasPermission}
                    canModify={canModify}
                    authEnabled={authEnabled}
                    showModified={showModified}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 lg:overflow-y-auto">
              {/* The wrapper has overflow-x-auto so a narrow viewport scrolls
                  horizontally instead of clipping the actions column off the
                  right edge. The previous `overflow-hidden` was there for the
                  rounded corners but also swallowed any content the actions
                  column couldn't fit (#1325 follow-up reported in chat). */}
              <div className="bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary overflow-x-auto">
                {/* List header - hidden on mobile, show simplified on small screens.
                    Trailing actions column is fixed at 220px (sliced 3MF = 7 icons
                    ~220px). It used to be `min-content`, but header + body are sibling
                    grids that compute `min-content` independently — the header's empty
                    trailing div resolved to 0px, leaving body columns shifted left of
                    their headers. Fixed width keeps header and body in lockstep. */}
                <div className={`hidden sm:grid ${authEnabled ? 'grid-cols-[auto_1fr_120px_100px_100px_100px_minmax(0,200px)_220px]' : 'grid-cols-[auto_1fr_100px_100px_100px_minmax(0,200px)_220px]'} gap-4 px-4 py-2 bg-bambu-dark-secondary border-b border-bambu-dark-tertiary text-xs text-bambu-gray font-medium`}>
                  <div className="w-6" />
                  <div>{t('common.name')}</div>
                  {authEnabled && <div>{t('fileManager.uploadedBy', { defaultValue: 'Uploaded By' })}</div>}
                  <div>{t('common.type')}</div>
                  <div>{t('fileManager.size')}</div>
                  <div>{t('fileManager.prints')}</div>
                  <div>{t('fileManager.tags.title')}</div>
                  <div />
                </div>
                {/* List rows */}
                {filteredAndSortedFiles.map((file) => (
                  <div
                    key={file.id}
                    className={`grid ${authEnabled ? 'grid-cols-[auto_1fr_120px_100px_100px_100px_minmax(0,200px)_220px]' : 'grid-cols-[auto_1fr_100px_100px_100px_minmax(0,200px)_220px]'} gap-4 px-4 py-3 items-center border-b border-bambu-dark-tertiary last:border-b-0 cursor-pointer hover:bg-bambu-dark/50 transition-colors ${
                      selectedFiles.includes(file.id) ? 'bg-bambu-green/10' : ''
                    }`}
                    onClick={() => handleFileSelect(file.id)}
                  >
                    {/* Checkbox */}
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                      selectedFiles.includes(file.id)
                        ? 'bg-bambu-green border-bambu-green'
                        : 'border-bambu-gray/50'
                    }`}>
                      {selectedFiles.includes(file.id) && <div className="w-2 h-2 bg-white rounded-sm" />}
                    </div>
                    {/* Name with thumbnail */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="relative group/thumb">
                        <div className="w-10 h-10 rounded bg-bambu-dark flex-shrink-0 overflow-hidden">
                          {file.thumbnail_path ? (
                            <img
                              src={`${api.getLibraryFileThumbnailUrl(file.id)}${thumbnailVersions[file.id] ? ((api.getLibraryFileThumbnailUrl(file.id).includes('?') ? '&' : '?') + `v=${thumbnailVersions[file.id]}`) : ''}`}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <FileBox className="w-5 h-5 text-bambu-gray/50" />
                            </div>
                          )}
                        </div>
                        {/* Hover preview */}
                        {file.thumbnail_path && (
                          <div className="absolute left-0 top-full mt-2 z-50 hidden group-hover/thumb:block">
                            <div className="w-48 h-48 rounded-lg bg-bambu-dark-secondary border border-bambu-dark-tertiary shadow-xl overflow-hidden">
                              <img
                                src={`${api.getLibraryFileThumbnailUrl(file.id)}${thumbnailVersions[file.id] ? ((api.getLibraryFileThumbnailUrl(file.id).includes('?') ? '&' : '?') + `v=${thumbnailVersions[file.id]}`) : ''}`}
                                alt={file.filename}
                                className="w-full h-full object-contain"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm text-white truncate">{file.print_name || file.filename}</div>
                        {/* #2680: last-modified date under the name, toggled from
                            the toolbar. Real on-disk mtime when known, else created_at. */}
                        {showModified && (
                          <div className="text-xs text-bambu-gray flex items-center gap-1 mt-0.5" title={t('fileManager.lastModified')}>
                            <CalendarClock className="w-3 h-3 flex-shrink-0" />
                            <span className="truncate">{formatDate(file.fs_modified_at ?? file.created_at)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    {/* Uploaded By - only show when auth is enabled */}
                    {authEnabled && (
                      <div className="text-sm text-bambu-gray flex items-center gap-1">
                        {file.created_by_username ? (
                          <>
                            <User className="w-3 h-3" />
                            <span className="truncate">{file.created_by_username}</span>
                          </>
                        ) : (
                          '-'
                        )}
                      </div>
                    )}
                    {/* Type */}
                    <div>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        file.file_type === '3mf' ? 'bg-bambu-green/20 text-bambu-green'
                        : (file.file_type === 'gcode' || file.file_type === 'gcode.3mf') ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400'
                        : file.file_type === 'stl' ? 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400'
                        : 'bg-bambu-gray/20 text-bambu-gray'
                      }`}>
                        {file.file_type.toUpperCase()}
                      </span>
                    </div>
                    {/* Size */}
                    <div className="text-sm text-bambu-gray">{formatFileSize(file.file_size)}</div>
                    {/* Prints */}
                    <div className="text-sm text-bambu-gray">{file.print_count > 0 ? `${file.print_count}x` : '-'}</div>
                    {/* Tags (#1268) — clickable chips push into the active
                        filter; minmax(0,200px) on the column lets the cell
                        shrink/wrap on narrow viewports without pushing the
                        Actions cell off-screen. */}
                    <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
                      {!file.tags || file.tags.length === 0 ? (
                        <span className="text-xs text-bambu-gray/50">-</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {file.tags.map((tg) => (
                            <button
                              key={tg.id}
                              type="button"
                              onClick={() => toggleTagFilter(tg.id)}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-bambu-green/10 text-bambu-green hover:bg-bambu-green/20 transition-colors max-w-full"
                              title={tg.name}
                            >
                              <TagIcon className="w-2.5 h-2.5 flex-shrink-0" />
                              <span className="truncate">{tg.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Actions */}
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      {isSlicedFilename(file.filename) && (
                        <>
                          <button
                            onClick={() => hasPermission('queue:create') && setPrintFile(file)}
                            className={`p-1.5 rounded transition-colors ${
                              hasPermission('queue:create')
                                ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
                                : 'text-bambu-gray/50 cursor-not-allowed'
                            }`}
                            title={hasPermission('queue:create') ? t('common.print') : t('fileManager.noPermissionAddToQueue')}
                            disabled={!hasPermission('queue:create')}
                          >
                            <Printer className="w-4 h-4" />
                          </button>
                        </>
                      )}
                      {(settings?.use_slicer_api ?? false) && isSliceableFilename(file.filename) && (
                        <button
                          onClick={() => hasPermission('library:upload') && setSliceFile(file)}
                          className={`p-1.5 rounded transition-colors ${
                            hasPermission('library:upload')
                              ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
                              : 'text-bambu-gray/50 cursor-not-allowed'
                          }`}
                          title={hasPermission('library:upload') ? t('slice.action') : t('fileManager.noPermissionSlice')}
                          disabled={!hasPermission('library:upload')}
                        >
                          <Cog className="w-4 h-4" />
                        </button>
                      )}
                      {(settings?.use_slicer_api ?? false) && isSliceableFilename(file.filename) && (
                        <button
                          onClick={() => hasPermission('pipelines:run') && setRunPipelineFile(file)}
                          className={`p-1.5 rounded transition-colors ${
                            hasPermission('pipelines:run')
                              ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
                              : 'text-bambu-gray/50 cursor-not-allowed'
                          }`}
                          title={hasPermission('pipelines:run') ? t('library.runWithPipeline.actionLabel', 'Run with pipeline') : t('library.runWithPipeline.noPermission', 'You do not have permission to run pipelines')}
                          disabled={!hasPermission('pipelines:run')}
                        >
                          <Play className="w-4 h-4" />
                        </button>
                      )}
                      {(file.file_type === '3mf' || file.file_type === 'gcode' || file.file_type === 'gcode.3mf' || file.file_type === 'stl') && (
                        <button
                          onClick={() => {
                            if (!hasPermission('library:read')) return;
                            if (isSlicedFilename(file.filename)) {
                              navigate(`/gcode-viewer?library_file=${file.id}`);
                            } else {
                              setViewerFile(file);
                            }
                          }}
                          className={`p-1.5 rounded transition-colors ${
                            hasPermission('library:read')
                              ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
                              : 'text-bambu-gray/50 cursor-not-allowed'
                          }`}
                          title={hasPermission('library:read') ? '3D Preview' : 'You do not have permission to preview files'}
                          disabled={!hasPermission('library:read')}
                        >
                          <Box className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        onClick={() => hasPermission('library:read') && handleDownload(file.id)}
                        className={`p-1.5 rounded transition-colors ${
                          hasPermission('library:read')
                            ? 'hover:bg-bambu-dark text-bambu-gray hover:text-white'
                            : 'text-bambu-gray/50 cursor-not-allowed'
                        }`}
                        title={hasPermission('library:read') ? t('common.download') : t('fileManager.noPermissionDownload')}
                        disabled={!hasPermission('library:read')}
                      >
                        <Download className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => canModify('library', 'update', file.created_by_id) && setRenameItem({ type: 'file', id: file.id, name: file.filename })}
                        className={`p-1.5 rounded transition-colors ${
                          canModify('library', 'update', file.created_by_id)
                            ? 'hover:bg-bambu-dark text-bambu-gray hover:text-white'
                            : 'text-bambu-gray/50 cursor-not-allowed'
                        }`}
                        title={canModify('library', 'update', file.created_by_id) ? t('common.rename') : t('fileManager.noPermissionRenameFile')}
                        disabled={!canModify('library', 'update', file.created_by_id)}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      {file.file_type === 'stl' && (
                        <button
                          onClick={() => canModify('library', 'update', file.created_by_id) && singleThumbnailMutation.mutate(file.id)}
                          className={`p-1.5 rounded transition-colors ${
                            canModify('library', 'update', file.created_by_id)
                              ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
                              : 'text-bambu-gray/50 cursor-not-allowed'
                          }`}
                          title={canModify('library', 'update', file.created_by_id) ? t('fileManager.generateThumbnail') : t('fileManager.noPermissionGenerateThumbnail')}
                          disabled={singleThumbnailMutation.isPending || !canModify('library', 'update', file.created_by_id)}
                        >
                          <Image className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        onClick={() => canModify('library', 'delete', file.created_by_id) && setDeleteConfirm({ type: 'file', id: file.id })}
                        className={`p-1.5 rounded transition-colors ${
                          canModify('library', 'delete', file.created_by_id)
                            ? 'hover:bg-bambu-dark text-bambu-gray hover:text-red-700 dark:hover:text-red-400'
                            : 'text-bambu-gray/50 cursor-not-allowed'
                        }`}
                        title={canModify('library', 'delete', file.created_by_id) ? t('common.delete') : t('fileManager.noPermissionDeleteFile')}
                        disabled={!canModify('library', 'delete', file.created_by_id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          </>
          )}
        </div>
          {/* README rail — collapsible right column on lg+, stacks on top
              on mobile. See the files-area wrapper comment above (#2520). */}
          {selectedFolderId !== null && <FolderReadmePanel folderId={selectedFolderId} />}
        </div>
      </div>
      )}

      {/* Modals */}
      {showNewFolderModal && (
        <NewFolderModal
          parentId={selectedFolderId}
          onClose={() => setShowNewFolderModal(false)}
          onSave={(data) => createFolderMutation.mutate(data)}
          isLoading={createFolderMutation.isPending}
          t={t}
        />
      )}

      {showSectionModal && (
        <NewSectionModal
          title={showSectionModal === 'create' ? t('fileManager.newSection') : t('fileManager.renameSection')}
          initialName={showSectionModal === 'create' ? '' : showSectionModal.name}
          onClose={() => setShowSectionModal(null)}
          onSave={(name) => {
            if (showSectionModal === 'create') createSectionMutation.mutate(name);
            else renameSectionMutation.mutate({ id: showSectionModal.id, name });
          }}
          isLoading={createSectionMutation.isPending || renameSectionMutation.isPending}
          t={t}
        />
      )}

      {deleteSectionId !== null && (
        <ConfirmModal
          title={t('fileManager.deleteSection')}
          message={t('fileManager.deleteSectionConfirm')}
          confirmText={t('common.delete')}
          variant="danger"
          onConfirm={() => deleteSectionMutation.mutate(deleteSectionId)}
          onCancel={() => setDeleteSectionId(null)}
          isLoading={deleteSectionMutation.isPending}
        />
      )}

      {showExternalFolderModal && (
        <ExternalFolderModal
          onClose={() => setShowExternalFolderModal(false)}
          onSave={(data) => createExternalFolderMutation.mutate(data)}
          isLoading={createExternalFolderMutation.isPending}
          t={t}
        />
      )}

      {showMoveModal && folders && (
        <MoveFilesModal
          folders={folders}
          selectedFiles={selectedFiles}
          currentFolderId={selectedFolderId}
          onClose={() => setShowMoveModal(false)}
          onMove={(folderId) => moveFilesMutation.mutate({ fileIds: selectedFiles, folderId })}
          isLoading={moveFilesMutation.isPending}
          t={t}
        />
      )}

      {showUploadModal && (
        <FileUploadModal
          folderId={selectedFolderId}
          onClose={() => {
            setShowUploadModal(false);
            setDroppedFiles([]);
          }}
          onUploadComplete={handleUploadComplete}
          initialFiles={droppedFiles.length > 0 ? droppedFiles : undefined}
        />
      )}

      {showPurgeModal && (
        <PurgeOldFilesModal onClose={() => setShowPurgeModal(false)} />
      )}

      <LibraryTagsModal
        open={showTagsModal}
        onClose={() => setShowTagsModal(false)}
        onPickTag={(tagId) => {
          if (!selectedTagIds.includes(tagId)) {
            setSelectedTagIds((prev) => [...prev, tagId]);
          }
        }}
      />

      <BulkTagsPickerModal
        open={showBulkTagsModal}
        fileIds={selectedFiles}
        onClose={() => setShowBulkTagsModal(false)}
      />

      {linkFolder && (
        <LinkFolderModal
          folder={linkFolder}
          onClose={() => setLinkFolder(null)}
          onLink={(data) => updateFolderMutation.mutate({ id: linkFolder.id, data })}
          isLoading={updateFolderMutation.isPending}
          t={t}
        />
      )}

      {deleteConfirm && (
        <ConfirmModal
          title={
            deleteConfirm.type === 'folder'
              ? t('fileManager.deleteFolder')
              : deleteConfirm.type === 'bulk'
              ? t('fileManager.deleteFilesCount', { count: deleteConfirm.count })
              : t('fileManager.deleteFile')
          }
          message={
            deleteConfirm.type === 'folder'
              ? t('fileManager.deleteFolderConfirm')
              : deleteConfirm.type === 'bulk'
              ? t('fileManager.deleteFilesConfirm', { count: deleteConfirm.count })
              : t('fileManager.deleteFileConfirm')
          }
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={isDeleting}
          loadingText={t('fileManager.deleting')}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {printFile && (
        <PrintModal
          mode="create"
          libraryFileId={printFile.id}
          archiveName={printFile.print_name || printFile.filename}
          onClose={() => setPrintFile(null)}
          onSuccess={() => {
            setPrintFile(null);
            setSelectedFiles([]);
            queryClient.invalidateQueries({ queryKey: ['library-files'] });
            queryClient.invalidateQueries({ queryKey: ['queue'] });
            queryClient.invalidateQueries({ queryKey: ['archives'] });
          }}
        />
      )}

      {sliceFile && (
        <SliceModal
          source={{ kind: 'libraryFile', id: sliceFile.id, filename: sliceFile.filename }}
          onClose={() => setSliceFile(null)}
        />
      )}

      {runPipelineFile && (
        <RunWithPipelineModal
          source={{ kind: 'libraryFile', id: runPipelineFile.id, filename: runPipelineFile.filename }}
          onClose={() => setRunPipelineFile(null)}
        />
      )}

      {viewerFile && (
        <ModelViewerModal
          libraryFileId={viewerFile.id}
          title={viewerFile.print_name || viewerFile.filename}
          fileType={viewerFile.file_type}
          onClose={() => setViewerFile(null)}
          onSliceWithBambuddy={
            // Only offer in-app slicing on files the SliceModal can actually
            // handle (matches the file-row Cog visibility check at :2127).
            isSliceableFilename(viewerFile.filename) && hasPermission('library:upload')
              ? () => {
                  const f = viewerFile;
                  setViewerFile(null);
                  setSliceFile(f);
                }
              : undefined
          }
        />
      )}

      {renameItem && (
        <RenameModal
          type={renameItem.type}
          currentName={renameItem.name}
          onClose={() => setRenameItem(null)}
          onSave={(newName) => {
            if (renameItem.type === 'file') {
              renameFileMutation.mutate({ id: renameItem.id, filename: newName });
            } else {
              renameFolderMutation.mutate({ id: renameItem.id, name: newName });
            }
          }}
          isLoading={renameFileMutation.isPending || renameFolderMutation.isPending}
          t={t}
        />
      )}
    </div>
  );
}
