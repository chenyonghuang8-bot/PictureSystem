import { describe, expect, it } from "vitest";
import {
  searchFilterQuery,
  searchFiltersFromUrl,
  searchPath,
  timelinePath,
} from "./gallery-paths.js";

describe("search URL identity", () => {
  it("canonicalizes dates, one exact BIGINT album and enabled favorites without changing old timeline paths", () => {
    const filters = searchFiltersFromUrl({
      favoritesOnly: "true",
      albumId: "18446744073709551615",
      toDate: "9999-12-31",
      fromDate: "1000-01-01",
    });
    expect(searchFilterQuery(filters)).toBe(
      "/?fromDate=1000-01-01&toDate=9999-12-31&albumId=18446744073709551615&favoritesOnly=true",
    );
    expect(searchPath("4", filters, { limit: 24, cursor: "YWJj" })).toBe(
      "/api/v1/families/4/search?fromDate=1000-01-01&toDate=9999-12-31&albumId=18446744073709551615&favoritesOnly=true&limit=24&cursor=YWJj",
    );
    expect(searchFilterQuery(searchFiltersFromUrl({}))).toBe("/");
    expect(timelinePath("4", { limit: 24, cursor: "old" })).toBe(
      "/api/v1/families/4/timeline?limit=24&cursor=old",
    );
  });
  it.each([
    { fromDate: ["2024-01-01", "2024-01-02"] },
    { fromDate: "2024-02-30" },
    { favoritesOnly: "false" },
    { cursor: "YWJj" },
    { limit: "1" },
    { gps: "1" },
  ])("rejects invalid/unsupported homepage identity %j", (input) => {
    expect(() => searchFiltersFromUrl(input)).toThrow();
  });
});

it("round trips all confirmed filters and canonical trimmed filename", () => {
  const filters = searchFiltersFromUrl({
    filename: "  Café%_!  ",
    uploaderMemberId: "9007199254740993",
    tagId: "7",
  });
  const url = searchFilterQuery(filters);
  expect(url).toContain("filename=Caf%C3%A9%25_%21");
  expect(
    searchFiltersFromUrl(Object.fromEntries(new URLSearchParams(url.slice(2)))),
  ).toEqual(filters);
});
