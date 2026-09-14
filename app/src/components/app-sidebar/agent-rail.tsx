import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * The left avatar strip on wide chat windows.
 *
 * Each face is a coworker already on this deployment; choosing one opens the existing new-channel
 * flow with that coworker as the recipient. Nothing here creates a coworker or talks to a new
 * endpoint. Below 1100px the strip is not shown — the roster still has its own new-channel control.
 */
export function AgentRail() {
  const { data: agents } = useQuery(agentListQueryOptions());

  return (
    <aside
      aria-label="Coworkers"
      className="relative z-20 hidden h-full w-[4.5rem] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-sidebar-border bg-sidebar py-3 min-[1100px]:flex"
      data-testid="agent-rail"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label="New channel"
              className="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/5"
              to="/channel/new"
            >
              <IconPlus className="size-5" />
            </Link>
          }
        />
        <TooltipContent side="right">New channel</TooltipContent>
      </Tooltip>
      {(agents ?? []).map((agent) => (
        <Tooltip key={agent.id}>
          <TooltipTrigger
            render={
              <Link
                aria-label={agent.name}
                className="flex size-10 items-center justify-center rounded-full hover:bg-foreground/5"
                search={{ agent: agent.id }}
                to="/channel/new"
              >
                <span aria-hidden="true">
                  <AbstractAvatar
                    name={agent.name}
                    seed={agent.avatarSeed}
                    size={32}
                  />
                </span>
              </Link>
            }
          />
          <TooltipContent side="right">{agent.name}</TooltipContent>
        </Tooltip>
      ))}
    </aside>
  );
}
