import { describe, expect, it } from "vitest";

import { AuthRateLimiter, AuthRateLimitError } from "./rate-limit.js";

describe("AuthRateLimiter", () => {
  it("limits the username and combination with concurrent reservations", () => {
    const limiter = new AuthRateLimiter(() => 0);
    const attempts = Array.from({ length: 5 }, () =>
      limiter.reserveCredentialAttempt("dad", "127.0.0.1"),
    );
    expect(() => limiter.reserveCredentialAttempt("dad", "127.0.0.1")).toThrow(
      AuthRateLimitError,
    );
    attempts.forEach((attempt) => attempt.finish(false));
  });

  it("limits IP attempts and recovers after the window", () => {
    let now = 0;
    const limiter = new AuthRateLimiter(() => now);
    for (let index = 0; index < 10; index += 1) {
      limiter.recordIpAttempt("127.0.0.1");
    }
    expect(() => limiter.recordIpAttempt("127.0.0.1")).toThrow(
      AuthRateLimitError,
    );
    now = 60_001;
    expect(() => limiter.recordIpAttempt("127.0.0.1")).not.toThrow();
  });

  it("a success clears only the combination failure bucket", () => {
    const limiter = new AuthRateLimiter(() => 0);
    for (let index = 0; index < 4; index += 1) {
      limiter.reserveCredentialAttempt("dad", "one").finish(false);
    }
    limiter.reserveCredentialAttempt("dad", "one").finish(true);
    expect(() => limiter.reserveCredentialAttempt("dad", "one")).not.toThrow();
  });

  it("enforces username failures across different IPs", () => {
    const limiter = new AuthRateLimiter(() => 0);
    for (let index = 0; index < 10; index += 1) {
      limiter.reserveCredentialAttempt("dad", `192.0.2.${index}`).finish(false);
    }
    expect(() => limiter.reserveCredentialAttempt("dad", "192.0.2.20")).toThrow(
      AuthRateLimitError,
    );
  });

  it("enforces the 15-minute IP budget and recovers", () => {
    let now = 0;
    const limiter = new AuthRateLimiter(() => now);
    for (let batch = 0; batch < 5; batch += 1) {
      for (let index = 0; index < 10; index += 1) {
        limiter.recordIpAttempt("198.51.100.1");
      }
      now += 60_001;
    }
    expect(() => limiter.recordIpAttempt("198.51.100.1")).toThrow(
      AuthRateLimitError,
    );
    now = 15 * 60_000 + 1;
    expect(() => limiter.recordIpAttempt("198.51.100.1")).not.toThrow();
  });

  it("recovers failure budgets after 15 minutes", () => {
    let now = 0;
    const limiter = new AuthRateLimiter(() => now);
    for (let index = 0; index < 5; index += 1) {
      limiter.reserveCredentialAttempt("dad", "203.0.113.1").finish(false);
    }
    expect(() =>
      limiter.reserveCredentialAttempt("dad", "203.0.113.1"),
    ).toThrow(AuthRateLimitError);
    now = 15 * 60_000 + 1;
    expect(() =>
      limiter.reserveCredentialAttempt("dad", "203.0.113.1"),
    ).not.toThrow();
  });
});
