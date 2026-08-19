import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Upload, X } from 'lucide-react';
import { api } from '../../api/client';
import type { ProductionReplacePreview } from '../../api/client';
import { Button } from '../Button';
import { ProductionParameterDiffTable } from './ProductionParameterDiffTable';
import { parseProductionFilename, storedProductionFilename } from '../../utils/productionFilename';

interface ReplaceProductionFileModalProps {
  slotId: number;
  code: string;
  quantity: number;
  major: number;
  revision: number;
  minor: number;
  currentVersion: string;
  printerModel: string;
  onClose: () => void;
  onReplaced: () => void;
}

export function ReplaceProductionFileModal({
  slotId,
  code: slotCode,
  quantity: slotQuantity,
  major: slotMajor,
  revision: slotRevision,
  minor: slotMinor,
  currentVersion,
  printerModel,
  onClose,
  onReplaced,
}: ReplaceProductionFileModalProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [code, setCode] = useState(slotCode);
  const [quantity, setQuantity] = useState(String(slotQuantity));
  const [major, setMajor] = useState(String(slotMajor));
  const [revision, setRevision] = useState(String(slotRevision));
  const [minor, setMinor] = useState(String(slotMinor));
  const [printer, setPrinter] = useState(printerModel);
  const [parseFailed, setParseFailed] = useState(false);
  const [preview, setPreview] = useState<ProductionReplacePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting && !previewing) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, submitting, previewing]);

  const qtyNumber = Number(quantity);
  const identityComplete =
    code.trim().length > 0
    && Number.isInteger(qtyNumber)
    && qtyNumber >= 1
    && Number.isInteger(Number(major))
    && Number.isInteger(Number(revision))
    && Number.isInteger(Number(minor))
    && printer.trim().length > 0;

  const savedAs = useMemo(() => {
    if (!file || !identityComplete) return null;
    return storedProductionFilename(
      file.name,
      code.trim().toUpperCase(),
      qtyNumber,
      Number(major),
      Number(revision),
      Number(minor),
      printer.trim(),
    );
  }, [file, identityComplete, code, qtyNumber, major, revision, minor, printer]);

  const applyIdentityFromFile = (next: File) => {
    const parsed = parseProductionFilename(next.name);
    if (parsed) {
      setCode(parsed.code);
      setQuantity(String(parsed.quantity));
      setMajor(String(parsed.major));
      setRevision(String(parsed.revision));
      setMinor(String(parsed.minor));
      setPrinter(parsed.printer);
      setParseFailed(false);
      return;
    }
    setCode(slotCode);
    setQuantity(String(slotQuantity));
    setMajor(String(slotMajor));
    setRevision(String(slotRevision));
    setMinor(String(slotMinor));
    setPrinter(printerModel);
    setParseFailed(true);
  };

  const loadPreview = async (next: File) => {
    setFile(next);
    applyIdentityFromFile(next);
    setPreview(null);
    setError(null);
    setPreviewing(true);
    try {
      const result = await api.previewReplaceProductionSlot(slotId, next);
      setPreview(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(t('fileManager.production.previewFailed', { error: message }));
    } finally {
      setPreviewing(false);
    }
  };

  const submit = async (resolution: 'proceed' | 'accept_baseline') => {
    if (!file || !identityComplete) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.replaceProductionSlot(slotId, file, {
        resolution,
        reason: reason.trim() || null,
        code: code.trim().toUpperCase(),
        quantity: qtyNumber,
        major: Number(major),
        revision: Number(revision),
        minor: Number(minor),
        printer: printer.trim(),
      });
      onReplaced();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(t('fileManager.production.replaceFailed', { error: message }));
    } finally {
      setSubmitting(false);
    }
  };

  const mismatchCount = preview?.parameter_diff.filter((row) => !row.match).length ?? 0;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-2xl border border-bambu-dark-tertiary max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{t('fileManager.production.replace')}</h2>
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
            onChange={(e) => {
              const next = e.target.files?.[0];
              if (next) void loadPreview(next);
            }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full border-2 border-dashed border-bambu-dark-tertiary hover:border-bambu-green rounded-lg p-6 text-center text-bambu-gray hover:text-white transition-colors"
          >
            <Upload className="w-8 h-8 mx-auto mb-2 text-bambu-green" />
            <p className="text-sm">{file ? file.name : t('fileManager.production.pickFile')}</p>
          </button>
          {savedAs && (
            <p className="text-xs text-bambu-gray font-mono text-center" data-testid="production-saved-as">
              {savedAs}
            </p>
          )}

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

          {previewing && (
            <div className="flex items-center gap-2 text-sm text-bambu-gray">
              <Loader2 className="w-4 h-4 animate-spin text-bambu-green" />
              {t('fileManager.production.previewing')}
            </div>
          )}

          {preview && (
            <>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-bambu-gray">{t('fileManager.production.currentVersion')}</p>
                  <p className="text-white font-medium">{preview.current_version || currentVersion}</p>
                </div>
                <div>
                  <p className="text-bambu-gray">{t('fileManager.production.incomingVersion')}</p>
                  <p className="text-white font-medium">{preview.incoming_version ?? '—'}</p>
                </div>
              </div>

              {!preview.version_is_newer && (
                <p className="text-sm text-amber-500">
                  {t('fileManager.production.versionNotNewer', {
                    incoming: preview.incoming_version ?? '—',
                    current: preview.current_version,
                  })}
                </p>
              )}
              <p className="text-xs text-bambu-gray">
                {t('fileManager.production.suggestedVersion', { version: preview.suggested_next_version })}
              </p>

              {!preview.printer_matches_folder && (
                <p className="text-sm text-amber-500">
                  {t('fileManager.production.printerMismatch', {
                    file: preview.parsed_filename?.printer ?? '—',
                    folder: printerModel,
                  })}
                </p>
              )}

              {preview.has_mismatches && (
                <p className="text-sm text-amber-500">
                  {t('fileManager.production.mismatchCount', { count: mismatchCount })}
                </p>
              )}

              <ProductionParameterDiffTable rows={preview.parameter_diff} />

              <label className="block text-sm">
                <span className="text-bambu-gray">{t('fileManager.production.reason')}</span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t('fileManager.production.reasonPlaceholder')}
                  rows={2}
                  className="mt-1 w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
                />
              </label>
            </>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              {t('fileManager.production.cancel')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void submit('proceed')}
              disabled={!preview || !identityComplete || submitting}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('fileManager.production.proceedAnyway')}
            </Button>
            <Button
              type="button"
              onClick={() => void submit('accept_baseline')}
              disabled={!preview || !identityComplete || submitting}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('fileManager.production.acceptBaseline')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
