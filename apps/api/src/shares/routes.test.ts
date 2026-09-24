import { describe, expect, it, vi } from "vitest";

import { createSessionToken, createShareToken } from "@family-album/auth";

import { createApp } from "../app.js";
import { PublicAuthError, type AuthService } from "../auth/service.js";
import type { ShareService } from "./service.js";

const origin = "https://localhost:3000";
const session = createSessionToken();
const createdAt = new Date("2026-01-01T00:00:00.000Z");
const expiresAt = new Date("2026-01-08T00:00:00.000Z");
const revokedAt = new Date("2026-01-02T00:00:00.000Z");

function setup() {
  const authService = {
    authenticate: vi.fn(async () => ({
      identity: { userId: "7", sessionId: "8" },
      tokenHash: Buffer.alloc(32),
    })),
  } as unknown as AuthService;
  const shareToken = createShareToken();
  const shareService = {
    createShare: vi.fn(async () => ({
      shareId: "15",
      albumId: "9",
      token: shareToken,
      expiresAt,
    })),
    listShares: vi.fn(async () => [
      {
        shareId: "15",
        familyId: "2",
        albumId: "9",
        createdAt,
        expiresAt,
        revokedAt: null,
        token: shareToken,
        token_hash: "not-returned",
      },
    ]),
    revokeShare: vi.fn(async () => ({
      shareId: "15",
      albumId: "9",
      revokedAt,
    })),
  } as unknown as ShareService;
  return {
    authService,
    shareService,
    shareToken,
    app: createApp({
      authService,
      shareService,
      trustedOrigins: new Set([origin]),
    }),
  };
}

function headers() {
  return {
    origin,
    "content-type": "application/json",
    cookie: `__Host-family_session=${session}`,
  };
}

describe("share management routes", () => {
  it("creates a share and returns the raw token once", async () => {
    const { app, shareService, shareToken } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/albums/9/share",
      headers: headers(),
      payload: { expiresAt: expiresAt.toISOString() },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      shareId: "15",
      token: shareToken,
      expiresAt: expiresAt.toISOString(),
    });
    expect(shareService.createShare).toHaveBeenCalledTimes(1);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/shares?familyId=2",
      headers: headers(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    const body = listed.json();
    expect(body.shares).toEqual([
      {
        shareId: "15",
        albumId: "9",
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        revokedAt: null,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(shareToken);
    expect(JSON.stringify(body)).not.toContain("token");
    expect(shareService.listShares).toHaveBeenCalledWith(expect.anything(), {
      familyId: "2",
      limit: 20,
    });
    await app.close();
  });

  it("rejects create and revoke without a session", async () => {
    const { app, authService, shareService } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/albums/9/share",
      headers: { origin, "content-type": "application/json" },
      payload: { expiresAt: expiresAt.toISOString() },
    });
    const revoked = await app.inject({
      method: "DELETE",
      url: "/api/v1/shares/15",
      headers: { origin, "content-type": "application/json" },
      payload: {},
    });
    expect(created.statusCode).toBe(401);
    expect(revoked.statusCode).toBe(401);
    expect(created.json().code).toBe("UNAUTHENTICATED");
    expect(authService.authenticate).not.toHaveBeenCalled();
    expect(shareService.createShare).not.toHaveBeenCalled();
    expect(shareService.revokeShare).not.toHaveBeenCalled();
    await app.close();
  });

  it("hides a custom album the caller cannot see", async () => {
    const { app, shareService } = setup();
    shareService.createShare = vi.fn(async () => {
      throw new PublicAuthError(404, "NOT_FOUND");
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/albums/9/share",
      headers: headers(),
      payload: { expiresAt: expiresAt.toISOString() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("NOT_FOUND");
    expect(response.json().message).toBe(
      "The requested resource was not found.",
    );
    expect(JSON.stringify(response.json())).not.toMatch(
      /token|expired|revoked|custom/i,
    );
    await app.close();
  });

  it("returns forbidden when the caller can view but not manage", async () => {
    const { app, shareService } = setup();
    shareService.createShare = vi.fn(async () => {
      throw new PublicAuthError(403, "FORBIDDEN");
    });
    shareService.revokeShare = vi.fn(async () => {
      throw new PublicAuthError(403, "FORBIDDEN");
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/albums/9/share",
      headers: headers(),
      payload: { expiresAt: expiresAt.toISOString() },
    });
    const revoked = await app.inject({
      method: "DELETE",
      url: "/api/v1/shares/15",
      headers: headers(),
      payload: {},
    });
    expect(created.statusCode).toBe(403);
    expect(revoked.statusCode).toBe(403);
    expect(created.json().code).toBe("FORBIDDEN");
    expect(revoked.json().code).toBe("FORBIDDEN");
    await app.close();
  });

  it("revokes once and returns the same state for a duplicate revoke", async () => {
    const { app, shareService } = setup();
    const first = await app.inject({
      method: "DELETE",
      url: "/api/v1/shares/15",
      headers: headers(),
      payload: {},
    });
    const second = await app.inject({
      method: "DELETE",
      url: "/api/v1/shares/15",
      headers: headers(),
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual({
      shareId: "15",
      albumId: "9",
      revokedAt: revokedAt.toISOString(),
    });
    expect(second.json()).toEqual(first.json());
    expect(JSON.stringify(first.json())).not.toContain("token");
    expect(shareService.revokeShare).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("returns not found for an unknown share", async () => {
    const { app, shareService } = setup();
    shareService.revokeShare = vi.fn(async () => {
      throw new PublicAuthError(404, "NOT_FOUND");
    });
    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/shares/15",
      headers: headers(),
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("NOT_FOUND");
    expect(JSON.stringify(response.json())).not.toMatch(/token|exist/i);
    await app.close();
  });
});
