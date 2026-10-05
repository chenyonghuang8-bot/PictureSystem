import { it, expect } from "vitest";
import {
  familyMapQuerySchema,
  familySearchQuerySchema,
  familyLocationOptionsQuerySchema,
} from "./gallery.js";
it("bounds all map inputs and keeps strict AND filter contracts", () => {
  expect(
    familyMapQuerySchema.parse({
      bbox: "170,-90,-170,90",
      zoom: "22",
      filename: "Café%",
      location: "country:US",
      favoritesOnly: "true",
    }).bbox,
  ).toEqual([170, -90, -170, 90]);
  for (const query of [
    { bbox: "0,0,181,90" },
    { bbox: "0,20,1,10" },
    { bbox: "NaN,0,1,2" },
    { zoom: "23" },
    { zoom: "-1" },
    { latitude: "1" },
    { fromDate: "2024-02-02", toDate: "2024-02-01" },
    { location: "cell:7:872830828ffffff" },
  ])
    expect(familyMapQuerySchema.safeParse(query).success).toBe(false);
  expect(familySearchQuerySchema.parse({ location: "unknown" }).location).toBe(
    "unknown",
  );
  expect(
    familyLocationOptionsQuerySchema.safeParse({ kind: "city", limit: "51" })
      .success,
  ).toBe(false);
});
