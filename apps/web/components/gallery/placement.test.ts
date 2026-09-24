import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { albumMediaRemovalSchema } from "@family-album/contracts";

import {
  GalleryClientError,
  readGalleryResponse,
} from "../../lib/gallery-client.js";
import {
  addMediaToAlbum,
  operableAlbums,
  placementErrorMessage,
  removalKeptMessage,
  removeMediaFromAlbum,
} from "../../lib/gallery-placement.js";
import { AlbumSelector } from "./album-selector.js";
import { RemovePlacement } from "./remove-placement.js";

const permissions = {
  canView: true,
  canUpload: false,
  canEdit: false,
  canDelete: false,
  canManageMembers: false,
};

function album(id: string, name: string, canEdit: boolean) {
  return {
    id,
    familyId: "4",
    ownerMemberId: "2",
    name,
    description: null,
    visibility: "CUSTOM" as const,
    revision: "1",
    createdAt: "2024-06-01T00:00:00.000Z",
    updatedAt: "2024-06-01T00:00:00.000Z",
    effectivePermissions: { ...permissions, canEdit, canUpload: canEdit },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("album placement UI", () => {
  it("renders operable albums and marks an existing placement", () => {
    const html = renderToStaticMarkup(
      createElement(AlbumSelector, {
        albums: operableAlbums([
          album("8", "春天", true),
          album("9", "只读", false),
        ]).map((item) => ({ id: item.id, name: item.name })),
        selectedIds: new Set(["8"]),
        pendingId: null,
        message: "",
        onAdd: () => undefined,
      }),
    );
    expect(html).toContain("春天");
    expect(html).toContain("已加入");
    expect(html).not.toContain("只读");
    expect(html).not.toMatch(/gps|original|storage|张/i);
  });

  it("adds a placement and treats a duplicate as already selected", async () => {
    const calls: { method: string; path: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init: { method: string; body: string }) => {
        calls.push({ method: init.method, path, body: init.body });
        const created = calls.length === 1;
        return Response.json({ albumId: "8", mediaId: "11", created });
      }),
    );
    const first = await addMediaToAlbum("8", "11");
    const second = await addMediaToAlbum("8", "11");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/albums/8/media",
        body: JSON.stringify({ mediaId: "11" }),
      },
      {
        method: "POST",
        path: "/api/v1/albums/8/media",
        body: JSON.stringify({ mediaId: "11" }),
      },
    ]);
  });

  it("removes only the placement and says the photo remains", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        calls.push(String(path));
        return Response.json({ albumId: "8", mediaId: "11", removed: true });
      }),
    );
    const result = await removeMediaFromAlbum("8", "11");
    const html = renderToStaticMarkup(
      createElement(RemovePlacement, {
        confirming: true,
        message: removalKeptMessage(),
        onAsk: () => undefined,
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(result.removed).toBe(true);
    expect(calls).toEqual(["/api/v1/albums/8/media/11"]);
    expect(html).toContain("从相册移除");
    expect(html).toContain("照片仍保留在家庭中");
    expect(html).not.toContain("删除照片");
  });

  it("maps permission responses without treating them as deletion", async () => {
    await expect(
      readGalleryResponse(
        Response.json({}, { status: 401 }),
        albumMediaRemovalSchema,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(
      placementErrorMessage(new GalleryClientError("UNAUTHENTICATED")),
    ).toContain("登录");
    expect(
      placementErrorMessage(new GalleryClientError("FORBIDDEN")),
    ).toContain("权限");
    expect(
      placementErrorMessage(new GalleryClientError("NOT_FOUND")),
    ).toContain("没有找到");
    expect(
      placementErrorMessage(new GalleryClientError("FORBIDDEN")),
    ).not.toContain("删除照片");
  });
});
