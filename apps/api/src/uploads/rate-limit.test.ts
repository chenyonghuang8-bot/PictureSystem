import { afterEach, describe, expect, it, vi } from "vitest";

import { UploadRateLimiter } from "./rate-limit.js";

describe("UploadRateLimiter", () => {
  afterEach(() => vi.useRealTimers());

  it("enforces the combined create burst without storing raw identities", () => {
    const limiter = new UploadRateLimiter();
    for (let index = 0; index < 8; index += 1)
      limiter.create("member", "127.0.0.1");
    try {
      limiter.create("member", "127.0.0.1");
      throw new Error("expected limiter rejection");
    } catch (error) {
      expect(error).toMatchObject({
        code: "RATE_LIMITED",
        retryAfterSeconds: 10,
      });
    }
  });

  it("resets bounded windows", () => {
    vi.useFakeTimers();
    const limiter = new UploadRateLimiter();
    for (let index = 0; index < 24; index += 1)
      limiter.access("member", "127.0.0.1");
    expect(() => limiter.access("member", "127.0.0.1")).toThrow();
    vi.advanceTimersByTime(10_001);
    expect(() => limiter.access("member", "127.0.0.1")).not.toThrow();
  });

  it("fails closed when the bounded bucket table cannot accept a new key", () => {
    const limiter = new UploadRateLimiter(2);
    limiter.access("first", "127.0.0.1");
    expect(() => limiter.access("second", "127.0.0.2")).toThrowError(
      expect.objectContaining({ code: "RATE_LIMITED" }),
    );
  });
});
