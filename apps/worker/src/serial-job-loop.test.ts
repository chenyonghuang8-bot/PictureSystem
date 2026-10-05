import { expect, it } from "vitest";
import { SerialJobLoop } from "./serial-job-loop.js";

it("interrupts idle without starting another operation", async () => {
  let calls = 0;
  const loop = new SerialJobLoop(async () => {
    calls++;
    await loop.wait(30000);
  });
  const done = loop.start();
  loop.requestStop();
  await done;
  await loop.drain();
  expect(calls).toBe(1);
});
it("drains current operation before completion and propagates fatal errors", async () => {
  let release!: () => void,
    calls = 0;
  const loop = new SerialJobLoop(async () => {
    calls++;
    await new Promise<void>((r) => {
      release = r;
    });
  });
  let settled = false;
  const done = loop.start().then(() => {
    settled = true;
  });
  loop.requestStop();
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await done;
  expect(calls).toBe(1);
  const error = new Error("UNKNOWN"),
    fatal = new SerialJobLoop(async () => {
      throw error;
    });
  await expect(fatal.start()).rejects.toBe(error);
  await expect(fatal.drain()).rejects.toBe(error);
});
