import { describe, expect, it, vi } from "vitest";

import { createSessionToken } from "@family-album/auth";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import { DerivedReadService } from "./service.js";

const token = createSessionToken();

function setup(serve: ReturnType<typeof vi.fn>) {
  const authService = {
    authenticate: vi.fn(async () => ({
      identity: { userId: "7", sessionId: "8" },
      tokenHash: Buffer.alloc(32),
    })),
  } as unknown as AuthService;
  const derivedService = { serve } as unknown as DerivedReadService;
  return {
    authService,
    app: createApp({
      authService,
      derivedService,
      trustedOrigins: new Set(["https://localhost:3000"]),
    }),
  };
}

describe("derived asset routes", () => {
  it("rejects a request with no session before authorization", async () => {
    const serve = vi.fn();
    const { app, authService } = setup(serve);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/media/11/derived/thumbnail",
    });
    expect(response.statusCode).toBe(401);
    expect(authService.authenticate).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects kind and media id values that are not canonical identifiers", async () => {
    const serve = vi.fn();
    const { app } = setup(serve);
    for (const url of [
      "/api/v1/media/11/derived/original",
      "/api/v1/media/11/derived/../originals",
      "/api/v1/media/11/derived/thumbnail.webp",
      "/api/v1/media/../derived/thumbnail",
      "/api/v1/media/0/derived/preview",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(response.statusCode === 400 || response.statusCode === 404).toBe(
        true,
      );
    }
    expect(serve).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the derived bytes with type, length, and a private cache policy", async () => {
    const bytes = Buffer.from("webp-bytes");
    const serve = vi.fn(async () => ({
      bytes,
      contentType: "image/webp" as const,
      familyId: "4",
    }));
    const { app } = setup(serve);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/media/11/derived/preview?path=/tmp/original",
      headers: { cookie: `__Host-family_session=${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.headers["content-length"]).toBe(String(bytes.length));
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.rawPayload.equals(bytes)).toBe(true);
    expect(serve).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ userId: "7" }) }),
      "11",
      "preview",
    );
    await app.close();
  });
});
