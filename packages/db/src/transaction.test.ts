import type { Pool, PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";

import {
  CommitOutcomeUnknownError,
  runTransaction,
  TransactionRollbackFailedError,
} from "./transaction.js";

function connection(overrides: Partial<PoolConnection> = {}) {
  return {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  } as unknown as PoolConnection;
}

const deadlock = () =>
  Object.assign(new Error("deadlock details must not escape"), {
    code: "ER_LOCK_DEADLOCK",
    errno: 1213,
    sqlState: "40001",
  });

describe("runTransaction", () => {
  it("retries one fully rolled-back deadlock on a fresh connection", async () => {
    const first = connection();
    const second = connection();
    const acquire = vi
      .fn<() => Promise<PoolConnection>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    await expect(
      runTransaction(
        {} as Pool,
        async () => {
          calls += 1;
          if (calls === 1) throw deadlock();
          return "ok";
        },
        { acquire, random: () => 0, sleep },
      ),
    ).resolves.toBe("ok");
    expect(first.rollback).toHaveBeenCalledOnce();
    expect(vi.mocked(first.release).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(second.beginTransaction).mock.invocationCallOrder[0]!,
    );
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("stops after three deadlocked attempts with bounded jitter", async () => {
    const connections = [connection(), connection(), connection()];
    const acquire = vi.fn(async () => connections.shift()!);
    const sleep = vi.fn(async () => undefined);
    await expect(
      runTransaction(
        {} as Pool,
        async () => {
          throw deadlock();
        },
        { acquire, random: () => 0.999_999, sleep },
      ),
    ).rejects.toMatchObject({ code: "ER_LOCK_DEADLOCK" });
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 50);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
  });

  it("does not retry a lock wait timeout", async () => {
    const current = connection();
    const acquire = vi.fn(async () => current);
    const operation = vi.fn(async () => {
      throw Object.assign(new Error("timeout"), {
        code: "ER_LOCK_WAIT_TIMEOUT",
        errno: 1205,
      });
    });
    await expect(
      runTransaction({} as Pool, operation, { acquire }),
    ).rejects.toMatchObject({ code: "ER_LOCK_WAIT_TIMEOUT" });
    expect(operation).toHaveBeenCalledOnce();
    expect(current.rollback).toHaveBeenCalledOnce();
    expect(current.release).toHaveBeenCalledOnce();
  });

  it("destroys a connection when rollback fails", async () => {
    const current = connection({
      rollback: vi.fn(async () => {
        throw new Error("rollback failed");
      }) as PoolConnection["rollback"],
    });
    await expect(
      runTransaction(
        {} as Pool,
        async () => {
          throw new Error("operation failed");
        },
        { acquire: async () => current },
      ),
    ).rejects.toBeInstanceOf(TransactionRollbackFailedError);
    expect(current.destroy).toHaveBeenCalledOnce();
    expect(current.release).not.toHaveBeenCalled();
  });

  it("destroys a connection after a rolled-back protocol failure", async () => {
    const current = connection();
    const operation = vi.fn(async () => {
      throw Object.assign(new Error("connection lost"), {
        code: "PROTOCOL_CONNECTION_LOST",
        fatal: true,
      });
    });
    await expect(
      runTransaction({} as Pool, operation, { acquire: async () => current }),
    ).rejects.toMatchObject({ code: "PROTOCOL_CONNECTION_LOST" });
    expect(operation).toHaveBeenCalledOnce();
    expect(current.rollback).toHaveBeenCalledOnce();
    expect(current.destroy).toHaveBeenCalledOnce();
    expect(current.release).not.toHaveBeenCalled();
  });

  it("never replays or releases a connection after an unclear commit", async () => {
    const current = connection({
      commit: vi.fn(async () => {
        throw Object.assign(new Error("network failed during commit"), {
          code: "PROTOCOL_CONNECTION_LOST",
        });
      }) as PoolConnection["commit"],
    });
    const operation = vi.fn(async () => "written");
    await expect(
      runTransaction({} as Pool, operation, { acquire: async () => current }),
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(operation).toHaveBeenCalledOnce();
    expect(current.rollback).not.toHaveBeenCalled();
    expect(current.destroy).toHaveBeenCalledOnce();
    expect(current.release).not.toHaveBeenCalled();
  });

  it("uses one custom lifecycle for named-lock connections", async () => {
    const current = connection();
    const release = vi.fn(async (target: PoolConnection) => target.release());
    const destroy = vi.fn(async (target: PoolConnection) => target.destroy());
    await expect(
      runTransaction({} as Pool, async () => "ok", {
        acquire: async () => current,
        release,
        destroy,
      }),
    ).resolves.toBe("ok");
    expect(release).toHaveBeenCalledWith(current);
    expect(destroy).not.toHaveBeenCalled();
  });
});
