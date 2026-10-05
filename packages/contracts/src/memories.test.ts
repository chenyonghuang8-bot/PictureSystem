import { describe, it, expect } from "vitest";
import {
  memoriesCalendar,
  memoryWeek,
  matchesMemoryDate,
  parseMemoryDate,
} from "./memories-calendar.js";
import { memoriesQuerySchema } from "./memories.js";

describe("Memories Gregorian wall calendar", () => {
  it.each([
    ["2026-10-05", "2025-09-29", "2025-10-06"],
    ["2026-01-01", "2024-12-30", "2025-01-06"],
    ["2024-02-29", "2023-02-27", "2023-03-06"],
    ["2025-02-28", "2024-02-26", "2024-03-04"],
  ])("subtracts a year before Monday week for %s", (anchor, start, end) =>
    expect(memoryWeek(anchor)).toEqual({ weekStart: start, weekEnd: end }),
  );
  it("crosses Shanghai midnight at 16Z with exact following midnight", () => {
    const before = memoriesCalendar(new Date("2026-10-04T15:59:59.999Z"));
    expect(before.anchorDate).toBe("2026-10-04");
    expect(before.nextMidnight).toBe("2026-10-04T16:00:00.000Z");
    const after = memoriesCalendar(new Date("2026-10-04T16:00:00.000Z"));
    expect(after.anchorDate).toBe("2026-10-05");
    expect(after.nextMidnight).toBe("2026-10-05T16:00:00.000Z");
  });
  it("matches only prior exact February 29 and does not absorb it into February 28", () => {
    expect(matchesMemoryDate("ON_THIS_DAY", "2024-02-29", "2028-02-29")).toBe(
      true,
    );
    for (const photo of ["2028-02-29", "2024-02-28", "2024-03-01"])
      expect(matchesMemoryDate("ON_THIS_DAY", photo, "2028-02-29")).toBe(false);
    expect(matchesMemoryDate("ON_THIS_DAY", "2024-02-29", "2025-02-28")).toBe(
      false,
    );
  });
  it("keeps week end exclusive and the December portion of a crossing week", () => {
    for (const photo of ["2024-12-30", "2025-01-05"])
      expect(matchesMemoryDate("LAST_YEAR_WEEK", photo, "2026-01-01")).toBe(
        true,
      );
    for (const photo of ["2024-12-29", "2025-01-06"])
      expect(matchesMemoryDate("LAST_YEAR_WEEK", photo, "2026-01-01")).toBe(
        false,
      );
  });
  it.each([
    "2025-02-29",
    "2024-02-30",
    "2024-13-01",
    "2024-1-01",
    "2024-01-01T00:00:00Z",
  ])("rejects impossible/nonliteral date %s", (date) =>
    expect(() => parseMemoryDate(date)).toThrow(),
  );
  it("permits only bounded kinds and cursors, no arbitrary anchor or zone", () => {
    expect(memoriesQuerySchema.parse({})).toEqual({
      kind: "ON_THIS_DAY",
      limit: 48,
    });
    for (const query of [
      { date: "2020-01-01" },
      { anchorDate: "2020-01-01" },
      { zone: "UTC" },
      { kind: ["ON_THIS_DAY"] },
      { limit: "101" },
      { limit: "0" },
      { limit: "1e1" },
      { limit: "048" },
    ])
      expect(memoriesQuerySchema.safeParse(query).success).toBe(false);
  });
});
