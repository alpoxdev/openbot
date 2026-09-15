import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ImportedHistory,
  type ImportedHistoryProps,
} from "@/components/channels/imported-history";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const THREADS = {
  nextCursor: null,
  threads: [
    {
      id: "thread-import",
      agentId: "bot-gone",
      channelId: null,
      provenance: "import",
      localReadiness: "history_only",
      updatedAt: "2026-02-01T00:00:00.000Z",
      title: "Imported ledger",
      preview: "Chase the invoice",
    },
  ],
};

const MESSAGES = {
  messages: [
    { id: "m1", role: "user", content: "Chase overdue invoices" },
    {
      id: "m2",
      role: "assistant",
      content: "I will look it up.",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "search_ledger",
            arguments: '{"invoice":"A-9"}',
          },
        },
      ],
    },
    {
      id: "m3",
      role: "tool",
      toolCallId: "call-1",
      content: "Line 12: 400 due",
    },
  ],
};

const MEDIA_REFERENCE_MESSAGES = {
  messages: [
    {
      id: "m-attachment-reference",
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "url",
            value: "/api/attachments/attachment-ref-1",
          },
          metadata: {
            attachmentId: "attachment-ref-1",
            filename: "invoice.png",
          },
        },
        { type: "text", text: "Invoice attached" },
      ],
    },
  ],
};

const HISTORY_ONLY_DETAILS = {
  messages: [
    {
      id: "sandbox-call",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "sandbox-call-1",
          type: "function",
          function: {
            name: "generateSandboxedUi",
            arguments: '{"title":"Stored interface"}',
          },
        },
      ],
      extensions: {
        source: "import",
        structured: { revision: 3 },
      },
    },
    {
      id: "sandbox-result",
      role: "tool",
      toolCallId: "sandbox-call-1",
      content: "<script>window.__historyExecuted = true</script>",
      extensions: { result: { rows: [1, 2] } },
    },
    {
      id: "orphan-result",
      role: "tool",
      toolCallId: "missing-call",
      content: "orphan result",
    },
  ],
};

function mount(
  agentId?: string,
  props: Omit<ImportedHistoryProps, "agentId"> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportedHistory {...props} agentId={agentId} />
    </QueryClientProvider>,
  );
}

test("lists stored conversations from this server and renders message and tool text without executing", async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    methods.push(init?.method ?? "GET");
    if (
      path.startsWith("/api/copilotkit/threads?") ||
      path === "/api/copilotkit/threads"
    ) {
      return Response.json(THREADS);
    }
    if (path.includes("/messages")) {
      return Response.json(MESSAGES);
    }
    if (path.startsWith("/api/threads/")) {
      return Response.json({
        status: "local",
        localReadiness: "history_only",
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const view = mount("bot-gone");
  await view.findByText("Imported ledger");
  await view.findByText("Chase overdue invoices");
  await view.findByText("I will look it up.");
  await view.findByText("search_ledger");
  expect(view.getByText('{"invoice":"A-9"}')).toBeTruthy();
  expect(view.getByText("Line 12: 400 due")).toBeTruthy();
  expect(view.getByText(/read-only/i)).toBeTruthy();
  expect(methods.every((method) => method === "GET")).toBe(true);
  globalThis.fetch = originalFetch;
});

test("records canonical media references without fetching or claiming file bytes", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (
      path.startsWith("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      return Response.json(THREADS);
    }
    if (path.includes("/messages")) {
      return Response.json(MEDIA_REFERENCE_MESSAGES);
    }
    if (path.startsWith("/api/threads/")) {
      return Response.json({
        status: "local",
        localReadiness: "history_only",
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const view = mount("bot-gone");
  await view.findByText("Invoice attached");
  expect(
    view.getByText(
      "1 attachment reference recorded; files are not fetched automatically.",
    ),
  ).toBeTruthy();
  expect(paths.some((path) => path.includes("/api/attachments/"))).toBe(false);
  expect(view.container.querySelector("img")).toBeNull();
  globalThis.fetch = originalFetch;
});

test("keeps canonical history-only records in an escaped expandable details view", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (
      path.includes("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      return Response.json(THREADS);
    }
    if (path.includes("/messages")) return Response.json(HISTORY_ONLY_DETAILS);
    if (path.startsWith("/api/threads/")) {
      return Response.json({
        status: "local",
        localReadiness: "history_only",
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const view = mount("bot-gone");
  await view.findByText(/Full stored message records \(3\)/);
  expect(
    view.getByText(
      "No messages can be shown in the formatted view. The stored records are available in the expandable details below.",
    ),
  ).toBeTruthy();

  const summary = view.getByText(/Full stored message records \(3\)/);
  await userEvent
    .setup({ document: view.container.ownerDocument })
    .click(summary);
  const records = view.container.querySelector("details pre");
  expect(records).toBeTruthy();
  const text = records?.textContent ?? "";
  expect(text).toContain("generateSandboxedUi");
  expect(text).toContain("sandbox-result");
  expect(text).toContain("orphan-result");
  expect(text).toContain('"structured": {\n        "revision": 3\n      }');
  expect(text.indexOf("sandbox-call")).toBeLessThan(
    text.indexOf("sandbox-result"),
  );
  expect(text.indexOf("sandbox-result")).toBeLessThan(
    text.indexOf("orphan-result"),
  );
  expect(text).toContain("<script>window.__historyExecuted = true</script>");
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.container.querySelector("img, iframe")).toBeNull();
  globalThis.fetch = originalFetch;
});

test("a deleted-agent history remains readable without live handover", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (
      path.includes("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      return Response.json(THREADS);
    }
    if (path.includes("/messages")) return Response.json(MESSAGES);
    if (path.startsWith("/api/threads/")) {
      return Response.json({ status: "local", localReadiness: "history_only" });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const view = mount();
  await view.findByText("Imported ledger");
  await waitFor(() =>
    expect(view.getByText("Chase overdue invoices")).toBeTruthy(),
  );
  expect(view.queryByRole("button", { name: "Send message" })).toBeNull();
  globalThis.fetch = originalFetch;
});

test("import pending disables live handover copy", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (
      path.includes("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      return Response.json(THREADS);
    }
    if (path.includes("/messages")) return Response.json(MESSAGES);
    if (path.startsWith("/api/threads/")) {
      return Response.json({ status: "import_pending" });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const view = mount("bot-gone");
  await view.findByText(/Live handover is disabled/);
  globalThis.fetch = originalFetch;
});

test("history with no surviving agent id is still readable without an agent query", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (
      path.includes("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      return Response.json({
        nextCursor: null,
        threads: [
          {
            ...THREADS.threads[0],
            agentId: null,
          },
        ],
      });
    }
    if (path.includes("/messages")) return Response.json(MESSAGES);
    if (path.startsWith("/api/threads/")) {
      return Response.json({
        status: "local",
        localReadiness: "history_only",
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const view = mount();
  await view.findByText("Imported ledger");
  await view.findByText("Chase overdue invoices");
  expect(
    paths
      .filter((path) => path.includes("/api/copilotkit/threads"))
      .every((path) => !path.includes("agentId=")),
  ).toBe(true);
  const messagesPath = paths.find((path) => path.includes("/messages"));
  expect(messagesPath).toBe("/api/copilotkit/threads/thread-import/messages");
  globalThis.fetch = originalFetch;
});

test("deep-link selection is limited to a listed thread and reports user selection", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (
      path.includes("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      return Response.json(THREADS);
    }
    if (path.includes("/messages")) return Response.json(MESSAGES);
    if (path.startsWith("/api/threads/")) {
      return Response.json({
        status: "local",
        localReadiness: "history_only",
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  let selected: string | undefined;
  const view = mount(undefined, {
    threadId: "thread-import",
    onThreadSelect: (threadId) => {
      selected = threadId;
    },
  });
  await view.findByText("Imported ledger");
  await userEvent
    .setup({ document: view.container.ownerDocument })
    .click(view.getByRole("button", { name: /Imported ledger/ }));
  expect(selected).toBe("thread-import");
  globalThis.fetch = originalFetch;
});

test("an unauthorized deep-link is reported instead of selecting another thread", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/api/copilotkit/threads")) return Response.json(THREADS);
    if (path === "/api/threads/not-listed") {
      return new Response("not found", { status: 404 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const view = mount(undefined, { threadId: "not-listed" });
  await view.findByRole("alert");
  expect(
    view.getByText(
      "This conversation is not available in your stored history.",
    ),
  ).toBeTruthy();
  expect(view.queryByText("Chase overdue invoices")).toBeNull();
  globalThis.fetch = originalFetch;
});

test("an authorized deep-link outside the first page reads before loading more", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (
      path.startsWith("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      return Response.json({
        nextCursor: "cursor-1",
        threads: THREADS.threads,
      });
    }
    if (path === "/api/threads/thread-old") {
      return Response.json({
        status: "local",
        localReadiness: "history_only",
      });
    }
    if (path === "/api/copilotkit/threads/thread-old/messages") {
      return Response.json(MESSAGES);
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const view = mount("bot-gone", { threadId: "thread-old" });
  await view.findByText("Chase overdue invoices");
  expect(
    view.queryByText(
      "This conversation is not available in your stored history.",
    ),
  ).toBeNull();
  expect(paths).toContain("/api/threads/thread-old");
  expect(paths).toContain("/api/copilotkit/threads/thread-old/messages");
  expect(view.queryByRole("button", { name: "Show more" })).toBeTruthy();
  globalThis.fetch = originalFetch;
});

test("an external off-page deep-link is denied without reading messages or retargeting", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (
      path.startsWith("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      return Response.json({
        nextCursor: "cursor-1",
        threads: THREADS.threads,
      });
    }
    if (path === "/api/threads/external-off-page") {
      return Response.json({ status: "external_unavailable" });
    }
    if (path.includes("/messages")) {
      throw new Error("external deep-link must not read messages");
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const view = mount("bot-gone", { threadId: "external-off-page" });
  await view.findByRole("alert");
  expect(
    view.getByText(
      "This conversation is not available in your stored history.",
    ),
  ).toBeTruthy();
  expect(view.queryByText("Chase overdue invoices")).toBeNull();
  expect(paths).toContain("/api/threads/external-off-page");
  expect(paths.some((path) => path.includes("/messages"))).toBe(false);
  expect(view.queryByRole("button", { name: "Show more" })).toBeTruthy();
  globalThis.fetch = originalFetch;
});

test("an external deep-link with an empty loaded index is denied without reading messages", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (
      path.startsWith("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      return Response.json({ nextCursor: null, threads: [] });
    }
    if (path === "/api/threads/external-empty-index") {
      return Response.json({ status: "external_unavailable" });
    }
    if (path.includes("/messages")) {
      throw new Error("external deep-link must not read messages");
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const view = mount(undefined, { threadId: "external-empty-index" });
  await view.findByRole("alert");
  expect(
    view.getByText(
      "This conversation is not available in your stored history.",
    ),
  ).toBeTruthy();
  expect(paths).toContain("/api/threads/external-empty-index");
  expect(paths.some((path) => path.includes("/messages"))).toBe(false);
  globalThis.fetch = originalFetch;
});

test("an authorized pending off-page deep-link stays read-only", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (
      path.startsWith("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      return Response.json({ nextCursor: null, threads: [] });
    }
    if (path === "/api/threads/pending-off-page") {
      return Response.json({
        status: "import_pending",
        localReadiness: "not_ready",
      });
    }
    if (path === "/api/copilotkit/threads/pending-off-page/messages") {
      return Response.json(MESSAGES);
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const view = mount(undefined, { threadId: "pending-off-page" });
  await view.findByText("Chase overdue invoices");
  expect(view.getByText(/Live handover is disabled/)).toBeTruthy();
  globalThis.fetch = originalFetch;
});

test("loads bounded history pages, keeps selected records, and deduplicates thread ids", async () => {
  const originalFetch = globalThis.fetch;
  const listPaths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (
      path.startsWith("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      listPaths.push(path);
      return listPaths.length === 1
        ? Response.json({
            nextCursor: "cursor-1",
            threads: THREADS.threads,
          })
        : Response.json({
            nextCursor: null,
            threads: [
              THREADS.threads[0],
              {
                ...THREADS.threads[0],
                id: "thread-second",
                title: "Second stored conversation",
              },
            ],
          });
    }
    if (path.includes("/messages")) return Response.json(MESSAGES);
    if (path.startsWith("/api/threads/")) {
      return Response.json({
        status: "local",
        localReadiness: "history_only",
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const view = mount("bot-gone");
  await view.findByText("Imported ledger");
  expect(view.getAllByText("Imported ledger")).toHaveLength(1);
  await userEvent
    .setup({ document: view.container.ownerDocument })
    .click(view.getByRole("button", { name: "Show more" }));
  await view.findByText("Second stored conversation");
  expect(view.getAllByText("Imported ledger")).toHaveLength(1);
  expect(listPaths).toEqual([
    "/api/copilotkit/threads?agentId=bot-gone&limit=50",
    "/api/copilotkit/threads?agentId=bot-gone&limit=50&cursor=cursor-1",
  ]);
  globalThis.fetch = originalFetch;
});

test("a failed next page keeps prior history and shows a failure notice", async () => {
  const originalFetch = globalThis.fetch;
  let listCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (
      path.startsWith("/api/copilotkit/threads") &&
      !path.includes("/messages")
    ) {
      listCalls += 1;
      if (listCalls === 1) {
        return Response.json({
          nextCursor: "cursor-1",
          threads: THREADS.threads,
        });
      }
      return new Response("temporary failure", { status: 502 });
    }
    if (path.includes("/messages")) return Response.json(MESSAGES);
    if (path.startsWith("/api/threads/")) {
      return Response.json({
        status: "local",
        localReadiness: "history_only",
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const view = mount("bot-gone");
  await view.findByText("Imported ledger");
  await userEvent
    .setup({ document: view.container.ownerDocument })
    .click(view.getByRole("button", { name: "Show more" }));
  await view.findByText(
    "More stored conversations could not be loaded. Previously loaded history is still available.",
  );
  expect(view.getByText("Imported ledger")).toBeTruthy();
  globalThis.fetch = originalFetch;
});
