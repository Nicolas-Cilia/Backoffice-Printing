import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Upload, X } from 'lucide-react';
import { api } from '../../api/client';
import type { ProductionPartView } from '../../api/client';
import { Button } from '../Button';
import { parseProductionFilename } from '../../utils/productionFilename';

interface AddProductionFileModalProps {
  folderId: number;
  printerModel: string;
  parts: ProductionPartView[];
  initialFile?: File | null;
  onClose: () => void;
  onCreated: () => void;
}

export function AddProductionFileModal({
  folderId,
  printerModel,
  parts,
  initialFile = null,
  onClose,
  onCreated,
}: AddProductionFileModalProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(initialFile);
  const [code, setCode] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [major, setMajor] = useState('1');
  const [revision, setRevision] = useState('0');
  const [minor, setMinor] = useState('0');
  const [printer, setPrinter] = useState(printerModel);
  const [parseFailed, setParseFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, submitting]);

  useEffect(() => {
    if (!file) return;
    const parsed = parseProductionFilename(file.name);
    if (parsed) {
      setCode(parsed.code);
      setQuantity(String(parsed.quantity));
      setMajor(String(parsed.major));
      setRevision(String(parsed.revision));
      setMinor(String(parsed.minor));
      setPrinter(parsed.printer);
      setParseFailed(false);
    } else {
      setParseFailed(true);
    }
  }, [file]);

  const matchingPart = useMemo(
    () => parts.find((part) => part.code.toUpperCase() === code.trim().toUpperCase()),
    [parts, code],
  );
  const qtyNumber = Number(quantity);
  const existingSlot = matchingPart?.slots.some((slot) => slot.quantity === qtyNumber) ?? false;

  const identityComplete =
    code.trim().length > 0
    && Number.isInteger(qtyNumber)
    && qtyNumber >= 1
    && Number.isInteger(Number(major))
    && Number.isInteger(Number(revision))
    && Number.isInteger(Number(minor))
    && printer.trim().length > 0;

  const applyFile = (next: File | null) => {
    setFile(next);
    setConfirmed(false);
    setError(null);
  };

  const handleSubmit = async () => {
    if (!file || !identityComplete || !confirmed || existingSlot) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createProductionSlot(file, {
        folder_id: folderId,
        code: code.trim().toUpperCase(),
        quantity: qtyNumber,
        major: Number(major),
        revision: Number(revision),
        minor: Number(minor),
        printer: printer.trim(),
      });
      onCreated();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(t('fileManager.production.createFailed', { error: message }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-lg border border-bambu-dark-tertiary max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{t('fileManager.production.addFile')}</h2>
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
          <input
            ref={fileInputRef}
            type="file"
            accept=".3mf,.gcode,.gcode.3mf"
            className="hidden"
            onChange={(e) => applyFile(e.target.files?.[0] ?? null)}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full border-2 border-dashed border-bambu-dark-tertiary hover:border-bambu-green rounded-lg p-6 text-center text-bambu-gray hover:text-white transition-colors"
          >
            <Upload className="w-8 h-8 mx-auto mb-2 text-bambu-green" />
            <p className="text-sm">{file ? file.name : t('fileManager.production.pickFile')}</p>
          </button>

          {file && parseFailed && (
            <p className="text-sm text-amber-500">{t('fileManager.production.parseFailed')}</p>
          )}

          {file && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-bambu-gray">{t('fileManager.production.code')}</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  className="mt-1 w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
                />
              </label>
              <label className="block text-sm">
                <span className="text-bambu-gray">{t('fileManager.production.quantity')}</span>
                <input
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="mt-1 w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
                />
              </label>
              <label className="block text-sm">
                <span className="text-bambu-gray">{t('fileManager.production.version')}</span>
                <div className="mt-1 flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    value={major}
                    onChange={(e) => setMajor(e.target.value)}
                    className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-2 text-white focus:outline-none focus:border-bambu-green"
                  />
                  <span className="text-bambu-gray">.</span>
                  <input
                    type="number"
                    min={0}
                    value={revision}
                    onChange={(e) => setRevision(e.target.value)}
                    className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-2 text-white focus:outline-none focus:border-bambu-green"
                  />
                  <span className="text-bambu-gray">.</span>
                  <input
                    type="number"
                    min={0}
                    value={minor}
                    onChange={(e) => setMinor(e.target.value)}
                    className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-2 text-white focus:outline-none focus:border-bambu-green"
                  />
                </div>
              </label>
              <label className="block text-sm">
                <span className="text-bambu-gray">{t('fileManager.production.printer')}</span>
                <input
                  value={printer}
                  onChange={(e) => setPrinter(e.target.value)}
                  className="mt-1 w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
                />
              </label>
            </div>
          )}

          {file && code && matchingPart && matchingPart.slots.length > 0 && (
            <p className="text-sm text-bambu-gray">
              {t('fileManager.production.newQuantityHint', { code: matchingPart.code, quantity: qtyNumber || 1 })}
            </p>
          )}
          {file && code && !matchingPart && (
            <p className="text-sm text-bambu-gray">
              {t('fileManager.production.newPartHint', { code: code.trim().toUpperCase() })}
            </p>
          )}
          {existingSlot && (
            <p className="text-sm text-amber-500">{t('fileManager.production.slotExists')}</p>
          )}

          {file && (
            <label className="flex items-start gap-2 text-sm text-white">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-1"
              />
              <span>{t('fileManager.production.newSlotConfirm')}</span>
            </label>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              {t('fileManager.production.cancel')}
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!file || !identityComplete || !confirmed || existingSlot || submitting}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {submitting ? t('fileManager.production.uploading') : t('fileManager.production.confirmCreate')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
