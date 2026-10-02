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
    listFamilySearchOptions: vi.fn(async () => [
      { id: "1", name: "可见来源" },
      { id: "2", name: "可见来源" },
    ]),
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
    "?filename=",
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
      familySearchScope("4", "7", { ...q, filename: "IMG" }),
      familySearchScope("4", "7", { ...q, uploaderMemberId: "9" }),
      familySearchScope("4", "7", { ...q, tagId: "2" }),
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

describe("confirmed batch API contracts and option privacy", () => {
  it("passes normalized new filters without widening DTO", async () => {
    const { app, repository } = setup();
    try {
      const r = await app.inject({
        method: "GET",
        url: "/api/v1/families/4/search?filename=%20IMG%20&uploaderMemberId=9&tagId=2",
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(r.statusCode).toBe(200);
      expect(repository.searchFamilyMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: {
            filename: "IMG",
            uploaderMemberId: "9",
            tagId: "2",
            favoritesOnly: false,
          },
        }),
      );
      expect(r.json().media[0]).not.toHaveProperty("filename");
      expect(r.json().media[0]).not.toHaveProperty("uploaderMemberId");
      const old = Buffer.from(
        JSON.stringify({
          version: 1,
          timelineKey: row.timelineKey.toISOString(),
          mediaId: row.mediaId,
          scope: familySearchScope("4", "7", familySearchQuerySchema.parse({})),
        }),
      ).toString("base64url");
      const rejected = await app.inject({
        method: "GET",
        url: `/api/v1/families/4/search?cursor=${old}`,
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(rejected.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("paginates only id/name with scoped cursor and private errors", async () => {
    const { app, repository, service } = setup();
    try {
      const req = (query: string, cookie = true) =>
        app.inject({
          method: "GET",
          url: "/api/v1/families/4/search/options" + query,
          ...(cookie
            ? { headers: { cookie: `__Host-family_session=${token}` } }
            : {}),
        });
      const r = await req("?kind=tag&limit=1");
      expect(r.statusCode).toBe(200);
      expect(r.headers["cache-control"]).toBe("private, no-store");
      expect(Object.keys(r.json().options[0]).sort()).toEqual(["id", "name"]);
      const c = r.json().nextCursor;
      expect(c).toBeTruthy();
      await req(`?kind=tag&limit=1&cursor=${c}`);
      expect(repository.listFamilySearchOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ afterId: "1", kind: "tag", limit: 2 }),
      );
      for (const query of [
        `?kind=uploader&limit=1&cursor=${c}`,
        `?kind=tag&limit=2&cursor=${c}`,
        "?kind=tag&kind=uploader",
        "?kind=tag&filename=private",
        "?kind=tag&cursor=_",
      ]) {
        const bad = await req(query);
        expect(bad.statusCode).toBe(400);
        expect(bad.headers["cache-control"]).toBe("private, no-store");
      }
      const crossFamily = await app.inject({
        method: "GET",
        url: `/api/v1/families/5/search/options?kind=tag&limit=1&cursor=${c}`,
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(crossFamily.statusCode).toBe(400);
      const crossUser = await service
        .searchOptions(
          {
            ...context,
            identity: { ...context.identity, userId: "9" },
          } as Parameters<typeof service.searchOptions>[0],
          "4",
          { kind: "tag", limit: 1, cursor: c },
        )
        .catch((error: unknown) => error);
      expect(crossUser).toMatchObject({ statusCode: 400 });
      const noAuth = await req("?kind=tag", false);
      expect(noAuth.statusCode).toBe(401);
      expect(noAuth.headers["cache-control"]).toBe("private, no-store");
      repository.listFamilySearchOptions = vi.fn(async () => {
        throw new AlbumRepositoryError("NOT_FOUND");
      });
      const denied = await req("?kind=tag");
      expect(denied.statusCode).toBe(404);
      expect(denied.headers["cache-control"]).toBe("private, no-store");
      repository.listFamilySearchOptions = vi.fn(async () => {
        throw new Error("synthetic database failure");
      });
      const unavailable = await req("?kind=tag");
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.headers["cache-control"]).toBe("private, no-store");
    } finally {
      await app.close();
    }
  });
});
