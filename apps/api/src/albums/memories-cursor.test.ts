import { it, expect } from "vitest";
import {
  memoriesQuerySchema,
  type MemoriesItem,
} from "@family-album/contracts";
import { encodeMemoriesCursor, decodeMemoriesCursor } from "./service.js";
const item = {
  mediaId: "18446744073709551615",
  timelineKey: "2025-10-05T12:00:00.000Z",
} as MemoriesItem;
it("binds memories continuation to current authenticated scope with exact BIGINT and timestamp", () => {
  const query = memoriesQuerySchema.parse({}),
    cursor = encodeMemoriesCursor(item, "1", "2", query, "2026-10-05");
  expect(decodeMemoriesCursor(cursor, "1", "2", query).mediaId).toBe(
    item.mediaId,
  );
  for (const [user, family, q] of [
    ["3", "2", query],
    ["1", "3", query],
    ["1", "2", { ...query, kind: "LAST_YEAR_WEEK" as const }],
    ["1", "2", { ...query, limit: 6 }],
  ] as const)
    expect(() => decodeMemoriesCursor(cursor, user, family, q)).toThrow();
  for (const change of [
    { zone: "UTC" },
    { policy: "v0" },
    { version: 2 },
    { anchorDate: "2026-02-30" },
    { mediaId: "0" },
    { mediaId: "18446744073709551616" },
    { timelineKey: "2025-10-05T12:00:00Z" },
    { extra: true },
  ]) {
    const edited = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(cursor, "base64url").toString()),
        ...change,
      }),
    ).toString("base64url");
    expect(() => decodeMemoriesCursor(edited, "1", "2", query)).toThrow();
  }
  for (const invalid of [
    cursor + "=",
    "_w",
    "a".repeat(1025),
    Buffer.from("{bad}").toString("base64url"),
  ])
    expect(() => decodeMemoriesCursor(invalid, "1", "2", query)).toThrow();
});
