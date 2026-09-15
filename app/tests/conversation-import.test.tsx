import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationImport } from "@/components/settings/conversation-import";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import {
  CONVERSATION_IMPORTS_PATH,
  conversationImportKeys,
  defaultSourceOrigin,
  readBrowserThreadHints,
  type ConversationImportItem,
  type ConversationImportJob,
  type ConversationImportJobDetail,
  type ConversationImportPhase,
} from "@/lib/conversation-import";

const originalFetch = globalThis.fetch;
const originalDefaults = queryClient.getDefaultOptions();
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  queryClient.setDefaultOptions(originalDefaults);
  globalThis.fetch = originalFetch;
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterAll(() => GlobalRegistrator.unregister());

const JOB_ID = "job-1";

function job(
  phase: ConversationImportPhase,
  extra: Partial<ConversationImportJob> = {},
): ConversationImportJob {
  return {
    id: JOB_ID,
    sourceOrigin: "http://localhost",
    sourceReference: "ns-1",
    phase,
    manifest: {
      inventoryCompleteForDeclaredScope:
        extra.manifest?.inventoryCompleteForDeclaredScope ?? false,
      pairCount: extra.manifest?.pairCount ?? 1,
      threadCount: extra.manifest?.threadCount ?? 1,
      notes: extra.manifest?.notes ?? [],
      inventoryRevision: extra.manifest?.inventoryRevision ?? 0,
    },
    approvedManifestHash: extra.approvedManifestHash ?? null,
    attemptStatus: extra.attemptStatus ?? "none",
    attemptKind: extra.attemptKind ?? null,
  };
}

function item(status: string): ConversationImportItem {
  return {
    id: "item-1",
    sourceThreadId: "thread-a",
    sourceUserId: "user-a",
    sourceAgentId: "agent-a",
    destinationUserId: "user-local",
    status,
    coverage: { messages: "partial" },
    failureCode: status === "failed" ? "gap" : null,
  };
}

function detail(
  phase: ConversationImportPhase,
  options: {
    items?: ConversationImportItem[];
    complete?: boolean;
    approved?: string | null;
    hash?: string | null;
    attemptStatus?: ConversationImportJob["attemptStatus"];
    attemptKind?: ConversationImportJob["attemptKind"];
  } = {},
): ConversationImportJobDetail {
  return {
    job: job(phase, {
      approvedManifestHash: options.approved ?? null,
      attemptStatus: options.attemptStatus,
      attemptKind: options.attemptKind,
      manifest: {
        inventoryCompleteForDeclaredScope: options.complete ?? false,
        pairCount: 1,
        threadCount: options.items?.length ?? 1,
        notes: [],
      },
    }),
    items: options.items ?? [item("discovered")],
    manifestHash: options.hash ?? "hash-1",
  };
}

function seedUser(queryClient: QueryClient, role: "admin" | "user") {
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "me",
    email: "me@example.test",
    role,
    onboarding: null,
  });
}

function mount(role: "admin" | "user" = "admin") {
  queryClient.clear();
  queryClient.setDefaultOptions({
    queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
  });
  seedUser(queryClient, role);
  queryClient.setQueryData(conversationImportKeys.list(), { jobs: [] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConversationImport />
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

test("ordinary users do not see the optional import panel", () => {
  const { view } = mount("user");
  expect(view.queryByText("Import old conversations")).toBeNull();
});

test("source origin is explicit and blocked browser storage is treated as unavailable", () => {
  expect(defaultSourceOrigin()).toBe("");
  const blockedStorage = {
    get length(): number {
      throw new Error("storage is blocked");
    },
    key(): string | null {
      throw new Error("storage is blocked");
    },
    getItem(): string | null {
      throw new Error("storage is blocked");
    },
  };
  expect(() => readBrowserThreadHints("me", blockedStorage)).not.toThrow();
  expect(readBrowserThreadHints("me", blockedStorage)).toEqual([]);
});

test("the panel is optional and does not require a project API key or login as a startup control", () => {
  const { view } = mount();
  expect(view.getByText("Import old conversations")).toBeTruthy();
  expect(view.getByText(/No CopilotKit account sign-in needed/)).toBeTruthy();
  expect(view.getByRole("button", { name: "Start import job" })).toBeTruthy();
  expect(view.getByLabelText("Old CopilotKit project API key")).toBeTruthy();
});

test("an active attempt disables duplicate actions while leaving cancellation available", async () => {
  const originalFetch = globalThis.fetch;
  let current = detail("inventory", {
    attemptStatus: "active",
    attemptKind: "inventory",
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (
      path === CONVERSATION_IMPORTS_PATH &&
      (init?.method ?? "GET") === "POST"
    ) {
      return Response.json({ job: current.job });
    }
    if (path === `${CONVERSATION_IMPORTS_PATH}/${JOB_ID}`) {
      return Response.json(current);
    }
    if (path.endsWith("/cancel")) {
      current = detail("cancelled", { attemptStatus: "none" });
      return Response.json({ job: current.job });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const { view, queryClient } = mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByLabelText("Source origin"),
    "https://old-source.example",
  );
  await user.type(view.getByLabelText("Source reference"), "ns-1");
  await user.click(view.getByRole("button", { name: "Start import job" }));
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  const discover = await view.findByRole("button", {
    name: "Discover conversations",
  });
  expect((discover as HTMLButtonElement).disabled).toBe(true);
  expect(view.queryByRole("button", { name: "Confirm inventory" })).toBeNull();
  expect(view.queryByRole("button", { name: "Import confirmed records" })).toBe(
    null,
  );
  await user.click(view.getByRole("button", { name: "Cancel" }));
  await view.findByText("Cancelled");
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  globalThis.fetch = originalFetch;
});

test("an expired run attempt offers resume only after fresh authorization", async () => {
  const calls: string[] = [];
  let current = detail("importing", {
    complete: true,
    approved: "hash-1",
    hash: "hash-1",
    attemptStatus: "expired",
    attemptKind: "run",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (
      path === CONVERSATION_IMPORTS_PATH &&
      (init?.method ?? "GET") === "POST"
    ) {
      return Response.json({ job: current.job });
    }
    if (path === `${CONVERSATION_IMPORTS_PATH}/${JOB_ID}`) {
      return Response.json(current);
    }
    if (path.endsWith("/run")) {
      current = detail("importing", {
        complete: true,
        approved: "hash-1",
        hash: "hash-1",
        attemptStatus: "active",
        attemptKind: "run",
      });
      return new Response(JSON.stringify({ job: current.job }), {
        status: 202,
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const { view, queryClient } = mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByLabelText("Source origin"),
    "https://old-source.example",
  );
  await user.type(view.getByLabelText("Source reference"), "ns-1");
  await user.click(view.getByRole("button", { name: "Start import job" }));
  const resume = await view.findByRole("button", { name: "Resume import" });
  expect((resume as HTMLButtonElement).disabled).toBe(true);
  await user.type(
    view.getByLabelText("Old CopilotKit project API key"),
    "secret-key",
  );
  await user.click(resume);
  expect(
    (view.getByLabelText("Old CopilotKit project API key") as HTMLInputElement)
      .value,
  ).toBe("");
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  await waitFor(() =>
    expect(calls.some((call) => call.endsWith("/run"))).toBe(true),
  );
  globalThis.fetch = originalFetch;
});

test("a failed partially published import stays visibly partial and can be resumed", async () => {
  const calls: string[] = [];
  const published = { ...item("published"), id: "item-published" };
  const failed = {
    ...item("failed"),
    id: "item-failed",
    failureCode: "source-changed",
  };
  let current = detail("failed", {
    complete: true,
    approved: "hash-1",
    hash: "hash-1",
    items: [published, failed],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (
      path === CONVERSATION_IMPORTS_PATH &&
      (init?.method ?? "GET") === "POST"
    ) {
      return Response.json({ job: current.job });
    }
    if (path === `${CONVERSATION_IMPORTS_PATH}/${JOB_ID}`) {
      return Response.json(current);
    }
    if (path.endsWith("/run")) {
      current = detail("importing", {
        complete: true,
        approved: "hash-1",
        hash: "hash-1",
        items: [published, failed],
      });
      return new Response(JSON.stringify({ job: current.job }), {
        status: 202,
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const { view, queryClient } = mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByLabelText("Source origin"),
    "https://old-source.example",
  );
  await user.type(view.getByLabelText("Source reference"), "ns-1");
  await user.click(view.getByRole("button", { name: "Start import job" }));
  await view.findByText(/records already stored on this server remain here/);
  expect(view.container.textContent).not.toMatch(
    /Confirm before anything is stored/,
  );
  const retry = await view.findByRole("button", { name: "Retry import" });
  expect((retry as HTMLButtonElement).disabled).toBe(true);
  await user.type(
    view.getByLabelText("Old CopilotKit project API key"),
    "secret-key",
  );
  await user.click(retry);
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  await waitFor(() =>
    expect(calls.some((call) => call.endsWith("/run"))).toBe(true),
  );
  globalThis.fetch = originalFetch;
});

test("confirm is required before run, and the project API key is not written to browser storage", async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  let current = detail("inventory");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path === CONVERSATION_IMPORTS_PATH && method === "POST") {
      current = detail("inventory");
      return Response.json({ job: current.job });
    }
    if (path === `${CONVERSATION_IMPORTS_PATH}/${JOB_ID}` && method === "GET") {
      return Response.json(current);
    }
    if (path.endsWith("/inventory")) {
      current = detail("awaiting_confirmation", {
        complete: true,
        hash: "hash-1",
      });
      return new Response(JSON.stringify({ job: current.job }), {
        status: 202,
      });
    }
    if (path.endsWith("/confirm")) {
      current = detail("awaiting_confirmation", {
        complete: true,
        hash: "hash-1",
        approved: "hash-1",
      });
      return Response.json({ job: current.job });
    }
    if (path.endsWith("/run")) {
      current = detail("importing", {
        complete: true,
        approved: "hash-1",
        hash: "hash-1",
      });
      return new Response(JSON.stringify({ job: current.job }), {
        status: 202,
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const { view, queryClient } = mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByLabelText("Source origin"),
    "https://old-source.example",
  );
  await user.type(view.getByLabelText("Source reference"), "ns-1");
  await user.type(
    view.getByLabelText("Old CopilotKit project API key"),
    "secret-key",
  );
  await user.click(view.getByRole("button", { name: "Start import job" }));
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);

  await view.findByRole("button", { name: "Discover conversations" });
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  expect(
    view.queryByRole("button", { name: "Import confirmed records" }),
  ).toBeNull();
  await user.click(
    view.getByRole("button", { name: "Discover conversations" }),
  );
  expect(
    (view.getByLabelText("Old CopilotKit project API key") as HTMLInputElement)
      .value,
  ).toBe("");
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data)
      .some((data) => JSON.stringify(data).includes("secret-key")),
  ).toBe(false);
  expect(
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state)
      .some((state) => JSON.stringify(state).includes("secret-key")),
  ).toBe(false);

  await view.findByText("Waiting for confirmation");
  expect(
    view.queryByRole("button", { name: "Import confirmed records" }),
  ).toBeNull();
  await user.click(view.getByRole("button", { name: "Confirm inventory" }));
  await view.findByRole("button", { name: "Import confirmed records" });
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  await user.type(
    view.getByLabelText("Old CopilotKit project API key"),
    "secret-key",
  );
  await user.click(
    view.getByRole("button", { name: "Import confirmed records" }),
  );
  await waitFor(() =>
    expect(calls.some((call) => call.path.endsWith("/run"))).toBe(true),
  );
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);

  expect(JSON.stringify(window.localStorage)).not.toContain("secret-key");
  expect(JSON.stringify(window.sessionStorage)).not.toContain("secret-key");
  expect(calls.find((call) => call.path.endsWith("/confirm"))?.body).toEqual({
    manifestHash: "hash-1",
  });
  expect(calls.find((call) => call.path.endsWith("/run"))?.body).toEqual({
    apiKey: "secret-key",
  });
  expect(calls.find((call) => call.path.endsWith("/inventory"))?.body).toEqual({
    apiKey: "secret-key",
  });
  globalThis.fetch = originalFetch;
});

test("a gapped inventory is not described as a complete history", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === CONVERSATION_IMPORTS_PATH && method === "POST") {
      return Response.json({ job: job("completed_with_gaps") });
    }
    if (path === `${CONVERSATION_IMPORTS_PATH}/${JOB_ID}`) {
      return Response.json(
        detail("completed_with_gaps", {
          complete: false,
          items: [item("failed")],
        }),
      );
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const { view } = mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByLabelText("Source origin"),
    "https://old-source.example",
  );
  await user.type(view.getByLabelText("Source reference"), "ns-1");
  await user.click(view.getByRole("button", { name: "Start import job" }));
  await view.findByText(
    "Finished with gaps — not a complete history of the source",
  );
  expect(
    view.getByText(/not a complete history of every conversation/),
  ).toBeTruthy();
  expect(
    view.getByText(/No imported records are reported as stored/),
  ).toBeTruthy();
  expect(view.container.textContent).not.toMatch(/all history/i);
  globalThis.fetch = originalFetch;
});

test("failed discovery before confirmation does not claim records were stored", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === CONVERSATION_IMPORTS_PATH && method === "POST") {
      return Response.json({ job: job("failed") });
    }
    if (path === `${CONVERSATION_IMPORTS_PATH}/${JOB_ID}`) {
      return Response.json(
        detail("failed", {
          complete: false,
          approved: null,
          items: [item("failed")],
        }),
      );
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const { view } = mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByLabelText("Source origin"),
    "https://old-source.example",
  );
  await user.type(view.getByLabelText("Source reference"), "ns-1");
  await user.click(view.getByRole("button", { name: "Start import job" }));
  await view.findByText(/No imported records are reported as stored/);
  expect(view.container.textContent).not.toMatch(
    /Imported records (already )?stored on this server/,
  );
  expect(view.container.textContent).not.toMatch(
    /Confirm before anything is stored/,
  );
  globalThis.fetch = originalFetch;
});

test("an approved gapped job can be explicitly retried with fresh authorization", async () => {
  const calls: string[] = [];
  let current = detail("completed_with_gaps", {
    complete: true,
    approved: "hash-1",
    hash: "hash-1",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (path === CONVERSATION_IMPORTS_PATH && method === "POST") {
      return Response.json({ job: current.job });
    }
    if (path === `${CONVERSATION_IMPORTS_PATH}/${JOB_ID}`) {
      return Response.json(current);
    }
    if (path.endsWith("/run")) {
      current = detail("importing", {
        complete: true,
        approved: "hash-1",
        hash: "hash-1",
      });
      return new Response(JSON.stringify({ job: current.job }), {
        status: 202,
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const { view } = mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByLabelText("Source origin"),
    "https://old-source.example",
  );
  await user.type(view.getByLabelText("Source reference"), "ns-1");
  await user.click(view.getByRole("button", { name: "Start import job" }));
  const retry = await view.findByRole("button", { name: "Retry import" });
  expect((retry as HTMLButtonElement).disabled).toBe(true);
  await user.type(
    view.getByLabelText("Old CopilotKit project API key"),
    "secret-key",
  );
  await user.click(retry);
  expect(
    (view.getByLabelText("Old CopilotKit project API key") as HTMLInputElement)
      .value,
  ).toBe("");
  await waitFor(() =>
    expect(calls.some((call) => call.endsWith("/run"))).toBe(true),
  );
  globalThis.fetch = originalFetch;
});

test("a failed job offers fresh discovery and requires a new confirmation", async () => {
  const calls: string[] = [];
  let current = detail("failed", {
    complete: false,
    approved: "old-hash",
    hash: "old-hash",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (path === CONVERSATION_IMPORTS_PATH && method === "POST") {
      return Response.json({ job: current.job });
    }
    if (path === `${CONVERSATION_IMPORTS_PATH}/${JOB_ID}`) {
      return Response.json(current);
    }
    if (path.endsWith("/inventory")) {
      current = detail("inventory", {
        complete: false,
        approved: null,
        hash: null,
      });
      return new Response(JSON.stringify({ job: current.job }), {
        status: 202,
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const { view } = mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByLabelText("Source origin"),
    "https://old-source.example",
  );
  await user.type(view.getByLabelText("Source reference"), "ns-1");
  await user.click(view.getByRole("button", { name: "Start import job" }));
  const retry = await view.findByRole("button", { name: "Retry discovery" });
  expect((retry as HTMLButtonElement).disabled).toBe(true);
  await user.type(
    view.getByLabelText("Old CopilotKit project API key"),
    "secret-key",
  );
  await user.click(retry);
  await waitFor(() =>
    expect(calls.some((call) => call.endsWith("/inventory"))).toBe(true),
  );
  await view.findByText("Discovering records");
  expect(view.queryByRole("button", { name: "Confirm inventory" })).toBeNull();
  globalThis.fetch = originalFetch;
});

test("cancel stays cancelled; paused inventory can reauthorize and resume", async () => {
  const calls: string[] = [];
  let current = detail("importing", { complete: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (path === CONVERSATION_IMPORTS_PATH && method === "POST") {
      current = detail("importing", { complete: false });
      return Response.json({ job: current.job });
    }
    if (path === `${CONVERSATION_IMPORTS_PATH}/${JOB_ID}` && method === "GET") {
      return Response.json(current);
    }
    if (path.endsWith("/cancel")) {
      current = detail("cancelled", { complete: false, hash: "hash-1" });
      return Response.json({ job: current.job });
    }
    if (path.endsWith("/inventory")) {
      return new Response(
        JSON.stringify({ error: "Cancelled jobs cannot inventory" }),
        {
          status: 409,
        },
      );
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const { view, queryClient } = mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByLabelText("Source origin"),
    "https://old-source.example",
  );
  await user.type(view.getByLabelText("Source reference"), "ns-1");
  await user.type(
    view.getByLabelText("Old CopilotKit project API key"),
    "secret-key",
  );
  await user.click(view.getByRole("button", { name: "Start import job" }));
  await view.findByRole("button", { name: "Cancel" });
  await user.click(view.getByRole("button", { name: "Cancel" }));
  await view.findByText("Cancelled");
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  expect(
    (view.getByLabelText("Old CopilotKit project API key") as HTMLInputElement)
      .value,
  ).toBe("");
  expect(
    view.queryByRole("button", { name: "Authorize and resume discovery" }),
  ).toBeNull();
  expect(
    view.queryByRole("button", { name: "Discover conversations" }),
  ).toBeNull();
  expect(calls.some((call) => call.endsWith("/cancel"))).toBe(true);
  expect(calls.some((call) => call.endsWith("/inventory"))).toBe(false);
  globalThis.fetch = originalFetch;
});

test("paused discovery can authorize and resume without starting a new job", async () => {
  const calls: { path: string; method: string }[] = [];
  let current = detail("paused", { complete: false, hash: "hash-1" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    if (path === CONVERSATION_IMPORTS_PATH && method === "POST") {
      current = detail("paused", { complete: false, hash: "hash-1" });
      return Response.json({ job: current.job });
    }
    if (path === `${CONVERSATION_IMPORTS_PATH}/${JOB_ID}` && method === "GET") {
      return Response.json(current);
    }
    if (path.endsWith("/inventory")) {
      current = detail("inventory", { complete: false });
      return new Response(JSON.stringify({ job: current.job }), {
        status: 202,
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const { view } = mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByLabelText("Source origin"),
    "https://old-source.example",
  );
  await user.type(view.getByLabelText("Source reference"), "ns-1");
  await user.type(
    view.getByLabelText("Old CopilotKit project API key"),
    "secret-key",
  );
  await user.click(view.getByRole("button", { name: "Start import job" }));
  await view.findByRole("button", { name: "Authorize and resume discovery" });
  await user.click(
    view.getByRole("button", { name: "Authorize and resume discovery" }),
  );
  await waitFor(() =>
    expect(calls.some((call) => call.path.endsWith("/inventory"))).toBe(true),
  );
  await view.findByText("Discovering records");
  globalThis.fetch = originalFetch;
});

test("remembered thread ids are opt-in hints and are not deleted", async () => {
  window.localStorage.setItem("openbot.bot-thread.agent-a", "thread-hint");
  const originalFetch = globalThis.fetch;
  let posted: unknown;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (
      path === CONVERSATION_IMPORTS_PATH &&
      (init?.method ?? "GET") === "POST"
    ) {
      posted = JSON.parse(String(init?.body ?? ""));
      return Response.json({ job: job("inventory") });
    }
    if (path === `${CONVERSATION_IMPORTS_PATH}/${JOB_ID}`) {
      return Response.json(detail("inventory"));
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const { view } = mount();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByLabelText("Use remembered thread ids as hints"));
  await user.type(
    view.getByLabelText("Source origin"),
    "https://old-source.example",
  );
  await user.type(view.getByLabelText("Source reference"), "ns-1");
  await user.click(view.getByRole("button", { name: "Start import job" }));
  await waitFor(() => expect(posted).toBeTruthy());
  expect(posted).toEqual({
    sourceOrigin: "https://old-source.example",
    sourceReference: "ns-1",
    explicitIds: [{ threadId: "thread-hint", userId: "me" }],
  });
  expect(window.localStorage.getItem("openbot.bot-thread.agent-a")).toBe(
    "thread-hint",
  );
  expect(readBrowserThreadHints("me")).toEqual([
    { threadId: "thread-hint", userId: "me" },
  ]);
  globalThis.fetch = originalFetch;
});
