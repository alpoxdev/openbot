import { type Message, MessageSchema } from "@ag-ui/core";
import { tryClient } from "@/lib/client";

/**
 * The messages a thread already holds, for restoring a conversation somebody comes back to.
 *
 * A plain fail-closed function rather than a query. Nothing caches it — the transcript this seeds is
 * then owned by the running agent, so a cached copy would be a second version of the same
 * conversation — and an unreadable history is not a reason to keep somebody from typing. Every
 * failure returns nothing and lets the composer open.
 *
 * WHAT ARRIVES HERE IS NOT TRUSTED. This used to end `stored as Message[]`, which is a cast rather
 * than a check: whatever the history store held was handed to `setMessages` and then to every
 * projection that reads a transcript. A turn shaped differently reached a renderer that dereferenced
 * `toolCall.function.arguments` and took the whole conversation down with it. One bad turn made a
 * thread unreadable.
 *
 * So each turn is parsed against the schema AG-UI ships, and one that does not parse is left out.
 * Checked here rather than in a projection because there are several projections and one history:
 * fixing it in the reader that is closest to the wire is what makes every consumer safe at once.
 *
 * The server now persists this canonical shape directly. Legacy source-provider dialects are
 * converted once by the explicit importer; the ordinary runtime reader must not reinterpret them,
 * because doing so would make an imported payload and a local payload follow different validation
 * and fidelity rules.
 */

/**
 * What a read gives back: the turns that parsed, and how many did not.
 *
 * The count is returned rather than logged. A turn quietly missing from a record people read back is
 * worse than a visible failure — it is a conversation that reads as though it never had that message,
 * with nothing to say otherwise. The caller is expected to say so on screen.
 */
export type StoredThread = {
  messages: Message[];
  /** Zero on every ordinary read. Above zero means the history store holds something unreadable. */
  unreadable: number;
  /**
   * `"unavailable"` means the history endpoint failed or could not be read. It is not evidence that
   * the thread is empty or belongs to another project.
   */
  availability: "ready" | "unavailable";
};

const UNAVAILABLE_THREAD: StoredThread = {
  messages: [],
  unreadable: 0,
  availability: "unavailable",
};

const THREAD_MESSAGES_DEADLINE_MS = 1500;

type ReadThreadMessagesOptions = {
  /** Shorter only in tests; production uses the mount/send ordering deadline. */
  deadlineMs?: number;
};

/**
 * The turns that parse, kept in order, and a count of the ones that did not.
 *
 * Exported so it can be tested against real stored shapes without a server. Takes `unknown[]`
 * because that is honestly what the wire gives.
 *
 * THE ORIGINAL OBJECT IS KEPT, not `parsed.data`. Zod strips keys a schema does not name, so
 * returning the parsed copy would quietly drop anything the runtime carries and this file has not
 * heard of — turning a validation step into a silent rewrite of every message that passed. The parse
 * is asked whether the turn is well formed; it is not asked to decide what the turn contains.
 */
export function readableTurns(stored: readonly unknown[]): StoredThread {
  const messages: Message[] = [];
  let unreadable = 0;

  for (const turn of stored) {
    if (MessageSchema.safeParse(turn).success) {
      // Keep the server payload verbatim. MessageSchema is a guard, not a projection: stripping
      // extension fields here would make a valid durable message impossible to replay faithfully.
      messages.push(turn as Message);
    } else {
      unreadable += 1;
    }
  }

  return { messages, unreadable, availability: "ready" };
}

export async function readThreadMessages(
  threadId: string,
  agentId: string,
  options: ReadThreadMessagesOptions = {},
): Promise<StoredThread> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadlineMs = options.deadlineMs ?? THREAD_MESSAGES_DEADLINE_MS;

  try {
    const read = async () => {
      const response = await tryClient(
        `/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?agentId=${encodeURIComponent(agentId)}`,
        { signal: controller.signal },
      );
      if (!response.ok) return UNAVAILABLE_THREAD;
      const body: unknown = await response.json();
      const stored =
        typeof body === "object" && body !== null && "messages" in body
          ? body.messages
          : null;
      return Array.isArray(stored) ? readableTurns(stored) : UNAVAILABLE_THREAD;
    };

    const deadline = new Promise<StoredThread>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(UNAVAILABLE_THREAD);
      }, deadlineMs);
    });

    return await Promise.race([read(), deadline]);
  } catch {
    return UNAVAILABLE_THREAD;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
