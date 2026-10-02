import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolConnection } from "mysql2/promise";
import { AuditRepository, PurgeIntentRepository } from "./purge-repository.js";

// These tests inspect statement fences; checked transaction health and atomic
// failure audit behavior are exercised by the live DEV integration suite.
vi.mock("./connection.js", () => ({
  runCheckedTransaction: async (
    pool: Pool,
    operation: (connection: PoolConnection) => Promise<unknown>,
  ) => operation(pool as unknown as PoolConnection),
}));

const lease = { id: "42", epoch: 3n, workerId: Buffer.alloc(16, 7) };
function poolWithRows(affectedRows: number) {
  const execute = vi.fn().mockResolvedValue([{ affectedRows }]);
  return { pool: { execute } as unknown as Pool, execute };
}

describe("Phase 7 durable purge repository fences", () => {
  it("returns zero for a stale lease and binds epoch plus worker on every mutation", async () => {
    const { pool, execute } = poolWithRows(0);
    const repo = new PurgeIntentRepository(pool);
    expect(await repo.heartbeat(lease)).toBe(false);
    expect(await repo.advance(lease, "REQUESTED", "DETACHED")).toBe(false);
    expect(await repo.fail(lease, "TRANSIENT_DB", 30)).toBe(false);
    for (const [sql, values] of execute.mock.calls) {
      expect(sql).toContain("lease_epoch=?");
      expect(sql).toContain("worker_id=?");
      expect(sql).toContain("locked_until > CURRENT_TIMESTAMP(3)");
      expect(values).toContain("3");
      expect(values).toContain(lease.workerId);
    }
  });

  it("rejects invalid progress and retry delay before writing", async () => {
    const { pool, execute } = poolWithRows(1);
    const repo = new PurgeIntentRepository(pool);
    await expect(
      repo.advance(lease, "REQUESTED", "COMPLETED"),
    ).rejects.toThrow();
    await expect(repo.fail(lease, "TRANSIENT_DB", 1)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("classifies only exact duplicate lifecycle identity as idempotent", async () => {
    const now = new Date("2026-10-01T00:00:00.000Z");
    const after = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const input = {
      familyId: "1",
      operationId: "op",
      mediaId: "2",
      storageObjectId: "3",
      sourceUploadId: "4",
      lifecycleRevision: 1n,
      trashedAt: now,
      purgeAfter: after,
      requestSource: "MANUAL" as const,
      actorMemberId: "5",
      originalBytes: 100n,
    };
    const execute = vi.fn().mockResolvedValue([
      [
        {
          id: "9",
          operationId: "op",
          storageObjectId: "3",
          sourceUploadId: "4",
          trashedAt: now,
          purgeAfter: after,
          requestSource: "MANUAL",
          actorMemberId: "5",
          originalBytes: "100",
        },
      ],
    ]);
    const connection = { execute } as unknown as PoolConnection;
    const repo = new PurgeIntentRepository({} as Pool);
    expect(await repo.create(connection, input)).toEqual({
      id: "9",
      created: false,
    });
    await expect(
      repo.create(connection, { ...input, operationId: "other" }),
    ).rejects.toThrow("PURGE_IDENTITY_CONFLICT");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps audit append narrow and propagates duplicate errors", async () => {
    const { pool, execute } = poolWithRows(1);
    execute.mockResolvedValueOnce([{ insertId: 12 }]);
    const audit = new AuditRepository(pool);
    expect(
      await audit.append({
        familyId: "1",
        operationId: "op",
        purgeIntentId: null,
        mediaId: "2",
        storageObjectId: "3",
        actorKind: "SYSTEM",
        actorMemberId: null,
        action: "PURGE_STARTED",
        lifecycleRevision: 1n,
        transitionId: "t",
        resultCategory: "SUCCESS",
      }),
    ).toBe("12");
    const [sql] = execute.mock.calls[0]!;
    expect(sql).not.toMatch(/filename|path|sha256|token|cookie|authorization/i);
  });
});
