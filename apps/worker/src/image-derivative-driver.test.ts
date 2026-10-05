import { expect, it, vi } from "vitest";
import type { Pool } from "mysql2/promise";
import {
  CommitOutcomeUnknownError,
  TransactionRollbackFailedError,
} from "@family-album/db";
import { ImageDerivativeDriver } from "./image-derivative-driver.js";

it("uncertain recovery stops before any claim", async () => {
  const error = new CommitOutcomeUnknownError(),
    pool = {
      getConnection: vi.fn(async () => {
        throw error;
      }),
    };
  const driver = new ImageDerivativeDriver(
      pool as unknown as Pool,
      {} as never,
      {} as never,
    ),
    run = vi.fn();
  Object.assign(driver, { processor: { run } });
  await expect(driver.recoverExpired()).rejects.toBe(error);
  await expect(driver.runNext()).rejects.toThrow(
    "DERIVATIVE_STOPPED_RESTART_REQUIRED",
  );
  expect(run).not.toHaveBeenCalled();
});

it("unresolved unknown and thrown DB failures latch stopped until a new driver, with no next claim", async () => {
  for (const failure of [
    undefined,
    new CommitOutcomeUnknownError(),
    new TransactionRollbackFailedError(),
    new Error("DB_FAILURE"),
  ]) {
    const driver = new ImageDerivativeDriver(
      {} as Pool,
      {} as never,
      {} as never,
    );
    const run = vi.fn(async () => {
      if (failure) throw failure;
      return { outcome: "COMMIT_UNKNOWN" };
    });
    // Replace only the typed processor collaborator; native handles are never
    // opened for this fault-path test. Runtime has no configurable bypass.
    Object.assign(driver, { processor: { run } });
    await expect(driver.runNext()).rejects.toThrow();
    await expect(driver.runNext()).rejects.toThrow(
      "DERIVATIVE_STOPPED_RESTART_REQUIRED",
    );
    expect(run).toHaveBeenCalledTimes(1);
    driver.requestStop();
    await driver.drain();
  }
});
