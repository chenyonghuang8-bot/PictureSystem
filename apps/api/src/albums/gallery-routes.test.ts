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
    putFavorite: vi.fn(async () => ({ isFavorite: true as const })),
    deleteFavorite: vi.fn(async () => ({ isFavorite: false as const })),
    putFeatured: vi.fn(async () => ({ isFamilyFeatured: true as const })),
    deleteFeatured: vi.fn(async () => ({ isFamilyFeatured: false as const })),
    listTags: vi.fn(async () => [{ id: "12", name: "Trip" }]),
    createTag: vi.fn(async () => ({
      id: "12",
      name: "Trip",
      familyId: "4",
      actorMemberId: "7",
    })),
    applyTag: vi.fn(async () => ({
      id: "12",
      name: "Trip",
      familyId: "4",
      actorMemberId: "7",
    })),
    removeTag: vi.fn(async () => ({
      removed: true as const,
      familyId: "4",
      actorMemberId: "7",
    })),
    updateNote: vi.fn(async () => ({
      note: "hello",
      noteRevision: "2",
      familyId: "4",
      actorMemberId: "7",
    })),
    listComments: vi.fn(async () => [
      {
        id: "13",
        body: "hello",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        author: { memberId: "7", displayName: "Member" },
        canDelete: true,
      },
    ]),
    createComment: vi.fn(async () => ({
      id: "13",
      body: "hello",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      author: { memberId: "7", displayName: "Member" },
      canDelete: true,
      familyId: "4",
      actorMemberId: "7",
    })),
    deleteComment: vi.fn(async () => ({})),
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
    isFavorite: true,
    isFamilyFeatured: false,
    tags: [{ id: "12", name: "Trip" }],
    note: null,
    noteRevision: "1",
    commentCount: "1",
    capabilities: {
      canManageFeatured: false,
      canEditTags: true,
      canEditNote: true,
      canComment: true,
      canDownloadOriginal: true,
      canDownloadPreview: true,
    },
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
        isFavorite: true,
        isFamilyFeatured: false,
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
      isFavorite: true,
      isFamilyFeatured: false,
    });
    expect(response.json()).not.toHaveProperty("gpsLatitude");
    await app.close();
  });

  it.each([
    ["PUT", "favorite", { isFavorite: true }],
    ["DELETE", "favorite", { isFavorite: false }],
    ["PUT", "featured", { isFamilyFeatured: true }],
    ["DELETE", "featured", { isFamilyFeatured: false }],
  ] as const)(
    "supports %s %s with strict empty JSON",
    async (method, kind, expected) => {
      const { app, albumService } = setup();
      const response = await app.inject({
        method,
        url: `/api/v1/albums/3/media/11/${kind}`,
        headers: {
          ...cookie(),
          origin,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
      const methodName =
        kind === "favorite"
          ? method === "PUT"
            ? "putFavorite"
            : "deleteFavorite"
          : method === "PUT"
            ? "putFeatured"
            : "deleteFeatured";
      expect(albumService[methodName]).toHaveBeenCalledWith(
        expect.objectContaining({
          identity: expect.objectContaining({ userId: "7" }),
        }),
        "3",
        "11",
      );
      await app.close();
    },
  );

  it("rejects extra mutation fields before reaching the service", async () => {
    const { app, albumService } = setup();
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/albums/3/media/11/favorite",
      headers: { ...cookie(), origin, "content-type": "application/json" },
      payload: { memberId: "9" },
    });
    expect(response.statusCode).toBe(400);
    expect(albumService.putFavorite).not.toHaveBeenCalled();
    await app.close();
  });

  it("supports strict tag, note and comment routes", async () => {
    const { app, albumService } = setup();
    const headers = {
      ...cookie(),
      origin,
      "content-type": "application/json",
    };
    const tag = await app.inject({
      method: "POST",
      url: "/api/v1/albums/3/media/11/tags",
      headers,
      payload: { name: "Trip" },
    });
    expect(tag.statusCode).toBe(200);
    expect(tag.json()).toEqual({ tag: { id: "12", name: "Trip" } });

    const note = await app.inject({
      method: "PUT",
      url: "/api/v1/albums/3/media/11/note",
      headers,
      payload: { note: "hello", expectedRevision: "1" },
    });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toEqual({ note: "hello", noteRevision: "2" });

    const comment = await app.inject({
      method: "POST",
      url: "/api/v1/albums/3/media/11/comments",
      headers,
      payload: { body: "hello" },
    });
    expect(comment.statusCode).toBe(201);
    expect(comment.json().comment.author).toEqual({
      memberId: "7",
      displayName: "Member",
    });
    expect(albumService.createComment).toHaveBeenCalledWith(
      expect.anything(),
      "3",
      "11",
      "hello",
    );

    const tags = await app.inject({
      method: "GET",
      url: "/api/v1/albums/3/media/11/tags",
      headers: cookie(),
    });
    expect(tags.json()).toEqual({ tags: [{ id: "12", name: "Trip" }] });

    const putTag = await app.inject({
      method: "PUT",
      url: "/api/v1/albums/3/media/11/tags/12",
      headers,
      payload: {},
    });
    expect(putTag.json()).toEqual({ tag: { id: "12", name: "Trip" } });

    const removeTag = await app.inject({
      method: "DELETE",
      url: "/api/v1/albums/3/media/11/tags/12",
      headers,
      payload: {},
    });
    expect(removeTag.json()).toEqual({ removed: true });

    const comments = await app.inject({
      method: "GET",
      url: "/api/v1/albums/3/media/11/comments?limit=1",
      headers: cookie(),
    });
    expect(comments.statusCode).toBe(200);
    expect(comments.json().comments).toHaveLength(1);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/albums/3/media/11/comments/13",
      headers,
      payload: {},
    });
    expect(deleted.statusCode).toBe(204);
    await app.close();
  });

  it("rejects forged ownership fields and malformed comment cursors", async () => {
    const { app, albumService } = setup();
    const forged = await app.inject({
      method: "POST",
      url: "/api/v1/albums/3/media/11/comments",
      headers: {
        ...cookie(),
        origin,
        "content-type": "application/json",
      },
      payload: { body: "hello", authorId: "99" },
    });
    expect(forged.statusCode).toBe(400);
    expect(albumService.createComment).not.toHaveBeenCalled();

    const cursor = await app.inject({
      method: "GET",
      url: "/api/v1/albums/3/media/11/comments?cursor=invalid",
      headers: cookie(),
    });
    expect(cursor.statusCode).toBe(400);
    expect(albumService.listComments).not.toHaveBeenCalled();
    await app.close();
  });
});
