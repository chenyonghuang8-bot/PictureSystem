import { describe, expect, it, vi } from "vitest";

import {
  AlbumRepositoryError,
  CommitOutcomeUnknownError,
} from "@family-album/db";

import type { AuthContext } from "../auth/service.js";
import { AlbumService, type AlbumRepository } from "./service.js";

const context = {
  identity: { userId: "9007199254740993", sessionId: "2" },
  tokenHash: Buffer.alloc(32, 1),
} as AuthContext;
const date = new Date("2026-01-01T00:00:00.000Z");

function setup() {
  const album = {
    id: "9007199254740995",
    familyId: "9007199254740994",
    ownerMemberId: "3",
    name: "Album",
    description: null,
    visibility: "CUSTOM" as const,
    revision: "1",
    createdAt: date,
    updatedAt: date,
    effectivePermissions: {
      canView: true,
      canUpload: true,
      canEdit: true,
      canDelete: true,
      canManageMembers: true,
    },
  };
  const repository = {
    createAlbum: vi.fn(async () => ({ ...album, actorMemberId: "3" })),
    listAlbums: vi.fn(async () => [album]),
    getAlbum: vi.fn(async () => album),
    updateAlbum: vi.fn(async () => ({
      ...album,
      revision: "2",
      actorMemberId: "3",
      changedFields: ["name"],
    })),
    softDeleteAlbum: vi.fn(async () => ({
      actorMemberId: "3",
      familyId: album.familyId,
      revision: "2",
    })),
    listAlbumMembers: vi.fn(async () => []),
    putAlbumMember: vi.fn(async () => ({
      actorMemberId: "3",
      familyId: album.familyId,
      revision: "2",
      action: "ADDED" as const,
    })),
    removeAlbumMember: vi.fn(async () => ({
      actorMemberId: "3",
      familyId: album.familyId,
      revision: "2",
      changed: true,
    })),
    listAlbumMedia: vi.fn(async () => []),
    listFamilyTimeline: vi.fn(async () => []),
    getAlbumMedia: vi.fn(async () => {
      throw new Error("not used");
    }),
  } satisfies AlbumRepository;
  return { album, repository, service: new AlbumService(repository) };
}

describe("AlbumService", () => {
  it("normalizes allowed text without normalizing descriptions", async () => {
    const { service, repository } = setup();
    await service.create(context, {
      familyId: "1",
      name: "  Family  ",
      description: "  preserved\n",
      visibility: "CUSTOM",
    });
    expect(repository.createAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: "1",
        name: "Family",
        description: "  preserved\n",
      }),
    );
  });

  it("rejects malformed, NUL and overlong album text", async () => {
    const { service } = setup();
    await expect(
      service.create(context, {
        familyId: "1",
        name: "\ud800",
        visibility: "CUSTOM",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      service.create(context, {
        familyId: "1",
        name: "bad\0name",
        visibility: "CUSTOM",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("maps non-disclosure, conflicts and commit ambiguity", async () => {
    const { service, repository } = setup();
    repository.getAlbum.mockRejectedValueOnce(
      new AlbumRepositoryError("NOT_FOUND"),
    );
    await expect(service.get(context, "1")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
    repository.updateAlbum.mockRejectedValueOnce(
      new AlbumRepositoryError("CONFLICT"),
    );
    await expect(
      service.update(context, "1", {
        expectedRevision: "1",
        name: "Updated",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    repository.softDeleteAlbum.mockRejectedValueOnce(
      new CommitOutcomeUnknownError(),
    );
    await expect(service.remove(context, "1", "1")).rejects.toMatchObject({
      statusCode: 503,
      errorCategory: "COMMIT_OUTCOME_UNKNOWN",
    });
  });

  it("preserves hidden-versus-visible mutation error semantics", async () => {
    const { service, repository } = setup();
    repository.putAlbumMember.mockRejectedValueOnce(
      new AlbumRepositoryError("NOT_FOUND"),
    );
    await expect(
      service.putMember(context, "4", "6", {
        expectedRevision: "1",
        ...{
          canView: true,
          canUpload: false,
          canEdit: false,
          canDelete: false,
          canManageMembers: false,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });

    repository.softDeleteAlbum.mockRejectedValueOnce(
      new AlbumRepositoryError("FORBIDDEN"),
    );
    await expect(service.remove(context, "4", "1")).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });
  });

  it("forwards only the complete ACL grant and expected revision", async () => {
    const { service, repository } = setup();
    await service.putMember(context, "4", "6", {
      expectedRevision: "1",
      canView: true,
      canUpload: false,
      canEdit: true,
      canDelete: false,
      canManageMembers: false,
    });
    expect(repository.putAlbumMember).toHaveBeenCalledWith({
      actor: {
        userId: context.identity.userId,
        sessionId: context.identity.sessionId,
        tokenHash: context.tokenHash,
      },
      albumId: "4",
      targetMemberId: "6",
      expectedRevision: "1",
      permissions: {
        canView: true,
        canUpload: false,
        canEdit: true,
        canDelete: false,
        canManageMembers: false,
      },
    });
  });
});
