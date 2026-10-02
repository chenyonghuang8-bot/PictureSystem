import { describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@family-album/auth";
import { familySearchQuerySchema } from "@family-album/contracts";
import { AlbumRepositoryError } from "@family-album/db";
import { createApp } from "../app.js";
import type { Phase1CService } from "../phase1c/service.js";
import type { AuthService } from "../auth/service.js";
import {
  AlbumService,
  decodeFamilySearchCursor,
  encodeFamilySearchCursor,
  familySearchScope,
  type AlbumRepository,
} from "./service.js";
const token = createSessionToken();
const context = {
  identity: { userId: "7", sessionId: "8" },
  tokenHash: Buffer.alloc(32),
};
const row = {
  mediaId: "9007199254740993",
  albumId: "3",
  timelineKey: new Date("2024-02-29T23:59:59.999Z"),
  timelineBasis: "CAPTURE_LOCAL" as const,
  displayWidth: 320,
  displayHeight: 240,
  isFavorite: true,
  isFamilyFeatured: false,
};
function setup(rows = [row]) {
  const repository = {
    searchFamilyMedia: vi.fn(async () => rows),
  } as unknown as AlbumRepository;
  const service = new AlbumService(repository);
  const auth = {
    authenticate: vi.fn(async () => context),
  } as unknown as AuthService;
  return {
    repository,
    service,
    app: createApp({
      authService: auth,
      albumService: service,
      // Include the legacy family-wide onSend hook present in the real app.
      phase1cService: {} as Phase1CService,
      trustedOrigins: new Set(["https://localhost:3000"]),
    }),
  };
}
describe("private family search", () => {
  it.each([
    "",
    "?limit=01",
    "?fromDate=2023-02-29",
    "?albumId=1&albumId=2",
    "?favoritesOnly=true&favoritesOnly=true",
    "?filename=private",
    "?limit=1&limit=2",
  ])(
    "guards malformed/unauthenticated responses and no-store: %s",
    async (query) => {
      const { app, repository } = setup();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/families/4/search${query}`,
          ...(query
            ? { headers: { cookie: `__Host-family_session=${token}` } }
            : {}),
        });
        expect(response.statusCode).toBe(query ? 400 : 401);
        expect(response.headers["cache-control"]).toBe("private, no-store");
        expect(repository.searchFamilyMedia).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it("binds UTC encoded calendar bounds, actor and lookahead without metadata expansion", async () => {
    const { app, repository } = setup([
      row,
      { ...row, mediaId: "9007199254740992" },
    ]);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/families/4/search?fromDate=2024-02-29&toDate=2024-02-29&albumId=3&favoritesOnly=true&limit=1",
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(repository.searchFamilyMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          familyId: "4",
          limit: 2,
          filters: {
            fromDate: new Date("2024-02-29T00:00:00.000Z"),
            toDate: new Date("2024-02-29T23:59:59.999Z"),
            albumId: "3",
            favoritesOnly: true,
          },
        }),
      );
      const body = response.json();
      expect(body.media).toHaveLength(1);
      expect(Object.keys(body.media[0]).sort()).toEqual(
        [
          "mediaId",
          "albumId",
          "timelineKey",
          "timelineBasis",
          "displayWidth",
          "displayHeight",
          "thumbnail",
          "isFavorite",
          "isFamilyFeatured",
        ].sort(),
      );
      const query = familySearchQuerySchema.parse({
        fromDate: "2024-02-29",
        toDate: "2024-02-29",
        albumId: "3",
        favoritesOnly: "true",
        limit: "1",
      });
      expect(
        decodeFamilySearchCursor(
          body.nextCursor,
          familySearchScope("4", "7", query),
        ).mediaId,
      ).toBe(row.mediaId);
    } finally {
      await app.close();
    }
  });
  it("does not emit a cursor for an exact full final page", async () => {
    const { app } = setup();
    try {
      const result = await app.inject({
        method: "GET",
        url: "/api/v1/families/4/search?limit=1",
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(result.json().nextCursor).toBeNull();
    } finally {
      await app.close();
    }
  });
  it("keeps family not-found and database failures safe and no-store", async () => {
    for (const failure of [
      new AlbumRepositoryError("NOT_FOUND"),
      new Error("sensitive database detail"),
    ]) {
      const { app, repository } = setup();
      vi.mocked(repository.searchFamilyMedia).mockRejectedValue(failure);
      try {
        const response = await app.inject({
          method: "GET",
          url: "/api/v1/families/4/search",
          headers: { cookie: `__Host-family_session=${token}` },
        });
        expect(response.statusCode).toBe(
          failure instanceof AlbumRepositoryError ? 404 : 503,
        );
        expect(response.headers["cache-control"]).toBe("private, no-store");
        expect(response.body).not.toContain("sensitive");
      } finally {
        await app.close();
      }
    }
  });
  it("rejects cursor transfer across actor/family/filter/limit and noncanonical encoding", () => {
    const q = familySearchQuerySchema.parse({ limit: "1" }),
      scope = familySearchScope("4", "7", q);
    const c = encodeFamilySearchCursor(
      { timelineKey: row.timelineKey.toISOString(), mediaId: row.mediaId },
      scope,
    );
    expect(decodeFamilySearchCursor(c, scope).mediaId).toBe(row.mediaId);
    for (const other of [
      familySearchScope("5", "7", q),
      familySearchScope("4", "8", q),
      familySearchScope("4", "7", { ...q, limit: 2 }),
      familySearchScope("4", "7", { ...q, favoritesOnly: true }),
      familySearchScope("4", "7", { ...q, albumId: "3" }),
    ])
      expect(() => decodeFamilySearchCursor(c, other)).toThrow();
    for (const bad of [
      c + "=",
      "_",
      Buffer.from(
        JSON.stringify({
          timelineKey: row.timelineKey.toISOString(),
          mediaId: row.mediaId,
        }),
      ).toString("base64url"),
      Buffer.from([255]).toString("base64url"),
    ])
      expect(() => decodeFamilySearchCursor(bad, scope)).toThrow();
  });
});
