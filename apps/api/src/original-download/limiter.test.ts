import { describe, expect, it } from "vitest";

import { OriginalDownloadLimiter } from "./limiter.js";

describe("OriginalDownloadLimiter", () => {
  it("enforces process/member limits without a queue and releases idempotently", () => {
    const limiter = new OriginalDownloadLimiter();
    const first = limiter.tryAcquire("1", "10");
    expect(first).not.toBeNull();
    expect(limiter.tryAcquire("1", "10")).toBeNull();
    const second = limiter.tryAcquire("1", "11");
    expect(second).not.toBeNull();
    expect(limiter.tryAcquire("1", "12")).toBeNull();
    expect(limiter.snapshot()).toEqual({ active: 2, activeMembers: 2 });
    first!.release();
    first!.release();
    expect(limiter.snapshot()).toEqual({ active: 1, activeMembers: 1 });
    expect(limiter.tryAcquire("1", "10")).not.toBeNull();
    second!.release();
  });
});
