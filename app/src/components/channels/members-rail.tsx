import { IconUsers } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelQueryOptions } from "@/lib/channels/queries";

/**
 * People in the open channel: the signed-in person, then each coworker id the channel already has.
 *
 * Names come from the coworker list and the current user. An id that is not in that list is shown
 * as the id, never as an invented coworker. Home and the new-channel screen pass no ids, so the
 * list is empty rather than filled with the whole roster.
 */
export function MembersList({ agentIds }: { agentIds: readonly string[] }) {
  const { data: agents } = useQuery(agentListQueryOptions());
  const { data: user } = useQuery(currentUserQueryOptions());
  const byId = new Map((agents ?? []).map((agent) => [agent.id, agent]));

  return (
    <ul className="flex flex-col gap-1 px-2 py-2">
      {user ? (
        <li className="flex items-center gap-2 rounded-lg px-2 py-1.5">
          <PersonInitials email={user.email} name={user.name} />
          <span className="min-w-0 truncate text-sm">
            {user.name?.trim() || user.email}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            You
          </span>
        </li>
      ) : null}
      {agentIds.map((id) => {
        const agent = byId.get(id);
        return (
          <li
            className="flex items-center gap-2 rounded-lg px-2 py-1.5"
            key={id}
          >
            {agent ? (
              <AbstractAvatar
                name={agent.name}
                seed={agent.avatarSeed}
                size={28}
              />
            ) : (
              <span className="size-7 shrink-0 rounded-full bg-muted" />
            )}
            <span className="min-w-0 truncate text-sm">
              {agent?.name ?? id}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function PersonInitials({
  email,
  name,
}: {
  email: string;
  name?: string | null;
}) {
  const initials =
    name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ?? email.slice(0, 2).toUpperCase();

  return (
    <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted-foreground/10 text-[11px] text-foreground/70">
      {initials}
    </div>
  );
}

function overlayingDetail(search: Record<string, unknown>) {
  return search.settings === true || search.watch === true;
}

/**
 * The right-hand members column on wide chat windows.
 *
 * Watch and settings take this slot: the column hides while that pane is open so the two never
 * sit side by side. Below 1100px the column is not shown; a channel header opens the same list
 * in a sheet.
 */
export function MembersRail() {
  const channelId = useParams({
    strict: false,
    select: (params) => (params as { channelId?: string }).channelId,
  });
  const overlay = useSearch({
    strict: false,
    select: (search) => overlayingDetail(search as Record<string, unknown>),
  });
  const channel = useQuery({
    ...channelQueryOptions(channelId ?? ""),
    enabled: Boolean(channelId),
  });
  const agentIds = channelId ? (channel.data?.agentIds ?? []) : [];

  return (
    <aside
      aria-label="Members"
      className={
        overlay
          ? "hidden"
          : "hidden h-full w-[240px] shrink-0 flex-col overflow-y-auto border-l border-sidebar-border bg-sidebar min-[1100px]:flex"
      }
      data-testid="members-rail"
    >
      <h2 className="px-4 py-3 text-xs font-medium tracking-wide text-muted-foreground">
        Members
      </h2>
      {channelId ? <MembersList agentIds={agentIds} /> : null}
    </aside>
  );
}

/**
 * Opens the members list on a narrow window, where the persistent column is gone.
 *
 * Wide windows already show {@link MembersRail}; this control hides there so the same list is
 * not offered twice.
 */
export function MembersHeaderButton({
  agentIds,
}: {
  agentIds: readonly string[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        aria-label="Members"
        className="min-[1100px]:hidden"
        onClick={() => setOpen(true)}
        size="icon"
        variant="ghost"
      >
        <IconUsers className="size-4.5" />
      </Button>
      <Sheet onOpenChange={setOpen} open={open}>
        <SheetContent className="w-72 p-0" side="right">
          <SheetHeader className="px-4 py-3">
            <SheetTitle>Members</SheetTitle>
          </SheetHeader>
          <MembersList agentIds={agentIds} />
        </SheetContent>
      </Sheet>
    </>
  );
}
