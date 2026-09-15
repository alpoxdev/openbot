import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ToolLine } from "@/components/channels/tool-line";
import { PageEmpty } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  listConversationHistory,
  liveHandoverAllowed,
  readConversationMessages,
  readConversationThread,
  type ConversationThreadSummary,
} from "@/lib/conversation-history";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import { asText, forDisplay, REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { readToolName } from "@/lib/plugins/tool-name";

export type ImportedHistoryProps = {
  agentId?: string;
  /** Optional route/deep-link selection. It is only honored after the server list authorizes it. */
  threadId?: string;
  /** Called when a listed thread is selected, so the route can update its deep link. */
  onThreadSelect?: (threadId: string) => void;
};

function ThreadRow({
  thread,
  selected,
  onSelect,
}: {
  thread: ConversationThreadSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const heading = thread.title ?? thread.id;
  return (
    <li>
      <button
        aria-current={selected ? "true" : undefined}
        className={`w-full rounded-md px-3 py-2 text-left text-sm ${
          selected ? "bg-foreground/5" : ""
        }`}
        onClick={onSelect}
        type="button"
      >
        <span className="block font-medium">{heading}</span>
        {thread.preview ? (
          <span className="mt-0.5 block truncate text-muted-foreground text-xs">
            {thread.preview}
          </span>
        ) : null}
        <span className="mt-0.5 block text-muted-foreground text-xs">
          {thread.localReadiness === "history_only"
            ? "Stored on this server — history only"
            : thread.localReadiness === "not_ready"
              ? "Import pending — history only"
              : "Stored on this server"}
        </span>
      </button>
    </li>
  );
}

function HistoricalMessages({
  threadId,
  agentId,
}: {
  threadId: string;
  agentId?: string;
}) {
  const record = useQuery({
    queryKey: ["conversation-history", "thread", threadId],
    queryFn: () => readConversationThread(threadId),
  });
  const stored = useQuery({
    queryKey: ["conversation-history", "messages", threadId, agentId ?? null],
    queryFn: () => readConversationMessages(threadId, agentId),
  });

  if (stored.isPending || record.isPending) {
    return (
      <p className="text-muted-foreground text-sm">
        Loading this conversation…
      </p>
    );
  }
  if (stored.data?.availability === "unavailable") {
    return (
      <p className="text-sm" role="alert">
        These stored messages could not be read from this server.
      </p>
    );
  }

  const handover = liveHandoverAllowed(record.data ?? null);
  const messages = stored.data?.messages ?? [];
  const items = toVisibleChatItems(messages);
  const fullRecords =
    messages.length > 0 ? JSON.stringify(messages, null, 2) : null;

  return (
    <div className="flex flex-col gap-3">
      {!handover ? (
        <p className="text-muted-foreground text-sm" role="status">
          This conversation is read-only. Live handover is disabled.
        </p>
      ) : null}
      {stored.data && stored.data.unreadable > 0 ? (
        <p className="text-muted-foreground text-sm">
          {stored.data.unreadable} stored turn
          {stored.data.unreadable === 1 ? "" : "s"} could not be shown.
        </p>
      ) : null}
      {items.length === 0 ? (
        messages.length > 0 ? (
          <p className="text-muted-foreground text-sm" role="status">
            No messages can be shown in the formatted view. The stored records
            are available in the expandable details below.
          </p>
        ) : (
          <PageEmpty>No messages stored for this conversation.</PageEmpty>
        )
      ) : (
        <ol className="flex flex-col gap-3">
          {items.map((item) => {
            if (item.kind === "text") {
              return (
                <li className="text-sm" key={item.id}>
                  <span className="text-muted-foreground text-xs">
                    {item.role === "user" ? "You" : "Assistant"}
                  </span>
                  <p className="whitespace-pre-wrap">{item.text}</p>
                </li>
              );
            }
            if (item.kind === "tool") {
              const named = readToolName(item.toolCall.function.name);
              const body =
                item.result === undefined ? undefined : asText(item.result);
              const refused = Boolean(body?.startsWith(REFUSAL_MARKER));
              return (
                <li key={item.id}>
                  <ToolLine
                    detail={named.detail}
                    label={named.label}
                    refused={refused}
                  >
                    <pre className="whitespace-pre-wrap break-all font-mono text-xs">
                      {item.toolCall.function.arguments}
                    </pre>
                    {body ? (
                      <p className="mt-2 whitespace-pre-wrap">
                        {forDisplay(body)}
                      </p>
                    ) : null}
                  </ToolLine>
                </li>
              );
            }
            if (item.kind === "activity") {
              const activityContent = JSON.stringify(
                item.message.content,
                null,
                2,
              );
              return (
                <li className="text-sm" key={item.id}>
                  <span className="text-muted-foreground text-xs">
                    Activity: {item.message.activityType}
                  </span>
                  <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">
                    {activityContent}
                  </pre>
                </li>
              );
            }
            return (
              <li className="text-muted-foreground text-sm" key={item.id}>
                {item.attachments.length} attachment reference
                {item.attachments.length === 1 ? "" : "s"} recorded; files are
                not fetched automatically.
              </li>
            );
          })}
        </ol>
      )}
      {fullRecords ? (
        <details className="rounded-md border border-border/60">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
            Full stored message records ({messages.length})
          </summary>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all border-t border-border/60 p-3 font-mono text-xs">
            {fullRecords}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Read-only browser of conversations already stored on this server.
 *
 * Does not register frontend tools, run agents, or fetch remote assets. Deleted-agent and
 * history-only threads remain readable.
 */
export function ImportedHistory({
  agentId,
  threadId,
  onThreadSelect,
}: ImportedHistoryProps) {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(
    null,
  );
  const listed = useInfiniteQuery({
    queryKey: ["conversation-history", "list", agentId ?? "all"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const cursor = typeof pageParam === "string" ? pageParam : undefined;
      const page = await listConversationHistory({
        ...(agentId ? { agentId } : {}),
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      if (page.availability === "unavailable") {
        throw new Error("Stored conversations could not be loaded.");
      }
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const directRecord = useQuery({
    queryKey: ["conversation-history", "thread", threadId ?? null],
    queryFn: () => readConversationThread(threadId as string),
    enabled:
      threadId !== undefined &&
      listed.data !== undefined &&
      !listed.data.pages.some((page) =>
        page.threads.some((thread) => thread.id === threadId),
      ),
  });

  if (listed.isPending) {
    return (
      <p className="text-muted-foreground text-sm">
        Loading stored conversations…
      </p>
    );
  }
  if (listed.isError && !listed.data) {
    return (
      <p className="text-sm" role="alert">
        Stored conversations could not be loaded from this server.
      </p>
    );
  }

  const threadById = new Map<string, ConversationThreadSummary>();
  for (const page of listed.data?.pages ?? []) {
    for (const thread of page.threads) {
      if (!threadById.has(thread.id)) threadById.set(thread.id, thread);
    }
  }
  const threads = [...threadById.values()];
  const selectedId = threadId ?? internalSelectedId;
  const selected =
    threadId !== undefined
      ? threads.find((thread) => thread.id === threadId)
      : (threads.find((thread) => thread.id === selectedId) ?? threads[0]);
  const explicitDirectSelection =
    threadId !== undefined && selected === undefined;
  const directSelectionPending =
    explicitDirectSelection && directRecord.isPending;
  const directSelectionAuthorized =
    explicitDirectSelection &&
    directRecord.data !== null &&
    directRecord.data !== undefined &&
    (directRecord.data.status === "local" ||
      directRecord.data.status === "import_pending");
  // A null agent id is meaningful: the original Bot may have been deleted. Omit the selector
  // rather than substituting the optional list filter, so history remains readable.
  const messageAgentId = selected?.agentId ?? undefined;

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-bold text-lg">Stored conversations</h2>
        <p className="mt-1 max-w-prose text-muted-foreground text-sm">
          Full records already stored on this server, including imported ones.
          This is a reading view: nothing here talks to a Bot or runs a tool.
        </p>
      </div>
      {threads.length === 0 ? (
        threadId !== undefined ? (
          directSelectionPending ? (
            <p className="text-muted-foreground text-sm">
              Loading this conversation…
            </p>
          ) : directSelectionAuthorized ? (
            <HistoricalMessages threadId={threadId} />
          ) : (
            <p className="text-sm" role="alert">
              This conversation is not available in your stored history.
            </p>
          )
        ) : (
          <PageEmpty>No conversations are stored on this server yet.</PageEmpty>
        )
      ) : (
        <div className="grid gap-6 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
          <ul className="flex flex-col gap-1">
            {threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                onSelect={() => {
                  setInternalSelectedId(thread.id);
                  onThreadSelect?.(thread.id);
                }}
                selected={selected?.id === thread.id}
                thread={thread}
              />
            ))}
          </ul>
          {selected ? (
            <HistoricalMessages
              agentId={messageAgentId}
              threadId={selected.id}
            />
          ) : directSelectionPending ? (
            <p className="text-muted-foreground text-sm">
              Loading this conversation…
            </p>
          ) : directSelectionAuthorized ? (
            <HistoricalMessages threadId={threadId as string} />
          ) : threadId !== undefined ? (
            <p className="text-sm" role="alert">
              This conversation is not available in your stored history.
            </p>
          ) : (
            <PageEmpty>Choose a conversation to read.</PageEmpty>
          )}
        </div>
      )}
      {listed.isFetchNextPageError ? (
        <p className="text-sm" role="alert">
          More stored conversations could not be loaded. Previously loaded
          history is still available.
        </p>
      ) : null}
      {listed.hasNextPage ? (
        <Button
          disabled={listed.isFetchingNextPage}
          onClick={() => listed.fetchNextPage()}
          size="sm"
          type="button"
          variant="outline"
        >
          {listed.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      ) : null}
    </section>
  );
}
