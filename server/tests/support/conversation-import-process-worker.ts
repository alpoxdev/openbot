import { createConversationImporter } from "../../src/conversations/importer";
import { createConversationImportStore } from "../../src/conversations/import-store";
import type { ConversationImportSource } from "../../src/conversations/import-source";
import { createConversationStore } from "../../src/conversations/store";
import { createDatabase } from "../../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./database";

// Fixture-only key: reauthorization is explicit and deterministic; no provider/source credential
// is inherited because the parent launches this worker with --no-env-file and a minimal env.
const KEY = `${"A".repeat(43)}=`;

type Fixture = {
  namespace: string;
  adminUserId: string;
  ownerUserId: string;
  agentId: string;
  sourceThreadId: string;
  jobId: string;
  itemId: string;
};

const rawFixture = process.env.CONVERSATION_IMPORT_PROCESS_FIXTURE;
const mode = process.env.CONVERSATION_IMPORT_PROCESS_MODE;
if (!rawFixture || (mode !== "stage" && mode !== "resume")) {
  throw new Error("Conversation import process fixture is invalid.");
}

let fixture: Fixture;
try {
  const parsed: unknown = JSON.parse(rawFixture);
  if (!parsed || typeof parsed !== "object") throw new Error();
  fixture = parsed as Fixture;
} catch {
  throw new Error("Conversation import process fixture is invalid.");
}

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const importStore = createConversationImportStore(database, {
  encryptionKey: KEY,
});
const conversations = createConversationStore(database);
const actor = { id: fixture.adminUserId, role: "admin" as const };

const messages = [
  {
    id: `${fixture.namespace}-user`,
    role: "user",
    content: "Imported process fixture.",
  },
  {
    id: `${fixture.namespace}-assistant-tool`,
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: `${fixture.namespace}-tool-call`,
        name: "deterministic_lookup",
        args: '{"key":"import-process-fixture"}',
      },
    ],
  },
  {
    id: `${fixture.namespace}-tool-result`,
    role: "tool",
    toolCallId: `${fixture.namespace}-tool-call`,
    content: "Imported deterministic result.",
  },
  {
    id: `${fixture.namespace}-assistant-final`,
    role: "assistant",
    content: "Imported process fixture persisted.",
  },
];

const source: ConversationImportSource = {
  async listThreads() {
    return { ok: true, value: { threads: [], nextCursor: null } };
  },
  async getThread({ threadId }) {
    if (threadId !== fixture.sourceThreadId)
      return { ok: false, gap: "not-found", message: "fixture thread missing" };
    return {
      ok: true,
      value: {
        id: fixture.sourceThreadId,
        name: "Imported process fixture",
        agentId: fixture.agentId,
        createdById: fixture.ownerUserId,
      },
    };
  },
  async getThreadMessages({ threadId }) {
    if (threadId !== fixture.sourceThreadId)
      return { ok: false, gap: "not-found", message: "fixture thread missing" };
    return { ok: true, value: { messages: messages as never } };
  },
  async getThreadEvents() {
    return {
      ok: true,
      value: {
        events: [{ type: "TEXT_MESSAGE_START" }],
        decodeErrorRowIds: [],
        truncated: false,
      },
    };
  },
  async getThreadState() {
    return {
      ok: true,
      value: { kind: "snapshot", state: {}, skippedDeltas: 0 },
    };
  },
};

async function stage() {
  const current = await importStore.getJob(actor, fixture.jobId);
  if (!current.approvedManifestHash)
    throw new Error("Approved import manifest is missing.");
  const admission = await importStore.acquireAttempt({
    actor,
    jobId: fixture.jobId,
    kind: "run",
    approvedManifestHash: current.approvedManifestHash,
  });
  const item = await importStore.getItem(actor, fixture.jobId, fixture.itemId);
  const staged = await importStore.encryptItemResources({
    actor,
    jobId: fixture.jobId,
    itemId: item.id,
    resources: { messages, marker: "process-import-resource" },
    attempt: admission.attempt,
    expectedPhase: "importing",
  });
  const job = await importStore.getJob(actor, fixture.jobId);
  console.log(
    JSON.stringify({
      type: "staged",
      namespace: fixture.namespace,
      jobId: fixture.jobId,
      itemId: fixture.itemId,
      phase: job.phase,
      status: staged.status,
      hasEncryptedResources: staged.hasEncryptedResources,
    }),
  );
  await new Promise<void>(() => undefined);
}

async function resume() {
  const job = await importStore.getJob(actor, fixture.jobId);
  if (!job.approvedManifestHash)
    throw new Error("Approved import manifest is missing.");
  const summary = await createConversationImporter({
    database,
    importStore,
    conversations,
  }).runApprovedImport({
    actor,
    jobId: fixture.jobId,
    approvedManifestHash: job.approvedManifestHash,
    source,
    itemIds: [fixture.itemId],
  });
  console.log(
    JSON.stringify({
      type: "resumed",
      namespace: fixture.namespace,
      jobId: fixture.jobId,
      phase: summary.phase,
      published: summary.counts.published,
      unchanged: summary.counts.unchanged,
    }),
  );
}

void (async () => {
  try {
    if (mode === "stage") await stage();
    else await resume();
  } finally {
    await database.$client.close();
  }
})().catch(async () => {
  console.log(
    JSON.stringify({
      type: "error",
      namespace: fixture.namespace,
      message: "Conversation import process worker failed.",
    }),
  );
  await database.$client.close();
  process.exitCode = 1;
});
