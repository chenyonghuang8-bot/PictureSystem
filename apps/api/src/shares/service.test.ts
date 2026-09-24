import { describe, expect, it, vi } from "vitest";

import { createShareToken, hashShareToken } from "@family-album/auth";
import {
  AlbumRepositoryError,
  ShareRepositoryError,
  type ShareTokenRow,
} from "@family-album/db";

import { PublicAuthError, type AuthContext } from "../auth/service.js";
import { ShareService, type ShareRepository } from "./service.js";

const context = {
  identity: { userId: "4", sessionId: "8" },
  tokenHash: Buffer.alloc(32, 3),
} as AuthContext;
const expiresAt = new Date("2026-02-01T00:00:00.000Z");
const serverNow = new Date("2026-01-01T00:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    shareId: "15",
    familyId: "2",
    albumId: "9",
    expiresAt,
    revokedAt: null,
    albumDeleted: false,
    serverNow,
    ...overrides,
  };
}

function setup() {
  const repository = {
    insertShare: vi.fn(async () => ({
      shareId: "15",
      familyId: "2",
      albumId: "9",
      createdAt: serverNow,
      expiresAt,
      revokedAt: null,
    })),
    findByTokenHash: vi.fn(async () => row()),
    listShares: vi.fn(async () => [
      {
        shareId: "15",
        familyId: "2",
        albumId: "9",
        createdAt: serverNow,
        expiresAt,
        revokedAt: null,
      },
    ]),
    revokeShare: vi.fn(async () => ({
      shareId: "15",
      familyId: "2",
      albumId: "9",
      createdAt: serverNow,
      expiresAt,
      revokedAt: new Date("2026-01-02T00:00:00.000Z"),
    })),
  } satisfies ShareRepository;
  return { repository, service: new ShareService(repository) };
}

describe("share service", () => {
  it("returns the raw token only from create and stores the hash", async () => {
    const { repository, service } = setup();
    const created = await service.createShare(context, "9", expiresAt);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created).toEqual({
      shareId: "15",
      albumId: "9",
      token: created.token,
      expiresAt,
    });
    const hash = (
      repository.insertShare.mock.calls as unknown as Array<
        [{ tokenHash: Buffer }]
      >
    )[0]?.[0].tokenHash;
    expect(hash).toEqual(hashShareToken(created.token));
    expect(hash?.toString("utf8")).not.toContain(created.token);
  });

  it("returns a capability without the token hash", async () => {
    const { service } = setup();
    await expect(service.verifyShareToken(createShareToken())).resolves.toEqual(
      {
        shareId: "15",
        familyId: "2",
        albumId: "9",
        expiresAt,
      },
    );
  });

  it.each<[string, ShareTokenRow | null]>([
    ["missing", null],
    ["expired", row({ expiresAt: serverNow })],
    ["revoked", row({ revokedAt: serverNow })],
    ["deleted album", row({ albumDeleted: true })],
  ])("hides a %s token as not found", async (_name, found) => {
    const { repository, service } = setup();
    repository.findByTokenHash.mockResolvedValue(found as never);
    const error = await service
      .verifyShareToken(createShareToken())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    expect(error).toBeInstanceOf(PublicAuthError);
    expect((error as Error).message).toBe("NOT_FOUND");
  });

  it("does not look up a malformed token", async () => {
    const { repository, service } = setup();
    await expect(service.verifyShareToken("short")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
    expect(repository.findByTokenHash).not.toHaveBeenCalled();
  });

  it.each([
    ["create", "FORBIDDEN", 403],
    ["create", "NOT_FOUND", 404],
    ["revoke", "FORBIDDEN", 403],
    ["revoke", "NOT_FOUND", 404],
  ] as const)(
    "preserves %s permission result %s",
    async (action, reason, status) => {
      const { repository, service } = setup();
      const failure = new AlbumRepositoryError(reason);
      if (action === "create")
        repository.insertShare.mockRejectedValue(failure);
      else repository.revokeShare.mockRejectedValue(failure);
      const run =
        action === "create"
          ? service.createShare(context, "9", expiresAt)
          : service.revokeShare(context, "15");
      await expect(run).rejects.toMatchObject({
        statusCode: status,
        code: reason,
      });
    },
  );

  it("lists share metadata without a token", async () => {
    const { service } = setup();
    const listed = await service.listShares(context, {
      familyId: "2",
      limit: 20,
    });
    expect(listed).toEqual([
      {
        shareId: "15",
        albumId: "9",
        createdAt: serverNow,
        expiresAt,
        revokedAt: null,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("token");
  });

  it("maps an expiry rejection without exposing the token", async () => {
    const { repository, service } = setup();
    repository.insertShare.mockRejectedValue(
      new ShareRepositoryError("INVALID_EXPIRY"),
    );
    await expect(
      service.createShare(context, "9", expiresAt),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_REQUEST" });
  });
});
