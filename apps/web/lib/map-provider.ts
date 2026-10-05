// Only ordinary interactive basemap requests are allowed; private overlays are
// local DOM markers. No geocoder, remote GeoJSON, telemetry, or fallback provider.
export function mapProvider(value: string | undefined) {
  if (value === "disabled") return null;
  const url = new URL(value ?? "https://tiles.openfreemap.org/styles/liberty");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("MAP_PROVIDER_INVALID");
  return { style: url.href, origin: url.origin };
}
export function mapResourceRequest(url: string, origin: string) {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.origin !== origin ||
    target.username ||
    target.password
  )
    throw new Error("MAP_RESOURCE_REFUSED");
  return {
    url: target.href,
    credentials: "same-origin" as const,
    referrerPolicy: "no-referrer" as const,
  };
}
