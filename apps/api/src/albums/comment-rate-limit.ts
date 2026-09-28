import { createHmac, randomBytes } from "node:crypto";

import { PublicAuthError } from "../auth/service.js";

type Bucket = { count: number; resetAt: number };

export class MediaCommentRateLimiter {
  #key = randomBytes(32);
  #buckets = new Map<string, Bucket>();

  constructor(
    private readonly maximumBuckets = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  consume(memberId: string) {
    const now = this.now();
    if (this.#buckets.size >= this.maximumBuckets) this.sweep(now);
    const key = createHmac("sha256", this.#key)
      .update("media-comment-member\0")
      .update(memberId)
      .digest("base64url");
    const current = this.#buckets.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && this.#buckets.size >= this.maximumBuckets) {
        throw new PublicAuthError(429, "RATE_LIMITED", 1);
      }
      this.#buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    if (current.count >= 20) {
      throw new PublicAuthError(
        429,
        "RATE_LIMITED",
        Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
      );
    }
    current.count += 1;
  }

  private sweep(now: number) {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now) this.#buckets.delete(key);
    }
  }
}
