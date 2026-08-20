import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { api } from '../../api/client';
import type { LibrarySectionPart } from '../../api/client';
import { Button } from '../Button';

interface AddProductionPartModalProps {
  folderId: number;
  sectionId?: number | null;
  existingCodes?: string[];
  onClose: () => void;
  onCreated: () => void;
}

export function AddProductionPartModal({
  folderId,
  sectionId = null,
  existingCodes = [],
  onClose,
  onCreated,
}: AddProductionPartModalProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingCode, setAddingCode] = useState<string | null>(null);

  const { data: sectionParts = [], isLoading: catalogLoading } = useQuery({
    queryKey: ['library-section-parts', sectionId],
    queryFn: () => api.getLibrarySectionParts(sectionId!),
    enabled: sectionId != null,
  });

  const existing = useMemo(
    () => new Set(existingCodes.map((item) => item.toUpperCase())),
    [existingCodes],
  );
  const availableParts = useMemo(
    () => sectionParts.filter((part) => !existing.has(part.code.toUpperCase())),
    [sectionParts, existing],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, submitting]);

  const normalizedCode = code.trim().toUpperCase();
  const codeValid = /^[A-Z]{1,32}$/.test(normalizedCode);

  const addPart = async (nextCode: string, nextName: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await api.addProductionPart(folderId, { code: nextCode, name: nextName });
      onCreated();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(t('fileManager.production.addPartFailed', { error: message }));
    } finally {
      setSubmitting(false);
      setAddingCode(null);
    }
  };

  const handleSubmit = async () => {
    if (!codeValid || submitting) return;
    await addPart(normalizedCode, name.trim());
  };

  const handleCatalogClick = async (part: LibrarySectionPart) => {
    if (submitting) return;
    setAddingCode(part.code);
    await addPart(part.code, part.name);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-md border border-bambu-dark-tertiary">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{t('fileManager.production.addPartTitle')}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-bambu-gray hover:text-white p-1 rounded"
            aria-label={t('fileManager.production.cancel')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          {sectionId != null && (
            <div className="space-y-2">
              <p className="text-sm text-bambu-gray">{t('fileManager.sectionParts.catalog')}</p>
              {catalogLoading ? (
                <div className="flex items-center gap-2 text-sm text-bambu-gray">
                  <Loader2 className="w-4 h-4 animate-spin text-bambu-green" />
                </div>
              ) : availableParts.length === 0 ? (
                <p className="text-xs text-bambu-gray">{t('fileManager.sectionParts.empty')}</p>
              ) : (
                <div className="space-y-1.5">
                  {availableParts.map((part) => (
                    <button
                      key={part.id}
                      type="button"
                      disabled={submitting}
                      onClick={() => void handleCatalogClick(part)}
                      className="w-full text-left px-3 py-2 rounded border border-bambu-dark-tertiary bg-bambu-dark hover:border-bambu-green disabled:opacity-50"
                    >
                      <span className="flex items-center gap-2">
                        {addingCode === part.code ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-bambu-green" />
                        ) : null}
                        <span className="font-mono text-sm text-white">{part.code}</span>
                        {part.name ? <span className="text-sm text-bambu-gray">{part.name}</span> : null}
                      </span>
                      {part.locked_parameters && Object.keys(part.locked_parameters).length > 0 && (
                        <p className="text-[11px] text-bambu-gray mt-1">
                          {t('fileManager.sectionParts.followsSectionSpec')}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-bambu-gray pt-1">{t('fileManager.sectionParts.orCreate')}</p>
            </div>
          )}
          <label className="block text-sm">
            <span className="text-bambu-gray">{t('fileManager.production.code')}</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              className="mt-1 w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
              autoFocus
            />
          </label>
          <label className="block text-sm">
            <span className="text-bambu-gray">{t('fileManager.production.partName')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
            />
          </label>
          <p className="text-xs text-bambu-gray">{t('fileManager.production.partCodeHint')}</p>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              {t('fileManager.production.cancel')}
            </Button>
            <Button type="button" onClick={() => void handleSubmit()} disabled={!codeValid || submitting}>
              {submitting && !addingCode ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('fileManager.production.confirmAddPart')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
