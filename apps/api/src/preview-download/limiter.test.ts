import { describe, expect, it } from "vitest";

import { PreviewDownloadLimiter } from "./limiter.js";

describe("PreviewDownloadLimiter", () => {
  it("enforces process=4 and member=2 without a queue", () => {
    const limiter = new PreviewDownloadLimiter();
    const leases = [
      limiter.tryAcquire("1", "10"),
      limiter.tryAcquire("1", "10"),
      limiter.tryAcquire("1", "11"),
      limiter.tryAcquire("1", "12"),
    ];
    expect(leases.every(Boolean)).toBe(true);
    expect(limiter.tryAcquire("1", "10")).toBeNull();
    expect(limiter.tryAcquire("1", "13")).toBeNull();
    expect(limiter.snapshot()).toEqual({
      active: 4,
      activeMembers: 3,
      memberCounts: [1, 1, 2],
    });
    leases[0]!.release();
    leases[0]!.release();
    expect(limiter.tryAcquire("1", "13")).not.toBeNull();
    for (const lease of leases.slice(1)) lease!.release();
  });
});
