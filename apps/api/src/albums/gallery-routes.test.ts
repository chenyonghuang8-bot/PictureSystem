import { describe, expect, it, vi } from "vitest";

import { createSessionToken } from "@family-album/auth";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import { encodeGalleryCursor, type AlbumService } from "./service.js";

const origin = "https://localhost:3000";
const token = createSessionToken();

function setup(media = mediaRow()) {
  const authService = {
    authenticate: vi.fn(async () => ({
      identity: { userId: "7", sessionId: "8" },
      tokenHash: Buffer.alloc(32),
    })),
  } as unknown as AuthService;
  const albumService = {
    list: vi.fn(async () => []),
    listMedia: vi.fn(async () => [media]),
    getMedia: vi.fn(async () => media),
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

function mediaRow() {
  return {
    mediaId: "11",
    timelineKey: new Date("2024-06-01T00:00:00.000Z"),
    timelineBasis: "UPLOAD_UTC" as const,
    displayWidth: 100,
    displayHeight: 80,
    orientation: 6,
    capturedLocalAt: null,
    cameraMake: "Synthetic",
    cameraModel: "Camera",
  };
}

function cookie() {
  return { cookie: `__Host-family_session=${token}` };
}

describe("gallery media routes", () => {
  it("requires a session before listing album media", async () => {
    const { app, authService } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/albums/3/media",
    });
    expect(response.statusCode).toBe(401);
    expect(authService.authenticate).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns a thumbnail cursor page without original fields", async () => {
    const { app, albumService } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/albums/3/media?limit=1",
      headers: cookie(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body.media).toEqual([
      {
        mediaId: "11",
        timelineKey: "2024-06-01T00:00:00.000Z",
        timelineBasis: "UPLOAD_UTC",
        displayWidth: 100,
        displayHeight: 80,
        thumbnail: { kind: "thumbnail" },
      },
    ]);
    expect(body.nextCursor).toBe(encodeGalleryCursor(body.media[0]));
    expect(JSON.stringify(body)).not.toContain("gps");
    expect(albumService.listMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ userId: "7" }),
      }),
      "3",
      { limit: 1 },
    );
    await app.close();
  });

  it("rejects a malformed browse cursor", async () => {
    const { app, albumService } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/albums/3/media?cursor=not-a-cursor",
      headers: cookie(),
    });
    expect(response.statusCode).toBe(400);
    expect(albumService.listMedia).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns album-scoped detail with preview and without coordinates", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/albums/3/media/11",
      headers: cookie(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mediaId: "11",
      orientation: 6,
      capturedLocalAt: null,
      cameraMake: "Synthetic",
      cameraModel: "Camera",
      preview: { kind: "preview" },
      thumbnail: { kind: "thumbnail" },
    });
    expect(response.json()).not.toHaveProperty("gpsLatitude");
    await app.close();
  });
});
