import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { latLngToCell } from "h3-js";
import { describe, it, expect } from "vitest";
import {
  LocationProjector,
  loadLocationProjector,
  locationCellCenter,
  greatCircleMeters,
} from "./location-projection.js";
import {
  aggregateLocationMap,
  centerInBbox,
  mapResolution,
  matchesLocation,
  assertLocationFilter,
} from "./location-map.js";
const version = "a".repeat(64);
const shape = {
  code: "US",
  name: "Synthetic country",
  polygons: [
    [
      [
        [-124, 36],
        [-121, 36],
        [-121, 39],
        [-124, 39],
        [-124, 36],
      ],
    ],
  ],
};
const center = locationCellCenter(latLngToCell(37.78, -122.42, 6));
const city = (
  id: string,
  lat = center[0],
  lng = center[1],
  country = "US",
) => ({ id, name: "Synthetic city", country, lat, lng });
const row = (h3Cell: string | null) => ({
  h3Cell,
  countryCode: null,
  cityGeonameId: null,
  hasGps: true,
});
describe("Phase8 local fixed-cell projection", () => {
  it("loads the real pinned global dataset and labels only coarse centers", () => {
    const projector = loadLocationProjector(
      resolve("resources/location/2026-10-03"),
    );
    for (const [lat, lng, country] of [
      [40.72, -74.0, "US"],
      [51.51, -0.12, "GB"],
      [35.68, 139.76, "JP"],
      [39.9, 116.4, "CN"],
      [-33.87, 151.21, "AU"],
    ] as const) {
      const projected = projector.project(String(lat), String(lng));
      expect(projected.countryCode).toBe(country);
      expect(projected.cityGeonameId).not.toBeNull();
      expect(projector.cityName(projected.cityGeonameId)).toBeTruthy();
    }
    expect(projector.project("89", "0").countryCode).toBeNull();
    expect(projector.project("0", "-140").cityGeonameId).toBeNull();
  });
  it("makes identical labels and bbox membership for two GPS values inside one cell", () => {
    const projector = new LocationProjector(
      version,
      [shape],
      [city("20"), city("3")],
    );
    const a = projector.project(String(center[0]), String(center[1])),
      b = projector.project(
        String(center[0] + 0.000001),
        String(center[1] + 0.000001),
      );
    expect(a).toEqual(b);
    expect(a.cityGeonameId).toBe("3");
    expect(Object.keys(a).sort()).toEqual([
      "cityGeonameId",
      "countryCode",
      "datasetVersion",
      "h3Cell",
      "policyVersion",
    ]);
    expect(
      centerInBbox(a.h3Cell, [center[1], center[0], center[1], center[0]]),
    ).toBe(true);
    expect(
      centerInBbox(a.h3Cell, [
        center[1] + 0.00001,
        center[0],
        center[1] + 0.00002,
        center[0],
      ]),
    ).toBe(false);
  });
  it("does not infer countries from cities, treats ambiguous matches as unknown, and enforces same-country <=50km", () => {
    expect(
      new LocationProjector(version, [], [city("1")]).project(
        "37.78",
        "-122.42",
      ).countryCode,
    ).toBeNull();
    expect(
      new LocationProjector(version, [shape, shape], [city("1")]).project(
        "37.78",
        "-122.42",
      ).cityGeonameId,
    ).toBeNull();
    expect(
      new LocationProjector(
        version,
        [shape],
        [city("1", center[0], center[1], "CA")],
      ).project("37.78", "-122.42").cityGeonameId,
    ).toBeNull();
    for (const [distance, expected] of [
      [49999.999, "1"],
      [50000.001, null],
    ] as const) {
      const lat = center[0] + ((distance / 6371008.8) * 180) / Math.PI;
      expect(
        Math.abs(greatCircleMeters(center, [lat, center[1]]) - distance),
      ).toBeLessThan(0.000001);
      expect(
        new LocationProjector(version, [shape], [city("1", lat)]).project(
          String(center[0]),
          String(center[1]),
        ).cityGeonameId,
      ).toBe(expected);
    }
  });
  it("normalizes dateline endpoints and refuses invalid coordinates, cells, and finer filters", () => {
    const projector = new LocationProjector(version, [], []);
    expect(projector.project("0", "180")).toEqual(
      projector.project("0", "-180"),
    );
    for (const pair of [
      ["NaN", "0"],
      ["0", "Infinity"],
      ["91", "0"],
      ["0", "181"],
      ["", "0"],
    ])
      expect(() => projector.project(pair[0]!, pair[1]!)).toThrow();
    expect(() => assertLocationFilter("cell:6:fffffffffffffff")).toThrow();
    expect(() =>
      assertLocationFilter("cell:7:" + latLngToCell(0, 0, 7)),
    ).toThrow();
  });
  it("refuses changed dataset bytes under a fixed manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "p8-data-"));
    try {
      for (const name of ["countries.json", "cities.json", "manifest.json"])
        writeFileSync(
          join(directory, name),
          readFileSync(resolve("resources/location/2026-10-03", name)),
        );
      writeFileSync(join(directory, "cities.json"), "[]");
      expect(() => loadLocationProjector(directory)).toThrow(
        "LOCATION_CHECKSUM_INVALID",
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  it("never truncates global 10k counts and uses logical parents, including polar and dateline rows", () => {
    const rows = Array.from({ length: 10000 }, (_, n) =>
      row(
        latLngToCell(
          -89 + (n % 100) * 1.78,
          -179 + Math.floor(n / 100) * 3.58,
          6,
        ),
      ),
    );
    const start = performance.now(),
      map = aggregateLocationMap(rows, [-180, -90, 180, 90], 22);
    expect(performance.now() - start).toBeLessThan(10000);
    expect(map.clusters.length).toBeLessThanOrEqual(500);
    expect(map.resolution).toBeLessThan(6);
    expect(map.clusters.reduce((sum, r) => sum + r.count, 0)).toBe(10000);
    expect(map.polarCount).toBeGreaterThan(0);
    const east = row(latLngToCell(0, 179.99, 6)),
      west = row(latLngToCell(0, -179.99, 6)),
      middle = row(latLngToCell(0, 0, 6));
    const wrapped = aggregateLocationMap(
      [east, west, middle],
      [170, -10, -170, 10],
      10,
    );
    expect(wrapped.clusters.reduce((sum, r) => sum + r.count, 0)).toBe(2);
    expect([0, 3, 4, 5, 6, 7, 8, 9, 10, 22].map(mapResolution)).toEqual([
      2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    ]);
    expect(matchesLocation(east, `cell:6:${east.h3Cell}`)).toBe(true);
    expect(
      createHash("sha256").update(JSON.stringify(map)).digest("hex"),
    ).toHaveLength(64);
  });
});
