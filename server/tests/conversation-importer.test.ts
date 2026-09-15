import { describe, expect, test } from "bun:test";
import { createConversationImporter } from "../src/conversations/importer";
import { runImportInventory } from "../src/conversations/import-inventory";
import { ImportJobConflictError } from "../src/conversations/import-store";
import { capturedContentHash } from "../src/conversations/import-validation";

const TEST_MANIFEST = {
  schemaVersion: 1,
  inventoryRevision: 0,
  sourceNamespace: "ns",
  sourceOrigin: "https://example.test",
  sourceReference: "ref",
  inventoryCompleteForDeclaredScope: true,
  pairCount: 0,
  threadCount: 0,
  notes: [],
};
const TEST_MANIFEST_HASH = capturedContentHash(TEST_MANIFEST);

type PromiseBackedQuery<T> = Promise<T[]> & {
  from: (...args: unknown[]) => PromiseBackedQuery<T>;
  leftJoin: (...args: unknown[]) => PromiseBackedQuery<T>;
  where: (...args: unknown[]) => PromiseBackedQuery<T>;
  limit: (...args: unknown[]) => PromiseBackedQuery<T>;
};

function promiseBackedQuery<T>(rows: T[]): PromiseBackedQuery<T> {
  const query = Promise.resolve(rows) as PromiseBackedQuery<T>;
  query.from = (..._args) => query;
  query.leftJoin = (..._args) => query;
  query.where = (..._args) => query;
  query.limit = (..._args) => query;
  return query;
}

describe("conversation importer guards", () => {
  test("requires an inventory attempt and passes it to page commits", async () => {
    const database = {
      select(..._args: unknown[]) {
        return promiseBackedQuery([]);
      },
    } as never;
    const source = {
      async listThreads() {
        return { ok: true as const, value: { threads: [], nextCursor: null } };
      },
    } as never;
    await expect(
      runImportInventory({
        database,
        attempt: { token: "", kind: "inventory" },
        source,
        explicitPairs: [],
      }),
    ).rejects.toThrow(/inventory attempt/i);

    const attempt = { token: "inventory-token", kind: "inventory" as const };
    const commits: unknown[] = [];
    await runImportInventory({
      database,
      attempt,
      source,
      explicitPairs: [{ userId: "owner", agentId: "agent" }],
      onPageCommit: async (_snapshot, committedAttempt) => {
        commits.push(committedAttempt);
      },
    });
    expect(commits).toEqual([attempt]);
  });

  test("refuses cancelled and mismatched manifest hashes without fetching", async () => {
    let fetches = 0;
    const importer = createConversationImporter({
      database: {} as never,
      conversations: {} as never,
      importStore: {
        async getJob() {
          return {
            id: "job",
            requestedBy: "admin",
            sourceNamespace: "ns",
            sourceOrigin: "https://example.test",
            sourceReference: "ref",
            phase: "cancelled",
            scope: {
              explicitPairs: [],
              explicitIds: [],
              sourceReference: "ref",
            },
            manifest: TEST_MANIFEST,
            approvedManifestHash: TEST_MANIFEST_HASH,
            checkpoint: { pairs: [] },
            attemptToken: null,
            attemptKind: null,
            attemptLeaseExpiresAt: null,
            attemptStatus: "none",
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
        async acquireAttempt() {
          return {
            job: await this.getJob({ id: "admin", role: "admin" }, "job"),
            attempt: { token: "attempt", kind: "run" as const },
          };
        },
      } as never,
    });
    await expect(
      importer.runApprovedImport({
        actor: { id: "admin", role: "admin" },
        jobId: "job",
        approvedManifestHash: TEST_MANIFEST_HASH,
        source: {
          async listThreads() {
            fetches += 1;
            return { ok: true, value: { threads: [], nextCursor: null } };
          },
        } as never,
      }),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
    expect(fetches).toBe(0);
  });

  test("rejects unknown item ids", async () => {
    const importer = createConversationImporter({
      database: {} as never,
      conversations: {} as never,
      importStore: {
        async getJob() {
          return {
            id: "job",
            requestedBy: "admin",
            sourceNamespace: "ns",
            sourceOrigin: "https://example.test",
            sourceReference: "ref",
            phase: "awaiting_confirmation",
            scope: {
              explicitPairs: [],
              explicitIds: [],
              sourceReference: "ref",
            },
            manifest: TEST_MANIFEST,
            approvedManifestHash: TEST_MANIFEST_HASH,
            checkpoint: { pairs: [] },
            attemptToken: null,
            attemptKind: null,
            attemptLeaseExpiresAt: null,
            attemptStatus: "none",
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
        async acquireAttempt() {
          const current = await this.getJob(
            { id: "admin", role: "admin" },
            "job",
          );
          return {
            job: { ...current, phase: "importing" as const },
            attempt: { token: "attempt", kind: "run" as const },
          };
        },
        async updatePhase() {
          return this.getJob();
        },
        async listItems() {
          return [{ id: "known", status: "discovered" }];
        },
      } as never,
    });
    await expect(
      importer.runApprovedImport({
        actor: { id: "admin", role: "admin" },
        jobId: "job",
        approvedManifestHash: TEST_MANIFEST_HASH,
        itemIds: ["missing"],
        source: {
          async listThreads() {
            return { ok: true, value: { threads: [], nextCursor: null } };
          },
        } as never,
      }),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
  });
});
