import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { parsePageLimit } from "../paging";
import {
  ConversationAccessError,
  ConversationConflictError,
  ConversationNotFoundError,
} from "./types";
import type { ConversationStore } from "./store";
import { MAX_THREAD_PAGE } from "./store";

export function createConversationRoutes(
  store: ConversationStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/threads", requireUser, async (context) => {
    try {
      // Listing is metadata-only; the store extracts a short baseline preview in SQL. Full
      // transcript projection remains reserved for the selected-thread endpoints below.
      const limit = parsePageLimit(
        context.req.query("limit") ?? null,
        MAX_THREAD_PAGE,
      );
      if (!limit.ok) return context.json({ error: limit.error }, 400);
      const rawDirectOnly = context.req.query("directOnly");
      if (
        rawDirectOnly !== undefined &&
        rawDirectOnly !== "true" &&
        rawDirectOnly !== "false"
      ) {
        return context.json(
          { error: 'Query parameter "directOnly" must be true or false.' },
          400,
        );
      }
      const agentId = context.req.query("agentId");
      if (agentId === "") {
        return context.json(
          { error: 'Query parameter "agentId" must not be empty.' },
          400,
        );
      }
      const cursor = context.req.query("cursor");
      const page = await store.list(
        { id: context.var.actor.id },
        {
          ...(agentId === undefined ? {} : { agentId }),
          ...(rawDirectOnly === undefined
            ? {}
            : { directOnly: rawDirectOnly === "true" }),
          ...(limit.limit === undefined ? {} : { limit: limit.limit }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      return context.json({
        threads: page.threads.map((thread) => ({
          ...thread,
          updatedAt: thread.updatedAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof ConversationConflictError) {
        return context.json({ error: error.message }, 400);
      }
      return context.json({ error: "Could not list conversations." }, 502);
    }
  });

  routes.get("/threads/:threadId/messages", requireUser, async (context) => {
    return readPart(context, store, "messages");
  });
  routes.get("/threads/:threadId/events", requireUser, async (context) => {
    return readPart(context, store, "events");
  });
  routes.get("/threads/:threadId/state", requireUser, async (context) => {
    return readPart(context, store, "state");
  });

  routes.all("/threads/*", requireUser, (context) =>
    context.json({ error: "Not found." }, 404),
  );

  return routes;
}

async function readPart(
  context: Context<{ Variables: AppVariables }>,
  store: ConversationStore,
  part: "messages" | "events" | "state",
) {
  const actor = { id: context.var.actor.id };
  const threadId = context.req.param("threadId");
  if (!threadId) return context.json({ error: "Not found." }, 404);
  try {
    const access = await store.authorize(
      actor,
      threadId,
      "history",
      context.req.query("agentId"),
    );
    if (access === "none") {
      return context.json({ error: "Not found." }, 404);
    }
    const snapshot = await store.readSnapshot(actor, threadId);
    if (part === "events") {
      const cursor = context.req.query("after") ?? "0";
      const limit = Number(context.req.query("limit") ?? "100");
      if (
        !/^\d{1,19}$/.test(cursor) ||
        BigInt(cursor) > 9223372036854775807n ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 500
      ) {
        return context.json(
          { error: "Invalid event cursor or page size." },
          400,
        );
      }
      const events = await store.readEventPage(
        actor,
        threadId,
        BigInt(cursor),
        limit,
      );
      let nextCursor: string | null = null;
      if (events.length === limit) {
        const latestEvent = events.at(-1);
        if (!latestEvent)
          throw new Error("Event page unexpectedly returned no events");
        nextCursor = latestEvent.sequence.toString();
      }
      return context.json({
        events: events.map((event) => ({
          sequence: event.sequence.toString(),
          type: event.type,
          payload: event.payload,
        })),
        nextCursor,
      });
    }
    if (part === "messages") {
      return context.json({ messages: snapshot.snapshot.messages });
    }
    return context.json({ state: snapshot.snapshot.state });
  } catch (error) {
    if (
      error instanceof ConversationAccessError ||
      error instanceof ConversationNotFoundError
    ) {
      return context.json({ error: "Not found." }, 404);
    }
    return context.json({ error: "Could not read conversation." }, 502);
  }
}
