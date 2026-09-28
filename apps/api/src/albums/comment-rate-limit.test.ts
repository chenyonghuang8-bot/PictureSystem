import { describe, expect, it } from "vitest";

import { PublicAuthError } from "../auth/service.js";
import { MediaCommentRateLimiter } from "./comment-rate-limit.js";

describe("MediaCommentRateLimiter", () => {
  it("allows 20 comments per actor per minute", () => {
    const limiter = new MediaCommentRateLimiter(10, () => 0);
    for (let index = 0; index < 20; index += 1) limiter.consume("7");
    expect(() => limiter.consume("7")).toThrow(PublicAuthError);
    expect(() => limiter.consume("8")).not.toThrow();
  });

  it("expires buckets and remains bounded", () => {
    let now = 0;
    const limiter = new MediaCommentRateLimiter(1, () => now);
    limiter.consume("7");
    expect(() => limiter.consume("8")).toThrow(PublicAuthError);
    now = 60_000;
    expect(() => limiter.consume("8")).not.toThrow();
  });
});
