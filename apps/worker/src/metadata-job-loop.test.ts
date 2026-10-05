import { expect, it, vi } from "vitest";
import type { Pool } from "mysql2/promise";
import { MetadataJobDriver } from "./metadata-driver.js";
import { MetadataJobLoop } from "./metadata-job-loop.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
it("stop during discovery selects no recovery or claim", async () => {
  const discovery = barrier(),
    entered = barrier();
  const driver = new MetadataJobDriver(
    {
      query: async () => {
        entered.release();
        await discovery.promise;
        return [[{ familyId: "1", mediaId: "2", jobId: "3", generation: "1" }]];
      },
    } as unknown as Pool,
    {} as never,
    {} as never,
  );
  const recoverExpiredLease = vi.fn(),
    claimNext = vi.fn();
  Object.assign(driver, { jobs: { recoverExpiredLease, claimNext } });
  const loop = new MetadataJobLoop(driver),
    completion = loop.start();
  await entered.promise;
  loop.requestStop();
  discovery.release();
  await completion;
  await loop.drain();
  expect(recoverExpiredLease).not.toHaveBeenCalled();
  expect(claimNext).not.toHaveBeenCalled();
});
it("stop drains one active recovery and selects no remaining recovery or new claim", async () => {
  const operation = barrier(),
    entered = barrier();
  const driver = new MetadataJobDriver(
    {
      query: async () => [
        [1, 2].map((n) => ({
          familyId: "1",
          mediaId: String(n),
          jobId: String(n),
          generation: "1",
        })),
      ],
    } as unknown as Pool,
    {} as never,
    {} as never,
  );
  const recoverExpiredLease = vi.fn(async () => {
      entered.release();
      await operation.promise;
    }),
    claimNext = vi.fn();
  Object.assign(driver, { jobs: { recoverExpiredLease, claimNext } });
  const loop = new MetadataJobLoop(driver),
    completion = loop.start();
  await entered.promise;
  loop.requestStop();
  let drained = false;
  const drain = loop.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  operation.release();
  await completion;
  await drain;
  expect(recoverExpiredLease).toHaveBeenCalledTimes(1);
  expect(claimNext).not.toHaveBeenCalled();
});
it("stop drains active probe before cleanup and interrupts idle wait", async () => {
  const probe = barrier(),
    entered = barrier();
  const runNext = vi.fn(async () => {
    entered.release();
    await probe.promise;
    return true;
  });
  const driver = {
    recoverExpired: vi.fn(async () => {}),
    runNext,
    requestStop: vi.fn(),
  };
  const loop = new MetadataJobLoop(driver),
    closed = vi.fn();
  const completion = loop.start().finally(closed);
  await entered.promise;
  loop.requestStop();
  await Promise.resolve();
  expect(closed).not.toHaveBeenCalled();
  probe.release();
  await completion;
  expect(runNext).toHaveBeenCalledTimes(1);
  expect(closed).toHaveBeenCalledTimes(1);
  const idle = new MetadataJobLoop({ ...driver, runNext: async () => false });
  const waiting = idle.start();
  await Promise.resolve();
  idle.requestStop();
  await waiting;
});
