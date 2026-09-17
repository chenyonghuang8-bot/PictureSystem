import { describe, expect, it } from "vitest";

import { UploadMutex } from "./mutex.js";

describe("UploadMutex", () => {
  it("serializes operations for one upload and releases after failure", async () => {
    const mutex = new UploadMutex();
    const order: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = mutex.runExclusive("upload", async () => {
      order.push("first-start");
      started();
      await barrier;
      order.push("first-end");
      throw new Error("synthetic");
    });
    const second = mutex.runExclusive("upload", async () => {
      order.push("second");
    });
    await entered;
    expect(order).toEqual(["first-start"]);
    release();
    await expect(first).rejects.toThrow("synthetic");
    await second;
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("bounds queued writers", async () => {
    const mutex = new UploadMutex(0);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = mutex.runExclusive("upload", () => barrier);
    await Promise.resolve();
    await expect(
      mutex.runExclusive("upload", async () => undefined),
    ).rejects.toMatchObject({
      status_code: 429,
    });
    release();
    await first;
  });
});
