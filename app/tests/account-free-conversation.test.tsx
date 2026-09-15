import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  type RenderResult,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createServer } from "node:net";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ImportedHistory } from "@/components/channels/imported-history";
import { testDatabaseUrl } from "../../server/tests/support/database";

const networkFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterAll(() => GlobalRegistrator.unregister());

type Fixture = {
  namespace: string;
  ownerUserId: string;
  foreignUserId: string;
  agentId: string;
  threadId: string;
  runId: string;
  userMessageId: string;
  assistantToolMessageId: string;
  toolResultMessageId: string;
  assistantFinalMessageId: string;
  continuationUserMessageId: string;
  continuationAssistantMessageId: string;
  ownerSessionToken: string;
  foreignSessionToken: string;
};

type Ready = {
  ownerUserId: string;
  foreignUserId: string;
  agentId: string;
  threadId: string;
  messages: Record<string, unknown>[];
  digest: string;
};

type RunningChild = {
  child: Bun.Subprocess;
  url: string;
  stdout: Promise<string>;
  stderr: Promise<string>;
};

function fixture(): Fixture {
  const namespace = `account-free-${randomUUID()}`;
  return {
    namespace,
    ownerUserId: `${namespace}-owner`,
    foreignUserId: `${namespace}-foreign`,
    agentId: `${namespace}-agent`,
    threadId: randomUUID(),
    runId: `${namespace}-run`,
    userMessageId: `${namespace}-user`,
    assistantToolMessageId: `${namespace}-assistant-tool`,
    toolResultMessageId: `${namespace}-tool-result`,
    assistantFinalMessageId: `${namespace}-assistant-final`,
    continuationUserMessageId: `${namespace}-continuation-user`,
    continuationAssistantMessageId: `${namespace}-continuation-assistant`,
    ownerSessionToken: `${namespace}-owner-session`,
    foreignSessionToken: `${namespace}-foreign-session`,
  };
}

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("fixture port was not allocated"));
      });
    });
  });
}

function childEnvironment(
  fixtureData: Fixture,
  mode: "seed" | "serve" | "cleanup",
  port?: number,
) {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TEST_DATABASE_URL: testDatabaseUrl(),
    ACCOUNT_FREE_FIXTURE: JSON.stringify(fixtureData),
    ACCOUNT_FREE_MODE: mode,
  };
  if (port !== undefined) environment.ACCOUNT_FREE_PORT = String(port);
  return environment;
}

async function stopChild(running: RunningChild | undefined) {
  if (!running) return;
  try {
    running.child.kill();
  } catch {
    // It may already have exited after a startup failure.
  }
  const exited = await Promise.race([
    running.child.exited.then(() => true),
    Bun.sleep(3_000).then(() => false),
  ]);
  if (!exited) {
    try {
      running.child.kill(9);
    } catch {
      // The process can exit between the timeout and the forced kill.
    }
    await Promise.race([running.child.exited, Bun.sleep(1_000)]);
  }
  await Promise.all([
    running.stdout.catch(() => ""),
    running.stderr.catch(() => ""),
  ]);
}

async function startChild(
  fixtureData: Fixture,
  mode: "seed" | "serve",
): Promise<RunningChild> {
  const port = await unusedPort();
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      "server/tests/support/account-free-history-server.ts",
    ],
    cwd: join(import.meta.dir, "../.."),
    env: childEnvironment(fixtureData, mode, port),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const running = {
    child,
    url: `http://127.0.0.1:${port}`,
    stdout,
    stderr,
  };
  const deadline = Date.now() + 10_000;
  let lastStatus = "not reachable";
  while (Date.now() < deadline) {
    try {
      const response = await networkFetch(`${running.url}/__fixture/ready`, {
        headers: {
          cookie: `account-free-session=${fixtureData.ownerSessionToken}`,
        },
      });
      if (response.ok) return running;
      lastStatus = `${response.status}`;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : "request failed";
    }
    await Bun.sleep(25);
  }
  await stopChild(running);
  throw new Error(`account-free fixture did not start (${lastStatus})`);
}

async function cleanupFixture(fixtureData: Fixture) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      "server/tests/support/account-free-history-server.ts",
    ],
    cwd: join(import.meta.dir, "../.."),
    env: childEnvironment(fixtureData, "cleanup"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let exitCode = await Promise.race([
    child.exited,
    Bun.sleep(5_000).then(() => null as number | null),
  ]);
  if (exitCode === null) {
    child.kill();
    exitCode = await Promise.race([
      child.exited,
      Bun.sleep(1_000).then(() => null as number | null),
    ]);
  }
  await output;
  if (exitCode === null)
    throw new Error("account-free fixture cleanup timed out");
  if (exitCode !== 0) throw new Error("account-free fixture cleanup failed");
}

function installBrowserFetch(
  url: string,
  token: string,
  requests: { path: string; method: string }[],
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const source =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const target = new URL(source, url);
    if (target.origin !== new URL(url).origin) {
      throw new Error("account-free browser fetch escaped the fixture");
    }
    const headers = new Headers(init?.headers);
    headers.set("cookie", `account-free-session=${token}`);
    requests.push({ path: target.pathname, method: init?.method ?? "GET" });
    return networkFetch(target, { ...init, headers });
  }) as typeof fetch;
  return original;
}

async function disposeBrowser(
  view: RenderResult,
  queryClient: QueryClient,
  originalFetch: typeof fetch,
) {
  view.unmount();
  queryClient.clear();
  window.localStorage.clear();
  window.sessionStorage.clear();
  await act(async () => {
    await Promise.resolve();
  });
  globalThis.fetch = originalFetch;
}

function messageDigest(messages: readonly Record<string, unknown>[]) {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(messages)))
    .digest("hex");
}

test("rebuilds owned PostgreSQL history in a fresh browser and server process", async () => {
  const fixtureData = fixture();
  testDatabaseUrl();
  let first: RunningChild | undefined;
  let second: RunningChild | undefined;
  let firstView: RenderResult | undefined;
  let secondView: RenderResult | undefined;
  let firstClient: QueryClient | undefined;
  let secondClient: QueryClient | undefined;
  let firstOriginalFetch: typeof fetch | undefined;
  let secondOriginalFetch: typeof fetch | undefined;

  try {
    first = await startChild(fixtureData, "seed");
    const ownerCookie = `account-free-session=${fixtureData.ownerSessionToken}`;
    const firstReadyResponse = await networkFetch(
      `${first.url}/__fixture/ready`,
      {
        headers: { cookie: ownerCookie },
      },
    );
    const firstReady = (await firstReadyResponse.json()) as Ready;
    expect(firstReady.threadId).toBe(fixtureData.threadId);
    expect(firstReady.ownerUserId).toBe(fixtureData.ownerUserId);

    const firstRequests: { path: string; method: string }[] = [];
    firstOriginalFetch = installBrowserFetch(
      first.url,
      fixtureData.ownerSessionToken,
      firstRequests,
    );
    firstClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    firstView = render(
      <QueryClientProvider client={firstClient}>
        <ImportedHistory />
      </QueryClientProvider>,
    );
    await firstView.findByText("Stored conversations");
    expect(
      await firstView.findAllByText("Account-free user fixture request."),
    ).not.toHaveLength(0);
    await firstView.findByText(
      "Assistant fixture is checking the account-free ledger.",
    );
    await firstView.findByText(
      "Assistant fixture final answer: the record is settled.",
    );
    const toolLabel = firstView.getByText("account_free_lookup");
    await userEvent
      .setup({ document: firstView.container.ownerDocument })
      .click(toolLabel);
    expect(toolLabel.closest("details")?.open).toBe(true);
    await firstView.findByText(
      "Detailed fixture tool result: record fixture-42 is settled.",
    );
    expect(firstView.getByText(/read-only/i)).toBeTruthy();

    const firstMessagesResponse = await networkFetch(
      `${first.url}/api/copilotkit/threads/${fixtureData.threadId}/messages`,
      { headers: { cookie: ownerCookie } },
    );
    expect(firstMessagesResponse.status).toBe(200);
    const firstMessagesBody = (await firstMessagesResponse.json()) as {
      messages: Record<string, unknown>[];
    };
    const expectedIds = firstReady.messages.map((message) => message.id);
    expect(firstMessagesBody.messages.map((message) => message.id)).toEqual(
      expectedIds,
    );
    expect(firstMessagesBody.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messageDigest(firstMessagesBody.messages)).toBe(firstReady.digest);
    expect(firstMessagesBody.messages[1]?.toolCalls).toBeTruthy();
    const firstAssistant = firstMessagesBody.messages[1] as
      | { toolCalls?: { id?: string }[] }
      | undefined;
    const firstTool = firstMessagesBody.messages[2] as
      | { toolCallId?: string }
      | undefined;
    expect(firstTool?.toolCallId).toBe(firstAssistant?.toolCalls?.[0]?.id);

    const firstStateResponse = await networkFetch(
      `${first.url}/__fixture/state`,
      {
        headers: { cookie: ownerCookie },
      },
    );
    const firstState = (await firstStateResponse.json()) as {
      messages: Record<string, unknown>[];
      digest: string;
      thread: { id: string; ownerUserId: string; localReadiness: string };
    };
    expect(firstState.thread).toMatchObject({
      id: fixtureData.threadId,
      ownerUserId: fixtureData.ownerUserId,
      localReadiness: "history_only",
    });
    expect(firstState.messages.map((message) => message.id)).toEqual(
      expectedIds,
    );
    expect(firstState.digest).toBe(firstReady.digest);
    expect(firstRequests.every((request) => request.method === "GET")).toBe(
      true,
    );
    expect(
      firstRequests.some((request) => request.path.includes("/messages")),
    ).toBe(true);
    expect(
      firstRequests.some((request) => request.path.includes("/agent/")),
    ).toBe(false);

    window.localStorage.setItem("account-free-test", "stale");
    window.sessionStorage.setItem("account-free-test", "stale");
    await disposeBrowser(firstView, firstClient, firstOriginalFetch);
    firstView = undefined;
    firstClient = undefined;
    firstOriginalFetch = undefined;
    expect(window.localStorage.getItem("account-free-test")).toBeNull();
    expect(window.sessionStorage.getItem("account-free-test")).toBeNull();
    await stopChild(first);
    first = undefined;

    second = await startChild(fixtureData, "serve");
    const secondRequests: { path: string; method: string }[] = [];
    secondOriginalFetch = installBrowserFetch(
      second.url,
      fixtureData.ownerSessionToken,
      secondRequests,
    );
    secondClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    secondView = render(
      <QueryClientProvider client={secondClient}>
        <ImportedHistory />
      </QueryClientProvider>,
    );
    await secondView.findByText("Stored conversations");
    expect(
      await secondView.findAllByText("Account-free user fixture request."),
    ).not.toHaveLength(0);
    await secondView.findByText(
      "Assistant fixture is checking the account-free ledger.",
    );
    await secondView.findByText(
      "Assistant fixture final answer: the record is settled.",
    );
    const secondToolLabel = secondView.getByText("account_free_lookup");
    await userEvent
      .setup({ document: secondView.container.ownerDocument })
      .click(secondToolLabel);
    expect(secondToolLabel.closest("details")?.open).toBe(true);
    await secondView.findByText(
      "Detailed fixture tool result: record fixture-42 is settled.",
    );
    await secondView.findByText("Deterministic engine continuation completed.");
    expect(secondView.getByText(/read-only/i)).toBeTruthy();

    const secondMessagesResponse = await networkFetch(
      `${second.url}/api/copilotkit/threads/${fixtureData.threadId}/messages`,
      { headers: { cookie: ownerCookie } },
    );
    expect(secondMessagesResponse.status).toBe(200);
    const secondMessagesBody = (await secondMessagesResponse.json()) as {
      messages: Record<string, unknown>[];
    };
    expect(secondMessagesBody.messages.map((message) => message.id)).toEqual(
      expectedIds,
    );
    expect(messageDigest(secondMessagesBody.messages)).toBe(firstReady.digest);
    expect(secondRequests.every((request) => request.method === "GET")).toBe(
      true,
    );
    expect(
      secondRequests.some((request) => request.path.includes("/agent/")),
    ).toBe(false);

    const unauthenticated = await networkFetch(
      `${second.url}/api/copilotkit/threads`,
    );
    expect(unauthenticated.status).toBe(401);
    const foreignList = await networkFetch(
      `${second.url}/api/copilotkit/threads`,
      {
        headers: {
          cookie: `account-free-session=${fixtureData.foreignSessionToken}`,
        },
      },
    );
    expect(foreignList.status).toBe(200);
    expect((await foreignList.json()).threads).toEqual([]);
    const foreignMessages = await networkFetch(
      `${second.url}/api/copilotkit/threads/${fixtureData.threadId}/messages`,
      {
        headers: {
          cookie: `account-free-session=${fixtureData.foreignSessionToken}`,
        },
      },
    );
    expect(foreignMessages.status).toBe(404);
  } finally {
    if (firstView && firstClient && firstOriginalFetch) {
      await disposeBrowser(firstView, firstClient, firstOriginalFetch);
    } else if (firstOriginalFetch) {
      firstClient?.clear();
      globalThis.fetch = firstOriginalFetch;
    }
    if (secondView && secondClient && secondOriginalFetch) {
      await disposeBrowser(secondView, secondClient, secondOriginalFetch);
    } else if (secondOriginalFetch) {
      secondClient?.clear();
      globalThis.fetch = secondOriginalFetch;
    }
    await stopChild(second);
    await stopChild(first);
    await cleanupFixture(fixtureData);
  }
}, 45_000);
