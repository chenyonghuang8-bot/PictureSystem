import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cellToLatLng,
  cellToParent,
  getResolution,
  isValidCell,
  latLngToCell,
} from "h3-js";

export const LOCATION_POLICY_VERSION = 1;
export const LOCATION_POLICY =
  "h3-js@4.5.0/res6/center-only/ambiguous-country-unknown/haversine-6371008.8/city<=50000m/numeric-id-tie/v1";
export type LocationProjection = {
  policyVersion: number;
  datasetVersion: string;
  h3Cell: string;
  countryCode: string | null;
  cityGeonameId: string | null;
};
export type CountryShape = {
  code: string | null;
  name: string;
  polygons: number[][][][];
};
export type NearbyCity = {
  id: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
};
export function locationCellCenter(cell: string) {
  if (
    !/^[0-9a-f]{15}$/.test(cell) ||
    !isValidCell(cell) ||
    getResolution(cell) !== 6
  )
    throw new Error("LOCATION_CELL_INVALID");
  return cellToLatLng(cell);
}
export function locationLogicalParent(cell: string, resolution: number) {
  locationCellCenter(cell);
  if (!Number.isInteger(resolution) || resolution < 0 || resolution > 6)
    throw new Error("LOCATION_RESOLUTION_INVALID");
  return cellToParent(cell, resolution);
}
export function greatCircleMeters(a: readonly number[], b: readonly number[]) {
  const rad = Math.PI / 180,
    dlat = (b[0]! - a[0]!) * rad,
    dlng = (b[1]! - a[1]!) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a[0]! * rad) * Math.cos(b[0]! * rad) * Math.sin(dlng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
type PreparedRing = {
  points: number[][];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};
function prepareRing(ring: number[][]): PreparedRing {
  const points: number[][] = [];
  let previous = ring[0]?.[0] ?? 0,
    minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const raw of ring) {
    let x = raw[0]!;
    while (x - previous > 180) x -= 360;
    while (x - previous < -180) x += 360;
    const y = raw[1]!;
    points.push([x, y]);
    previous = x;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { points, minX, maxX, minY, maxY };
}
function ringContains(ring: PreparedRing, lat: number, lng: number) {
  if (ring.points.length < 4 || lat < ring.minY || lat > ring.maxY)
    return false;
  const x = lng + 360 * Math.round(((ring.minX + ring.maxX) / 2 - lng) / 360);
  if (x < ring.minX || x > ring.maxX) return false;
  let inside = false;
  const points = ring.points;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j]!,
      b = points[i]!;
    const cross =
      (x - a[0]!) * (b[1]! - a[1]!) - (lat - a[1]!) * (b[0]! - a[0]!);
    if (
      Math.abs(cross) < 1e-10 &&
      x >= Math.min(a[0]!, b[0]!) - 1e-10 &&
      x <= Math.max(a[0]!, b[0]!) + 1e-10 &&
      lat >= Math.min(a[1]!, b[1]!) - 1e-10 &&
      lat <= Math.max(a[1]!, b[1]!) + 1e-10
    )
      return true;
    if (
      a[1]! > lat !== b[1]! > lat &&
      x < ((b[0]! - a[0]!) * (lat - a[1]!)) / (b[1]! - a[1]!) + a[0]!
    )
      inside = !inside;
  }
  return inside;
}
export class LocationProjector {
  readonly policyVersion = LOCATION_POLICY_VERSION;
  private readonly countryNames = new Map<string, string>();
  private readonly shapes: {
    code: string | null;
    polygons: PreparedRing[][];
  }[] = [];
  private readonly citiesByCountry = new Map<string, NearbyCity[]>();
  private readonly cityById = new Map<string, NearbyCity>();
  constructor(
    readonly datasetVersion: string,
    countries: readonly CountryShape[],
    cities: readonly NearbyCity[],
  ) {
    if (!/^[a-f0-9]{64}$/.test(datasetVersion))
      throw new Error("LOCATION_DATASET_INVALID");
    for (const country of countries) {
      this.shapes.push({
        code: country.code,
        polygons: country.polygons.map((p) => p.map(prepareRing)),
      });
      if (country.code) this.countryNames.set(country.code, country.name);
      for (const polygon of country.polygons)
        for (const ring of polygon)
          for (const pair of ring)
            if (
              pair.length !== 2 ||
              !Number.isFinite(pair[0]) ||
              !Number.isFinite(pair[1]) ||
              Math.abs(pair[0]!) > 180 ||
              Math.abs(pair[1]!) > 90
            )
              throw new Error("LOCATION_DATASET_INVALID");
    }
    for (const city of cities) {
      if (
        !/^[1-9][0-9]*$/.test(city.id) ||
        !city.name ||
        !/^[A-Z]{2}$/.test(city.country) ||
        !Number.isFinite(city.lat) ||
        !Number.isFinite(city.lng) ||
        Math.abs(city.lat) > 90 ||
        Math.abs(city.lng) > 180 ||
        this.cityById.has(city.id)
      )
        throw new Error("LOCATION_DATASET_INVALID");
      this.cityById.set(city.id, city);
      const group = this.citiesByCountry.get(city.country) ?? [];
      group.push(city);
      this.citiesByCountry.set(city.country, group);
    }
  }
  project(latitude: string, longitude: string): LocationProjection {
    const lat = Number(latitude),
      lng = Number(longitude);
    if (
      !latitude.trim() ||
      !longitude.trim() ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      throw new Error("LOCATION_GPS_INVALID");
    const h3Cell = latLngToCell(lat, lng === 180 ? -180 : lng, 6);
    const center = locationCellCenter(h3Cell);
    const matched = this.shapes.filter((country) =>
      country.polygons.some(
        (p) =>
          ringContains(p[0]!, center[0], center[1]) &&
          !p.slice(1).some((h) => ringContains(h, center[0], center[1])),
      ),
    );
    const countryCode = matched.length === 1 ? matched[0]!.code : null;
    let nearest: NearbyCity | undefined,
      best = 50000;
    if (countryCode)
      for (const city of this.citiesByCountry.get(countryCode) ?? []) {
        if (Math.abs(city.lat - center[0]) > 0.5) continue;
        const distance = greatCircleMeters(center, [city.lat, city.lng]);
        if (
          distance < best ||
          (distance === best &&
            (!nearest || BigInt(city.id) < BigInt(nearest.id)))
        ) {
          nearest = city;
          best = distance;
        }
      }
    return {
      policyVersion: this.policyVersion,
      datasetVersion: this.datasetVersion,
      h3Cell,
      countryCode,
      cityGeonameId: nearest?.id ?? null,
    };
  }
  countryName(code: string | null) {
    return code ? (this.countryNames.get(code) ?? null) : null;
  }
  cityName(id: string | null) {
    return id ? (this.cityById.get(id)?.name ?? null) : null;
  }
}
export function loadLocationProjector(directory: string): LocationProjector {
  const manifestBytes = readFileSync(join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    policy: string;
    normalization: string;
    files: Record<string, string>;
  };
  if (
    manifest.policy !== LOCATION_POLICY ||
    manifest.normalization !==
      "naturalearth-iso-a2-eh-geonames-cities1000-v2-dbf-null-padding" ||
    !manifest.files
  )
    throw new Error("LOCATION_MANIFEST_INVALID");
  for (const name of ["countries.json", "cities.json"]) {
    const bytes = readFileSync(join(directory, name));
    if (
      createHash("sha256").update(bytes).digest("hex") !== manifest.files[name]
    )
      throw new Error("LOCATION_CHECKSUM_INVALID");
  }
  const datasetVersion = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  return new LocationProjector(
    datasetVersion,
    JSON.parse(readFileSync(join(directory, "countries.json"), "utf8")),
    JSON.parse(readFileSync(join(directory, "cities.json"), "utf8")),
  );
}
