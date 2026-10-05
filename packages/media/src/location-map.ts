import { cellToLatLng, getResolution, isValidCell } from "h3-js";
import {
  locationCellCenter,
  locationLogicalParent,
} from "./location-projection.js";

export type CoarseLocation = {
  h3Cell: string | null;
  countryCode: string | null;
  cityGeonameId: string | null;
  hasGps: boolean;
};
export function assertLocationFilter(filter: string | undefined) {
  if (filter?.startsWith("cell:")) {
    const [, resolution, cell] = filter.split(":");
    if (
      !cell ||
      !isValidCell(cell) ||
      getResolution(cell) !== Number(resolution) ||
      Number(resolution) > 6
    )
      throw new Error("LOCATION_FILTER_INVALID");
  }
}
export function matchesLocation(
  row: CoarseLocation,
  filter: string | undefined,
) {
  if (!filter) return true;
  if (!row.h3Cell) return false;
  if (filter === "located") return true;
  if (filter === "unknown") return row.countryCode === null;
  if (filter === "no-city") return row.cityGeonameId === null;
  if (filter.startsWith("country:")) return row.countryCode === filter.slice(8);
  if (filter.startsWith("city:")) return row.cityGeonameId === filter.slice(5);
  const [, resolution, cell] = filter.split(":");
  return locationLogicalParent(row.h3Cell, Number(resolution)) === cell;
}
export function centerInBbox(
  cell: string,
  bbox: readonly [number, number, number, number],
) {
  const [lat, lng] = locationCellCenter(cell),
    [west, south, east, north] = bbox;
  return (
    lat >= south &&
    lat <= north &&
    (west <= east ? lng >= west && lng <= east : lng >= west || lng <= east)
  );
}
export function mapResolution(zoom: number) {
  return zoom < 4 ? 2 : zoom < 6 ? 3 : zoom < 8 ? 4 : zoom < 10 ? 5 : 6;
}
export function aggregateLocationMap(
  rows: readonly CoarseLocation[],
  bbox: readonly [number, number, number, number],
  zoom: number,
) {
  const located = rows.filter(
    (r): r is CoarseLocation & { h3Cell: string } => r.h3Cell !== null,
  );
  const selected = located.filter((r) => centerInBbox(r.h3Cell, bbox));
  let resolution = mapResolution(zoom);
  let groups: Map<string, number>;
  do {
    groups = new Map();
    for (const row of selected) {
      const parent = locationLogicalParent(row.h3Cell, resolution);
      groups.set(parent, (groups.get(parent) ?? 0) + 1);
    }
    if (groups.size <= 500 || resolution === 0) break;
    --resolution;
  } while (resolution >= 0);
  return {
    resolution,
    clusters: [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cell, count]) => {
        const [latitude, longitude] = cellToLatLng(cell);
        return { cell, latitude, longitude, count };
      }),
    locatedCount: located.length,
    pendingCount: rows.filter((r) => r.hasGps && !r.h3Cell).length,
    noGpsCount: rows.filter((r) => !r.hasGps).length,
    polarCount: located.filter(
      (r) => Math.abs(locationCellCenter(r.h3Cell)[0]) > 85.0511287798066,
    ).length,
  };
}
