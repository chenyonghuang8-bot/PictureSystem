import { describe, it, expect, vi } from "vitest";
import { createSessionToken } from "@family-album/auth";
import { memoriesCalendar, type MemoriesItem } from "@family-album/contracts";
import { createApp } from "../app.js";
import { PublicAuthError, type AuthService } from "../auth/service.js";
import type { AlbumService } from "./service.js";
const token = createSessionToken();
function setup() {
  const context = memoriesCalendar(new Date("2026-10-05T04:00:00Z"));
  const media: MemoriesItem = {
    mediaId: "11",
    albumId: "3",
    timelineKey: "2025-10-05T12:00:00.000Z",
    timelineBasis: "CAPTURE_LOCAL",
    displayWidth: 1,
    displayHeight: 1,
    isFavorite: false,
    isFamilyFeatured: false,
    thumbnail: { kind: "thumbnail" },
    timelineDate: "2025-10-05",
    dateBasis: "CAPTURE_LOCAL",
  };
  const auth = {
    authenticate: vi.fn(async () => ({
      identity: { userId: "7", sessionId: "8" },
      tokenHash: Buffer.alloc(32),
    })),
  };
  const albums = {
    memories: vi.fn(async () => ({
      context,
      kind: "ON_THIS_DAY",
      media: [media],
      nextCursor: null,
    })),
    memoriesPreview: vi.fn(async () => ({
      context,
      cards: [
        { kind: "ON_THIS_DAY", media: [media], hasMore: false },
        { kind: "LAST_YEAR_WEEK", media: [], hasMore: false },
      ],
    })),
  };
  const app = createApp({
    authService: auth as unknown as AuthService,
    albumService: albums as unknown as AlbumService,
    trustedOrigins: new Set(),
  });
  return { app, auth, albums };
}
describe("Memories narrow private routes", () => {
  it("authenticates page/combined preview and returns only approved DTO fields with private/no-store", async () => {
    const { app, albums } = setup();
    try {
      for (const suffix of ["", "/preview"]) {
        const result = await app.inject({
          method: "GET",
          url: "/api/v1/families/4/memories" + suffix,
          headers: { cookie: `__Host-family_session=${token}` },
        });
        expect(result.statusCode).toBe(200);
        expect(result.headers["cache-control"]).toBe("private, no-store");
        expect(result.body).not.toMatch(
          /gps|sha256|storage|filename|capturedAtUtc/i,
        );
      }
      expect(albums.memoriesPreview).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it("all strict-query, missing/mixed-credential and malformed failures remain private/no-store", async () => {
    const { app, albums } = setup();
    try {
      for (const query of [
        "date=2020-01-01",
        "anchorDate=2020-01-01",
        "zone=UTC",
        "kind=OTHER",
        "limit=101",
        "limit=1e1",
        "kind=ON_THIS_DAY&kind=LAST_YEAR_WEEK",
        "cursor=%FF",
      ]) {
        const r = await app.inject({
          method: "GET",
          url: "/api/v1/families/4/memories?" + query,
          headers: { cookie: `__Host-family_session=${token}` },
        });
        expect(r.statusCode).toBe(400);
        expect(r.headers["cache-control"]).toBe("private, no-store");
      }
      const missing = await app.inject({
        method: "GET",
        url: "/api/v1/families/4/memories",
      });
      expect(missing.statusCode).toBe(401);
      expect(missing.headers["cache-control"]).toBe("private, no-store");
      const mixed = await app.inject({
        method: "GET",
        url: "/api/v1/families/4/memories",
        headers: {
          cookie: `__Host-family_session=${token}`,
          authorization: `Bearer ${token}`,
        },
      });
      expect(mixed.statusCode).toBe(401);
      expect(mixed.headers["cache-control"]).toBe("private, no-store");
      const extra = await app.inject({
        method: "GET",
        url: "/api/v1/families/4/memories/preview?limit=6",
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(extra.statusCode).toBe(400);
      expect(albums.memories).not.toHaveBeenCalled();
      expect(albums.memoriesPreview).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("uses narrow fixed expired-anchor 409 envelope and auth remains authoritative", async () => {
    const { app, albums, auth } = setup();
    try {
      albums.memories.mockRejectedValue(
        new PublicAuthError(409, "MEMORIES_ANCHOR_EXPIRED"),
      );
      const r = await app.inject({
        method: "GET",
        url: "/api/v1/families/4/memories",
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({
        code: "MEMORIES_ANCHOR_EXPIRED",
        message: "The memories date has expired. Please refresh.",
      });
      auth.authenticate.mockRejectedValue(
        new PublicAuthError(401, "UNAUTHENTICATED"),
      );
      const denied = await app.inject({
        method: "GET",
        url: "/api/v1/families/4/memories",
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(denied.statusCode).toBe(401);
      expect(albums.memories).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
