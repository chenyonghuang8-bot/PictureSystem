import { describe, expect, it, vi } from "vitest";

import { createSessionToken } from "@family-album/auth";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import type { AlbumService } from "./service.js";

const origin = "https://localhost:3000";
const token = createSessionToken();

function setup() {
  const authService = {
    authenticate: vi.fn(async () => ({
      identity: { userId: "7", sessionId: "8" },
      tokenHash: Buffer.alloc(32),
    })),
  } as unknown as AuthService;
  const albumService = {
    addMedia: vi.fn(async () => ({
      albumId: "3",
      mediaId: "11",
      created: true,
    })),
    removeMedia: vi.fn(async () => ({
      albumId: "3",
      mediaId: "11",
      removed: true,
    })),
  } as unknown as AlbumService;
  return {
    authService,
    albumService,
    app: createApp({
      authService,
      albumService,
      trustedOrigins: new Set([origin]),
    }),
  };
}

describe("album placement routes", () => {
  it("requires a session before adding or removing media", async () => {
    const { app, authService } = setup();
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/albums/3/media",
      headers: { origin, "content-type": "application/json" },
      payload: { mediaId: "11" },
    });
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/albums/3/media/11",
      headers: { origin, "content-type": "application/json" },
      payload: {},
    });
    expect(added.statusCode).toBe(401);
    expect(removed.statusCode).toBe(401);
    expect(authService.authenticate).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns placement results without original fields", async () => {
    const { app } = setup();
    const headers = {
      origin,
      "content-type": "application/json",
      cookie: `__Host-family_session=${token}`,
    };
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/albums/3/media",
      headers,
      payload: { mediaId: "11" },
    });
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/albums/3/media/11",
      headers,
      payload: {},
    });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toEqual({
      albumId: "3",
      mediaId: "11",
      created: true,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({
      albumId: "3",
      mediaId: "11",
      removed: true,
    });
    expect(`${added.body}${removed.body}`).not.toMatch(/gps|original|storage/i);
    await app.close();
  });
});
