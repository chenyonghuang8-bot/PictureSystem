import { familyTimelinePageSchema } from "@family-album/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GalleryClientError,
  browserGalleryGet,
  readGalleryResponse,
} from "./gallery-client.js";
import { timelinePath } from "./gallery-paths.js";

const item = {
  mediaId: "11",
  albumId: "3",
  timelineKey: "2024-06-01T00:00:00.000Z",
  timelineBasis: "UPLOAD_UTC",
  displayWidth: 320,
  displayHeight: 240,
  thumbnail: { kind: "thumbnail" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gallery API client", () => {
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
