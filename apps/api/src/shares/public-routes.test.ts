import { describe, expect, it, vi } from "vitest";

import { createShareToken } from "@family-album/auth";
import { assertSensitiveCategoryAbsent } from "../../../../tests/helpers/security-assertions.js";

import { createApp } from "../app.js";
import { PublicAuthError } from "../auth/service.js";
import type { PublicShareService } from "./public-service.js";

const token = createShareToken();

function setup() {
  const publicShareService = {
    openAlbum: vi.fn(async () => ({
      shareId: "15",
      album: { name: "家庭旅行" },
      media: [
        {
          mediaId: "11",
          timelineKey: "2026-01-03T00:00:00.000Z",
          timelineBasis: "UPLOAD_UTC",
          displayWidth: 32,
          displayHeight: 16,
          thumbnail: { kind: "thumbnail" },
        },
      ],
      nextCursor: null,
    })),
    openDerived: vi.fn(
      async (_token: unknown, _mediaId: string, kind: string) => {
        if (kind !== "thumbnail" && kind !== "preview") {
          throw new PublicAuthError(404, "NOT_FOUND");
        }
        return {
          bytes: Buffer.from("webp"),
          contentType: "image/webp" as const,
        };
      },
    ),
  } as unknown as PublicShareService;
  return {
    publicShareService,
    app: createApp({
      authService: {
        authenticate: vi.fn(),
      } as never,
      publicShareService,
      trustedOrigins: new Set(["https://localhost:3000"]),
    }),
  };
}

describe("public share routes", () => {
  it("returns a private album page without family or storage fields", async () => {
    const { app, publicShareService } = setup();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/share/${token}`,
      headers: { cookie: `__Host-family_session=ignored` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.json()).toEqual({
      album: { name: "家庭旅行" },
      media: [
        {
          mediaId: "11",
          timelineKey: "2026-01-03T00:00:00.000Z",
          timelineBasis: "UPLOAD_UTC",
          displayWidth: 32,
          displayHeight: 16,
          thumbnail: { kind: "thumbnail" },
        },
      ],
      nextCursor: null,
    });
    assertSensitiveCategoryAbsent(JSON.stringify(response.json()), {
      category: "share-token",
      secret: token,
    });
    const call = vi.mocked(publicShareService.openAlbum).mock.calls[0];
    expect(call?.[0] === token && call?.[1]?.limit === 20).toBe(true);
    await app.close();
  });

  it("returns the exact same public keys with or without a session cookie", async () => {
    const { app } = setup();
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/v1/share/${token}`,
    });
    const authenticated = await app.inject({
      method: "GET",
      url: `/api/v1/share/${token}`,
      headers: { cookie: "__Host-family_session=present-but-irrelevant" },
    });
    expect(Object.keys(anonymous.json())).toEqual([
      "album",
      "media",
      "nextCursor",
    ]);
    expect(Object.keys(anonymous.json().media[0])).toEqual([
      "mediaId",
      "timelineKey",
      "timelineBasis",
      "displayWidth",
      "displayHeight",
      "thumbnail",
    ]);
    expect(authenticated.json()).toEqual(anonymous.json());
    await app.close();
  });

  it("serves thumbnail bytes and rejects original as not found", async () => {
    const { app } = setup();
    const thumbnail = await app.inject({
      method: "GET",
      url: `/api/v1/share/${token}/media/11/derived/thumbnail`,
    });
    const original = await app.inject({
      method: "GET",
      url: `/api/v1/share/${token}/media/11/derived/original`,
    });
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.headers["content-type"]).toBe("image/webp");
    expect(thumbnail.headers["cache-control"]).toBe("private, no-store");
    expect(thumbnail.body).toBe("webp");
    expect(original.statusCode).toBe(404);
    expect(original.json().code).toBe("NOT_FOUND");
    assertSensitiveCategoryAbsent(JSON.stringify(original.json()), {
      category: "share-token",
      secret: token,
    });
    await app.close();
  });

  it("uses one not-found response for a rejected share", async () => {
    const { app, publicShareService } = setup();
    publicShareService.openAlbum = vi.fn(async () => {
      throw new PublicAuthError(404, "NOT_FOUND");
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/share/${token}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe(
      "The requested resource was not found.",
    );
    expect(JSON.stringify(response.json())).not.toMatch(
      /expired|revoked|family|token/i,
    );
    await app.close();
  });
});
