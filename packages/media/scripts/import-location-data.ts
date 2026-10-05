import { read } from "shapefile";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { LOCATION_POLICY } from "../src/location-projection.js";
const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2] || process.argv.length !== 3)
  throw new Error("LOCATION_IMPORT_DIRECTORY_REQUIRED");
const hash = (name: string) =>
  createHash("sha256")
    .update(readFileSync(join(directory, name)))
    .digest("hex");
if (
  readFileSync(
    join(directory, "ne_10m_admin_0_countries.VERSION.txt"),
    "utf8",
  ).trim() !== "5.1.1"
)
  throw new Error("NATURAL_EARTH_VERSION_INVALID");
const codes = new Set(
  readFileSync(join(directory, "countryInfo.txt"), "utf8")
    .split(/\r?\n/)
    .filter((x) => x && !x.startsWith("#"))
    .map((line) => line.split("\t")[0]!),
);
const data = await read(
  join(directory, "ne_10m_admin_0_countries.shp"),
  join(directory, "ne_10m_admin_0_countries.dbf"),
);
const countries = data.features.map((feature) => {
  const properties = feature.properties as Record<string, unknown>;
  const code =
    typeof properties.ISO_A2_EH === "string"
      ? properties.ISO_A2_EH.replace(/\0+$/u, "").trim()
      : null;
  const geometry = feature.geometry;
  if (
    !geometry ||
    (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
  )
    throw new Error("COUNTRY_GEOMETRY_INVALID");
  return {
    code: typeof code === "string" && codes.has(code) ? code : null,
    name: String(properties.NAME_EN ?? properties.NAME)
      .replace(/\0+$/u, "")
      .trim(),
    polygons:
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates,
  };
});
const cities = readFileSync(join(directory, "cities1000.txt"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const row = line.split("\t");
    if (row.length !== 19) throw new Error("GEONAMES_ROW_INVALID");
    return {
      id: row[0],
      name: row[1],
      lat: Number(row[4]),
      lng: Number(row[5]),
      country: row[8],
    };
  });
if (countries.length < 200 || cities.length < 100000)
  throw new Error("LOCATION_DATASET_INCOMPLETE");
writeFileSync(
  join(directory, "countries.json"),
  JSON.stringify(countries) + "\n",
);
writeFileSync(join(directory, "cities.json"), JSON.stringify(cities) + "\n");
const manifest = {
  policy: LOCATION_POLICY,
  normalization:
    "naturalearth-iso-a2-eh-geonames-cities1000-v2-dbf-null-padding",
  naturalEarthVersion: "5.1.1",
  importedAt: new Date().toISOString(),
  sources: {
    naturalEarth:
      "https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_0_countries.zip",
    geoNames: "https://download.geonames.org/export/dump/cities1000.zip",
    countryCodes: "https://download.geonames.org/export/dump/countryInfo.txt",
  },
  licenses: { naturalEarth: "public-domain", geoNames: "CC-BY-4.0" },
  files: Object.fromEntries(
    [
      "countries.zip",
      "cities1000.zip",
      "countryInfo.txt",
      "countries.json",
      "cities.json",
    ].map((n) => [n, hash(n)]),
  ),
  counts: { countries: countries.length, cities: cities.length },
};
writeFileSync(
  join(directory, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(JSON.stringify(manifest.counts));
