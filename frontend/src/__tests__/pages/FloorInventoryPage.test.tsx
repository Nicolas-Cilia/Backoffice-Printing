import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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

  it("clears the search from the inline X button", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    render(<FloorInventoryPage />);

    const search = screen.getByRole("textbox", { name: "Search part history" });
    await user.type(search, "bracket");
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(search).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
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

  it("replaces a sticker code and appends a timeline event", async () => {
    const user = userEvent.setup();
    mockPartHistory();
    let replaced = false;
    // Same reasoning as the unlink test above: the parts list handler must
    // reflect the new sticker code, or the post-mutation refetch reverts it.
    let parts = PARTS.map((part) => ({ ...part }));
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
        ];
        if (replaced) {
          events.push({
            id: 11,
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
              ? { ...part, sticker_code: body.new_sticker_code }
              : part,
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
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

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
      expect(screen.getAllByRole("listitem")).toHaveLength(2),
    );
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
              ? { ...part, latest_event_action: "fit_checked" }
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
    expect(await screen.findByText("Rework")).toBeInTheDocument();
    await user.click(screen.getByText("BBD-000101"));

    expect(
      await screen.findByText("Fit checked · Initial QC passed"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByText("Rework")).toHaveLength(2),
    );
    const timelineItems = await screen.findAllByRole("listitem");
    expect(timelineItems[1].querySelector("span")).toHaveClass("bg-green-500");
    expect(timelineItems[2].querySelector("span")).toHaveClass("bg-orange-500");
  });
});
