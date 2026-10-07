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
    listFamilySearchOptions: vi.fn(),
    searchFamilyMedia: vi.fn(async () => []),
    getAlbumMedia: vi.fn(async () => {
      throw new Error("not used");
    }),
    addAlbumMedia: vi.fn(async () => ({
      albumId: "1",
      mediaId: "2",
      created: true,
    })),
    removeAlbumMedia: vi.fn(async () => ({
      albumId: "1",
      mediaId: "2",
      removed: true,
    })),
    putFavorite: vi.fn(async () => ({
      isFavorite: true as const,
      familyId: "1",
      actorMemberId: "3",
    })),
    deleteFavorite: vi.fn(async () => ({
      isFavorite: false as const,
      familyId: "1",
      actorMemberId: "3",
    })),
    putFeatured: vi.fn(async () => ({
      isFamilyFeatured: true as const,
      familyId: "1",
      actorMemberId: "3",
    })),
    deleteFeatured: vi.fn(async () => ({
      isFamilyFeatured: false as const,
      familyId: "1",
      actorMemberId: "3",
    })),
    listMediaTags: vi.fn(async () => []),
    createAndApplyMediaTag: vi.fn(async () => ({
      id: "4",
      name: "Trip",
      familyId: "1",
      actorMemberId: "3",
    })),
    applyMediaTag: vi.fn(async () => ({
      id: "4",
      name: "Trip",
      familyId: "1",
      actorMemberId: "3",
    })),
    removeMediaTag: vi.fn(async () => ({
      removed: true as const,
      familyId: "1",
      actorMemberId: "3",
    })),
    updateMediaNote: vi.fn(async () => ({
      note: "note",
      noteRevision: "2",
      familyId: "1",
      actorMemberId: "3",
    })),
    listMediaComments: vi.fn(async () => []),
    createMediaComment: vi.fn(async () => ({
      id: "5",
      body: "comment",
      createdAt: date,
      author: { memberId: "3", displayName: "Member" },
      canDelete: true,
      familyId: "1",
      actorMemberId: "3",
    })),
    deleteMediaComment: vi.fn(async () => ({
      familyId: "1",
      actorMemberId: "3",
    })),
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

  it("uses the canonical Phase 6C text normalizers once before repository writes", async () => {
    const { service, repository } = setup();
    await service.createTag(context, "1", "2", "  Ｔｒｉｐ\t");
    expect(repository.createAndApplyMediaTag).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Trip",
        normalizedName: Buffer.from("trip"),
      }),
    );
    await service.updateNote(context, "1", "2", "  a\r\nb\r ", "1");
    expect(repository.updateMediaNote).toHaveBeenCalledWith(
      expect.objectContaining({ note: "  a\nb\n ", expectedRevision: "1" }),
    );
    await service.createComment(context, "1", "2", "<b>x</b>\r");
    expect(repository.createMediaComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "<b>x</b>\n" }),
    );
  });

  it("maps invalid Phase 6C text to INVALID_REQUEST", async () => {
    const { service, repository } = setup();
    await expect(
      service.createTag(context, "1", "2", "bad\u200btag"),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_REQUEST",
    });
    await expect(
      service.updateNote(context, "1", "2", "bad\0note", "1"),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_REQUEST",
    });
    await expect(
      service.createComment(context, "1", "2", " \n "),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_REQUEST",
    });
    expect(repository.createAndApplyMediaTag).not.toHaveBeenCalled();
    expect(repository.updateMediaNote).not.toHaveBeenCalled();
    expect(repository.createMediaComment).not.toHaveBeenCalled();
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
        expectedClientType: "WEB",
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
