import { describe, expect, it } from "vitest";

import {
  createShareRequestSchema,
  createShareResponseSchema,
  listSharesQuerySchema,
  shareListResponseSchema,
  publicSharePageSchema,
} from "./shares.js";
import {
  favoriteStateSchema,
  featuredStateSchema,
  galleryMediaItemSchema,
} from "./gallery.js";

describe("share management contracts", () => {
  it("requires an expiry and rejects a token on the request", () => {
    expect(
      createShareRequestSchema.parse({
        expiresAt: "2026-01-08T00:00:00.000Z",
      }),
    ).toEqual({ expiresAt: "2026-01-08T00:00:00.000Z" });
    expect(
      createShareRequestSchema.safeParse({
        expiresAt: "2026-01-08T00:00:00.000Z",
        token: "x",
      }).success,
    ).toBe(false);
  });

  it("keeps the raw token only on the create response", () => {
    const token = "A".repeat(43);
    expect(
      createShareResponseSchema.parse({
        shareId: "15",
        token,
        expiresAt: "2026-01-08T00:00:00.000Z",
      }).token,
    ).toBe(token);
    expect(
      shareListResponseSchema.safeParse({
        shares: [
          {
            shareId: "15",
            albumId: "9",
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-08T00:00:00.000Z",
            revokedAt: null,
            token,
          },
        ],
        nextAfterId: null,
      }).success,
    ).toBe(false);
  });

  it("requires the family being listed", () => {
    expect(listSharesQuerySchema.parse({ familyId: "2" })).toEqual({
      familyId: "2",
      limit: 20,
    });
    expect(listSharesQuerySchema.safeParse({}).success).toBe(false);
  });

  it("separates strict public media from private gallery state", () => {
    const publicMedia = {
      mediaId: "11",
      timelineKey: "2026-01-01T00:00:00.000Z",
      timelineBasis: "UPLOAD_UTC",
      displayWidth: 10,
      displayHeight: 20,
      thumbnail: { kind: "thumbnail" },
    };
    expect(
      publicSharePageSchema.parse({
        album: { name: "Album" },
        media: [publicMedia],
        nextCursor: null,
      }).media[0],
    ).toEqual(publicMedia);
    expect(
      publicSharePageSchema.safeParse({
        album: { name: "Album" },
        media: [{ ...publicMedia, isFavorite: true }],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      galleryMediaItemSchema.parse({
        ...publicMedia,
        isFavorite: true,
        isFamilyFeatured: false,
      }),
    ).toMatchObject({ isFavorite: true, isFamilyFeatured: false });
    expect(
      favoriteStateSchema.safeParse({ isFavorite: true, memberId: "1" })
        .success,
    ).toBe(false);
    expect(
      featuredStateSchema.safeParse({ isFamilyFeatured: true, familyId: "1" })
        .success,
    ).toBe(false);
  });
});
