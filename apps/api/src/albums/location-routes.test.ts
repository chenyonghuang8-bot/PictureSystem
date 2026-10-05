import { describe, it, expect, vi } from "vitest";
import { createSessionToken } from "@family-album/auth";
import type { MySqlAlbumRepository } from "@family-album/db";
import { createApp } from "../app.js";
import { AlbumService, type AlbumRepository } from "./service.js";
import type { AuthService } from "../auth/service.js";
import type { Phase1CService } from "../phase1c/service.js";
import { loadLocationProjector } from "@family-album/media";
import { resolve } from "node:path";
import {
  familyMapPageSchema,
  familyLocationOptionsPageSchema,
} from "@family-album/contracts";
const token = createSessionToken();
function setup() {
  const projector = loadLocationProjector(
    resolve("resources/location/2026-10-03"),
  );
  const p = projector.project("37.78", "-122.42");
  const repository = {
    locationProjector: projector,
    locationFamilyMedia: vi.fn(async () => [
      {
        mediaId: "11",
        albumId: "3",
        timelineKey: new Date("2024-01-01"),
        timelineBasis: "UPLOAD_UTC" as const,
        displayWidth: 1,
        displayHeight: 1,
        isFavorite: false,
        isFamilyFeatured: false,
        hasGps: true,
        ...p,
      },
    ]),
    searchFamilyMedia: vi.fn(),
  } as unknown as AlbumRepository & {
    locationProjector: typeof projector;
    locationFamilyMedia: MySqlAlbumRepository["locationFamilyMedia"];
  };
  const auth = {
    authenticate: vi.fn(async () => ({
      identity: { userId: "7", sessionId: "8" },
      tokenHash: Buffer.alloc(32),
    })),
  } as unknown as AuthService;
  return {
    repository,
    app: createApp({
      authService: auth,
      albumService: new AlbumService(repository),
      phase1cService: {} as Phase1CService,
      trustedOrigins: new Set(["https://localhost:3000"]),
    }),
  };
}
describe("Phase8 map route whitelist and strict boundary", () => {
  it("serves only coarse map DTOs with private no-store and applies the complete contract", async () => {
    const { app, repository } = setup();
    try {
      const r = await app.inject({
        method: "GET",
        url: "/api/v1/families/4/search/map?location=country%3AUS&filename=Caf%C3%A9&favoritesOnly=true&albumId=3&tagId=2&uploaderMemberId=7&fromDate=2024-01-01&toDate=2024-01-31",
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(r.statusCode).toBe(200);
      expect(r.headers["cache-control"]).toBe("private, no-store");
      const dto = familyMapPageSchema.parse(r.json());
      expect(dto.locatedCount).toBe(1);
      expect(r.body).not.toContain("37.780000");
      expect(r.body).not.toContain("gpsLatitude");
      expect(repository.locationFamilyMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({
            location: "country:US",
            filename: "Café",
            favoritesOnly: true,
            albumId: "3",
            tagId: "2",
            uploaderMemberId: "7",
          }),
        }),
      );
    } finally {
      await app.close();
    }
  });
  it("rejects malformed, duplicate, fine-resolution and GPS query parameters before repository calls", async () => {
    const { app, repository } = setup();
    try {
      for (const query of [
        "bbox=0,0,181,90",
        "zoom=23",
        "location=cell:7:872830828ffffff",
        "bbox=0,0,1,1&bbox=2,2,3,3",
        "gpsLatitude=1",
        "filename=x&filename=y",
      ]) {
        const r = await app.inject({
          method: "GET",
          url: "/api/v1/families/4/search/map?" + query,
          headers: { cookie: `__Host-family_session=${token}` },
        });
        expect(r.statusCode).toBe(400);
        expect(r.headers["cache-control"]).toBe("private, no-store");
      }
      expect(repository.locationFamilyMedia).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("paginates regions with actor/filter/version bound cursor and keeps disabled location capability separate", async () => {
    const { app } = setup();
    try {
      const r = await app.inject({
        method: "GET",
        url: "/api/v1/families/4/search/locations?kind=city",
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(r.statusCode).toBe(200);
      expect(
        familyLocationOptionsPageSchema.parse(r.json()).options[0]!.name,
      ).toMatch(/附近$/);
      const bad = await app.inject({
        method: "GET",
        url: "/api/v1/families/4/search/locations?kind=country&cursor=e30",
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
