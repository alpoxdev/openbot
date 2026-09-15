import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import type { ConversationStore } from "../conversations/store";
import { ConversationAccessError } from "../conversations/types";
import type { ThreadIdentity } from "./thread-identity";
import { localThreadStatus } from "./thread-status";

export function createThreadRoutes(
  identity: ThreadIdentity,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  store: ConversationStore,
  profiles: Pick<AgentProfileStore, "getWithin">,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/mint", requireUser, async (context) => {
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return context.json(
        { error: "Choose a Bot for this conversation." },
        400,
      );
    }
    if (
      !input ||
      typeof input !== "object" ||
      !("agentId" in input) ||
      typeof input.agentId !== "string" ||
      !input.agentId.trim() ||
      input.agentId.length > 500
    ) {
      return context.json(
        { error: "Choose a Bot for this conversation." },
        400,
      );
    }
    try {
      const thread = await store.createOwnedThread(
        context.var.actor,
        identity.mint(),
        input.agentId,
        profiles,
      );
      return context.json({ threadId: thread.id });
    } catch (error) {
      if (error instanceof ConversationAccessError)
        return context.json({ error: "Bot not found." }, 404);
      return context.json({ error: "Could not create conversation." }, 502);
    }
  });

  routes.get("/:threadId", requireUser, async (context) => {
    const threadId = context.req.param("threadId");
    try {
      return context.json(
        await localThreadStatus(store, threadId, context.var.actor.id),
      );
    } catch {
      return context.json({ error: "Could not check thread status." }, 502);
    }
  });

  return routes;
}
