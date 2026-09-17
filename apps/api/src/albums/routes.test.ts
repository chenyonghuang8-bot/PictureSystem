import { describe, expect, it, vi } from "vitest";

import { createSessionToken } from "@family-album/auth";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import type { AlbumService } from "./service.js";
import { logAlbumEvent } from "./routes.js";

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
  const album = {
    id: "3",
    familyId: "4",
    ownerMemberId: "5",
    name: "Synthetic",
    description: null,
    visibility: "CUSTOM" as const,
    revision: "1",
    createdAt: date,
    updatedAt: date,
    effectivePermissions: {
      canView: true,
      canUpload: true,
      canEdit: true,
      canDelete: true,
      canManageMembers: true,
    },
  };
  const albumService = {
    create: vi.fn(async () => ({ ...album, actorMemberId: "5" })),
    list: vi.fn(async () => [album]),
    get: vi.fn(async () => album),
    update: vi.fn(async () => ({
      ...album,
      revision: "2",
      actorMemberId: "5",
      changedFields: ["name"],
    })),
    remove: vi.fn(async () => ({
      actorMemberId: "5",
      familyId: "4",
      revision: "2",
    })),
    listMembers: vi.fn(async () => []),
    putMember: vi.fn(async () => ({
      actorMemberId: "5",
      familyId: "4",
      revision: "2",
      action: "ADDED" as const,
    })),
    removeMember: vi.fn(async () => ({
      actorMemberId: "5",
      familyId: "4",
      revision: "2",
      changed: true,
    })),
  } as unknown as AlbumService;
  return {
    albumService,
    app: createApp({
      authService,
      albumService,
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

describe("Phase 2A album routes", () => {
  it("logs only whitelisted audit identifiers and the actual actor", () => {
    const info = vi.fn();
    logAlbumEvent(
      { id: "request-1", log: { info } } as never,
      "album_created",
      {
        actorUserId: "1",
        actorMemberId: "5",
        familyId: "4",
        albumId: "3",
        targetMemberId: "6",
        revision: "1",
        description: "MUST_NOT_LOG",
      } as never,
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "1",
        actorMemberId: "5",
        albumId: "3",
        targetMemberId: "6",
      }),
      "security event",
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("MUST_NOT_LOG");
  });

  it("creates an album and rejects mass assignment", async () => {
    const { app, albumService } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/albums",
      headers: headers(),
      payload: { familyId: "4", name: "Synthetic" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(albumService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ visibility: "CUSTOM" }),
    );
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/albums",
      headers: headers(),
      payload: { familyId: "4", name: "X", ownerMemberId: "999" },
    });
    expect(rejected.statusCode).toBe(400);
    await app.close();
  });

  it("parses keyset pagination and returns an exact cursor", async () => {
    const { app, albumService } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/albums?familyId=4&afterId=1&limit=1",
      headers: { cookie: `__Host-family_session=${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().nextAfterId).toBe("3");
    expect(albumService.list).toHaveBeenCalledWith(expect.anything(), {
      familyId: "4",
      afterId: "1",
      limit: 1,
    });
    await app.close();
  });

  it("requires trusted JSON writes and exact revision contracts", async () => {
    const { app, albumService } = setup();
    const noOrigin = await app.inject({
      method: "PATCH",
      url: "/api/v1/albums/3",
      headers: {
        "content-type": "application/json",
        cookie: `__Host-family_session=${token}`,
      },
      payload: { expectedRevision: "1", name: "Updated" },
    });
    expect(noOrigin.statusCode).toBe(403);
    const forbiddenField = await app.inject({
      method: "PATCH",
      url: "/api/v1/albums/3",
      headers: headers(),
      payload: {
        expectedRevision: "1",
        name: "Updated",
        deletedAt: date.toISOString(),
      },
    });
    expect(forbiddenField.statusCode).toBe(400);
    expect(albumService.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("exposes only strict complete ACL mutation contracts", async () => {
    const { app, albumService } = setup();
    const granted = await app.inject({
      method: "PUT",
      url: "/api/v1/albums/3/members/6",
      headers: headers(),
      payload: {
        expectedRevision: "1",
        canView: true,
        canUpload: false,
        canEdit: true,
        canDelete: false,
        canManageMembers: false,
      },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toEqual({ revision: "2" });
    expect(albumService.putMember).toHaveBeenCalled();

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/albums/3/members/6",
      headers: headers(),
      payload: {
        expectedRevision: "1",
        canView: false,
        canUpload: true,
        canEdit: false,
        canDelete: false,
        canManageMembers: false,
        role: "SUPER_ADMIN",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(albumService.putMember).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("lists ACL members and removes them through protected JSON writes", async () => {
    const { app, albumService } = setup();
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/albums/3/members",
      headers: { cookie: `__Host-family_session=${token}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ members: [] });
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/albums/3/members/6",
      headers: headers(),
      payload: { expectedRevision: "1" },
    });
    expect(removed.statusCode).toBe(204);
    expect(albumService.removeMember).toHaveBeenCalledWith(
      expect.anything(),
      "3",
      "6",
      "1",
    );
    await app.close();
  });
});
