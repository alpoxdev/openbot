import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AgentRail } from "@/components/app-sidebar/agent-rail";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { MembersRail } from "@/components/channels/members-rail";
import { SidebarShell } from "@/components/layout/sidebar-shell";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    // One viewport, never scrolls: panes scroll inside it. A growable shell lets the transcript's
    // scroller size against the page, grow it, and grow again.
    //
    // Wide windows add an avatar strip to the left of the roster and a members column to the right
    // of the transcript. Both hide below 1100px; the roster still collapses into the existing Sheet
    // below 768px.
    <div className="flex h-svh min-h-0 overflow-hidden min-[1100px]:[--chat-rail:4.5rem]">
      <AgentRail />
      <SidebarShell
        className="h-svh min-w-0 flex-1 overflow-hidden"
        width="340px"
      >
        <AppSidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
        <MembersRail />
      </SidebarShell>
    </div>
  );
}
