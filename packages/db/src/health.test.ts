import { describe, expect, it, vi } from "vitest";
import type { Connection } from "mysql2/promise";
import { validateDatabaseHealth } from "./health.js";

function connectionFor(rows: unknown[]) {
  return { query: vi.fn().mockResolvedValue([rows, []]) } as unknown as Pick<
    Connection,
    "query"
  >;
}

describe("database FK health", () => {
  it.each([1, "1"])("accepts enabled flags encoded as %j", async (flag) => {
    await expect(
      validateDatabaseHealth(
        connectionFor([{ nativeFk: flag, foreignKeyChecks: flag }]),
      ),
    ).resolves.toEqual({ nativeFk: true, foreignKeyChecks: true });
  });
  it.each([0, "0", undefined, null])(
    "fails closed for native FK %j",
    async (flag) => {
      await expect(
        validateDatabaseHealth(
          connectionFor([{ nativeFk: flag, foreignKeyChecks: 1 }]),
        ),
      ).rejects.toThrow("DB_NATIVE_FK_REQUIRED");
    },
  );
  it.each([0, "0", undefined, null])(
    "fails closed for session FK checks %j",
    async (flag) => {
      await expect(
        validateDatabaseHealth(
          connectionFor([{ nativeFk: 1, foreignKeyChecks: flag }]),
        ),
      ).rejects.toThrow("DB_FK_CHECKS_REQUIRED");
    },
  );
  it("rejects missing rows", async () => {
    await expect(validateDatabaseHealth(connectionFor([]))).rejects.toThrow(
      "DB_NATIVE_FK_REQUIRED",
    );
  });
  it("propagates query failure rather than reporting healthy", async () => {
    const connection = {
      query: vi.fn().mockRejectedValue(new Error("query failed")),
    } as unknown as Pick<Connection, "query">;
    await expect(validateDatabaseHealth(connection)).rejects.toThrow(
      "query failed",
    );
  });
});
