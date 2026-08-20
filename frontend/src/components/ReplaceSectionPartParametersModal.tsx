import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Upload, X } from 'lucide-react';
import { api } from '../api/client';
import type { LibrarySectionPart, SectionPartParameterPreview } from '../api/client';
import { Button } from './Button';
import { ProductionParameterDiffTable } from './production/ProductionParameterDiffTable';

interface ReplaceSectionPartParametersModalProps {
  sectionId: number;
  part: LibrarySectionPart;
  onClose: () => void;
  onReplaced: () => void;
}

export function ReplaceSectionPartParametersModal({
  sectionId,
  part,
  onClose,
  onReplaced,
}: ReplaceSectionPartParametersModalProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SectionPartParameterPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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
      const result = await api.previewLibrarySectionPartParameters(sectionId, part.id, next);
      setPreview(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(t('fileManager.sectionParts.previewFailed', { error: message }));
    } finally {
      setPreviewing(false);
    }
  };

  const handleReplace = async () => {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.seedLibrarySectionPartParameters(sectionId, part.id, file, {
        resolution: 'accept_baseline',
      });
      onReplaced();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(t('fileManager.sectionParts.replaceFailed', { error: message }));
    } finally {
      setSubmitting(false);
    }
  };

  const mismatchCount = preview?.parameter_diff.filter((row) => !row.match).length ?? 0;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div
        className="bg-bambu-dark-secondary rounded-lg w-full max-w-2xl border border-bambu-dark-tertiary max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-labelledby="replace-section-part-title"
      >
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between">
          <h2 id="replace-section-part-title" className="text-lg font-semibold text-white">
            {t('fileManager.sectionParts.replaceParametersTitle')}
            <span className="text-bambu-gray font-normal"> · {part.code}</span>
          </h2>
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
          <p className="text-xs text-bambu-gray">{t('fileManager.sectionParts.replaceParametersHelp')}</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".3mf,.gcode,.gcode.3mf"
            className="hidden"
            data-testid="section-part-replace-file"
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

          {preview && preview.has_existing_contract && (
            <>
              {preview.has_mismatches && (
                <p className="text-sm text-amber-500">
                  {t('fileManager.production.mismatchCount', { count: mismatchCount })}
                </p>
              )}
              <ProductionParameterDiffTable rows={preview.parameter_diff} />
            </>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              {t('fileManager.production.cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => void handleReplace()}
              disabled={!file || !preview || previewing || submitting}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('fileManager.sectionParts.replaceConfirm')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
