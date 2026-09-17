import { describe, expect, it, vi } from "vitest";

import { createSessionToken } from "@family-album/auth";

import { createApp } from "../app.js";
import { PublicAuthError, type AuthService } from "./service.js";

const origin = "https://localhost:3000";
const token = createSessionToken();
const serverNow = new Date("2026-01-01T00:00:00.000Z");
const identity = {
  sessionId: "9007199254740993",
  userId: "9007199254740995",
  username: "Dad",
  displayName: "Dad",
  passwordHash: "phc",
  clientType: "WEB" as const,
  authenticatedAt: serverNow,
  createdAt: serverNow,
  lastSeenAt: serverNow,
  expiresAt: new Date("2026-01-31T00:00:00.000Z"),
  revokedAt: null,
  disabledAt: null,
  serverNow,
};

function setup(trustedProxies: readonly string[] = []) {
  const context = { identity, tokenHash: Buffer.alloc(32) };
  const service = {
    login: vi.fn(async () => ({
      token,
      expiresAt: identity.expiresAt,
      serverNow,
    })),
    authenticate: vi.fn(async () => context),
    me: vi.fn(async () => ({ memberships: [] })),
    logout: vi.fn(async () => ({ clearCookie: true })),
    logoutAll: vi.fn(async () => undefined),
    reauthenticate: vi.fn(async () => ({
      token,
      expiresAt: identity.expiresAt,
      serverNow,
    })),
    changePassword: vi.fn(async () => ({
      token,
      expiresAt: identity.expiresAt,
      serverNow,
    })),
    sessions: vi.fn(async () => [
      {
        id: identity.sessionId,
        clientType: "WEB" as const,
        deviceLabel: null,
        createdAt: serverNow,
        authenticatedAt: serverNow,
        lastSeenAt: serverNow,
        expiresAt: identity.expiresAt,
      },
    ]),
    revokeSession: vi.fn(async () => ({ revokedCurrent: true })),
  } as unknown as AuthService;
  return {
    service,
    app: createApp({
      authService: service,
      trustedOrigins: new Set([origin]),
      trustedProxies,
    }),
  };
}

describe("Phase 1B auth routes", () => {
  it("sets a secure host-only Cookie on login and returns no token body", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin, "content-type": "application/json" },
      payload: { username: "Dad", password: "password1" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(response.headers["set-cookie"]).not.toContain("Domain=");
    await app.close();
  });

  it("replaces an existing browser Cookie with a fresh login session", async () => {
    const { app, service } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: `__Host-family_session=${createSessionToken()}`,
      },
      payload: { username: "Dad", password: "password1" },
    });
    expect(response.statusCode).toBe(204);
    expect(service.login).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it.each([
    ["missing", undefined],
    ["null", "null"],
    ["untrusted", "https://evil.example"],
  ])("rejects %s Origin before login", async (_label, suppliedOrigin) => {
    const { app, service } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: {
        ...(suppliedOrigin ? { origin: suppliedOrigin } : {}),
        "content-type": "application/json",
      },
      payload: { username: "Dad", password: "password1" },
    });
    expect(response.statusCode).toBe(403);
    expect(service.login).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a non-JSON write", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin, "content-type": "text/plain" },
      payload: "Dad",
    });
    expect(response.statusCode).toBe(415);
    await app.close();
  });

  it("wraps malformed JSON in the stable auth error contract", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin, "content-type": "application/json" },
      payload: "{",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "The request is invalid.",
      requestId: expect.any(String),
    });
    await app.close();
  });

  it("rejects Cookie and Authorization used together", async () => {
    const { app, service } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie: `__Host-family_session=${token}`,
        authorization: `Bearer ${token}`,
      },
    });
    expect(response.statusCode).toBe(401);
    expect(service.authenticate).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns only the session DTO whitelist with exact string IDs", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: { cookie: `__Host-family_session=${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().sessions[0]).toEqual(
      expect.objectContaining({ id: "9007199254740993", current: true }),
    );
    expect(response.body).not.toContain("token");
    await app.close();
  });

  it("implements all remaining state-changing endpoints behind Origin", async () => {
    const { app, service } = setup();
    const cookie = `__Host-family_session=${token}`;
    const requests = [
      ["POST", "/api/v1/auth/logout", {}],
      ["POST", "/api/v1/auth/logout-all", {}],
      ["POST", "/api/v1/auth/reauth", { password: "password1" }],
      [
        "POST",
        "/api/v1/auth/password",
        { currentPassword: "password1", newPassword: "password2" },
      ],
      ["DELETE", "/api/v1/auth/sessions/9007199254740993", {}],
    ] as const;
    for (const [method, url, payload] of requests) {
      const response = await app.inject({
        method,
        url,
        headers: { origin, "content-type": "application/json", cookie },
        payload,
      });
      expect(response.statusCode, url).toBe(204);
    }
    expect(service.logout).toHaveBeenCalledTimes(1);
    expect(service.logoutAll).toHaveBeenCalledTimes(1);
    expect(service.reauthenticate).toHaveBeenCalledTimes(1);
    expect(service.changePassword).toHaveBeenCalledTimes(1);
    expect(service.revokeSession).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not clear a replacement Cookie for a late old-token logout", async () => {
    const { app, service } = setup();
    vi.mocked(service.logout).mockResolvedValue({ clearCookie: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: `__Host-family_session=${token}`,
      },
      payload: {},
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("does not send a success Cookie when commit outcome is unknown", async () => {
    const { app, service } = setup();
    vi.mocked(service.reauthenticate).mockRejectedValue(
      new PublicAuthError(
        503,
        "SERVICE_UNAVAILABLE",
        undefined,
        "COMMIT_OUTCOME_UNKNOWN",
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reauth",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: `__Host-family_session=${token}`,
      },
      payload: { password: "password1" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await app.close();
  });

  it("ignores forwarded IP headers when proxy trust is disabled", async () => {
    const { app, service } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: {
        origin,
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.10",
      },
      payload: { username: "Dad", password: "password1" },
    });
    expect(response.statusCode).toBe(204);
    expect(service.login).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "127.0.0.1" }),
    );
    await app.close();
  });

  it("ignores XFF from a peer outside the configured proxy allowlist", async () => {
    const { app, service } = setup(["10.0.0.0/8"]);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: {
        origin,
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.10",
      },
      payload: { username: "Dad", password: "password1" },
    });
    expect(service.login).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "127.0.0.1" }),
    );
    await app.close();
  });

  it("uses the nearest untrusted client address behind an allowed proxy", async () => {
    const { app, service } = setup(["127.0.0.1"]);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: {
        origin,
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.10, 203.0.113.66",
      },
      payload: { username: "Dad", password: "password1" },
    });
    expect(service.login).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "203.0.113.66" }),
    );
    await app.close();
  });
});
