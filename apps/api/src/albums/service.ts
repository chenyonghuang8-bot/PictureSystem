import { countCodePoints, hasMalformedUnicode } from "@family-album/auth";
import {
  AlbumRepositoryError,
  CommitOutcomeUnknownError,
  type AlbumMediaRecord,
  type MySqlAlbumRepository,
  TransactionRollbackFailedError,
} from "@family-album/db";
import {
  galleryCursorSchema,
  type AlbumVisibility,
  type PutAlbumMemberRequest,
  type UpdateAlbumRequest,
} from "@family-album/contracts";

import { PublicAuthError, type AuthContext } from "../auth/service.js";

export type AlbumRepository = Pick<
  MySqlAlbumRepository,
  | "createAlbum"
  | "listAlbums"
  | "getAlbum"
  | "updateAlbum"
  | "softDeleteAlbum"
  | "listAlbumMembers"
  | "putAlbumMember"
  | "removeAlbumMember"
  | "listAlbumMedia"
  | "getAlbumMedia"
  | "addAlbumMedia"
  | "removeAlbumMedia"
  | "listFamilyTimeline"
>;

export class AlbumService {
  constructor(private readonly repository: AlbumRepository) {}

  async create(
    context: AuthContext,
    input: {
      familyId: string;
      name: unknown;
      description?: unknown;
      visibility: AlbumVisibility;
    },
  ) {
    return this.database(() =>
      this.repository.createAlbum({
        actor: actor(context),
        familyId: input.familyId,
        name: validateAlbumName(input.name),
        description: validateAlbumDescription(input.description),
        visibility: input.visibility,
      }),
    );
  }

  async list(
    context: AuthContext,
    input: {
      familyId: string;
      afterId?: string;
      limit: number;
    },
  ) {
    return this.database(() =>
      this.repository.listAlbums({ actor: actor(context), ...input }),
    );
  }

  async get(context: AuthContext, albumId: string) {
    return this.database(() =>
      this.repository.getAlbum({ actor: actor(context), albumId }),
    );
  }

  async listTimeline(
    context: AuthContext,
    familyId: string,
    input: { limit: number; cursor?: { timelineKey: Date; mediaId: string } },
  ) {
    return this.database(() =>
      this.repository.listFamilyTimeline({
        actor: actor(context),
        familyId,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      }),
    );
  }

  async listMedia(
    context: AuthContext,
    albumId: string,
    input: { limit: number; cursor?: { timelineKey: Date; mediaId: string } },
  ) {
    return this.database(() =>
      this.repository.listAlbumMedia({
        actor: actor(context),
        albumId,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      }),
    );
  }

  async addMedia(context: AuthContext, albumId: string, mediaId: string) {
    return this.database(() =>
      this.repository.addAlbumMedia({
        actor: actor(context),
        albumId,
        mediaId,
      }),
    );
  }

  async removeMedia(context: AuthContext, albumId: string, mediaId: string) {
    return this.database(() =>
      this.repository.removeAlbumMedia({
        actor: actor(context),
        albumId,
        mediaId,
      }),
    );
  }

  async getMedia(context: AuthContext, albumId: string, mediaId: string) {
    return this.database(() =>
      this.repository.getAlbumMedia({
        actor: actor(context),
        albumId,
        mediaId,
      }),
    );
  }

  async update(
    context: AuthContext,
    albumId: string,
    input: UpdateAlbumRequest,
  ) {
    return this.database(() =>
      this.repository.updateAlbum({
        actor: actor(context),
        albumId,
        expectedRevision: input.expectedRevision,
        ...(input.name !== undefined
          ? { name: validateAlbumName(input.name) }
          : {}),
        ...(input.description !== undefined
          ? { description: validateAlbumDescription(input.description) }
          : {}),
        ...(input.visibility !== undefined
          ? { visibility: input.visibility }
          : {}),
      }),
    );
  }

  async remove(
    context: AuthContext,
    albumId: string,
    expectedRevision: string,
  ) {
    return this.database(() =>
      this.repository.softDeleteAlbum({
        actor: actor(context),
        albumId,
        expectedRevision,
      }),
    );
  }

  async listMembers(context: AuthContext, albumId: string) {
    return this.database(() =>
      this.repository.listAlbumMembers({ actor: actor(context), albumId }),
    );
  }

  async putMember(
    context: AuthContext,
    albumId: string,
    targetMemberId: string,
    input: PutAlbumMemberRequest,
  ) {
    return this.database(() =>
      this.repository.putAlbumMember({
        actor: actor(context),
        albumId,
        targetMemberId,
        expectedRevision: input.expectedRevision,
        permissions: {
          canView: input.canView,
          canUpload: input.canUpload,
          canEdit: input.canEdit,
          canDelete: input.canDelete,
          canManageMembers: input.canManageMembers,
        },
      }),
    );
  }

  async removeMember(
    context: AuthContext,
    albumId: string,
    targetMemberId: string,
    expectedRevision: string,
  ) {
    return this.database(() =>
      this.repository.removeAlbumMember({
        actor: actor(context),
        albumId,
        targetMemberId,
        expectedRevision,
      }),
    );
  }

  private async database<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PublicAuthError) throw error;
      if (error instanceof CommitOutcomeUnknownError) {
        throw new PublicAuthError(
          503,
          "SERVICE_UNAVAILABLE",
          undefined,
          "COMMIT_OUTCOME_UNKNOWN",
        );
      }
      if (error instanceof TransactionRollbackFailedError) {
        throw new PublicAuthError(
          503,
          "SERVICE_UNAVAILABLE",
          undefined,
          "ROLLBACK_FAILED",
        );
      }
      if (error instanceof AlbumRepositoryError) {
        if (error.reason === "UNAUTHENTICATED")
          throw new PublicAuthError(401, "UNAUTHENTICATED");
        if (error.reason === "FORBIDDEN")
          throw new PublicAuthError(403, "FORBIDDEN");
        if (error.reason === "NOT_FOUND")
          throw new PublicAuthError(404, "NOT_FOUND");
        throw new PublicAuthError(409, "CONFLICT");
      }
      throw new PublicAuthError(
        503,
        "SERVICE_UNAVAILABLE",
        undefined,
        "DATABASE_FAILURE",
      );
    }
  }
}

export function decodeGalleryCursor(cursor: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new PublicAuthError(400, "INVALID_REQUEST");
  }
  const result = galleryCursorSchema.safeParse(parsed);
  if (!result.success) throw new PublicAuthError(400, "INVALID_REQUEST");
  const timelineKey = new Date(result.data.timelineKey);
  if (Number.isNaN(timelineKey.getTime())) {
    throw new PublicAuthError(400, "INVALID_REQUEST");
  }
  return { timelineKey, mediaId: result.data.mediaId };
}

export function familyTimelineItem(row: {
  mediaId: string;
  albumId: string;
  timelineKey: Date;
  timelineBasis: AlbumMediaRecord["timelineBasis"];
  displayWidth: number | null;
  displayHeight: number | null;
}) {
  return {
    ...galleryMediaItem({
      ...row,
      orientation: null,
      capturedLocalAt: null,
      cameraMake: null,
      cameraModel: null,
    }),
    albumId: row.albumId,
  };
}

export function galleryMediaItem(row: AlbumMediaRecord) {
  return {
    mediaId: row.mediaId,
    timelineKey: row.timelineKey.toISOString(),
    timelineBasis: row.timelineBasis,
    displayWidth: row.displayWidth,
    displayHeight: row.displayHeight,
    thumbnail: { kind: "thumbnail" as const },
  };
}

export function galleryMediaDetail(row: AlbumMediaRecord) {
  return {
    ...galleryMediaItem(row),
    orientation: row.orientation,
    capturedLocalAt: row.capturedLocalAt
      ? row.capturedLocalAt.toISOString()
      : null,
    cameraMake: row.cameraMake,
    cameraModel: row.cameraModel,
    preview: { kind: "preview" as const },
  };
}

export function encodeGalleryCursor(item: {
  timelineKey: string;
  mediaId: string;
}) {
  return Buffer.from(
    JSON.stringify({
      timelineKey: item.timelineKey,
      mediaId: item.mediaId,
    }),
  ).toString("base64url");
}

function actor(context: AuthContext) {
  return {
    userId: context.identity.userId,
    sessionId: context.identity.sessionId,
    tokenHash: context.tokenHash,
  };
}

function validateAlbumName(input: unknown) {
  if (
    typeof input !== "string" ||
    hasMalformedUnicode(input) ||
    input.includes("\0")
  ) {
    throw new PublicAuthError(400, "INVALID_REQUEST");
  }
  const value = input.trim();
  if (
    countCodePoints(value) < 1 ||
    countCodePoints(value) > 128 ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw new PublicAuthError(400, "INVALID_REQUEST");
  }
  return value;
}

function validateAlbumDescription(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (
    typeof input !== "string" ||
    hasMalformedUnicode(input) ||
    input.includes("\0") ||
    countCodePoints(input) > 2_000 ||
    Buffer.byteLength(input, "utf8") > 8_000
  ) {
    throw new PublicAuthError(400, "INVALID_REQUEST");
  }
  return input;
}
