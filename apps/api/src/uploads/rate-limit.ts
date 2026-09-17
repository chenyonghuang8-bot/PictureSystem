import { createHmac, randomBytes } from "node:crypto";

import { UploadServiceError } from "./service.js";

type Bucket = { count: number; resetAt: number };

export class UploadRateLimiter {
  #key = randomBytes(32);
  #buckets = new Map<string, Bucket>();

  constructor(private readonly maximumBuckets = 10_000) {}

  create(userId: string, ip: string) {
    this.consume("create-member", userId, 20, 60_000);
    this.consume("create-ip", ip, 60, 60_000);
    this.consume("create-burst", `${userId}\0${ip}`, 8, 10_000);
  }

  access(userId: string, ip: string) {
    this.consume("access-member", userId, 120, 60_000);
    this.consume("access-burst", `${userId}\0${ip}`, 24, 10_000);
  }

  finalize(userId: string, ip: string) {
    this.consume("finalize-member", userId, 20, 60_000);
    this.consume("finalize-ip", ip, 60, 60_000);
    this.consume("finalize-burst", `${userId}\0${ip}`, 8, 10_000);
  }

  private consume(
    scope: string,
    value: string,
    limit: number,
    windowMs: number,
  ) {
    const now = Date.now();
    if (this.#buckets.size >= this.maximumBuckets) this.sweep(now);
    const key = createHmac("sha256", this.#key)
      .update(scope)
      .update("\0")
      .update(value)
      .digest("base64url");
    const current = this.#buckets.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && this.#buckets.size >= this.maximumBuckets) {
        throw new UploadServiceError(
          429,
          "RATE_LIMITED",
          undefined,
          undefined,
          1,
        );
      }
      this.#buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    if (current.count >= limit) {
      throw new UploadServiceError(
        429,
        "RATE_LIMITED",
        undefined,
        undefined,
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
