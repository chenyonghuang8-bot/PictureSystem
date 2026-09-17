import { describe, expect, it, vi } from "vitest";

import { createSessionToken } from "@family-album/auth";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import type { Phase1CService } from "./service.js";

const origin = "https://localhost:3000";
const token = createSessionToken();
const date = new Date("2026-01-01T00:00:00.000Z");

function setup() {
  const authService = {
    authenticate: vi.fn(async () => ({
      identity: { userId: "1", sessionId: "2" },
      tokenHash: Buffer.alloc(32),
    })),
  } as unknown as AuthService;
  const phase1cService = {
    createInvitation: vi.fn(async () => ({
      id: "3",
      role: "MEMBER" as const,
      expiresAt: date,
      invitationUrl: `https://localhost:3000/join#token=${createSessionToken()}`,
      actorMemberId: "4",
    })),
    listInvitations: vi.fn(async () => []),
    revokeInvitation: vi.fn(async () => ({ actorMemberId: "4" })),
    previewInvitation: vi.fn(async () => ({
      familyName: "Family",
      role: "MEMBER" as const,
      expiresAt: date,
    })),
    consumeInvitation: vi.fn(async () => ({
      familyId: "1",
      userId: "5",
      memberId: "6",
    })),
    listMembers: vi.fn(async () => []),
    updateMember: vi.fn(async () => ({
      actorMemberId: "4",
      member: {
        id: "6",
        userId: "5",
        username: "member",
        displayName: null,
        role: "MEMBER" as const,
        disabledAt: null,
      },
    })),
  } as unknown as Phase1CService;
  return {
    authService,
    phase1cService,
    app: createApp({
      authService,
      phase1cService,
      trustedOrigins: new Set([origin]),
    }),
  };
}

function headers() {
  return {
    origin,
    "content-type": "application/json",
    cookie: `__Host-family_session=${token}`,
  };
}

describe("Phase 1C routes", () => {
  it("creates an invitation with no-store/no-referrer and strict input", async () => {
    const { app, phase1cService } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/1/invitations",
      headers: headers(),
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(phase1cService.createInvitation).toHaveBeenCalledWith(
      expect.anything(),
      { familyId: "1", role: "MEMBER", expiresInHours: 48 },
    );
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/families/1/invitations",
      headers: headers(),
      payload: { role: "SUPER_ADMIN" },
    });
    expect(rejected.statusCode).toBe(400);
    await app.close();
  });

  it("rejects mass assignment before consume reaches the service", async () => {
    const { app, phase1cService } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/consume",
      headers: headers(),
      payload: {
        token: createSessionToken(),
        username: "newmember",
        password: "password1",
        familyId: "999",
        role: "SUPER_ADMIN",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(phase1cService.consumeInvitation).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not issue a session Cookie after consuming an invitation", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/consume",
      headers: { origin, "content-type": "application/json" },
      payload: {
        token: createSessionToken(),
        username: "newmember",
        password: "password1",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).toBe("");
    await app.close();
  });

  it("requires trusted Origin and a Cookie session for management writes", async () => {
    const { app, phase1cService } = setup();
    const noOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/families/1/invitations/2/revoke",
      headers: {
        "content-type": "application/json",
        cookie: `__Host-family_session=${token}`,
      },
      payload: {},
    });
    expect(noOrigin.statusCode).toBe(403);
    const bearer = await app.inject({
      method: "POST",
      url: "/api/v1/families/1/invitations/2/revoke",
      headers: {
        ...headers(),
        authorization: `Bearer ${token}`,
      },
      payload: {},
    });
    expect(bearer.statusCode).toBe(401);
    expect(phase1cService.revokeInvitation).not.toHaveBeenCalled();
    await app.close();
  });

  it("exposes no bootstrap HTTP route", async () => {
    const { app } = setup();
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/bootstrap" }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/v1/families/1/members/2",
          headers: { cookie: `__Host-family_session=${token}` },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });
});
