import {
  familyTimelinePageSchema,
  favoriteStateSchema,
} from "@family-album/contracts";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GalleryClientError,
  browserGalleryGet,
  browserGallerySend,
  readGalleryResponse,
} from "./gallery-client.js";
import {
  timelinePath,
  mediaFeaturePath,
  originalDownloadPath,
  previewDownloadPath,
} from "./gallery-paths.js";

const item = {
  mediaId: "11",
  albumId: "3",
  timelineKey: "2024-06-01T00:00:00.000Z",
  timelineBasis: "UPLOAD_UTC",
  displayWidth: 320,
  displayHeight: 240,
  thumbnail: { kind: "thumbnail" },
  isFavorite: false,
  isFamilyFeatured: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gallery API client", () => {
  it("sends PUT once with same-origin credentials/no-store and distinguishes conflict", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ code: "CONFLICT" }, { status: 409 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      browserGallerySend(
        "PUT",
        mediaFeaturePath("3", "11", "note"),
        favoriteStateSchema,
        { note: "synthetic", expectedRevision: "1" },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/albums/3/media/11/note",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("accepts empty 204 deletion and rejects invalid mutation responses without replay", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      browserGallerySend(
        "DELETE",
        mediaFeaturePath("3", "11", "comments", "9"),
        z.undefined(),
        {},
      ),
    ).resolves.toBeUndefined();
    await expect(
      browserGallerySend(
        "PUT",
        mediaFeaturePath("3", "11", "favorite"),
        favoriteStateSchema,
        {},
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses selected-album attachment paths and rejects unchecked IDs", () => {
    expect(originalDownloadPath("3", "11")).toBe(
      "/api/v1/albums/3/media/11/download/original",
    );
    expect(previewDownloadPath("4", "11")).toBe(
      "/api/v1/albums/4/media/11/download/preview",
    );
    for (const id of ["../3", "0", "1?token=x", "https://other.test"]) {
      expect(() => originalDownloadPath(id, "11")).toThrow(
        "GALLERY_ID_INVALID",
      );
      expect(() => previewDownloadPath("3", id)).toThrow("GALLERY_ID_INVALID");
      expect(() => mediaFeaturePath("3", "11", "tags", id)).toThrow(
        "GALLERY_ID_INVALID",
      );
    }
  });
  it("maps a 401 to an auth error without reading a cookie", async () => {
    const response = Response.json(
      {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
        requestId: "req",
      },
      { status: 401 },
    );
    await expect(
      readGalleryResponse(response, familyTimelinePageSchema),
    ).rejects.toEqual(new GalleryClientError("UNAUTHENTICATED"));
  });

  it("rejects a payload that includes a location field", async () => {
    const response = Response.json({
      media: [{ ...item, gpsLatitude: "37.780000" }],
      nextCursor: null,
    });
    await expect(
      readGalleryResponse(response, familyTimelinePageSchema),
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("calls the same-origin gallery path", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push(String(input));
        return Response.json({ media: [item], nextCursor: null });
      }),
    );
    const page = await browserGalleryGet(
      timelinePath("4", { limit: 24 }),
      familyTimelinePageSchema,
    );
    expect(calls).toEqual(["/api/v1/families/4/timeline?limit=24"]);
    expect(page.media[0]?.mediaId).toBe("11");
  });
});
