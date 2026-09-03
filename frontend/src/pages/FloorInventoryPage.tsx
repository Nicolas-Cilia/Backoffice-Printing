import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  type FloorProductUnit,
  type ReplaceUnitKitResult,
  type ReplaceUnitResult,
  type FloorStopReasonCode,
  type FloorPartCodeOption,
  type FloorPartJobCandidate,
  type JobSearchResult,
} from "../api/client";
import { useToast } from "../contexts/ToastContext";
import { PartHistoryTimeline } from "../components/floor/PartHistoryTimeline";
import { formatFloorDate } from "../utils/floorScan";
import {
  buildPartTimeline,
  consumedBySticker,
  FLOOR_PASS_BADGE_CLASS,
  FLOOR_PASS_EVENT_DOT_CLASS,
  formatCustomStatus,
  isFloorPassBinStatus,
  isFloorPassPartAction,
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
  // Kit bookkeeping is which fills were drawn — not a workflow status.
  "kit_assigned",
  "kit_reassigned",
  // BOT bin load is audit-only — workflow status stays on fit check until staged/WIP.
  "bot_bin_loaded",
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
// Serials assembly card identities render as inline links into Parts/Bins.
const ASSEMBLY_LINK_CLASS =
  "break-all rounded font-mono text-left text-bambu-green underline decoration-dotted underline-offset-2 transition-colors hover:text-bambu-green/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green";
const INVENTORY_CELL_CLASS = "block min-w-0 px-4 py-1.5 first:pt-3 last:pb-3 md:table-cell md:py-3";

type FloorInventoryTab = "parts" | "bins" | "serials";

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
      <button
        type="button"
        onClick={() => onChange("serials")}
        className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${tab === "serials" ? "bg-bambu-green text-white" : "text-bambu-gray hover:text-white"}`}
      >
        {t("floor.serialsTab", "Serials")}
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

function isArchivedBin(bin: FloorBinManagement) {
  return Boolean(bin.batch?.archived_at);
}

/** Still occupying the tote — archive only, not delete. */
function isActiveBin(bin: FloorBinManagement) {
  if (!bin.batch || isArchivedBin(bin)) return false;
  const status = bin.batch.status;
  return status !== "empty" && status !== "empty_override" && status !== "unlinked";
}

// Part Assembly Linking — Part history serial collapse.
//
// A product unit ties a TOP + BOT housing together under one product serial.
// On the Parts tab those two stickers collapse into a single serial row keyed
// by the serial, so a linked pair is one clickable row (→ Serials assembly
// card) rather than two separate sticker rows.
type UnitRow = { unit: FloorProductUnit; parts: FloorInventoryPart[] };

// Both housings shipped ⇒ the unit is fulfilled/shipped; otherwise it is still
// a registered (linked) product serial.
function unitAllShipped(
  parts: FloorInventoryPart[],
  latestEventActions: Map<number, string>,
) {
  return (
    parts.length > 0 &&
    parts.every((part) => isFulfilledPart(part, latestEventActions.get(part.id)))
  );
}

function isReworkAction(action?: string | null) {
  return action === "rework" || action === "sanding";
}

type UnitRowStatus = "shipped" | "rework" | "linked";

/** Map API unit_workflow_status → the same badges used on Part history rows. */
function unitWorkflowRowStatus(
  status: FloorProductUnit["unit_workflow_status"] | null | undefined,
): UnitRowStatus {
  if (status === "rework") return "rework";
  if (status === "shipped") return "shipped";
  return "linked";
}

function unitStatusPresentation(
  rowStatus: UnitRowStatus,
  t: (key: string, defaultValue: string) => string,
): { className: string; label: string } {
  if (rowStatus === "shipped") {
    return {
      className:
        "border border-sky-600 bg-sky-100 text-sky-800 shadow-sm shadow-sky-500/20 dark:border-sky-400/50 dark:bg-sky-500/20 dark:text-sky-300",
      label: t("floor.inventoryStatusShipped", "Shipped"),
    };
  }
  if (rowStatus === "rework") {
    return {
      className:
        "border border-orange-600 bg-orange-100 text-orange-800 shadow-sm shadow-orange-500/20 dark:border-orange-400/50 dark:bg-orange-500/20 dark:text-orange-300",
      label: t("floor.inventoryStatusRework", "Rework"),
    };
  }
  return {
    className:
      "border border-cyan-600 bg-cyan-100 text-cyan-800 dark:border-bambu-green/25 dark:bg-bambu-green/15 dark:text-bambu-green-light",
    label: t("floor.inventoryStatusLinked", "Linked"),
  };
}

/**
 * Parent serial badge for a linked TOP+BOT unit.
 *
 * Serial return-to-rework moves both housings together (never KNB/BUT bins).
 * Prefer the API's unit_workflow_status; fall back to both housing events only.
 */
function unitRowStatus(
  unit: FloorProductUnit,
  parts: FloorInventoryPart[],
  latestEventActions: Map<number, string>,
): UnitRowStatus {
  // Serial return-to-rework sets unit_workflow_status from TOP+BOT only.
  if (unit.unit_workflow_status === "rework") return "rework";
  if (unit.unit_workflow_status === "shipped" || unitAllShipped(parts, latestEventActions)) {
    return "shipped";
  }
  // Fallback when the units payload is stale/missing the field: both housings
  // must be in rework — same rule as serial return-to-rework (not kit bins).
  const housingActions = parts
    .filter((part) => !part.archived_at)
    .map((part) => latestEventActions.get(part.id) ?? part.latest_event_action ?? null);
  if (
    housingActions.length > 0 &&
    housingActions.every((action) => isReworkAction(action))
  ) {
    return "rework";
  }
  return "linked";
}

function unitMatchesFilter(
  parts: FloorInventoryPart[],
  filter: PartFilter,
  latestEventActions: Map<number, string>,
) {
  const action = (part: FloorInventoryPart) => latestEventActions.get(part.id);
  switch (filter) {
    case "all":
      return parts.some((part) => !part.archived_at);
    case "attention":
      return parts.some(
        (part) =>
          isAttention(part, action(part)) && !isFulfilledPart(part, action(part)),
      );
    case "linked":
      return parts.some(
        (part) =>
          isLinked(part, action(part)) && !isFulfilledPart(part, action(part)),
      );
    case "fulfilled":
      return unitAllShipped(parts, latestEventActions);
    case "archived":
      return parts.some((part) => Boolean(part.archived_at));
    default:
      return false;
  }
}

function unitSearchValues(
  unit: FloorProductUnit,
  parts: FloorInventoryPart[],
  latestEventActions: Map<number, string>,
) {
  return [
    unit.serial_code,
    unit.top_sticker,
    unit.bottom_sticker,
    unit.top_part_code,
    unit.bottom_part_code,
    unit.knob_bin_payload,
    unit.button_bin_payload,
    unit.knob_batch_id != null ? String(unit.knob_batch_id) : null,
    unit.button_batch_id != null ? String(unit.button_batch_id) : null,
    unit.knob_batch_id != null ? `#${unit.knob_batch_id}` : null,
    unit.button_batch_id != null ? `#${unit.button_batch_id}` : null,
    ...parts.flatMap((part) =>
      partSearchValues(part, latestEventActions.get(part.id)),
    ),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
}

type PartHistorySort =
  | "last_scanned_desc"
  | "last_scanned_asc"
  | "labeled_desc"
  | "labeled_asc";

const PART_HISTORY_SORT_OPTIONS: { id: PartHistorySort; labelKey: string; fallback: string }[] = [
  { id: "last_scanned_desc", labelKey: "floor.inventorySortLastScannedDesc", fallback: "Last scanned (newest)" },
  { id: "last_scanned_asc", labelKey: "floor.inventorySortLastScannedAsc", fallback: "Last scanned (oldest)" },
  { id: "labeled_desc", labelKey: "floor.inventorySortLabeledDesc", fallback: "First labeled (newest)" },
  { id: "labeled_asc", labelKey: "floor.inventorySortLabeledAsc", fallback: "First labeled (oldest)" },
];

function partLastScannedAt(part: FloorInventoryPart): string {
  return part.last_scanned_at ?? part.labeled_at;
}

function compareInventoryParts(left: FloorInventoryPart, right: FloorInventoryPart, sort: PartHistorySort): number {
  switch (sort) {
    case "last_scanned_desc":
      return new Date(partLastScannedAt(right)).getTime() - new Date(partLastScannedAt(left)).getTime();
    case "last_scanned_asc":
      return new Date(partLastScannedAt(left)).getTime() - new Date(partLastScannedAt(right)).getTime();
    case "labeled_desc":
      return new Date(right.labeled_at).getTime() - new Date(left.labeled_at).getTime();
    case "labeled_asc":
      return new Date(left.labeled_at).getTime() - new Date(right.labeled_at).getTime();
    default:
      return 0;
  }
}

function unitRowLastScannedAt(row: UnitRow): string {
  const timestamps = row.parts.map(partLastScannedAt);
  if (timestamps.length === 0) return row.unit.linked_at;
  return timestamps.reduce((latest, value) =>
    new Date(value).getTime() > new Date(latest).getTime() ? value : latest,
  );
}

function compareUnitRows(left: UnitRow, right: UnitRow, sort: PartHistorySort): number {
  if (sort === "labeled_desc" || sort === "labeled_asc") {
    const leftTs = new Date(left.unit.linked_at).getTime();
    const rightTs = new Date(right.unit.linked_at).getTime();
    return sort === "labeled_desc" ? rightTs - leftTs : leftTs - rightTs;
  }
  const leftTs = new Date(unitRowLastScannedAt(left)).getTime();
  const rightTs = new Date(unitRowLastScannedAt(right)).getTime();
  return sort === "last_scanned_asc" ? leftTs - rightTs : rightTs - leftTs;
}

function unitLastScannedAt(
  unit: FloorProductUnit,
  partsById: Map<number, FloorInventoryPart>,
): string {
  const timestamps = [unit.top_part_id, unit.bottom_part_id]
    .map((id) => partsById.get(id))
    .filter((part): part is FloorInventoryPart => part != null)
    .map(partLastScannedAt);
  if (timestamps.length === 0) return unit.linked_at;
  return timestamps.reduce((latest, value) =>
    new Date(value).getTime() > new Date(latest).getTime() ? value : latest,
  );
}

function compareSerialUnits(
  left: FloorProductUnit,
  right: FloorProductUnit,
  sort: PartHistorySort,
  partsById: Map<number, FloorInventoryPart>,
): number {
  if (sort === "labeled_desc" || sort === "labeled_asc") {
    const leftTs = new Date(left.linked_at).getTime();
    const rightTs = new Date(right.linked_at).getTime();
    return sort === "labeled_desc" ? rightTs - leftTs : leftTs - rightTs;
  }
  const leftTs = new Date(unitLastScannedAt(left, partsById)).getTime();
  const rightTs = new Date(unitLastScannedAt(right, partsById)).getTime();
  return sort === "last_scanned_asc" ? leftTs - rightTs : rightTs - leftTs;
}

export function FloorInventoryPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const pageTab: FloorInventoryTab =
    tabParam === "bins" ? "bins" : tabParam === "serials" ? "serials" : "parts";
  const setPageTab = (tab: FloorInventoryTab) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      // A manual tab switch clears any deep-link bin focus so a stale
      // highlight does not linger when the Bins tab is reopened by hand.
      next.delete("bin");
      if (tab === "parts") {
        next.delete("tab");
        next.delete("unit");
      } else {
        next.set("tab", tab);
      }
      return next;
    }, { replace: true });
  };
  const [filter, setFilter] = useState<PartFilter>("linked");
  const [sort, setSort] = useState<PartHistorySort>("last_scanned_desc");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedBinId, setSelectedBinId] = useState<number | null>(null);
  const [selectedFailure, setSelectedFailure] = useState<FloorPrintFailureReason | null>(null);
  /** Serial caret open on Part history (lifted so Serials → part can expand it). */
  const [expandedUnitId, setExpandedUnitId] = useState<number | null>(null);
  /** Sticker to select once part records are available after a cross-tab jump. */
  const [pendingOpenSticker, setPendingOpenSticker] = useState<string | null>(null);
  /** Kit batch to expand under its serial once units are available. */
  const [pendingOpenBatchId, setPendingOpenBatchId] = useState<number | null>(null);
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
  // Part Assembly Linking (Wave 3): the linked units, so a TOP/BOT row can show
  // the product serial it belongs to and click through to the Serials card.
  const partUnitsQuery = useQuery({
    queryKey: ["floor-units"],
    queryFn: () => api.listUnits(),
    enabled: pageTab === "parts",
    staleTime: 30_000,
  });
  const unitByPartId = useMemo(() => {
    const map = new Map<number, FloorProductUnit>();
    for (const unit of partUnitsQuery.data ?? []) {
      map.set(unit.top_part_id, unit);
      map.set(unit.bottom_part_id, unit);
    }
    return map;
  }, [partUnitsQuery.data]);
  // Linked housings collapse into their product-serial row, so they are pulled
  // out of the standalone parts list below.
  const unitMemberPartIds = useMemo(() => {
    const ids = new Set<number>();
    for (const unit of partUnitsQuery.data ?? []) {
      ids.add(unit.top_part_id);
      ids.add(unit.bottom_part_id);
    }
    return ids;
  }, [partUnitsQuery.data]);
  const openSerial = (unit: FloorProductUnit) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("tab", "serials");
      next.set("unit", String(unit.id));
      return next;
    }, { replace: true });
  };
  // Serials assembly card → Part history: search the serial (or sticker), expand
  // the unit caret, and select that housing once parts have loaded.
  const openPartBySticker = (sticker: string, unit?: FloorProductUnit | null) => {
    const trimmed = sticker.trim();
    if (!trimmed) return;
    setSearch(unit?.serial_code?.trim() || trimmed);
    setFilter("all");
    setSelectedFailure(null);
    setSelectedBinId(null);
    if (unit) setExpandedUnitId(unit.id);
    setPendingOpenSticker(trimmed);
    setPageTab("parts");
  };
  // Serials assembly / part timeline → Part history kit fill under its serial.
  const openBinByBatchId = (
    batchId: number,
    payload: string | null,
    unit?: FloorProductUnit | null,
  ) => {
    const knownUnit =
      unit ??
      (partUnitsQuery.data ?? []).find(
        (candidate) =>
          candidate.knob_batch_id === batchId || candidate.button_batch_id === batchId,
      ) ??
      null;
    setFilter("all");
    setSelectedId(null);
    setSelectedFailure(null);
    setSelectedBinId(batchId);
    if (knownUnit) {
      setSearch(knownUnit.serial_code.trim());
      setExpandedUnitId(knownUnit.id);
      setPendingOpenBatchId(null);
    } else {
      setSearch(payload?.trim() || "");
      setPendingOpenBatchId(batchId);
    }
    setPageTab("parts");
  };
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

  // Resolve Serials → Part history focus once parts (and units) are available.
  useEffect(() => {
    if (!pendingOpenSticker) return;
    const needle = pendingOpenSticker.trim().toUpperCase();
    const part = records.find(
      (candidate) => candidate.sticker_code.trim().toUpperCase() === needle,
    );
    if (!part) return;
    setSelectedId(part.id);
    setSelectedFailure(null);
    setSelectedBinId(null);
    const unit = unitByPartId.get(part.id);
    if (unit) setExpandedUnitId(unit.id);
    setPendingOpenSticker(null);
  }, [pendingOpenSticker, records, unitByPartId]);

  // Expand the serial that owns a kit fill after units load (timeline / deep link).
  useEffect(() => {
    if (pendingOpenBatchId == null) return;
    const unit = (partUnitsQuery.data ?? []).find(
      (candidate) =>
        candidate.knob_batch_id === pendingOpenBatchId ||
        candidate.button_batch_id === pendingOpenBatchId,
    );
    if (!unit) {
      if (partUnitsQuery.isSuccess) setPendingOpenBatchId(null);
      return;
    }
    setSearch(unit.serial_code.trim());
    setExpandedUnitId(unit.id);
    setPendingOpenBatchId(null);
  }, [pendingOpenBatchId, partUnitsQuery.data, partUnitsQuery.isSuccess]);

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
        ).length +
        historyBins.filter(
          (bin) =>
            bin.batch?.archive_id !== null && !isFulfilledBin(bin) && !isArchivedBin(bin),
        ).length,
      attention:
        records.filter((part) =>
          isAttention(part, latestEventActions.get(part.id)) &&
          !isFulfilledPart(part, latestEventActions.get(part.id)),
        ).length +
        historyBins.filter(
          (bin) =>
            bin.batch?.archive_id === null && !isFulfilledBin(bin) && !isArchivedBin(bin),
        ).length,
      archived:
        records.filter((part) => part.archived_at).length +
        historyBins.filter((bin) => isArchivedBin(bin)).length,
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
      // Housings on a product unit are represented by their serial row.
      if (unitMemberPartIds.has(part.id)) return false;
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
  }, [filter, latestEventActions, records, search, unitMemberPartIds]);
  const sortedVisibleParts = useMemo(
    () => [...visibleParts].sort((left, right) => compareInventoryParts(left, right, sort)),
    [visibleParts, sort],
  );
  // Collapsed product-serial rows: linked TOP + BOT housings shown as one row.
  const visibleUnitRows = useMemo<UnitRow[]>(() => {
    const term = search.trim().toLowerCase();
    return (partUnitsQuery.data ?? [])
      .map((unit) => ({
        unit,
        parts: records.filter(
          (part) => part.id === unit.top_part_id || part.id === unit.bottom_part_id,
        ),
      }))
      .filter(({ unit, parts }) => {
        if (parts.length === 0) return false;
        if (!unitMatchesFilter(parts, filter, latestEventActions)) return false;
        return (
          !term ||
          unitSearchValues(unit, parts, latestEventActions).some((value) =>
            value.includes(term),
          )
        );
      });
  }, [partUnitsQuery.data, records, filter, search, latestEventActions]);
  const sortedVisibleUnitRows = useMemo(
    () => [...visibleUnitRows].sort((left, right) => compareUnitRows(left, right, sort)),
    [visibleUnitRows, sort],
  );
  const visibleBins = useMemo(() => {
    const term = search.trim().toLowerCase();
    return historyBins.filter((bin) => {
      const batch = bin.batch;
      if (!batch) return false;
      const included =
        filter === "all"
          ? !isArchivedBin(bin)
          : filter === "attention"
            ? batch.archive_id === null && !isFulfilledBin(bin) && !isArchivedBin(bin)
            : filter === "linked"
              ? batch.archive_id !== null && !isFulfilledBin(bin) && !isArchivedBin(bin)
              : filter === "fulfilled"
                ? isFulfilledBin(bin) && !isArchivedBin(bin)
                : filter === "archived"
                  ? isArchivedBin(bin)
                  : false;
      return (
        included &&
        (!term ||
          binSearchValues(bin).some((value) => value.includes(term)))
      );
    });
  }, [historyBins, filter, search]);
  const sortedVisibleBins = useMemo(() => {
    const rows = [...visibleBins];
    rows.sort((left, right) => {
      const leftTs = new Date(left.batch?.harvested_at ?? 0).getTime();
      const rightTs = new Date(right.batch?.harvested_at ?? 0).getTime();
      if (sort === "labeled_asc" || sort === "last_scanned_asc") {
        return leftTs - rightTs;
      }
      return rightTs - leftTs;
    });
    return rows;
  }, [visibleBins, sort]);
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
    visibleParts.length +
    visibleUnitRows.length +
    visibleBins.length +
    visibleFailureRecords.length;
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

  if (pageTab === "serials") {
    return (
      <div className="space-y-6 p-4 md:p-8">
        <FloorInventoryTabs tab={pageTab} onChange={setPageTab} />
        <FloorSerialsSection onOpenPart={openPartBySticker} onOpenBin={openBinByBatchId} />
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
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <section className="min-w-0 overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary">
          <div className="space-y-3 border-b border-bambu-dark-tertiary p-4">
            <HorizontalScrollFade className="w-full" fadeFromClassName="from-bambu-dark-secondary">
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex min-w-0 items-center gap-1 rounded-lg bg-bambu-dark p-1">
                <span className="shrink-0 pl-2 text-sm text-bambu-gray">
                  {t("floor.inventorySortLabel", "Sort by")}
                </span>
                <div className="relative min-w-0">
                  <select
                    value={sort}
                    onChange={(event) => setSort(event.target.value as PartHistorySort)}
                    className="w-full min-w-[12rem] appearance-none rounded-md bg-bambu-dark-secondary py-1.5 pl-2.5 pr-8 text-sm text-white transition-colors hover:text-white focus:border-bambu-green focus:outline-none focus:ring-1 focus:ring-bambu-green sm:min-w-[14rem]"
                    aria-label={t("floor.inventorySortLabel", "Sort by")}
                  >
                    {PART_HISTORY_SORT_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {t(option.labelKey, option.fallback)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray"
                    aria-hidden="true"
                  />
                </div>
              </label>
              <div className="flex flex-wrap items-center gap-3">
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
                  parts={sortedVisibleParts}
                  unitRows={sortedVisibleUnitRows}
                  bins={sortedVisibleBins}
                  allBins={historyBins}
                  failures={visibleFailureRecords}
                  latestEventActions={latestEventActions}
                  unitByPartId={unitByPartId}
                  onOpenSerial={openSerial}
                  selectedId={selectedId}
                  selectedBinId={selectedBinId}
                  selectedFailure={selectedFailure}
                  expandedUnitId={expandedUnitId}
                  onExpandedUnitIdChange={setExpandedUnitId}
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
          onOpenSticker={openPartBySticker}
          onOpenBinBatch={openBinByBatchId}
          onOpenSerial={(serial, unitId) => {
            if (unitId != null) {
              setSearchParams((previous) => {
                const next = new URLSearchParams(previous);
                next.set("tab", "serials");
                next.set("unit", String(unitId));
                return next;
              }, { replace: true });
              return;
            }
            setSearch(serial);
            setPageTab("serials");
          }}
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
  unitRows = [],
  bins,
  allBins = [],
  failures,
  latestEventActions,
  unitByPartId,
  onOpenSerial,
  selectedId,
  selectedBinId,
  selectedFailure,
  expandedUnitId,
  onExpandedUnitIdChange,
  onSelectPart,
  onSelectBin,
  onSelectFailure,
  t,
}: {
  parts: FloorInventoryPart[];
  unitRows?: UnitRow[];
  bins: FloorBinManagement[];
  /** Full bin history (not filter-clipped) so kit slots can open depleted fills. */
  allBins?: FloorBinManagement[];
  failures: FloorPrintFailureReason[];
  latestEventActions: Map<number, string>;
  unitByPartId?: Map<number, FloorProductUnit>;
  onOpenSerial?: (unit: FloorProductUnit) => void;
  selectedId: number | null;
  selectedBinId: number | null;
  selectedFailure: FloorPrintFailureReason | null;
  expandedUnitId: number | null;
  onExpandedUnitIdChange: (unitId: number | null) => void;
  onSelectPart: (part: FloorInventoryPart) => void;
  onSelectBin: (bin: FloorBinManagement) => void;
  onSelectFailure: (record: FloorPrintFailureReason) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const findBinByBatchId = (batchId: number | null | undefined) =>
    batchId == null
      ? null
      : (allBins.find((bin) => bin.batch?.id === batchId) ??
        bins.find((bin) => bin.batch?.id === batchId) ??
        null);

  const kitSlotLabel = (
    unit: FloorProductUnit,
    slot: "KNB" | "BUT",
  ): string => {
    const batchId = slot === "KNB" ? unit.knob_batch_id : unit.button_batch_id;
    const payload = slot === "KNB" ? unit.knob_bin_payload : unit.button_bin_payload;
    if (batchId == null) {
      return t("floor.inventoryUnitKitMissing", "Not assigned");
    }
    const bin = findBinByBatchId(batchId);
    if (bin) return binBatchLabel(bin);
    return payload?.trim() ? `${payload.trim()} #${batchId}` : `#${batchId}`;
  };

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
              {t("floor.inventoryColLastScanned", "Last scanned")}
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
          {unitRows.map(({ unit, parts: unitParts }) => {
            const { className: statusPillClass, label: statusText } = unitStatusPresentation(
              unitRowStatus(unit, unitParts, latestEventActions),
              t,
            );
            const partCodeSummary = [
              unit.top_part_code ?? "TOP",
              unit.bottom_part_code ?? "BOT",
            ].join(" + ");
            const jobName =
              [...new Set(unitParts.map((part) => part.print_name).filter(Boolean))].join(
                " · ",
              ) || null;
            const printerName =
              [
                ...new Set(unitParts.map((part) => part.printer_name).filter(Boolean)),
              ].join(", ") || t("floor.inventoryDeletedPrinter", "Deleted printer");
            const expanded = expandedUnitId === unit.id;
            const topPart = unitParts.find((part) => part.id === unit.top_part_id) ?? null;
            const bottomPart = unitParts.find((part) => part.id === unit.bottom_part_id) ?? null;
            const knobBin = findBinByBatchId(unit.knob_batch_id);
            const buttonBin = findBinByBatchId(unit.button_batch_id);
            const childSelected =
              (topPart != null && selectedId === topPart.id) ||
              (bottomPart != null && selectedId === bottomPart.id) ||
              (unit.knob_batch_id != null && selectedBinId === unit.knob_batch_id) ||
              (unit.button_batch_id != null && selectedBinId === unit.button_batch_id);

            const toggleExpanded = () =>
              onExpandedUnitIdChange(expandedUnitId === unit.id ? null : unit.id);

            return (
              <Fragment key={`unit-${unit.id}`}>
                <tr
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={toggleExpanded}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleExpanded();
                    }
                  }}
                  className={`cursor-pointer ${INVENTORY_ROW_CLASS} transition-colors hover:bg-bambu-dark-tertiary/60 focus:bg-bambu-dark-tertiary/60 focus:outline-none ${expanded || childSelected ? "bg-bambu-dark-tertiary/40" : ""}`}
                >
                  <td className={`${INVENTORY_CELL_CLASS} break-all font-mono font-medium text-white`}>
                    <span className="inline-flex items-center gap-1.5">
                      <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-bambu-gray transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
                        aria-hidden="true"
                      />
                      <Link2 className="h-3.5 w-3.5 shrink-0 text-bambu-green" aria-hidden="true" />
                      {unit.serial_code}
                    </span>
                    <span className="mt-0.5 block break-all text-xs text-bambu-gray">
                      <span>{unit.top_sticker}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{unit.bottom_sticker}</span>
                    </span>
                  </td>
                  <td className={`${INVENTORY_CELL_CLASS} md:whitespace-nowrap`}>
                    <span className={`${STATUS_PILL_CLASS} ${statusPillClass}`}>{statusText}</span>
                  </td>
                  <td className={`${INVENTORY_CELL_CLASS} break-words text-white`}>
                    <span className="mb-0.5 mr-2 block font-mono text-bambu-green-light md:mb-0 md:inline">
                      {partCodeSummary}
                    </span>
                    {jobName ?? (
                      <span className="text-bambu-gray">{t("floor.inventoryNoJob", "No completed job")}</span>
                    )}
                    {onOpenSerial && (
                      <button
                        type="button"
                        className="mt-1 block text-xs text-bambu-green-light underline-offset-2 hover:underline md:mt-0 md:ml-2 md:inline"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenSerial(unit);
                        }}
                      >
                        {t("floor.inventoryOpenInSerials", "Open in Serials")}
                      </button>
                    )}
                  </td>
                  <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray-light`}>{printerName}</td>
                  <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray md:whitespace-nowrap`}>
                    {formatFloorDate(unitRowLastScannedAt({ unit, parts: unitParts }), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </td>
                </tr>
                {expanded && (
                  <>
                    <UnitComponentRow
                      slotLabel={unit.top_part_code ?? "TOP"}
                      identity={unit.top_sticker}
                      selected={topPart != null && selectedId === topPart.id}
                      disabled={topPart == null}
                      status={
                        topPart
                          ? statusLabel(
                              topPart,
                              t,
                              latestEventActions.get(topPart.id) ?? topPart.latest_event_action,
                            )
                          : "—"
                      }
                      statusClassName={
                        topPart
                          ? statusClass(
                              topPart,
                              latestEventActions.get(topPart.id) ?? topPart.latest_event_action,
                            )
                          : "bg-bambu-dark-tertiary text-bambu-gray-light"
                      }
                      job={topPart?.print_name ?? null}
                      printer={topPart?.printer_name ?? null}
                      labeledAt={topPart ? partLastScannedAt(topPart) : null}
                      onSelect={() => topPart && onSelectPart(topPart)}
                      t={t}
                    />
                    <UnitComponentRow
                      slotLabel={unit.bottom_part_code ?? "BOT"}
                      identity={unit.bottom_sticker}
                      selected={bottomPart != null && selectedId === bottomPart.id}
                      disabled={bottomPart == null}
                      status={
                        bottomPart
                          ? statusLabel(
                              bottomPart,
                              t,
                              latestEventActions.get(bottomPart.id) ??
                                bottomPart.latest_event_action,
                            )
                          : "—"
                      }
                      statusClassName={
                        bottomPart
                          ? statusClass(
                              bottomPart,
                              latestEventActions.get(bottomPart.id) ??
                                bottomPart.latest_event_action,
                            )
                          : "bg-bambu-dark-tertiary text-bambu-gray-light"
                      }
                      job={bottomPart?.print_name ?? null}
                      printer={bottomPart?.printer_name ?? null}
                      labeledAt={bottomPart ? partLastScannedAt(bottomPart) : null}
                      onSelect={() => bottomPart && onSelectPart(bottomPart)}
                      t={t}
                    />
                    <UnitComponentRow
                      slotLabel="KNB"
                      identity={kitSlotLabel(unit, "KNB")}
                      selected={
                        unit.knob_batch_id != null && selectedBinId === unit.knob_batch_id
                      }
                      disabled={knobBin == null}
                      status={
                        knobBin?.batch
                          ? binStatusLabel(
                              knobBin.batch.status,
                              t,
                              Boolean(knobBin.batch.archived_at),
                            )
                          : "—"
                      }
                      statusClassName={
                        knobBin?.batch
                          ? binStatusClass(
                              knobBin.batch.status,
                              Boolean(knobBin.batch.archived_at),
                            )
                          : "bg-bambu-dark-tertiary text-bambu-gray-light"
                      }
                      job={knobBin?.batch?.print_name ?? null}
                      printer={knobBin?.batch?.printer_name ?? null}
                      labeledAt={knobBin?.batch?.harvested_at ?? null}
                      onSelect={() => knobBin && onSelectBin(knobBin)}
                      t={t}
                    />
                    <UnitComponentRow
                      slotLabel="BUT"
                      identity={kitSlotLabel(unit, "BUT")}
                      selected={
                        unit.button_batch_id != null && selectedBinId === unit.button_batch_id
                      }
                      disabled={buttonBin == null}
                      status={
                        buttonBin?.batch
                          ? binStatusLabel(
                              buttonBin.batch.status,
                              t,
                              Boolean(buttonBin.batch.archived_at),
                            )
                          : "—"
                      }
                      statusClassName={
                        buttonBin?.batch
                          ? binStatusClass(
                              buttonBin.batch.status,
                              Boolean(buttonBin.batch.archived_at),
                            )
                          : "bg-bambu-dark-tertiary text-bambu-gray-light"
                      }
                      job={buttonBin?.batch?.print_name ?? null}
                      printer={buttonBin?.batch?.printer_name ?? null}
                      labeledAt={buttonBin?.batch?.harvested_at ?? null}
                      onSelect={() => buttonBin && onSelectBin(buttonBin)}
                      t={t}
                    />
                  </>
                )}
              </Fragment>
            );
          })}
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
                <td className={`${INVENTORY_CELL_CLASS} break-all font-mono font-medium text-white`}>
                  {part.sticker_code}
                  {(() => {
                    const unit = unitByPartId?.get(part.id);
                    if (!unit) return null;
                    return (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenSerial?.(unit);
                        }}
                        title={t("floor.serialChipTooltip", "Open product serial {{serial}}", { serial: unit.serial_code })}
                        className="ml-2 inline-flex items-center gap-1 rounded-full border border-bambu-green/40 bg-bambu-green/10 px-2 py-0.5 align-middle text-xs font-medium text-bambu-green-light transition-colors hover:bg-bambu-green/20"
                      >
                        <Link2 className="h-3 w-3" aria-hidden="true" />
                        {unit.serial_code}
                      </button>
                    );
                  })()}
                </td>
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
                  {formatFloorDate(partLastScannedAt(part), { dateStyle: "medium", timeStyle: "short" })}
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
                <td className={`${INVENTORY_CELL_CLASS} break-all font-mono font-medium text-white`}>{binBatchLabel(bin)}</td>
                <td className={`${INVENTORY_CELL_CLASS} md:whitespace-nowrap`}>
                  <span className={`${STATUS_PILL_CLASS} ${binStatusClass(batch.status, Boolean(batch.archived_at))}`}>
                    {binStatusLabel(batch.status, t, Boolean(batch.archived_at))}
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

function UnitComponentRow({
  slotLabel,
  identity,
  selected,
  disabled,
  status,
  statusClassName,
  job,
  printer,
  labeledAt,
  onSelect,
  t,
}: {
  slotLabel: string;
  identity: string;
  selected: boolean;
  disabled: boolean;
  status: string;
  statusClassName: string;
  job: string | null;
  printer: string | null;
  labeledAt: string | null;
  onSelect: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <tr
      tabIndex={disabled ? undefined : 0}
      aria-label={t("floor.inventoryUnitComponentRow", "{{slot}} {{identity}}", {
        slot: slotLabel,
        identity,
      })}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`${INVENTORY_ROW_CLASS} ${disabled ? "opacity-50" : "cursor-pointer hover:bg-bambu-dark-tertiary/60 focus:bg-bambu-dark-tertiary/60 focus:outline-none"} ${selected ? "bg-bambu-dark-tertiary/60" : "bg-bambu-dark/40"}`}
    >
      <td className={`${INVENTORY_CELL_CLASS} break-all font-mono font-medium text-white`}>
        <span className="ml-5 inline-flex flex-col gap-0.5 sm:ml-7">
          <span className="text-xs uppercase tracking-wide text-bambu-gray">{slotLabel}</span>
          <span>{identity}</span>
        </span>
      </td>
      <td className={`${INVENTORY_CELL_CLASS} md:whitespace-nowrap`}>
        <span className={`${STATUS_PILL_CLASS} ${statusClassName}`}>{status}</span>
      </td>
      <td className={`${INVENTORY_CELL_CLASS} break-words text-white`}>
        {job ?? (
          <span className="text-bambu-gray">{t("floor.inventoryNoJob", "No completed job")}</span>
        )}
      </td>
      <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray-light`}>
        {printer ?? t("floor.inventoryDeletedPrinter", "Deleted printer")}
      </td>
      <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray md:whitespace-nowrap`}>
        {labeledAt
          ? formatFloorDate(labeledAt, { dateStyle: "medium", timeStyle: "short" })
          : "—"}
      </td>
    </tr>
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
      className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100vh-3rem)] lg:flex-col lg:overflow-hidden"
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
    const leftDate = left.type === "failure" ? left.record.stopped_at : partLastScannedAt(left.part);
    const rightDate = right.type === "failure" ? right.record.stopped_at : partLastScannedAt(right.part);
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
                  {t("floor.inventoryColLastScanned", "Last scanned")}
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
                      {formatFloorDate(isFailure ? entry.record.stopped_at : partLastScannedAt(entry.part), {
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

function binBatchLabel(bin: FloorBinManagement): string {
  // Each harvest fill shares the reusable bin QR (BBN-BUT-1) but gets a
  // durable batch id — the same #N the kit picker already shows — so Part
  // history and search can tell fills apart.
  return bin.batch ? `${bin.payload} #${bin.batch.id}` : bin.payload;
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
  const label = binBatchLabel(bin);
  return [
    bin.payload,
    label,
    `#${batch.id}`,
    String(batch.id),
    bin.part_code,
    bin.part_name,
    batch.print_name,
    batch.printer_name,
    batch.status,
    batch.archived_at ? "archived" : null,
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

function binStatusClass(status: string, archived = false) {
  if (archived) {
    return "border border-bambu-dark-tertiary bg-bambu-dark-tertiary text-bambu-gray-light";
  }
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
  archived = false,
) {
  if (archived) return t("floor.inventoryStatusArchived", "Archived");
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
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    setHistoryAtBottom(true);
    setQuantityDraft(String(batch?.remaining_quantity ?? 0));
    setClearOpen(false);
    setUnlinkOpen(false);
    setDeleteOpen(false);
  }, [batch?.id, batch?.remaining_quantity, batch?.archived_at]);

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

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteFloorBinBatch(batch!.id),
    onSuccess: async () => {
      setDeleteOpen(false);
      await refreshBinData();
      showToast(t("floor.inventoryBinDeleted", "Bin record deleted"), "success");
      onClose();
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error && /archiv/i.test(error.message)
          ? t(
              "floor.inventoryBinDeleteActive",
              "Active bin fills must be archived before they can be deleted",
            )
          : t("floor.inventoryBinDeleteFailed", "Could not delete bin record");
      showToast(message, "error");
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (archived: boolean) => api.archiveFloorBinBatch(batch!.id, archived),
    onSuccess: async (_data, archived) => {
      await refreshBinData();
      showToast(
        archived
          ? t("floor.inventoryBinArchived", "Bin record archived")
          : t("floor.inventoryBinRestored", "Bin record restored"),
        "success",
      );
    },
    onError: () =>
      showToast(
        t(
          "floor.inventoryBinArchiveBlocked",
          "Clear quantity or unlink the print before archiving this bin fill",
        ),
        "error",
      ),
  });

  if (!batch) {
    return (
      <aside className="rounded-lg border border-dashed border-bambu-dark-tertiary p-6 text-center text-sm text-bambu-gray break-words lg:sticky lg:top-6">
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
  const archived = Boolean(batch.archived_at);
  const active = isActiveBin(bin);
  const linkedToPrint = Boolean(batch.archive_id) && !unlinked;
  const canArchive =
    archived || !(batch.remaining_quantity > 0 && linkedToPrint);
  const parsedQuantity = Number(quantityDraft);
  const quantityValid =
    Number.isInteger(parsedQuantity) &&
    parsedQuantity > 0 &&
    parsedQuantity <= batch.quantity;
  const busy =
    overrideMutation.isPending ||
    unlinkMutation.isPending ||
    deleteMutation.isPending ||
    archiveMutation.isPending;
  const canManage = !depleted && !archived;
  const batchLabel = binBatchLabel(bin);

  return (
    <aside
      className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100vh-3rem)] lg:flex-col lg:overflow-hidden"
      aria-label={t("floor.inventoryBinDetailLabel", "Bin detail")}
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-bambu-dark-tertiary p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-bambu-gray">
            {t("floor.inventoryBinDetailEyebrow", "Bin record")}
          </p>
          <h2 className="mt-1 font-mono text-lg font-semibold text-white">
            {batchLabel}
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
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <div>
          <span
            className={`${STATUS_PILL_CLASS} ${binStatusClass(batch.status, archived)}`}
          >
            {binStatusLabel(batch.status, t, archived)}
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
            <dt className="text-bambu-gray">{t("floor.inventoryBinBatch", "Batch")}</dt>
            <dd className="mt-0.5 font-mono text-white">#{batch.id}</dd>
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

        <div className="flex flex-wrap gap-2 border-t border-bambu-dark-tertiary pt-4">
          {canArchive && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => archiveMutation.mutate(!archived)}
            >
              {archived ? (
                <ArchiveRestore className="h-4 w-4" />
              ) : (
                <Archive className="h-4 w-4" />
              )}
              {archived
                ? t("floor.inventoryRestore", "Restore record")
                : t("floor.inventoryArchive", "Archive record")}
            </Button>
          )}
          {!active && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
              {t("floor.inventoryBinDelete", "Delete bin record")}
            </Button>
          )}
        </div>

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
      {deleteOpen && (
        <ConfirmModal
          title={t("floor.inventoryBinDeleteTitle", "Delete bin record?")}
          message={t(
            "floor.inventoryBinDeleteConfirm",
            "This permanently deletes {{code}}, its quantity history, and every audit event for this fill. Parts that used this kit will keep their part history but lose the kit link. This cannot be undone.",
            { code: batchLabel },
          )}
          confirmText={t("floor.inventoryBinDeleteConfirmButton", "Delete permanently")}
          variant="danger"
          isLoading={deleteMutation.isPending}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => deleteMutation.mutate()}
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
      {/* Fixed arm (w-14), not a 50% grid column — below lg the detail is full-width
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
    case "consumed": {
      const sticker = consumedBySticker(event.details);
      return sticker
        ? t("floor.inventoryBinEventConsumedBy", "Consumed by {{sticker}}", { sticker })
        : t("floor.inventoryBinEventConsumed", "Consumed");
    }
    default:
      return formatCustomStatus(event.action);
  }
}

function binEventDotClass(action: string) {
  if (action === "harvested") return "bg-bambu-green";
  if (action === "visual_qc_passed" || action === "ready_for_production") return FLOOR_PASS_EVENT_DOT_CLASS;
  if (action === "wip") return "bg-amber-500";
  if (action === "empty" || action === "empty_override" || action === "consumed") return "bg-sky-500";
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
  onOpenSticker,
  onOpenBinBatch,
  onOpenSerial,
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
  onOpenSticker?: (sticker: string) => void;
  onOpenBinBatch?: (batchId: number, payload: string | null) => void;
  onOpenSerial?: (serial: string, unitId: number | null) => void;
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
      <aside className="rounded-lg border border-dashed border-bambu-dark-tertiary p-6 text-center text-sm text-bambu-gray break-words lg:sticky lg:top-6">
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
      className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100vh-3rem)] lg:flex-col lg:overflow-hidden"
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
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
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
              {t("floor.inventoryColLastScanned", "Last scanned")}
            </dt>
            <dd className="mt-0.5 text-white">
              {formatFloorDate(partLastScannedAt(part), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </dd>
          </div>
          <div>
            <dt className="text-bambu-gray">
              {t("floor.inventoryColFirstLabeled", "First labeled")}
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
                <PartHistoryTimeline
                  events={timeline}
                  partCode={part?.part_code}
                  compact
                  handlers={{
                    onOpenSticker,
                    onOpenBinBatch,
                    onOpenSerial,
                  }}
                />
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

// ── Serials tab (Part Assembly Linking, Wave 3) ───────────────────────────
//
// Reads ``GET /floor/inventory/units`` (product serials linked to a TOP + BOT
// housing pair) and lets the office unlink or replace a housing. This is the
// product-serial counterpart to the Parts tab — kept deliberately separate
// from the Parts "Registered Parts" filter, which is harvest job-match.

function replaceResultMessage(
  result: ReplaceUnitResult,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  switch (result) {
    case "top_not_found":
    case "bottom_not_found":
      return t("floor.serialReplaceNotFound", "That sticker was not found.");
    case "top_not_eligible":
      return t("floor.serialReplaceTopNotEligible", "The new top must be a TOP In WIP with a kit assigned.");
    case "bottom_not_eligible":
      return t("floor.serialReplaceBottomNotEligible", "The new bottom must be a BOT In WIP.");
    case "top_already_linked":
    case "bottom_already_linked":
      return t("floor.serialReplaceAlreadyLinked", "That housing is already on another unit.");
    case "same_part":
      return t("floor.serialReplaceSamePart", "Top and bottom must be different housings.");
    case "no_change":
      return t("floor.serialReplaceNoChange", "That housing is already on this unit.");
    default:
      return t("floor.serialActionError", "Could not save that change.");
  }
}

function replaceKitResultMessage(
  result: ReplaceUnitKitResult,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  switch (result) {
    case "no_kit":
      return t("floor.serialReplaceKitNoKit", "This unit's top has no knob/button kit to move.");
    case "invalid_slot":
      return t("floor.serialReplaceKitInvalidSlot", "Pick a knob (KNB) or button (BUT) harvest.");
    case "no_target":
      return t(
        "floor.serialReplaceKitNoTarget",
        "That harvest is not available (needs remaining parts In WIP or Ready for Production).",
      );
    default:
      return t("floor.serialActionError", "Could not save that change.");
  }
}

function kitHarvestEligible(batch: FloorBinBatch): boolean {
  return (
    (batch.status === "wip" || batch.status === "ready_for_production") &&
    batch.remaining_quantity > 0
  );
}

function FloorSerialsSection({
  onOpenPart,
  onOpenBin,
}: {
  onOpenPart: (sticker: string, unit?: FloorProductUnit | null) => void;
  onOpenBin: (
    batchId: number,
    payload: string | null,
    unit?: FloorProductUnit | null,
  ) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PartHistorySort>("last_scanned_desc");
  const selectedUnitIdRaw = searchParams.get("unit");
  const selectedUnitId =
    selectedUnitIdRaw != null && selectedUnitIdRaw !== "" && Number.isFinite(Number(selectedUnitIdRaw))
      ? Number(selectedUnitIdRaw)
      : null;
  const setSelectedUnitId = (id: number | null) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (id === null) next.delete("unit");
      else next.set("unit", String(id));
      return next;
    }, { replace: true });
  };
  const unitsQuery = useQuery({
    queryKey: ["floor-units"],
    queryFn: () => api.listUnits(),
    refetchOnMount: "always",
  });
  // Housing last-scan times for the same sort options as Part history.
  const partsQuery = useQuery({
    queryKey: ["floor-inventory-parts"],
    queryFn: () => api.getFloorInventoryParts(true),
    staleTime: 30_000,
  });
  const units = useMemo(() => unitsQuery.data ?? [], [unitsQuery.data]);
  const partsById = useMemo(() => {
    const map = new Map<number, FloorInventoryPart>();
    for (const part of partsQuery.data ?? []) map.set(part.id, part);
    return map;
  }, [partsQuery.data]);
  const selectedUnit = units.find((unit) => unit.id === selectedUnitId) ?? null;
  const unitDeepLinkMissing =
    selectedUnitId != null && unitsQuery.isSuccess && selectedUnit == null;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["floor-units"] });

  const unlinkMutation = useMutation({
    mutationFn: (unitId: number) => api.unlinkUnit(unitId),
    onSuccess: async () => {
      showToast(t("floor.serialUnlinkSuccess", "Serial unlinked; both housings back to WIP"), "success");
      setSelectedUnitId(null);
      await invalidate();
    },
    onError: () => showToast(t("floor.serialActionError", "Could not save that change."), "error"),
  });
  const replaceMutation = useMutation({
    mutationFn: ({ unitId, data }: { unitId: number; data: { top_sticker?: string; bottom_sticker?: string } }) =>
      api.replaceUnitHousing(unitId, data),
    onSuccess: async (response) => {
      if (response.result === "replaced") {
        showToast(t("floor.serialReplaceSuccess", "Housing replaced"), "success");
        await invalidate();
      } else {
        showToast(replaceResultMessage(response.result, t), "error");
      }
    },
    onError: () => showToast(t("floor.serialActionError", "Could not save that change."), "error"),
  });
  const replaceKitMutation = useMutation({
    mutationFn: ({
      unitId,
      data,
    }: {
      unitId: number;
      data: { slot: "KNB" | "BUT"; batch_id: number };
    }) => api.replaceUnitKit(unitId, data),
    onSuccess: async (response) => {
      if (response.result === "replaced") {
        showToast(
          response.new_remaining != null
            ? t("floor.serialReplaceKitSuccessRemaining", "Kit updated · {{count}} left on harvest", {
                count: response.new_remaining,
              })
            : t("floor.serialReplaceKitSuccess", "Kit harvest updated"),
          "success",
        );
        await Promise.all([
          invalidate(),
          queryClient.invalidateQueries({ queryKey: ["floor-bin-history"] }),
        ]);
      } else {
        showToast(replaceKitResultMessage(response.result, t), "error");
      }
    },
    onError: () => showToast(t("floor.serialActionError", "Could not save that change."), "error"),
  });

  const term = search.trim().toLowerCase();
  const visibleUnits = useMemo(() => {
    const filtered = term
      ? units.filter((unit) =>
          [unit.serial_code, unit.top_sticker, unit.bottom_sticker].some((value) =>
            value.toLowerCase().includes(term),
          ),
        )
      : units;
    return [...filtered].sort((left, right) => compareSerialUnits(left, right, sort, partsById));
  }, [term, units, sort, partsById]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-bambu-gray">
            {t("floor.landingEyebrow", "Production floor")}
          </p>
          <h1 className="mt-1 text-2xl font-bold text-white">
            {t("floor.serialsTitle", "Product serials")}
          </h1>
          <p className="mt-1 max-w-2xl break-words text-bambu-gray">
            {t(
              "floor.serialsSubtitle",
              "Every product serial linked to a TOP + BOT housing pair. Unlink to free a serial, or replace a housing.",
            )}
          </p>
        </div>
        <div className="relative w-full lg:w-80">
          <label className="relative block">
            <span className="sr-only">{t("floor.serialsSearchLabel", "Search serials")}</span>
            <Search
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray"
              aria-hidden="true"
            />
            <input
              className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-2.5 pl-9 pr-9 text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
              placeholder={t("floor.serialsSearchPlaceholder", "Search serial or sticker")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <button
                type="button"
                aria-label={t("common.clearSearch", "Clear search")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-bambu-gray transition-colors hover:text-white focus:outline-none focus:ring-2 focus:ring-bambu-green"
                onClick={() => setSearch("")}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </label>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <section className="min-w-0 overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-bambu-dark-tertiary p-4">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <h2 className="text-sm font-semibold text-white">
                {t("floor.serialsListTitle", "Linked units")}
              </h2>
              <label className="inline-flex min-w-0 items-center gap-1 rounded-lg bg-bambu-dark p-1">
                <span className="shrink-0 pl-2 text-sm text-bambu-gray">
                  {t("floor.inventorySortLabel", "Sort by")}
                </span>
                <div className="relative min-w-0">
                  <select
                    value={sort}
                    onChange={(event) => setSort(event.target.value as PartHistorySort)}
                    className="w-full min-w-[12rem] appearance-none rounded-md bg-bambu-dark-secondary py-1.5 pl-2.5 pr-8 text-sm text-white transition-colors hover:text-white focus:border-bambu-green focus:outline-none focus:ring-1 focus:ring-bambu-green sm:min-w-[14rem]"
                    aria-label={t("floor.inventorySortLabel", "Sort by")}
                  >
                    {PART_HISTORY_SORT_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {t(option.labelKey, option.fallback)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray"
                    aria-hidden="true"
                  />
                </div>
              </label>
            </div>
            <p className="text-sm text-bambu-gray">
              {visibleUnits.length === 1
                ? t("floor.inventoryRecordCountOne", "{{count}} record", { count: visibleUnits.length })
                : t("floor.inventoryRecordCountMany", "{{count}} records", { count: visibleUnits.length })}
            </p>
          </div>
          {unitsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-16 text-bambu-gray">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t("floor.serialsLoading", "Loading product serials…")}
            </div>
          ) : unitsQuery.isError ? (
            <div className="px-4 py-16 text-center">
              <p className="font-medium text-white">
                {t("floor.serialsLoadError", "Could not load product serials")}
              </p>
              <Button className="mt-3" variant="secondary" onClick={() => unitsQuery.refetch()}>
                {t("common.retry", "Retry")}
              </Button>
            </div>
          ) : visibleUnits.length === 0 ? (
            <div className="px-4 py-16 text-center text-bambu-gray">
              {search
                ? t("floor.serialsEmptySearch", "No serials match that search.")
                : t("floor.serialsEmpty", "No product serials linked yet.")}
            </div>
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <table className={INVENTORY_TABLE_CLASS}>
                <thead className={INVENTORY_THEAD_CLASS}>
                  <tr>
                    <th className="px-4 py-3 font-medium">{t("floor.serialsColSerial", "Serial")}</th>
                    <th className="whitespace-nowrap px-4 py-3 font-medium">
                      {t("floor.inventoryColStatus", "Status")}
                    </th>
                    <th className="px-4 py-3 font-medium">{t("floor.serialsColTop", "Top")}</th>
                    <th className="px-4 py-3 font-medium">{t("floor.serialsColBottom", "Bottom")}</th>
                    <th className="px-4 py-3 font-medium">{t("floor.serialsColKnob", "Knob bin")}</th>
                    <th className="px-4 py-3 font-medium">{t("floor.serialsColButton", "Button bin")}</th>
                    <th className="px-4 py-3 font-medium">{t("floor.serialsColLinked", "Linked")}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUnits.map((unit) => {
                    const { className: statusPillClass, label: statusText } = unitStatusPresentation(
                      unitWorkflowRowStatus(unit.unit_workflow_status),
                      t,
                    );
                    return (
                    <tr
                      key={unit.id}
                      tabIndex={0}
                      onClick={() => setSelectedUnitId(unit.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") setSelectedUnitId(unit.id);
                      }}
                      className={`cursor-pointer ${INVENTORY_ROW_CLASS} transition-colors hover:bg-bambu-dark-tertiary/60 focus:bg-bambu-dark-tertiary/60 focus:outline-none ${selectedUnitId === unit.id ? "bg-bambu-dark-tertiary/60" : ""}`}
                    >
                      <td className={`${INVENTORY_CELL_CLASS} break-all font-mono font-medium text-white`}>{unit.serial_code}</td>
                      <td className={`${INVENTORY_CELL_CLASS} md:whitespace-nowrap`}>
                        <span className={`${STATUS_PILL_CLASS} ${statusPillClass}`}>{statusText}</span>
                      </td>
                      <td className={`${INVENTORY_CELL_CLASS} break-all font-mono text-bambu-gray-light`}>{unit.top_sticker}</td>
                      <td className={`${INVENTORY_CELL_CLASS} break-all font-mono text-bambu-gray-light`}>{unit.bottom_sticker}</td>
                      <td className={`${INVENTORY_CELL_CLASS} font-mono text-bambu-gray-light`}>
                        {unit.knob_bin_payload ?? t("floor.serialsNoBin", "—")}
                      </td>
                      <td className={`${INVENTORY_CELL_CLASS} font-mono text-bambu-gray-light`}>
                        {unit.button_bin_payload ?? t("floor.serialsNoBin", "—")}
                      </td>
                      <td className={`${INVENTORY_CELL_CLASS} text-bambu-gray md:whitespace-nowrap`}>
                        {formatFloorDate(unit.linked_at, { dateStyle: "medium", timeStyle: "short" })}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {selectedUnit ? (
          <UnitAssemblyCard
            unit={selectedUnit}
            unlinkPending={unlinkMutation.isPending}
            replacePending={replaceMutation.isPending}
            replaceKitPending={replaceKitMutation.isPending}
            onOpenPart={onOpenPart}
            onOpenBin={onOpenBin}
            onClose={() => setSelectedUnitId(null)}
            onUnlink={() => unlinkMutation.mutate(selectedUnit.id)}
            onReplace={(slot, sticker) =>
              replaceMutation.mutate({
                unitId: selectedUnit.id,
                data: slot === "top" ? { top_sticker: sticker } : { bottom_sticker: sticker },
              })
            }
            onReplaceKit={(slot, batchId) =>
              replaceKitMutation.mutate({
                unitId: selectedUnit.id,
                data: { slot, batch_id: batchId },
              })
            }
          />
        ) : (
          <aside className="rounded-lg border border-dashed border-bambu-dark-tertiary p-6 text-center text-sm text-bambu-gray break-words lg:sticky lg:top-6">
            {unitDeepLinkMissing
              ? t(
                  "floor.serialsUnitNotFound",
                  "That serial is not in the list — it may have been unlinked. Pick a row below.",
                )
              : t(
                  "floor.serialsSelectPrompt",
                  "Select a serial to see its assembly, unlink it, or replace a housing.",
                )}
          </aside>
        )}
      </div>
    </div>
  );
}

function UnitAssemblyCard({
  unit,
  unlinkPending,
  replacePending,
  replaceKitPending,
  onOpenPart,
  onOpenBin,
  onClose,
  onUnlink,
  onReplace,
  onReplaceKit,
}: {
  unit: FloorProductUnit;
  unlinkPending: boolean;
  replacePending: boolean;
  replaceKitPending: boolean;
  onOpenPart: (sticker: string, unit?: FloorProductUnit | null) => void;
  onOpenBin: (
    batchId: number,
    payload: string | null,
    unit?: FloorProductUnit | null,
  ) => void;
  onClose: () => void;
  onUnlink: () => void;
  onReplace: (slot: "top" | "bottom", sticker: string) => void;
  onReplaceKit: (slot: "KNB" | "BUT", batchId: number) => void;
}) {
  const { t } = useTranslation();
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [replaceSlot, setReplaceSlot] = useState<"top" | "bottom" | null>(null);
  const [replaceKitSlot, setReplaceKitSlot] = useState<"KNB" | "BUT" | null>(null);
  const [pickedBatchId, setPickedBatchId] = useState<number | null>(null);
  const [newSticker, setNewSticker] = useState("");

  useEffect(() => {
    setUnlinkOpen(false);
    setReplaceSlot(null);
    setReplaceKitSlot(null);
    setPickedBatchId(null);
    setNewSticker("");
  }, [unit.id]);

  const harvestQuery = useQuery({
    queryKey: ["floor-bin-history"],
    queryFn: () => api.getFloorBinHistory(),
    enabled: replaceKitSlot != null,
    staleTime: 30_000,
  });

  const kitCandidates = useMemo(() => {
    if (replaceKitSlot == null) return [];
    const rows = (harvestQuery.data ?? [])
      .map((row) => row.batch)
      .filter((batch): batch is FloorBinBatch => batch != null && batch.part_code === replaceKitSlot);
    // Newest harvests first; eligible ones stay selectable, empty/past stay listed
    // but disabled so the office can see every fill of that type.
    return [...rows].sort((a, b) => b.id - a.id);
  }, [harvestQuery.data, replaceKitSlot]);

  const trimmed = newSticker.trim().toUpperCase();
  const stickerLooksValid = /^BBD-\d{6}$/.test(trimmed);
  const currentKitBatchId =
    replaceKitSlot === "KNB" ? unit.knob_batch_id : replaceKitSlot === "BUT" ? unit.button_batch_id : null;

  const openKitBatch = (batchId: number | null | undefined, payload: string | null | undefined) => {
    if (batchId == null) return;
    onOpenBin(batchId, payload ?? null, unit);
  };

  const { className: statusPillClass, label: statusText } = unitStatusPresentation(
    unitWorkflowRowStatus(unit.unit_workflow_status),
    t,
  );

  return (
    <aside
      className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100vh-3rem)] lg:flex-col lg:overflow-hidden"
      aria-label={t("floor.serialAssemblyLabel", "Assembly detail")}
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-bambu-dark-tertiary p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-bambu-green">
            {t("floor.serialAssemblyEyebrow", "Product serial")}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-lg font-semibold text-white">{unit.serial_code}</h2>
            <span className={`${STATUS_PILL_CLASS} ${statusPillClass}`}>{statusText}</span>
          </div>
        </div>
        <button
          type="button"
          className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
          onClick={onClose}
          aria-label={t("floor.serialAssemblyClose", "Close assembly detail")}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
          <div>
            <dt className="text-bambu-gray">{t("floor.serialsColTop", "Top")}</dt>
            <dd className="mt-0.5">
              <button
                type="button"
                onClick={() => onOpenPart(unit.top_sticker, unit)}
                aria-label={t("floor.serialOpenPart", "Open part {{sticker}}", {
                  sticker: unit.top_sticker,
                })}
                className={ASSEMBLY_LINK_CLASS}
              >
                {unit.top_sticker}
              </button>
            </dd>
          </div>
          <div>
            <dt className="text-bambu-gray">{t("floor.serialsColBottom", "Bottom")}</dt>
            <dd className="mt-0.5">
              <button
                type="button"
                onClick={() => onOpenPart(unit.bottom_sticker, unit)}
                aria-label={t("floor.serialOpenPart", "Open part {{sticker}}", {
                  sticker: unit.bottom_sticker,
                })}
                className={ASSEMBLY_LINK_CLASS}
              >
                {unit.bottom_sticker}
              </button>
            </dd>
          </div>
          <div>
            <dt className="text-bambu-gray">{t("floor.serialAssemblyKnob", "Knob batch")}</dt>
            <dd className="mt-0.5 font-mono text-white">
              {unit.knob_batch_id != null ? (
                <button
                  type="button"
                  onClick={() => openKitBatch(unit.knob_batch_id, unit.knob_bin_payload)}
                  aria-label={t("floor.serialOpenBinBatch", "Open bin batch {{payload}} · #{{id}}", {
                    payload: unit.knob_bin_payload ?? "KNB",
                    id: unit.knob_batch_id,
                  })}
                  className={ASSEMBLY_LINK_CLASS}
                >
                  {unit.knob_bin_payload ?? "KNB"}
                  {` · #${unit.knob_batch_id}`}
                </button>
              ) : (
                t("floor.serialsNoBin", "—")
              )}
            </dd>
          </div>
          <div>
            <dt className="text-bambu-gray">{t("floor.serialAssemblyButton", "Button batch")}</dt>
            <dd className="mt-0.5 font-mono text-white">
              {unit.button_batch_id != null ? (
                <button
                  type="button"
                  onClick={() => openKitBatch(unit.button_batch_id, unit.button_bin_payload)}
                  aria-label={t("floor.serialOpenBinBatch", "Open bin batch {{payload}} · #{{id}}", {
                    payload: unit.button_bin_payload ?? "BUT",
                    id: unit.button_batch_id,
                  })}
                  className={ASSEMBLY_LINK_CLASS}
                >
                  {unit.button_bin_payload ?? "BUT"}
                  {` · #${unit.button_batch_id}`}
                </button>
              ) : (
                t("floor.serialsNoBin", "—")
              )}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-bambu-gray">{t("floor.serialsColLinked", "Linked")}</dt>
            <dd className="mt-0.5 text-white">
              {formatFloorDate(unit.linked_at, { dateStyle: "medium", timeStyle: "short" })}
            </dd>
          </div>
        </dl>
      </div>
      <div className="shrink-0 space-y-3 border-t border-bambu-dark-tertiary p-4">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => { setReplaceSlot("top"); setNewSticker(""); }}>
            <Link2 className="h-4 w-4" />
            {t("floor.serialReplaceTop", "Replace top")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => { setReplaceSlot("bottom"); setNewSticker(""); }}>
            <Link2 className="h-4 w-4" />
            {t("floor.serialReplaceBottom", "Replace bottom")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setReplaceKitSlot("KNB");
              setPickedBatchId(null);
            }}
          >
            <Hash className="h-4 w-4" />
            {t("floor.serialReplaceKnob", "Replace knob")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setReplaceKitSlot("BUT");
              setPickedBatchId(null);
            }}
          >
            <Hash className="h-4 w-4" />
            {t("floor.serialReplaceButton", "Replace button")}
          </Button>
          <Button size="sm" variant="danger" onClick={() => setUnlinkOpen(true)}>
            <Unlink className="h-4 w-4" />
            {t("floor.serialUnlink", "Unlink")}
          </Button>
        </div>
      </div>
      {unlinkOpen && (
        <ConfirmModal
          title={t("floor.serialUnlinkTitle", "Unlink this serial?")}
          message={t(
            "floor.serialUnlinkMessage",
            "Frees serial {{serial}} and returns both housings to WIP so they can be reused.",
            { serial: unit.serial_code },
          )}
          confirmText={t("floor.serialUnlinkConfirm", "Unlink unit")}
          variant="danger"
          isLoading={unlinkPending}
          onCancel={() => setUnlinkOpen(false)}
          onConfirm={() => {
            onUnlink();
            setUnlinkOpen(false);
          }}
        />
      )}
      {replaceSlot && (
        <ConfirmModal
          title={
            replaceSlot === "top"
              ? t("floor.serialReplaceTopTitle", "Replace the top housing?")
              : t("floor.serialReplaceBottomTitle", "Replace the bottom housing?")
          }
          message={t(
            "floor.serialReplaceMessage",
            "Enter the new housing's BBD- sticker (six digits). Replacing the top also updates the kit knob/button from that top. The old housing returns to WIP; the new one ships.",
          )}
          confirmText={t("floor.serialReplaceConfirm", "Replace housing")}
          confirmDisabled={!stickerLooksValid}
          isLoading={replacePending}
          onCancel={() => setReplaceSlot(null)}
          onConfirm={() => {
            onReplace(replaceSlot, trimmed);
            setReplaceSlot(null);
          }}
        >
          <input
            type="text"
            autoFocus
            aria-label={
              replaceSlot === "top"
                ? t("floor.serialReplaceTopInput", "New top sticker")
                : t("floor.serialReplaceBottomInput", "New bottom sticker")
            }
            placeholder="BBD-000000"
            value={newSticker}
            onChange={(event) => setNewSticker(event.target.value)}
            className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 font-mono text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
          />
          {trimmed.length > 0 && !stickerLooksValid ? (
            <p className="mt-2 text-xs text-amber-400">
              {t("floor.serialReplaceStickerHint", "Use a part sticker like BBD-000123")}
            </p>
          ) : null}
        </ConfirmModal>
      )}
      {replaceKitSlot && (
        <ConfirmModal
          title={
            replaceKitSlot === "KNB"
              ? t("floor.serialReplaceKnobTitle", "Replace the knob harvest?")
              : t("floor.serialReplaceButtonTitle", "Replace the button harvest?")
          }
          message={t(
            "floor.serialReplaceKitMessage",
            "Pick any past or current {{type}} harvest with remaining parts. The previous fill is restored +1 and the new fill is consumed −1.",
            { type: replaceKitSlot },
          )}
          confirmText={t("floor.serialReplaceKitConfirm", "Replace harvest")}
          confirmDisabled={
            pickedBatchId == null ||
            pickedBatchId === currentKitBatchId ||
            !kitCandidates.some((batch) => batch.id === pickedBatchId && kitHarvestEligible(batch))
          }
          isLoading={replaceKitPending}
          onCancel={() => setReplaceKitSlot(null)}
          onConfirm={() => {
            if (pickedBatchId == null) return;
            onReplaceKit(replaceKitSlot, pickedBatchId);
            setReplaceKitSlot(null);
          }}
        >
          {harvestQuery.isLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-bambu-gray">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("floor.serialReplaceKitLoading", "Loading harvests…")}
            </div>
          ) : harvestQuery.isError ? (
            <p className="py-2 text-sm text-amber-400">
              {t("floor.serialReplaceKitLoadError", "Could not load bin harvests.")}
            </p>
          ) : kitCandidates.length === 0 ? (
            <p className="py-2 text-sm text-bambu-gray">
              {t("floor.serialReplaceKitEmpty", "No {{type}} harvests on record yet.", {
                type: replaceKitSlot,
              })}
            </p>
          ) : (
            <ul
              className="max-h-64 space-y-1 overflow-y-auto"
              role="listbox"
              aria-label={t("floor.serialReplaceKitList", "Available harvests")}
            >
              {kitCandidates.map((batch) => {
                const eligible = kitHarvestEligible(batch);
                const selected = pickedBatchId === batch.id;
                const current = currentKitBatchId === batch.id;
                return (
                  <li key={batch.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={!eligible || current}
                      onClick={() => setPickedBatchId(batch.id)}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left font-mono text-sm transition-colors ${
                        selected
                          ? "border-bambu-green bg-bambu-green/10 text-white"
                          : "border-bambu-dark-tertiary bg-bambu-dark text-bambu-gray-light hover:border-bambu-gray"
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <span>
                        {batch.payload}
                        {` · #${batch.id}`}
                        {current
                          ? ` · ${t("floor.serialReplaceKitCurrent", "current")}`
                          : ""}
                      </span>
                      <span className="shrink-0 text-xs text-bambu-gray">
                        {eligible
                          ? t("floor.serialReplaceKitRemaining", "{{count}} left", {
                              count: batch.remaining_quantity,
                            })
                          : t("floor.serialReplaceKitUnavailable", "unavailable")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </ConfirmModal>
      )}
    </aside>
  );
}
