import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GalleryClientError } from "../../lib/gallery-client.js";
import { AlbumList } from "./album-list.js";
import { GalleryFallback } from "./fallback.js";
import { GalleryShell } from "./shell.js";
import { EmptyPhotos, SignedOut } from "./states.js";
import { Timeline } from "./timeline.js";

const item = {
  mediaId: "11",
  albumId: "3",
  timelineKey: "2024-06-01T00:00:00.000Z",
  timelineBasis: "CAPTURE_LOCAL" as const,
  displayWidth: 320,
  displayHeight: 240,
  thumbnail: { kind: "thumbnail" as const },
};

describe("gallery pages", () => {
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
    expect(albums).not.toContain("张");
  });
});
