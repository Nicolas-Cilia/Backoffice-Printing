import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, Loader2, Upload, X, XCircle } from 'lucide-react';
import { api } from '../../api/client';
import type { ProductionParameterDiff, ProductionReplacePreview } from '../../api/client';
import { Button } from '../Button';

interface ReplaceProductionFileModalProps {
  slotId: number;
  currentVersion: string;
  printerModel: string;
  onClose: () => void;
  onReplaced: () => void;
}

function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function ReplaceProductionFileModal({
  slotId,
  currentVersion,
  printerModel,
  onClose,
  onReplaced,
}: ReplaceProductionFileModalProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
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

  const loadPreview = async (next: File) => {
    setFile(next);
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
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      const parsed = preview?.parsed_filename;
      await api.replaceProductionSlot(slotId, file, {
        resolution,
        reason: reason.trim() || null,
        major: parsed?.major ?? null,
        revision: parsed?.revision ?? null,
        minor: parsed?.minor ?? null,
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

              <div className="overflow-x-auto rounded-lg border border-bambu-dark-tertiary">
                <table className="w-full text-sm">
                  <thead className="bg-bambu-dark text-bambu-gray">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">{t('fileManager.production.parameter')}</th>
                      <th className="text-left px-3 py-2 font-medium">{t('fileManager.production.lockedValue')}</th>
                      <th className="text-left px-3 py-2 font-medium">{t('fileManager.production.incomingValue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.parameter_diff.map((row: ProductionParameterDiff) => (
                      <tr
                        key={row.key}
                        className={row.match ? 'bg-green-500/10' : 'bg-red-500/10'}
                      >
                        <td className="px-3 py-2 text-white font-mono text-xs">{row.key}</td>
                        <td className="px-3 py-2 text-bambu-gray font-mono text-xs">{formatDiffValue(row.locked)}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          <span className="inline-flex items-center gap-1">
                            {row.match ? (
                              <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                            ) : (
                              <XCircle className="w-3.5 h-3.5 text-red-500" />
                            )}
                            <span className={row.match ? 'text-green-400' : 'text-red-400'}>
                              {formatDiffValue(row.incoming)}
                            </span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

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
              disabled={!preview || submitting}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('fileManager.production.proceedAnyway')}
            </Button>
            <Button
              type="button"
              onClick={() => void submit('accept_baseline')}
              disabled={!preview || submitting}
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
