import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { api } from '../../api/client';
import { Button } from '../Button';

interface AddProductionPartModalProps {
  folderId: number;
  onClose: () => void;
  onCreated: () => void;
}

export function AddProductionPartModal({
  folderId,
  onClose,
  onCreated,
}: AddProductionPartModalProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, submitting]);

  const normalizedCode = code.trim().toUpperCase();
  const codeValid = /^[A-Z]{1,32}$/.test(normalizedCode);

  const handleSubmit = async () => {
    if (!codeValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.addProductionPart(folderId, { code: normalizedCode, name: name.trim() });
      onCreated();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(t('fileManager.production.addPartFailed', { error: message }));
    } finally {
      setSubmitting(false);
    }
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
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('fileManager.production.confirmAddPart')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
