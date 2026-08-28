import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Eraser,
  Hash,
  Link2,
  Link2Off,
  Loader2,
  Pencil,
  Search,
  Tag,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import { Button } from "../components/Button";
import { ConfirmModal } from "../components/ConfirmModal";
import { HorizontalScrollFade } from "../components/HorizontalScrollFade";
import {
  api,
  type FloorBinBatch,
  type FloorBinManagement,
  type FloorBinBatchEvent,
  type FloorInventoryPart,
  type FloorInventoryPartEvent,
  type FloorPrintFailureReason,
  type FloorStopReasonCode,
  type FloorPartCodeOption,
  type FloorPartJobCandidate,
  type JobSearchResult,
} from "../api/client";
import { useToast } from "../contexts/ToastContext";
import { formatFloorDate } from "../utils/floorScan";
import {
  buildPartTimeline,
  FLOOR_PASS_BADGE_CLASS,
  FLOOR_PASS_EVENT_DOT_CLASS,
  formatCustomStatus,
  isFloorPassBinStatus,
  isFloorPassPartAction,
  partEventDotClass,
  partEventLabel,
} from "../utils/floorPartHistory";
import { FloorBinManagementPage } from "./FloorBinManagementPage";

type PartFilter = "all" | "attention" | "linked" | "fulfilled" | "archived" | "failures";
const EMPTY_PARTS: FloorInventoryPart[] = [];
const NON_STATUS_EVENT_ACTIONS = new Set([
  "scanned",
  "archived",
  "restored",
  "part_code_assigned",
  "part_code_changed",
  "part_code_removed",
  // Sticker replacement is audit-only — keep the last workflow status.
  "sticker_replaced",
]);
const FAILURE_REASON_OPTIONS: Array<{ value: FloorStopReasonCode; label: string }> = [
  { value: "first_layer_issue", label: "First layer issue" },
  { value: "warping", label: "Warping" },
  { value: "layer_lines", label: "Layer lines" },
  { value: "filament_issue", label: "Filament issue" },
  { value: "other", label: "Other" },
];
const STATUS_SEARCH_SHORTCUTS = [
  { label: "Needs matching", query: "matching" },
  { label: "Initial QC Pass", query: "qc" },
  { label: "Fit Check Pass", query: "fit check" },
  { label: "Visual QC pass", query: "visual qc" },
  { label: "Reworks", query: "rework" },
  { label: "Support Removed", query: "support" },
  { label: "Overhang Removed", query: "overhang" },
  { label: "Hot Air Removed", query: "hot air" },
  { label: "Cleanup Pass", query: "cleanup" },
  { label: "Staged for Production", query: "staged" },
  { label: "WIP", query: "wip" },
  { label: "Shipped", query: "shipped" },
  { label: "Fulfilled", query: "fulfilled" },
  { label: "Failed", query: "failed" },
  { label: "Discarded", query: "discarded" },
];
const MANUAL_STATUS_OPTIONS = [
  { value: "needs_matching", label: "Needs matching" },
  { value: "linked", label: "Linked" },
  { value: "fit_checked", label: "Fit Check Pass" },
  { value: "rework", label: "Rework" },
  { value: "support_removed", label: "Support Removed" },
  { value: "overhang_removed", label: "Overhang Removed" },
  { value: "hot_air_removed", label: "Hot Air Removed" },
  { value: "cleanup", label: "Cleanup Pass" },
  { value: "ready_for_production", label: "Staged for Production" },
  { value: "wip", label: "In WIP" },
  { value: "shipped", label: "Shipped" },
  { value: "discarded", label: "Discarded" },
];
const NON_WORKFLOW_STATUS_ACTIONS = new Set([
  "enrolled",
  "relinked",
  "relinked_by_scan",
  "unlinked",
  "sticker_replaced",
]);
const DISCARDED_STATUS_CLASS =
  "border border-red-600 bg-red-100 text-red-800 shadow-sm shadow-red-500/20 dark:border-red-400/50 dark:bg-red-500/20 dark:text-red-300";
const STATUS_PILL_CLASS =
  "inline-flex max-w-full whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium";
const INVENTORY_TABLE_CLASS = "w-full text-left text-sm md:min-w-[680px]";
const INVENTORY_THEAD_CLASS =
  "hidden border-b border-bambu-dark-tertiary text-xs uppercase tracking-wide text-bambu-gray md:table-header-group";
const INVENTORY_ROW_CLASS = "block border-b border-bambu-dark-tertiary last:border-0 md:table-row";
const INVENTORY_CELL_CLASS = "block min-w-0 px-4 py-1.5 first:pt-3 last:pb-3 md:table-cell md:py-3";

type FloorInventoryTab = "parts" | "bins";

function FloorInventoryTabs({
  tab,
  onChange,
}: {
  tab: FloorInventoryTab;
  onChange: (tab: FloorInventoryTab) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex rounded-lg bg-bambu-dark-secondary p-1">
      <button
        type="button"
        onClick={() => onChange("parts")}
        className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${tab === "parts" ? "bg-bambu-green text-white" : "text-bambu-gray hover:text-white"}`}
      >
        {t("floor.partHistoryTab", "Part history")}
      </button>
      <button
        type="button"
        onClick={() => onChange("bins")}
        className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${tab === "bins" ? "bg-bambu-green text-white" : "text-bambu-gray hover:text-white"}`}
      >
        {t("floor.binsTab", "Bins")}
      </button>
    </div>
  );
}

function isDiscarded(
  part: FloorInventoryPart,
  latestEventAction = part.latest_event_action,
) {
  return latestEventAction === "discarded";
}
function isAttention(
  part: FloorInventoryPart,
  latestEventAction?: string | null,
) {
  return (
    !part.archived_at &&
    part.archive_id === null &&
    !isDiscarded(part, latestEventAction)
  );
}
function isLinked(
  part: FloorInventoryPart,
  latestEventAction?: string | null,
) {
  return (
    !part.archived_at &&
    part.archive_id !== null &&
    !isDiscarded(part, latestEventAction)
  );
}

function isFulfilledPart(
  part: FloorInventoryPart,
  latestEventAction?: string | null,
) {
  return !part.archived_at && latestEventAction === "shipped";
}

function isFulfilledBin(bin: FloorBinManagement) {
  return bin.batch?.status === "empty" || bin.batch?.status === "empty_override";
}

export function FloorInventoryPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const pageTab: FloorInventoryTab = searchParams.get("tab") === "bins" ? "bins" : "parts";
  const setPageTab = (tab: FloorInventoryTab) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (tab === "parts") next.delete("tab");
      else next.set("tab", "bins");
      return next;
    }, { replace: true });
  };
  const [filter, setFilter] = useState<PartFilter>("linked");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedBinId, setSelectedBinId] = useState<number | null>(null);
  const [selectedFailure, setSelectedFailure] = useState<FloorPrintFailureReason | null>(null);
  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (value.trim()) {
      setFilter("all");
    }
  };
  const filters: Array<{ id: PartFilter; label: string }> = [
    { id: "linked", label: t("floor.inventoryFilterLinked", "Registered Parts") },
    { id: "fulfilled", label: t("floor.inventoryFilterFulfilled", "Fulfilled") },
    { id: "failures", label: t("floor.printFailureLogTitle", "Print failure log") },
    { id: "attention", label: t("floor.inventoryFilterAttention", "Needs matching") },
    { id: "all", label: t("floor.inventoryFilterAll", "All parts") },
  ];
  const partsQuery = useQuery({
    queryKey: ["floor-inventory-parts"],
    queryFn: () => api.getFloorInventoryParts(true),
    enabled: pageTab === "parts",
    refetchOnMount: "always",
  });
  const binHistoryQuery = useQuery({
    queryKey: ["floor-bin-history"],
    queryFn: () => api.getFloorBinHistory(),
    enabled: pageTab === "parts",
    refetchOnMount: "always",
  });
  const failureReasonsQuery = useQuery({
    queryKey: ["floor-print-failure-reasons"],
    queryFn: () => api.getFloorPrintFailureReasons(12),
    enabled: pageTab === "parts",
    staleTime: 30_000,
  });
  const updateFailureMutation = useMutation({
    mutationFn: ({
      id,
      reason_code,
      reason_text,
    }: {
      id: number;
      reason_code: FloorStopReasonCode;
      reason_text: string | null;
    }) => api.updateFloorPrintFailureReason(id, { reason_code, reason_text }),
    onSuccess: async (updated) => {
      setSelectedId(null);
      setSelectedBinId(null);
      setSelectedFailure(updated);
      await queryClient.invalidateQueries({ queryKey: ["floor-print-failure-reasons"] });
      showToast(t("floor.printFailureLogUpdated", "Failure reason updated"), "success");
    },
  });
  const discardFailureMutation = useMutation({
    mutationFn: (id: number) => api.discardFloorPrintFailureReason(id),
    onSuccess: async () => {
      setSelectedFailure(null);
      setSelectedBinId(null);
      await queryClient.invalidateQueries({ queryKey: ["floor-print-failure-reasons"] });
      showToast(t("floor.printFailureLogDiscarded", "Failure reason discarded"), "success");
    },
  });
  const records = partsQuery.data ?? EMPTY_PARTS;
  const binRecords: FloorBinManagement[] | undefined = binHistoryQuery.data;
  const historyBins = useMemo(
    () => (binRecords ?? []).filter((bin) => bin.batch !== null),
    [binRecords],
  );
  const activeRecords = records.filter((part) => !part.archived_at);
  const historyQueries = useQueries({
    queries: activeRecords.map((part) => ({
        queryKey: ["floor-inventory-part-events", part.id],
        queryFn: () => api.getFloorInventoryPartEvents(part.id),
        staleTime: 60_000,
      })),
  });
  const latestEventActions = useMemo(
    () =>
      new Map(
        historyQueries.flatMap((query, index) => {
          const events = query.data;
          const latestEvent = [...(events ?? [])]
            .reverse()
            .find((event) => !NON_STATUS_EVENT_ACTIONS.has(event.action));
          const part = activeRecords[index];
          return latestEvent && part
            ? [[part.id, latestEvent.action] as const]
            : [];
        }),
      ),
    [activeRecords, historyQueries],
  );
  const selectedPart = records.find((part) => part.id === selectedId) ?? null;
  const selectedBin = historyBins.find((bin) => bin.batch?.id === selectedBinId) ?? null;
  const selectedBinEventsQuery = useQuery({
    queryKey: ["floor-bin-batch-events", selectedBinId],
    queryFn: () => api.getFloorBinBatchEvents(selectedBinId!),
    enabled: selectedBinId !== null,
  });
  const eventsQuery = useQuery({
    queryKey: ["floor-inventory-part-events", selectedId],
    queryFn: () => api.getFloorInventoryPartEvents(selectedId!),
    enabled: selectedId !== null,
  });
  useEffect(() => {
    const latestEventAction = [...(eventsQuery.data ?? [])]
      .reverse()
      .find((event) => !NON_STATUS_EVENT_ACTIONS.has(event.action))?.action;
    if (selectedId === null || !latestEventAction) {
      return;
    }
    queryClient.setQueryData<FloorInventoryPart[]>(
      ["floor-inventory-parts"],
      (current) =>
        current?.map((part) =>
          part.id === selectedId
            ? { ...part, latest_event_action: latestEventAction }
            : part,
        ),
    );
  }, [eventsQuery.data, queryClient, selectedId]);
  const candidatesQuery = useQuery({
    queryKey: [
      "floor-inventory-part-candidates",
      selectedId,
      selectedPart?.archive_id,
    ],
    queryFn: () => api.getFloorInventoryPartJobCandidates(selectedId!),
    enabled:
      selectedId !== null &&
      selectedPart?.archive_id === null &&
      !selectedPart.archived_at,
  });
  const partCodeOptionsQuery = useQuery({
    queryKey: ["floor-part-code-options"],
    queryFn: () => api.getFloorPartCodeOptions(),
    enabled:
      selectedId !== null &&
      !selectedPart?.archived_at,
    staleTime: 60_000,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["floor-inventory-parts"] });
  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: number; archived: boolean }) =>
      api.archiveFloorInventoryPart(id, archived),
    onSuccess: async () => {
      await refresh();
      queryClient.invalidateQueries({
        queryKey: ["floor-inventory-part-events", selectedId],
      });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteFloorInventoryPart(id),
    onSuccess: async (_, id) => {
      queryClient.setQueryData<FloorInventoryPart[]>(
        ["floor-inventory-parts"],
        (current) => current?.filter((part) => part.id !== id) ?? [],
      );
      queryClient.removeQueries({
        queryKey: ["floor-inventory-part-events", id],
      });
      queryClient.removeQueries({
        queryKey: ["floor-inventory-part-candidates", id],
      });
      setSelectedId(null);
      setSelectedBinId(null);
      showToast(
        t("floor.inventoryDeleteSuccess", "Part record permanently deleted"),
        "success",
      );
      await refresh();
    },
  });
  const relinkMutation = useMutation({
    mutationFn: ({
      partId,
      archiveId,
    }: {
      partId: number;
      archiveId: number;
    }) => api.relinkFloorInventoryPart(partId, archiveId),
    onSuccess: async (updatedPart) => {
      queryClient.setQueryData<FloorInventoryPart[]>(
        ["floor-inventory-parts"],
        (current) => {
          if (!current) return [updatedPart];
          const index = current.findIndex((part) => part.id === updatedPart.id);
          if (index === -1) return [updatedPart, ...current];
          const next = [...current];
          next[index] = updatedPart;
          return next;
        },
      );
      setFilter("linked");
      setSelectedBinId(null);
      setSelectedId(updatedPart.id);
      showToast(
        t(
          "floor.inventoryMatchSuccess",
          "{{code}} matched to {{job}}",
          {
            code: updatedPart.sticker_code,
            job:
              updatedPart.print_name ??
              t("floor.inventoryNoJobLinked", "No job linked"),
          },
        ),
        "success",
      );
      await refresh();
      queryClient.invalidateQueries({
        queryKey: ["floor-inventory-part-events", updatedPart.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["floor-inventory-part-candidates", updatedPart.id],
      });
    },
  });
  const unlinkMutation = useMutation({
    mutationFn: ({
      id,
      reasonCode,
      reasonText,
    }: {
      id: number;
      reasonCode: string;
      reasonText: string | null;
    }) => api.unlinkFloorInventoryPart(id, reasonCode, reasonText),
    onSuccess: async (updatedPart) => {
      queryClient.setQueryData<FloorInventoryPart[]>(
        ["floor-inventory-parts"],
        (current) => {
          if (!current) return [updatedPart];
          const index = current.findIndex((part) => part.id === updatedPart.id);
          if (index === -1) return [updatedPart, ...current];
          const next = [...current];
          next[index] = updatedPart;
          return next;
        },
      );
      setSelectedId(updatedPart.id);
      setSelectedBinId(null);
      showToast(
        t(
          "floor.inventoryUnlinkSuccess",
          "{{code}} unlinked from its job",
          { code: updatedPart.sticker_code },
        ),
        "success",
      );
      await refresh();
      queryClient.invalidateQueries({
        queryKey: ["floor-inventory-part-events", updatedPart.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["floor-inventory-part-candidates", updatedPart.id],
      });
    },
  });
  const replaceStickerMutation = useMutation({
    mutationFn: ({
      id,
      newStickerCode,
      reasonCode,
      reasonText,
    }: {
      id: number;
      newStickerCode: string;
      reasonCode: string;
      reasonText: string | null;
    }) =>
      api.replaceFloorInventoryPartSticker(
        id,
        newStickerCode,
        reasonCode,
        reasonText,
      ),
    onSuccess: async (updatedPart) => {
      queryClient.setQueryData<FloorInventoryPart[]>(
        ["floor-inventory-parts"],
        (current) => {
          if (!current) return [updatedPart];
          const index = current.findIndex((part) => part.id === updatedPart.id);
          if (index === -1) return [updatedPart, ...current];
          const next = [...current];
          next[index] = updatedPart;
          return next;
        },
      );
      setSelectedId(updatedPart.id);
      setSelectedBinId(null);
      showToast(
        t(
          "floor.inventoryReplaceStickerSuccess",
          "Sticker replaced with {{code}}",
          { code: updatedPart.sticker_code },
        ),
        "success",
      );
      await refresh();
      queryClient.invalidateQueries({
        queryKey: ["floor-inventory-part-events", updatedPart.id],
      });
    },
  });
  const setPartCodeMutation = useMutation({
    mutationFn: ({ id, code }: { id: number; code: string }) =>
      api.setFloorInventoryPartCode(id, code),
    onSuccess: async (updatedPart) => {
      queryClient.setQueryData<FloorInventoryPart[]>(
        ["floor-inventory-parts"],
        (current) => {
          if (!current) return [updatedPart];
          const index = current.findIndex((part) => part.id === updatedPart.id);
          if (index === -1) return [updatedPart, ...current];
          const next = [...current];
          next[index] = updatedPart;
          return next;
        },
      );
      showToast(
        t(
          "floor.inventorySetPartCodeSuccess",
          "Part code set to {{code}}",
          { code: updatedPart.part_code },
        ),
        "success",
      );
      await refresh();
      queryClient.invalidateQueries({
        queryKey: ["floor-inventory-part-events", updatedPart.id],
      });
    },
  });
  const clearPartCodeMutation = useMutation({
    mutationFn: (id: number) => api.clearFloorInventoryPartCode(id),
    onSuccess: async (updatedPart) => {
      queryClient.setQueryData<FloorInventoryPart[]>(
        ["floor-inventory-parts"],
        (current) => current?.map((part) => part.id === updatedPart.id ? updatedPart : part) ?? [updatedPart],
      );
      showToast(t("floor.inventoryRemovePartCodeSuccess", "Part code removed"), "success");
      await refresh();
      queryClient.invalidateQueries({ queryKey: ["floor-inventory-part-events", updatedPart.id] });
    },
  });
  const setStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.setFloorInventoryPartStatus(id, status),
    onSuccess: async (updatedPart) => {
      queryClient.setQueryData<FloorInventoryPart[]>(
        ["floor-inventory-parts"],
        (current) => current?.map((part) => part.id === updatedPart.id ? updatedPart : part) ?? [updatedPart],
      );
      showToast(t("floor.inventorySetStatusSuccess", "Part status updated"), "success");
      await refresh();
      queryClient.invalidateQueries({ queryKey: ["floor-inventory-part-events", updatedPart.id] });
    },
  });
  const counts = useMemo(
    () => ({
      active:
        records.filter((part) =>
          isLinked(part, latestEventActions.get(part.id)) &&
          !isFulfilledPart(part, latestEventActions.get(part.id)),
        ).length + historyBins.filter((bin) => bin.batch?.archive_id !== null && !isFulfilledBin(bin)).length,
      attention: records.filter((part) =>
        isAttention(part, latestEventActions.get(part.id)) &&
        !isFulfilledPart(part, latestEventActions.get(part.id)),
      ).length + historyBins.filter((bin) => bin.batch?.archive_id === null && !isFulfilledBin(bin)).length,
      archived: records.filter((part) => part.archived_at).length,
    }),
    [historyBins, latestEventActions, records],
  );
  const discardedParts = useMemo(
    () =>
      activeRecords.filter((part) =>
        isDiscarded(part, latestEventActions.get(part.id)),
      ),
    [activeRecords, latestEventActions],
  );
  const visibleParts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return records.filter((part) => {
      const included =
        filter === "all"
          ? !part.archived_at
          : filter === "attention"
            ? isAttention(part, latestEventActions.get(part.id)) &&
              !isFulfilledPart(part, latestEventActions.get(part.id))
            : filter === "linked"
              ? isLinked(part, latestEventActions.get(part.id)) &&
                !isFulfilledPart(part, latestEventActions.get(part.id))
              : filter === "fulfilled"
                ? isFulfilledPart(part, latestEventActions.get(part.id))
              : Boolean(part.archived_at);
      return (
        included &&
        (!term ||
          partSearchValues(part, latestEventActions.get(part.id)).some((value) =>
            value.includes(term),
          ))
      );
    });
  }, [filter, latestEventActions, records, search]);
  const visibleBins = useMemo(() => {
    const term = search.trim().toLowerCase();
    return historyBins.filter((bin) => {
      const batch = bin.batch;
      if (!batch) return false;
      const included =
        filter === "all"
          ? true
          : filter === "attention"
            ? batch.archive_id === null && !isFulfilledBin(bin)
            : filter === "linked"
              ? batch.archive_id !== null && !isFulfilledBin(bin)
              : filter === "fulfilled"
                ? isFulfilledBin(bin)
              : false;
      return (
        included &&
        (!term ||
          binSearchValues(bin).some((value) => value.includes(term)))
      );
    });
  }, [historyBins, filter, search]);
  const visibleFailureRecords = useMemo(() => {
    if (filter !== "all") return [];
    const term = search.trim().toLowerCase();
    return (failureReasonsQuery.data ?? []).filter((record) =>
      !term ||
      [
        record.part_code,
        record.print_name,
        record.printer_name,
        record.reason_text,
        "failed",
        "failure",
        printFailureReasonLabel(record.reason_code, record.reason_text, t),
      ]
        .some((value) => value?.toLowerCase().includes(term)),
    );
  }, [failureReasonsQuery.data, filter, search, t]);
  const visibleRecordCount =
    visibleParts.length + visibleBins.length + visibleFailureRecords.length;
  const displayedRecordCount = visibleRecordCount;
  const failureLogCount =
    (failureReasonsQuery.data?.length ?? 0) + discardedParts.length;
  const hiddenByFilter =
    !partsQuery.isLoading &&
    !partsQuery.isError &&
    !search.trim() &&
    records.length + historyBins.length + (failureReasonsQuery.data?.length ?? 0) > 0 &&
    visibleRecordCount === 0;
  const saveError =
    archiveMutation.isError ||
    relinkMutation.isError ||
    unlinkMutation.isError ||
    replaceStickerMutation.isError ||
    setPartCodeMutation.isError ||
    setStatusMutation.isError ||
    deleteMutation.isError
      ? t("floor.inventorySaveError", "Could not save that change.")
      : null;

  if (pageTab === "bins") {
    return (
      <div className="space-y-6 p-4 md:p-8">
        <FloorInventoryTabs tab={pageTab} onChange={setPageTab} />
        <FloorBinManagementPage />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      <FloorInventoryTabs tab={pageTab} onChange={setPageTab} />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-bambu-gray">
            {t("floor.landingEyebrow", "Production floor")}
          </p>
          <h1 className="mt-1 text-2xl font-bold text-white">
            {t("floor.inventoryTitle", "Part history")}
          </h1>
          <p className="mt-1 max-w-2xl break-words text-bambu-gray">
            {t(
              "floor.inventorySubtitle",
              "Trace each stickered part back to its harvest and completed job. Resolve only the records that could not be linked at harvest.",
            )}
          </p>
        </div>
        <div
          className="relative w-full lg:w-80"
          onBlur={(event) => {
            const nextTarget = event.relatedTarget as Node | null;
            if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
              setSearchFocused(false);
            }
          }}
        >
          <label className="relative block">
            <span className="sr-only">
              {t("floor.inventorySearchLabel", "Search part history")}
            </span>
            <Search
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray"
              aria-hidden="true"
            />
            <input
              className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-2.5 pl-9 pr-9 text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
              placeholder={t(
                "floor.inventorySearchPlaceholder",
                "Search sticker, job, printer, or status",
              )}
              value={search}
              onFocus={() => setSearchFocused(true)}
              onChange={(event) => handleSearchChange(event.target.value)}
            />
            {search && (
              <button
                type="button"
                aria-label={t("common.clearSearch", "Clear search")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-bambu-gray transition-colors hover:text-white focus:outline-none focus:ring-2 focus:ring-bambu-green"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSearchChange("")}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </label>
          {searchFocused && (
            <div className="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-xl shadow-black/30">
              <div className="border-b border-bambu-dark-tertiary px-3 py-2">
                <p className="text-xs font-semibold text-white">
                  {t("floor.inventorySearchSuggestions", "Suggested status filters")}
                </p>
                <p className="mt-0.5 text-xs text-bambu-gray">
                  {t("floor.inventorySearchSuggestionHint", "Search by status or choose a shortcut.")}
                </p>
              </div>
              <div className="max-h-80 overflow-y-auto p-1.5">
                {STATUS_SEARCH_SHORTCUTS.map((shortcut) => (
                  <button
                    key={shortcut.query}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      handleSearchChange(shortcut.query);
                      setSearchFocused(false);
                    }}
                    className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-bambu-gray-light transition-colors hover:bg-bambu-dark-tertiary hover:text-white"
                  >
                    <span>{shortcut.label}</span>
                    <span className="font-mono text-xs text-bambu-gray">{shortcut.query}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard
          label={t("floor.inventoryFilterAttention", "Needs matching")}
          count={counts.attention}
          accent="amber"
          onClick={() => setFilter("attention")}
        />
        <SummaryCard
          label={t("floor.inventoryActiveLinked", "Actively registered parts")}
          count={counts.active}
          accent="green"
          onClick={() => setFilter("linked")}
        />
        <SummaryCard
          label={t("floor.inventoryArchivedRecords", "Archived records")}
          count={counts.archived}
          accent="gray"
          onClick={() => setFilter("archived")}
        />
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
        <section className="min-w-0 overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary">
          <div className="flex flex-col gap-3 border-b border-bambu-dark-tertiary p-4 md:flex-row md:items-start">
            <HorizontalScrollFade className="w-full md:flex-1" fadeFromClassName="from-bambu-dark-secondary">
              <div className="inline-flex min-w-full flex-nowrap gap-1 rounded-lg bg-bambu-dark p-1 md:min-w-0">
                {filters.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setFilter(item.id)}
                    className={`shrink-0 whitespace-nowrap rounded-md px-3 py-2.5 text-sm transition-colors md:py-1.5 ${filter === item.id ? "bg-bambu-green text-white" : "text-bambu-gray hover:text-white"}`}
                  >
                    {item.label}
                    {item.id === "attention" && counts.attention > 0
                      ? ` (${counts.attention})`
                      : ""}
                  </button>
                ))}
              </div>
            </HorizontalScrollFade>
            <div className="flex shrink-0 items-center justify-between gap-2 md:flex-col md:items-end">
              <button
                type="button"
                onClick={() => setFilter("archived")}
                className={`whitespace-nowrap rounded-md border px-3 py-1.5 text-sm transition-colors ${filter === "archived" ? "border-bambu-green bg-bambu-green text-white" : "border-bambu-dark-tertiary bg-bambu-dark-tertiary text-white hover:border-bambu-gray hover:bg-bambu-dark hover:text-white"}`}
              >
                {t("floor.inventoryShowArchived", "Show archived")}
              </button>
              <p className="text-sm text-bambu-gray">
              {filter === "failures"
                ? failureLogCount === 1
                  ? t("floor.inventoryRecordCountOne", "{{count}} record", {
                      count: failureLogCount,
                    })
                  : t("floor.inventoryRecordCountMany", "{{count}} records", {
                      count: failureLogCount,
                    })
                : displayedRecordCount === 1
                ? t("floor.inventoryRecordCountOne", "{{count}} record", {
                    count: displayedRecordCount,
                  })
                : t("floor.inventoryRecordCountMany", "{{count}} records", {
                      count: displayedRecordCount,
                  })}
              </p>
            </div>
          </div>
          {filter === "failures" ? (
            <PrintFailureReasonLog
              records={failureReasonsQuery.data ?? []}
              discardedParts={discardedParts}
              loading={failureReasonsQuery.isLoading}
              t={t}
              selectedId={selectedId}
              selectedFailure={selectedFailure}
              onSelectFailure={(record) => {
                setSelectedId(null);
                setSelectedBinId(null);
                setSelectedFailure(record);
              }}
              onSelectPart={(part) => {
                setSelectedFailure(null);
                setSelectedBinId(null);
                setSelectedId(part.id);
              }}
            />
          ) : partsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-16 text-bambu-gray">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t("floor.inventoryLoading", "Loading part history…")}
            </div>
          ) : partsQuery.isError ? (
            <div className="px-4 py-16 text-center">
              <p className="font-medium text-white">
                {t("floor.inventoryLoadError", "Could not load part history")}
              </p>
              <Button
                className="mt-3"
                variant="secondary"
                onClick={() => partsQuery.refetch()}
              >
                {t("common.retry", "Retry")}
              </Button>
            </div>
              ) : visibleRecordCount === 0 ? (
            <div className="px-4 py-16 text-center text-bambu-gray">
              {filter === "fulfilled" ? (
                t("floor.inventoryEmptyFulfilled", "No fulfilled parts or depleted bins yet.")
              ) : hiddenByFilter ? (
                <div className="space-y-3">
                  <p>
                    {t(
                      "floor.inventoryHiddenByFilter",
                      "No records in this view, but part history has {{count}} saved.",
                        { count: records.length + historyBins.length },
                    )}
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {counts.active > 0 && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setFilter("linked")}
                      >
                        {t("floor.inventoryShowLinked", "Show linked parts")}
                      </Button>
                    )}
                    {counts.archived > 0 && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setFilter("archived")}
                      >
                        {t("floor.inventoryShowArchived", "Show archived")}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setFilter("all")}
                    >
                      {t("floor.inventoryShowAll", "Show all active")}
                    </Button>
                  </div>
                </div>
              ) : filter === "attention" ? (
                t(
                  "floor.inventoryEmptyAttention",
                  "Every active part is linked to a completed job.",
                )
              ) : filter === "linked" ? (
                t("floor.inventoryEmptyLinked", "No linked parts yet.")
              ) : search ? (
                t(
                  "floor.inventoryEmptySearch",
                  "No part records match that search.",
                )
              ) : (
                t("floor.inventoryEmpty", "No part records yet.")
              )}
            </div>
              ) : (
                <InventoryHistoryTable
                  parts={visibleParts}
                  bins={visibleBins}
                  failures={visibleFailureRecords}
                  latestEventActions={latestEventActions}
                  selectedId={selectedId}
                  selectedBinId={selectedBinId}
                  selectedFailure={selectedFailure}
                  onSelectPart={(part) => {
                    setSelectedFailure(null);
                    setSelectedBinId(null);
                    setSelectedId(part.id);
                  }}
                  onSelectBin={(bin) => {
                    setSelectedFailure(null);
                    setSelectedId(null);
                    setSelectedBinId(bin.batch?.id ?? null);
                  }}
                  onSelectFailure={(record) => {
                    setSelectedId(null);
                    setSelectedBinId(null);
                    setSelectedFailure(record);
                  }}
                  t={t}
                />
              )}
        </section>
        {selectedFailure ? (
          <PrintFailureDetail
            record={selectedFailure}
            updatePending={updateFailureMutation.isPending}
            discardPending={discardFailureMutation.isPending}
            onClose={() => setSelectedFailure(null)}
            onUpdate={(reasonCode, reasonText) =>
              updateFailureMutation.mutate({
                id: selectedFailure.id,
                reason_code: reasonCode,
                reason_text: reasonText,
              })
            }
            onDiscard={() => discardFailureMutation.mutate(selectedFailure.id)}
          />
        ) : selectedBin ? (
          <BinDetail
            bin={selectedBin}
            events={selectedBinEventsQuery.data ?? []}
            eventsLoading={selectedBinEventsQuery.isLoading}
            eventsLoadFailed={selectedBinEventsQuery.isError}
            onClose={() => setSelectedBinId(null)}
          />
        ) : (
        <PartDetail
          part={selectedPart}
          events={eventsQuery.data ?? []}
          eventsLoadFailed={eventsQuery.isError}
          candidates={candidatesQuery.data ?? []}
          candidatesLoading={candidatesQuery.isLoading}
          relinkPending={relinkMutation.isPending}
          archivePending={archiveMutation.isPending}
          unlinkPending={unlinkMutation.isPending}
          stickerPending={replaceStickerMutation.isPending}
          deletePending={deleteMutation.isPending}
          codeOptions={partCodeOptionsQuery.data ?? []}
          codeOptionsLoading={partCodeOptionsQuery.isLoading}
          setCodePending={setPartCodeMutation.isPending}
          clearCodePending={clearPartCodeMutation.isPending}
          statusPending={setStatusMutation.isPending}
          saveError={saveError}
          onClose={() => setSelectedId(null)}
          onRelink={(archiveId) =>
            selectedPart &&
            relinkMutation.mutate({ partId: selectedPart.id, archiveId })
          }
          onArchive={(archived) =>
            selectedPart &&
            archiveMutation.mutate({ id: selectedPart.id, archived })
          }
          onUnlink={(reasonCode, reasonText) =>
            selectedPart &&
            unlinkMutation.mutate({ id: selectedPart.id, reasonCode, reasonText })
          }
          onReplaceSticker={(newStickerCode, reasonCode, reasonText) =>
            selectedPart &&
            replaceStickerMutation.mutate({
              id: selectedPart.id,
              newStickerCode,
              reasonCode,
              reasonText,
            })
          }
          onSetPartCode={(code) =>
            selectedPart && setPartCodeMutation.mutate({ id: selectedPart.id, code })
          }
          onClearPartCode={() => selectedPart && clearPartCodeMutation.mutate(selectedPart.id)}
          onSetStatus={(status) =>
            selectedPart && setStatusMutation.mutate({ id: selectedPart.id, status })
          }
          onDelete={() => selectedPart && deleteMutation.mutate(selectedPart.id)}
        />
        )}
      </div>
    </div>
  );
}

function InventoryHistoryTable({
  parts,
  bins,
  failures,
  latestEventActions,
  selectedId,
  selectedBinId,
  selectedFailure,
  onSelectPart,
  onSelectBin,
  onSelectFailure,
  t,
}: {
  parts: FloorInventoryPart[];
  bins: FloorBinManagement[];
  failures: FloorPrintFailureReason[];
  latestEventActions: Map<number, string>;
  selectedId: number | null;
  selectedBinId: number | null;
  selectedFailure: FloorPrintFailureReason | null;
  onSelectPart: (part: FloorInventoryPart) => void;
  onSelectBin: (bin: FloorBinManagement) => void;
  onSelectFailure: (record: FloorPrintFailureReason) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className={INVENTORY_TABLE_CLASS}>
        <thead className={INVENTORY_THEAD_CLASS}>
          <tr>
            <th className="px-4 py-3 font-medium">
              {t("floor.inventoryColStickerOrBin", "Sticker / bin")}
            </th>
            <th className="whitespace-nowrap px-4 py-3 font-medium">
              {t("floor.inventoryColStatus", "Status")}
            </th>
            <th className="px-4 py-3 font-medium">
              {t("floor.inventoryColJob", "Job / part")}
            </th>
            <th className="px-4 py-3 font-medium">
              {t("floor.inventoryColPrinter", "Printer")}
            </th>
            <th className="px-4 py-3 font-medium">
              {t("floor.inventoryColLabeled", "Labeled")}
            </th>
          </tr>
        </thead>
        <tbody>
          {failures.map((record) => (
            <tr
              key={`failure-${record.id}`}
              tabIndex={0}
              onClick={() => onSelectFailure(record)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onSelectFailure(record);
              }}
              className={`cursor-pointer ${INVENTORY_ROW_CLASS} transition-colors hover:bg-bambu-dark-tertiary/60 focus:bg-bambu-dark-tertiary/60 focus:outline-none ${selectedFailure?.id === record.id ? "bg-red-100/50 dark:bg-red-500/10" : ""}`}
            >
              <td className={`${INVENTORY_CELL_CLASS} font-mono font-medium text-bambu-gray`}>—</td>
              <td className={`${INVENTORY_CELL_CLASS} md:whitespace-nowrap`}>
                <span className={`${STATUS_PILL_CLASS} ${DISCARDED_STATUS_CLASS}`}>
                  {t("floor.inventoryStatusFailed", "Failed")}
                </span>
              </td>
              <td className={`${INVENTORY_CELL_CLASS} break-words text-white`}>
                {record.part_code && (
                  <span className="mb-0.5 mr-2 block font-mono text-bambu-green-light md:mb-0 md:inline">{record.part_code}</span>
                )}
                {record.print_name ?? t("floor.inventoryNoJob", "No completed job")}
                <span className="ml-0 mt-0.5 block text-red-800 md:ml-2 md:mt-0 md:inline dark:text-red-300">
                  {printFailureReasonLabel(record.reason_code, record.reason_text, t)}
                </span>
              </td>
              <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray-light`}>
                {record.printer_name ?? t("floor.inventoryDeletedPrinter", "Deleted printer")}
              </td>
              <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray md:whitespace-nowrap`}>
                {formatFloorDate(record.stopped_at, { dateStyle: "medium", timeStyle: "short" })}
              </td>
            </tr>
          ))}
          {parts.map((part) => {
            const latestEventAction = latestEventActions.get(part.id) ?? part.latest_event_action ?? null;
            return (
              <tr
                key={part.id}
                tabIndex={0}
                onClick={() => onSelectPart(part)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onSelectPart(part);
                }}
                className={`cursor-pointer ${INVENTORY_ROW_CLASS} transition-colors hover:bg-bambu-dark-tertiary/60 focus:bg-bambu-dark-tertiary/60 focus:outline-none ${selectedId === part.id ? "bg-bambu-dark-tertiary/60" : ""}`}
              >
                <td className={`${INVENTORY_CELL_CLASS} break-all font-mono font-medium text-white`}>{part.sticker_code}</td>
                <td className={`${INVENTORY_CELL_CLASS} md:whitespace-nowrap`}>
                  <span className={`${STATUS_PILL_CLASS} ${statusClass(part, latestEventAction)}`}>
                    {statusLabel(part, t, latestEventAction)}
                  </span>
                </td>
                <td className={`${INVENTORY_CELL_CLASS} break-words text-white`}>
                  {part.part_code && <span className="mb-0.5 mr-2 block font-mono text-bambu-green-light md:mb-0 md:inline">{part.part_code}</span>}
                  {part.print_name ?? (
                    <span className="text-bambu-gray">{t("floor.inventoryNoJob", "No completed job")}</span>
                  )}
                </td>
                <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray-light`}>
                  {part.printer_name ?? t("floor.inventoryDeletedPrinter", "Deleted printer")}
                </td>
                <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray md:whitespace-nowrap`}>
                  {formatFloorDate(part.labeled_at, { dateStyle: "medium", timeStyle: "short" })}
                </td>
              </tr>
            );
          })}
          {bins.map((bin) => {
            const batch = bin.batch;
            if (!batch) return null;
            return (
              <tr
                key={`bin-${batch.id}`}
                tabIndex={0}
                onClick={() => onSelectBin(bin)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onSelectBin(bin);
                }}
                className={`cursor-pointer ${INVENTORY_ROW_CLASS} transition-colors hover:bg-bambu-dark-tertiary/60 focus:bg-bambu-dark-tertiary/60 focus:outline-none ${selectedBinId === batch.id ? "bg-bambu-dark-tertiary/60" : ""}`}
              >
                <td className={`${INVENTORY_CELL_CLASS} break-all font-mono font-medium text-white`}>{bin.payload}</td>
                <td className={`${INVENTORY_CELL_CLASS} md:whitespace-nowrap`}>
                  <span className={`${STATUS_PILL_CLASS} ${binStatusClass(batch.status)}`}>
                    {binStatusLabel(batch.status, t)}
                  </span>
                </td>
                <td className={`${INVENTORY_CELL_CLASS} break-words text-white`}>
                  <span className="mb-0.5 mr-2 block font-mono text-bambu-green-light md:mb-0 md:inline">{bin.part_code}</span>
                  {batch.print_name ?? (
                    <span className="text-bambu-gray">{t("floor.inventoryNoJob", "No completed job")}</span>
                  )}
                  <span className="ml-0 mt-0.5 block text-bambu-gray md:ml-2 md:mt-0 md:inline">({batch.remaining_quantity}/{batch.quantity})</span>
                </td>
                <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray-light`}>
                  {batch.printer_name ?? t("floor.inventoryDeletedPrinter", "Deleted printer")}
                </td>
                <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray md:whitespace-nowrap`}>
                  {formatFloorDate(batch.harvested_at, { dateStyle: "medium", timeStyle: "short" })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PrintFailureDetail({
  record,
  updatePending,
  discardPending,
  onClose,
  onUpdate,
  onDiscard,
}: {
  record: FloorPrintFailureReason;
  updatePending: boolean;
  discardPending: boolean;
  onClose: () => void;
  onUpdate: (reasonCode: FloorStopReasonCode, reasonText: string | null) => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [reasonCode, setReasonCode] = useState<FloorStopReasonCode>(record.reason_code);
  const [reasonText, setReasonText] = useState(record.reason_text ?? "");
  const [discardOpen, setDiscardOpen] = useState(false);

  useEffect(() => {
    setEditing(false);
    setReasonCode(record.reason_code);
    setReasonText(record.reason_text ?? "");
    setDiscardOpen(false);
  }, [record.id, record.reason_code, record.reason_text]);

  const reasonLabel = printFailureReasonLabel(record.reason_code, record.reason_text, t);
  const canSave = reasonCode !== "other" || reasonText.trim().length > 0;

  return (
    <aside
      className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary xl:sticky xl:top-6 xl:flex xl:max-h-[calc(100vh-3rem)] xl:flex-col xl:overflow-hidden"
      aria-label={t("floor.printFailureDetailLabel", "Print failure detail")}
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-bambu-dark-tertiary p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-red-600 dark:text-red-400">
            {t("floor.printFailureDetailEyebrow", "Print failure")}
          </p>
          <h2 className="mt-1 font-mono text-lg font-semibold text-white">
            {record.part_code ?? t("floor.stoppedPrintPartCodeUnknown", "Part code unavailable")}
          </h2>
        </div>
        <button
          type="button"
          className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
          onClick={onClose}
          aria-label={t("floor.printFailureDetailClose", "Close failure detail")}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <span className={`${STATUS_PILL_CLASS} ${DISCARDED_STATUS_CLASS}`}>
            {t("floor.inventoryStatusFailed", "Failed")}
          </span>
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
          <div className="col-span-2">
            <dt className="text-bambu-gray">{t("floor.inventoryCompletedJob", "Job")}</dt>
            <dd className="mt-0.5 text-white">
              {record.print_name ?? t("floor.inventoryNoJobLinked", "No job linked")}
            </dd>
          </div>
          <div>
            <dt className="text-bambu-gray">{t("floor.inventoryColPrinter", "Printer")}</dt>
            <dd className="mt-0.5 text-white">
              {record.printer_name ?? t("floor.inventoryDeletedPrinter", "Deleted printer")}
            </dd>
          </div>
          <div>
            <dt className="text-bambu-gray">{t("floor.printFailureStoppedAt", "Stopped")}</dt>
            <dd className="mt-0.5 text-white">
              {formatFloorDate(record.stopped_at, { dateStyle: "medium", timeStyle: "short" })}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-bambu-gray">{t("floor.printFailureReason", "Failure reason")}</dt>
            {!editing ? (
              <dd className="mt-1 text-red-800 dark:text-red-300">{reasonLabel}</dd>
            ) : (
              <dd className="mt-2 space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  {FAILURE_REASON_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={reasonCode === option.value}
                      onClick={() => setReasonCode(option.value)}
                      className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                        reasonCode === option.value
                          ? "border-red-600 bg-red-100 text-red-800 dark:border-red-400/50 dark:bg-red-500/15 dark:text-red-300"
                          : "border-bambu-dark-tertiary bg-bambu-dark text-bambu-gray-light hover:border-red-600 hover:text-red-800 dark:hover:border-red-400/60 dark:hover:text-white"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {reasonCode === "other" && (
                  <textarea
                    value={reasonText}
                    onChange={(event) => setReasonText(event.target.value)}
                    rows={3}
                    maxLength={500}
                    autoFocus
                    placeholder={t("floor.failureReasonOtherPlaceholder", "Describe why the print failed…")}
                    className="w-full resize-y rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white placeholder:text-bambu-gray focus:border-red-400 focus:outline-none"
                  />
                )}
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
                    {t("common.cancel", "Cancel")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!canSave || updatePending}
                    onClick={() => onUpdate(reasonCode, reasonCode === "other" ? reasonText.trim() : null)}
                  >
                    {updatePending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t("common.save", "Save")}
                  </Button>
                </div>
              </dd>
            )}
          </div>
        </dl>
      </div>
      <div className="shrink-0 border-t border-bambu-dark-tertiary p-4">
        {!editing && !discardOpen && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {t("floor.printFailureEditReason", "Edit reason")}
            </Button>
            <Button size="sm" variant="danger" onClick={() => setDiscardOpen(true)}>
              {t("floor.printFailureDiscardReason", "Discard reason")}
            </Button>
          </div>
        )}
        {discardOpen && (
          <div className="space-y-3">
            <p className="text-sm text-white">
              {t("floor.printFailureDiscardConfirm", "Discard this failure reason? This removes it from Part history.")}
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setDiscardOpen(false)}>
                {t("common.cancel", "Cancel")}
              </Button>
              <Button size="sm" variant="danger" disabled={discardPending} onClick={onDiscard}>
                {discardPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("floor.printFailureConfirmDiscard", "Discard reason")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function PrintFailureReasonLog({
  records,
  discardedParts,
  loading,
  t,
  selectedId,
  selectedFailure,
  onSelectFailure,
  onSelectPart,
}: {
  records: FloorPrintFailureReason[];
  discardedParts: FloorInventoryPart[];
  loading: boolean;
  t: ReturnType<typeof useTranslation>["t"];
  selectedId: number | null;
  selectedFailure: FloorPrintFailureReason | null;
  onSelectFailure: (record: FloorPrintFailureReason) => void;
  onSelectPart: (part: FloorInventoryPart) => void;
}) {
  const entries = [
    ...records.map((record) => ({ type: "failure" as const, record })),
    ...discardedParts.map((part) => ({ type: "discarded" as const, part })),
  ].sort((left, right) => {
    const leftDate = left.type === "failure" ? left.record.stopped_at : left.part.labeled_at;
    const rightDate = right.type === "failure" ? right.record.stopped_at : right.part.labeled_at;
    return new Date(rightDate).getTime() - new Date(leftDate).getTime();
  });

  return (
    <div className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-bambu-dark-tertiary px-4 py-3">
        <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden="true" />
        <div>
          <h2 className="text-sm font-semibold text-white">
            {t("floor.printFailureLogTitle", "Print failure log")}
          </h2>
          <p className="text-xs text-bambu-gray">
            {t("floor.printFailureLogDescription", "Stopped, failed, and discarded prints recorded from the floor.")}
          </p>
        </div>
      </div>
      {loading ? (
        <div className="px-4 py-4 text-sm text-bambu-gray">
          {t("floor.printFailureLogLoading", "Loading failure log…")}
        </div>
      ) : entries.length === 0 ? (
        <div className="px-4 py-4 text-sm text-bambu-gray">
          {t("floor.printFailureLogEmpty", "No print failure reasons logged yet.")}
        </div>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <table className={INVENTORY_TABLE_CLASS}>
            <thead className={INVENTORY_THEAD_CLASS}>
              <tr>
                <th className="px-4 py-3 font-medium">
                  {t("floor.inventoryColSticker", "Sticker")}
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium">
                  {t("floor.inventoryColStatus", "Status")}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t("floor.inventoryColJob", "Job / part")}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t("floor.inventoryColPrinter", "Printer")}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t("floor.inventoryColLabeled", "Labeled")}
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const isFailure = entry.type === "failure";
                const selected = isFailure
                  ? selectedFailure?.id === entry.record.id
                  : selectedId === entry.part.id;
                const select = () => {
                  if (entry.type === "failure") onSelectFailure(entry.record);
                  else onSelectPart(entry.part);
                };
                return (
                  <tr
                    key={`${entry.type}-${isFailure ? entry.record.id : entry.part.id}`}
                    tabIndex={0}
                    onClick={select}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        select();
                      }
                    }}
                    className={`cursor-pointer ${INVENTORY_ROW_CLASS} transition-colors hover:bg-bambu-dark-tertiary/60 focus:bg-bambu-dark-tertiary/60 focus:outline-none ${selected ? isFailure ? "bg-red-100/50 dark:bg-red-500/10" : "bg-bambu-dark-tertiary/60" : ""}`}
                  >
                    <td className={`${INVENTORY_CELL_CLASS} break-all font-mono font-medium ${isFailure ? "text-bambu-gray" : "text-white"}`}>
                      {isFailure ? "—" : entry.part.sticker_code}
                    </td>
                    <td className={`${INVENTORY_CELL_CLASS} md:whitespace-nowrap`}>
                      <span className={`${STATUS_PILL_CLASS} ${isFailure ? DISCARDED_STATUS_CLASS : statusClass(entry.part, "discarded")}`}>
                        {isFailure
                          ? t("floor.inventoryStatusFailed", "Failed")
                          : statusLabel(entry.part, t, "discarded")}
                      </span>
                    </td>
                    <td className={`${INVENTORY_CELL_CLASS} break-words text-white`}>
                      {isFailure ? (
                        <>
                          {entry.record.part_code && (
                            <span className="mb-0.5 mr-2 block font-mono text-bambu-green-light md:mb-0 md:inline">
                              {entry.record.part_code}
                            </span>
                          )}
                          {entry.record.print_name ?? t("floor.inventoryNoJob", "No completed job")}
                          <span className="ml-0 mt-0.5 block text-red-800 md:ml-2 md:mt-0 md:inline dark:text-red-300">
                            {printFailureReasonLabel(entry.record.reason_code, entry.record.reason_text, t)}
                          </span>
                        </>
                      ) : (
                        <>
                          {entry.part.part_code && (
                            <span className="mb-0.5 mr-2 block font-mono text-bambu-green-light md:mb-0 md:inline">
                              {entry.part.part_code}
                            </span>
                          )}
                          {entry.part.print_name ?? (
                            <span className="text-bambu-gray">
                              {t("floor.inventoryNoJob", "No completed job")}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray-light`}>
                      {(isFailure ? entry.record.printer_name : entry.part.printer_name) ??
                        t("floor.inventoryDeletedPrinter", "Deleted printer")}
                    </td>
                    <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray md:whitespace-nowrap`}>
                      {formatFloorDate(isFailure ? entry.record.stopped_at : entry.part.labeled_at, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function printFailureReasonLabel(
  reasonCode: FloorPrintFailureReason["reason_code"],
  reasonText: string | null,
  t: ReturnType<typeof useTranslation>["t"],
) {
  if (reasonCode === "other") return reasonText || t("floor.stopReasonOther", "Other");
  const labels: Record<Exclude<FloorPrintFailureReason["reason_code"], "other">, string> = {
    first_layer_issue: "First layer issue",
    warping: "Warping",
    layer_lines: "Layer lines",
    filament_issue: "Filament issue",
  };
  return labels[reasonCode];
}

function partSearchValues(part: FloorInventoryPart, latestEventAction: string | null | undefined) {
  const statusTerms = part.archived_at
    ? ["archived"]
    : ["registered", "registered parts", "linked", "linked parts", "active"];
  const action = latestEventAction ?? part.latest_event_action ?? null;
  const actionTerms = partStatusSearchTerms(part.part_code, action, part.archive_id);
  return [
    part.sticker_code,
    part.part_code,
    part.print_name,
    part.printer_name,
    ...statusTerms,
    ...actionTerms,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
}

function partStatusSearchTerms(
  partCode: string | null | undefined,
  action: string | null,
  archiveId: number | null,
) {
  if (action === "fit_check" || action === "fit_checked") {
    return partCode === "BUT" || partCode === "KNB"
      ? ["visual", "visual qc", "visual qc pass", "initial qc pass", "qc"]
      : ["fit", "fit check", "fit checks", "fit check pass", "initial qc pass", "qc"];
  }
  if (action === "rework" || action === "sanding") return ["rework", "reworks", "sanding"];
  if (action === "wip" || action === "in_wip") return ["wip", "in wip", "in_wip"];
  if (action === "ready_for_production") {
    return ["staged", "staged for production", "ready for production", "ready_for_production"];
  }
  if (action === "shipped") return ["shipped", "shipping", "fulfilled"];
  if (action === "discarded") return ["discarded", "discard"];
  if (action === "cleanup" || action === "cleaned_up") return ["cleanup", "cleanup pass"];
  if (action === "support_removed") return ["support", "support removed", "support removal"];
  if (action === "overhang_removed") return ["overhang", "overhang removed", "overhang removal"];
  if (action === "hot_air_removed") return ["hot air", "hot air removed", "hot air removal"];
  if (action === "needs_matching") return ["needs matching", "matching", "attention", "unmatched"];
  if (action) return [action, formatCustomStatus(action)];
  return archiveId === null ? ["needs matching", "matching", "attention", "unmatched"] : [];
}

function binSearchValues(bin: FloorBinManagement) {
  const batch = bin.batch;
  if (!batch) return [];
  const statusTerms =
    batch.status === "visual_qc_passed"
      ? ["visual", "visual qc", "visual qc pass", "initial qc pass", "qc"]
      : batch.status === "ready_for_production"
        ? ["staged", "staged for production", "ready for production", "ready_for_production"]
        : batch.status === "wip"
          ? ["wip", "in wip"]
          : [];
  return [
    bin.payload,
    bin.part_code,
    bin.part_name,
    batch.print_name,
    batch.printer_name,
    batch.status,
    "fulfilled",
    "depleted",
    "manually cleared",
    "bin",
    "button",
    "knob",
    ...statusTerms,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
}

function statusLabel(
  part: FloorInventoryPart,
  t: ReturnType<typeof useTranslation>["t"],
  latestEventAction = part.latest_event_action ?? null,
) {
  if (part.archived_at) return t("floor.inventoryStatusArchived", "Archived");
  if (latestEventAction === "fit_check" || latestEventAction === "fit_checked") {
    return part.part_code === "BUT" || part.part_code === "KNB"
      ? t("floor.inventoryStatusVisualQcPass", "Visual QC pass")
      : t("floor.inventoryStatusFitCheckPass", "Fit Check Pass");
  }
  if (latestEventAction === "rework" || latestEventAction === "sanding") {
    return t("floor.inventoryStatusRework", "Rework");
  }
  if (latestEventAction === "discarded") return t("floor.inventoryStatusDiscarded", "Discarded");
  if (latestEventAction === "cleanup" || latestEventAction === "cleaned_up") {
    return t("floor.inventoryStatusCleanupPass", "Cleanup Pass");
  }
  if (latestEventAction === "wip" || latestEventAction === "in_wip") {
    return t("floor.inventoryStatusWip", "In WIP");
  }
  if (latestEventAction === "ready_for_production") {
    return t("floor.inventoryStatusStagedForProduction", "Staged for Production");
  }
  if (latestEventAction === "shipped") return t("floor.inventoryStatusShipped", "Shipped");
  if (latestEventAction === "linked") return t("floor.inventoryStatusLinked", "Linked");
  if (latestEventAction === "needs_matching") {
    return t("floor.inventoryFilterAttention", "Needs matching");
  }
  if (latestEventAction && !NON_WORKFLOW_STATUS_ACTIONS.has(latestEventAction)) {
    return formatCustomStatus(latestEventAction);
  }
  return part.archive_id === null
    ? t("floor.inventoryFilterAttention", "Needs matching")
    : t("floor.inventoryStatusLinked", "Linked");
}

function manualStatusValue(part: FloorInventoryPart, latestEventAction: string | null) {
  const aliases: Record<string, string> = {
    fit_check: "fit_checked",
    sanding: "rework",
    cleaned_up: "cleanup",
    in_wip: "wip",
  };
  const candidate = latestEventAction ? aliases[latestEventAction] ?? latestEventAction : null;
  return candidate && MANUAL_STATUS_OPTIONS.some((option) => option.value === candidate)
    ? candidate
    : part.archive_id === null
      ? "needs_matching"
      : "linked";
}

function statusClass(
  part: FloorInventoryPart,
  latestEventAction = part.latest_event_action ?? null,
) {
  if (part.archived_at) return "bg-bambu-dark-tertiary text-bambu-gray-light";
  if (isFloorPassPartAction(latestEventAction ?? "")) {
    return FLOOR_PASS_BADGE_CLASS;
  }
  if (latestEventAction === "rework" || latestEventAction === "sanding") {
    return "border border-orange-600 bg-orange-100 text-orange-800 shadow-sm shadow-orange-500/20 dark:border-orange-400/50 dark:bg-orange-500/20 dark:text-orange-300";
  }
  if (latestEventAction === "discarded") return DISCARDED_STATUS_CLASS;
  if (latestEventAction === "cleanup" || latestEventAction === "cleaned_up") {
    return "border border-emerald-600 bg-emerald-100 text-emerald-800 shadow-sm shadow-emerald-500/20 dark:border-emerald-400/50 dark:bg-emerald-500/20 dark:text-emerald-300";
  }
  if (latestEventAction === "wip" || latestEventAction === "in_wip") {
    return "border border-amber-600 bg-amber-100 text-amber-800 shadow-sm shadow-amber-500/20 dark:border-amber-400/50 dark:bg-amber-500/20 dark:text-amber-300";
  }
  if (latestEventAction === "shipped") {
    return "border border-sky-600 bg-sky-100 text-sky-800 shadow-sm shadow-sky-500/20 dark:border-sky-400/50 dark:bg-sky-500/20 dark:text-sky-300";
  }
  if (latestEventAction === "needs_matching") {
    return "border border-amber-600 bg-amber-100 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/15 dark:text-amber-300";
  }
  return part.archive_id === null && !latestEventAction
    ? "border border-amber-600 bg-amber-100 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/15 dark:text-amber-300"
    : "border border-cyan-600 bg-cyan-100 text-cyan-800 dark:border-bambu-green/25 dark:bg-bambu-green/15 dark:text-bambu-green-light";
}

function binStatusClass(status: string) {
  if (status === "wip") {
    return "border border-amber-600 bg-amber-100 text-amber-800 shadow-sm shadow-amber-500/20 dark:border-amber-400/50 dark:bg-amber-500/20 dark:text-amber-300";
  }
  if (isFloorPassBinStatus(status)) {
    return FLOOR_PASS_BADGE_CLASS;
  }
  return "border border-cyan-600 bg-cyan-100 text-cyan-800 dark:border-bambu-green/25 dark:bg-bambu-green/15 dark:text-bambu-green-light";
}

function binStatusLabel(
  status: string,
  t: ReturnType<typeof useTranslation>["t"],
) {
  switch (status) {
    case "visual_qc_passed":
      return t("floor.inventoryBinVisualQcPassed", "Visual QC pass");
    case "wip":
      return t("floor.inventoryBinWip", "In WIP");
    case "ready_for_production":
      return t("floor.inventoryBinStagedForProduction", "Staged for Production");
    case "empty_override":
      return t("floor.inventoryBinDepletedManual", "Depleted (manually cleared)");
    case "empty":
      return t("floor.inventoryBinDepleted", "Depleted");
    case "unlinked":
      return t("floor.inventoryBinUnlinked", "Released (unlinked)");
    default:
      return t("floor.inventoryBinAwaitingQc", "Awaiting visual QC");
  }
}

function SummaryCard({
  label,
  count,
  accent,
  onClick,
}: {
  label: string;
  count: number;
  accent: "amber" | "green" | "gray";
  onClick: () => void;
}) {
  const colors = {
    amber: "border-amber-500/30 hover:border-amber-400/60",
    green: "border-bambu-green/30 hover:border-bambu-green/60",
    gray: "border-bambu-dark-tertiary hover:border-bambu-gray",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border bg-bambu-dark-secondary p-4 text-left transition-colors ${colors[accent]}`}
    >
      <div className="text-2xl font-semibold text-white">{count}</div>
      <div className="mt-1 text-sm text-bambu-gray-light">{label}</div>
    </button>
  );
}

function BinDetail({
  bin,
  events,
  eventsLoading,
  eventsLoadFailed,
  onClose,
}: {
  bin: FloorBinManagement;
  events: FloorBinBatchEvent[];
  eventsLoading: boolean;
  eventsLoadFailed: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const batch = bin.batch;
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const [historyAtBottom, setHistoryAtBottom] = useState(true);
  const [quantityDraft, setQuantityDraft] = useState(
    String(batch?.remaining_quantity ?? 0),
  );
  const [clearOpen, setClearOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);

  useEffect(() => {
    setHistoryAtBottom(true);
    setQuantityDraft(String(batch?.remaining_quantity ?? 0));
    setClearOpen(false);
    setUnlinkOpen(false);
  }, [batch?.id, batch?.remaining_quantity]);

  const refreshBinData = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["floor-bin-history"] }),
      queryClient.invalidateQueries({ queryKey: ["floor-bin-management"] }),
      queryClient.invalidateQueries({
        queryKey: ["floor-bin-batch-events", batch?.id ?? null],
      }),
    ]);

  const overrideMutation = useMutation({
    mutationFn: (remaining_quantity: number) =>
      api.overrideFloorBinQuantity({ payload: bin.payload, remaining_quantity }),
    onSuccess: async () => {
      setClearOpen(false);
      await refreshBinData();
      showToast(
        t("inventory.binQuantityUpdated", "Bin quantity updated"),
        "success",
      );
    },
    onError: () =>
      showToast(
        t("inventory.binQuantityUpdateFailed", "Could not update bin quantity"),
        "error",
      ),
  });

  const unlinkMutation = useMutation({
    mutationFn: () => api.unlinkFloorBin({ payload: bin.payload }),
    onSuccess: async () => {
      setUnlinkOpen(false);
      await refreshBinData();
      showToast(
        t("inventory.binUnlinked", "Bin assignment cleared"),
        "success",
      );
    },
    onError: () =>
      showToast(
        t("inventory.binUnlinkFailed", "Could not clear bin assignment"),
        "error",
      ),
  });

  if (!batch) {
    return (
      <aside className="rounded-lg border border-dashed border-bambu-dark-tertiary p-6 text-center text-sm text-bambu-gray break-words xl:sticky xl:top-6">
        {t("floor.inventoryBinDetailUnavailable", "This bin fill is no longer active.")}
      </aside>
    );
  }

  const timeline = events.length
    ? events
    : eventsLoading
      ? []
      : [
          {
            id: -batch.id,
            action: "harvested",
            details: { quantity: batch.quantity },
            occurred_at: batch.harvested_at,
          },
        ];

  const depleted =
    batch.status === "empty" || batch.status === "empty_override";
  const unlinked = batch.status === "unlinked" || bin.status === "unlinked";
  const parsedQuantity = Number(quantityDraft);
  const quantityValid =
    Number.isInteger(parsedQuantity) &&
    parsedQuantity > 0 &&
    parsedQuantity <= batch.quantity;
  const busy = overrideMutation.isPending || unlinkMutation.isPending;
  const canManage = !depleted;

  return (
    <aside
      className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary xl:sticky xl:top-6 xl:flex xl:max-h-[calc(100vh-3rem)] xl:flex-col xl:overflow-hidden"
      aria-label={t("floor.inventoryBinDetailLabel", "Bin detail")}
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-bambu-dark-tertiary p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-bambu-gray">
            {t("floor.inventoryBinDetailEyebrow", "Bin record")}
          </p>
          <h2 className="mt-1 font-mono text-lg font-semibold text-white">
            {bin.payload}
          </h2>
        </div>
        <button
          type="button"
          className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
          onClick={onClose}
          aria-label={t("floor.inventoryDetailClose", "Close part detail")}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-none flex-col gap-5 overflow-hidden p-4">
        <div>
          <span
            className={`${STATUS_PILL_CLASS} ${binStatusClass(batch.status)}`}
          >
            {binStatusLabel(batch.status, t)}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt className="text-bambu-gray">{t("floor.inventoryBinPart", "Part")}</dt>
            <dd className="mt-0.5 font-mono text-white">{bin.part_code}</dd>
          </div>
          <div>
            <dt className="text-bambu-gray">{t("floor.inventoryBinNumber", "Bin")}</dt>
            <dd className="mt-0.5 text-white">{bin.part_name} {bin.bin_number}</dd>
          </div>
          <div>
            <dt className="text-bambu-gray">{t("floor.inventoryColPrinter", "Printer")}</dt>
            <dd className="mt-0.5 text-white">
              {batch.printer_name ?? t("floor.inventoryDeletedPrinter", "Deleted printer")}
            </dd>
          </div>
          <div>
            <dt className="text-bambu-gray">{t("floor.inventoryCompletedJob", "Completed job")}</dt>
            <dd className="mt-0.5 text-white">
              {batch.print_name ?? t("floor.inventoryNoJobLinked", "No job linked")}
            </dd>
          </div>
          <div>
            <dt className="text-bambu-gray">{t("floor.inventoryBinQuantity", "Quantity")}</dt>
            <dd className="mt-0.5 text-white">
              {batch.remaining_quantity} / {batch.quantity} {t("floor.inventoryBinRemaining", "remaining")}
            </dd>
          </div>
          <div>
            <dt className="text-bambu-gray">{t("floor.inventoryBinHarvested", "Harvested")}</dt>
            <dd className="mt-0.5 text-white">
              {formatFloorDate(batch.harvested_at, { dateStyle: "medium", timeStyle: "short" })}
            </dd>
          </div>
        </dl>

        {canManage && (
          <div className="space-y-3 border-t border-bambu-dark-tertiary pt-4">
            <div className="flex items-end gap-2">
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-xs text-bambu-gray">
                  {t("inventory.binOverrideLabel", "Remaining quantity")}
                </span>
                <input
                  aria-label={`${bin.part_name} ${bin.bin_number} remaining quantity`}
                  type="number"
                  min={1}
                  max={batch.quantity}
                  step={1}
                  value={quantityDraft}
                  disabled={busy}
                  onChange={(event) => setQuantityDraft(event.target.value)}
                  className="w-full rounded border border-bambu-dark-tertiary bg-bambu-dark px-2 py-2 text-sm text-white focus:border-bambu-green focus:outline-none"
                />
              </label>
              <Button
                size="sm"
                variant="secondary"
                disabled={!quantityValid || busy}
                onClick={() => overrideMutation.mutate(parsedQuantity)}
              >
                {t("inventory.binOverride", "Override")}
              </Button>
            </div>
            {!unlinked && (
              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setClearOpen(true)}
                >
                  <Eraser className="h-4 w-4" />
                  {t("inventory.binClearQuantity", "Clear quantity")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => setUnlinkOpen(true)}
                >
                  <Link2Off className="h-4 w-4" />
                  {t("inventory.binUnlink", "Unlink")}
                </Button>
              </div>
            )}
          </div>
        )}

        <section className="flex min-h-0 flex-none flex-col">
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-bambu-gray" />
            <h3 className="font-medium text-white">
              {t("floor.inventoryHistoryHeading", "History")}
            </h3>
          </div>
          <div className="relative mt-3">
            <div
              ref={historyScrollRef}
              className="max-h-56 overflow-y-auto pr-1"
              onScroll={(event) => {
                const element = event.currentTarget;
                setHistoryAtBottom(
                  element.scrollTop + element.clientHeight >= element.scrollHeight - 4,
                );
              }}
            >
              {eventsLoading ? (
                <div className="flex items-center gap-2 py-2 text-sm text-bambu-gray">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("floor.inventoryLoadingHistory", "Loading history…")}
                </div>
              ) : (
                <div className="relative">
                  <span
                    aria-hidden="true"
                    className="absolute bottom-2 left-[3px] top-2 w-0.5 bg-bambu-gray/70"
                  />
                  <BinHistoryTimeline events={timeline} batch={batch} t={t} />
                </div>
              )}
            </div>
            {timeline.length > 4 && !historyAtBottom && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-10 items-end justify-center bg-gradient-to-t from-bambu-dark-secondary via-bambu-dark-secondary/80 to-transparent pb-1">
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-700 shadow-md shadow-gray-400/40 dark:border-gray-500/70 dark:bg-bambu-dark-secondary dark:text-bambu-gray-light dark:shadow-black/70 dark:ring-1 dark:ring-white/5">
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </div>
            )}
          </div>
          {eventsLoadFailed && (
            <p className="mt-2 text-xs text-bambu-gray">
              {t(
                "floor.inventoryBinEventsUnavailable",
                "Bin history could not be loaded.",
              )}
            </p>
          )}
        </section>
      </div>

      {clearOpen && (
        <ConfirmModal
          title={t("inventory.binClearQuantityTitle", "Clear remaining quantity?")}
          message={t(
            "inventory.binClearQuantityMessage",
            "This will set {{bin}} remaining quantity to 0 and release the bin for reuse. It will leave the active bin list, but the historical batch and audit events will not be deleted.",
            { bin: `${bin.part_name} ${bin.bin_number}` },
          )}
          confirmText={t("inventory.binClearQuantityConfirm", "Clear quantity")}
          variant="warning"
          isLoading={overrideMutation.isPending}
          onCancel={() => setClearOpen(false)}
          onConfirm={() => overrideMutation.mutate(0)}
        />
      )}

      {unlinkOpen && (
        <ConfirmModal
          title={t("inventory.binUnlinkTitle", "Unlink bin assignment?")}
          message={t(
            "inventory.binUnlinkMessage",
            "This will release {{bin}} from {{printer}} and make it available for another harvest. The historical batch record will remain in the audit history.",
            {
              bin: `${bin.part_name} ${bin.bin_number}`,
              printer: batch.printer_name ?? "its printer",
            },
          )}
          confirmText={t("inventory.binUnlinkConfirm", "Unlink bin")}
          variant="danger"
          isLoading={unlinkMutation.isPending}
          onCancel={() => setUnlinkOpen(false)}
          onConfirm={() => unlinkMutation.mutate()}
        />
      )}
    </aside>
  );
}

function BinHistoryTimeline({
  events,
  batch,
  t,
}: {
  events: FloorBinBatchEvent[];
  batch: FloorBinBatch;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const items: ReactNode[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const nextEvent = events[index + 1];
    const qcQuantities =
      event.action === "harvested" && nextEvent?.action === "visual_qc_passed"
        ? binQcQuantities(nextEvent, batch)
        : null;

    if (qcQuantities && qcQuantities.rejected > 0) {
      items.push(
        <BinQcBranch
          key={`${event.id}-${nextEvent.id}`}
          harvestedEvent={event}
          qcEvent={nextEvent}
          quantities={qcQuantities}
          batch={batch}
          t={t}
        />,
      );
      index += 1;
      continue;
    }

    items.push(<BinHistoryEvent key={event.id} event={event} batch={batch} t={t} />);
  }

  return <ol className="space-y-3">{items}</ol>;
}

function BinHistoryEvent({
  event,
  batch,
  t,
}: {
  event: FloorBinBatchEvent;
  batch: FloorBinBatch;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <li className="relative pl-7 text-sm">
      <span
        className={`absolute left-1 top-1.5 z-10 h-2 w-2 -translate-x-1/2 rounded-full ${binEventDotClass(event.action)}`}
      />
      <p className="text-white">{binEventLabel(event, t, batch)}</p>
      <p className="text-xs text-bambu-gray">
        {formatFloorDate(event.occurred_at, {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </p>
    </li>
  );
}

function BinQcBranch({
  harvestedEvent,
  qcEvent,
  quantities,
  batch,
  t,
}: {
  harvestedEvent: FloorBinBatchEvent;
  qcEvent: FloorBinBatchEvent;
  quantities: { harvested: number; passed: number; rejected: number };
  batch: FloorBinBatch;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <li className="relative text-sm">
      <div className="relative pl-7">
        <span className="absolute left-1 top-1.5 z-10 h-2 w-2 -translate-x-1/2 rounded-full bg-bambu-green" />
        <p className="text-white">{binEventLabel(harvestedEvent, t, batch)}</p>
        <p className="text-xs text-bambu-gray">
          {formatFloorDate(harvestedEvent.occurred_at, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
      </div>
      {/* Fixed arm (w-14), not a 50% grid column — below xl the detail is full-width
          and a percentage branch stretches across half the page. */}
      <div className="relative mt-3 space-y-3">
        <div className="relative pl-[5.25rem]">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-3 left-[3px] h-[1.4375rem] w-14 rounded-bl-[1.25rem] border-b-2 border-l-2 border-bambu-gray/70"
          />
          <span className="absolute left-[3.75rem] top-1.5 z-10 h-2 w-2 -translate-x-1/2 rounded-full bg-red-500" />
          <p className="text-white">
            {t(
              "floor.inventoryBinEventVisualQcRejected",
              "{{rejected}} parts failed visual QC",
              { rejected: quantities.rejected },
            )}
          </p>
          <p className="text-xs text-bambu-gray">
            {formatFloorDate(qcEvent.occurred_at, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        </div>
        <div className="relative pl-7">
          <span className="absolute left-1 top-1.5 z-10 h-2 w-2 -translate-x-1/2 rounded-full bg-green-500" />
          <p className="text-white">
            {t(
              "floor.inventoryBinEventVisualQcQuantity",
              "{{passed}} of {{harvested}} passed visual QC",
              quantities,
            )}
          </p>
          <p className="text-xs text-bambu-gray">
            {formatFloorDate(qcEvent.occurred_at, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        </div>
      </div>
    </li>
  );
}

function binQcQuantities(
  event: FloorBinBatchEvent,
  batch: FloorBinBatch,
) {
  if (event.action !== "visual_qc_passed") return null;

  const harvestedQuantity = event.details?.harvested_quantity;
  const passedQuantity = event.details?.passed_quantity;
  const rejectedQuantity = event.details?.rejected_quantity;
  const harvested =
    typeof harvestedQuantity === "number" ? harvestedQuantity : batch.quantity;
  const passed =
    typeof passedQuantity === "number"
      ? passedQuantity
      : typeof batch.qc_passed_quantity === "number"
        ? batch.qc_passed_quantity
        : batch.status === "visual_qc_passed"
          ? batch.remaining_quantity
          : null;

  if (typeof passed !== "number") return null;

  return {
    harvested,
    passed,
    rejected:
      typeof rejectedQuantity === "number"
        ? rejectedQuantity
        : Math.max(0, harvested - passed),
  };
}

function binEventLabel(
  event: FloorBinBatchEvent,
  t: ReturnType<typeof useTranslation>["t"],
  batch: FloorBinBatch,
) {
  const quantity = event.details?.quantity;
  const harvestedQuantity = event.details?.harvested_quantity;
  const passedQuantity = event.details?.passed_quantity;
  const remainingQuantity = event.details?.remaining_quantity;
  switch (event.action) {
    case "harvested":
      return typeof quantity === "number"
        ? t("floor.inventoryBinEventHarvestedQuantity", "Harvested {{quantity}} parts into bin", { quantity })
        : t("floor.inventoryBinEventHarvested", "Harvested parts into bin");
    case "visual_qc_passed":
      {
        const passed =
          typeof passedQuantity === "number"
            ? passedQuantity
            : typeof batch.qc_passed_quantity === "number"
              ? batch.qc_passed_quantity
              : batch.status === "visual_qc_passed"
                ? batch.remaining_quantity
                : null;
        const harvested =
          typeof harvestedQuantity === "number" ? harvestedQuantity : batch.quantity;
        return typeof passed === "number"
          ? t(
              "floor.inventoryBinEventVisualQcQuantity",
              "{{passed}} of {{harvested}} passed visual QC",
              { passed, harvested },
            )
          : t("floor.inventoryBinEventVisualQc", "Visual QC passed");
      }
    case "wip":
      return t("floor.inventoryBinEventWip", "Moved to WIP");
    case "ready_for_production":
      return t("floor.inventoryBinEventStagedForProduction", "Staged for Production");
    case "empty":
      return t("floor.inventoryBinEventEmpty", "Bin marked empty");
    case "empty_override":
      return t("floor.inventoryBinEventEmptyOverride", "Bin manually cleared and marked depleted");
    case "relinked":
      return t("floor.inventoryBinEventRelinked", "Bin linked to completed job");
    case "quantity_override":
      return typeof remainingQuantity === "number"
        ? t("floor.inventoryBinEventQuantityOverride", "Quantity overridden to {{quantity}} remaining", { quantity: remainingQuantity })
        : t("floor.inventoryBinEventQuantityOverrideUnknown", "Quantity overridden");
    case "unlinked":
      return t("floor.inventoryBinEventUnlinked", "Bin fill unlinked");
    default:
      return formatCustomStatus(event.action);
  }
}

function binEventDotClass(action: string) {
  if (action === "harvested") return "bg-bambu-green";
  if (action === "visual_qc_passed" || action === "ready_for_production") return FLOOR_PASS_EVENT_DOT_CLASS;
  if (action === "wip") return "bg-amber-500";
  if (action === "empty" || action === "empty_override") return "bg-sky-500";
  if (action === "relinked") return "bg-bambu-green";
  if (action === "unlinked") return "bg-red-500";
  return "bg-bambu-gray";
}

function PartDetail({
  part,
  events,
  eventsLoadFailed,
  candidates,
  candidatesLoading,
  relinkPending,
  archivePending,
  unlinkPending,
  stickerPending,
  deletePending,
  codeOptions,
  codeOptionsLoading,
  setCodePending,
  clearCodePending,
  statusPending,
  saveError,
  onClose,
  onRelink,
  onArchive,
  onUnlink,
  onReplaceSticker,
  onSetPartCode,
  onClearPartCode,
  onSetStatus,
  onDelete,
}: {
  part: FloorInventoryPart | null;
  events: FloorInventoryPartEvent[];
  eventsLoadFailed: boolean;
  candidates: FloorPartJobCandidate[];
  candidatesLoading: boolean;
  relinkPending: boolean;
  archivePending: boolean;
  unlinkPending: boolean;
  stickerPending: boolean;
  deletePending: boolean;
  codeOptions: FloorPartCodeOption[];
  codeOptionsLoading: boolean;
  setCodePending: boolean;
  clearCodePending: boolean;
  statusPending: boolean;
  saveError: string | null;
  onClose: () => void;
  onRelink: (archiveId: number) => void;
  onArchive: (archived: boolean) => void;
  onUnlink: (reasonCode: string, reasonText: string | null) => void;
  onReplaceSticker: (
    newStickerCode: string,
    reasonCode: string,
    reasonText: string | null,
  ) => void;
  onSetPartCode: (code: string) => void;
  onClearPartCode: () => void;
  onSetStatus: (status: string) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [candidateId, setCandidateId] = useState("");
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [unlinkReasonCode, setUnlinkReasonCode] = useState("wrong_job");
  const [unlinkReasonText, setUnlinkReasonText] = useState("");
  const [stickerOpen, setStickerOpen] = useState(false);
  const [newStickerCode, setNewStickerCode] = useState("");
  const [stickerReasonCode, setStickerReasonCode] = useState("damaged");
  const [stickerReasonText, setStickerReasonText] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [clearCodeOpen, setClearCodeOpen] = useState(false);
  const [partCodeSelection, setPartCodeSelection] = useState("");
  const [partCodeEditing, setPartCodeEditing] = useState(false);
  const [statusEditing, setStatusEditing] = useState(false);
  const [statusSelection, setStatusSelection] = useState("");
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const [historyAtBottom, setHistoryAtBottom] = useState(true);
  useEffect(() => {
    setUnlinkOpen(false);
    setUnlinkReasonCode("wrong_job");
    setUnlinkReasonText("");
    setStickerOpen(false);
    setNewStickerCode("");
    setStickerReasonCode("damaged");
    setStickerReasonText("");
    setDeleteOpen(false);
    setClearCodeOpen(false);
    setPartCodeSelection("");
    setPartCodeEditing(false);
    setStatusEditing(false);
    setStatusSelection("");
    setHistoryAtBottom(true);
  }, [part?.id]);
  useEffect(() => {
    const element = historyScrollRef.current;
    if (!element) return;
    setHistoryAtBottom(
      element.scrollTop + element.clientHeight >= element.scrollHeight - 4,
    );
  }, [part?.id, events.length]);
  if (!part)
    return (
      <aside className="rounded-lg border border-dashed border-bambu-dark-tertiary p-6 text-center text-sm text-bambu-gray break-words xl:sticky xl:top-6">
        {t(
          "floor.inventoryDetailEmpty",
          "Select a part record to inspect its harvest evidence and event history.",
        )}
      </aside>
    );
  const needsMatching = isAttention(part);
  const timeline = buildPartTimeline(part, events);
  const latestEventAction = [...timeline]
    .reverse()
    .find((event) => !NON_STATUS_EVENT_ACTIONS.has(event.action))?.action ?? null;
  const currentStatus = manualStatusValue(
    part,
    latestEventAction ?? part.latest_event_action ?? null,
  );
  return (
    <aside
      className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary xl:sticky xl:top-6 xl:flex xl:max-h-[calc(100vh-3rem)] xl:flex-col xl:overflow-hidden"
      aria-label={t("floor.inventoryDetailLabel", "Part detail")}
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-bambu-dark-tertiary p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-bambu-gray">
            {t("floor.inventoryDetailEyebrow", "Part record")}
          </p>
          <h2 className="mt-1 font-mono text-lg font-semibold text-white">
            {part.sticker_code}
          </h2>
        </div>
        <button
          type="button"
          className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
          onClick={onClose}
          aria-label={t("floor.inventoryDetailClose", "Close part detail")}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-none flex-col gap-5 overflow-hidden p-4">
        <div className="flex items-center gap-2">
          <span
            className={`${STATUS_PILL_CLASS} ${statusClass(part, latestEventAction)}`}
          >
            {statusLabel(part, t, latestEventAction)}
          </span>
          {!part.archived_at && !statusEditing && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setStatusSelection(currentStatus);
                setStatusEditing(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              {t("floor.inventoryChangeStatus", "Change status")}
            </Button>
          )}
          {needsMatching && (
            <span className="text-xs text-amber-300">
              {t(
                "floor.inventoryNeedsMatchingHint",
                "A job was not available at harvest.",
              )}
            </span>
          )}
        </div>
        {statusEditing && (
          <div className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3">
            <label
              htmlFor="floor-part-status"
              className="text-xs font-medium text-bambu-gray-light"
            >
              {t("floor.inventoryStatusOverrideLabel", "Manual status")}
            </label>
            <select
              id="floor-part-status"
              value={statusSelection}
              onChange={(event) => setStatusSelection(event.target.value)}
              autoFocus
              className="mt-1.5 w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-2 text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
            >
              {MANUAL_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === "fit_checked" &&
                  (part.part_code === "BUT" || part.part_code === "KNB")
                    ? t("floor.inventoryStatusVisualQcPass", "Visual QC pass")
                    : option.label}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-bambu-gray">
              {t(
                "floor.inventoryStatusOverrideHint",
                "Choose one of the supported statuses. Changes are saved in history.",
              )}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setStatusEditing(false)}
              >
                {t("common.cancel", "Cancel")}
              </Button>
              <Button
                size="sm"
                disabled={!statusSelection.trim() || statusPending}
                onClick={() => {
                  onSetStatus(statusSelection.trim());
                  setStatusEditing(false);
                }}
              >
                {statusPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("common.save", "Save")}
              </Button>
            </div>
          </div>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt className="text-bambu-gray">
              {t("floor.inventoryColPrinter", "Printer")}
            </dt>
            <dd className="mt-0.5 text-white">
              {part.printer_name ??
                t("floor.inventoryDeletedPrinter", "Deleted printer")}
            </dd>
          </div>
          <div>
            <dt className="text-bambu-gray">
              {t("floor.inventoryColLabeled", "Labeled")}
            </dt>
            <dd className="mt-0.5 text-white">
              {formatFloorDate(part.labeled_at, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-bambu-gray">{t("floor.inventoryPartCode", "Part code")}</dt>
            {part.archived_at ? (
              <dd className="mt-0.5 font-mono text-white">{part.part_code ?? "—"}</dd>
            ) : part.part_code && !partCodeEditing ? (
              <dd className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className="font-mono text-white">{part.part_code}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setPartCodeEditing(true)}
                >
                  <Hash className="h-4 w-4" />
                  {t("floor.inventoryChangePartCode", "Change")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={setCodePending || clearCodePending}
                  onClick={() => setClearCodeOpen(true)}
                >
                  <X className="h-4 w-4" />
                  {t("floor.inventoryRemovePartCode", "Remove code")}
                </Button>
              </dd>
            ) : (
              <dd className="mt-1.5 flex flex-wrap items-center gap-2">
                <select
                  aria-label={t("floor.inventoryAssignPartCodeLabel", "Assign part code")}
                  value={partCodeSelection || part.part_code || ""}
                  onChange={(event) => setPartCodeSelection(event.target.value)}
                  disabled={codeOptionsLoading || setCodePending}
                  className="min-w-0 flex-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5 text-sm text-white focus:border-bambu-green focus:outline-none disabled:opacity-50"
                >
                  <option value="">
                    {codeOptionsLoading
                      ? t("floor.inventoryPartCodeOptionsLoading", "Loading codes…")
                      : t("floor.inventoryChoosePartCode", "Choose a part code")}
                  </option>
                  {codeOptions.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.code} — {option.name}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  disabled={!partCodeSelection || setCodePending}
                  onClick={() => {
                    onSetPartCode(partCodeSelection);
                    setPartCodeSelection("");
                    setPartCodeEditing(false);
                  }}
                >
                  {setCodePending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Hash className="h-4 w-4" />
                  )}
                  {part.part_code
                    ? t("floor.inventoryChangePartCode", "Change")
                    : t("floor.inventoryAssignPartCode", "Assign")}
                </Button>
                {part.part_code && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={setCodePending || clearCodePending}
                    onClick={() => setPartCodeEditing(false)}
                  >
                    {t("floor.inventoryCancelPartCodeChange", "Cancel")}
                  </Button>
                )}
              </dd>
            )}
          </div>
          <div className="col-span-2">
            <dt className="text-bambu-gray">
              {t("floor.inventoryCompletedJob", "Completed job")}
            </dt>
            <dd className="mt-0.5 text-white">
              {part.print_name ?? t("floor.inventoryNoJobLinked", "No job linked")}
            </dd>
          </div>
        </dl>
        {needsMatching && (
          <MatchJob
            key={part.id}
            candidates={candidates}
            loading={candidatesLoading}
            pending={relinkPending}
            candidateId={candidateId}
            onChange={setCandidateId}
            onMatch={onRelink}
          />
        )}
        <section className="flex min-h-0 flex-none flex-col">
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-bambu-gray" />
            <h3 className="font-medium text-white">
              {t("floor.inventoryHistoryHeading", "History")}
            </h3>
          </div>
          <div className="relative mt-3">
            <div
              ref={historyScrollRef}
              className="max-h-56 overflow-y-auto pr-1"
              onScroll={(event) => {
                const element = event.currentTarget;
                setHistoryAtBottom(
                  element.scrollTop + element.clientHeight >= element.scrollHeight - 4,
                );
              }}
            >
              <div className="relative">
                <span
                  aria-hidden="true"
                  className="absolute bottom-2 left-[3px] top-2 w-0.5 bg-bambu-dark-tertiary"
                />
                <ol className="space-y-3">
                  {timeline.map((event) => (
                    <li key={event.id} className="relative pl-7 text-sm">
                      <span
                        className={`absolute left-1 top-1.5 z-10 h-2 w-2 -translate-x-1/2 rounded-full ${partEventDotClass(event.action)}`}
                      />
                      <p className="text-white">{partEventLabel(event, part?.part_code, t)}</p>
                      <p className="text-xs text-bambu-gray">
                        {formatFloorDate(event.occurred_at, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
            {timeline.length > 4 && !historyAtBottom && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-10 items-end justify-center bg-gradient-to-t from-bambu-dark-secondary via-bambu-dark-secondary/80 to-transparent pb-1">
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-700 shadow-md shadow-gray-400/40 dark:border-gray-500/70 dark:bg-bambu-dark-secondary dark:text-bambu-gray-light dark:shadow-black/70 dark:ring-1 dark:ring-white/5">
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </div>
            )}
          </div>
          {eventsLoadFailed && events.length === 0 && (
            <p className="mt-2 text-xs text-bambu-gray">
              {t(
                "floor.inventoryEventsUnavailable",
                "Extra scan history could not be loaded. Check that the backend includes the Part history events API.",
              )}
            </p>
          )}
        </section>
        {saveError && (
          <p className="text-sm text-red-400" role="alert">
            {saveError}
          </p>
        )}
      </div>
      <div className="shrink-0 space-y-3 border-t border-bambu-dark-tertiary p-4">
          <div className="flex flex-wrap gap-2">
            {isLinked(part) && !unlinkOpen && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setUnlinkOpen(true)}
              >
                <Unlink className="h-4 w-4" />
                {t("floor.inventoryUnlink", "Unlink job")}
              </Button>
            )}
            {!part.archived_at && !stickerOpen && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setStickerOpen(true)}
              >
                <Tag className="h-4 w-4" />
                {t("floor.inventoryReplaceSticker", "Replace sticker")}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={archivePending}
              onClick={() => onArchive(!part.archived_at)}
            >
              {part.archived_at ? (
                <ArchiveRestore className="h-4 w-4" />
              ) : (
                <Archive className="h-4 w-4" />
              )}
              {part.archived_at
                ? t("floor.inventoryRestore", "Restore record")
                : t("floor.inventoryArchive", "Archive record")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={deletePending}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
              {t("floor.inventoryDelete", "Delete part record")}
            </Button>
          </div>
          {isLinked(part) && unlinkOpen && (
            <UnlinkForm
              reasonCode={unlinkReasonCode}
              reasonText={unlinkReasonText}
              onReasonCodeChange={setUnlinkReasonCode}
              onReasonTextChange={setUnlinkReasonText}
              pending={unlinkPending}
              onCancel={() => setUnlinkOpen(false)}
              onConfirm={() => {
                onUnlink(
                  unlinkReasonCode,
                  unlinkReasonCode === "other"
                    ? unlinkReasonText.trim()
                    : null,
                );
                setUnlinkOpen(false);
              }}
            />
          )}
          {!part.archived_at && stickerOpen && (
            <ReplaceStickerForm
              newCode={newStickerCode}
              reasonCode={stickerReasonCode}
              reasonText={stickerReasonText}
              onNewCodeChange={setNewStickerCode}
              onReasonCodeChange={setStickerReasonCode}
              onReasonTextChange={setStickerReasonText}
              pending={stickerPending}
              onCancel={() => setStickerOpen(false)}
              onConfirm={() => {
                onReplaceSticker(
                  newStickerCode.trim(),
                  stickerReasonCode,
                  stickerReasonCode === "other"
                    ? stickerReasonText.trim()
                    : null,
                );
                setStickerOpen(false);
              }}
            />
          )}
      </div>
      {deleteOpen && (
        <ConfirmModal
          title={t("floor.inventoryDeleteTitle", "Delete part record?")}
          message={t(
            "floor.inventoryDeleteConfirm",
            "This permanently deletes {{code}}, its job link, and every history event. This cannot be undone.",
            { code: part.sticker_code },
          )}
          confirmText={t("floor.inventoryDeleteConfirmButton", "Delete permanently")}
          variant="danger"
          isLoading={deletePending}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={onDelete}
        />
      )}
      {clearCodeOpen && (
        <ConfirmModal
          title={t("floor.inventoryRemovePartCodeTitle", "Remove part code?")}
          message={t(
            "floor.inventoryRemovePartCodeConfirm",
            "This removes the part-code association from {{code}} but keeps the part, job link, and history.",
            { code: part.part_code },
          )}
          confirmText={t("floor.inventoryRemovePartCodeConfirmButton", "Remove code")}
          variant="danger"
          isLoading={clearCodePending}
          onCancel={() => setClearCodeOpen(false)}
          onConfirm={() => {
            onClearPartCode();
            setClearCodeOpen(false);
          }}
        />
      )}
    </aside>
  );
}

type MatchMode = "recent" | "search";

function MatchJob({
  candidates,
  loading,
  pending,
  candidateId,
  onChange,
  onMatch,
}: {
  candidates: FloorPartJobCandidate[];
  loading: boolean;
  pending: boolean;
  candidateId: string;
  onChange: (value: string) => void;
  onMatch: (archiveId: number) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<MatchMode>("recent");
  const [term, setTerm] = useState("");
  const [debouncedTerm, setDebouncedTerm] = useState("");
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedTerm(term), 300);
    return () => clearTimeout(handle);
  }, [term]);
  const trimmedTerm = debouncedTerm.trim();
  const searchQuery = useQuery({
    queryKey: ["floor-inventory-job-search", trimmedTerm],
    queryFn: () => api.searchFloorInventoryJobs(trimmedTerm),
    enabled: mode === "search" && trimmedTerm.length > 0,
  });
  const searchResults: JobSearchResult[] = searchQuery.data ?? [];
  return (
    <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="flex gap-2">
        <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <div>
          <h3 className="font-medium text-amber-200">
            {t("floor.inventoryMatchHeading", "Match to completed job")}
          </h3>
          <p className="mt-1 text-xs text-amber-100/70">
            {t(
              "floor.inventoryMatchHint",
              "Candidates are completed jobs from this printer. Use the label time above to confirm the right one.",
            )}
          </p>
        </div>
      </div>
      <div className="mt-3 inline-flex max-w-full flex-wrap rounded-lg bg-bambu-dark p-1 text-xs">
        <button
          type="button"
          onClick={() => setMode("recent")}
          className={`shrink-0 whitespace-nowrap rounded-md px-2 py-1 transition-colors ${mode === "recent" ? "bg-bambu-green text-white" : "text-bambu-gray hover:text-white"}`}
        >
          {t("floor.inventoryMatchModeRecent", "Recent on this printer")}
        </button>
        <button
          type="button"
          onClick={() => setMode("search")}
          className={`shrink-0 whitespace-nowrap rounded-md px-2 py-1 transition-colors ${mode === "search" ? "bg-bambu-green text-white" : "text-bambu-gray hover:text-white"}`}
        >
          {t("floor.inventoryMatchModeSearch", "Search all jobs")}
        </button>
      </div>
      {mode === "recent" ? (
        loading ? (
          <p className="mt-3 text-sm text-bambu-gray">
            {t("floor.inventoryCandidatesLoading", "Loading candidates…")}
          </p>
        ) : candidates.length === 0 ? (
          <p className="mt-3 text-sm text-bambu-gray">
            {t(
              "floor.inventoryCandidatesEmpty",
              "No completed jobs are available for this printer.",
            )}
          </p>
        ) : (
          <div className="mt-3 flex gap-2">
            <select
              aria-label={t("floor.inventoryCompletedJob", "Completed job")}
              value={candidateId}
              onChange={(event) => onChange(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-amber-500/30 bg-bambu-dark px-2 py-2 text-sm text-white focus:border-bambu-green focus:outline-none"
            >
              <option value="">
                {t("floor.inventoryChooseJob", "Choose a completed job")}
              </option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.print_name}
                  {candidate.completed_at
                    ? ` · ${formatFloorDate(candidate.completed_at, { dateStyle: "short", timeStyle: "short" })}`
                    : ""}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!candidateId || pending}
              onClick={() => onMatch(Number(candidateId))}
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {t("floor.inventoryMatchAction", "Match")}
            </Button>
          </div>
        )
      ) : (
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={t(
              "floor.inventoryJobSearchPlaceholder",
              "Search by job name",
            )}
            aria-label={t(
              "floor.inventoryJobSearchLabel",
              "Search all completed jobs",
            )}
            className="w-full rounded-lg border border-amber-500/30 bg-bambu-dark px-2 py-2 text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
          />
          {!trimmedTerm ? (
            <p className="text-sm text-bambu-gray">
              {t(
                "floor.inventoryJobSearchPrompt",
                "Type a job name to search every completed job, on any printer.",
              )}
            </p>
          ) : searchQuery.isFetching ? (
            <p className="text-sm text-bambu-gray">
              {t("floor.inventoryJobSearchLoading", "Searching…")}
            </p>
          ) : searchResults.length === 0 ? (
            <p className="text-sm text-bambu-gray">
              {t(
                "floor.inventoryJobSearchEmpty",
                "No completed jobs match that search.",
              )}
            </p>
          ) : (
            <ul className="space-y-2">
              {searchResults.map((job) => (
                <li
                  key={job.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-bambu-dark px-2 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate text-white">{job.print_name}</p>
                    <p className="truncate text-xs text-bambu-gray">
                      {job.printer_name ??
                        t("floor.inventoryDeletedPrinter", "Deleted printer")}
                      {job.completed_at
                        ? ` · ${formatFloorDate(job.completed_at, { dateStyle: "short", timeStyle: "short" })}`
                        : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => onMatch(job.id)}
                  >
                    {pending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    {t("floor.inventoryMatchAction", "Match")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function UnlinkForm({
  reasonCode,
  reasonText,
  onReasonCodeChange,
  onReasonTextChange,
  pending,
  onCancel,
  onConfirm,
}: {
  reasonCode: string;
  reasonText: string;
  onReasonCodeChange: (value: string) => void;
  onReasonTextChange: (value: string) => void;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const requiresText = reasonCode === "other";
  const blocked = requiresText && reasonText.trim().length === 0;
  return (
    <section className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3">
      <h4 className="text-sm font-medium text-white">
        {t("floor.inventoryUnlinkHeading", "Unlink this job")}
      </h4>
      <p className="mt-1 text-xs text-bambu-gray">
        {t(
          "floor.inventoryUnlinkHint",
          "The part becomes unmatched again and can be rematched to the correct job.",
        )}
      </p>
      <div className="mt-3 space-y-2">
        <select
          aria-label={t("floor.inventoryUnlinkReasonLabel", "Unlink reason")}
          value={reasonCode}
          onChange={(event) => onReasonCodeChange(event.target.value)}
          className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-2 text-sm text-white focus:border-bambu-green focus:outline-none"
        >
          <option value="wrong_job">
            {t("floor.inventoryUnlinkReasonWrongJob", "Wrong job matched")}
          </option>
          <option value="wrong_printer">
            {t(
              "floor.inventoryUnlinkReasonWrongPrinter",
              "Wrong printer scanned",
            )}
          </option>
          <option value="other">
            {t("floor.inventoryReasonOther", "Other")}
          </option>
        </select>
        {requiresText && (
          <input
            type="text"
            aria-label={t(
              "floor.inventoryUnlinkReasonTextLabel",
              "Unlink reason details",
            )}
            placeholder={t(
              "floor.inventoryReasonTextPlaceholder",
              "Describe what happened",
            )}
            value={reasonText}
            onChange={(event) => onReasonTextChange(event.target.value)}
            className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-2 text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
          />
        )}
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={onCancel}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button size="sm" disabled={pending || blocked} onClick={onConfirm}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Unlink className="h-4 w-4" />
            )}
            {t("floor.inventoryUnlinkConfirm", "Confirm unlink")}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ReplaceStickerForm({
  newCode,
  reasonCode,
  reasonText,
  onNewCodeChange,
  onReasonCodeChange,
  onReasonTextChange,
  pending,
  onCancel,
  onConfirm,
}: {
  newCode: string;
  reasonCode: string;
  reasonText: string;
  onNewCodeChange: (value: string) => void;
  onReasonCodeChange: (value: string) => void;
  onReasonTextChange: (value: string) => void;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const requiresText = reasonCode === "other";
  const blocked =
    newCode.trim().length === 0 ||
    (requiresText && reasonText.trim().length === 0);
  return (
    <section className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3">
      <h4 className="text-sm font-medium text-white">
        {t("floor.inventoryReplaceStickerHeading", "Replace sticker")}
      </h4>
      <p className="mt-1 text-xs text-bambu-gray">
        {t(
          "floor.inventoryReplaceStickerHint",
          "Use this when the physical sticker is damaged or replaced. The job link and history stay attached to this part.",
        )}
      </p>
      <div className="mt-3 space-y-2">
        <input
          type="text"
          aria-label={t(
            "floor.inventoryNewStickerLabel",
            "New sticker code",
          )}
          placeholder={t(
            "floor.inventoryNewStickerPlaceholder",
            "New sticker code",
          )}
          value={newCode}
          onChange={(event) => onNewCodeChange(event.target.value)}
          className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-2 text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
        />
        <select
          aria-label={t(
            "floor.inventoryReplaceStickerReasonLabel",
            "Replace sticker reason",
          )}
          value={reasonCode}
          onChange={(event) => onReasonCodeChange(event.target.value)}
          className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-2 text-sm text-white focus:border-bambu-green focus:outline-none"
        >
          <option value="damaged">
            {t("floor.inventoryStickerReasonDamaged", "Sticker damaged")}
          </option>
          <option value="fell_off">
            {t("floor.inventoryStickerReasonFellOff", "Sticker fell off")}
          </option>
          <option value="other">
            {t("floor.inventoryReasonOther", "Other")}
          </option>
        </select>
        {requiresText && (
          <input
            type="text"
            aria-label={t(
              "floor.inventoryStickerReasonTextLabel",
              "Sticker reason details",
            )}
            placeholder={t(
              "floor.inventoryReasonTextPlaceholder",
              "Describe what happened",
            )}
            value={reasonText}
            onChange={(event) => onReasonTextChange(event.target.value)}
            className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-2 text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
          />
        )}
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={onCancel}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button size="sm" disabled={pending || blocked} onClick={onConfirm}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Tag className="h-4 w-4" />
            )}
            {t("floor.inventoryReplaceStickerConfirm", "Confirm replacement")}
          </Button>
        </div>
      </div>
    </section>
  );
}
