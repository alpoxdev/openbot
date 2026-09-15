import {
  installBotRouteMocks,
  restoreBotRouteMocks,
} from "./bot-route-default-agent.fixture";

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

const originalFetch = global.fetch;

let BotRoute: typeof import("@/routes/_authed/_app/bot").Route;

beforeAll(async () => {
  GlobalRegistrator.register();
  installBotRouteMocks({
    useActiveBot: () => {
      activeBotCalls += 1;
    },
    useBotThread: (agentId: string) => ({
      ...botThreadMock,
      threadId: botThreadMock.threadId || `thread-${agentId}`,
    }),
  });
  ({ Route: BotRoute } = await import("@/routes/_authed/_app/bot"));
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  resetBotThreadMock();
  activeBotCalls = 0;
});

afterAll(async () => {
  await settleReactWork();
  restoreBotRouteMocks();
  GlobalRegistrator.unregister();
});

type BotThreadMock = {
  history: "ready" | "unavailable";
  startNew: () => void;
  threadId: string;
  status:
    | "local"
    | "import_pending"
    | "external_unavailable"
    | "notfound"
    | undefined;
  localReadiness: "ready" | "history_only" | "not_ready" | undefined;
  liveHandover?: boolean;
};

const readyBotThread: BotThreadMock = {
  history: "ready",
  localReadiness: "ready",
  liveHandover: true,
  startNew: () => undefined,
  status: "local",
  threadId: "thread-default",
};

let botThreadMock: BotThreadMock = { ...readyBotThread };
let activeBotCalls = 0;

function resetBotThreadMock() {
  botThreadMock = { ...readyBotThread };
}

function setBotThreadMock(
  overrides: Partial<BotThreadMock> & { liveHandover?: boolean },
) {
  botThreadMock = { ...readyBotThread, ...overrides };
}

function omitLiveHandover() {
  const withoutLiveHandover = { ...botThreadMock };
  delete withoutLiveHandover.liveHandover;
  botThreadMock = withoutLiveHandover;
}

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    avatarSeed: "seed",
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    mine: true,
    name: "Agent",
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

function queryClientWithAgents(agents: AgentProfile[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

function queryClientWithAgentsAndFetchedAgent(
  agents: AgentProfile[],
  agentId: string,
  response: Response,
) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/agents/${agentId}`) return response.clone();
      throw new Error(`Unexpected fetch: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  return queryClientWithAgents(agents);
}

function queryClientWithFailingAgents() {
  global.fetch = Object.assign(
    async () => new Response(null, { status: 500 }),
    { preconnect: originalFetch.preconnect },
  );
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

const rootRoute = createRootRoute({ component: Outlet });
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  component: Outlet,
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
type TestFileRouteWiring = Parameters<typeof BotRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};

function renderBot(queryClient: QueryClient, initialEntry = "/bot") {
  /*
   * TanStack's generated route tree wires file routes with update({ id, path, getParentRoute })
   * (app/src/routeTree.gen.ts), and the memory-router docs use an explicit test tree. The
   * createFileRoute update type exposed to tests does not include those generated wiring fields,
   * so this cast is confined to the file-route attachment point; the rendered component, router,
   * query data, and assertions stay typed.
   */
  const testBotRoute = BotRoute.update({
    id: "/bot",
    path: "/bot",
    getParentRoute: () => appRoute,
  } as TestFileRouteWiring);
  const routeTree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([testBotRoute])]),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const GENERAL_ASSISTANT = agent({
  id: "general-assistant",
  name: "General Assistant",
  title: "Everyday work",
});

const PICKED_HARNESS = agent({
  builtIn: false,
  endpoint: "http://127.0.0.1:4201",
  id: "picked-harness",
  name: "LangGraph",
  title: "LangGraph",
});

test("/bot defaults to the picked harness when this setup selected one", async () => {
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
  );

  expect(await view.findByRole("heading", { name: "LangGraph" })).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe(
    "picked-harness",
  );
});

test("/bot with an empty agent query uses the normal default Bot", async () => {
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
    "/bot?agent=",
  );

  expect(await view.findByRole("heading", { name: "LangGraph" })).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe(
    "picked-harness",
  );
  expect(view.queryByText('This deployment has no Bot called "".')).toBeNull();
  expect(view.queryByText("This deployment has no Bots yet.")).toBeNull();
});

test("/bot reports a failed initial roster load instead of claiming there are no Bots", async () => {
  const view = renderBot(queryClientWithFailingAgents());

  expect(await view.findByText("Bots couldn't be loaded.")).toBeTruthy();
  expect(view.queryByText("This deployment has no Bots yet.")).toBeNull();
});

test("/bot preserves an explicit agent, including the built-in first agent", async () => {
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
    "/bot?agent=general-assistant",
  );

  expect(
    await view.findByRole("heading", { name: "General Assistant" }),
  ).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe(
    "general-assistant",
  );
});

test("/bot preserves an explicit unknown agent as a clear missing-bot state", async () => {
  const view = renderBot(
    queryClientWithAgentsAndFetchedAgent(
      [GENERAL_ASSISTANT, PICKED_HARNESS],
      "missing-agent",
      new Response(null, { status: 404 }),
    ),
    "/bot?agent=missing-agent",
  );

  expect(
    await view.findByText('This deployment has no Bot called "missing-agent".'),
  ).toBeTruthy();
  expect(view.queryByTestId("copilot-chat")).toBeNull();
});

test("/bot loads a hidden explicit agent from the detail endpoint", async () => {
  const hiddenBot = agent({
    hidden: true,
    id: "hidden-bot",
    name: "Hidden Bot",
    title: "Hidden Bot",
  });
  const view = renderBot(
    queryClientWithAgentsAndFetchedAgent(
      [GENERAL_ASSISTANT],
      "hidden-bot",
      Response.json({ agent: hiddenBot }),
    ),
    "/bot?agent=hidden-bot",
  );

  expect(await view.findByRole("heading", { name: "Hidden Bot" })).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe("hidden-bot");
  expect(
    view.queryByText('This deployment has no Bot called "hidden-bot".'),
  ).toBeNull();
});

test("/bot hidden lookup does not collide with the shared agent detail cache", async () => {
  const hiddenBot = agent({
    hidden: true,
    id: "hidden-bot",
    name: "Hidden Bot",
    title: "Hidden Bot",
  });
  const queryClient = queryClientWithAgentsAndFetchedAgent(
    [GENERAL_ASSISTANT],
    "hidden-bot",
    Response.json({ agent: hiddenBot }),
  );
  queryClient.setQueryData(agentKeys.detail("hidden-bot"), hiddenBot);
  const view = renderBot(queryClient, "/bot?agent=hidden-bot");

  expect(await view.findByRole("heading", { name: "Hidden Bot" })).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe("hidden-bot");
  expect(
    view.queryByText('This deployment has no Bot called "hidden-bot".'),
  ).toBeNull();
});

test("/bot reports an explicit agent detail load failure", async () => {
  const view = renderBot(
    queryClientWithAgentsAndFetchedAgent(
      [GENERAL_ASSISTANT],
      "error-bot",
      Response.json({ error: "detail exploded" }, { status: 500 }),
    ),
    "/bot?agent=error-bot",
  );

  expect((await view.findByRole("alert")).textContent).toBe(
    "Bot couldn't be loaded.",
  );
  expect(view.queryByTestId("copilot-chat")).toBeNull();
});

test("/bot still falls back to the first agent when no picked harness exists", async () => {
  const otherAgent = agent({ id: "researcher", name: "Researcher" });
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, otherAgent]),
  );

  expect(
    await view.findByRole("heading", { name: "General Assistant" }),
  ).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe(
    "general-assistant",
  );
});

test("/bot mounts live chat only for an explicit ready handover", async () => {
  setBotThreadMock({
    history: "ready",
    liveHandover: true,
    localReadiness: "ready",
    status: "local",
  });
  const view = renderBot(queryClientWithAgents([GENERAL_ASSISTANT]));

  expect(await view.findByTestId("copilot-chat")).toBeTruthy();
  expect(view.queryByTestId("imported-history")).toBeNull();
  expect(activeBotCalls).toBeGreaterThan(0);
});

test("/bot keeps history-only threads read-only when handover is false", async () => {
  setBotThreadMock({
    history: "ready",
    liveHandover: false,
    localReadiness: "history_only",
    status: "local",
    threadId: "preserved-history-thread",
  });
  const view = renderBot(queryClientWithAgents([GENERAL_ASSISTANT]));

  const notice = await view.findByRole("status");
  expect(notice.textContent).toContain(
    "This conversation is history-only. Live handover and tools are disabled.",
  );
  expect(notice.textContent).toContain(
    "Preserved thread ID: preserved-history-thread.",
  );
  expect(view.queryByTestId("copilot-chat")).toBeNull();
  expect(view.getByTestId("imported-history").dataset.threadId).toBe(
    "preserved-history-thread",
  );
  expect(view.getByRole("button", { name: "New chat" })).toBeTruthy();
  expect(activeBotCalls).toBe(0);
});

test("/bot fails closed when the handover field is missing", async () => {
  setBotThreadMock({
    history: "ready",
    localReadiness: "ready",
    status: "local",
    threadId: "missing-flag-thread",
  });
  omitLiveHandover();
  const view = renderBot(queryClientWithAgents([GENERAL_ASSISTANT]));

  const notice = await view.findByRole("status");
  expect(notice.textContent).toContain(
    "This conversation is history-only. Live handover and tools are disabled.",
  );
  expect(notice.textContent).toContain(
    "Preserved thread ID: missing-flag-thread.",
  );
  expect(view.queryByTestId("copilot-chat")).toBeNull();
  expect(view.getByTestId("imported-history").dataset.threadId).toBe(
    "missing-flag-thread",
  );
  expect(view.getByRole("button", { name: "New chat" })).toBeTruthy();
  expect(activeBotCalls).toBe(0);
});
