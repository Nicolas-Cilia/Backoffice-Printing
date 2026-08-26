import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Clock3,
  Link2,
  Loader2,
  Search,
  Tag,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import { Button } from "../components/Button";
import { ConfirmModal } from "../components/ConfirmModal";
import {
  api,
  type FloorInventoryPart,
  type FloorInventoryPartEvent,
  type FloorPartJobCandidate,
  type JobSearchResult,
} from "../api/client";
import { useToast } from "../contexts/ToastContext";
import { formatFloorDate } from "../utils/floorScan";

type PartFilter = "all" | "attention" | "linked" | "archived";
const EMPTY_PARTS: FloorInventoryPart[] = [];

function isAttention(part: FloorInventoryPart) {
  return !part.archived_at && part.archive_id === null;
}
function isLinked(part: FloorInventoryPart) {
  return !part.archived_at && part.archive_id !== null;
}

export function FloorInventoryPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<PartFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const filters: Array<{ id: PartFilter; label: string }> = [
    { id: "all", label: t("floor.inventoryFilterAll", "All parts") },
    { id: "attention", label: t("floor.inventoryFilterAttention", "Needs matching") },
    { id: "linked", label: t("floor.inventoryFilterLinked", "Linked parts") },
    { id: "archived", label: t("floor.inventoryFilterArchived", "Archived") },
  ];
  const partsQuery = useQuery({
    queryKey: ["floor-inventory-parts"],
    queryFn: () => api.getFloorInventoryParts(true),
    refetchOnMount: "always",
  });
  const records = partsQuery.data ?? EMPTY_PARTS;
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
          const latestEvent = events?.at(-1);
          const part = activeRecords[index];
          return latestEvent && part
            ? [[part.id, latestEvent.action] as const]
            : [];
        }),
      ),
    [activeRecords, historyQueries],
  );
  const selectedPart = records.find((part) => part.id === selectedId) ?? null;
  const eventsQuery = useQuery({
    queryKey: ["floor-inventory-part-events", selectedId],
    queryFn: () => api.getFloorInventoryPartEvents(selectedId!),
    enabled: selectedId !== null,
  });
  useEffect(() => {
    const latestEventAction = eventsQuery.data?.at(-1)?.action;
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
  const counts = useMemo(
    () => ({
      active: records.filter(isLinked).length,
      attention: records.filter(isAttention).length,
      archived: records.filter((part) => part.archived_at).length,
    }),
    [records],
  );
  const visibleParts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return records.filter((part) => {
      const included =
        filter === "all"
          ? !part.archived_at
          : filter === "attention"
            ? isAttention(part)
            : filter === "linked"
              ? isLinked(part)
              : Boolean(part.archived_at);
      return (
        included &&
        (!term ||
          [part.sticker_code, part.print_name, part.printer_name].some(
            (value) => value?.toLowerCase().includes(term),
          ))
      );
    });
  }, [filter, records, search]);
  const hiddenByFilter =
    !partsQuery.isLoading &&
    !partsQuery.isError &&
    !search.trim() &&
    records.length > 0 &&
    visibleParts.length === 0;
  const saveError =
    archiveMutation.isError ||
    relinkMutation.isError ||
    unlinkMutation.isError ||
    replaceStickerMutation.isError ||
    deleteMutation.isError
      ? t("floor.inventorySaveError", "Could not save that change.")
      : null;

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-bambu-gray">
            {t("floor.landingEyebrow", "Production floor")}
          </p>
          <h1 className="mt-1 text-2xl font-bold text-white">
            {t("floor.inventoryTitle", "Part history")}
          </h1>
          <p className="mt-1 max-w-2xl text-bambu-gray">
            {t(
              "floor.inventorySubtitle",
              "Trace each stickered part back to its harvest and completed job. Resolve only the records that could not be linked at harvest.",
            )}
          </p>
        </div>
        <label className="relative block w-full lg:w-80">
          <span className="sr-only">
            {t("floor.inventorySearchLabel", "Search part history")}
          </span>
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray"
            aria-hidden="true"
          />
          <input
            className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
            placeholder={t(
              "floor.inventorySearchPlaceholder",
              "Search sticker, job, or printer",
            )}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <div className="grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard
          label={t("floor.inventoryFilterAttention", "Needs matching")}
          count={counts.attention}
          accent="amber"
          onClick={() => setFilter("attention")}
        />
        <SummaryCard
          label={t("floor.inventoryActiveLinked", "Active linked parts")}
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
        <section className="overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary">
          <div className="flex flex-col gap-3 border-b border-bambu-dark-tertiary p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="inline-flex self-start rounded-lg bg-bambu-dark p-1">
              {filters.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  className={`rounded-md px-3 py-1.5 text-sm transition-colors ${filter === item.id ? "bg-bambu-green text-white" : "text-bambu-gray hover:text-white"}`}
                >
                  {item.label}
                  {item.id === "attention" && counts.attention > 0
                    ? ` (${counts.attention})`
                    : ""}
                </button>
              ))}
            </div>
            <p className="text-sm text-bambu-gray">
              {visibleParts.length === 1
                ? t("floor.inventoryRecordCountOne", "{{count}} record", {
                    count: visibleParts.length,
                  })
                : t("floor.inventoryRecordCountMany", "{{count}} records", {
                    count: visibleParts.length,
                  })}
            </p>
          </div>
          {partsQuery.isLoading ? (
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
          ) : visibleParts.length === 0 ? (
            <div className="px-4 py-16 text-center text-bambu-gray">
              {hiddenByFilter ? (
                <div className="space-y-3">
                  <p>
                    {t(
                      "floor.inventoryHiddenByFilter",
                      "No records in this view, but part history has {{count}} saved.",
                      { count: records.length },
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
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="border-b border-bambu-dark-tertiary text-xs uppercase tracking-wide text-bambu-gray">
                  <tr>
                    <th className="px-4 py-3 font-medium">
                      {t("floor.inventoryColSticker", "Sticker")}
                    </th>
                    <th className="px-4 py-3 font-medium">
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
                  {visibleParts.map((part) => {
                    const latestEventAction =
                      latestEventActions.get(part.id) ??
                      part.latest_event_action ??
                      null;
                    return (
                    <tr
                      key={part.id}
                      tabIndex={0}
                      onClick={() => setSelectedId(part.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ")
                          setSelectedId(part.id);
                      }}
                      className={`cursor-pointer border-b border-bambu-dark-tertiary last:border-0 transition-colors hover:bg-bambu-dark-tertiary/60 focus:bg-bambu-dark-tertiary/60 focus:outline-none ${selectedId === part.id ? "bg-bambu-dark-tertiary/60" : ""}`}
                    >
                      <td className="px-4 py-3 font-mono font-medium text-white">
                        {part.sticker_code}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusClass(part, latestEventAction)}`}
                        >
                          {statusLabel(part, t, latestEventAction)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-white">
                        {part.print_name ?? (
                          <span className="text-bambu-gray">
                            {t("floor.inventoryNoJob", "No completed job")}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-bambu-gray-light">
                        {part.printer_name ??
                          t("floor.inventoryDeletedPrinter", "Deleted printer")}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-bambu-gray">
                        {formatFloorDate(part.labeled_at, {
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
        </section>
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
          onDelete={() => selectedPart && deleteMutation.mutate(selectedPart.id)}
        />
      </div>
    </div>
  );
}

function statusLabel(
  part: FloorInventoryPart,
  t: ReturnType<typeof useTranslation>["t"],
  latestEventAction = part.latest_event_action ?? null,
) {
  return part.archived_at
    ? t("floor.inventoryStatusArchived", "Archived")
    : latestEventAction === "fit_check" || latestEventAction === "fit_checked"
      ? t("floor.inventoryStatusFitCheckPass", "Fit Check Pass")
    : latestEventAction === "sanding"
      ? t("floor.inventoryStatusSanding", "Sanding")
    : latestEventAction === "cleanup" || latestEventAction === "cleaned_up"
      ? t("floor.inventoryStatusCleanupPass", "Cleanup Pass")
    : latestEventAction === "wip" || latestEventAction === "in_wip"
      ? t("floor.inventoryStatusWip", "In WIP")
    : latestEventAction === "shipped"
      ? t("floor.inventoryStatusShipped", "Shipped")
    : part.archive_id === null
      ? t("floor.inventoryFilterAttention", "Needs matching")
      : t("floor.inventoryStatusLinked", "Linked");
}

function statusClass(
  part: FloorInventoryPart,
  latestEventAction = part.latest_event_action ?? null,
) {
  return part.archived_at
    ? "bg-bambu-dark-tertiary text-bambu-gray-light"
    : latestEventAction === "fit_check" || latestEventAction === "fit_checked"
      ? "border border-green-400/50 bg-green-500/20 text-green-300 shadow-sm shadow-green-500/20"
    : latestEventAction === "sanding"
      ? "border border-orange-400/50 bg-orange-500/20 text-orange-300 shadow-sm shadow-orange-500/20"
    : latestEventAction === "cleanup" || latestEventAction === "cleaned_up"
      ? "border border-emerald-400/50 bg-emerald-500/20 text-emerald-300 shadow-sm shadow-emerald-500/20"
    : latestEventAction === "wip" || latestEventAction === "in_wip"
      ? "border border-amber-400/50 bg-amber-500/20 text-amber-300 shadow-sm shadow-amber-500/20"
    : latestEventAction === "shipped"
      ? "border border-sky-400/50 bg-sky-500/20 text-sky-300 shadow-sm shadow-sky-500/20"
    : part.archive_id === null
      ? "bg-amber-500/15 text-amber-300 border border-amber-500/25"
      : "bg-bambu-green/15 text-bambu-green-light border border-bambu-green/25";
}

function eventLabel(
  event: FloorInventoryPartEvent,
  t: ReturnType<typeof useTranslation>["t"],
) {
  const archiveId = event.details?.archive_id;
  switch (event.action) {
    case "enrolled":
      return archiveId
        ? t(
            "floor.inventoryEventEnrolledLinked",
            "Sticker enrolled · linked at harvest",
          )
        : t(
            "floor.inventoryEventEnrolledNoJob",
            "Sticker enrolled · no job found at harvest",
          );
    case "scanned":
      return t("floor.inventoryEventScanned", "Scanned at floor");
    case "relinked":
      return t("floor.inventoryEventRelinked", "Matched to completed job");
    case "relinked_by_scan":
      return t("floor.inventoryEventRelinkedByScan", "Linked by scanner");
    case "fit_check":
    case "fit_checked":
      return t("floor.inventoryEventFitChecked", "Fit checked · Initial QC passed");
    case "sanding": {
      const reasonCode = event.details?.reason_code;
      const reasonText = event.details?.reason_text;
      const reason =
        typeof reasonCode === "string" && reasonCode !== "other"
          ? reasonCode.replaceAll("_", " ")
          : (typeof reasonText === "string" && reasonText) || null;
      return reason
        ? t("floor.inventoryEventSandingWithReason", "Sent to Sanding · {{reason}}", { reason })
        : t("floor.inventoryEventSanding", "Sent to Sanding");
    }
    case "cleanup":
    case "cleaned_up":
      return t("floor.inventoryEventCleanedUp", "Cleaned up");
    case "archived":
      return t("floor.inventoryEventArchived", "Archived from active view");
    case "restored":
      return t("floor.inventoryEventRestored", "Restored to active view");
    case "unlinked": {
      const reasonCode = event.details?.reason_code;
      const reasonText = event.details?.reason_text;
      const reason =
        reasonCode === "wrong_job"
          ? t("floor.inventoryUnlinkReasonWrongJob", "Wrong job matched")
          : reasonCode === "wrong_printer"
            ? t(
                "floor.inventoryUnlinkReasonWrongPrinter",
                "Wrong printer scanned",
              )
            : reasonCode === "other"
              ? (typeof reasonText === "string" && reasonText) ||
                t("floor.inventoryReasonOther", "Other")
              : null;
      return reason
        ? t(
            "floor.inventoryEventUnlinkedWithReason",
            "Job link removed · {{reason}}",
            { reason },
          )
        : t("floor.inventoryEventUnlinked", "Job link removed");
    }
    case "sticker_replaced": {
      const previousCode = event.details?.previous_code;
      const newCode = event.details?.new_code;
      return typeof previousCode === "string" && typeof newCode === "string"
        ? t(
            "floor.inventoryEventStickerReplacedWithCodes",
            "Sticker replaced · {{previousCode}} → {{newCode}}",
            { previousCode, newCode },
          )
        : t("floor.inventoryEventStickerReplaced", "Sticker replaced");
    }
    default:
      return event.action.replaceAll("_", " ");
  }
}

/** Always includes enroll from the part row; merges API audit events on top. */
function buildPartTimeline(
  part: FloorInventoryPart,
  events: FloorInventoryPartEvent[],
): FloorInventoryPartEvent[] {
  const extras = events.filter((event) => event.action !== "enrolled");
  const enrolledFromApi = events.find((event) => event.action === "enrolled");
  const enrolled: FloorInventoryPartEvent = enrolledFromApi ?? {
    id: -part.id,
    action: "enrolled",
    details: part.archive_id != null ? { archive_id: part.archive_id } : null,
    occurred_at: part.labeled_at,
  };
  return [enrolled, ...extras].sort(
    (left, right) =>
      new Date(left.occurred_at).getTime() -
      new Date(right.occurred_at).getTime(),
  );
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
  saveError,
  onClose,
  onRelink,
  onArchive,
  onUnlink,
  onReplaceSticker,
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
  useEffect(() => {
    setUnlinkOpen(false);
    setUnlinkReasonCode("wrong_job");
    setUnlinkReasonText("");
    setStickerOpen(false);
    setNewStickerCode("");
    setStickerReasonCode("damaged");
    setStickerReasonText("");
    setDeleteOpen(false);
  }, [part?.id]);
  if (!part)
    return (
      <aside className="rounded-lg border border-dashed border-bambu-dark-tertiary p-6 text-center text-sm text-bambu-gray xl:sticky xl:top-6">
        {t(
          "floor.inventoryDetailEmpty",
          "Select a part record to inspect its harvest evidence and event history.",
        )}
      </aside>
    );
  const needsMatching = isAttention(part);
  const timeline = buildPartTimeline(part, events);
  const latestEventAction = timeline.at(-1)?.action ?? null;
  return (
    <aside
      className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary xl:sticky xl:top-6"
      aria-label={t("floor.inventoryDetailLabel", "Part detail")}
    >
      <div className="flex items-start justify-between gap-3 border-b border-bambu-dark-tertiary p-4">
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
      <div className="space-y-5 p-4">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusClass(part, latestEventAction)}`}
          >
            {statusLabel(part, t, latestEventAction)}
          </span>
          {needsMatching && (
            <span className="text-xs text-amber-300">
              {t(
                "floor.inventoryNeedsMatchingHint",
                "A job was not available at harvest.",
              )}
            </span>
          )}
        </div>
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
        <section>
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-bambu-gray" />
            <h3 className="font-medium text-white">
              {t("floor.inventoryHistoryHeading", "History")}
            </h3>
          </div>
          <ol className="mt-3 space-y-3 border-l border-bambu-dark-tertiary pl-4">
            {timeline.map((event) => (
              <li key={event.id} className="relative text-sm">
                <span
                  className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ${
                    event.action === "enrolled" ||
                    event.action === "relinked" ||
                    event.action === "relinked_by_scan"
                      ? "bg-bambu-green"
                      : event.action === "fit_check" ||
                          event.action === "fit_checked"
                        ? "bg-green-500"
                        : event.action === "sanding"
                          ? "bg-orange-500"
                      : "bg-bambu-gray"
                  }`}
                />
                <p className="text-white">{eventLabel(event, t)}</p>
                <p className="text-xs text-bambu-gray">
                  {formatFloorDate(event.occurred_at, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              </li>
            ))}
          </ol>
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
        <div className="space-y-3 border-t border-bambu-dark-tertiary pt-4">
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
      <div className="mt-3 inline-flex rounded-lg bg-bambu-dark p-1 text-xs">
        <button
          type="button"
          onClick={() => setMode("recent")}
          className={`rounded-md px-2 py-1 transition-colors ${mode === "recent" ? "bg-bambu-green text-white" : "text-bambu-gray hover:text-white"}`}
        >
          {t("floor.inventoryMatchModeRecent", "Recent on this printer")}
        </button>
        <button
          type="button"
          onClick={() => setMode("search")}
          className={`rounded-md px-2 py-1 transition-colors ${mode === "search" ? "bg-bambu-green text-white" : "text-bambu-gray hover:text-white"}`}
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
