import { createHmac, randomBytes } from "node:crypto";

type Bucket = { startedAt: number; count: number };
type FailureBucket = Bucket & { reserved: number };

export class AuthRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Authentication rate limit exceeded.");
    this.name = "AuthRateLimitError";
  }
}

export class AuthRateLimitCapacityError extends Error {
  constructor() {
    super("Authentication rate limiter capacity is unavailable.");
    this.name = "AuthRateLimitCapacityError";
  }
}

export type CredentialAttempt = { finish(success: boolean): void };

export class AuthRateLimiter {
  private readonly processKey = randomBytes(32);
  private readonly attempts = new Map<string, Bucket>();
  private readonly failures = new Map<string, FailureBucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxBuckets = 10_000,
  ) {}

  recordIpAttempt(ip: string) {
    this.incrementAttempt(`ip15:${this.key(ip)}`, 50, 15 * 60_000);
    this.incrementAttempt(`ip1:${this.key(ip)}`, 10, 60_000);
  }

  reserveCredentialAttempt(
    normalizedUsername: string,
    ip: string,
  ): CredentialAttempt {
    const usernameKey = `user:${this.key(normalizedUsername)}`;
    const comboKey = `combo:${this.key(`${normalizedUsername}\0${ip}`)}`;
    const username = this.failureBucket(usernameKey, 15 * 60_000);
    const combo = this.failureBucket(comboKey, 15 * 60_000);

    this.assertAvailable(username, 10, 15 * 60_000);
    this.assertAvailable(combo, 5, 15 * 60_000);
    username.reserved += 1;
    combo.reserved += 1;

    let finished = false;
    return {
      finish: (success) => {
        if (finished) return;
        finished = true;
        username.reserved -= 1;
        combo.reserved -= 1;
        if (success) combo.count = 0;
        else {
          username.count += 1;
          combo.count += 1;
        }
      },
    };
  }

  private key(value: string) {
    return createHmac("sha256", this.processKey).update(value).digest("hex");
  }

  private incrementAttempt(key: string, limit: number, windowMs: number) {
    const bucket = this.attemptBucket(key, windowMs);
    if (bucket.count >= limit) this.limited(bucket.startedAt, windowMs);
    bucket.count += 1;
  }

  private attemptBucket(key: string, windowMs: number): Bucket {
    const existing = this.attempts.get(key);
    const now = this.now();
    if (existing && now - existing.startedAt < windowMs) return existing;
    if (!existing) this.ensureCapacity();
    const bucket = { startedAt: now, count: 0 };
    this.attempts.set(key, bucket);
    return bucket;
  }

  private failureBucket(key: string, windowMs: number): FailureBucket {
    const existing = this.failures.get(key);
    const now = this.now();
    if (existing && now - existing.startedAt < windowMs) return existing;
    if (!existing) this.ensureCapacity();
    const bucket = { startedAt: now, count: 0, reserved: 0 };
    this.failures.set(key, bucket);
    return bucket;
  }

  private assertAvailable(
    bucket: FailureBucket,
    limit: number,
    windowMs: number,
  ) {
    if (bucket.count + bucket.reserved >= limit) {
      this.limited(bucket.startedAt, windowMs);
    }
  }

  private limited(startedAt: number, windowMs: number): never {
    const remainingMs = Math.max(1, startedAt + windowMs - this.now());
    throw new AuthRateLimitError(Math.ceil(remainingMs / 1_000));
  }

  private ensureCapacity() {
    this.cleanup();
    if (this.attempts.size + this.failures.size >= this.maxBuckets) {
      throw new AuthRateLimitCapacityError();
    }
  }

  private cleanup() {
    const now = this.now();
    for (const [key, value] of this.attempts) {
      const windowMs = key.startsWith("ip1:") ? 60_000 : 15 * 60_000;
      if (now - value.startedAt >= windowMs) this.attempts.delete(key);
    }
    for (const [key, value] of this.failures) {
      if (value.reserved === 0 && now - value.startedAt >= 15 * 60_000) {
        this.failures.delete(key);
      }
    }
  }
}
