import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, ChevronDown, Eraser, Link2, Link2Off, Loader2, Package, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, type FloorBinJobCandidate, type FloorBinManagement, type FloorBotBinMember, type FloorInventoryPart, type FloorPrinter } from '../api/client';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { useToast } from '../contexts/ToastContext';
import { formatFloorDate } from '../utils/floorScan';
import { FLOOR_PASS_BADGE_CLASS, isFloorPassBinStatus } from '../utils/floorPartHistory';

function statusLabel(status: string): string {
  if (status === 'loaded') return 'Loaded';
  if (status === 'visual_qc_passed') return 'Visual QC pass';
  if (status === 'ready_for_production') return 'Staged for Production';
  if (status === 'wip') return 'In WIP';
  if (status === 'harvested') return 'Awaiting visual QC';
  if (status === 'unlinked') return 'Needs relinking';
  if (status === 'empty_override') return 'Depleted (manually cleared)';
  if (status === 'empty') return 'Depleted';
  return status.replaceAll('_', ' ');
}

function binManagementCardClass(focused: boolean, constrained = false): string {
  return [
    'flex flex-col rounded-lg border bg-bambu-dark p-4 min-h-[17rem]',
    constrained ? 'max-h-[17rem] overflow-hidden' : '',
    focused ? 'border-bambu-green ring-2 ring-bambu-green' : 'border-bambu-dark-tertiary',
  ].join(' ');
}

const BOT_BIN_MAX_MEMBERS = 20;

function botBinAssignErrorMessage(
  result: string,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (result === 'locked') {
    return t('inventory.botBinAssignLocked', 'Cannot add bottoms while this bin is in WIP');
  }
  if (result === 'qc_required') {
    return t('inventory.botBinAssignQcRequired', 'Initial QC Pass is required before loading into a BOT bin');
  }
  if (result === 'wrong_part') {
    return t('inventory.botBinAssignWrongPart', 'Only bottom (BOT) housings go in BOT bins');
  }
  if (result === 'bin_in_use') {
    return t('inventory.botBinAssignFull', 'This BOT bin is full — choose another');
  }
  return t('inventory.botBinAssignInvalid', 'Could not add bottom to BOT bin');
}

function statusClass(status: string): string {
  if (isFloorPassBinStatus(status)) {
    return FLOOR_PASS_BADGE_CLASS;
  }
  if (status === 'unlinked') {
    return 'border border-amber-600 bg-amber-100 text-amber-800 shadow-sm shadow-amber-500/20 dark:border-amber-400/50 dark:bg-amber-500/20 dark:text-amber-300';
  }
  return 'bg-bambu-green/15 text-bambu-green';
}

export function FloorBinManagementPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [assignPrinterIds, setAssignPrinterIds] = useState<Record<string, number | null>>({});
  const [assignQuantities, setAssignQuantities] = useState<Record<string, string>>({});
  const [clearTarget, setClearTarget] = useState<FloorBinManagement | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<FloorBinManagement | null>(null);
  const [relinkTarget, setRelinkTarget] = useState<FloorBinManagement | null>(null);
  const [relinkPrinterId, setRelinkPrinterId] = useState<number | null>(null);
  const [relinkArchiveId, setRelinkArchiveId] = useState<number | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ batchId: number; partId: number; sticker: string } | null>(null);
  const [movePayload, setMovePayload] = useState('');
  const [removeTarget, setRemoveTarget] = useState<{ batchId: number; partId: number; sticker: string } | null>(null);
  const [clearBotTarget, setClearBotTarget] = useState<FloorBinManagement | null>(null);
  const [botAssignStickers, setBotAssignStickers] = useState<Record<string, string>>({});
  // Deep-link focus from the Serials assembly card (``?bin=BBN-KNB-1``): the
  // matching card is highlighted and scrolled into view.
  const [searchParams] = useSearchParams();
  const focusPayload = (searchParams.get('bin') ?? '').trim().toUpperCase() || null;
  const focusedRef = useRef<HTMLElement | null>(null);

  const binsQuery = useQuery({
    queryKey: ['floor-bin-management'],
    queryFn: api.getFloorBinManagement,
  });
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['floor-bin-management'] }),
    queryClient.invalidateQueries({ queryKey: ['floor-bin-history'] }),
    queryClient.invalidateQueries({ queryKey: ['floor-bot-bin-members'] }),
  ]);
  const overrideMutation = useMutation({
    mutationFn: ({ payload, remaining_quantity }: { payload: string; remaining_quantity: number }) =>
      api.overrideFloorBinQuantity({ payload, remaining_quantity }),
    onSuccess: async () => {
      setClearTarget(null);
      await refresh();
      showToast(t('inventory.binQuantityUpdated', 'Bin quantity updated'), 'success');
    },
    onError: () => showToast(t('inventory.binQuantityUpdateFailed', 'Could not update bin quantity'), 'error'),
  });
  const unlinkMutation = useMutation({
    mutationFn: (payload: string) => api.unlinkFloorBin({ payload }),
    onSuccess: async () => {
      setUnlinkTarget(null);
      await refresh();
      showToast(t('inventory.binUnlinked', 'Bin assignment cleared'), 'success');
    },
    onError: () => showToast(t('inventory.binUnlinkFailed', 'Could not clear bin assignment'), 'error'),
  });
  const printersQuery = useQuery({
    queryKey: ['floor-printers'],
    queryFn: api.getFloorPrinters,
  });
  const assignMutation = useMutation({
    mutationFn: ({
      payload,
      printer_id,
      quantity,
    }: {
      payload: string;
      printer_id: number;
      quantity: number;
    }) => api.assignFloorBin({ payload, printer_id, quantity }),
    onSuccess: async (_data, variables) => {
      setAssignPrinterIds((current) => ({ ...current, [variables.payload]: null }));
      setAssignQuantities((current) => ({ ...current, [variables.payload]: '' }));
      await refresh();
      showToast(t('inventory.binAssigned', 'Bin assigned to printer'), 'success');
    },
    onError: () => showToast(t('inventory.binAssignFailed', 'Could not assign bin'), 'error'),
  });
  const candidatesQuery = useQuery({
    queryKey: ['floor-bin-job-candidates', relinkTarget?.batch?.id, relinkPrinterId],
    queryFn: () => api.getFloorBinJobCandidates(relinkTarget!.batch!.id, relinkPrinterId!),
    enabled: relinkTarget?.batch !== null && relinkTarget?.batch !== undefined && relinkPrinterId !== null,
  });
  const relinkMutation = useMutation({
    mutationFn: ({ batchId, archiveId }: { batchId: number; archiveId: number }) =>
      api.relinkFloorBin(batchId, archiveId),
    onSuccess: async () => {
      setRelinkTarget(null);
      setRelinkPrinterId(null);
      setRelinkArchiveId(null);
      await refresh();
      showToast(t('inventory.binRelinked', 'Bin linked to completed job'), 'success');
    },
    onError: () => showToast(t('inventory.binRelinkFailed', 'Could not link bin to completed job'), 'error'),
  });
  const removeBotMemberMutation = useMutation({
    mutationFn: ({ batchId, partId }: { batchId: number; partId: number }) =>
      api.officeRemoveBotBinMember(batchId, partId),
    onSuccess: async (resp) => {
      setRemoveTarget(null);
      await refresh();
      if (resp.result !== 'recorded') {
        showToast(botBinAssignErrorMessage(resp.result, t), 'error');
        return;
      }
      showToast(t('inventory.botBinMemberRemoved', 'Bottom removed from BOT bin'), 'success');
      if (resp.empty_bin_warning) {
        showToast(
          t('inventory.botBinEmptyWarning', 'Last bottom removed — mark the bin empty when it is off the line'),
          'warning',
        );
      }
    },
    onError: () => showToast(t('inventory.botBinMemberRemoveFailed', 'Could not remove bottom from BOT bin'), 'error'),
  });
  const moveBotMemberMutation = useMutation({
    mutationFn: ({ batchId, partId, target_payload }: { batchId: number; partId: number; target_payload: string }) =>
      api.officeMoveBotBinMember(batchId, partId, target_payload),
    onSuccess: async (resp) => {
      setMoveTarget(null);
      setMovePayload('');
      await refresh();
      if (resp.result !== 'recorded') {
        showToast(botBinAssignErrorMessage(resp.result, t), 'error');
        return;
      }
      showToast(t('inventory.botBinMemberMoved', 'Bottom moved to another BOT bin'), 'success');
      if (resp.empty_bin_warning) {
        showToast(
          t('inventory.botBinEmptyWarning', 'Last bottom removed — mark the bin empty when it is off the line'),
          'warning',
        );
      }
    },
    onError: () => showToast(t('inventory.botBinMemberMoveFailed', 'Could not move bottom to another BOT bin'), 'error'),
  });
  const stageBotBinMutation = useMutation({
    mutationFn: ({ payload }: { payload: string; returning?: boolean }) => api.officeStageBotBin(payload),
    onSuccess: async (_data, variables) => {
      await refresh();
      showToast(
        variables.returning
          ? t('inventory.botBinReturnedToStaged', 'BOT bin returned to staged')
          : t('inventory.botBinStaged', 'BOT bin staged for production'),
        'success',
      );
    },
    onError: () => showToast(t('inventory.botBinStageFailed', 'Could not update BOT bin staging'), 'error'),
  });
  const clearBotBinMutation = useMutation({
    mutationFn: (payload: string) => api.officeClearBotBin(payload),
    onSuccess: async () => {
      setClearBotTarget(null);
      await refresh();
      showToast(t('inventory.botBinCleared', 'BOT bin cleared'), 'success');
    },
    onError: () => showToast(t('inventory.botBinClearFailed', 'Could not clear BOT bin'), 'error'),
  });
  const addBotMemberMutation = useMutation({
    mutationFn: ({ bin_payload, part_sticker }: { bin_payload: string; part_sticker: string }) =>
      api.addBotBinMember({ bin_payload, part_sticker }),
    onSuccess: async (resp, variables) => {
      if (resp.result === 'recorded') {
        setBotAssignStickers((current) => ({ ...current, [variables.bin_payload]: '' }));
        await refresh();
        showToast(t('inventory.botBinMemberAdded', 'Bottom added to BOT bin'), 'success');
        return;
      }
      showToast(botBinAssignErrorMessage(resp.result, t), 'error');
    },
    onError: () => showToast(t('inventory.botBinAssignFailed', 'Could not add bottom to BOT bin'), 'error'),
  });
  const partsQuery = useQuery({
    queryKey: ['floor-inventory-parts', false],
    queryFn: () => api.getFloorInventoryParts(false),
  });

  useEffect(() => {
    setRelinkPrinterId(relinkTarget?.batch?.printer_id ?? null);
    setRelinkArchiveId(null);
  }, [relinkTarget]);

  const bins = binsQuery.data ?? [];
  const knobBins = bins.filter((bin) => bin.part_code === 'KNB').sort((a, b) => a.bin_number - b.bin_number);
  const buttonBins = bins.filter((bin) => bin.part_code === 'BUT').sort((a, b) => a.bin_number - b.bin_number);
  const botBins = bins.filter((bin) => bin.part_code === 'BOT').sort((a, b) => a.bin_number - b.bin_number);
  const partsById = useMemo(() => {
    const map = new Map<number, FloorInventoryPart>();
    for (const part of partsQuery.data ?? []) {
      map.set(part.id, part);
    }
    return map;
  }, [partsQuery.data]);
  useEffect(() => {
    if (focusPayload && focusedRef.current && typeof focusedRef.current.scrollIntoView === 'function') {
      focusedRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [focusPayload, binsQuery.data]);
  const relinkCount = bins.filter((bin) => bin.status === 'unlinked').length;
  const activeCount = bins.filter((bin) => bin.batch !== null && bin.status !== 'unlinked').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-3 text-2xl font-bold text-white">
          <Package className="h-7 w-7 text-bambu-green" />
          {t('inventory.binsTitle', 'Part bins')}
        </h1>
        <p className="mt-1 max-w-3xl text-bambu-gray">
          {t(
            'inventory.binsSubtitle',
            'Manage the shared KNB, BUT, and BOT bins. KNB/BUT fills are assigned to a printer at Harvest; BOT bins collect QC-passed bottoms.',
          )}
        </p>
      </div>

      <div className="grid max-w-5xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Summary label={t('inventory.binsTotal', 'Total bins')} value={bins.length} />
        <Summary label={t('inventory.binsAssigned', 'Assigned')} value={activeCount} />
        <Summary label={t('inventory.binsAvailable', 'Available')} value={Math.max(0, bins.length - activeCount - relinkCount)} />
        <Summary label={t('inventory.binsNeedsRelink', 'Needs relinking')} value={relinkCount} />
      </div>

      <section className="overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary">
        <div className="border-b border-bambu-dark-tertiary px-4 py-3">
          <h2 className="font-semibold text-white">{t('inventory.binsManagementHeading', 'Shared reusable bins')}</h2>
          <p className="mt-0.5 text-xs text-bambu-gray">
            {t(
              'inventory.binsManagementHint',
              'Override a remaining count when needed, unlink a fill, or manually assign a free bin when Harvest did not recognize knobs or buttons.',
            )}
          </p>
        </div>
        {binsQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-bambu-gray">
            <Loader2 className="h-5 w-5 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : binsQuery.isError ? (
          <div className="px-4 py-16 text-center">
            <p className="font-medium text-white">{t('inventory.binsLoadError', 'Could not load bins')}</p>
            <Button className="mt-3" variant="secondary" onClick={() => binsQuery.refetch()}>
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 p-4 lg:grid-cols-3 md:grid-cols-2">
            <BinColumn
              title={t('inventory.binsKnobColumn', 'Knob bins')}
              bins={knobBins}
              drafts={drafts}
              setDrafts={setDrafts}
              assignPrinterIds={assignPrinterIds}
              setAssignPrinterIds={setAssignPrinterIds}
              assignQuantities={assignQuantities}
              setAssignQuantities={setAssignQuantities}
              relinkTarget={relinkTarget}
              relinkPrinterId={relinkPrinterId}
              setRelinkTarget={setRelinkTarget}
              setRelinkPrinterId={setRelinkPrinterId}
              setRelinkArchiveId={setRelinkArchiveId}
              relinkArchiveId={relinkArchiveId}
              printers={printersQuery.data ?? []}
              printersLoading={printersQuery.isLoading}
              candidates={candidatesQuery.data ?? []}
              candidatesLoading={candidatesQuery.isLoading}
              busy={
                overrideMutation.isPending
                || unlinkMutation.isPending
                || relinkMutation.isPending
                || assignMutation.isPending
              }
              focusPayload={focusPayload}
              focusedRef={focusedRef}
              onOverride={(payload, remaining_quantity) => overrideMutation.mutate({ payload, remaining_quantity })}
              onUnlink={setUnlinkTarget}
              onClear={setClearTarget}
              onAssign={(payload, printer_id, quantity) => assignMutation.mutate({ payload, printer_id, quantity })}
              onRelink={(batchId, archiveId) => relinkMutation.mutate({ batchId, archiveId })}
              assignPending={assignMutation.isPending}
              relinkPending={relinkMutation.isPending}
              t={t}
            />
            <BinColumn
              title={t('inventory.binsButtonColumn', 'Button bins')}
              bins={buttonBins}
              drafts={drafts}
              setDrafts={setDrafts}
              assignPrinterIds={assignPrinterIds}
              setAssignPrinterIds={setAssignPrinterIds}
              assignQuantities={assignQuantities}
              setAssignQuantities={setAssignQuantities}
              relinkTarget={relinkTarget}
              relinkPrinterId={relinkPrinterId}
              setRelinkTarget={setRelinkTarget}
              setRelinkPrinterId={setRelinkPrinterId}
              setRelinkArchiveId={setRelinkArchiveId}
              relinkArchiveId={relinkArchiveId}
              printers={printersQuery.data ?? []}
              printersLoading={printersQuery.isLoading}
              candidates={candidatesQuery.data ?? []}
              candidatesLoading={candidatesQuery.isLoading}
              busy={
                overrideMutation.isPending
                || unlinkMutation.isPending
                || relinkMutation.isPending
                || assignMutation.isPending
              }
              focusPayload={focusPayload}
              focusedRef={focusedRef}
              onOverride={(payload, remaining_quantity) => overrideMutation.mutate({ payload, remaining_quantity })}
              onUnlink={setUnlinkTarget}
              onClear={setClearTarget}
              onAssign={(payload, printer_id, quantity) => assignMutation.mutate({ payload, printer_id, quantity })}
              onRelink={(batchId, archiveId) => relinkMutation.mutate({ batchId, archiveId })}
              assignPending={assignMutation.isPending}
              relinkPending={relinkMutation.isPending}
              t={t}
            />
            <BotBinColumn
              title={t('inventory.binsBotColumn', 'Bot bins')}
              bins={botBins}
              partsById={partsById}
              allBotBins={botBins}
              focusPayload={focusPayload}
              focusedRef={focusedRef}
              busy={
                removeBotMemberMutation.isPending
                || moveBotMemberMutation.isPending
                || stageBotBinMutation.isPending
                || clearBotBinMutation.isPending
                || addBotMemberMutation.isPending
              }
              assignStickers={botAssignStickers}
              setAssignStickers={setBotAssignStickers}
              onAssign={(bin_payload, part_sticker) => addBotMemberMutation.mutate({ bin_payload, part_sticker })}
              assignPending={addBotMemberMutation.isPending}
              onRemove={(batchId, partId, sticker) => setRemoveTarget({ batchId, partId, sticker })}
              onMove={(batchId, partId, sticker) => {
                setMoveTarget({ batchId, partId, sticker });
                setMovePayload('');
              }}
              onStage={(payload, returning) => stageBotBinMutation.mutate({ payload, returning })}
              onClear={setClearBotTarget}
              stagePending={stageBotBinMutation.isPending}
              t={t}
            />
          </div>
        )}
      </section>

      {clearTarget && (
        <ConfirmModal
          title={t('inventory.binClearQuantityTitle', 'Clear remaining quantity?')}
          message={t('inventory.binClearQuantityMessage', 'This will set {{bin}} remaining quantity to 0 and release the bin for reuse. It will leave the active bin list, but the historical batch and audit events will not be deleted.', {
            bin: `${clearTarget.part_name} ${clearTarget.bin_number}`,
          })}
          confirmText={t('inventory.binClearQuantityConfirm', 'Clear quantity')}
          variant="warning"
          isLoading={overrideMutation.isPending}
          onCancel={() => setClearTarget(null)}
          onConfirm={() => overrideMutation.mutate({ payload: clearTarget.payload, remaining_quantity: 0 })}
        />
      )}

      {unlinkTarget && (
        <ConfirmModal
          title={t('inventory.binUnlinkTitle', 'Unlink bin assignment?')}
          message={t('inventory.binUnlinkMessage', 'This will release {{bin}} from {{printer}} and make it available for another harvest. The historical batch record will remain in the audit history.', {
            bin: `${unlinkTarget.part_name} ${unlinkTarget.bin_number}`,
            printer: unlinkTarget.batch?.printer_name ?? 'its printer',
          })}
          confirmText={t('inventory.binUnlinkConfirm', 'Unlink bin')}
          variant="danger"
          isLoading={unlinkMutation.isPending}
          onCancel={() => setUnlinkTarget(null)}
          onConfirm={() => {
            setRelinkTarget(unlinkTarget);
            unlinkMutation.mutate(unlinkTarget.payload);
          }}
        />
      )}

      {removeTarget && (
        <ConfirmModal
          title={t('inventory.botBinRemoveTitle', 'Remove bottom from BOT bin?')}
          message={t('inventory.botBinRemoveMessage', 'Remove {{sticker}} from this BOT bin fill?', {
            sticker: removeTarget.sticker,
          })}
          confirmText={t('inventory.botBinRemoveConfirm', 'Remove')}
          variant="danger"
          isLoading={removeBotMemberMutation.isPending}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => removeBotMemberMutation.mutate({
            batchId: removeTarget.batchId,
            partId: removeTarget.partId,
          })}
        />
      )}

      {moveTarget && (
        <ConfirmModal
          title={t('inventory.botBinMoveTitle', 'Move bottom to another BOT bin')}
          message={t('inventory.botBinMoveMessage', 'Move {{sticker}} to another BOT bin:', { sticker: moveTarget.sticker })}
          confirmText={t('inventory.botBinMoveConfirm', 'Move')}
          variant="warning"
          isLoading={moveBotMemberMutation.isPending}
          confirmDisabled={!movePayload.trim()}
          onCancel={() => {
            setMoveTarget(null);
            setMovePayload('');
          }}
          onConfirm={() => {
            if (!movePayload.trim()) return;
            moveBotMemberMutation.mutate({
              batchId: moveTarget.batchId,
              partId: moveTarget.partId,
              target_payload: movePayload.trim(),
            });
          }}
        >
          <select
            aria-label={t('inventory.botBinMoveTarget', 'Target BOT bin')}
            value={movePayload}
            onChange={(event) => setMovePayload(event.target.value)}
            className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-2 text-sm text-white focus:border-bambu-green focus:outline-none"
          >
            <option value="">{t('inventory.botBinChooseTarget', 'Choose a BOT bin')}</option>
            {botBins.map((bin) => (
              <option key={bin.payload} value={bin.payload}>{bin.part_name} {bin.bin_number}</option>
            ))}
          </select>
        </ConfirmModal>
      )}

      {clearBotTarget && (
        <ConfirmModal
          title={t('inventory.botBinClearTitle', 'Clear BOT bin?')}
          message={t(
            'inventory.botBinClearMessage',
            'Remove every bottom from {{bin}} and release it for reuse? The parts themselves are not discarded.',
            { bin: `${clearBotTarget.part_name} ${clearBotTarget.bin_number}` },
          )}
          confirmText={t('inventory.botBinClearConfirm', 'Clear bin')}
          variant="warning"
          isLoading={clearBotBinMutation.isPending}
          onCancel={() => setClearBotTarget(null)}
          onConfirm={() => clearBotBinMutation.mutate(clearBotTarget.payload)}
        />
      )}
    </div>
  );
}

type BinColumnProps = {
  title: string;
  bins: FloorBinManagement[];
  drafts: Record<string, string>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  assignPrinterIds: Record<string, number | null>;
  setAssignPrinterIds: Dispatch<SetStateAction<Record<string, number | null>>>;
  assignQuantities: Record<string, string>;
  setAssignQuantities: Dispatch<SetStateAction<Record<string, string>>>;
  relinkTarget: FloorBinManagement | null;
  relinkPrinterId: number | null;
  setRelinkTarget: (bin: FloorBinManagement | null) => void;
  setRelinkPrinterId: (id: number | null) => void;
  setRelinkArchiveId: (id: number | null) => void;
  relinkArchiveId: number | null;
  printers: FloorPrinter[];
  printersLoading: boolean;
  candidates: FloorBinJobCandidate[];
  candidatesLoading: boolean;
  busy: boolean;
  focusPayload: string | null;
  focusedRef: RefObject<HTMLElement | null>;
  onOverride: (payload: string, remaining_quantity: number) => void;
  onUnlink: (bin: FloorBinManagement) => void;
  onClear: (bin: FloorBinManagement) => void;
  onAssign: (payload: string, printer_id: number, quantity: number) => void;
  onRelink: (batchId: number, archiveId: number) => void;
  assignPending: boolean;
  relinkPending: boolean;
  t: ReturnType<typeof useTranslation>['t'];
};

function BinColumn({
  title,
  bins,
  drafts,
  setDrafts,
  assignPrinterIds,
  setAssignPrinterIds,
  assignQuantities,
  setAssignQuantities,
  relinkTarget,
  relinkPrinterId,
  setRelinkTarget,
  setRelinkPrinterId,
  setRelinkArchiveId,
  relinkArchiveId,
  printers,
  printersLoading,
  candidates,
  candidatesLoading,
  busy,
  focusPayload,
  focusedRef,
  onOverride,
  onUnlink,
  onClear,
  onAssign,
  onRelink,
  assignPending,
  relinkPending,
  t,
}: BinColumnProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-bambu-gray">{title}</h3>
      {bins.map((bin) => {
        const batch = bin.batch;
        const draft = drafts[bin.payload] ?? String(batch?.remaining_quantity ?? 0);
        const parsed = Number(draft);
        const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000;
        const assignPrinterId = assignPrinterIds[bin.payload] ?? null;
        const assignQtyDraft = assignQuantities[bin.payload] ?? '';
        const assignQty = Number(assignQtyDraft);
        const assignQtyValid = Number.isInteger(assignQty) && assignQty >= 1 && assignQty <= 100_000;
        const focused = focusPayload === bin.payload.toUpperCase();
        return (
          <article
            key={bin.payload}
            ref={focused ? focusedRef : undefined}
            aria-current={focused ? 'true' : undefined}
            className={binManagementCardClass(focused)}
          >
            <div className="flex shrink-0 items-start justify-between gap-3">
              <div>
                <h4 className="font-semibold text-white">{bin.part_name} {bin.bin_number}</h4>
                <p className="mt-1 font-mono text-xs text-bambu-gray">{bin.payload}</p>
              </div>
              <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium ${batch ? statusClass(bin.status) : 'bg-bambu-dark-tertiary text-bambu-gray'}`}>
                {batch ? statusLabel(bin.status) : t('inventory.binAvailable', 'Available')}
              </span>
            </div>

            {batch ? (
              <>
                <div className="mt-4 space-y-1 text-sm text-bambu-gray-light">
                  <p>
                    {bin.status === 'unlinked'
                      ? t('inventory.binUnlinkedDetails', 'Printer/job needs relinking')
                      : `${batch.printer_name ?? 'Printer'}${batch.print_name ? ` · ${batch.print_name}` : ''}`}
                  </p>
                  <p>{batch.remaining_quantity} {t('inventory.binRemaining', 'remaining')} / {batch.quantity} {t('inventory.binHarvested', 'harvested')}</p>
                </div>
                <div className="mt-4 flex items-end gap-2">
                  <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-xs text-bambu-gray">{t('inventory.binOverrideLabel', 'Remaining quantity')}</span>
                    <input
                      aria-label={`${bin.part_name} ${bin.bin_number} remaining quantity`}
                      type="number"
                      min={0}
                      max={100000}
                      step={1}
                      value={draft}
                      disabled={busy}
                      onChange={(event) => setDrafts((current) => ({ ...current, [bin.payload]: event.target.value }))}
                      className="w-full rounded border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-2 text-sm text-white focus:border-bambu-green focus:outline-none"
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!valid || busy}
                    onClick={() => onOverride(bin.payload, parsed)}
                  >
                    {t('inventory.binOverride', 'Override')}
                  </Button>
                </div>
                {bin.status === 'unlinked' ? (
                  <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                    <div className="flex gap-2">
                      <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                      <div>
                        <p className="font-medium text-amber-200">{t('inventory.binRelinkHeading', 'Link this bin to a completed job')}</p>
                        <p className="mt-1 text-xs text-amber-100/70">{t('inventory.binRelinkHint', 'Choose the printer, then select the completed print this fill came from.')}</p>
                      </div>
                    </div>
                    <div className="relative mt-3">
                      <select
                        aria-label={t('inventory.binRelinkPrinter', 'Printer')}
                        value={relinkTarget?.batch?.id === batch.id ? String(relinkPrinterId ?? '') : ''}
                        disabled={busy || printersLoading}
                        onChange={(event) => {
                          setRelinkTarget(bin);
                          setRelinkPrinterId(event.target.value ? Number(event.target.value) : null);
                          setRelinkArchiveId(null);
                        }}
                        className="w-full appearance-none rounded-lg border border-amber-500/30 bg-bambu-dark px-2 py-2 pr-10 text-sm text-white focus:border-bambu-green focus:outline-none"
                      >
                        <option value="">{printersLoading ? t('common.loading', 'Loading…') : t('inventory.binChoosePrinter', 'Choose a printer')}</option>
                        {printers.map((printer) => (
                          <option key={printer.id} value={printer.id}>{printer.name}</option>
                        ))}
                      </select>
                      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray" />
                    </div>
                    {relinkPrinterId !== null && relinkTarget?.batch?.id === batch.id && (
                      <div className="mt-2 flex gap-2">
                        <div className="relative min-w-0 flex-1">
                          <select
                            aria-label={t('inventory.binRelinkJob', 'Completed job')}
                            value={String(relinkArchiveId ?? '')}
                            disabled={busy || candidatesLoading}
                            onChange={(event) => setRelinkArchiveId(event.target.value ? Number(event.target.value) : null)}
                            className="w-full appearance-none rounded-lg border border-amber-500/30 bg-bambu-dark px-2 py-2 pr-10 text-sm text-white focus:border-bambu-green focus:outline-none"
                          >
                            <option value="">{candidatesLoading ? t('common.loading', 'Loading…') : t('inventory.binChooseJob', 'Choose a completed job')}</option>
                            {candidates.map((job) => (
                              <option key={job.id} value={job.id}>
                                {job.print_name}{job.completed_at ? ` · ${formatFloorDate(job.completed_at, { dateStyle: 'short', timeStyle: 'short' })}` : ''}
                              </option>
                            ))}
                          </select>
                          <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray" />
                        </div>
                        <Button
                          size="sm"
                          disabled={relinkArchiveId === null || busy}
                          onClick={() => onRelink(batch.id, relinkArchiveId!)}
                        >
                          {relinkPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                          {t('inventory.binRelink', 'Link')}
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => onClear(bin)}
                    >
                      <Eraser className="h-4 w-4" />
                      {t('inventory.binClearQuantity', 'Clear quantity')}
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => onUnlink(bin)}>
                      <Link2Off className="h-4 w-4" />
                      {t('inventory.binUnlink', 'Unlink')}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="mt-4 space-y-3">
                <p className="text-sm text-bambu-gray">
                  {t(
                    'inventory.binManualAssignHint',
                    'Assign manually when Harvest did not recognize knobs or buttons for a printer.',
                  )}
                </p>
                <div className="relative">
                  <select
                    aria-label={`${bin.part_name} ${bin.bin_number} printer`}
                    value={assignPrinterId !== null ? String(assignPrinterId) : ''}
                    disabled={busy || printersLoading}
                    onChange={(event) => {
                      setAssignPrinterIds((current) => ({
                        ...current,
                        [bin.payload]: event.target.value ? Number(event.target.value) : null,
                      }));
                    }}
                    className="w-full appearance-none rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-2 pr-10 text-sm text-white focus:border-bambu-green focus:outline-none"
                  >
                    <option value="">
                      {printersLoading
                        ? t('common.loading', 'Loading…')
                        : t('inventory.binChoosePrinter', 'Choose a printer')}
                    </option>
                    {printers.map((printer) => (
                      <option key={printer.id} value={printer.id}>{printer.name}</option>
                    ))}
                  </select>
                  <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray" />
                </div>
                <div className="flex items-end gap-2">
                  <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-xs text-bambu-gray">{t('inventory.binAssignQuantity', 'Quantity')}</span>
                    <input
                      aria-label={`${bin.part_name} ${bin.bin_number} quantity`}
                      type="number"
                      min={1}
                      max={100000}
                      step={1}
                      value={assignQtyDraft}
                      disabled={busy}
                      onChange={(event) => setAssignQuantities((current) => ({
                        ...current,
                        [bin.payload]: event.target.value,
                      }))}
                      className="w-full rounded border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-2 text-sm text-white focus:border-bambu-green focus:outline-none"
                    />
                  </label>
                  <Button
                    size="sm"
                    disabled={assignPrinterId === null || !assignQtyValid || busy}
                    onClick={() => onAssign(bin.payload, assignPrinterId!, assignQty)}
                  >
                    {assignPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {t('inventory.binAssign', 'Assign')}
                  </Button>
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function BotBinColumn({
  title,
  bins,
  partsById,
  focusPayload,
  focusedRef,
  busy,
  onRemove,
  onMove,
  onStage,
  onClear,
  onAssign,
  assignStickers,
  setAssignStickers,
  stagePending,
  assignPending,
  t,
}: {
  title: string;
  bins: FloorBinManagement[];
  partsById: Map<number, FloorInventoryPart>;
  allBotBins: FloorBinManagement[];
  focusPayload: string | null;
  focusedRef: RefObject<HTMLElement | null>;
  busy: boolean;
  onRemove: (batchId: number, partId: number, sticker: string) => void;
  onMove: (batchId: number, partId: number, sticker: string) => void;
  onStage: (payload: string, returning?: boolean) => void;
  onClear: (bin: FloorBinManagement) => void;
  onAssign: (bin_payload: string, part_sticker: string) => void;
  assignStickers: Record<string, string>;
  setAssignStickers: Dispatch<SetStateAction<Record<string, string>>>;
  stagePending: boolean;
  assignPending: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-bambu-gray">{title}</h3>
      {bins.map((bin) => (
        <BotBinCard
          key={bin.payload}
          bin={bin}
          partsById={partsById}
          focusPayload={focusPayload}
          focusedRef={focusedRef}
          busy={busy}
          onRemove={onRemove}
          onMove={onMove}
          onStage={onStage}
          onClear={onClear}
          onAssign={onAssign}
          assignSticker={assignStickers[bin.payload] ?? ''}
          setAssignSticker={(value) => setAssignStickers((current) => ({ ...current, [bin.payload]: value }))}
          stagePending={stagePending}
          assignPending={assignPending}
          t={t}
        />
      ))}
    </div>
  );
}

function BotBinAssignRow({
  bin,
  assignSticker,
  setAssignSticker,
  busy,
  assignPending,
  onAssign,
  t,
}: {
  bin: FloorBinManagement;
  assignSticker: string;
  setAssignSticker: (value: string) => void;
  busy: boolean;
  assignPending: boolean;
  onAssign: (bin_payload: string, part_sticker: string) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const trimmed = assignSticker.trim();
  return (
    <div className="flex shrink-0 items-end gap-2">
      <label className="min-w-0 flex-1">
        <span className="mb-1 block text-xs text-bambu-gray">
          {t('inventory.botBinAssignLabel', 'Bottom sticker')}
        </span>
        <input
          aria-label={`${bin.part_name} ${bin.bin_number} bottom sticker`}
          type="text"
          value={assignSticker}
          disabled={busy}
          placeholder="BBD-000001"
          onChange={(event) => setAssignSticker(event.target.value)}
          className="w-full rounded border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-2 font-mono text-sm text-white focus:border-bambu-green focus:outline-none"
        />
      </label>
      <Button
        size="sm"
        disabled={!trimmed || busy}
        onClick={() => onAssign(bin.payload, trimmed)}
      >
        {assignPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {t('inventory.botBinAssign', 'Add')}
      </Button>
    </div>
  );
}

function BotBinCard({
  bin,
  partsById,
  focusPayload,
  focusedRef,
  busy,
  onRemove,
  onMove,
  onStage,
  onClear,
  onAssign,
  assignSticker,
  setAssignSticker,
  stagePending,
  assignPending,
  t,
}: {
  bin: FloorBinManagement;
  partsById: Map<number, FloorInventoryPart>;
  focusPayload: string | null;
  focusedRef: RefObject<HTMLElement | null>;
  busy: boolean;
  onRemove: (batchId: number, partId: number, sticker: string) => void;
  onMove: (batchId: number, partId: number, sticker: string) => void;
  onStage: (payload: string, returning?: boolean) => void;
  onClear: (bin: FloorBinManagement) => void;
  onAssign: (bin_payload: string, part_sticker: string) => void;
  assignSticker: string;
  setAssignSticker: (value: string) => void;
  stagePending: boolean;
  assignPending: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const batch = bin.batch;
  const membersQuery = useQuery({
    queryKey: ['floor-bot-bin-members', batch?.id],
    queryFn: () => api.listBotBinMembers(batch!.id),
    enabled: batch != null,
  });
  const focused = focusPayload === bin.payload.toUpperCase();
  const memberCount = membersQuery.data?.length ?? batch?.remaining_quantity ?? 0;
  const canStage = bin.status === 'loaded' && memberCount > 0;
  const canReturnToStaged = bin.status === 'wip';
  const canAssign = bin.status !== 'wip' && memberCount < BOT_BIN_MAX_MEMBERS;

  return (
    <article
      ref={focused ? focusedRef : undefined}
      aria-current={focused ? 'true' : undefined}
      className={binManagementCardClass(focused, batch != null)}
    >
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-white">{bin.part_name} {bin.bin_number}</h4>
          <p className="mt-1 font-mono text-xs text-bambu-gray">{bin.payload}</p>
        </div>
        <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium ${batch ? statusClass(bin.status) : 'bg-bambu-dark-tertiary text-bambu-gray'}`}>
          {batch ? statusLabel(bin.status) : t('inventory.binAvailable', 'Available')}
        </span>
      </div>

      {batch ? (
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
          {canAssign && (
            <BotBinAssignRow
              bin={bin}
              assignSticker={assignSticker}
              setAssignSticker={setAssignSticker}
              busy={busy}
              assignPending={assignPending}
              onAssign={onAssign}
              t={t}
            />
          )}
          <p className="shrink-0 text-sm text-bambu-gray-light">
            {batch.remaining_quantity} {t('inventory.botBinMembers', 'bottoms loaded')}
          </p>
          {membersQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-bambu-gray">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading', 'Loading…')}
            </div>
          ) : membersQuery.isError ? (
            <p className="text-sm text-red-400">{t('inventory.botBinMembersLoadError', 'Could not load members')}</p>
          ) : (membersQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('inventory.botBinNoMembers', 'No bottoms loaded')}</p>
          ) : (
            <div className="-mr-1 min-h-0 flex-1 overflow-y-auto overscroll-y-contain pr-1">
              <ul className="space-y-2">
                {(membersQuery.data ?? []).map((member: FloorBotBinMember) => {
                  const part = partsById.get(member.part_id);
                  return (
                    <li
                      key={member.part_id}
                      className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-2 text-sm"
                    >
                      <p className="font-mono text-white">{member.sticker_code}</p>
                      <p className="mt-1 text-bambu-gray">
                        {part?.printer_name ?? t('inventory.botBinUnknownPrinter', 'Unknown printer')}
                        {part?.print_name ? ` · ${part.print_name}` : ''}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => onMove(batch.id, member.part_id, member.sticker_code)}
                        >
                          {t('inventory.botBinMoveMember', 'Move')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => onRemove(batch.id, member.part_id, member.sticker_code)}
                        >
                          {t('inventory.botBinRemoveMember', 'Remove')}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className="flex shrink-0 flex-wrap gap-2">
            {canStage && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onStage(bin.payload, false)}
              >
                {stagePending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {t('inventory.botBinStage', 'Stage for production')}
              </Button>
            )}
            {canReturnToStaged && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => onStage(bin.payload, true)}
              >
                {stagePending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeft className="h-4 w-4" />}
                {t('inventory.botBinReturnToStaged', 'Return to staged')}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onClear(bin)}
            >
              <Eraser className="h-4 w-4" />
              {t('inventory.botBinClear', 'Clear bin')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-bambu-gray">
            {t(
              'inventory.botBinEmptyHint',
              'Add a QC-passed bottom sticker here, or scan one on the floor then scan this bin.',
            )}
          </p>
          {canAssign && (
            <BotBinAssignRow
              bin={bin}
              assignSticker={assignSticker}
              setAssignSticker={setAssignSticker}
              busy={busy}
              assignPending={assignPending}
              onAssign={onAssign}
              t={t}
            />
          )}
        </div>
      )}
    </article>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-bambu-gray">{label}</div>
      <div className="mt-1 text-2xl font-bold text-white">{value}</div>
    </div>
  );
}
