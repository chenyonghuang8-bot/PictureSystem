import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolConnection } from "mysql2/promise";
import { boundedCheckedRead } from "./bounded-read.js";
function connection() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("nativeFk"))
        return [[{ nativeFk: 1, foreignKeyChecks: 1 }]];
      if (sql.includes("sqlMode"))
        return [[{ timeZone: "+00:00", sqlMode: "STRICT_TRANS_TABLES" }]];
      return [[]];
    }),
    destroy: vi.fn(),
    release: vi.fn(),
  };
}
function pool(c: ReturnType<typeof connection>) {
  return { getConnection: async () => c } as unknown as Pool;
}
afterEach(() => {
  vi.useRealTimers();
});
describe("bounded checked observation", () => {
  it("uses normal UTC, strict mode and native FK checks before the observation", async () => {
    const c = connection(),
      read = vi.fn(async () => "ok");
    expect(await boundedCheckedRead(pool(c), read)).toBe("ok");
    expect(c.query).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenCalledOnce();
    expect(c.release).toHaveBeenCalledOnce();
    expect(c.destroy).not.toHaveBeenCalled();
  });
  it("does not invoke read after a late acquisition and discards the late connection", async () => {
    vi.useFakeTimers();
    const c = connection();
    let resolve!: (v: PoolConnection) => void;
    const p = {
      getConnection: () =>
        new Promise<PoolConnection>((r) => {
          resolve = r;
        }),
    } as unknown as Pool;
    const read = vi.fn(async () => "unsafe");
    const result = boundedCheckedRead(p, read, 20);
    const rejected = expect(result).rejects.toThrow("READINESS_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    resolve(c as unknown as PoolConnection);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.destroy).toHaveBeenCalledOnce();
    expect(c.release).not.toHaveBeenCalled();
    expect(c.query).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it("destroys an active slow health query and never invokes the observation", async () => {
    vi.useFakeTimers();
    const c = connection();
    let resume!: () => void;
    c.query.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resume = () => r([[]]);
        }),
    );
    const read = vi.fn(async () => "unsafe");
    const result = boundedCheckedRead(pool(c), read, 20);
    const rejected = expect(result).rejects.toThrow("READINESS_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(c.destroy).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).not.toHaveBeenCalled();
    expect(c.release).not.toHaveBeenCalled();
  });
  it("destroys a timed-out observation rather than returning a late success to callers", async () => {
    vi.useFakeTimers();
    const c = connection();
    let resume!: (v: string) => void;
    const result = boundedCheckedRead(
      pool(c),
      () =>
        new Promise<string>((r) => {
          resume = r;
        }),
      20,
    );
    const rejected = expect(result).rejects.toThrow("READINESS_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(c.destroy).toHaveBeenCalledOnce();
    resume("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(c.release).not.toHaveBeenCalled();
  });
  it("releases a checked connection after an ordinary observation failure", async () => {
    const c = connection();
    await expect(
      boundedCheckedRead(pool(c), async () => {
        throw Error("READ_FAILED");
      }),
    ).rejects.toThrow("READ_FAILED");
    expect(c.release).toHaveBeenCalledOnce();
    expect(c.destroy).not.toHaveBeenCalled();
  });
  it.each([0, -1, 2001, Infinity, NaN])(
    "rejects an invalid observation budget %s before acquisition",
    async (budget) => {
      const c = connection(),
        getConnection = vi.fn(async () => c);
      await expect(
        boundedCheckedRead(
          { getConnection } as unknown as Pool,
          async () => {},
          budget,
        ),
      ).rejects.toThrow("READINESS_BUDGET_INVALID");
      expect(getConnection).not.toHaveBeenCalled();
    },
  );
});
