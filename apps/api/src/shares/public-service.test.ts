import { describe, expect, it, vi } from "vitest";

import { createShareToken } from "@family-album/auth";
import type { ReadyDerivedView } from "@family-album/db";

import { PublicAuthError } from "../auth/service.js";
import { PublicShareService } from "./public-service.js";

const token = createShareToken();
const timelineKey = new Date("2026-01-03T00:00:00.000Z");

function setup() {
  const shares = {
    verifyShareToken: vi.fn(async () => ({
      shareId: "15",
      familyId: "2",
      albumId: "9",
      expiresAt: new Date("2026-02-01T00:00:00.000Z"),
    })),
  };
  const pages = {
    readSharedAlbum: vi.fn(async () => ({
      name: "家庭旅行",
      media: [
        {
          mediaId: "11",
          timelineKey,
          timelineBasis: "UPLOAD_UTC" as const,
          displayWidth: 32,
          displayHeight: 16,
        },
      ],
    })),
    recordAccess: vi.fn(async () => undefined),
  };
  const bytes = Buffer.from("derived-bytes");
  const derived = {
    findReadyDerivedInAlbum: vi.fn(
      async (input: {
        mediaId: string;
        kind: "THUMBNAIL" | "PREVIEW";
      }): Promise<ReadyDerivedView> => ({
        familyId: "2",
        mediaId: input.mediaId,
        generation: 1n,
        kind: input.kind,
        byteSize: BigInt(bytes.length),
        sha256Hex: "ab".repeat(32),
      }),
    ),
  };
  const reader = { read: vi.fn(async () => bytes) };
  return {
    shares,
    pages,
    derived,
    reader,
    bytes,
    service: new PublicShareService(shares, pages, derived, reader),
  };
}

describe("public share service", () => {
  it("returns album display data and one access event", async () => {
    const { service, pages } = setup();
    const opened = await service.openAlbum(token, { limit: 20 });
    expect(opened.album).toEqual({ name: "家庭旅行" });
    expect(opened.media).toEqual([
      {
        mediaId: "11",
        timelineKey: timelineKey.toISOString(),
        timelineBasis: "UPLOAD_UTC",
        displayWidth: 32,
        displayHeight: 16,
        thumbnail: { kind: "thumbnail" },
      },
    ]);
    expect(JSON.stringify(opened)).not.toMatch(
      /familyId|member|storage|original|gps|latitude|permission|token_hash/i,
    );
    expect(pages.recordAccess).toHaveBeenCalledTimes(1);
    expect(pages.recordAccess).toHaveBeenCalledWith({
      familyId: "2",
      shareId: "15",
    });
  });

  it.each(["invalid", "expired", "revoked", "deleted album"])(
    "hides a %s token and writes no access event",
    async () => {
      const { service, shares, pages } = setup();
      shares.verifyShareToken.mockRejectedValue(
        new PublicAuthError(404, "NOT_FOUND"),
      );
      await expect(
        service.openAlbum(token, { limit: 20 }),
      ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
      expect(pages.recordAccess).not.toHaveBeenCalled();
    },
  );

  it("omits a removed placement and does not serve its derived bytes", async () => {
    const { service, pages, derived, reader } = setup();
    pages.readSharedAlbum.mockResolvedValue({ name: "家庭旅行", media: [] });
    derived.findReadyDerivedInAlbum.mockResolvedValue(null as never);
    const opened = await service.openAlbum(token, { limit: 20 });
    expect(opened.media).toEqual([]);
    await expect(
      service.openDerived(token, "11", "thumbnail"),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(reader.read).not.toHaveBeenCalled();
    expect(pages.recordAccess).toHaveBeenCalledTimes(1);
  });

  it("serves thumbnail and preview through the existing reader and rejects original", async () => {
    const { service, reader, pages, bytes } = setup();
    const thumbnail = await service.openDerived(token, "11", "thumbnail");
    const preview = await service.openDerived(token, "11", "preview");
    expect(thumbnail.bytes).toBe(bytes);
    expect(preview.contentType).toBe("image/webp");
    expect(reader.read).toHaveBeenCalledTimes(2);
    const calls = reader.read.mock.calls as unknown as Array<
      [{ kind: string; recipeId: number }]
    >;
    expect(calls.map((call) => call[0].kind)).toEqual(["THUMBNAIL", "PREVIEW"]);
    expect(calls[0]?.[0].recipeId).toBe(1);
    await expect(
      service.openDerived(token, "11", "original"),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    expect(pages.recordAccess).not.toHaveBeenCalled();
  });

  it("hides a missing derived asset", async () => {
    const { service, derived, reader, pages } = setup();
    derived.findReadyDerivedInAlbum.mockResolvedValue(null as never);
    await expect(
      service.openDerived(token, "11", "preview"),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    expect(reader.read).not.toHaveBeenCalled();
    expect(pages.recordAccess).not.toHaveBeenCalled();
  });
});
