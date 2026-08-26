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

    await user.click(screen.getByRole("button", { name: "Linked parts" }));
    expect(await screen.findByText("BBD-000101")).toBeInTheDocument();
    expect(screen.queryByText("BBD-000102")).not.toBeInTheDocument();
    expect(screen.queryByText("BBD-000103")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archived" }));
    expect(await screen.findByText("BBD-000103")).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Search part history" }),
      "000102",
    );
    expect(
      await screen.findByText("No part records match that search."),
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

    await user.click(screen.getByRole("button", { name: "Archived" }));
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

  it("uses green for fit checks and orange for sanding in the history timeline", async () => {
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
    expect(await screen.findByText("Sanding")).toBeInTheDocument();
    await user.click(screen.getByText("BBD-000101"));

    expect(
      await screen.findByText("Fit checked · Initial QC passed"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByText("Sanding")).toHaveLength(2),
    );
    const timelineItems = await screen.findAllByRole("listitem");
    expect(timelineItems[1].querySelector("span")).toHaveClass("bg-green-500");
    expect(timelineItems[2].querySelector("span")).toHaveClass("bg-orange-500");
  });
});
