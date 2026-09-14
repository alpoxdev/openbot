import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import type { ReactNode } from "react";
import { AgentRail } from "@/components/app-sidebar/agent-rail";
import {
  MembersList,
  MembersRail,
} from "@/components/channels/members-rail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { authKeys, type AuthenticatedUser } from "@/lib/auth/queries";
import { channelKeys, type AgentChannel } from "@/lib/channels/queries";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

const coworker: AgentProfile = {
  id: "a1",
  name: "Renewal Desk",
  title: "Accounts",
  roleDescription: "Do the work.",
  avatarSeed: "seed-a1",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const you: AuthenticatedUser = {
  id: "user-1",
  email: "you@openbot.local",
  name: "Ada",
  image: null,
  role: "user",
  onboarding: { step: 1, completedAt: "2026-01-01T00:00:00.000Z" },
};

function clientWith(data: {
  agents?: AgentProfile[];
  user?: AuthenticatedUser;
  channel?: AgentChannel;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(agentKeys.list(false), data.agents ?? [coworker]);
  queryClient.setQueryData(authKeys.currentUser(), data.user ?? you);
  if (data.channel) {
    queryClient.setQueryData(channelKeys.detail(data.channel.id), data.channel);
  }
  return queryClient;
}

function renderAt(
  path: string,
  queryClient: QueryClient,
  children: ReactNode,
) {
  const rootRoute = createRootRoute({
    component: () => (
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{children}</>,
  });
  const newRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/new",
    component: () => <>{children}</>,
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/$channelId",
    component: () => <>{children}</>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, newRoute, channelRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("agent-rail lists existing coworkers and the new-channel control", async () => {
  const view = renderAt("/", clientWith({}), <AgentRail />);

  expect(await view.findByTestId("agent-rail")).toBeTruthy();
  expect(view.getByRole("link", { name: "New channel" })).toBeTruthy();
  expect(view.getByRole("link", { name: "Renewal Desk" })).toBeTruthy();
});

test("members list shows the signed-in person and named channel coworkers only", async () => {
  const view = renderAt(
    "/",
    clientWith({}),
    <MembersList agentIds={["a1", "missing"]} />,
  );

  expect(await view.findByText("Ada")).toBeTruthy();
  expect(view.getByText("Renewal Desk")).toBeTruthy();
  expect(view.getByText("missing")).toBeTruthy();
  expect(view.queryByText("Invented")).toBeNull();
});

test("members rail is empty on /channel/new", async () => {
  const view = renderAt("/channel/new", clientWith({}), <MembersRail />);

  const rail = await view.findByTestId("members-rail");
  expect(rail.querySelector("ul")).toBeNull();
  expect(view.queryByText("Renewal Desk")).toBeNull();
});

test("members rail lists the open channel's agentIds", async () => {
  const channel: AgentChannel = {
    id: "ch1",
    name: "Renewal",
    agentIds: ["a1"],
    threadId: "t1",
    active: true,
    lastMessageAt: null,
  };
  const view = renderAt(
    "/channel/ch1",
    clientWith({ channel }),
    <MembersRail />,
  );

  expect(await view.findByTestId("members-rail")).toBeTruthy();
  expect(await view.findByText("Renewal Desk")).toBeTruthy();
});
