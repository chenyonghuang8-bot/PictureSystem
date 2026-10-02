import { describe, expect, it } from "vitest";
import {
  familySearchQuerySchema,
  familySearchCursorSchema,
  galleryMediaQuerySchema,
} from "./gallery.js";

describe("strict family search contract", () => {
  it.each([
    {},
    { fromDate: "1000-01-01" },
    { toDate: "9999-12-31" },
    {
      fromDate: "2024-02-29",
      toDate: "2024-02-29",
      albumId: "18446744073709551615",
      favoritesOnly: "true",
      limit: "100",
    },
  ])("accepts calendar and exact bounded values: %j", (input) =>
    expect(familySearchQuerySchema.safeParse(input).success).toBe(true),
  );
  it.each([
    { fromDate: "2023-02-29" },
    { fromDate: "2024-02-30" },
    { fromDate: "0999-12-31" },
    { fromDate: "2024-13-01" },
    { fromDate: "2024-01-01T00:00:00Z" },
    { fromDate: "" },
    { fromDate: ["2024-01-01", "2024-01-02"] },
    { fromDate: "2024-03-01", toDate: "2024-02-29" },
    { limit: "" },
    { limit: " 2" },
    { limit: "1e1" },
    { limit: "2.0" },
    { limit: "01" },
    { limit: "101" },
    { limit: ["1", "2"] },
    { albumId: "0" },
    { albumId: "18446744073709551616" },
    { albumId: ["1", "2"] },
    { favoritesOnly: "false" },
    { favoritesOnly: "1" },
    { favoritesOnly: "" },
    { favoritesOnly: true },
    { favoritesOnly: ["true", "true"] },
    { cursor: "a=" },
    { cursor: "a".repeat(1025) },
    { familyId: "4" },
    { memberId: "7" },
    { filename: "private" },
    { tagId: "1" },
    { gpsLatitude: "1" },
  ])("rejects malformed or out-of-scope input: %j", (input) =>
    expect(familySearchQuerySchema.safeParse(input).success).toBe(false),
  );
  it("keeps legacy gallery query unchanged and defaults personal favorites off", () => {
    expect(
      galleryMediaQuerySchema.safeParse({ favoritesOnly: "true" }).success,
    ).toBe(false);
    expect(familySearchQuerySchema.parse({})).toEqual({
      limit: 20,
      favoritesOnly: false,
    });
  });
  it("requires canonical valid cursor timeline and a scoped version", () => {
    const row = {
      version: 1,
      timelineKey: "2024-02-29T23:59:59.999Z",
      mediaId: "9007199254740993",
      scope: "a".repeat(64),
    };
    expect(familySearchCursorSchema.safeParse(row).success).toBe(true);
    for (const override of [
      { version: 2 },
      { timelineKey: "2023-02-29T00:00:00.000Z" },
      { timelineKey: "2024-02-29T00:00:00Z" },
      { scope: "A".repeat(64) },
      { hiddenAlbumId: "2" },
    ])
      expect(
        familySearchCursorSchema.safeParse({ ...row, ...override }).success,
      ).toBe(false);
  });
});
