import { it, expect } from "vitest";
import { mapProvider, mapResourceRequest } from "./map-provider.js";
it("supports explicit disable and refuses third-party or credential-bearing resources", () => {
  expect(mapProvider("disabled")).toBeNull();
  const config = mapProvider(undefined)!;
  expect(config.style).toBe("https://tiles.openfreemap.org/styles/liberty");
  expect(mapResourceRequest(config.style, config.origin)).toEqual({
    url: config.style,
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
  });
  for (const url of [
    "https://geocoder.example/query",
    "http://tiles.openfreemap.org/foo",
    "https://user:pass@tiles.openfreemap.org/foo",
  ])
    expect(() => mapResourceRequest(url, config.origin)).toThrow();
  for (const value of [
    "http://example.com/style",
    "https://user:pass@example.com/style",
    "https://example.com/style?private=1",
  ])
    expect(() => mapProvider(value)).toThrow();
});
