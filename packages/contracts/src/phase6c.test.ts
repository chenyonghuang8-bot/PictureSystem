import { describe, expect, it } from "vitest";

import {
  createMediaCommentSchema,
  createMediaTagSchema,
  galleryMediaDetailSchema,
  mediaCommentCursorSchema,
  updateMediaNoteSchema,
} from "./gallery.js";

describe("Phase 6C contracts", () => {
  it("keeps mutation bodies strict and BIGINT strings exact", () => {
    expect(
      createMediaTagSchema.safeParse({ name: "Trip", familyId: "1" }).success,
    ).toBe(false);
    expect(
      createMediaCommentSchema.safeParse({ body: "Hi", authorId: "2" }).success,
    ).toBe(false);
    expect(
      updateMediaNoteSchema.safeParse({
        note: "Hi",
        expectedRevision: "9007199254740993",
      }).success,
    ).toBe(true);
  });

  it("requires a versioned private comment cursor", () => {
    expect(
      mediaCommentCursorSchema.safeParse({
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "9007199254740993",
      }).success,
    ).toBe(true);
    expect(
      mediaCommentCursorSchema.safeParse({
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "1",
        mediaId: "4",
      }).success,
    ).toBe(false);
  });

  it("requires all private detail fields", () => {
    expect(
      galleryMediaDetailSchema.safeParse({
        mediaId: "1",
        timelineKey: "2026-01-01T00:00:00.000Z",
        timelineBasis: "UPLOAD_UTC",
        displayWidth: null,
        displayHeight: null,
        thumbnail: { kind: "thumbnail" },
        isFavorite: false,
        isFamilyFeatured: false,
        orientation: null,
        capturedLocalAt: null,
        cameraMake: null,
        cameraModel: null,
        preview: { kind: "preview" },
      }).success,
    ).toBe(false);
  });
});
