import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  intelligenceChannelMappings,
  users,
} from "../db/schema";
import type { ConversationImportSource } from "./import-source";
import type { ImportThreadSummary } from "./import-types";
import type { ImportAttempt } from "./import-store";

export type DatabaseExecutor = Pick<Database, "select" | "insert" | "update">;

export type ImportActorAgentPair = {
  userId: string;
  agentId: string;
};

export type ImportExplicitId = {
  threadId: string;
  userId: string;
};

export type ImportInventoryPairOrigin =
  | "explicit"
  | "mapping"
  | "current-agent"
  | "historical-agent";

export type ImportInventoryClassification =
  | "mapped"
  | "unmapped"
  | "identity-conflict"
  | "zero-threads"
  | "probe-not-found"
  | "explicit-unowned";

export type ImportInventoryOwnershipEvidence = {
  classification: ImportInventoryClassification;
  mappingUserId?: string;
  mappingChannelId?: string;
  mappingThreadId?: string;
  notes: string[];
};

export type ImportInventoryThread = {
  sourceThreadId: string;
  sourceUserId: string;
  sourceAgentId: string;
  summary: ImportThreadSummary;
  pairOrigins: ImportInventoryPairOrigin[];
  ownership: ImportInventoryOwnershipEvidence;
  discovery: "list" | "mapped-probe" | "explicit-probe";
};

export type ImportPairCursorState = {
  userId: string;
  agentId: string;
  nextCursor: string | null;
  exhausted: boolean;
  paused: boolean;
  cycleDetected: boolean;
  noProgress: boolean;
  seenCursors: string[];
  pageCount: number;
  threadCount: number;
  origins: ImportInventoryPairOrigin[];
};

export type ImportProbeRecord = {
  threadId: string;
  userId: string;
  origin: "mapped-probe" | "explicit-probe";
  outcome: "found" | "not-found" | "error" | "unowned-blocked";
};

export type ImportInventoryCheckpoint = {
  pairs: ImportPairCursorState[];
  probes?: ImportProbeRecord[];
};

export type ImportInventoryResult = {
  threads: ImportInventoryThread[];
  checkpoint: ImportInventoryCheckpoint;
  inventoryCompleteForDeclaredScope: boolean;
  gaps: Array<{
    pair?: ImportActorAgentPair;
    threadId?: string;
    reason: string;
  }>;
};

export type RunImportInventoryInput = {
  database: DatabaseExecutor;
  attempt: ImportAttempt;
  source: ConversationImportSource;
  explicitPairs: readonly ImportActorAgentPair[];
  explicitIds?: readonly ImportExplicitId[];
  checkpoint?: ImportInventoryCheckpoint;
  pageLimit?: number;
  maxPagesPerPair?: number;
  signal?: AbortSignal;
  onPageCommit?: (
    snapshot: ImportInventoryResult,
    attempt: ImportAttempt,
  ) => Promise<void>;
};

function pairKey(userId: string, agentId: string): string {
  return `${userId}\0${agentId}`;
}

function mergeOrigins(
  existing: ImportInventoryPairOrigin[] | undefined,
  extra: ImportInventoryPairOrigin,
): ImportInventoryPairOrigin[] {
  const set = new Set(existing ?? []);
  set.add(extra);
  return [...set];
}

export async function collectDeclaredPairs(
  database: DatabaseExecutor,
  explicitPairs: readonly ImportActorAgentPair[],
): Promise<Map<string, ImportInventoryPairOrigin[]>> {
  const pairs = new Map<string, ImportInventoryPairOrigin[]>();
  const add = (
    userId: string,
    agentId: string,
    origin: ImportInventoryPairOrigin,
  ) => {
    const key = pairKey(userId, agentId);
    pairs.set(key, mergeOrigins(pairs.get(key), origin));
  };

  for (const pair of explicitPairs) {
    add(pair.userId, pair.agentId, "explicit");
  }

  const mappings = await database
    .select({
      userId: intelligenceChannelMappings.userId,
      threadId: intelligenceChannelMappings.threadId,
      channelId: intelligenceChannelMappings.channelId,
    })
    .from(intelligenceChannelMappings);

  const channelAgentRows = await database
    .select({
      channelId: channelAgents.channelId,
      agentId: channelAgents.agentId,
    })
    .from(channelAgents);
  const agentsByChannel = new Map<string, string[]>();
  for (const row of channelAgentRows) {
    const list = agentsByChannel.get(row.channelId) ?? [];
    list.push(row.agentId);
    agentsByChannel.set(row.channelId, list);
  }

  for (const mapping of mappings) {
    for (const agentId of agentsByChannel.get(mapping.channelId) ?? []) {
      add(mapping.userId, agentId, "mapping");
    }
  }

  const agentRows = await database
    .select({
      id: agents.id,
      deletedAt: agentProfiles.deletedAt,
    })
    .from(agents)
    .leftJoin(agentProfiles, eq(agentProfiles.agentId, agents.id));

  const localUsers = await database.select({ id: users.id }).from(users);
  const userIds = localUsers.map((row) => row.id);

  for (const agent of agentRows) {
    const origin: ImportInventoryPairOrigin =
      agent.deletedAt == null ? "current-agent" : "historical-agent";
    for (const userId of userIds) {
      add(userId, agent.id, origin);
    }
  }

  return pairs;
}

async function mappingForThread(
  database: DatabaseExecutor,
  sourceThreadId: string,
) {
  const [row] = await database
    .select()
    .from(intelligenceChannelMappings)
    .where(eq(intelligenceChannelMappings.threadId, sourceThreadId))
    .limit(1);
  return row ?? null;
}

function classifyOwnership(input: {
  sourceUserId: string;
  sourceThreadId: string;
  mapping: {
    userId: string;
    channelId: string;
    threadId: string;
  } | null;
  explicitUnowned?: boolean;
}): ImportInventoryOwnershipEvidence {
  if (input.explicitUnowned) {
    return {
      classification: "explicit-unowned",
      notes: [
        "Explicit thread id is a candidate hint only. No corroborated local owner mapping; the organizer is not adopted as owner.",
      ],
    };
  }
  if (!input.mapping) {
    return {
      classification: "unmapped",
      notes: [
        "No local intelligence_channel_mappings row for this source thread. Publication requires later explicit mapping evidence; the import organizer is not the conversation owner.",
      ],
    };
  }
  if (input.mapping.userId !== input.sourceUserId) {
    return {
      classification: "identity-conflict",
      mappingUserId: input.mapping.userId,
      mappingChannelId: input.mapping.channelId,
      mappingThreadId: input.mapping.threadId,
      notes: [
        "Local mapping user does not match the source userId used for the scoped read.",
      ],
    };
  }
  return {
    classification: "mapped",
    mappingUserId: input.mapping.userId,
    mappingChannelId: input.mapping.channelId,
    mappingThreadId: input.mapping.threadId,
    notes: [
      "Corroborated by intelligence_channel_mappings and scoped source read.",
    ],
  };
}

function snapshot(
  threadsById: Map<string, ImportInventoryThread>,
  pairStates: ImportPairCursorState[],
  probes: ImportProbeRecord[],
  gaps: ImportInventoryResult["gaps"],
  options: { final: boolean },
): ImportInventoryResult {
  const inventoryCompleteForDeclaredScope =
    options.final &&
    pairStates.every(
      (pair) =>
        pair.exhausted &&
        !pair.cycleDetected &&
        !pair.paused &&
        !pair.noProgress,
    ) &&
    gaps.length === 0 &&
    probes.every((probe) => probe.outcome !== "error");
  return {
    threads: [...threadsById.values()],
    checkpoint: {
      pairs: pairStates.map((pair) => ({
        ...pair,
        seenCursors: [...pair.seenCursors],
      })),
      probes: [...probes],
    },
    inventoryCompleteForDeclaredScope,
    gaps: [...gaps],
  };
}

export async function runImportInventory(
  input: RunImportInventoryInput,
): Promise<ImportInventoryResult> {
  if (!input.attempt.token || input.attempt.kind !== "inventory") {
    throw new Error("A valid inventory attempt is required");
  }
  const pageLimit = input.pageLimit ?? 100;
  const maxPages = input.maxPagesPerPair ?? 50;
  const declared = await collectDeclaredPairs(
    input.database,
    input.explicitPairs,
  );
  const prior = new Map(
    (input.checkpoint?.pairs ?? []).map((pair) => [
      pairKey(pair.userId, pair.agentId),
      pair,
    ]),
  );
  const priorProbes = [...(input.checkpoint?.probes ?? [])];

  const threadsById = new Map<string, ImportInventoryThread>();
  const pairStates: ImportPairCursorState[] = [];
  const gaps: ImportInventoryResult["gaps"] = [];
  const probes: ImportProbeRecord[] = [...priorProbes];

  const commit = async () => {
    if (input.onPageCommit) {
      await input.onPageCommit(
        snapshot(threadsById, pairStates, probes, gaps, { final: false }),
        input.attempt,
      );
    }
  };

  for (const [key, origins] of declared) {
    const [userId, agentId] = key.split("\0") as [string, string];
    const [origin] = origins;
    if (origin === undefined) {
      throw new Error(`Declared pair ${key} has no origin`);
    }
    const previous = prior.get(key);
    const state: ImportPairCursorState = previous
      ? {
          ...previous,
          origins: mergeOrigins(previous.origins, origin),
          seenCursors: [...previous.seenCursors],
        }
      : {
          userId,
          agentId,
          nextCursor: null,
          exhausted: false,
          paused: false,
          cycleDetected: false,
          noProgress: false,
          seenCursors: [],
          pageCount: 0,
          threadCount: 0,
          origins,
        };
    state.origins = origins;
    pairStates.push(state);

    if (state.exhausted || state.cycleDetected) {
      continue;
    }
    if (state.paused) {
      state.paused = false;
    }

    let pagesThisResume = 0;
    while (!state.exhausted && !state.cycleDetected && !state.paused) {
      if (input.signal?.aborted) {
        state.paused = true;
        gaps.push({
          pair: { userId, agentId },
          reason: "Inventory cancelled.",
        });
        break;
      }
      if (pagesThisResume >= maxPages) {
        state.paused = true;
        gaps.push({
          pair: { userId, agentId },
          reason: "Page cap reached; inventory is paused, not complete.",
        });
        break;
      }
      const cursor = state.nextCursor;
      if (cursor !== null && state.seenCursors.includes(cursor)) {
        state.cycleDetected = true;
        gaps.push({
          pair: { userId, agentId },
          reason: "Cursor cycle detected.",
        });
        break;
      }

      const page = await input.source.listThreads({
        userId,
        agentId,
        includeArchived: true,
        limit: pageLimit,
        ...(cursor ? { cursor } : {}),
        signal: input.signal,
      });
      if (!page.ok) {
        state.paused = true;
        gaps.push({ pair: { userId, agentId }, reason: page.message });
        await commit();
        break;
      }
      if (cursor !== null) state.seenCursors.push(cursor);
      pagesThisResume += 1;

      for (const summary of page.value.threads) {
        const mapping = await mappingForThread(input.database, summary.id);
        const existing = threadsById.get(summary.id);
        if (existing) {
          if (
            existing.sourceUserId !== userId ||
            existing.sourceAgentId !== agentId
          ) {
            existing.ownership = {
              classification: "identity-conflict",
              mappingUserId: existing.ownership.mappingUserId,
              mappingChannelId: existing.ownership.mappingChannelId,
              mappingThreadId: existing.ownership.mappingThreadId,
              notes: [
                ...existing.ownership.notes,
                "Same source thread id observed under a different user/agent pair.",
              ],
            };
          } else {
            existing.pairOrigins = mergeOrigins(existing.pairOrigins, origin);
          }
          continue;
        }
        threadsById.set(summary.id, {
          sourceThreadId: summary.id,
          sourceUserId: userId,
          sourceAgentId: agentId,
          summary,
          pairOrigins: origins,
          ownership: classifyOwnership({
            sourceUserId: userId,
            sourceThreadId: summary.id,
            mapping,
          }),
          discovery: "list",
        });
        state.threadCount += 1;
      }

      state.pageCount += 1;
      const next = page.value.nextCursor;
      if (next == null || next === "") {
        state.nextCursor = null;
        state.exhausted = true;
        await commit();
        break;
      }
      if (next === cursor || state.seenCursors.includes(next)) {
        state.cycleDetected = true;
        gaps.push({
          pair: { userId, agentId },
          reason: "Cursor cycle detected.",
        });
        await commit();
        break;
      }
      state.nextCursor = next;
      await commit();
    }
  }

  const listedIds = new Set(threadsById.keys());
  const mappings = await input.database
    .select({
      userId: intelligenceChannelMappings.userId,
      threadId: intelligenceChannelMappings.threadId,
      channelId: intelligenceChannelMappings.channelId,
    })
    .from(intelligenceChannelMappings);

  const toProbe: Array<{
    threadId: string;
    userId: string;
    origin: "mapped-probe" | "explicit-probe";
    mapped: boolean;
  }> = [];

  for (const mapping of mappings) {
    if (!listedIds.has(mapping.threadId)) {
      toProbe.push({
        threadId: mapping.threadId,
        userId: mapping.userId,
        origin: "mapped-probe",
        mapped: true,
      });
    }
  }
  for (const explicit of input.explicitIds ?? []) {
    if (!listedIds.has(explicit.threadId)) {
      toProbe.push({
        threadId: explicit.threadId,
        userId: explicit.userId,
        origin: "explicit-probe",
        mapped: false,
      });
    }
  }

  const probed = new Set(
    probes
      .filter((probe) => probe.outcome !== "error")
      .map((probe) => `${probe.origin}:${probe.threadId}:${probe.userId}`),
  );
  for (const candidate of toProbe) {
    const probeKey = `${candidate.origin}:${candidate.threadId}:${candidate.userId}`;
    if (probed.has(probeKey)) continue;
    if (input.signal?.aborted) {
      gaps.push({
        threadId: candidate.threadId,
        reason: "Inventory cancelled before probe.",
      });
      break;
    }
    const got = await input.source.getThread({
      threadId: candidate.threadId,
      userId: candidate.userId,
      signal: input.signal,
    });
    if (got.ok) {
      const mapping = await mappingForThread(
        input.database,
        candidate.threadId,
      );
      const unowned = candidate.origin === "explicit-probe" && !mapping;
      const ownership = classifyOwnership({
        sourceUserId: candidate.userId,
        sourceThreadId: candidate.threadId,
        mapping,
        explicitUnowned: unowned,
      });
      threadsById.set(candidate.threadId, {
        sourceThreadId: candidate.threadId,
        sourceUserId: candidate.userId,
        sourceAgentId: got.value.agentId ?? "",
        summary: got.value,
        pairOrigins: candidate.mapped ? ["mapping"] : ["explicit"],
        ownership,
        discovery: candidate.origin,
      });
      probes.push({
        threadId: candidate.threadId,
        userId: candidate.userId,
        origin: candidate.origin,
        outcome: unowned ? "unowned-blocked" : "found",
      });
    } else if ("gap" in got && got.gap === "not-found") {
      probes.push({
        threadId: candidate.threadId,
        userId: candidate.userId,
        origin: candidate.origin,
        outcome: "not-found",
      });
      threadsById.set(candidate.threadId, {
        sourceThreadId: candidate.threadId,
        sourceUserId: candidate.userId,
        sourceAgentId: "",
        summary: { id: candidate.threadId, name: null },
        pairOrigins: candidate.mapped ? ["mapping"] : ["explicit"],
        ownership: {
          classification: "probe-not-found",
          notes: [
            "Scoped getThread returned not-found for this mapped/explicit id.",
          ],
        },
        discovery: candidate.origin,
      });
    } else {
      for (let i = probes.length - 1; i >= 0; i -= 1) {
        const prior = probes[i];
        if (prior === undefined) continue;
        if (
          prior.origin === candidate.origin &&
          prior.threadId === candidate.threadId &&
          prior.userId === candidate.userId &&
          prior.outcome === "error"
        ) {
          probes.splice(i, 1);
        }
      }
      probes.push({
        threadId: candidate.threadId,
        userId: candidate.userId,
        origin: candidate.origin,
        outcome: "error",
      });
      gaps.push({
        threadId: candidate.threadId,
        reason:
          "ok" in got && !got.ok && "message" in got
            ? got.message
            : "Probe failed.",
      });
    }
    probed.add(probeKey);
    await commit();
  }

  return snapshot(threadsById, pairStates, probes, gaps, { final: true });
}
