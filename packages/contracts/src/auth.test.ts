import { describe, expect, it } from "vitest";

import {
  loginRequestSchema,
  sessionParamsSchema,
  sessionsResponseSchema,
} from "./auth.js";

describe("Phase 1B auth contracts", () => {
  it("rejects unknown credential fields", () => {
    expect(() =>
      loginRequestSchema.parse({
        username: "Dad",
        password: "password",
        token: "no",
      }),
    ).toThrow();
  });

  it("keeps BIGINT identifiers as exact decimal strings", () => {
    expect(
      sessionParamsSchema.parse({ sessionId: "18446744073709551615" }),
    ).toEqual({ sessionId: "18446744073709551615" });
    expect(() =>
      sessionParamsSchema.parse({ sessionId: "18446744073709551616" }),
    ).toThrow();
  });

  it("does not allow token fields in session responses", () => {
    expect(() =>
      sessionsResponseSchema.parse({
        sessions: [
          {
            id: "1",
            clientType: "WEB",
            deviceLabel: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            authenticatedAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-31T00:00:00.000Z",
            current: true,
            tokenHash: "secret",
          },
        ],
      }),
    ).toThrow();
  });
});
