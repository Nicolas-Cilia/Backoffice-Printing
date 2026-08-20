import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Upload, X } from 'lucide-react';
import { api } from '../../api/client';
import type { ProductionPartView, ProductionReplacePreview } from '../../api/client';
import { Button } from '../Button';
import { parseProductionFilename, storedProductionFilename } from '../../utils/productionFilename';
import {
  collectParameterNotes,
  mismatchNotesComplete,
  ProductionParameterDiffTable,
} from './ProductionParameterDiffTable';

interface AddProductionFileModalProps {
  folderId: number;
  printerModel: string;
  parts: ProductionPartView[];
  initialFile?: File | null;
  initialCode?: string;
  onClose: () => void;
  onCreated: () => void;
}

function partHasContract(part: ProductionPartView | undefined): boolean {
  if (!part) return false;
  if (part.slots.length > 0) return true;
  const locked = part.locked_parameters;
  return Boolean(locked && Object.keys(locked).length > 0);
}

export function AddProductionFileModal({
  folderId,
  printerModel,
  parts,
  initialFile = null,
  initialCode = '',
  onClose,
  onCreated,
}: AddProductionFileModalProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(initialFile);
  const [code, setCode] = useState(initialCode);
  const [quantity, setQuantity] = useState('1');
  const [major, setMajor] = useState('1');
  const [revision, setRevision] = useState('0');
  const [minor, setMinor] = useState('0');
  const [printer, setPrinter] = useState(printerModel);
  const [parseFailed, setParseFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProductionReplacePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [reason, setReason] = useState('');
  const [parameterNotes, setParameterNotes] = useState<Record<string, string>>({});

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
  const hasContract = partHasContract(matchingPart);

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

  useEffect(() => {
    if (!file || !identityComplete || !hasContract || existingSlot) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    setError(null);
    void api.previewCreateProductionSlot(file, {
      folder_id: folderId,
      code: code.trim().toUpperCase(),
      quantity: qtyNumber,
      major: Number(major),
      revision: Number(revision),
      minor: Number(minor),
      printer: printer.trim(),
    }).then((result) => {
      if (!cancelled) setPreview(result);
    }).catch((err: unknown) => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      setPreview(null);
      setError(t('fileManager.production.previewFailed', { error: message }));
    }).finally(() => {
      if (!cancelled) setPreviewing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [file, folderId, code, qtyNumber, major, revision, minor, printer, hasContract, existingSlot, identityComplete, t]);

  const applyFile = (next: File | null) => {
    setFile(next);
    setConfirmed(false);
    setError(null);
    setPreview(null);
    setReason('');
    setParameterNotes({});
  };

  const identityFields = () => ({
    folder_id: folderId,
    code: code.trim().toUpperCase(),
    quantity: qtyNumber,
    major: Number(major),
    revision: Number(revision),
    minor: Number(minor),
    printer: printer.trim(),
  });

  const handleCreate = async (resolution?: 'proceed' | 'accept_baseline') => {
    if (!file || !identityComplete || existingSlot) return;
    if (!hasContract && !confirmed) return;
    if (hasContract && preview?.has_mismatches && !resolution) return;
    if (
      resolution === 'proceed'
      && preview?.has_mismatches
      && !mismatchNotesComplete(preview.parameter_diff, parameterNotes)
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const notes = preview?.has_mismatches && resolution === 'proceed'
        ? collectParameterNotes(preview.parameter_diff, parameterNotes)
        : undefined;
      await api.createProductionSlot(file, {
        ...identityFields(),
        resolution: resolution ?? null,
        reason: reason.trim() || null,
        parameter_notes: notes && Object.keys(notes).length > 0 ? notes : undefined,
      });
      onCreated();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(t('fileManager.production.createFailed', { error: message }));
    } finally {
      setSubmitting(false);
    }
  };

  const mismatchCount = preview?.parameter_diff.filter((row) => !row.match).length ?? 0;
  const showDiffActions = Boolean(hasContract && preview?.has_mismatches);
  const proceedNotesReady = Boolean(
    preview && (!preview.has_mismatches || mismatchNotesComplete(preview.parameter_diff, parameterNotes)),
  );
  const canCreateWithoutResolution = Boolean(
    file && identityComplete && !existingSlot && !submitting && (
      (!hasContract && confirmed) || (hasContract && preview && !preview.has_mismatches && !previewing)
    ),
  );

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

          {file && code && matchingPart && matchingPart.slots.length > 0 && (
            <p className="text-sm text-bambu-gray">
              {t('fileManager.production.newQuantityHint', { code: matchingPart.code, quantity: qtyNumber || 1 })}
            </p>
          )}
          {file && hasContract && matchingPart && (
            <p className="text-sm text-bambu-gray">
              {t('fileManager.production.sharedContractHint', { code: matchingPart.code })}
            </p>
          )}
          {file && code && !matchingPart && (
            <p className="text-sm text-bambu-gray">
              {t('fileManager.production.newPartHint', { code: code.trim().toUpperCase() })}
            </p>
          )}
          {file && existingSlot && (
            <p className="text-sm text-amber-500">{t('fileManager.production.slotExists')}</p>
          )}

          {previewing && (
            <div className="flex items-center gap-2 text-sm text-bambu-gray">
              <Loader2 className="w-4 h-4 animate-spin text-bambu-green" />
              {t('fileManager.production.previewing')}
            </div>
          )}

          {preview && hasContract && (
            <>
              {preview.has_mismatches && (
                <p className="text-sm text-amber-500">
                  {t('fileManager.production.mismatchCount', { count: mismatchCount })}
                </p>
              )}
              <ProductionParameterDiffTable
                rows={preview.parameter_diff}
                notes={parameterNotes}
                onNoteChange={(key, value) => setParameterNotes((prev) => ({ ...prev, [key]: value }))}
              />
              {preview.has_mismatches && !proceedNotesReady && (
                <p className="text-sm text-amber-500">{t('fileManager.production.notesRequired')}</p>
              )}
              {preview.has_mismatches && (
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
              )}
            </>
          )}

          {file && !hasContract && (
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

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              {t('fileManager.production.cancel')}
            </Button>
            {showDiffActions ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleCreate('proceed')}
                  disabled={!preview || submitting || existingSlot || !proceedNotesReady}
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {t('fileManager.production.proceedAnyway')}
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleCreate('accept_baseline')}
                  disabled={!preview || submitting || existingSlot}
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {t('fileManager.production.acceptBaseline')}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={() => void handleCreate()}
                disabled={!canCreateWithoutResolution}
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {submitting ? t('fileManager.production.uploading') : t('fileManager.production.confirmCreate')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
