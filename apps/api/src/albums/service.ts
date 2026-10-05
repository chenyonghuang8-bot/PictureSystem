import {
  aggregateLocationMap,
  assertLocationFilter,
  type LocationProjector,
} from "@family-album/media";
import { createHash } from "node:crypto";
import { countCodePoints, hasMalformedUnicode } from "@family-album/auth";
import {
  AlbumRepositoryError,
  CommitOutcomeUnknownError,
  type AlbumMediaDetailRecord,
  type AlbumMediaRecord,
  type MySqlAlbumRepository,
  TransactionRollbackFailedError,
} from "@family-album/db";
import {
  galleryCursorSchema,
  familySearchCursorSchema,
  familySearchOptionsCursorSchema,
  type FamilySearchOptionsQuery,
  type FamilySearchQuery,
  type FamilyMapQuery,
  type FamilyLocationOptionsQuery,
  mediaCommentCursorSchema,
  type AlbumVisibility,
  type PutAlbumMemberRequest,
  type UpdateAlbumRequest,
} from "@family-album/contracts";

import { PublicAuthError, type AuthContext } from "../auth/service.js";
import { MediaCommentRateLimiter } from "./comment-rate-limit.js";
import {
  MediaTextValidationError,
  normalizeMediaComment,
  normalizeMediaNote,
  normalizeTagName,
} from "./text.js";

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
  | "searchFamilyMedia"
  | "listFamilySearchOptions"
  | "putFavorite"
  | "deleteFavorite"
  | "putFeatured"
  | "deleteFeatured"
  | "listMediaTags"
  | "createAndApplyMediaTag"
  | "applyMediaTag"
  | "removeMediaTag"
  | "updateMediaNote"
  | "listMediaComments"
  | "createMediaComment"
  | "deleteMediaComment"
>;

type LocationRepository = Partial<
  Pick<MySqlAlbumRepository, "locationFamilyMedia" | "locationProjector">
>;

export class AlbumService {
  constructor(
    private readonly repository: AlbumRepository & LocationRepository,
    private readonly commentRateLimiter = new MediaCommentRateLimiter(),
  ) {}

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

  async search(
    context: AuthContext,
    familyId: string,
    query: FamilySearchQuery,
  ) {
    try {
      assertLocationFilter(query.location);
    } catch {
      throw new PublicAuthError(400, "INVALID_REQUEST");
    }
    if (query.location && !this.repository.locationProjector)
      throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
    const scope = familySearchScope(
      familyId,
      context.identity.userId,
      query,
      this.repository.locationProjector,
    );
    const cursor = query.cursor
      ? decodeFamilySearchCursor(query.cursor, scope)
      : undefined;
    const filters = databaseSearchFilters(query);
    const rows = query.location
      ? (await this.locationRows(context, familyId, query))
          .filter(
            (row) =>
              !cursor ||
              row.timelineKey < cursor.timelineKey ||
              (row.timelineKey.getTime() === cursor.timelineKey.getTime() &&
                BigInt(row.mediaId) < BigInt(cursor.mediaId)),
          )
          .slice(0, query.limit + 1)
      : await this.database(() =>
          this.repository.searchFamilyMedia({
            actor: actor(context),
            familyId,
            limit: query.limit + 1,
            ...(cursor ? { cursor } : {}),
            filters,
          }),
        );
    const media = rows.slice(0, query.limit).map(familyTimelineItem);
    return {
      media,
      nextCursor:
        rows.length > query.limit
          ? encodeFamilySearchCursor(media.at(-1)!, scope)
          : null,
    };
  }

  private async locationRows(
    context: AuthContext,
    familyId: string,
    query: Pick<
      FamilySearchQuery,
      | "fromDate"
      | "toDate"
      | "albumId"
      | "filename"
      | "uploaderMemberId"
      | "tagId"
      | "favoritesOnly"
      | "location"
    >,
  ) {
    try {
      assertLocationFilter(query.location);
    } catch {
      throw new PublicAuthError(400, "INVALID_REQUEST");
    }
    if (
      !this.repository.locationFamilyMedia ||
      !this.repository.locationProjector
    )
      throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
    return this.database(() =>
      this.repository.locationFamilyMedia!({
        actor: actor(context),
        familyId,
        filters: databaseSearchFilters(query),
      }),
    );
  }

  async map(context: AuthContext, familyId: string, query: FamilyMapQuery) {
    return aggregateLocationMap(
      await this.locationRows(context, familyId, query),
      query.bbox,
      query.zoom,
    );
  }

  async locationOptions(
    context: AuthContext,
    familyId: string,
    query: FamilyLocationOptionsQuery,
  ) {
    const scope =
      familySearchScope(
        familyId,
        context.identity.userId,
        { ...query, limit: query.limit },
        this.repository.locationProjector,
      ) +
      ":" +
      query.kind;
    let after = "";
    if (query.cursor) {
      const parsed = decodeCanonicalSearchCursor(query.cursor);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Object.keys(parsed).sort().join(",") !== "after,scope,version" ||
        !("version" in parsed) ||
        parsed.version !== 1 ||
        !("scope" in parsed) ||
        parsed.scope !== scope ||
        !("after" in parsed) ||
        typeof parsed.after !== "string"
      )
        throw new PublicAuthError(400, "INVALID_REQUEST");
      after = parsed.after;
    }
    const rows = await this.locationRows(context, familyId, query),
      projector = this.repository.locationProjector!;
    const groups = new Map<
      string,
      { id: string; name: string; count: number }
    >();
    for (const row of rows) {
      if (!row.h3Cell) continue;
      const id =
        query.kind === "country"
          ? row.countryCode
            ? "country:" + row.countryCode
            : "unknown"
          : row.cityGeonameId
            ? "city:" + row.cityGeonameId
            : "no-city";
      const name =
        query.kind === "country"
          ? (projector.countryName(row.countryCode) ?? "未知国家 / 海洋")
          : row.cityGeonameId
            ? (projector.cityName(row.cityGeonameId) ?? "未知城市") + "附近"
            : "无 50 公里内附近城市";
      const previous = groups.get(id);
      if (previous) ++previous.count;
      else groups.set(id, { id, name: name.slice(0, 256), count: 1 });
    }
    const sorted = [...groups.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((r) => r.id > after);
    const options = sorted.slice(0, query.limit);
    return {
      options,
      nextCursor:
        sorted.length > query.limit
          ? Buffer.from(
              JSON.stringify({ version: 1, after: options.at(-1)!.id, scope }),
            ).toString("base64url")
          : null,
    };
  }

  async searchOptions(
    context: AuthContext,
    familyId: string,
    query: FamilySearchOptionsQuery,
  ) {
    const scope = createHash("sha256")
      .update(
        JSON.stringify([
          "family-search-options-v1",
          familyId,
          context.identity.userId,
          query.kind,
          query.limit,
        ]),
      )
      .digest("hex");
    let afterId: string | undefined;
    if (query.cursor) {
      const parsed = familySearchOptionsCursorSchema.safeParse(
        decodeCanonicalSearchCursor(query.cursor),
      );
      if (!parsed.success || parsed.data.scope !== scope)
        throw new PublicAuthError(400, "INVALID_REQUEST");
      afterId = parsed.data.afterId;
    }
    const rows = await this.database(() =>
      this.repository.listFamilySearchOptions({
        actor: actor(context),
        familyId,
        kind: query.kind,
        limit: query.limit + 1,
        ...(afterId ? { afterId } : {}),
      }),
    );
    const options = rows.slice(0, query.limit);
    return {
      options,
      nextCursor:
        rows.length > query.limit
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                afterId: options.at(-1)!.id,
                scope,
              }),
            ).toString("base64url")
          : null,
    };
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

  async putFavorite(context: AuthContext, albumId: string, mediaId: string) {
    return this.database(() =>
      this.repository.putFavorite({
        actor: actor(context),
        albumId,
        mediaId,
      }),
    );
  }

  async deleteFavorite(context: AuthContext, albumId: string, mediaId: string) {
    return this.database(() =>
      this.repository.deleteFavorite({
        actor: actor(context),
        albumId,
        mediaId,
      }),
    );
  }

  async putFeatured(context: AuthContext, albumId: string, mediaId: string) {
    return this.database(() =>
      this.repository.putFeatured({
        actor: actor(context),
        albumId,
        mediaId,
      }),
    );
  }

  async deleteFeatured(context: AuthContext, albumId: string, mediaId: string) {
    return this.database(() =>
      this.repository.deleteFeatured({
        actor: actor(context),
        albumId,
        mediaId,
      }),
    );
  }

  async listTags(context: AuthContext, albumId: string, mediaId: string) {
    return this.database(() =>
      this.repository.listMediaTags({
        actor: actor(context),
        albumId,
        mediaId,
      }),
    );
  }

  async createTag(
    context: AuthContext,
    albumId: string,
    mediaId: string,
    name: unknown,
  ) {
    const normalized = this.mediaText(() => normalizeTagName(name));
    return this.database(() =>
      this.repository.createAndApplyMediaTag({
        actor: actor(context),
        albumId,
        mediaId,
        name: normalized.name,
        normalizedName: normalized.normalizedBytes,
      }),
    );
  }

  async applyTag(
    context: AuthContext,
    albumId: string,
    mediaId: string,
    tagId: string,
  ) {
    return this.database(() =>
      this.repository.applyMediaTag({
        actor: actor(context),
        albumId,
        mediaId,
        tagId,
      }),
    );
  }

  async removeTag(
    context: AuthContext,
    albumId: string,
    mediaId: string,
    tagId: string,
  ) {
    return this.database(() =>
      this.repository.removeMediaTag({
        actor: actor(context),
        albumId,
        mediaId,
        tagId,
      }),
    );
  }

  async updateNote(
    context: AuthContext,
    albumId: string,
    mediaId: string,
    note: unknown,
    expectedRevision: string,
  ) {
    const normalized = this.mediaText(() => normalizeMediaNote(note));
    return this.database(() =>
      this.repository.updateMediaNote({
        actor: actor(context),
        albumId,
        mediaId,
        note: normalized,
        expectedRevision,
      }),
    );
  }

  async listComments(
    context: AuthContext,
    albumId: string,
    mediaId: string,
    input: { limit: number; cursor?: { createdAt: Date; id: string } },
  ) {
    return this.database(() =>
      this.repository.listMediaComments({
        actor: actor(context),
        albumId,
        mediaId,
        limit: input.limit + 1,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      }),
    );
  }

  async createComment(
    context: AuthContext,
    albumId: string,
    mediaId: string,
    body: unknown,
  ) {
    const normalized = this.mediaText(() => normalizeMediaComment(body));
    return this.database(() =>
      this.repository.createMediaComment({
        actor: actor(context),
        albumId,
        mediaId,
        body: normalized,
        admit: (memberId) => this.commentRateLimiter.consume(memberId),
      }),
    );
  }

  async deleteComment(
    context: AuthContext,
    albumId: string,
    mediaId: string,
    commentId: string,
  ) {
    return this.database(() =>
      this.repository.deleteMediaComment({
        actor: actor(context),
        albumId,
        mediaId,
        commentId,
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

  private mediaText<T>(normalize: () => T) {
    try {
      return normalize();
    } catch (error) {
      if (error instanceof MediaTextValidationError) {
        throw new PublicAuthError(400, "INVALID_REQUEST");
      }
      throw error;
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

export function decodeMediaCommentCursor(cursor: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new PublicAuthError(400, "INVALID_REQUEST");
  }
  const result = mediaCommentCursorSchema.safeParse(parsed);
  if (!result.success) throw new PublicAuthError(400, "INVALID_REQUEST");
  const createdAt = new Date(result.data.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new PublicAuthError(400, "INVALID_REQUEST");
  }
  return { createdAt, id: result.data.id };
}

export function encodeMediaCommentCursor(item: {
  createdAt: string;
  id: string;
}) {
  return Buffer.from(
    JSON.stringify({ version: 1, createdAt: item.createdAt, id: item.id }),
  ).toString("base64url");
}

export function familyTimelineItem(row: {
  mediaId: string;
  albumId: string;
  timelineKey: Date;
  timelineBasis: AlbumMediaRecord["timelineBasis"];
  displayWidth: number | null;
  displayHeight: number | null;
  isFavorite?: boolean;
  isFamilyFeatured?: boolean;
}) {
  return {
    ...galleryMediaItem({
      ...row,
      isFavorite: row.isFavorite ?? false,
      isFamilyFeatured: row.isFamilyFeatured ?? false,
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
    isFavorite: row.isFavorite ?? false,
    isFamilyFeatured: row.isFamilyFeatured ?? false,
  };
}

export function publicGalleryMediaItem(row: {
  mediaId: string;
  timelineKey: Date;
  timelineBasis: AlbumMediaRecord["timelineBasis"];
  displayWidth: number | null;
  displayHeight: number | null;
}) {
  return {
    mediaId: row.mediaId,
    timelineKey: row.timelineKey.toISOString(),
    timelineBasis: row.timelineBasis,
    displayWidth: row.displayWidth,
    displayHeight: row.displayHeight,
    thumbnail: { kind: "thumbnail" as const },
  };
}

export function galleryMediaDetail(row: AlbumMediaDetailRecord) {
  return {
    ...galleryMediaItem(row),
    orientation: row.orientation,
    capturedLocalAt: row.capturedLocalAt
      ? row.capturedLocalAt.toISOString()
      : null,
    cameraMake: row.cameraMake,
    cameraModel: row.cameraModel,
    preview: { kind: "preview" as const },
    tags: row.tags,
    note: row.note,
    noteRevision: row.noteRevision,
    commentCount: row.commentCount,
    lifecycleRevision: row.lifecycleRevision,
    capabilities: row.capabilities,
  };
}

export function mediaCommentDto(row: {
  id: string;
  body: string;
  createdAt: Date;
  author: { memberId: string; displayName: string };
  canDelete: boolean;
}) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    author: row.author,
    canDelete: row.canDelete,
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

export function familySearchScope(
  familyId: string,
  userId: string,
  query: FamilySearchQuery,
  projector?: LocationProjector,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "family-search-v2",
        familyId,
        userId,
        query.fromDate ?? null,
        query.toDate ?? null,
        query.albumId ?? null,
        query.favoritesOnly,
        query.filename ?? null,
        query.uploaderMemberId ?? null,
        query.tagId ?? null,
        query.limit,
        query.location ?? null,
        projector?.policyVersion ?? null,
        projector?.datasetVersion ?? null,
      ]),
    )
    .digest("hex");
}

function decodeCanonicalSearchCursor(cursor: string): unknown {
  if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new PublicAuthError(400, "INVALID_REQUEST");
  let parsed: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    const text = bytes.toString("utf8");
    if (
      bytes.length > 768 ||
      bytes.toString("base64url") !== cursor ||
      !Buffer.from(text, "utf8").equals(bytes)
    )
      throw new Error();
    parsed = JSON.parse(text);
  } catch {
    throw new PublicAuthError(400, "INVALID_REQUEST");
  }
  return parsed;
}

export function decodeFamilySearchCursor(cursor: string, scope: string) {
  const result = familySearchCursorSchema.safeParse(
    decodeCanonicalSearchCursor(cursor),
  );
  if (!result.success || result.data.scope !== scope)
    throw new PublicAuthError(400, "INVALID_REQUEST");
  return {
    timelineKey: new Date(result.data.timelineKey),
    mediaId: result.data.mediaId,
  };
}

export function encodeFamilySearchCursor(
  item: { timelineKey: string; mediaId: string },
  scope: string,
) {
  return Buffer.from(
    JSON.stringify({
      version: 2,
      timelineKey: item.timelineKey,
      mediaId: item.mediaId,
      scope,
    }),
  ).toString("base64url");
}

function databaseSearchFilters(
  query: Pick<
    FamilySearchQuery,
    | "fromDate"
    | "toDate"
    | "albumId"
    | "filename"
    | "uploaderMemberId"
    | "tagId"
    | "favoritesOnly"
    | "location"
  >,
) {
  return {
    ...(query.fromDate
      ? { fromDate: new Date(`${query.fromDate}T00:00:00.000Z`) }
      : {}),
    ...(query.toDate
      ? { toDate: new Date(`${query.toDate}T23:59:59.999Z`) }
      : {}),
    ...(query.albumId ? { albumId: query.albumId } : {}),
    favoritesOnly: query.favoritesOnly,
    ...(query.filename ? { filename: query.filename } : {}),
    ...(query.uploaderMemberId
      ? { uploaderMemberId: query.uploaderMemberId }
      : {}),
    ...(query.tagId ? { tagId: query.tagId } : {}),
    ...(query.location ? { location: query.location } : {}),
  };
}
