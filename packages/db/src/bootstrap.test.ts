import type { Pool, PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";

import { bootstrapIdentity, BootstrapRejectedError } from "./bootstrap.js";

vi.mock("./migration-readiness.js", () => {
  class MigrationReadinessError extends Error {}
  return {
    MigrationReadinessError,
    assertMigrationReadiness: vi.fn(async (connection: PoolConnection) => {
      await connection.query("/* TEST_MIGRATION_READINESS */ SELECT 1");
    }),
  };
});

function setup(input?: {
  lock?: "0" | "1" | (() => "0" | "1");
  databaseName?: string;
  currentUser?: string;
  counts?: [string, string, string];
  readinessFailure?: boolean;
  firstInsertDeadlock?: boolean;
  releaseLock?: "0" | "1";
  commitUnknown?: boolean;
  beforeIdentity?: () => Promise<void>;
  afterRelease?: () => void;
}) {
  const [users, families, members] = input?.counts ?? ["0", "0", "0"];
  let insertId = 0;
  let deadlocked = false;
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SET SESSION")) return [[], []];
    if (sql.includes("innodb_native_foreign_keys")) {
      return [[{ nativeFk: 1, foreignKeyChecks: 1 }], []];
    }
    if (sql.includes("@@SESSION.time_zone")) {
      return [[{ timeZone: "+00:00", sqlMode: "STRICT_TRANS_TABLES" }], []];
    }
    if (sql.includes("GET_LOCK")) {
      const acquired =
        typeof input?.lock === "function" ? input.lock() : (input?.lock ?? "1");
      return [[{ acquired }], []];
    }
    if (sql.includes("DATABASE() AS databaseName")) {
      await input?.beforeIdentity?.();
      return [
        [
          {
            databaseName: input?.databaseName ?? "family_album_dev",
            currentUser:
              input?.currentUser ?? "family_album_dev_user@localhost",
          },
        ],
        [],
      ];
    }
    if (sql.includes("TEST_MIGRATION_READINESS")) {
      if (input?.readinessFailure) {
        const { MigrationReadinessError } =
          await import("./migration-readiness.js");
        throw new MigrationReadinessError("JOURNAL_MISMATCH");
      }
      return [[], []];
    }
    if (sql.includes("SELECT COUNT(*) FROM users")) {
      return [[{ users, families, members }], []];
    }
    if (sql.includes("CURRENT_TIMESTAMP")) {
      return [[{ serverNow: new Date("2026-01-01T00:00:00Z") }], []];
    }
    if (sql.startsWith("INSERT")) {
      if (input?.firstInsertDeadlock && !deadlocked) {
        deadlocked = true;
        throw Object.assign(new Error("synthetic deadlock"), {
          code: "ER_LOCK_DEADLOCK",
          errno: 1213,
          sqlState: "40001",
        });
      }
      insertId += 1;
      return [{ insertId, affectedRows: 1 }, []];
    }
    if (sql.includes("RELEASE_LOCK")) {
      input?.afterRelease?.();
      return [[{ released: input?.releaseLock ?? "1" }], []];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const connection = {
    query,
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => {
      if (input?.commitUnknown) {
        throw Object.assign(new Error("lost commit response"), {
          code: "PROTOCOL_CONNECTION_LOST",
        });
      }
    }),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    destroy: vi.fn(),
  } as unknown as PoolConnection;
  const pool = {
    getConnection: vi.fn(async () => connection),
  } as unknown as Pool;
  return { pool, connection, query };
}

const request = {
  familyName: "Synthetic family",
  username: "Admin",
  usernameNormalized: Buffer.from("admin"),
  passwordHash: "$argon2id$synthetic",
  displayName: "Admin",
};

describe("bootstrapIdentity", () => {
  it("creates exactly one family, user, and SUPER_ADMIN in one transaction", async () => {
    const { pool, connection, query } = setup();
    await expect(bootstrapIdentity(pool, request)).resolves.toEqual({
      familyId: "1",
      userId: "2",
      memberId: "3",
      cleanupWarning: false,
    });
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("'SUPER_ADMIN'")),
    ).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toContain("RELEASE_LOCK");
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it.each([
    [{ databaseName: "production" }, "WRONG_DATABASE"],
    [{ currentUser: "root@localhost" }, "ROOT_DATABASE_USER"],
    [
      { counts: ["1", "0", "0"] as [string, string, string] },
      "DATABASE_NOT_EMPTY",
    ],
    [{ readinessFailure: true }, "MIGRATION_NOT_READY"],
  ])("fails closed before writes", async (overrides, reason) => {
    const { pool, query } = setup(overrides);
    await expect(bootstrapIdentity(pool, request)).rejects.toMatchObject({
      reason,
    });
    expect(
      query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT")),
    ).toBe(false);
  });

  it("rejects a simultaneous contender when the named lock is held", async () => {
    const { pool, connection } = setup({ lock: "0" });
    await expect(bootstrapIdentity(pool, request)).rejects.toBeInstanceOf(
      BootstrapRejectedError,
    );
    expect(connection.beginTransaction).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it("allows only one of two simultaneous bootstrap contenders", async () => {
    let locked = false;
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const lock = () => {
      if (locked) return "0" as const;
      locked = true;
      return "1" as const;
    };
    const first = setup({
      lock,
      beforeIdentity: async () => {
        signalFirst();
        await holdFirst;
      },
      afterRelease: () => {
        locked = false;
      },
    });
    const second = setup({ lock });
    const winner = bootstrapIdentity(first.pool, request);
    await firstEntered;
    const loser = bootstrapIdentity(second.pool, request);
    await expect(loser).rejects.toMatchObject({ reason: "LOCK_UNAVAILABLE" });
    releaseFirst();
    await expect(winner).resolves.toMatchObject({ familyId: "1" });
  });

  it("reports cleanup trouble after a known commit and destroys the connection", async () => {
    const { pool, connection } = setup({ releaseLock: "0" });
    await expect(bootstrapIdentity(pool, request)).resolves.toMatchObject({
      cleanupWarning: true,
    });
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });

  it("never replays an unknown commit and releases the named lock by destroying", async () => {
    const { pool, connection } = setup({ commitUnknown: true });
    await expect(bootstrapIdentity(pool, request)).rejects.toMatchObject({
      name: "CommitOutcomeUnknownError",
    });
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it("rechecks readiness and empty identity state on a deadlock retry", async () => {
    const { pool, query } = setup({ firstInsertDeadlock: true });
    await expect(bootstrapIdentity(pool, request)).resolves.toMatchObject({
      familyId: "1",
    });
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes("TEST_MIGRATION_READINESS"),
      ),
    ).toHaveLength(2);
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes("SELECT COUNT(*) FROM users"),
      ),
    ).toHaveLength(2);
  });
});
