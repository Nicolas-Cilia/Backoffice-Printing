import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { render } from "../utils";
import { server } from "../mocks/server";
import { FloorInventoryPage } from "../../pages/FloorInventoryPage";

const PARTS = [
  {
    id: 1,
    sticker_code: "BBD-000101",
    printer_id: 4,
    printer_name: "X1 Carbon 04",
    archive_id: 31,
    print_name: "Cable guide",
    labeled_at: "2026-08-25T14:31:00",
    archived_at: null,
    released_at: null,
  },
  {
    id: 2,
    sticker_code: "BBD-000102",
    printer_id: 4,
    printer_name: "X1 Carbon 04",
    archive_id: null,
    print_name: null,
    labeled_at: "2026-08-25T14:32:00",
    archived_at: null,
    released_at: null,
  },
  {
    id: 3,
    sticker_code: "BBD-000103",
    printer_id: 5,
    printer_name: "P1S 02",
    archive_id: 32,
    print_name: "Bracket",
    labeled_at: "2026-08-24T14:32:00",
    archived_at: "2026-08-25T15:00:00",
    released_at: null,
  },
];

/** Part/status filter <option>s reuse badge labels — ignore options in assertions. */
function getStatusLabels(text: string) {
  return screen.getAllByText(text).filter((element) => element.tagName !== "OPTION");
}

async function findStatusLabels(text: string) {
  return waitFor(() => {
    const labels = getStatusLabels(text);
    expect(labels.length).toBeGreaterThan(0);
    return labels;
  });
}

function mockPartHistory() {
  server.use(
    http.get("/api/v1/floor/inventory/parts", () => HttpResponse.json(PARTS)),
    http.get("/api/v1/floor/inventory/print-failures", () => HttpResponse.json([])),
    http.get("/api/v1/floor/inventory/parts/:id/events", ({ params }) =>
      HttpResponse.json([
        {
          id: 10,
          action: "enrolled",
          details: { archive_id: Number(params.id) === 1 ? 31 : null },
          occurred_at: "2026-08-25T14:32:00",
        },
      ]),
    ),
    http.get("/api/v1/floor/inventory/parts/:id/job-candidates", () =>
      HttpResponse.json([
        {
          id: 41,
          print_name: "Cable guide",
          completed_at: "2026-08-25T14:20:00",
        },
      ]),
    ),
  );
}

describe("FloorInventoryPage", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("keeps bin management under Part history instead of Filament Tracking", async () => {
    mockPartHistory();
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-KNB-1",
            bin_number: 1,
            part_code: "KNB",
            part_name: "Knob bin",
            status: "available",
            batch: null,
          },
        ]),
      ),
    );
    const user = userEvent.setup();
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("button", { name: "Bins" }));

    expect(await screen.findByRole("heading", { name: "Part bins" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Part history" })).toBeInTheDocument();
    expect(screen.getByText("BBN-KNB-1")).toBeInTheDocument();
  });

  it("keeps filter pill labels and status badges from wrapping inside themselves", async () => {
    mockPartHistory();
    render(<FloorInventoryPage />);

    const printFailureLog = await screen.findByRole("button", { name: "Print failure log" });
    expect(printFailureLog).toHaveClass("whitespace-nowrap", "shrink-0");
    expect(printFailureLog.parentElement).toHaveClass("flex-nowrap");

    const statusBadge = await screen.findByText("Linked");
    expect(statusBadge).toHaveClass("whitespace-nowrap");
  });

  it("shows active knob and button bin fills in the part history table", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-KNB-1",
            bin_number: 1,
            part_code: "KNB",
            part_name: "Knob bin",
            status: "visual_qc_passed",
            batch: {
              id: 101,
              payload: "BBN-KNB-1",
              bin_number: 1,
              printer_id: 4,
              printer_name: "X1 Carbon 04",
              archive_id: 31,
              print_name: "Knob plate",
              part_code: "KNB",
              quantity: 20,
              qc_passed_quantity: 18,
              remaining_quantity: 18,
              status: "visual_qc_passed",
              harvested_at: "2026-08-26T14:35:00",
            },
          },
          {
            payload: "BBN-BUT-2",
            bin_number: 2,
            part_code: "BUT",
            part_name: "Button bin",
            status: "wip",
            batch: {
              id: 102,
              payload: "BBN-BUT-2",
              bin_number: 2,
              printer_id: 5,
              printer_name: "P1S 02",
              archive_id: 32,
              print_name: "Button plate",
              part_code: "BUT",
              quantity: 12,
              remaining_quantity: 8,
              status: "wip",
              harvested_at: "2026-08-26T14:36:00",
            },
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins/batches/:batchId/events", () =>
        HttpResponse.json([
          {
            id: 201,
            action: "harvested",
            details: { quantity: 20 },
            occurred_at: "2026-08-26T14:35:00",
          },
          {
            id: 202,
            action: "visual_qc_passed",
            details: {
              inspection: "visual",
              harvested_quantity: 20,
              passed_quantity: 18,
              rejected_quantity: 2,
            },
            occurred_at: "2026-08-26T14:40:00",
          },
        ]),
      ),
    );
    render(<FloorInventoryPage />);

    expect(await screen.findByText("BBN-KNB-1 #101")).toBeInTheDocument();
    expect(screen.getByText("BBN-BUT-2 #102")).toBeInTheDocument();
    expect(getStatusLabels("Visual QC pass").length).toBeGreaterThan(0);
    expect(getStatusLabels("In WIP").length).toBeGreaterThan(0);
    expect(screen.getByText("(8/12)")).toBeInTheDocument();

    await user.click(screen.getByText("BBN-KNB-1 #101"));

    expect(await screen.findByRole("heading", { name: "BBN-KNB-1 #101" })).toBeInTheDocument();
    expect(screen.getByText("Bin record")).toBeInTheDocument();
    expect(screen.getByText("Harvested 20 parts into bin")).toBeInTheDocument();
    const qcEvent = screen.getByText("18 of 20 passed visual QC");
    expect(qcEvent).toBeInTheDocument();
    expect(qcEvent.previousElementSibling).toHaveClass("bg-green-500");
    const rejectedEvent = screen.getByText("2 parts failed visual QC");
    expect(rejectedEvent.previousElementSibling).toHaveClass("bg-red-500");
  });

  it("overrides, clears, and unlinks a bin from the Part history bin record", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let overrideBody: unknown = null;
    let unlinkBody: unknown = null;
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-KNB-1",
            bin_number: 1,
            part_code: "KNB",
            part_name: "Knob bin",
            status: "visual_qc_passed",
            batch: {
              id: 101,
              payload: "BBN-KNB-1",
              bin_number: 1,
              printer_id: 4,
              printer_name: "X1 Carbon 04",
              archive_id: 31,
              print_name: "Knob plate",
              part_code: "KNB",
              quantity: 20,
              qc_passed_quantity: 18,
              remaining_quantity: 18,
              status: "visual_qc_passed",
              harvested_at: "2026-08-26T14:35:00",
            },
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins/batches/:batchId/events", () =>
        HttpResponse.json([
          {
            id: 201,
            action: "harvested",
            details: { quantity: 20 },
            occurred_at: "2026-08-26T14:35:00",
          },
        ]),
      ),
      http.post("/api/v1/floor/inventory/bins/quantity-override", async ({ request }) => {
        overrideBody = await request.json();
        return HttpResponse.json({ result: "quantity_overridden" });
      }),
      http.post("/api/v1/floor/inventory/bins/unlink", async ({ request }) => {
        unlinkBody = await request.json();
        return HttpResponse.json({ result: "unlinked" });
      }),
    );
    render(<FloorInventoryPage />);

    await user.click(await screen.findByText("BBN-KNB-1 #101"));
    expect(await screen.findByRole("heading", { name: "BBN-KNB-1 #101" })).toBeInTheDocument();

    const quantityInput = screen.getByLabelText("Knob bin 1 remaining quantity");
    await user.clear(quantityInput);
    expect(screen.getByRole("button", { name: "Override" })).toBeDisabled();
    await user.type(quantityInput, "0");
    expect(screen.getByRole("button", { name: "Override" })).toBeDisabled();
    await user.clear(quantityInput);
    await user.type(quantityInput, "12");
    await user.click(screen.getByRole("button", { name: "Override" }));
    await waitFor(() =>
      expect(overrideBody).toEqual({ payload: "BBN-KNB-1", remaining_quantity: 12 }),
    );

    overrideBody = null;
    await user.click(screen.getByRole("button", { name: "Clear quantity" }));
    expect(screen.getByText("Clear remaining quantity?")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear quantity" })[1]);
    await waitFor(() =>
      expect(overrideBody).toEqual({ payload: "BBN-KNB-1", remaining_quantity: 0 }),
    );

    await user.click(screen.getByRole("button", { name: "Unlink" }));
    await user.click(screen.getByRole("button", { name: "Unlink bin" }));
    await waitFor(() => expect(unlinkBody).toEqual({ payload: "BBN-KNB-1" }));
  });

  it("lets a needs-matching bin browse printers and match a completed job", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let matched: unknown = null;
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-BOT-1",
            bin_number: 1,
            part_code: "BOT",
            part_name: "Bot bin",
            status: "harvested",
            batch: {
              id: 88,
              payload: "BBN-BOT-1",
              bin_number: 1,
              printer_id: null,
              printer_name: null,
              archive_id: null,
              print_name: null,
              part_code: "BOT",
              quantity: 0,
              qc_passed_quantity: null,
              remaining_quantity: 0,
              status: "harvested",
              harvested_at: "2026-09-02T15:04:00",
            },
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins/batches/:batchId/events", () =>
        HttpResponse.json([
          {
            id: 1,
            action: "harvested",
            details: { quantity: 0 },
            occurred_at: "2026-09-02T15:04:00",
          },
        ]),
      ),
      http.get("/api/v1/floor/printers", () =>
        HttpResponse.json([
          { id: 9, name: "P1S 09", payload: "BBP-9", model: "P1S", serial_number: "ABC" },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins/batches/:batchId/job-candidates", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("printer_id")).toBe("9");
        return HttpResponse.json([
          {
            id: 77,
            print_name: "BOT x4 - plate",
            completed_at: "2026-09-02T12:00:00",
          },
        ]);
      }),
      http.post("/api/v1/floor/inventory/bins/batches/:batchId/relink", async ({ request, params }) => {
        matched = { batchId: Number(params.batchId), ...(await request.json() as object) };
        return HttpResponse.json({
          result: "recorded",
          batch: {
            id: 88,
            payload: "BBN-BOT-1",
            bin_number: 1,
            printer_id: 9,
            printer_name: "P1S 09",
            archive_id: 77,
            print_name: "BOT x4 - plate",
            part_code: "BOT",
            quantity: 0,
            remaining_quantity: 0,
            status: "harvested",
            harvested_at: "2026-09-02T15:04:00",
          },
        });
      }),
    );
    render(<FloorInventoryPage />);

    await user.type(
      screen.getByPlaceholderText(/Search sticker, job, printer, or status/i),
      "BBN-BOT-1",
    );
    await user.click(await screen.findByText("BBN-BOT-1 #88"));
    expect(await screen.findByText("Match to completed job")).toBeInTheDocument();
    expect(screen.getByText("No job linked")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Printer" }), "9");
    expect(await screen.findByRole("option", { name: /BOT x4 - plate/ })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Completed job" }), "77");
    await user.click(screen.getByRole("button", { name: "Match" }));
    await waitFor(() => expect(matched).toEqual({ batchId: 88, archive_id: 77 }));
  });

  it("hides archive and delete for a stocked print-linked bin fill", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-KNB-1",
            bin_number: 1,
            part_code: "KNB",
            part_name: "Knob bin",
            status: "visual_qc_passed",
            batch: {
              id: 101,
              payload: "BBN-KNB-1",
              bin_number: 1,
              printer_id: 4,
              printer_name: "X1 Carbon 04",
              archive_id: 31,
              print_name: "Knob plate",
              part_code: "KNB",
              quantity: 20,
              qc_passed_quantity: 18,
              remaining_quantity: 18,
              status: "visual_qc_passed",
              harvested_at: "2026-08-26T14:35:00",
              archived_at: null,
            },
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins/batches/:batchId/events", () =>
        HttpResponse.json([
          {
            id: 201,
            action: "harvested",
            details: { quantity: 20 },
            occurred_at: "2026-08-26T14:35:00",
          },
        ]),
      ),
    );
    render(<FloorInventoryPage />);

    await user.click(await screen.findByText("BBN-KNB-1 #101"));
    expect(await screen.findByRole("heading", { name: "BBN-KNB-1 #101" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive record" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete bin record" })).not.toBeInTheDocument();
  });

  it("archives a depleted bin fill from Part history", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let archivedAt: string | null = null;
    const depletedBatch = {
      id: 101,
      payload: "BBN-KNB-1",
      bin_number: 1,
      printer_id: 4,
      printer_name: "X1 Carbon 04",
      archive_id: 31,
      print_name: "Knob plate",
      part_code: "KNB",
      quantity: 20,
      qc_passed_quantity: 18,
      remaining_quantity: 0,
      status: "empty",
      harvested_at: "2026-08-26T14:35:00",
      archived_at: null as string | null,
    };
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-KNB-1",
            bin_number: 1,
            part_code: "KNB",
            part_name: "Knob bin",
            status: "empty",
            batch: { ...depletedBatch, archived_at: archivedAt },
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins/batches/:batchId/events", () =>
        HttpResponse.json([
          {
            id: 201,
            action: "harvested",
            details: { quantity: 20 },
            occurred_at: "2026-08-26T14:35:00",
          },
          {
            id: 202,
            action: "empty",
            details: { remaining_quantity: 0 },
            occurred_at: "2026-08-26T18:00:00",
          },
        ]),
      ),
      http.post("/api/v1/floor/inventory/bins/batches/:batchId/archive", ({ request }) => {
        const url = new URL(request.url);
        archivedAt = url.searchParams.get("archived") === "true" ? "2026-08-28T16:00:00" : null;
        return HttpResponse.json({
          payload: "BBN-KNB-1",
          bin_number: 1,
          part_code: "KNB",
          part_name: "Knob bin",
          status: "empty",
          batch: { ...depletedBatch, archived_at: archivedAt },
        });
      }),
    );
    render(<FloorInventoryPage />);

    await user.click(await screen.findByRole("button", { name: "Fulfilled" }));
    await user.click(await screen.findByText("BBN-KNB-1 #101"));
    expect(await screen.findByRole("heading", { name: "BBN-KNB-1 #101" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive record" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete bin record" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archive record" }));
    await waitFor(() => expect(archivedAt).toBe("2026-08-28T16:00:00"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restore record" })).toBeInTheDocument(),
    );
  });

  it("deletes an inactive bin record permanently from Part history", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let deletedId: number | null = null;
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json(
          deletedId === 101
            ? []
            : [
                {
                  payload: "BBN-KNB-1",
                  bin_number: 1,
                  part_code: "KNB",
                  part_name: "Knob bin",
                  status: "empty",
                  batch: {
                    id: 101,
                    payload: "BBN-KNB-1",
                    bin_number: 1,
                    printer_id: 4,
                    printer_name: "X1 Carbon 04",
                    archive_id: 31,
                    print_name: "Knob plate",
                    part_code: "KNB",
                    quantity: 20,
                    qc_passed_quantity: 18,
                    remaining_quantity: 0,
                    status: "empty",
                    harvested_at: "2026-08-26T14:35:00",
                    archived_at: null,
                  },
                },
              ],
        ),
      ),
      http.get("/api/v1/floor/inventory/bins/batches/:batchId/events", () =>
        HttpResponse.json([
          {
            id: 201,
            action: "harvested",
            details: { quantity: 20 },
            occurred_at: "2026-08-26T14:35:00",
          },
          {
            id: 202,
            action: "empty",
            details: { remaining_quantity: 0 },
            occurred_at: "2026-08-26T18:00:00",
          },
        ]),
      ),
      http.delete("/api/v1/floor/inventory/bins/batches/:batchId", ({ params }) => {
        deletedId = Number(params.batchId);
        return HttpResponse.json({ deleted: true });
      }),
    );
    render(<FloorInventoryPage />);

    await user.click(await screen.findByRole("button", { name: "Fulfilled" }));
    await user.click(await screen.findByText("BBN-KNB-1 #101"));
    expect(await screen.findByRole("heading", { name: "BBN-KNB-1 #101" })).toBeInTheDocument();
    expect(screen.getByText("#101")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete bin record" }));
    expect(screen.getByText("Delete bin record?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(deletedId).toBe(101));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "BBN-KNB-1 #101" })).not.toBeInTheDocument(),
    );
  });

  it("finds a bin fill by its batch number in Part history search", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-BUT-1",
            bin_number: 1,
            part_code: "BUT",
            part_name: "Button bin",
            status: "wip",
            batch: {
              id: 77,
              payload: "BBN-BUT-1",
              bin_number: 1,
              printer_id: 2,
              printer_name: "El Jefe",
              archive_id: 40,
              print_name: "BUT H2D Test Print",
              part_code: "BUT",
              quantity: 25,
              remaining_quantity: 19,
              status: "wip",
              harvested_at: "2026-08-26T17:14:00",
            },
          },
          {
            payload: "BBN-BUT-1",
            bin_number: 1,
            part_code: "BUT",
            part_name: "Button bin",
            status: "empty",
            batch: {
              id: 76,
              payload: "BBN-BUT-1",
              bin_number: 1,
              printer_id: 2,
              printer_name: "El Jefe",
              archive_id: 39,
              print_name: "Older fill",
              part_code: "BUT",
              quantity: 25,
              remaining_quantity: 0,
              status: "empty",
              harvested_at: "2026-08-25T12:00:00",
            },
          },
        ]),
      ),
    );
    render(<FloorInventoryPage />);

    await user.click(await screen.findByRole("button", { name: "All parts" }));
    expect(await screen.findByText("BBN-BUT-1 #77")).toBeInTheDocument();
    expect(screen.getByText("BBN-BUT-1 #76")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/Search/i), "BBN-BUT-1 #77");
    expect(screen.getByText("BBN-BUT-1 #77")).toBeInTheDocument();
    expect(screen.queryByText("BBN-BUT-1 #76")).not.toBeInTheDocument();
  });

  it("keeps the bin history linear when every part passes visual QC", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-KNB-1",
            bin_number: 1,
            part_code: "KNB",
            part_name: "Knob bin",
            status: "visual_qc_passed",
            batch: {
              id: 103,
              payload: "BBN-KNB-1",
              bin_number: 1,
              printer_id: 4,
              printer_name: "X1 Carbon 04",
              archive_id: 31,
              print_name: "Knob plate",
              part_code: "KNB",
              quantity: 20,
              qc_passed_quantity: 20,
              remaining_quantity: 20,
              status: "visual_qc_passed",
              harvested_at: "2026-08-26T14:35:00",
            },
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins/batches/:batchId/events", () =>
        HttpResponse.json([
          {
            id: 203,
            action: "harvested",
            details: { quantity: 20 },
            occurred_at: "2026-08-26T14:35:00",
          },
          {
            id: 204,
            action: "visual_qc_passed",
            details: {
              inspection: "visual",
              harvested_quantity: 20,
              passed_quantity: 20,
              rejected_quantity: 0,
            },
            occurred_at: "2026-08-26T14:40:00",
          },
        ]),
      ),
    );
    render(<FloorInventoryPage />);

    await user.click(await screen.findByText("BBN-KNB-1 #103"));

    expect(await screen.findByText("20 of 20 passed visual QC")).toBeInTheDocument();
    expect(screen.queryByText("0 parts failed visual QC")).not.toBeInTheDocument();
  });

  it("keeps manually cleared bin fills in Part history", async () => {
    mockPartHistory();
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-BUT-2",
            bin_number: 2,
            part_code: "BUT",
            part_name: "Button bin",
            status: "empty_override",
            batch: {
              id: 104,
              payload: "BBN-BUT-2",
              bin_number: 2,
              printer_id: 5,
              printer_name: "P1S 02",
              archive_id: 32,
              print_name: "Button plate",
              part_code: "BUT",
              quantity: 12,
              qc_passed_quantity: 12,
              remaining_quantity: 0,
              status: "empty_override",
              harvested_at: "2026-08-26T14:36:00",
            },
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins/batches/:batchId/events", () =>
        HttpResponse.json([
          {
            id: 205,
            action: "harvested",
            details: { quantity: 12 },
            occurred_at: "2026-08-26T14:36:00",
          },
          {
            id: 206,
            action: "empty_override",
            details: { source: "inventory_override", remaining_quantity: 0 },
            occurred_at: "2026-08-26T15:00:00",
          },
        ]),
      ),
    );
    const user = userEvent.setup();
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("button", { name: "Fulfilled" }));
    expect(await screen.findByText("BBN-BUT-2 #104")).toBeInTheDocument();
    expect(screen.getByText("Depleted (manually cleared)")).toBeInTheDocument();
    expect(screen.getByText("(0/12)")).toBeInTheDocument();

    await user.click(screen.getByText("BBN-BUT-2 #104"));
    expect(await screen.findByText("Bin manually cleared and marked depleted")).toBeInTheDocument();
  });

  it("groups shipped parts and depleted bins under Fulfilled", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    const shippedPart = {
      ...PARTS[0],
      id: 5,
      sticker_code: "BBD-000105",
      print_name: "Shipped cable guide",
      latest_event_action: "shipped",
    };
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json([...PARTS, shippedPart]),
      ),
      http.get("/api/v1/floor/inventory/parts/:id/events", ({ params }) =>
        HttpResponse.json(
          Number(params.id) === shippedPart.id
            ? [{ id: 50, action: "shipped", details: null, occurred_at: "2026-08-26T16:00:00" }]
            : [{ id: 10, action: "enrolled", details: { archive_id: 31 }, occurred_at: "2026-08-25T14:32:00" }],
        ),
      ),
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-BUT-2",
            bin_number: 2,
            part_code: "BUT",
            part_name: "Button bin",
            status: "empty_override",
            batch: {
              id: 105,
              payload: "BBN-BUT-2",
              bin_number: 2,
              printer_id: 5,
              printer_name: "P1S 02",
              archive_id: 32,
              print_name: "Button plate",
              part_code: "BUT",
              quantity: 12,
              qc_passed_quantity: 12,
              remaining_quantity: 0,
              status: "empty_override",
              harvested_at: "2026-08-26T15:36:00",
            },
          },
        ]),
      ),
    );
    render(<FloorInventoryPage />);

    expect(screen.getByRole("button", { name: "Fulfilled" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fulfilled" }));
    expect(screen.getByText("BBD-000105")).toBeInTheDocument();
    expect(getStatusLabels("Shipped").length).toBeGreaterThan(0);
    expect(screen.getByText("Depleted (manually cleared)")).toBeInTheDocument();
  });

  it("shows logged print failure reasons above the part history table", async () => {
    mockPartHistory();
    server.use(
      http.get("/api/v1/floor/inventory/print-failures", () =>
        HttpResponse.json([
          {
            id: 9,
            printer_id: 4,
            printer_name: "X1 Carbon 04",
            archive_id: 31,
            print_name: "Cable guide",
            part_code: "TOP",
            reason_code: "warping",
            reason_text: null,
            stopped_at: "2026-08-26T11:00:00",
          },
        ]),
      ),
    );
    render(<FloorInventoryPage />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Print failure log" }));
    expect(screen.getByRole("button", { name: "Print failure log" })).toBeInTheDocument();
    expect(await screen.findByText("Warping")).toBeInTheDocument();
    expect(screen.getByText("TOP")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Failed" })).toBeInTheDocument();
  });

  it("keeps discarded parts out of Registered Parts and groups them into the failure log", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    const discardedPart = {
      ...PARTS[0],
      id: 4,
      sticker_code: "BBD-000104",
      latest_event_action: "discarded",
    };
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json([...PARTS, discardedPart]),
      ),
      http.get("/api/v1/floor/inventory/parts/:id/events", ({ params }) =>
        HttpResponse.json(
          Number(params.id) === discardedPart.id
            ? [
                {
                  id: 40,
                  action: "discarded",
                  details: null,
                  occurred_at: "2026-08-26T10:50:00",
                },
              ]
            : [
                {
                  id: 10,
                  action: "enrolled",
                  details: { archive_id: Number(params.id) === 1 ? 31 : null },
                  occurred_at: "2026-08-25T14:32:00",
                },
              ],
        ),
      ),
    );
    render(<FloorInventoryPage />);

    expect(await screen.findByText("BBD-000101")).toBeInTheDocument();
    expect(screen.queryByText("BBD-000104")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Print failure log" }));
    expect(await screen.findByText("BBD-000104")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Discarded" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Registered Parts" }));
    expect(screen.queryByText("BBD-000104")).not.toBeInTheDocument();
  });

  it("prioritizes unresolved records and filters the searchable index", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    render(<FloorInventoryPage />);

    expect(await screen.findByText("BBD-000101")).toBeInTheDocument();
    expect(
      screen.getByText("Needs matching", { selector: "div" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("BBD-000103")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Needs matching \(1\)/ }),
    );
    expect(await screen.findByText("BBD-000102")).toBeInTheDocument();
    expect(screen.queryByText("BBD-000101")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Registered Parts" }));
    expect(await screen.findByText("BBD-000101")).toBeInTheDocument();
    expect(screen.queryByText("BBD-000102")).not.toBeInTheDocument();
    expect(screen.queryByText("BBD-000103")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show archived" }));
    expect(await screen.findByText("BBD-000103")).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Search part history" }),
      "000102",
    );
    expect(await screen.findByText("BBD-000102")).toBeInTheDocument();
    expect(screen.queryByText("BBD-000103")).not.toBeInTheDocument();
  });

  it("shows WIP + staged counts for tops, bottoms, buttons, and knobs", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json([
          {
            id: 1,
            sticker_code: "BBD-000201",
            printer_id: 4,
            printer_name: "X1 Carbon 04",
            archive_id: 31,
            part_code: "TOP",
            print_name: "Top Housing",
            labeled_at: "2026-08-25T14:31:00",
            archived_at: null,
            released_at: null,
            latest_event_action: "ready_for_production",
          },
          {
            id: 2,
            sticker_code: "BBD-000202",
            printer_id: 4,
            printer_name: "X1 Carbon 04",
            archive_id: 32,
            part_code: "TOP",
            print_name: "Top Housing",
            labeled_at: "2026-08-25T14:32:00",
            archived_at: null,
            released_at: null,
            latest_event_action: "wip",
          },
          {
            id: 3,
            sticker_code: "BBD-000203",
            printer_id: 5,
            printer_name: "P1S 02",
            archive_id: 33,
            part_code: "BOT",
            print_name: "Bottom Housing",
            labeled_at: "2026-08-25T14:33:00",
            archived_at: null,
            released_at: null,
            latest_event_action: "ready_for_production",
          },
          {
            id: 4,
            sticker_code: "BBD-000204",
            printer_id: 5,
            printer_name: "P1S 02",
            archive_id: 34,
            part_code: "BOT",
            print_name: "Bottom Housing",
            labeled_at: "2026-08-25T14:34:00",
            archived_at: null,
            released_at: null,
            latest_event_action: "ready_for_production",
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-BUT-1",
            bin_number: 1,
            part_code: "BUT",
            part_name: "Button bin",
            status: "ready_for_production",
            batch: {
              id: 11,
              payload: "BBN-BUT-1",
              bin_number: 1,
              printer_id: 4,
              printer_name: "X1 Carbon 04",
              archive_id: 41,
              print_name: "Buttons",
              part_code: "BUT",
              quantity: 47,
              qc_passed_quantity: 47,
              remaining_quantity: 12,
              status: "ready_for_production",
              harvested_at: "2026-08-25T14:00:00",
              archived_at: null,
            },
          },
          {
            payload: "BBN-KNB-1",
            bin_number: 1,
            part_code: "KNB",
            part_name: "Knob bin",
            status: "ready_for_production",
            batch: {
              id: 12,
              payload: "BBN-KNB-1",
              bin_number: 1,
              printer_id: 4,
              printer_name: "X1 Carbon 04",
              archive_id: 42,
              print_name: "Knobs",
              part_code: "KNB",
              quantity: 30,
              qc_passed_quantity: 30,
              remaining_quantity: 5,
              status: "ready_for_production",
              harvested_at: "2026-08-25T14:05:00",
              archived_at: null,
            },
          },
          {
            payload: "BBN-KNB-2",
            bin_number: 2,
            part_code: "KNB",
            part_name: "Knob bin",
            status: "wip",
            batch: {
              id: 13,
              payload: "BBN-KNB-2",
              bin_number: 2,
              printer_id: 4,
              printer_name: "X1 Carbon 04",
              archive_id: 43,
              print_name: "Knobs",
              part_code: "KNB",
              quantity: 30,
              qc_passed_quantity: 30,
              remaining_quantity: 8,
              status: "wip",
              harvested_at: "2026-08-25T14:10:00",
              archived_at: null,
            },
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/print-failures", () => HttpResponse.json([])),
      http.get("/api/v1/floor/inventory/parts/:id/events", ({ params }) => {
        const actions: Record<string, string> = {
          "1": "ready_for_production",
          "2": "wip",
          "3": "ready_for_production",
          "4": "ready_for_production",
        };
        return HttpResponse.json([
          {
            id: 10,
            action: actions[String(params.id)] ?? "enrolled",
            details: null,
            occurred_at: "2026-08-25T14:32:00",
          },
        ]);
      }),
      http.get("/api/v1/floor/inventory/units", () => HttpResponse.json([])),
    );
    render(<FloorInventoryPage />);

    await waitFor(() => {
      const topsCard = screen.getByRole("button", { name: /Tops in WIP \+ staged/ });
      expect(within(topsCard).getByText("2")).toBeInTheDocument();
    });
    const bottomsCard = screen.getByRole("button", { name: /Bottoms in WIP \+ staged/ });
    const buttonsCard = screen.getByRole("button", { name: /Buttons in WIP \+ staged/ });
    const knobsCard = screen.getByRole("button", { name: /Knobs in WIP \+ staged/ });
    expect(within(bottomsCard).getByText("2")).toBeInTheDocument();
    expect(within(buttonsCard).getByText("12")).toBeInTheDocument();
    // Staged remaining 5 + WIP remaining 8
    expect(within(knobsCard).getByText("13")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Tops in WIP \+ staged/ }));
    expect(await screen.findByText("BBD-000201")).toBeInTheDocument();
    expect(await screen.findByText("BBD-000202")).toBeInTheDocument();
    expect(screen.queryByText("BBD-000203")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filter by part" })).toHaveValue("TOP");
    expect(screen.getByRole("combobox", { name: "Filter by status" })).toHaveValue(
      "wip_or_staged",
    );
  });

  it("filters by status and part together and hides incompatible part options", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json([
          {
            id: 1,
            sticker_code: "BBD-TOP-SANDING",
            printer_id: 4,
            printer_name: "X1 Carbon 04",
            archive_id: 31,
            part_code: "TOP",
            print_name: "Top Housing",
            labeled_at: "2026-08-25T14:31:00",
            archived_at: null,
            released_at: null,
            latest_event_action: "sanding",
          },
          {
            id: 2,
            sticker_code: "BBD-BOT-REWORK",
            printer_id: 5,
            printer_name: "P1S 02",
            archive_id: 32,
            part_code: "BOT",
            print_name: "Bottom Housing",
            labeled_at: "2026-08-25T14:32:00",
            archived_at: null,
            released_at: null,
            latest_event_action: "rework",
          },
          {
            id: 5,
            sticker_code: "BBD-TOP-REWORK",
            printer_id: 4,
            printer_name: "X1 Carbon 04",
            archive_id: 35,
            part_code: "TOP",
            print_name: "Top Housing",
            labeled_at: "2026-08-25T14:35:00",
            archived_at: null,
            released_at: null,
            latest_event_action: "rework",
          },
          {
            id: 3,
            sticker_code: "BBD-TOP-SUPPORT",
            printer_id: 4,
            printer_name: "X1 Carbon 04",
            archive_id: 33,
            part_code: "TOP",
            print_name: "Top Housing",
            labeled_at: "2026-08-25T14:33:00",
            archived_at: null,
            released_at: null,
            latest_event_action: "support_removed",
          },
          {
            id: 4,
            sticker_code: "BBD-BOT-STAGED",
            printer_id: 5,
            printer_name: "P1S 02",
            archive_id: 34,
            part_code: "BOT",
            print_name: "Bottom Housing",
            labeled_at: "2026-08-25T14:34:00",
            archived_at: null,
            released_at: null,
            latest_event_action: "ready_for_production",
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins", () => HttpResponse.json([])),
      http.get("/api/v1/floor/inventory/units", () => HttpResponse.json([])),
      http.get("/api/v1/floor/inventory/print-failures", () => HttpResponse.json([])),
    );
    render(<FloorInventoryPage />);

    await screen.findByText("BBD-TOP-SANDING");

    const partFilter = screen.getByRole("combobox", { name: "Filter by part" });
    const statusFilter = screen.getByRole("combobox", { name: "Filter by status" });

    await user.selectOptions(partFilter, "BOT");
    await user.selectOptions(statusFilter, "rework");

    expect(await screen.findByText("BBD-BOT-REWORK")).toBeInTheDocument();
    expect(screen.queryByText("BBD-TOP-SANDING")).not.toBeInTheDocument();
    expect(screen.queryByText("BBD-TOP-REWORK")).not.toBeInTheDocument();
    expect(screen.queryByText("BBD-BOT-STAGED")).not.toBeInTheDocument();
    // Finishing statuses are TOP-only — not offered while Bottoms is selected.
    expect(
      within(statusFilter).queryByRole("option", { name: "Support Removed" }),
    ).not.toBeInTheDocument();

    await user.selectOptions(partFilter, "all");
    await user.selectOptions(statusFilter, "support_removed");

    expect(await screen.findByText("BBD-TOP-SUPPORT")).toBeInTheDocument();
    expect(screen.queryByText("BBD-BOT-REWORK")).not.toBeInTheDocument();
    expect(screen.queryByText("BBD-TOP-SANDING")).not.toBeInTheDocument();
    expect(screen.queryByText("BBD-TOP-REWORK")).not.toBeInTheDocument();
    expect(
      within(partFilter).queryByRole("option", { name: "Bottoms" }),
    ).not.toBeInTheDocument();
    expect(within(partFilter).getByRole("option", { name: "Tops" })).toBeInTheDocument();

    await user.selectOptions(partFilter, "TOP");
    await user.selectOptions(statusFilter, "sanding");
    expect(await screen.findByText("BBD-TOP-SANDING")).toBeInTheDocument();
    expect(screen.queryByText("BBD-TOP-REWORK")).not.toBeInTheDocument();
    expect(screen.queryByText("BBD-BOT-REWORK")).not.toBeInTheDocument();

    await user.selectOptions(statusFilter, "rework");
    expect(await screen.findByText("BBD-TOP-REWORK")).toBeInTheDocument();
    expect(screen.queryByText("BBD-TOP-SANDING")).not.toBeInTheDocument();
    expect(screen.queryByText("BBD-BOT-REWORK")).not.toBeInTheDocument();
  });

  it("switches to All parts for searches and shows failed parts from the failure log", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    server.use(
      http.get("/api/v1/floor/inventory/print-failures", () =>
        HttpResponse.json([
          {
            id: 12,
            printer_id: 4,
            printer_name: "X1 Carbon 04",
            archive_id: 31,
            print_name: "Failed bracket",
            part_code: "TOP",
            reason_code: "warping",
            reason_text: null,
            stopped_at: "2026-08-26T11:00:00",
          },
        ]),
      ),
    );
    render(<FloorInventoryPage />);

    const search = screen.getByRole("textbox", { name: "Search part history" });
    await user.click(search);
    await user.click(screen.getByRole("button", { name: /Failed failed/ }));

    expect(screen.getByRole("button", { name: "All parts" })).toHaveClass("bg-bambu-green");
    const failedPrint = await screen.findByText("Failed bracket");
    expect(failedPrint).toBeInTheDocument();
    expect(screen.getByText("Failed", { selector: "span" })).toHaveClass("bg-red-100", "text-red-800");

    await user.click(failedPrint);
    expect(failedPrint.closest("tr")).toHaveClass("bg-red-100/50");

    await user.clear(search);
    await user.click(screen.getByRole("button", { name: "Registered Parts" }));
    await user.type(search, "bracket");
    expect(screen.getByRole("button", { name: "All parts" })).toHaveClass("bg-bambu-green");
  });

  it("offers discarded as a suggested status search", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("textbox", { name: "Search part history" }));

    expect(screen.getByRole("button", { name: /Discarded discarded/ })).toBeInTheDocument();
  });

  it("offers fulfilled as a suggested status search", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("textbox", { name: "Search part history" }));

    expect(screen.getByRole("button", { name: /Fulfilled fulfilled/ })).toBeInTheDocument();
  });

  it("offers the new floor statuses as suggested searches", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("textbox", { name: "Search part history" }));

    expect(screen.getByRole("button", { name: /Staged for Production staged/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Support Removed support/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Overhang Removed overhang/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hot Air Removed hot air/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cleanup Pass cleanup/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Visual QC pass visual qc/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fit Check Pass fit check/ })).toBeInTheDocument();
  });

  it("finds needs-matching parts and bins via the matching search shortcut", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json([
          {
            id: 2,
            sticker_code: "BBD-000102",
            printer_id: 4,
            printer_name: "X1 Carbon 04",
            archive_id: null,
            part_code: "TOP",
            print_name: null,
            labeled_at: "2026-08-25T14:32:00",
            archived_at: null,
            released_at: null,
            latest_event_action: "enrolled",
          },
          {
            id: 1,
            sticker_code: "BBD-000101",
            printer_id: 4,
            printer_name: "X1 Carbon 04",
            archive_id: 31,
            part_code: "TOP",
            print_name: "Cable guide",
            labeled_at: "2026-08-25T14:31:00",
            archived_at: null,
            released_at: null,
            latest_event_action: "wip",
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-BOT-1",
            bin_number: 1,
            part_code: "BOT",
            part_name: "Bot bin",
            status: "harvested",
            batch: {
              id: 88,
              payload: "BBN-BOT-1",
              bin_number: 1,
              printer_id: null,
              printer_name: null,
              archive_id: null,
              print_name: null,
              part_code: "BOT",
              quantity: 0,
              qc_passed_quantity: null,
              remaining_quantity: 0,
              status: "harvested",
              harvested_at: "2026-09-02T15:04:00",
            },
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/print-failures", () => HttpResponse.json([])),
      http.get("/api/v1/floor/inventory/parts/:id/events", ({ params }) =>
        HttpResponse.json([
          {
            id: 10,
            action: Number(params.id) === 2 ? "enrolled" : "wip",
            details: { archive_id: Number(params.id) === 1 ? 31 : null },
            occurred_at: "2026-08-25T14:32:00",
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/units", () => HttpResponse.json([])),
    );
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("textbox", { name: "Search part history" }));
    await user.click(screen.getByRole("button", { name: /Needs matching matching/ }));

    expect(await screen.findByText("BBD-000102")).toBeInTheDocument();
    expect(await screen.findByText("BBN-BOT-1 #88")).toBeInTheDocument();
    expect(screen.queryByText("BBD-000101")).not.toBeInTheDocument();
  });

  it("clears the search from the inline X button", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    render(<FloorInventoryPage />);

    const search = screen.getByRole("textbox", { name: "Search part history" });
    await user.type(search, "bracket");
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Staged for Production staged/ }),
    ).toBeInTheDocument();
  });

  it("shows harvest history and offers only same-printer job candidates for a match", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let matched: unknown = null;
    server.use(
      http.post(
        "/api/v1/floor/inventory/parts/2/relink",
        async ({ request }) => {
          matched = await request.json();
          return HttpResponse.json({
            ...PARTS[1],
            archive_id: 41,
            print_name: "Cable guide",
          });
        },
      ),
    );
    render(<FloorInventoryPage />);
    await user.click(screen.getByRole("button", { name: "Needs matching" }));
    await screen.findByText("BBD-000102");

    await user.click(screen.getByText("BBD-000102"));
    expect(
      await screen.findByRole("heading", { name: "BBD-000102" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Sticker enrolled · no job found at harvest/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Match to completed job"),
    ).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Completed job" }),
      "41",
    );
    await user.click(screen.getByRole("button", { name: "Match" }));
    expect(matched).toEqual({ archive_id: 41 });
  });

  it("archives a selected record from the detail panel", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let archived = false;
    server.use(
      http.post("/api/v1/floor/inventory/parts/1/archive", () => {
        archived = true;
        return HttpResponse.json({
          ...PARTS[0],
          archived_at: "2026-08-25T16:00:00",
        });
      }),
    );
    render(<FloorInventoryPage />);
    await screen.findByText("BBD-000101");

    await user.click(screen.getByText("BBD-000101"));
    await user.click(screen.getByRole("button", { name: "Archive record" }));

    expect(archived).toBe(true);
  });

  it("permanently deletes a part record and its history after confirmation", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let parts = PARTS.map((part) => ({ ...part }));
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json(parts),
      ),
      http.delete("/api/v1/floor/inventory/parts/1", () => {
        parts = parts.filter((part) => part.id !== 1);
        return HttpResponse.json({ deleted: true });
      }),
    );
    render(<FloorInventoryPage />);
    await screen.findByText("BBD-000101");

    await user.click(screen.getByText("BBD-000101"));
    await user.click(screen.getByRole("button", { name: "Delete part record" }));
    expect(
      screen.getByText(/permanently deletes BBD-000101, its job link, and every history event/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() =>
      expect(screen.queryByText("BBD-000101")).not.toBeInTheDocument(),
    );
  });

  it("unlinks a linked part and lets it be rematched", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let unlinkBody: unknown = null;
    // `refresh()` invalidates the parts list, which refetches — so the list
    // handler must reflect the unlink too, or the refetch would clobber the
    // optimistic cache splice with the original (still-linked) fixture.
    let parts = PARTS.map((part) => ({ ...part }));
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json(parts),
      ),
      http.post(
        "/api/v1/floor/inventory/parts/1/unlink",
        async ({ request }) => {
          unlinkBody = await request.json();
          parts = parts.map((part) =>
            part.id === 1
              ? { ...part, archive_id: null, print_name: null }
              : part,
          );
          return HttpResponse.json(parts[0]);
        },
      ),
    );
    render(<FloorInventoryPage />);
    await screen.findByText("BBD-000101");

    await user.click(screen.getByText("BBD-000101"));
    await user.click(screen.getByRole("button", { name: "Unlink job" }));
    await user.click(screen.getByRole("button", { name: "Confirm unlink" }));

    await waitFor(() =>
      expect(unlinkBody).toEqual({ reason_code: "wrong_job", reason_text: null }),
    );
    expect(
      await screen.findByText("Match to completed job"),
    ).toBeInTheDocument();
  });

  it("blocks unlink confirm until reason text is provided for other", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let called = false;
    server.use(
      http.post("/api/v1/floor/inventory/parts/1/unlink", () => {
        called = true;
        return HttpResponse.json({
          ...PARTS[0],
          archive_id: null,
          print_name: null,
        });
      }),
    );
    render(<FloorInventoryPage />);
    await screen.findByText("BBD-000101");

    await user.click(screen.getByText("BBD-000101"));
    await user.click(screen.getByRole("button", { name: "Unlink job" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Unlink reason" }),
      "other",
    );
    const confirmButton = screen.getByRole("button", {
      name: "Confirm unlink",
    });
    expect(confirmButton).toBeDisabled();

    await user.click(confirmButton);
    expect(called).toBe(false);

    await user.type(
      screen.getByRole("textbox", { name: "Unlink reason details" }),
      "Sticker was actually on a different part",
    );
    expect(confirmButton).toBeEnabled();
  });

  it("matches a needs-matching part to a job found via cross-printer search", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let matched: unknown = null;
    server.use(
      http.get("/api/v1/floor/inventory/jobs/search", ({ request }) => {
        const url = new URL(request.url);
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) return HttpResponse.json([]);
        return HttpResponse.json([
          {
            id: 77,
            print_name: "Fan shroud",
            printer_id: 9,
            printer_name: "P1S 09",
            completed_at: "2026-08-20T10:00:00",
          },
        ]);
      }),
      http.post(
        "/api/v1/floor/inventory/parts/2/relink",
        async ({ request }) => {
          matched = await request.json();
          return HttpResponse.json({
            ...PARTS[1],
            archive_id: 77,
            print_name: "Fan shroud",
            printer_id: 9,
            printer_name: "P1S 09",
          });
        },
      ),
    );
    render(<FloorInventoryPage />);
    await user.click(screen.getByRole("button", { name: "Needs matching" }));
    await screen.findByText("BBD-000102");

    await user.click(screen.getByText("BBD-000102"));
    await screen.findByText("Match to completed job");

    await user.click(screen.getByRole("button", { name: "Search all jobs" }));
    await user.type(
      screen.getByRole("textbox", { name: "Search all completed jobs" }),
      "fan",
    );
    expect(
      await screen.findByText("Fan shroud", {}, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/P1S 09/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Match" }));
    expect(matched).toEqual({ archive_id: 77 });
  });

  it("replaces a sticker code without changing the workflow status", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let replaced = false;
    // Same reasoning as the unlink test above: the parts list handler must
    // reflect the new sticker code, or the post-mutation refetch reverts it.
    let parts = PARTS.map((part) =>
      part.id === 1
        ? { ...part, latest_event_action: "fit_checked", part_code: "TOP" }
        : { ...part },
    );
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json(parts),
      ),
      http.get("/api/v1/floor/inventory/parts/:id/events", ({ params }) => {
        if (Number(params.id) !== 1) {
          return HttpResponse.json([
            {
              id: 10,
              action: "enrolled",
              details: null,
              occurred_at: "2026-08-25T14:32:00",
            },
          ]);
        }
        const events = [
          {
            id: 10,
            action: "enrolled",
            details: { archive_id: 31 },
            occurred_at: "2026-08-25T14:31:00",
          },
          {
            id: 11,
            action: "fit_checked",
            details: { status_override: true },
            occurred_at: "2026-08-25T15:00:00",
          },
        ];
        if (replaced) {
          events.push({
            id: 12,
            action: "sticker_replaced",
            details: {
              previous_code: "BBD-000101",
              new_code: "BBD-000199",
              reason_code: "damaged",
              reason_text: null,
            },
            occurred_at: "2026-08-25T16:10:00",
          });
        }
        return HttpResponse.json(events);
      }),
      http.post(
        "/api/v1/floor/inventory/parts/1/replace-sticker",
        async ({ request }) => {
          const body = (await request.json()) as { new_sticker_code: string };
          replaced = true;
          parts = parts.map((part) =>
            part.id === 1
              ? {
                  ...part,
                  sticker_code: body.new_sticker_code,
                  // Server keeps the prior workflow status for latest_event_action.
                  latest_event_action: "fit_checked",
                }
              : part,
          );
          return HttpResponse.json(parts[0]);
        },
      ),
    );
    render(<FloorInventoryPage />);
    await screen.findByText("BBD-000101");

    await user.click(screen.getByText("BBD-000101"));
    const detail = await screen.findByLabelText("Part detail");
    expect(
      await screen.findByRole("heading", { name: "BBD-000101" }),
    ).toBeInTheDocument();
    expect(within(detail).getByText("Fit Check Pass")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Replace sticker" }));
    await user.type(
      screen.getByRole("textbox", { name: "New sticker code" }),
      "BBD-000199",
    );
    await user.click(
      screen.getByRole("button", { name: "Confirm replacement" }),
    );

    expect(
      await screen.findByRole("heading", { name: "BBD-000199" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(detail).getByText(/Sticker replaced/)).toBeInTheDocument(),
    );
    expect(within(detail).getByText("Fit Check Pass")).toBeInTheDocument();
    expect(within(detail).queryByText("Linked")).not.toBeInTheDocument();
  });

  it("hides unlink and replace-sticker actions for an archived record", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    render(<FloorInventoryPage />);
    await screen.findByText("BBD-000101");

    await user.click(screen.getByRole("button", { name: "Show archived" }));
    await user.click(await screen.findByText("BBD-000103"));
    expect(
      await screen.findByRole("heading", { name: "BBD-000103" }),
    ).toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Unlink job" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Replace sticker" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restore record" }),
    ).toBeInTheDocument();
  });

  it("assigns a part code from the catalog and appends a timeline event", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let assigned = false;
    let parts = PARTS.map((part) => ({ ...part }));
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json(parts),
      ),
      http.get("/api/v1/floor/parts/codes", () =>
        HttpResponse.json([
          { code: "TOP", name: "Top Housing" },
          { code: "BOT", name: "Bottom Housing" },
        ]),
      ),
      http.get("/api/v1/floor/inventory/parts/:id/events", ({ params }) => {
        const events: unknown[] = [
          {
            id: 10,
            action: "enrolled",
            details: { archive_id: Number(params.id) === 1 ? 31 : null },
            occurred_at: "2026-08-25T14:31:00",
          },
        ];
        if (Number(params.id) === 1 && assigned) {
          events.push({
            id: 11,
            action: "part_code_assigned",
            details: { part_code: "TOP" },
            occurred_at: "2026-08-25T16:20:00",
          });
        }
        return HttpResponse.json(events);
      }),
      http.post(
        "/api/v1/floor/inventory/parts/1/part-code",
        async ({ request }) => {
          const body = (await request.json()) as { code: string };
          assigned = true;
          parts = parts.map((part) =>
            part.id === 1 ? { ...part, part_code: body.code } : part,
          );
          return HttpResponse.json(parts[0]);
        },
      ),
    );
    render(<FloorInventoryPage />);
    await screen.findByText("BBD-000101");

    await user.click(screen.getByText("BBD-000101"));
    expect(
      await screen.findByRole("heading", { name: "BBD-000101" }),
    ).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Assign part code" }),
      "TOP",
    );
    await user.click(screen.getByRole("button", { name: "Assign" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("combobox", { name: "Assign part code" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText("Part code assigned · TOP"),
    ).toBeInTheDocument();
  });

  it("uses green for fit checks and orange for rework in the history timeline", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json(
          PARTS.map((part) =>
            part.id === 1
              ? { ...part, part_code: "TOP", latest_event_action: "fit_checked" }
              : part,
          ),
        ),
      ),
      http.get("/api/v1/floor/inventory/parts/1/events", () =>
        HttpResponse.json([
          {
            id: 10,
            action: "enrolled",
            details: { archive_id: 31 },
            occurred_at: "2026-08-25T14:32:00",
          },
          {
            id: 11,
            action: "fit_checked",
            details: null,
            occurred_at: "2026-08-25T15:00:00",
          },
          {
            id: 12,
            action: "sanding",
            details: null,
            occurred_at: "2026-08-25T16:00:00",
          },
        ]),
      ),
    );
    render(<FloorInventoryPage />);
    await screen.findByText("BBD-000101");
    expect((await findStatusLabels("Sanding")).length).toBeGreaterThan(0);
    await user.click(screen.getByText("BBD-000101"));

    expect((await findStatusLabels("Fit Check Pass")).length).toBeGreaterThan(0);
    await waitFor(() => expect(getStatusLabels("Sanding")).toHaveLength(2));
    const timelineItems = await screen.findAllByRole("listitem");
    expect(timelineItems[1].querySelector("span")).toHaveClass("bg-green-500");
    expect(timelineItems[2].querySelector("span")).toHaveClass("bg-orange-500");
  });

  it("shows Visual QC pass for KNB and BUT parts after initial QC", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json([
          { ...PARTS[0], part_code: "KNB", latest_event_action: "fit_checked" },
        ]),
      ),
      http.get("/api/v1/floor/inventory/parts/1/events", () =>
        HttpResponse.json([
          {
            id: 10,
            action: "enrolled",
            details: { archive_id: 31 },
            occurred_at: "2026-08-25T14:32:00",
          },
          {
            id: 11,
            action: "fit_checked",
            details: null,
            occurred_at: "2026-08-25T15:00:00",
          },
        ]),
      ),
    );
    render(<FloorInventoryPage />);

    expect((await findStatusLabels("Visual QC pass")).length).toBeGreaterThan(0);
    await user.click(screen.getByText("BBD-000101"));
    expect(screen.getByRole("list")).toHaveTextContent("Visual QC pass");
  });

  it("lets an operator override a part with a supported status", async () => {
    const user = userEvent.setup();
    let statusOverridden = false;
    let parts = PARTS.map((part) => ({ ...part }));
    server.use(
      http.get("/api/v1/floor/inventory/parts", () => HttpResponse.json(parts)),
      http.get("/api/v1/floor/inventory/parts/1/events", () =>
        HttpResponse.json([
          {
            id: 10,
            action: "enrolled",
            details: { archive_id: 31 },
            occurred_at: "2026-08-25T14:32:00",
          },
          ...(statusOverridden
            ? [{
                id: 11,
                action: "shipped",
                details: {
                  status_override: true,
                  status: "shipped",
                  previous_status: null,
                },
                occurred_at: "2026-08-25T16:00:00",
              }]
            : []),
        ]),
      ),
      http.post("/api/v1/floor/inventory/parts/1/status", async ({ request }) => {
        const body = (await request.json()) as { status: string };
        statusOverridden = true;
        parts = parts.map((part) =>
          part.id === 1 ? { ...part, latest_event_action: body.status } : part,
        );
        return HttpResponse.json({ ...parts[0], latest_event_action: body.status });
      }),
    );
    render(<FloorInventoryPage />);

    await user.click(await screen.findByText("BBD-000101"));
    await user.click(await screen.findByRole("button", { name: "Change status" }));
    const status = screen.getByRole("combobox", { name: "Manual status" });
    expect(within(status).getByRole("option", { name: "Staged for Production" })).toBeInTheDocument();
    expect(within(status).getByRole("option", { name: "Support Removed" })).toBeInTheDocument();
    expect(within(status).getByRole("option", { name: "Overhang Removed" })).toBeInTheDocument();
    expect(within(status).getByRole("option", { name: "Hot Air Removed" })).toBeInTheDocument();
    expect(within(status).getByRole("option", { name: "Cleanup Pass" })).toBeInTheDocument();
    expect(within(status).getByRole("option", { name: "Fit Check Pass" })).toBeInTheDocument();
    expect(within(status).getByRole("option", { name: "Sanding" })).toBeInTheDocument();
    expect(within(status).getByRole("option", { name: "Rework" })).toBeInTheDocument();
    await user.selectOptions(status, "shipped");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Status overridden to Shipped")).toBeInTheDocument();
    expect(getStatusLabels("Shipped")).toHaveLength(1);
  });
});

const UNITS = [
  {
    id: 900,
    serial_code: "XG2SNP",
    top_part_id: 1,
    bottom_part_id: 201,
    top_sticker: "BBD-000101",
    bottom_sticker: "BBD-000201",
    top_part_code: "TOP",
    bottom_part_code: "BOT",
    knob_batch_id: 11,
    button_batch_id: 12,
    knob_bin_payload: "BBN-KNB-1",
    button_bin_payload: "BBN-BUT-1",
    linked_at: "2026-08-27T10:00:00",
    unit_workflow_status: "shipped" as const,
  },
  {
    id: 901,
    serial_code: "8TBDT9",
    top_part_id: 3,
    bottom_part_id: 203,
    top_sticker: "BBD-000303",
    bottom_sticker: "BBD-000403",
    top_part_code: "TOP",
    bottom_part_code: "BOT",
    knob_batch_id: 21,
    button_batch_id: 22,
    knob_bin_payload: "BBN-KNB-2",
    button_bin_payload: "BBN-BUT-2",
    linked_at: "2026-08-26T09:00:00",
    unit_workflow_status: "rework" as const,
  },
];

function mockUnits(units = UNITS) {
  server.use(
    http.get("/api/v1/floor/inventory/units", () => HttpResponse.json(units)),
  );
}

describe("FloorInventoryPage — Serials tab", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("lists linked product units under a Serials tab", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    mockUnits();
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("button", { name: "Serials" }));

    expect(await screen.findByText("XG2SNP")).toBeInTheDocument();
    expect(screen.getByText("8TBDT9")).toBeInTheDocument();
    expect(screen.getByText("BBD-000201")).toBeInTheDocument();
    expect(screen.getAllByText("BBN-KNB-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("BBN-BUT-1").length).toBeGreaterThan(0);
  });

  it("shows shipped / rework status on each serial row and the assembly card", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    mockUnits();
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("button", { name: "Serials" }));

    const shippedRow = (await screen.findByText("XG2SNP")).closest("tr");
    const reworkRow = screen.getByText("8TBDT9").closest("tr");
    expect(shippedRow).not.toBeNull();
    expect(reworkRow).not.toBeNull();
    expect(within(shippedRow as HTMLElement).getByText("Shipped")).toBeInTheDocument();
    expect(within(reworkRow as HTMLElement).getByText("Rework")).toBeInTheDocument();

    await user.click(shippedRow as HTMLElement);
    expect(await screen.findByRole("heading", { name: "XG2SNP" })).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Assembly detail")).getByText("Shipped"),
    ).toBeInTheDocument();
  });

  it("sorts serials with the same last-scanned / labeled options as Part history", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    mockUnits();
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("button", { name: "Serials" }));
    await screen.findByText("XG2SNP");

    const serialOrder = () => {
      const newerScan = screen.getByText("XG2SNP");
      const olderScan = screen.getByText("8TBDT9");
      return newerScan.compareDocumentPosition(olderScan) & Node.DOCUMENT_POSITION_FOLLOWING
        ? ["XG2SNP", "8TBDT9"]
        : ["8TBDT9", "XG2SNP"];
    };

    // Default: last scanned newest — XG2SNP housing labeled later than 8TBDT9's.
    expect(serialOrder()).toEqual(["XG2SNP", "8TBDT9"]);

    await user.selectOptions(screen.getByLabelText("Sort by"), "labeled_asc");
    expect(serialOrder()).toEqual(["8TBDT9", "XG2SNP"]);

    await user.selectOptions(screen.getByLabelText("Sort by"), "labeled_desc");
    expect(serialOrder()).toEqual(["XG2SNP", "8TBDT9"]);
  });

  it("filters serials by serial or either sticker", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    mockUnits();
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("button", { name: "Serials" }));
    await screen.findByText("XG2SNP");

    const search = screen.getByPlaceholderText("Search serial or sticker");
    await user.type(search, "000201");

    expect(screen.getByText("XG2SNP")).toBeInTheDocument();
    expect(screen.queryByText("8TBDT9")).not.toBeInTheDocument();
  });

  it("opens the assembly card and unlinks a unit", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    mockUnits();
    let unlinkedId: string | null = null;
    server.use(
      http.post("/api/v1/floor/units/:id/unlink", ({ params }) => {
        unlinkedId = String(params.id);
        return HttpResponse.json({ result: "unlinked", unit_id: 900, serial_code: "XG2SNP" });
      }),
    );
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("button", { name: "Serials" }));
    await user.click(await screen.findByText("XG2SNP"));

    // Assembly card shows the four identities.
    expect(await screen.findByRole("heading", { name: "XG2SNP" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Unlink" }));
    await user.click(screen.getByRole("button", { name: "Unlink unit" }));

    await waitFor(() => expect(unlinkedId).toBe("900"));
  });

  it("replaces the top housing from the assembly card", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    mockUnits();
    let replaceBody: unknown = null;
    let replacedUnitId: string | null = null;
    server.use(
      http.post("/api/v1/floor/units/:id/replace", async ({ request, params }) => {
        replaceBody = await request.json();
        replacedUnitId = String(params.id);
        return HttpResponse.json({ result: "replaced", unit: { ...UNITS[0], top_sticker: "BBD-000999" } });
      }),
    );
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("button", { name: "Serials" }));
    await user.click(await screen.findByText("XG2SNP"));

    await user.click(screen.getByRole("button", { name: "Replace top" }));
    const input = await screen.findByLabelText("New top sticker");
    await user.type(input, "BBD-000999");
    await user.click(screen.getByRole("button", { name: "Replace housing" }));

    await waitFor(() => expect(replaceBody).toEqual({ top_sticker: "BBD-000999" }));
    expect(replacedUnitId).toBe("900");
  });

  it("collapses a linked housing into a serial row that expands and can open Serials", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    mockUnits();
    render(<FloorInventoryPage />);

    // Part BBD-000101 (id 1) is the TOP of unit XG2SNP → it collapses into a
    // single serial row keyed by the product serial, so the raw sticker no
    // longer appears as its own standalone part row.
    const serialRow = (await screen.findByText("XG2SNP")).closest("tr");
    expect(serialRow).not.toBeNull();
    expect(within(serialRow as HTMLElement).getByText("BBD-000101")).toBeInTheDocument();

    await user.click(serialRow as HTMLElement);
    expect(serialRow).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("BBD-000201").length).toBeGreaterThan(0);

    await user.click(
      within(serialRow as HTMLElement).getByRole("button", { name: "Open in Serials" }),
    );
    expect(await screen.findByRole("heading", { name: "XG2SNP" })).toBeInTheDocument();
    expect(screen.getByLabelText("Assembly detail")).toBeInTheDocument();
  });

  it("links the top and bottom stickers from the assembly card to the Parts tab", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    mockUnits();
    server.use(
      http.get("/api/v1/floor/inventory/bins", () => HttpResponse.json([])),
    );
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("button", { name: "Serials" }));
    await user.click(await screen.findByText("XG2SNP"));
    await screen.findByRole("heading", { name: "XG2SNP" });

    await user.click(await screen.findByRole("button", { name: "Open part BBD-000101" }));

    expect(await screen.findByRole("heading", { name: "Part history" })).toBeInTheDocument();
    const search = await screen.findByRole("textbox", { name: "Search part history" });
    expect(search).toHaveValue("XG2SNP");

    const serialRow = (await screen.findByText("XG2SNP")).closest("tr");
    expect(serialRow).not.toBeNull();
    expect(serialRow).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("heading", { name: "BBD-000101" })).toBeInTheDocument();
    expect(screen.getByLabelText("Part detail")).toBeInTheDocument();
  });

  it("links the knob and button batches from the assembly card to Part history", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    mockUnits();
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-KNB-1",
            bin_number: 1,
            part_code: "KNB",
            part_name: "Knob bin",
            status: "wip",
            batch: {
              id: 11,
              payload: "BBN-KNB-1",
              bin_number: 1,
              printer_id: 4,
              printer_name: "X1 Carbon 04",
              archive_id: 31,
              print_name: "Knob plate",
              part_code: "KNB",
              quantity: 20,
              qc_passed_quantity: 18,
              remaining_quantity: 9,
              status: "wip",
              harvested_at: "2026-08-26T14:35:00",
            },
          },
        ]),
      ),
      http.get("/api/v1/floor/inventory/bins/batches/:batchId/events", () =>
        HttpResponse.json([
          {
            id: 201,
            action: "harvested",
            details: { quantity: 20 },
            occurred_at: "2026-08-26T14:35:00",
          },
        ]),
      ),
    );
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("button", { name: "Serials" }));
    await user.click(await screen.findByText("XG2SNP"));

    await user.click(await screen.findByRole("button", { name: /Open bin batch BBN-KNB-1 · #11/i }));

    expect(await screen.findByRole("heading", { name: "Part history" })).toBeInTheDocument();
    const search = await screen.findByRole("textbox", { name: "Search part history" });
    expect(search).toHaveValue("XG2SNP");

    const serialRow = (await screen.findByText("XG2SNP")).closest("tr");
    expect(serialRow).not.toBeNull();
    expect(serialRow).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("heading", { name: "BBN-KNB-1 #11" })).toBeInTheDocument();
    expect(screen.getByLabelText("Bin detail")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /KNB BBN-KNB-1 #11/i })).toBeInTheDocument();
  });

  it("replaces the knob harvest from a past or current fill on the assembly card", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    mockUnits();
    let replaceBody: unknown = null;
    server.use(
      http.get("/api/v1/floor/inventory/bins", () =>
        HttpResponse.json([
          {
            payload: "BBN-KNB-1",
            bin_number: 1,
            part_code: "KNB",
            part_name: "Knob bin",
            status: "wip",
            batch: {
              id: 11,
              payload: "BBN-KNB-1",
              bin_number: 1,
              printer_id: 4,
              printer_name: "X1",
              archive_id: 31,
              print_name: "Knob plate",
              part_code: "KNB",
              quantity: 20,
              remaining_quantity: 9,
              status: "wip",
              harvested_at: "2026-08-26T14:35:00",
            },
          },
          {
            payload: "BBN-KNB-2",
            bin_number: 2,
            part_code: "KNB",
            part_name: "Knob bin",
            status: "ready_for_production",
            batch: {
              id: 13,
              payload: "BBN-KNB-2",
              bin_number: 2,
              printer_id: 5,
              printer_name: "P1S",
              archive_id: 32,
              print_name: "Knob plate",
              part_code: "KNB",
              quantity: 5,
              remaining_quantity: 5,
              status: "ready_for_production",
              harvested_at: "2026-08-27T10:00:00",
            },
          },
        ]),
      ),
      http.post("/api/v1/floor/units/:id/replace-kit", async ({ request, params }) => {
        replaceBody = { id: params.id, ...(await request.json()) };
        return HttpResponse.json({
          result: "replaced",
          unit: { ...UNITS[0], knob_batch_id: 13, knob_bin_payload: "BBN-KNB-2" },
          slot: "KNB",
          previous_batch_id: 11,
          new_batch_id: 13,
          previous_remaining: 10,
          new_remaining: 4,
        });
      }),
    );
    render(<FloorInventoryPage />);

    await user.click(screen.getByRole("button", { name: "Serials" }));
    await user.click(await screen.findByText("XG2SNP"));
    await user.click(screen.getByRole("button", { name: "Replace knob" }));

    expect(await screen.findByText("BBN-KNB-2 · #13")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /BBN-KNB-2 · #13/i }));
    await user.click(screen.getByRole("button", { name: "Replace harvest" }));

    await waitFor(() =>
      expect(replaceBody).toEqual({ id: "900", slot: "KNB", batch_id: 13 }),
    );
  });

  it("deep-links an unknown unit id with a not-found prompt", async () => {
    mockPartHistory();
    mockUnits();
    window.history.pushState({}, "", "/inventory?tab=serials&unit=99999");
    render(<FloorInventoryPage />);

    expect(
      await screen.findByText(/That serial is not in the list/i),
    ).toBeInTheDocument();
  });
});

// Part Assembly Linking: linked TOP + BOT housings that share a product unit
// collapse into a single serial row on the Part history (Parts) tab, keyed by
// the product serial, instead of appearing as two separate sticker rows.
const COLLAPSE_PARTS = [
  {
    id: 10,
    sticker_code: "BBD-000501",
    printer_id: 4,
    printer_name: "X1 Carbon 04",
    archive_id: 51,
    part_code: "TOP",
    print_name: "Top plate",
    labeled_at: "2026-08-27T09:00:00",
    archived_at: null,
    released_at: null,
  },
  {
    id: 11,
    sticker_code: "BBD-000601",
    printer_id: 4,
    printer_name: "X1 Carbon 04",
    archive_id: 52,
    part_code: "BOT",
    print_name: "Bottom plate",
    labeled_at: "2026-08-27T09:01:00",
    archived_at: null,
    released_at: null,
  },
  {
    id: 12,
    sticker_code: "BBD-000701",
    printer_id: 5,
    printer_name: "P1S 02",
    archive_id: 53,
    part_code: "TOP",
    print_name: "Loose top plate",
    labeled_at: "2026-08-27T09:02:00",
    archived_at: null,
    released_at: null,
  },
];

const COLLAPSE_UNIT = {
  id: 950,
  serial_code: "ZK5KFG",
  top_part_id: 10,
  bottom_part_id: 11,
  top_sticker: "BBD-000501",
  bottom_sticker: "BBD-000601",
  top_part_code: "TOP",
  bottom_part_code: "BOT",
  knob_batch_id: 31,
  button_batch_id: 32,
  knob_bin_payload: "BBN-KNB-9",
  button_bin_payload: "BBN-BUT-9",
  linked_at: "2026-08-27T10:30:00",
  unit_workflow_status: "shipped" as const,
};

const COLLAPSE_KIT_BINS = [
  {
    payload: "BBN-KNB-9",
    bin_number: 9,
    part_code: "KNB",
    part_name: "Knob bin",
    status: "wip",
    batch: {
      id: 31,
      payload: "BBN-KNB-9",
      bin_number: 9,
      printer_id: 4,
      printer_name: "X1 Carbon 04",
      archive_id: 61,
      print_name: "Knob plate",
      part_code: "KNB",
      quantity: 20,
      qc_passed_quantity: 18,
      remaining_quantity: 17,
      status: "wip",
      harvested_at: "2026-08-27T08:00:00",
      archived_at: null,
    },
  },
  {
    payload: "BBN-BUT-9",
    bin_number: 9,
    part_code: "BUT",
    part_name: "Button bin",
    status: "wip",
    batch: {
      id: 32,
      payload: "BBN-BUT-9",
      bin_number: 9,
      printer_id: 4,
      printer_name: "X1 Carbon 04",
      archive_id: 62,
      print_name: "Button plate",
      part_code: "BUT",
      quantity: 25,
      qc_passed_quantity: 25,
      remaining_quantity: 24,
      status: "wip",
      harvested_at: "2026-08-27T08:05:00",
      archived_at: null,
    },
  },
];

function mockCollapse() {
  server.use(
    http.get("/api/v1/floor/inventory/parts", () => HttpResponse.json(COLLAPSE_PARTS)),
    http.get("/api/v1/floor/inventory/print-failures", () => HttpResponse.json([])),
    http.get("/api/v1/floor/inventory/bins", () => HttpResponse.json(COLLAPSE_KIT_BINS)),
    http.get("/api/v1/floor/inventory/parts/:id/events", ({ params }) =>
      HttpResponse.json([
        {
          id: Number(params.id) * 10,
          action: "enrolled",
          details: { archive_id: 51 },
          occurred_at: "2026-08-27T09:00:00",
        },
        {
          id: Number(params.id) * 10 + 1,
          action: "wip",
          details: null,
          occurred_at: "2026-08-27T09:10:00",
        },
      ]),
    ),
    http.get("/api/v1/floor/inventory/bins/batches/:batchId/events", () =>
      HttpResponse.json([
        {
          id: 301,
          action: "harvested",
          details: { quantity: 20 },
          occurred_at: "2026-08-27T08:00:00",
        },
      ]),
    ),
    http.get("/api/v1/floor/inventory/parts/:id/job-candidates", () => HttpResponse.json([])),
    http.get("/api/v1/floor/inventory/units", () => HttpResponse.json([COLLAPSE_UNIT])),
  );
}

describe("FloorInventoryPage — Part history serial collapse", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("collapses a linked TOP and BOT into one serial row, not two sticker rows", async () => {
    mockCollapse();
    render(<FloorInventoryPage />);

    // The serial row shows once for the product serial.
    const serial = await screen.findByText("ZK5KFG");
    const serialRow = serial.closest("tr");
    expect(serialRow).not.toBeNull();

    // Both housing stickers live inside that single serial row — there is no
    // separate standalone part row for either housing.
    expect(within(serialRow as HTMLElement).getByText("BBD-000501")).toBeInTheDocument();
    expect(within(serialRow as HTMLElement).getByText("BBD-000601")).toBeInTheDocument();
    expect(screen.getAllByText("BBD-000501")).toHaveLength(1);
    expect(screen.getAllByText("BBD-000601")).toHaveLength(1);

    // The unlinked, standalone housing still appears as its own part row.
    expect(screen.getByText("BBD-000701")).toBeInTheDocument();
  });

  it("shows Rework on the serial row when the unit was returned to rework (both housings)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json(
          COLLAPSE_PARTS.map((part) =>
            part.id === 10 || part.id === 11
              ? { ...part, latest_event_action: "rework" }
              : part,
          ),
        ),
      ),
      http.get("/api/v1/floor/inventory/bins", () => HttpResponse.json(COLLAPSE_KIT_BINS)),
      http.get("/api/v1/floor/inventory/units", () =>
        HttpResponse.json([{ ...COLLAPSE_UNIT, unit_workflow_status: "rework" }]),
      ),
    );
    render(<FloorInventoryPage />);

    const serialRow = (await screen.findByText("ZK5KFG")).closest("tr");
    expect(serialRow).not.toBeNull();
    expect(within(serialRow as HTMLElement).getByText("Rework")).toBeInTheDocument();
    expect(within(serialRow as HTMLElement).queryByText("Linked")).not.toBeInTheDocument();

    await user.click(serialRow as HTMLElement);
    // Only TOP/BOT housings go to rework — kit bin slots keep their bin status.
    expect(within(screen.getByRole("row", { name: "TOP BBD-000501" })).getByText("Rework")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: "BOT BBD-000601" })).getByText("Rework")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: "KNB BBN-KNB-9 #31" })).queryByText("Rework")).not.toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: "BUT BBN-BUT-9 #32" })).queryByText("Rework")).not.toBeInTheDocument();
  });

  it("keeps Linked on the serial row when only one housing is in rework", async () => {
    server.use(
      http.get("/api/v1/floor/inventory/parts", () =>
        HttpResponse.json(
          COLLAPSE_PARTS.map((part) =>
            part.id === 10
              ? { ...part, latest_event_action: "rework" }
              : part.id === 11
                ? { ...part, latest_event_action: "shipped" }
                : part,
          ),
        ),
      ),
      http.get("/api/v1/floor/inventory/bins", () => HttpResponse.json(COLLAPSE_KIT_BINS)),
      http.get("/api/v1/floor/inventory/units", () =>
        HttpResponse.json([{ ...COLLAPSE_UNIT, unit_workflow_status: "mixed" }]),
      ),
    );
    render(<FloorInventoryPage />);

    const serialRow = (await screen.findByText("ZK5KFG")).closest("tr");
    expect(serialRow).not.toBeNull();
    expect(within(serialRow as HTMLElement).getByText("Linked")).toBeInTheDocument();
    expect(within(serialRow as HTMLElement).queryByText("Rework")).not.toBeInTheDocument();
  });

  it("expands the serial row into TOP, BOT, knob, and button slots without leaving Part history", async () => {
    const user = userEvent.setup();
    mockCollapse();
    render(<FloorInventoryPage />);

    const serialRow = (await screen.findByText("ZK5KFG")).closest("tr");
    await user.click(serialRow as HTMLElement);

    expect(screen.queryByLabelText("Assembly detail")).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: "TOP BBD-000501" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "BOT BBD-000601" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "KNB BBN-KNB-9 #31" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "BUT BBN-BUT-9 #32" })).toBeInTheDocument();
  });

  it("opens part history on the right when a housing slot is clicked", async () => {
    const user = userEvent.setup();
    mockCollapse();
    render(<FloorInventoryPage />);

    const serialRow = (await screen.findByText("ZK5KFG")).closest("tr");
    await user.click(serialRow as HTMLElement);
    await user.click(screen.getByRole("row", { name: "TOP BBD-000501" }));

    expect(await screen.findByRole("heading", { name: "BBD-000501" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Assembly detail")).not.toBeInTheDocument();
    expect(screen.getByText("ZK5KFG")).toBeInTheDocument();
  });

  it("opens bin history on the right when a kit slot is clicked", async () => {
    const user = userEvent.setup();
    mockCollapse();
    render(<FloorInventoryPage />);

    const serialRow = (await screen.findByText("ZK5KFG")).closest("tr");
    await user.click(serialRow as HTMLElement);
    await user.click(screen.getByRole("row", { name: "BUT BBN-BUT-9 #32" }));

    expect(await screen.findByRole("heading", { name: "BBN-BUT-9 #32" })).toBeInTheDocument();
    expect(screen.getByLabelText("Bin detail")).toBeInTheDocument();
    expect(screen.getByText("ZK5KFG")).toBeInTheDocument();
  });

  it("keeps a link to open the unit on the Serials tab", async () => {
    const user = userEvent.setup();
    mockCollapse();
    render(<FloorInventoryPage />);

    const serialRow = (await screen.findByText("ZK5KFG")).closest("tr");
    await user.click(within(serialRow as HTMLElement).getByRole("button", { name: "Open in Serials" }));

    expect(await screen.findByRole("heading", { name: "ZK5KFG" })).toBeInTheDocument();
    expect(screen.getByLabelText("Assembly detail")).toBeInTheDocument();
  });

  it("keeps unlinked stickers as their own individual part rows", async () => {
    const user = userEvent.setup();
    mockCollapse();
    render(<FloorInventoryPage />);

    const loose = await screen.findByText("BBD-000701");
    await user.click(loose);

    // A standalone part opens the ordinary part detail, not the assembly card.
    expect(await screen.findByRole("heading", { name: "BBD-000701" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Assembly detail")).not.toBeInTheDocument();
  });

  it("finds the serial row when searching by either housing sticker", async () => {
    const user = userEvent.setup();
    mockCollapse();
    render(<FloorInventoryPage />);

    await screen.findByText("ZK5KFG");
    await user.type(
      screen.getByRole("textbox", { name: "Search part history" }),
      "000601",
    );

    expect(screen.getByText("ZK5KFG")).toBeInTheDocument();
    expect(screen.queryByText("BBD-000701")).not.toBeInTheDocument();
  });
});
