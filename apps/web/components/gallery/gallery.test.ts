import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GalleryClientError } from "../../lib/gallery-client.js";
import { AlbumList } from "./album-list.js";
import { GalleryFallback } from "./fallback.js";
import { GalleryShell } from "./shell.js";
import { EmptyPhotos, SignedOut } from "./states.js";
import { Timeline } from "./timeline.js";
import { PhotoGrid } from "./photo-grid.js";
import { HomeHeader } from "./home-header.js";
import { PreviewFrame, Viewer } from "./viewer.js";
import { ViewerDetails, ViewerComment } from "./viewer-details.js";
import type { GalleryMediaDetail } from "@family-album/contracts";

const item = {
  mediaId: "11",
  albumId: "3",
  timelineKey: "2024-06-01T00:00:00.000Z",
  timelineBasis: "CAPTURE_LOCAL" as const,
  displayWidth: 320,
  displayHeight: 240,
  thumbnail: { kind: "thumbnail" as const },
  isFavorite: false,
  isFamilyFeatured: false,
};

describe("gallery pages", () => {
  it("renders private detail controls, safe attachment links and capability-gated editors", () => {
    const detail: GalleryMediaDetail = {
      ...item,
      orientation: 1,
      capturedLocalAt: null,
      cameraMake: "Camera",
      cameraModel: null,
      preview: { kind: "preview" },
      isFavorite: true,
      isFamilyFeatured: true,
      tags: [{ id: "2", name: "<tag>" }],
      note: "<note>",
      noteRevision: "1",
      commentCount: "2",
      capabilities: {
        canManageFeatured: true,
        canEditTags: true,
        canEditNote: true,
        canComment: true,
        canDownloadOriginal: true,
        canDownloadPreview: true,
      },
    };
    const render = (row: GalleryMediaDetail) =>
      renderToStaticMarkup(
        createElement(ViewerDetails, {
          detail: row,
          target: { albumId: "3", mediaId: "11" },
          reload: async () => {},
          onFailure: () => {},
        }),
      );
    const html = render(detail);
    expect(html).toContain("取消收藏");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("取消家庭精选");
    expect(html).toContain("&lt;tag&gt;");
    expect(html).toContain("&lt;note&gt;");
    expect(html).toContain("编辑备注");
    expect(html).toContain("添加标签");
    expect(html).toContain(
      'href="/api/v1/albums/3/media/11/download/original"',
    );
    expect(html).toContain('href="/api/v1/albums/3/media/11/download/preview"');
    const readonly = render({
      ...detail,
      isFavorite: false,
      capabilities: {
        ...detail.capabilities,
        canManageFeatured: false,
        canEditTags: false,
        canEditNote: false,
        canDownloadPreview: false,
      },
    });
    expect(readonly).toContain(">收藏</button>");
    expect(readonly).not.toMatch(
      /取消家庭精选|编辑备注|添加标签|移除标签|download\/preview/,
    );
  });

  it("renders comments as escaped text and uses only returned canDelete for delete controls", () => {
    const comment = {
      id: "2",
      body: '<script>alert("x")</script>',
      createdAt: "2026-09-30T00:00:00.000Z",
      author: { memberId: "3", displayName: "<author>" },
      canDelete: true,
    };
    const render = (canDelete: boolean) =>
      renderToStaticMarkup(
        createElement(ViewerComment, {
          comment: { ...comment, canDelete },
          pending: false,
          onDelete: () => {},
        }),
      );
    expect(render(true)).toContain("&lt;script&gt;");
    expect(render(true)).not.toContain("<script>");
    expect(render(true)).toContain("删除评论");
    expect(render(false)).not.toContain("删除评论");
  });
  it("renders the three-part shell", () => {
    const html = renderToStaticMarkup(
      createElement(GalleryShell, {
        familyName: "周末家庭",
        active: "photos",
        children: createElement("p", null, "照片区域"),
      }),
    );
    expect(html).toContain("周末家庭");
    expect(html).toContain("照片");
    expect(html).toContain("相册");
    expect(html).toContain("照片区域");
    expect(html).toContain("辅助信息");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("gallery-aside-placeholder");
    expect(html).toContain("disabled");
  });

  it("renders the home family header with a real user placeholder", () => {
    const html = renderToStaticMarkup(
      createElement(HomeHeader, {
        familyName: "周末家庭",
        displayName: "小明",
      }),
    );
    expect(html).toContain("周末家庭");
    expect(html).toContain("小明");
    expect(html).toContain('class="gallery-avatar"');
    expect(html).toContain('class="gallery-avatar-placeholder"');
  });

  it("renders an empty timeline and a signed-out state", () => {
    const empty = renderToStaticMarkup(
      createElement(Timeline, {
        familyId: "4",
        initial: { media: [], nextCursor: null },
      }),
    );
    const signedOut = renderToStaticMarkup(
      createElement(GalleryFallback, {
        error: new GalleryClientError("UNAUTHENTICATED"),
      }),
    );
    expect(empty).toContain("还没有照片");
    expect(renderToStaticMarkup(createElement(EmptyPhotos))).toContain(
      "还没有照片",
    );
    expect(signedOut).toContain("需要登录");
    expect(renderToStaticMarkup(createElement(SignedOut))).not.toMatch(
      /gps|original|storage/i,
    );
  });

  it("groups a thumbnail grid by month without album counts", () => {
    const html = renderToStaticMarkup(
      createElement(Timeline, {
        familyId: "4",
        initial: {
          media: [
            item,
            { ...item, mediaId: "10", timelineKey: "2020-01-01T00:00:00.000Z" },
          ],
          nextCursor: null,
        },
      }),
    );
    expect(html).toContain("2024年6月");
    expect(html).toContain("2020年1月");
    expect(html).toContain("/api/v1/media/11/derived/thumbnail");
    expect(html).not.toMatch(/gps|original|storage/i);

    const albums = renderToStaticMarkup(
      createElement(AlbumList, {
        familyId: "4",
        initial: {
          albums: [
            {
              id: "8",
              familyId: "4",
              ownerMemberId: "2",
              name: "春天",
              description: null,
              visibility: "FAMILY",
              revision: "1",
              createdAt: "2024-06-01T00:00:00.000Z",
              updatedAt: "2024-06-01T00:00:00.000Z",
              effectivePermissions: {
                canView: true,
                canUpload: false,
                canEdit: false,
                canDelete: false,
                canManageMembers: false,
              },
            },
          ],
          nextAfterId: null,
        },
      }),
    );
    expect(albums).toContain("春天");
    expect(albums).toContain("家庭可见");
    expect(albums).toContain("gallery-album-card-header");
    expect(albums).toContain("gallery-album-permission");
    expect(albums).not.toContain("张");
  });

  it("renders a photo-first responsive grid with preserved media ratio", () => {
    const html = renderToStaticMarkup(
      createElement(PhotoGrid, {
        items: [{ mediaId: "11", displayWidth: 1600, displayHeight: 900 }],
        onOpen: () => undefined,
      }),
    );
    expect(html).toContain('class="gallery-grid"');
    expect(html).toContain('class="gallery-cell"');
    expect(html).toContain("aspect-ratio:1600 / 900");
    expect(html).toContain("derived/thumbnail");
  });

  it("renders the preview viewer with a loading state and safe preview path", () => {
    const html = renderToStaticMarkup(
      createElement(Viewer, {
        items: [{ mediaId: "11", albumId: "3" }],
        index: 0,
        familyId: "4",
        onIndex: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="关闭照片查看器"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("derived/preview");
    expect(html).not.toMatch(/original|gps|storage/i);
  });

  it("shows bounded preview loading and thumbnail fallback states", () => {
    const loading = renderToStaticMarkup(
      createElement(PreviewFrame, {
        preview: "/preview",
        thumbnail: "/thumbnail",
        loading: true,
        broken: false,
        fallbackBroken: false,
        missing: false,
        onPreviewError: () => undefined,
        onThumbnailError: () => undefined,
        onLoaded: () => undefined,
      }),
    );
    const fallback = renderToStaticMarkup(
      createElement(PreviewFrame, {
        preview: "/preview",
        thumbnail: "/thumbnail",
        loading: false,
        broken: true,
        fallbackBroken: false,
        missing: false,
        onPreviewError: () => undefined,
        onThumbnailError: () => undefined,
        onLoaded: () => undefined,
      }),
    );
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("正在加载预览");
    expect(fallback).toContain('src="/thumbnail"');
    expect(fallback).not.toContain('src="/preview"');
  });

  it("keeps responsive masonry hooks in the grid markup", () => {
    const html = renderToStaticMarkup(
      createElement(PhotoGrid, {
        items: [{ mediaId: "11", displayWidth: 4, displayHeight: 3 }],
        onOpen: () => undefined,
      }),
    );
    expect(html).toContain('class="gallery-grid"');
    expect(html).toContain('class="gallery-cell"');
    expect(html).toContain('loading="lazy"');
  });
});
