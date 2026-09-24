import { describe, expect, it, vi } from "vitest";

import { createSessionToken } from "@family-album/auth";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import { encodeGalleryCursor, type AlbumService } from "./service.js";

const token = createSessionToken();

function setup() {
  const authService = {
    authenticate: vi.fn(async () => ({
      identity: { userId: "7", sessionId: "8" },
      tokenHash: Buffer.alloc(32),
    })),
  } as unknown as AuthService;
  const row = {
    mediaId: "11",
    albumId: "3",
    timelineKey: new Date("2024-06-01T00:00:00.000Z"),
    timelineBasis: "CAPTURE_LOCAL" as const,
    displayWidth: 320,
    displayHeight: 240,
  };
  const albumService = {
    listTimeline: vi.fn(async () => [row]),
  } as unknown as AlbumService;
  return {
    authService,
    albumService,
    app: createApp({
      authService,
      albumService,
      trustedOrigins: new Set(["https://localhost:3000"]),
    }),
  };
}

describe("family timeline route", () => {
  it("requires a session", async () => {
    const { app, authService } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/families/4/timeline",
    });
    expect(response.statusCode).toBe(401);
    expect(authService.authenticate).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns one jump album and a thumbnail kind without original fields", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/families/4/timeline?limit=1",
      headers: { cookie: `__Host-family_session=${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body.media).toEqual([
      {
        mediaId: "11",
        albumId: "3",
        timelineKey: "2024-06-01T00:00:00.000Z",
        timelineBasis: "CAPTURE_LOCAL",
        displayWidth: 320,
        displayHeight: 240,
        thumbnail: { kind: "thumbnail" },
      },
    ]);
    expect(body.nextCursor).toBe(encodeGalleryCursor(body.media[0]));
    expect(JSON.stringify(body)).not.toMatch(/gps|original|storage/i);
    await app.close();
  });
});
