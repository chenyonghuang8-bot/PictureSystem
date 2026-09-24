import {
  publicSharePageSchema,
  shareListResponseSchema,
} from "@family-album/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AlbumDetail } from "./album-detail.js";
import {
  PublicShare,
  PublicShareMissing,
  PublicViewer,
} from "./public-share.js";
import {
  ShareLinkResult,
  ShareList,
  ShareRevokeConfirm,
} from "./share-panel.js";
import {
  GalleryClientError,
  readGalleryResponse,
} from "../../lib/gallery-client.js";
import {
  createShare,
  listShares,
  publicDerivedPath,
  revokeShare,
  shareLink,
  shareTimeLabel,
} from "../../lib/share-client.js";
import { loadPublicShare } from "../../lib/share-server.js";

const token = "a".repeat(43);
const item = {
  mediaId: "11",
  timelineKey: "2024-06-01T00:00:00.000Z",
  timelineBasis: "UPLOAD_UTC" as const,
  displayWidth: 320,
  displayHeight: 240,
  thumbnail: { kind: "thumbnail" as const },
};
const share = {
  shareId: "15",
  albumId: "8",
  createdAt: "2024-06-01T00:00:00.000Z",
  expiresAt: "2024-06-08T00:00:00.000Z",
  revokedAt: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("share management UI", () => {
  it("renders a share entry, a one-time link, and no token hash", () => {
    const album = renderToStaticMarkup(
      createElement(AlbumDetail, {
        albumId: "8",
        albumName: "春天",
        familyId: "4",
        initial: { media: [], nextCursor: null },
      }),
    );
    const link = shareLink("https://album.example", token);
    const created = renderToStaticMarkup(
      createElement(ShareLinkResult, {
        link,
        copied: false,
        onCopy: () => undefined,
      }),
    );
    expect(album).toContain("分享");
    expect(album).toContain("春天");
    expect(created).toContain(link);
    expect(created).toContain("复制链接");
    expect(created).toContain("刷新页面后不能再次查看");
    expect(created).not.toMatch(/token_hash|token hash/i);
  });

  it("lists album shares and confirms stopping access", () => {
    const html = renderToStaticMarkup(
      createElement(ShareList, {
        albumName: "春天",
        shares: [
          share,
          { ...share, shareId: "16", revokedAt: "2024-06-02T00:00:00.000Z" },
        ],
        pendingId: null,
        onRevoke: () => undefined,
      }),
    );
    const confirm = renderToStaticMarkup(
      createElement(ShareRevokeConfirm, {
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(html).toContain("春天");
    expect(html).toContain(`创建 ${shareTimeLabel(share.createdAt)}`);
    expect(html).toContain(`到期 ${shareTimeLabel(share.expiresAt)}`);
    expect(html).toContain("未停止");
    expect(html).toContain(
      `已停止 ${shareTimeLabel("2024-06-02T00:00:00.000Z")}`,
    );
    expect(html).toContain("停止访问");
    expect(html).not.toContain(token);
    expect(html).not.toMatch(/token_hash|15|16/);
    expect(confirm).toContain("停止该分享链接访问");
    expect(confirm).not.toContain("删除分享");
  });

  it("creates, lists, and revokes through the share API", async () => {
    const calls: { method: string; path: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init: { method?: string; body?: string }) => {
        calls.push({
          method: init.method ?? "GET",
          path,
          ...(init.body ? { body: init.body } : {}),
        });
        if (init.method === "POST") {
          return Response.json({
            shareId: "15",
            token,
            expiresAt: "2024-06-08T00:00:00.000Z",
          });
        }
        if (init.method === "DELETE") {
          return Response.json({
            shareId: "15",
            albumId: "8",
            revokedAt: "2024-06-02T00:00:00.000Z",
          });
        }
        return Response.json({
          shares: [share],
          nextAfterId: null,
        });
      }),
    );
    const created = await createShare(
      "8",
      new Date("2024-06-08T00:00:00.000Z"),
    );
    const listed = await listShares("4");
    const revoked = await revokeShare("15");
    expect(created.token).toBe(token);
    expect(listed.shares[0]?.albumId).toBe("8");
    expect(revoked.revokedAt).toBe("2024-06-02T00:00:00.000Z");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/v1/albums/8/share",
      "GET /api/v1/shares?familyId=4&limit=100",
      "DELETE /api/v1/shares/15",
    ]);
    expect(calls[0]?.body).toBe(
      JSON.stringify({ expiresAt: "2024-06-08T00:00:00.000Z" }),
    );
    expect(JSON.stringify(listed)).not.toContain(token);
  });
});

describe("public share viewer", () => {
  it("renders a thumbnail grid and a preview without original or GPS", () => {
    const page = renderToStaticMarkup(
      createElement(PublicShare, {
        token,
        initial: {
          album: { name: "春天" },
          media: [item],
          nextCursor: null,
        },
      }),
    );
    const viewer = renderToStaticMarkup(
      createElement(PublicViewer, {
        token,
        items: [{ mediaId: "11" }],
        index: 0,
        onIndex: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(page).toContain("春天");
    expect(page).toContain(publicDerivedPath(token, "11", "thumbnail"));
    expect(viewer).toContain(publicDerivedPath(token, "11", "preview"));
    expect(`${page}${viewer}`).not.toMatch(
      /\/derived\/original|gps|latitude|familyId|member|storage/i,
    );
    expect(page).not.toContain("家庭成员");
  });

  it("uses one not-found page for an invalid or expired link", async () => {
    const missing = renderToStaticMarkup(createElement(PublicShareMissing));
    expect(missing).toContain("没有找到");
    expect(missing).not.toMatch(/expired|revoked|invalid|过期|撤销/i);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "NOT_FOUND", message: "missing", requestId: "req" },
          { status: 404 },
        ),
      ),
    );
    vi.stubEnv("FAMILY_ALBUM_API_ORIGIN", "http://127.0.0.1:4000");
    await expect(loadPublicShare(token, { limit: 24 })).rejects.toEqual(
      new GalleryClientError("NOT_FOUND"),
    );
    await expect(loadPublicShare("not-a-token", { limit: 24 })).rejects.toThrow(
      "SHARE_TOKEN_INVALID",
    );
  });

  it("hides a removed preview and rejects GPS or a token on the list", async () => {
    const hidden = renderToStaticMarkup(
      createElement(PublicViewer, {
        token,
        items: [{ mediaId: "11" }],
        index: 0,
        previewFailed: true,
        onIndex: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(hidden).toContain("没有找到");
    expect(hidden).not.toContain("original");
    await expect(
      readGalleryResponse(
        Response.json({
          album: { name: "春天" },
          media: [{ ...item, latitude: 1 }],
          nextCursor: null,
        }),
        publicSharePageSchema,
      ),
    ).rejects.toEqual(new GalleryClientError("UNAVAILABLE"));
    await expect(
      readGalleryResponse(
        Response.json({
          shares: [{ ...share, token }],
          nextAfterId: null,
        }),
        shareListResponseSchema,
      ),
    ).rejects.toEqual(new GalleryClientError("UNAVAILABLE"));
  });
});
