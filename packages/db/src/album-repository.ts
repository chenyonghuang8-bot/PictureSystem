import {
  memoriesCalendar,
  type MemoriesKind,
  type MemoriesContext,
  type MemoriesCursor,
} from "@family-album/contracts";
import {
  matchesLocation,
  type CoarseLocation,
  type LocationProjector,
} from "@family-album/media";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import {
  canDeleteFromAlbum,
  canEditAlbum,
  canManageAlbumMembers,
  canUploadToAlbum,
  evaluateAlbumPermissions,
  isPermissionSubset,
  type AlbumPermissionContext,
  type AlbumPermissionGrant,
  type AlbumVisibility,
  type FamilyRole,
} from "@family-album/permissions";

import {
  acquireCheckedConnection,
  readServerTime,
  runCheckedTransaction,
} from "./connection.js";
import type { Phase1CActor } from "./phase1c-repository.js";
import { activeMediaSql } from "./media-lifecycle.js";
import type {
  AlbumRepositoryTestHook,
  AlbumRepositoryTestOperation,
} from "./album-repository-test-hooks.js";

const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
const RECENT_AUTH_MS = 15 * 60_000;

export type AlbumRecord = {
  id: string;
  familyId: string;
  ownerMemberId: string;
  name: string;
  description: string | null;
  visibility: AlbumVisibility;
  revision: string;
  createdAt: Date;
  updatedAt: Date;
  effectivePermissions: AlbumPermissionGrant;
};

export type AlbumMemberRecord = AlbumPermissionGrant & {
  memberId: string;
  displayName: string | null;
  active: boolean;
  isOwner: boolean;
};

export type FamilyTimelineRecord = {
  mediaId: string;
  albumId: string;
  timelineKey: Date;
  timelineBasis: "CAPTURE_LOCAL" | "UPLOAD_UTC";
  displayWidth: number | null;
  displayHeight: number | null;
  isFavorite: boolean;
  isFamilyFeatured: boolean;
};

export type FamilySearchFilters = {
  location?: string;
  filename?: string;
  uploaderMemberId?: string;
  tagId?: string;
  fromDate?: Date;
  toDate?: Date;
  albumId?: string;
  favoritesOnly?: boolean;
};

export type AlbumMediaRecord = {
  mediaId: string;
  timelineKey: Date;
  timelineBasis: "CAPTURE_LOCAL" | "UPLOAD_UTC";
  displayWidth: number | null;
  displayHeight: number | null;
  orientation: number | null;
  capturedLocalAt: Date | null;
  cameraMake: string | null;
  cameraModel: string | null;
  isFavorite: boolean;
  isFamilyFeatured: boolean;
};

export type MediaTagRecord = { id: string; name: string };

export type MediaCommentRecord = {
  id: string;
  body: string;
  createdAt: Date;
  author: { memberId: string; displayName: string };
  canDelete: boolean;
};

export type AlbumMediaDetailRecord = AlbumMediaRecord & {
  lifecycleRevision: string;
  tags: MediaTagRecord[];
  note: string | null;
  noteRevision: string;
  commentCount: string;
  capabilities: {
    canTrash: boolean;
    canManageFeatured: boolean;
    canEditTags: boolean;
    canEditNote: boolean;
    canComment: boolean;
    canDownloadOriginal: boolean;
    canDownloadPreview: boolean;
  };
};

export type OriginalDownloadRecord = {
  lifecycleRevision: string;
  familyId: string;
  albumId: string;
  actorMemberId: string;
  mediaId: string;
  storageObjectId: string;
  keyVersion: number;
  sha256Hex: string;
  byteSize: string;
  sourceUploadId: string;
  originalFilename: string;
  detectedMime: string | null;
};

export type PreviewDownloadRecord = {
  lifecycleRevision: string;
  originalSha256Hex: string;
  originalByteSize: string;
  familyId: string;
  albumId: string;
  actorMemberId: string;
  mediaId: string;
  storageObjectId: string;
  sourceUploadId: string;
  mediaGeneration: bigint;
  mediaRecipeId: 1;
  derivedAssetId: string;
  derivedGeneration: bigint;
  derivedRecipeId: 1;
  kind: "PREVIEW";
  byteSize: bigint;
  sha256Hex: string;
  outputMime: "image/webp";
  width: number;
  height: number;
  producerJobId: string;
  producerLeaseEpoch: bigint;
  publishedAt: Date;
  configuredPreviewRecipeId: 1;
};

export class AlbumRepositoryError extends Error {
  constructor(
    readonly reason:
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "SERVICE_UNAVAILABLE",
  ) {
    super(reason);
    this.name = "AlbumRepositoryError";
  }
}

type ActorMemberRow = RowDataPacket & {
  id: string;
  familyId: string;
  userId: string;
  role: FamilyRole;
  disabledAt: Date | null;
  leftAt: Date | null;
};
type UserRow = RowDataPacket & {
  id: string;
  displayName: string | null;
  disabledAt: Date | null;
};
type SessionRow = RowDataPacket & {
  tokenHash: Buffer;
  clientType: "WEB" | "ANDROID";
  authenticatedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};
type AlbumRow = RowDataPacket & {
  id: string;
  familyId: string;
  ownerMemberId: string;
  name: string;
  description: string | null;
  visibility: AlbumVisibility;
  revision: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};
type GrantRow = RowDataPacket & AlbumPermissionGrant & { id: string };
type LockedActor = {
  member: ActorMemberRow;
  user: UserRow | undefined;
  session: SessionRow | undefined;
};
type AclState = LockedActor & {
  album: AlbumRow | undefined;
  actorGrant: GrantRow | undefined;
  targetMember: ActorMemberRow | undefined;
  targetUser: UserRow | undefined;
  targetGrant: GrantRow | undefined;
};

export class MySqlAlbumRepository {
  constructor(
    private readonly pool: Pool,
    private readonly testOptions?: {
      readonly locationProjector?: LocationProjector;
      /** Internal test clock; never wired to HTTP or environment. */
      readonly memoriesClock?: (databaseNow: Date) => Date;
      readonly testHook?: AlbumRepositoryTestHook;
      /** Test-only seam for proving configured recipe drift; production omits it. */
      readonly getConfiguredPreviewRecipeId?: () => number;
    },
  ) {}

  async listFamilyMemories(input: {
    actor: Phase1CActor;
    familyId: string;
    kind: MemoriesKind;
    limit: number;
    cursor?: MemoriesCursor;
  }): Promise<{ context: MemoriesContext; rows: MemoriesRecord[] }> {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const locked = await lockActor(connection, input.familyId, input.actor);
      const now = await readServerTime(connection);
      assertActor(locked, input.actor, now);
      const context = memoriesCalendar(
        this.testOptions?.memoriesClock?.(now) ?? now,
      );
      if (input.cursor && input.cursor.anchorDate !== context.anchorDate)
        throw new MemoriesAnchorExpiredError();
      const query = buildFamilyMemoriesQuery(
        input.familyId,
        locked.member.id,
        input.kind,
        context,
        input.limit,
        input.cursor,
      );
      const [rows] = await connection.query<RowDataPacket[]>(
        query.sql,
        query.values,
      );
      return { context, rows: rows.map(memoryRecord) };
    });
  }

  async listFamilyMemoriesPreview(input: {
    actor: Phase1CActor;
    familyId: string;
  }) {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const locked = await lockActor(connection, input.familyId, input.actor);
      const now = await readServerTime(connection);
      assertActor(locked, input.actor, now);
      const context = memoriesCalendar(
        this.testOptions?.memoriesClock?.(now) ?? now,
      );
      const read = async (kind: MemoriesKind) => {
        const query = buildFamilyMemoriesQuery(
          input.familyId,
          locked.member.id,
          kind,
          context,
          7,
        );
        const [rows] = await connection.query<RowDataPacket[]>(
          query.sql,
          query.values,
        );
        return rows.map(memoryRecord);
      };
      return {
        context,
        onThisDay: await read("ON_THIS_DAY"),
        lastYearWeek: await read("LAST_YEAR_WEEK"),
      };
    });
  }

  get locationProjector() {
    return this.testOptions?.locationProjector;
  }

  async locationFamilyMedia(input: {
    actor: Phase1CActor;
    familyId: string;
    filters: FamilySearchFilters;
  }): Promise<(FamilyTimelineRecord & CoarseLocation)[]> {
    const projector = this.locationProjector;
    if (!projector) throw new AlbumRepositoryError("SERVICE_UNAVAILABLE");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const locked = await lockActor(connection, input.familyId, input.actor);
      assertActor(locked, input.actor, await readServerTime(connection));
      const query = buildFamilyLocationQuery(
        input.familyId,
        locked.member.id,
        input.filters,
        projector,
      );
      const [rows] = await connection.query<RowDataPacket[]>(
        query.sql,
        query.values,
      );
      return rows
        .map((row) => ({
          mediaId: String(row.mediaId),
          albumId: String(row.albumId),
          timelineKey: row.timelineKey as Date,
          timelineBasis:
            row.timelineBasis as FamilyTimelineRecord["timelineBasis"],
          displayWidth: nullableInteger(row.displayWidth),
          displayHeight: nullableInteger(row.displayHeight),
          isFavorite: Number(row.isFavorite) === 1,
          isFamilyFeatured: Number(row.isFamilyFeatured) === 1,
          h3Cell: row.h3Cell as string | null,
          countryCode: row.countryCode as string | null,
          cityGeonameId: row.cityGeonameId as string | null,
          hasGps: Number(row.hasGps) === 1,
        }))
        .filter((row) => matchesLocation(row, input.filters.location));
    });
  }

  async createAlbum(input: {
    actor: Phase1CActor;
    familyId: string;
    name: string;
    description: string | null;
    visibility: AlbumVisibility;
  }): Promise<AlbumRecord & { actorMemberId: string }> {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const actor = await lockActor(connection, input.familyId, input.actor);
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      assertRecentAuth(actor.session, now);

      await connection.query<ResultSetHeader>(
        `INSERT INTO albums
          (family_id, owner_member_id, name, description, visibility,
           revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          input.familyId,
          actor.member.id,
          input.name,
          input.description,
          input.visibility,
          now,
          now,
        ],
      );
      const [ids] = await connection.query<RowDataPacket[]>(
        "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id",
      );
      const id = String(ids[0]?.id ?? "");
      if (!id) throw new Error("Album insert result is unavailable.");
      return {
        id,
        familyId: input.familyId,
        ownerMemberId: actor.member.id,
        name: input.name,
        description: input.description,
        visibility: input.visibility,
        revision: "1",
        createdAt: now,
        updatedAt: now,
        effectivePermissions: ownerPermissions(),
        actorMemberId: actor.member.id,
      };
    });
  }

  async listAlbums(input: {
    actor: Phase1CActor;
    familyId: string;
    afterId?: string;
    limit: number;
  }): Promise<AlbumRecord[]> {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const actor = await lockActor(connection, input.familyId, input.actor);

      // The family row is the coarse Phase 2 mutex. This SQL applies the view
      // predicate before LIMIT so hidden rows neither leak nor consume a page.
      const [located] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(a.id AS CHAR) AS id,
                CAST(am.id AS CHAR) AS grantId
           FROM albums a
           LEFT JOIN album_members am
             ON am.family_id = a.family_id AND am.album_id = a.id
            AND am.member_id = ?
          WHERE a.family_id = ? AND a.deleted_at IS NULL
            AND a.id > ?
            AND (a.owner_member_id = ? OR a.visibility = 'FAMILY'
                 OR am.can_view = 1)
          ORDER BY a.id ASC LIMIT ?`,
        [
          actor.member.id,
          input.familyId,
          input.afterId ?? "0",
          actor.member.id,
          input.limit,
        ],
      );
      const albumIds = located.map((row) => String(row.id));
      const grantIds = located
        .filter((row) => row.grantId !== null)
        .map((row) => String(row.grantId));
      await lockIds(connection, "albums", albumIds);
      await lockIds(connection, "album_members", grantIds);

      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      if (albumIds.length === 0) return [];

      const [rows] = await connection.query<(AlbumRow & GrantRow)[]>(
        `SELECT CAST(a.id AS CHAR) AS id, CAST(a.family_id AS CHAR) AS familyId,
                CAST(a.owner_member_id AS CHAR) AS ownerMemberId,
                a.name, a.description, a.visibility,
                CAST(a.revision AS CHAR) AS revision,
                a.created_at AS createdAt, a.updated_at AS updatedAt,
                a.deleted_at AS deletedAt,
                COALESCE(am.can_view, 0) AS canView,
                COALESCE(am.can_upload, 0) AS canUpload,
                COALESCE(am.can_edit, 0) AS canEdit,
                COALESCE(am.can_delete, 0) AS canDelete,
                COALESCE(am.can_manage_members, 0) AS canManageMembers
           FROM albums a
           LEFT JOIN album_members am
             ON am.family_id = a.family_id AND am.album_id = a.id
            AND am.member_id = ?
          WHERE a.family_id = ? AND a.id IN (?)
          ORDER BY a.id ASC`,
        [actor.member.id, input.familyId, albumIds],
      );
      return rows
        .map((row) => toAlbumRecord(row, actor.member, row))
        .filter((album) => album.effectivePermissions.canView);
    });
  }

  async getAlbum(input: {
    actor: Phase1CActor;
    albumId: string;
  }): Promise<AlbumRecord> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const actor = await lockActor(connection, familyId, input.actor);
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, actor.member.id)
        : undefined;
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      return assertVisible(album, actor.member, grant);
    });
  }

  async listFamilyTimeline(input: {
    actor: Phase1CActor;
    familyId: string;
    limit: number;
    cursor?: { timelineKey: Date; mediaId: string };
  }): Promise<FamilyTimelineRecord[]> {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const locked = await lockActor(connection, input.familyId, input.actor);
      const now = await readServerTime(connection);
      assertActor(locked, input.actor, now);
      return readFamilyTimeline(
        connection,
        input.familyId,
        locked.member.id,
        input.limit,
        input.cursor,
      );
    });
  }

  async listFamilySearchOptions(input: {
    actor: Phase1CActor;
    familyId: string;
    kind: "tag" | "uploader";
    limit: number;
    afterId?: string;
  }): Promise<{ id: string; name: string }[]> {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const locked = await lockActor(connection, input.familyId, input.actor);
      const now = await readServerTime(connection);
      assertActor(locked, input.actor, now);
      const query = buildFamilySearchOptionsQuery(
        input.familyId,
        locked.member.id,
        input.kind,
        input.limit,
        input.afterId,
      );
      const [rows] = await connection.query<RowDataPacket[]>(
        query.sql,
        query.values,
      );
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
      }));
    });
  }

  async searchFamilyMedia(input: {
    actor: Phase1CActor;
    familyId: string;
    limit: number;
    cursor?: { timelineKey: Date; mediaId: string };
    filters: FamilySearchFilters;
  }): Promise<FamilyTimelineRecord[]> {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const locked = await lockActor(connection, input.familyId, input.actor);
      const now = await readServerTime(connection);
      assertActor(locked, input.actor, now);
      const query = buildFamilySearchQuery(
        input.familyId,
        locked.member.id,
        input.limit,
        input.cursor,
        input.filters,
      );
      const [rows] = await connection.query<
        (RowDataPacket & FamilyTimelineRecord)[]
      >(query.sql, query.values);
      return rows.map((row) => ({
        mediaId: String(row.mediaId),
        albumId: String(row.albumId),
        timelineKey: row.timelineKey,
        timelineBasis: row.timelineBasis,
        displayWidth: nullableInteger(row.displayWidth),
        displayHeight: nullableInteger(row.displayHeight),
        isFavorite: Number(row.isFavorite) === 1,
        isFamilyFeatured: Number(row.isFamilyFeatured) === 1,
      }));
    });
  }

  async listAlbumMedia(input: {
    actor: Phase1CActor;
    albumId: string;
    limit: number;
    cursor?: { timelineKey: Date; mediaId: string };
  }): Promise<AlbumMediaRecord[]> {
    return this.withVisibleAlbum(
      input.actor,
      input.albumId,
      (connection, album, actorMemberId) =>
        readAlbumMedia(
          connection,
          album,
          actorMemberId,
          input.limit,
          input.cursor,
        ),
    );
  }

  async getAlbumMedia(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
  }): Promise<AlbumMediaDetailRecord> {
    return this.mutateMediaState(input, {}, async (connection, scope) => {
      const rows = await readAlbumMedia(
        connection,
        scope.album,
        scope.actorMemberId,
        1,
        undefined,
        input.mediaId,
      );
      const row = rows[0];
      if (!row) throw new AlbumRepositoryError("NOT_FOUND");
      const tags = await readMediaTags(
        connection,
        scope.familyId,
        input.mediaId,
      );
      const commentCount = await readCommentCount(
        connection,
        scope.familyId,
        input.mediaId,
      );
      const media = await readMediaNote(
        connection,
        scope.familyId,
        input.mediaId,
      );
      const [lifecycleRows] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(m.lifecycle_revision AS CHAR) lifecycleRevision,
          NOT EXISTS (SELECT 1 FROM album_media p JOIN albums a ON a.family_id=p.family_id AND a.id=p.album_id
            LEFT JOIN album_members g ON g.family_id=a.family_id AND g.album_id=a.id AND g.member_id=?
            WHERE p.family_id=m.family_id AND p.media_id=m.id AND a.deleted_at IS NULL
              AND NOT (a.owner_member_id=? OR (COALESCE(g.can_delete,0)=1 AND (a.visibility='FAMILY' OR g.can_view=1)))) canTrash
         FROM media_items m WHERE m.family_id=? AND m.id=? AND m.trashed_at IS NULL AND m.purge_intent_id IS NULL`,
        [
          scope.actorMemberId,
          scope.actorMemberId,
          scope.familyId,
          input.mediaId,
        ],
      );
      const lifecycle = lifecycleRows[0];
      if (!lifecycle) throw new AlbumRepositoryError("NOT_FOUND");
      const lifecycleRevision = String(lifecycle.lifecycleRevision);
      return {
        ...row,
        lifecycleRevision,
        tags,
        note: media.note,
        noteRevision: media.noteRevision,
        commentCount,
        capabilities: {
          canTrash:
            Number(lifecycle.canTrash) === 1 &&
            BigInt(lifecycleRevision) < 18446744073709551615n,
          canManageFeatured:
            scope.actorRole === "ADMIN" || scope.actorRole === "SUPER_ADMIN",
          canEditTags: scope.album.effectivePermissions.canEdit,
          canEditNote: scope.album.effectivePermissions.canEdit,
          canComment: true,
          // Feature availability for this view-authorized detail, not a storage
          // preflight. Each download route reauthorizes current state itself.
          canDownloadOriginal: true,
          canDownloadPreview: true,
        },
      };
    });
  }

  async prepareOriginalDownload(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
  }): Promise<OriginalDownloadRecord> {
    return this.authorizeOriginalDownload(input, "ORIGINAL_DOWNLOAD_PREPARE");
  }

  async recheckOriginalDownload(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
    expected: OriginalDownloadRecord;
  }): Promise<OriginalDownloadRecord> {
    return this.authorizeOriginalDownload(
      input,
      "ORIGINAL_DOWNLOAD_RECHECK",
      input.expected,
    );
  }

  async preparePreviewDownload(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
  }): Promise<PreviewDownloadRecord> {
    return this.authorizePreviewDownload(input, "PREVIEW_DOWNLOAD_PREPARE");
  }

  async recheckPreviewDownload(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
    expected: PreviewDownloadRecord;
  }): Promise<PreviewDownloadRecord> {
    return this.authorizePreviewDownload(
      input,
      "PREVIEW_DOWNLOAD_RECHECK",
      input.expected,
    );
  }

  async addAlbumMedia(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
  }): Promise<{ albumId: string; mediaId: string; created: boolean }> {
    return this.mutatePlacement(
      input,
      (context) => {
        return canUploadToAlbum(context) || canEditAlbum(context);
      },
      (connection, album) =>
        insertPlacement(connection, album.familyId, album.id, input.mediaId),
    );
  }

  async removeAlbumMedia(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
  }): Promise<{ albumId: string; mediaId: string; removed: boolean }> {
    return this.mutatePlacement(
      input,
      canDeleteFromAlbum,
      (connection, album) =>
        deletePlacement(connection, album.familyId, album.id, input.mediaId),
    );
  }

  async putFavorite(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
  }): Promise<{
    isFavorite: true;
    familyId: string;
    actorMemberId: string;
  }> {
    return this.mutateMediaState(input, {}, async (connection, scope) => {
      const existing = await lockFavorite(
        connection,
        scope.familyId,
        scope.actorMemberId,
        input.mediaId,
      );
      if (existing) return { isFavorite: true };
      try {
        await connection.query<ResultSetHeader>(
          `INSERT INTO user_favorites (family_id, member_id, media_id)
           VALUES (?, ?, ?)`,
          [scope.familyId, scope.actorMemberId, input.mediaId],
        );
      } catch (error) {
        if (!isApprovedIdentityDuplicate(error, "uq_user_favorites_identity")) {
          throw error;
        }
        const raced = await lockFavorite(
          connection,
          scope.familyId,
          scope.actorMemberId,
          input.mediaId,
        );
        if (!raced) throw error;
      }
      return { isFavorite: true };
    });
  }

  async deleteFavorite(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
  }): Promise<{
    isFavorite: false;
    familyId: string;
    actorMemberId: string;
  }> {
    return this.mutateMediaState(input, {}, async (connection, scope) => {
      const existing = await lockFavorite(
        connection,
        scope.familyId,
        scope.actorMemberId,
        input.mediaId,
      );
      if (existing) {
        const [removed] = await connection.query<ResultSetHeader>(
          `DELETE FROM user_favorites
            WHERE id = ? AND family_id = ? AND member_id = ? AND media_id = ?`,
          [existing, scope.familyId, scope.actorMemberId, input.mediaId],
        );
        if (removed.affectedRows !== 1) {
          throw new AlbumRepositoryError("CONFLICT");
        }
      }
      return { isFavorite: false };
    });
  }

  async putFeatured(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
  }): Promise<{
    isFamilyFeatured: true;
    familyId: string;
    actorMemberId: string;
  }> {
    return this.mutateMediaState(
      input,
      { requireFeaturedManager: true },
      async (connection, scope) => {
        const existing = await lockFeatured(
          connection,
          scope.familyId,
          input.mediaId,
        );
        if (existing) return { isFamilyFeatured: true };
        try {
          await connection.query<ResultSetHeader>(
            `INSERT INTO family_featured
            (family_id, media_id, featured_by_member_id)
           VALUES (?, ?, ?)`,
            [scope.familyId, input.mediaId, scope.actorMemberId],
          );
        } catch (error) {
          if (
            !isApprovedIdentityDuplicate(error, "uq_family_featured_identity")
          ) {
            throw error;
          }
          const raced = await lockFeatured(
            connection,
            scope.familyId,
            input.mediaId,
          );
          if (!raced) throw error;
        }
        return { isFamilyFeatured: true };
      },
    );
  }

  async deleteFeatured(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
  }): Promise<{
    isFamilyFeatured: false;
    familyId: string;
    actorMemberId: string;
  }> {
    return this.mutateMediaState(
      input,
      { requireFeaturedManager: true },
      async (connection, scope) => {
        const existing = await lockFeatured(
          connection,
          scope.familyId,
          input.mediaId,
        );
        if (existing) {
          const [removed] = await connection.query<ResultSetHeader>(
            `DELETE FROM family_featured
            WHERE id = ? AND family_id = ? AND media_id = ?`,
            [existing, scope.familyId, input.mediaId],
          );
          if (removed.affectedRows !== 1) {
            throw new AlbumRepositoryError("CONFLICT");
          }
        }
        return { isFamilyFeatured: false };
      },
    );
  }

  async listMediaTags(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
  }): Promise<MediaTagRecord[]> {
    const result = await this.mutateMediaState(
      input,
      {},
      async (connection, scope) => ({
        items: await readMediaTags(connection, scope.familyId, input.mediaId),
      }),
    );
    return result.items;
  }

  async createAndApplyMediaTag(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
    name: string;
    normalizedName: Buffer;
  }): Promise<MediaTagRecord & { familyId: string; actorMemberId: string }> {
    return this.mutateMediaState(
      input,
      { requireEdit: true },
      async (connection, scope) => {
        let tag = await lockTagByIdentity(
          connection,
          scope.familyId,
          input.normalizedName,
        );
        if (!tag) {
          try {
            await connection.query<ResultSetHeader>(
              `INSERT INTO tags (family_id, name, name_normalized)
               VALUES (?, ?, ?)`,
              [scope.familyId, input.name, input.normalizedName],
            );
          } catch (error) {
            if (!isApprovedIdentityDuplicate(error, "uq_tags_identity")) {
              throw error;
            }
          }
          tag = await lockTagByIdentity(
            connection,
            scope.familyId,
            input.normalizedName,
          );
          if (!tag) throw new AlbumRepositoryError("CONFLICT");
        }
        await attachMediaTag(connection, scope.familyId, input.mediaId, tag.id);
        return tag;
      },
      "TAG_CREATE_APPLY",
    );
  }

  async applyMediaTag(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
    tagId: string;
  }): Promise<MediaTagRecord & { familyId: string; actorMemberId: string }> {
    return this.mutateMediaState(
      input,
      { requireEdit: true },
      async (connection, scope) => {
        const tag = await lockVisibleTag(
          connection,
          scope.familyId,
          scope.actorMemberId,
          input.tagId,
        );
        if (!tag) throw new AlbumRepositoryError("NOT_FOUND");
        await attachMediaTag(connection, scope.familyId, input.mediaId, tag.id);
        return tag;
      },
      "TAG_APPLY_EXISTING",
    );
  }

  async removeMediaTag(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
    tagId: string;
  }): Promise<{ removed: true; familyId: string; actorMemberId: string }> {
    return this.mutateMediaState(
      input,
      { requireEdit: true },
      async (connection, scope) => {
        await connection.query<ResultSetHeader>(
          `DELETE FROM media_tags
            WHERE family_id = ? AND media_id = ? AND tag_id = ?`,
          [scope.familyId, input.mediaId, input.tagId],
        );
        return { removed: true as const };
      },
      "TAG_REMOVE",
    );
  }

  async updateMediaNote(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
    note: string | null;
    expectedRevision: string;
  }): Promise<{
    note: string | null;
    noteRevision: string;
    familyId: string;
    actorMemberId: string;
  }> {
    return this.mutateMediaState(
      input,
      { requireEdit: true },
      async (connection, scope) => {
        if (input.expectedRevision === "18446744073709551615") {
          throw new AlbumRepositoryError("CONFLICT");
        }
        const [updated] = await connection.query<ResultSetHeader>(
          `UPDATE media_items
              SET description = ?, note_revision = note_revision + 1
            WHERE family_id = ? AND id = ? AND note_revision = ?`,
          [input.note, scope.familyId, input.mediaId, input.expectedRevision],
        );
        if (updated.affectedRows !== 1) {
          throw new AlbumRepositoryError("CONFLICT");
        }
        return {
          note: input.note,
          noteRevision: (BigInt(input.expectedRevision) + 1n).toString(),
        };
      },
      "NOTE_UPDATE",
    );
  }

  async listMediaComments(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
    limit: number;
    cursor?: { createdAt: Date; id: string };
  }): Promise<MediaCommentRecord[]> {
    const result = await this.mutateMediaState(
      input,
      {},
      async (connection, scope) => ({
        items: await readMediaComments(
          connection,
          scope.familyId,
          input.mediaId,
          scope.actorMemberId,
          input.limit,
          input.cursor,
        ),
      }),
    );
    return result.items;
  }

  async createMediaComment(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
    body: string;
    admit: (actorMemberId: string) => void;
  }): Promise<
    MediaCommentRecord & { familyId: string; actorMemberId: string }
  > {
    let admitted = false;
    return this.mutateMediaState(
      input,
      {},
      async (connection, scope) => {
        if (!admitted) {
          input.admit(scope.actorMemberId);
          admitted = true;
        }
        await connection.query<ResultSetHeader>(
          `INSERT INTO comments (family_id, media_id, author_member_id, body)
         VALUES (?, ?, ?, ?)`,
          [scope.familyId, input.mediaId, scope.actorMemberId, input.body],
        );
        const [ids] = await connection.query<RowDataPacket[]>(
          "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id",
        );
        const id = String(ids[0]?.id ?? "");
        if (!id) throw new Error("Comment insert result is unavailable.");
        const [createdRows] = await connection.query<
          (RowDataPacket & { createdAt: Date })[]
        >(
          `SELECT created_at AS createdAt FROM comments
          WHERE family_id = ? AND media_id = ? AND id = ?`,
          [scope.familyId, input.mediaId, id],
        );
        const createdAt = createdRows[0]?.createdAt;
        if (!createdAt) throw new Error("Comment insert row is unavailable.");
        return {
          id,
          body: input.body,
          createdAt,
          author: {
            memberId: scope.actorMemberId,
            displayName: scope.actorDisplayName,
          },
          canDelete: true,
        };
      },
      "COMMENT_CREATE",
    );
  }

  async deleteMediaComment(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
    commentId: string;
  }): Promise<{ familyId: string; actorMemberId: string }> {
    return this.mutateMediaState(
      input,
      {},
      async (connection, scope) => {
        const [rows] = await connection.query<
          (RowDataPacket & { id: string; authorMemberId: string })[]
        >(
          `SELECT CAST(id AS CHAR) AS id,
                CAST(author_member_id AS CHAR) AS authorMemberId
           FROM comments
          WHERE family_id = ? AND media_id = ? AND id = ? FOR UPDATE`,
          [scope.familyId, input.mediaId, input.commentId],
        );
        const comment = rows[0];
        if (!comment) throw new AlbumRepositoryError("NOT_FOUND");
        if (String(comment.authorMemberId) !== scope.actorMemberId) {
          throw new AlbumRepositoryError("FORBIDDEN");
        }
        const [deleted] = await connection.query<ResultSetHeader>(
          `DELETE FROM comments
          WHERE id = ? AND family_id = ? AND media_id = ?
            AND author_member_id = ?`,
          [input.commentId, scope.familyId, input.mediaId, scope.actorMemberId],
        );
        if (deleted.affectedRows !== 1) {
          throw new AlbumRepositoryError("NOT_FOUND");
        }
        return {};
      },
      "COMMENT_DELETE",
    );
  }

  private async mutateMediaState<T>(
    input: { actor: Phase1CActor; albumId: string; mediaId: string },
    requirements: { requireFeaturedManager?: boolean; requireEdit?: boolean },
    mutate: (
      connection: PoolConnection,
      scope: {
        familyId: string;
        actorMemberId: string;
        actorDisplayName: string;
        actorRole: FamilyRole;
        album: AlbumRecord;
        now: Date;
      },
    ) => Promise<T>,
    testOperation?: AlbumRepositoryTestOperation,
  ): Promise<T & { familyId: string; actorMemberId: string }> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      const testHook = testOperation ? this.testOptions?.testHook : undefined;
      await lockFamily(
        connection,
        familyId,
        testHook && testOperation
          ? () =>
              testHook({
                stage: "FAMILY_LOCK_QUERY_DISPATCHED",
                operation: testOperation,
                familyId,
              })
          : undefined,
      );
      const actor = await lockActor(connection, familyId, input.actor);
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, actor.member.id)
        : undefined;
      const hasPlacement = await lockMediaPlacement(
        connection,
        familyId,
        input.albumId,
        input.mediaId,
      );
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      const visible = assertVisible(album, actor.member, grant);
      if (!hasPlacement) throw new AlbumRepositoryError("NOT_FOUND");
      if (
        requirements.requireFeaturedManager &&
        actor.member.role !== "ADMIN" &&
        actor.member.role !== "SUPER_ADMIN"
      ) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }
      if (requirements.requireEdit && !visible.effectivePermissions.canEdit) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }
      const scope = {
        familyId,
        actorMemberId: actor.member.id,
        actorDisplayName: actor.user?.displayName ?? "Family member",
        actorRole: actor.member.role,
        album: visible,
        now,
      };
      const result = await mutate(connection, scope);
      if (testHook && testOperation) {
        await testHook({
          stage: "MUTATION_APPLIED_BEFORE_COMMIT",
          operation: testOperation,
          familyId,
        });
      }
      return {
        ...result,
        familyId: scope.familyId,
        actorMemberId: scope.actorMemberId,
      };
    });
  }

  private async authorizeOriginalDownload(
    input: { actor: Phase1CActor; albumId: string; mediaId: string },
    operation: "ORIGINAL_DOWNLOAD_PREPARE" | "ORIGINAL_DOWNLOAD_RECHECK",
    expected?: OriginalDownloadRecord,
  ): Promise<OriginalDownloadRecord> {
    const targets = await this.locateOriginalDownloadTargets(
      input.albumId,
      input.mediaId,
    );
    if (!targets.familyId) throw new AlbumRepositoryError("NOT_FOUND");
    const familyId = targets.familyId;
    return runCheckedTransaction(this.pool, async (connection) => {
      const testHook = this.testOptions?.testHook;
      await lockFamily(connection, familyId, () =>
        testHook?.({
          stage: "FAMILY_LOCK_QUERY_DISPATCHED",
          operation,
          familyId,
        }),
      );
      const actor = await lockActor(connection, familyId, input.actor);
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, actor.member.id)
        : undefined;
      const storage = targets.storageObjectId
        ? await lockOriginalStorage(
            connection,
            familyId,
            targets.storageObjectId,
          )
        : undefined;
      const media = await lockOriginalMedia(
        connection,
        familyId,
        input.mediaId,
      );
      const placement = await lockExactPlacement(
        connection,
        familyId,
        input.albumId,
        input.mediaId,
      );
      const receipt = targets.sourceUploadId
        ? await lockOriginalReceipt(
            connection,
            familyId,
            targets.sourceUploadId,
          )
        : undefined;
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      assertVisible(album, actor.member, grant);
      if (!media || !placement) throw new AlbumRepositoryError("NOT_FOUND");
      if (media.processingState === "BLOCKED") {
        throw new AlbumRepositoryError("NOT_FOUND");
      }
      if (!ORIGINAL_MEDIA_STATES.has(media.processingState)) {
        throw new AlbumRepositoryError("NOT_FOUND");
      }
      const record = validatedOriginalDownloadRecord({
        familyId,
        albumId: input.albumId,
        actorMemberId: actor.member.id,
        mediaId: input.mediaId,
        storage,
        media,
        receipt,
      });
      if (expected && expected.lifecycleRevision !== record.lifecycleRevision)
        throw new AlbumRepositoryError("NOT_FOUND");
      if (expected && !sameOriginalIdentity(expected, record)) {
        throw new AlbumRepositoryError("SERVICE_UNAVAILABLE");
      }
      const connectionId = testHook
        ? await readConnectionId(connection)
        : undefined;
      await testHook?.({
        stage: "ORIGINAL_DOWNLOAD_VALIDATED_BEFORE_COMMIT",
        operation,
        familyId,
        ...(connectionId === undefined ? {} : { connectionId }),
      });
      return record;
    });
  }

  private async authorizePreviewDownload(
    input: { actor: Phase1CActor; albumId: string; mediaId: string },
    operation: "PREVIEW_DOWNLOAD_PREPARE" | "PREVIEW_DOWNLOAD_RECHECK",
    expected?: PreviewDownloadRecord,
  ): Promise<PreviewDownloadRecord> {
    const targets = await this.locateOriginalDownloadTargets(
      input.albumId,
      input.mediaId,
    );
    if (!targets.familyId) throw new AlbumRepositoryError("NOT_FOUND");
    const familyId = targets.familyId;
    return runCheckedTransaction(this.pool, async (connection) => {
      const testHook = this.testOptions?.testHook;
      await lockFamily(connection, familyId, () =>
        testHook?.({
          stage: "FAMILY_LOCK_QUERY_DISPATCHED",
          operation,
          familyId,
        }),
      );
      const actor = await lockActor(connection, familyId, input.actor);
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, actor.member.id)
        : undefined;
      const storage = targets.storageObjectId
        ? await lockOriginalStorage(
            connection,
            familyId,
            targets.storageObjectId,
          )
        : undefined;
      const media = await lockPreviewMedia(connection, familyId, input.mediaId);
      const placement = await lockExactPlacement(
        connection,
        familyId,
        input.albumId,
        input.mediaId,
      );
      const preview = media
        ? await lockCurrentPreview(connection, familyId, input.mediaId, media)
        : undefined;
      const configuredPreviewRecipeId =
        this.testOptions?.getConfiguredPreviewRecipeId?.() ?? 1;
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      assertVisible(album, actor.member, grant);
      if (!media || !placement) throw new AlbumRepositoryError("NOT_FOUND");
      if (!ORIGINAL_MEDIA_STATES.has(media.processingState)) {
        throw new AlbumRepositoryError("NOT_FOUND");
      }
      const record = validatedPreviewDownloadRecord({
        familyId,
        albumId: input.albumId,
        actorMemberId: actor.member.id,
        mediaId: input.mediaId,
        storage,
        media,
        preview,
        configuredPreviewRecipeId,
      });
      if (expected && !samePreviewIdentity(expected, record)) {
        throw new AlbumRepositoryError("NOT_FOUND");
      }
      const connectionId = testHook
        ? await readConnectionId(connection)
        : undefined;
      await testHook?.({
        stage: "PREVIEW_DOWNLOAD_VALIDATED_BEFORE_COMMIT",
        operation,
        familyId,
        ...(connectionId === undefined ? {} : { connectionId }),
      });
      return record;
    });
  }

  private async mutatePlacement<T extends { albumId: string; mediaId: string }>(
    input: { actor: Phase1CActor; albumId: string; mediaId: string },
    allow: (context: AlbumPermissionContext) => boolean,
    mutate: (connection: PoolConnection, album: AlbumRecord) => Promise<T>,
  ): Promise<T> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const actor = await lockActor(connection, familyId, input.actor);
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, actor.member.id)
        : undefined;
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      if (!album) throw new AlbumRepositoryError("NOT_FOUND");
      const visible = assertVisible(album, actor.member, grant);
      const [active] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM media_items WHERE family_id=? AND id=? AND ${activeMediaSql("media_items")} FOR UPDATE`,
        [familyId, input.mediaId],
      );
      assertActor(actor, input.actor, await readServerTime(connection));
      if (!active[0]) throw new AlbumRepositoryError("NOT_FOUND");
      if (!allow(albumPermissionContext(album, actor.member, grant))) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }
      return mutate(connection, visible);
    });
  }

  private async withVisibleAlbum<T>(
    actor: Phase1CActor,
    albumId: string,
    read: (
      connection: PoolConnection,
      album: AlbumRecord,
      actorMemberId: string,
    ) => Promise<T>,
  ): Promise<T> {
    const familyId = await this.locateAlbumFamily(albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const locked = await lockActor(connection, familyId, actor);
      const album = await lockAlbum(connection, familyId, albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, locked.member.id)
        : undefined;
      const now = await readServerTime(connection);
      assertActor(locked, actor, now);
      const visible = assertVisible(album, locked.member, grant);
      return read(connection, visible, locked.member.id);
    });
  }

  async updateAlbum(input: {
    actor: Phase1CActor;
    albumId: string;
    expectedRevision: string;
    name?: string;
    description?: string | null;
    visibility?: AlbumVisibility;
  }): Promise<
    AlbumRecord & { actorMemberId: string; changedFields: string[] }
  > {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const actor = await lockActor(connection, familyId, input.actor);
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, actor.member.id)
        : undefined;
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      const current = assertVisible(album, actor.member, grant);
      if (input.visibility !== undefined) {
        assertRecentAuth(actor.session, now);
      }
      if (!current.effectivePermissions.canEdit) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }
      if (
        input.visibility !== undefined &&
        current.ownerMemberId !== actor.member.id
      ) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }
      if (current.revision !== input.expectedRevision) {
        throw new AlbumRepositoryError("CONFLICT");
      }

      const changedFields: string[] = [];
      if (input.name !== undefined && input.name !== current.name)
        changedFields.push("name");
      if (
        input.description !== undefined &&
        input.description !== current.description
      )
        changedFields.push("description");
      if (
        input.visibility !== undefined &&
        input.visibility !== current.visibility
      )
        changedFields.push("visibility");
      if (changedFields.length === 0) {
        return { ...current, actorMemberId: actor.member.id, changedFields };
      }

      const assignments: string[] = [];
      const values: unknown[] = [];
      if (changedFields.includes("name")) {
        assignments.push("name = ?");
        values.push(input.name);
      }
      if (changedFields.includes("description")) {
        assignments.push("description = ?");
        values.push(input.description);
      }
      if (changedFields.includes("visibility")) {
        assignments.push("visibility = ?");
        values.push(input.visibility);
      }
      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE albums SET ${assignments.join(", ")},
                revision = revision + 1, updated_at = ?
          WHERE id = ? AND family_id = ? AND revision = ?
            AND deleted_at IS NULL`,
        [...values, now, input.albumId, familyId, input.expectedRevision],
      );
      if (updated.affectedRows !== 1) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      const refreshed = await readAlbum(connection, familyId, input.albumId);
      if (!refreshed) throw new AlbumRepositoryError("CONFLICT");
      return {
        ...toAlbumRecord(refreshed, actor.member, grant),
        actorMemberId: actor.member.id,
        changedFields,
      };
    });
  }

  async softDeleteAlbum(input: {
    actor: Phase1CActor;
    albumId: string;
    expectedRevision: string;
  }): Promise<{ actorMemberId: string; familyId: string; revision: string }> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const actor = await lockActor(connection, familyId, input.actor);
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, actor.member.id)
        : undefined;
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      const current = assertVisible(album, actor.member, grant);
      assertRecentAuth(actor.session, now);
      if (current.ownerMemberId !== actor.member.id) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }
      if (current.revision !== input.expectedRevision) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE albums SET deleted_at = ?, updated_at = ?, revision = revision + 1
          WHERE id = ? AND family_id = ? AND revision = ?
            AND deleted_at IS NULL`,
        [now, now, input.albumId, familyId, input.expectedRevision],
      );
      if (updated.affectedRows !== 1) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      return {
        actorMemberId: actor.member.id,
        familyId,
        revision: (BigInt(current.revision) + 1n).toString(),
      };
    });
  }

  async listAlbumMembers(input: {
    actor: Phase1CActor;
    albumId: string;
  }): Promise<AlbumMemberRecord[]> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const [albumLocation] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(owner_member_id AS CHAR) AS ownerMemberId
           FROM albums WHERE id = ? AND family_id = ? LIMIT 1`,
        [input.albumId, familyId],
      );
      const ownerMemberId = albumLocation[0]
        ? String(albumLocation[0].ownerMemberId)
        : null;
      const [grantLocations] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(id AS CHAR) AS id, CAST(member_id AS CHAR) AS memberId
           FROM album_members WHERE family_id = ? AND album_id = ?
          ORDER BY id ASC`,
        [familyId, input.albumId],
      );
      const actorLocation = await locateMemberByUser(
        connection,
        familyId,
        input.actor.userId,
      );
      if (!actorLocation) throw new AlbumRepositoryError("NOT_FOUND");
      const relevantMemberIds = [
        actorLocation.id,
        ...(ownerMemberId ? [ownerMemberId] : []),
        ...grantLocations.map((row) => String(row.memberId)),
      ];
      const locations = await locateMembersByIds(
        connection,
        familyId,
        relevantMemberIds,
      );
      const users = await lockUsers(
        connection,
        locations.map((member) => member.userId),
      );
      const session = await lockActorSession(connection, input.actor);
      const members = await lockMembers(
        connection,
        familyId,
        locations.map((member) => member.id),
      );
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grants = await lockGrantsByIds(
        connection,
        grantLocations.map((row) => String(row.id)),
      );
      const now = await readServerTime(connection);
      const actorMember = members.get(actorLocation.id);
      if (!actorMember) throw new AlbumRepositoryError("NOT_FOUND");
      const actorState: LockedActor = {
        member: actorMember,
        user: users.get(input.actor.userId),
        session,
      };
      assertActor(actorState, input.actor, now);
      const actorGrant = [...grants.values()].find(
        (grant) =>
          grantLocations.find((row) => String(row.id) === grant.id)
            ?.memberId === actorMember.id,
      );
      const visible = assertVisible(album, actorMember, actorGrant);
      if (!visible.effectivePermissions.canManageMembers) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }

      const records = new Map<string, AlbumMemberRecord>();
      if (ownerMemberId) {
        const owner = members.get(ownerMemberId);
        const ownerUser = owner ? users.get(owner.userId) : undefined;
        if (owner && ownerUser) {
          records.set(owner.id, {
            memberId: owner.id,
            displayName: ownerUser.displayName,
            active: !ownerUser.disabledAt && !owner.disabledAt && !owner.leftAt,
            isOwner: true,
            ...ownerPermissions(),
          });
        }
      }
      for (const location of grantLocations) {
        const memberId = String(location.memberId);
        if (memberId === ownerMemberId) continue;
        const member = members.get(memberId);
        const user = member ? users.get(member.userId) : undefined;
        const grant = grants.get(String(location.id));
        if (!member || !user || !grant) continue;
        records.set(memberId, {
          memberId,
          displayName: user.displayName,
          active: !user.disabledAt && !member.disabledAt && !member.leftAt,
          isOwner: false,
          ...grantPermissions(grant),
        });
      }
      return [...records.values()].sort((left, right) =>
        compareIds(left.memberId, right.memberId),
      );
    });
  }

  async putAlbumMember(input: {
    actor: Phase1CActor;
    albumId: string;
    targetMemberId: string;
    expectedRevision: string;
    permissions: AlbumPermissionGrant;
  }): Promise<{
    actorMemberId: string;
    familyId: string;
    revision: string;
    action: "ADDED" | "CHANGED" | "NONE";
  }> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const state = await lockAclState(connection, familyId, input.actor, {
        albumId: input.albumId,
        targetMemberId: input.targetMemberId,
      });
      const now = await readServerTime(connection);
      assertActor(state, input.actor, now);
      const current = assertVisible(
        state.album,
        state.member,
        state.actorGrant,
      );
      assertRecentAuth(state.session, now);
      assertCanMutateGrant(
        state,
        current.effectivePermissions,
        input.permissions,
      );
      if (current.revision !== input.expectedRevision) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      const existing = state.targetGrant
        ? grantPermissions(state.targetGrant)
        : null;
      if (existing && samePermissions(existing, input.permissions)) {
        return {
          actorMemberId: state.member.id,
          familyId,
          revision: current.revision,
          action: "NONE",
        };
      }

      const nextRevision = await advanceAlbumRevision(
        connection,
        state.album!,
        input.expectedRevision,
        now,
      );
      if (state.targetGrant) {
        const [updated] = await connection.query<ResultSetHeader>(
          `UPDATE album_members
              SET can_view = ?, can_upload = ?, can_edit = ?, can_delete = ?,
                  can_manage_members = ?, updated_at = ?
            WHERE id = ? AND family_id = ? AND album_id = ? AND member_id = ?`,
          [
            input.permissions.canView,
            input.permissions.canUpload,
            input.permissions.canEdit,
            input.permissions.canDelete,
            input.permissions.canManageMembers,
            now,
            state.targetGrant.id,
            familyId,
            input.albumId,
            input.targetMemberId,
          ],
        );
        if (updated.affectedRows !== 1) {
          throw new AlbumRepositoryError("CONFLICT");
        }
      } else {
        await connection.query<ResultSetHeader>(
          `INSERT INTO album_members
            (family_id, album_id, member_id, can_view, can_upload, can_edit,
             can_delete, can_manage_members, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            familyId,
            input.albumId,
            input.targetMemberId,
            input.permissions.canView,
            input.permissions.canUpload,
            input.permissions.canEdit,
            input.permissions.canDelete,
            input.permissions.canManageMembers,
            now,
            now,
          ],
        );
      }
      return {
        actorMemberId: state.member.id,
        familyId,
        revision: nextRevision,
        action: state.targetGrant ? "CHANGED" : "ADDED",
      };
    });
  }

  async removeAlbumMember(input: {
    actor: Phase1CActor;
    albumId: string;
    targetMemberId: string;
    expectedRevision: string;
  }): Promise<{
    actorMemberId: string;
    familyId: string;
    revision: string;
    changed: boolean;
  }> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const state = await lockAclState(connection, familyId, input.actor, {
        albumId: input.albumId,
        targetMemberId: input.targetMemberId,
      });
      const now = await readServerTime(connection);
      assertActor(state, input.actor, now);
      const current = assertVisible(
        state.album,
        state.member,
        state.actorGrant,
      );
      assertRecentAuth(state.session, now);
      assertCanMutateGrant(state, current.effectivePermissions);
      if (current.revision !== input.expectedRevision) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      if (!state.targetGrant) {
        return {
          actorMemberId: state.member.id,
          familyId,
          revision: current.revision,
          changed: false,
        };
      }
      const nextRevision = await advanceAlbumRevision(
        connection,
        state.album!,
        input.expectedRevision,
        now,
      );
      const [removed] = await connection.query<ResultSetHeader>(
        `DELETE FROM album_members
          WHERE id = ? AND family_id = ? AND album_id = ? AND member_id = ?`,
        [state.targetGrant.id, familyId, input.albumId, input.targetMemberId],
      );
      if (removed.affectedRows !== 1) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      return {
        actorMemberId: state.member.id,
        familyId,
        revision: nextRevision,
        changed: true,
      };
    });
  }

  async withAlbumManager<T>(
    input: { actor: Phase1CActor; albumId: string },
    work: (
      connection: PoolConnection,
      scope: { album: AlbumRecord; actorMemberId: string; now: Date },
    ) => Promise<T>,
  ): Promise<T> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const actor = await lockActor(connection, familyId, input.actor);
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, actor.member.id)
        : undefined;
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      if (!album) throw new AlbumRepositoryError("NOT_FOUND");
      const visible = assertVisible(album, actor.member, grant);
      if (
        !canManageAlbumMembers(
          albumPermissionContext(album, actor.member, grant),
        )
      ) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }
      return work(connection, {
        album: visible,
        actorMemberId: actor.member.id,
        now,
      });
    });
  }

  async listManagedAlbumIds(input: {
    actor: Phase1CActor;
    familyId: string;
  }): Promise<string[]> {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const actor = await lockActor(connection, input.familyId, input.actor);
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      const [rows] = await connection.query<(AlbumRow & GrantRow)[]>(
        `SELECT CAST(a.id AS CHAR) AS id, CAST(a.family_id AS CHAR) AS familyId,
                CAST(a.owner_member_id AS CHAR) AS ownerMemberId,
                a.name, a.description, a.visibility,
                CAST(a.revision AS CHAR) AS revision,
                a.created_at AS createdAt, a.updated_at AS updatedAt,
                a.deleted_at AS deletedAt,
                COALESCE(am.can_view, 0) AS canView,
                COALESCE(am.can_upload, 0) AS canUpload,
                COALESCE(am.can_edit, 0) AS canEdit,
                COALESCE(am.can_delete, 0) AS canDelete,
                COALESCE(am.can_manage_members, 0) AS canManageMembers
           FROM albums a
           LEFT JOIN album_members am
             ON am.family_id = a.family_id AND am.album_id = a.id
            AND am.member_id = ?
          WHERE a.family_id = ? AND a.deleted_at IS NULL
            AND (a.owner_member_id = ? OR a.visibility = 'FAMILY'
                 OR am.can_view = 1)`,
        [actor.member.id, input.familyId, actor.member.id],
      );
      return rows
        .map((row) => toAlbumRecord(row, actor.member, row))
        .filter((album) => album.effectivePermissions.canManageMembers)
        .map((album) => album.id);
    });
  }

  private async locateAlbumFamily(albumId: string): Promise<string | null> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT CAST(family_id AS CHAR) AS familyId FROM albums WHERE id = ? LIMIT 1",
        [albumId],
      );
      return rows[0] ? String(rows[0].familyId) : null;
    } finally {
      connection.release();
    }
  }

  private async locateOriginalDownloadTargets(
    albumId: string,
    mediaId: string,
  ): Promise<{
    familyId: string | null;
    storageObjectId: string | null;
    sourceUploadId: string | null;
  }> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [albums] = await connection.query<RowDataPacket[]>(
        "SELECT CAST(family_id AS CHAR) AS familyId FROM albums WHERE id = ? LIMIT 1",
        [albumId],
      );
      const familyId = albums[0] ? String(albums[0].familyId) : null;
      if (!familyId) {
        return { familyId: null, storageObjectId: null, sourceUploadId: null };
      }
      const [media] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(storage_object_id AS CHAR) AS storageObjectId,
                CAST(source_upload_id AS CHAR) AS sourceUploadId
           FROM media_items WHERE family_id = ? AND id = ? LIMIT 1`,
        [familyId, mediaId],
      );
      return {
        familyId,
        storageObjectId: media[0] ? String(media[0].storageObjectId) : null,
        sourceUploadId: media[0] ? String(media[0].sourceUploadId) : null,
      };
    } finally {
      connection.release();
    }
  }
}

const ORIGINAL_MEDIA_STATES = new Set([
  "PENDING",
  "PROCESSING",
  "READY",
  "PARTIAL",
  "FAILED",
]);

type OriginalStorageRow = RowDataPacket & {
  id: string;
  familyId: string;
  sha256: Buffer;
  byteSize: string;
  keyVersion: number;
  state: "AVAILABLE" | "MISSING" | "CORRUPT";
};

type OriginalMediaRow = RowDataPacket & {
  lifecycleRevision: string;
  id: string;
  familyId: string;
  storageObjectId: string;
  sourceUploadId: string;
  generation: string;
  metadataGeneration: string | null;
  detectedMime: string | null;
  processingState: string;
};

type PreviewMediaRow = OriginalMediaRow & {
  recipeId: number;
};

type PreviewAssetRow = RowDataPacket & {
  id: string;
  familyId: string;
  mediaId: string;
  generation: string;
  recipeId: number;
  kind: string;
  state: string;
  reservedBytes: string;
  byteSize: string | null;
  sha256: Buffer | null;
  width: number | null;
  height: number | null;
  outputMime: string | null;
  producerJobId: string;
  producerLeaseEpoch: string | null;
  publishedAt: Date | null;
  cleanedAt: Date | null;
};

type OriginalReceiptRow = RowDataPacket & {
  id: string;
  familyId: string;
  originalFilename: string;
  declaredSize: string;
  committedOffset: string;
  state: string;
  computedSha256: Buffer | null;
  storageObjectId: string | null;
};

async function lockOriginalStorage(
  connection: PoolConnection,
  familyId: string,
  storageObjectId: string,
) {
  const [rows] = await connection.query<OriginalStorageRow[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            sha256, CAST(byte_size AS CHAR) AS byteSize,
            key_version AS keyVersion, state
       FROM storage_objects
      WHERE family_id = ? AND id = ? FOR UPDATE`,
    [familyId, storageObjectId],
  );
  return rows[0];
}

async function lockOriginalMedia(
  connection: PoolConnection,
  familyId: string,
  mediaId: string,
) {
  const [rows] = await connection.query<OriginalMediaRow[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            CAST(storage_object_id AS CHAR) AS storageObjectId,
            CAST(source_upload_id AS CHAR) AS sourceUploadId,
            CAST(generation AS CHAR) AS generation,
            CAST(lifecycle_revision AS CHAR) AS lifecycleRevision,
            CAST(metadata_generation AS CHAR) AS metadataGeneration,
            detected_mime AS detectedMime, processing_state AS processingState
       FROM media_items
      WHERE family_id = ? AND id = ? AND ${activeMediaSql("media_items")} FOR UPDATE`,
    [familyId, mediaId],
  );
  return rows[0];
}

async function lockPreviewMedia(
  connection: PoolConnection,
  familyId: string,
  mediaId: string,
) {
  const [rows] = await connection.query<PreviewMediaRow[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            CAST(storage_object_id AS CHAR) AS storageObjectId,
            CAST(source_upload_id AS CHAR) AS sourceUploadId,
            CAST(generation AS CHAR) AS generation,
            CAST(lifecycle_revision AS CHAR) AS lifecycleRevision,
            recipe_id AS recipeId, processing_state AS processingState,
            CAST(metadata_generation AS CHAR) AS metadataGeneration,
            detected_mime AS detectedMime
       FROM media_items
      WHERE family_id = ? AND id = ? AND ${activeMediaSql("media_items")} FOR UPDATE`,
    [familyId, mediaId],
  );
  return rows[0];
}

async function lockCurrentPreview(
  connection: PoolConnection,
  familyId: string,
  mediaId: string,
  media: PreviewMediaRow,
) {
  const [rows] = await connection.query<PreviewAssetRow[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            CAST(media_id AS CHAR) AS mediaId,
            CAST(generation AS CHAR) AS generation,
            recipe_id AS recipeId, kind, state,
            CAST(reserved_bytes AS CHAR) AS reservedBytes,
            CAST(byte_size AS CHAR) AS byteSize, sha256, width, height,
            output_mime AS outputMime,
            CAST(producer_job_id AS CHAR) AS producerJobId,
            CAST(producer_lease_epoch AS CHAR) AS producerLeaseEpoch,
            published_at AS publishedAt, cleaned_at AS cleanedAt
       FROM derived_assets
      WHERE family_id = ? AND media_id = ? AND generation = ?
        AND recipe_id = ? AND kind = 'PREVIEW'
      FOR UPDATE`,
    [familyId, mediaId, media.generation, media.recipeId],
  );
  return rows[0];
}

async function lockExactPlacement(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
  mediaId: string,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT id FROM album_media
      WHERE family_id = ? AND album_id = ? AND media_id = ? FOR UPDATE`,
    [familyId, albumId, mediaId],
  );
  return Boolean(rows[0]);
}

async function lockOriginalReceipt(
  connection: PoolConnection,
  familyId: string,
  sourceUploadId: string,
) {
  const [rows] = await connection.query<OriginalReceiptRow[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            original_filename AS originalFilename,
            CAST(declared_size AS CHAR) AS declaredSize,
            CAST(committed_offset AS CHAR) AS committedOffset,
            state, computed_sha256 AS computedSha256,
            CAST(storage_object_id AS CHAR) AS storageObjectId
       FROM upload_sessions
      WHERE family_id = ? AND id = ? FOR UPDATE`,
    [familyId, sourceUploadId],
  );
  return rows[0];
}

function validatedOriginalDownloadRecord(input: {
  familyId: string;
  albumId: string;
  actorMemberId: string;
  mediaId: string;
  storage: OriginalStorageRow | undefined;
  media: OriginalMediaRow;
  receipt: OriginalReceiptRow | undefined;
}): OriginalDownloadRecord {
  const { storage, media, receipt } = input;
  if (
    !storage ||
    storage.familyId !== input.familyId ||
    storage.id !== media.storageObjectId ||
    storage.state !== "AVAILABLE" ||
    storage.keyVersion !== 1 ||
    !/^[1-9][0-9]*$/u.test(storage.byteSize) ||
    !Buffer.isBuffer(storage.sha256) ||
    storage.sha256.length !== 32
  ) {
    throw new AlbumRepositoryError("SERVICE_UNAVAILABLE");
  }
  if (
    !receipt ||
    receipt.familyId !== input.familyId ||
    receipt.id !== media.sourceUploadId ||
    receipt.state !== "COMPLETE" ||
    receipt.storageObjectId !== storage.id ||
    receipt.committedOffset !== receipt.declaredSize ||
    receipt.declaredSize !== storage.byteSize ||
    !Buffer.isBuffer(receipt.computedSha256) ||
    !receipt.computedSha256.equals(storage.sha256)
  ) {
    throw new AlbumRepositoryError("SERVICE_UNAVAILABLE");
  }
  return {
    familyId: input.familyId,
    albumId: input.albumId,
    actorMemberId: input.actorMemberId,
    mediaId: input.mediaId,
    storageObjectId: storage.id,
    keyVersion: storage.keyVersion,
    sha256Hex: storage.sha256.toString("hex"),
    byteSize: storage.byteSize,
    lifecycleRevision: media.lifecycleRevision,
    sourceUploadId: receipt.id,
    originalFilename: receipt.originalFilename,
    detectedMime:
      media.metadataGeneration !== null &&
      media.metadataGeneration === media.generation
        ? media.detectedMime
        : null,
  };
}

function sameOriginalIdentity(
  left: OriginalDownloadRecord,
  right: OriginalDownloadRecord,
) {
  return (
    left.lifecycleRevision === right.lifecycleRevision &&
    left.familyId === right.familyId &&
    left.albumId === right.albumId &&
    left.actorMemberId === right.actorMemberId &&
    left.mediaId === right.mediaId &&
    left.storageObjectId === right.storageObjectId &&
    left.keyVersion === right.keyVersion &&
    left.sha256Hex === right.sha256Hex &&
    left.byteSize === right.byteSize &&
    left.sourceUploadId === right.sourceUploadId
  );
}

const MAX_PREVIEW_BYTES = 4_194_304n;

function validatedPreviewDownloadRecord(input: {
  familyId: string;
  albumId: string;
  actorMemberId: string;
  mediaId: string;
  storage: OriginalStorageRow | undefined;
  media: PreviewMediaRow;
  preview: PreviewAssetRow | undefined;
  configuredPreviewRecipeId: number;
}): PreviewDownloadRecord {
  const { storage, media, preview } = input;
  if (
    !storage ||
    storage.familyId !== input.familyId ||
    storage.id !== media.storageObjectId ||
    storage.state !== "AVAILABLE" ||
    media.familyId !== input.familyId ||
    media.id !== input.mediaId ||
    media.recipeId !== 1 ||
    input.configuredPreviewRecipeId !== 1 ||
    !/^[1-9][0-9]*$/u.test(media.generation)
  ) {
    throw new AlbumRepositoryError("NOT_FOUND");
  }
  if (
    !preview ||
    preview.familyId !== input.familyId ||
    preview.mediaId !== input.mediaId ||
    preview.generation !== media.generation ||
    preview.recipeId !== media.recipeId ||
    preview.kind !== "PREVIEW" ||
    preview.state !== "READY" ||
    preview.cleanedAt !== null
  ) {
    throw new AlbumRepositoryError("NOT_FOUND");
  }
  if (
    !/^[1-9][0-9]*$/u.test(preview.id) ||
    !/^[1-9][0-9]*$/u.test(preview.reservedBytes) ||
    preview.byteSize === null ||
    !/^[1-9][0-9]*$/u.test(preview.byteSize) ||
    !Buffer.isBuffer(preview.sha256) ||
    preview.sha256.length !== 32 ||
    !Number.isInteger(preview.width) ||
    preview.width === null ||
    preview.width <= 0 ||
    !Number.isInteger(preview.height) ||
    preview.height === null ||
    preview.height <= 0 ||
    preview.outputMime !== "image/webp" ||
    !/^[1-9][0-9]*$/u.test(preview.producerJobId) ||
    preview.producerLeaseEpoch === null ||
    !/^[1-9][0-9]*$/u.test(preview.producerLeaseEpoch) ||
    !(preview.publishedAt instanceof Date)
  ) {
    throw new AlbumRepositoryError("SERVICE_UNAVAILABLE");
  }
  const reservedBytes = BigInt(preview.reservedBytes);
  const byteSize = BigInt(preview.byteSize);
  if (
    reservedBytes > MAX_PREVIEW_BYTES ||
    byteSize > reservedBytes ||
    byteSize > MAX_PREVIEW_BYTES
  ) {
    throw new AlbumRepositoryError("SERVICE_UNAVAILABLE");
  }
  const generation = BigInt(media.generation);
  return {
    familyId: input.familyId,
    albumId: input.albumId,
    actorMemberId: input.actorMemberId,
    mediaId: input.mediaId,
    storageObjectId: storage.id,
    sourceUploadId: media.sourceUploadId,
    lifecycleRevision: media.lifecycleRevision,
    originalSha256Hex: storage.sha256.toString("hex"),
    originalByteSize: storage.byteSize,
    mediaGeneration: generation,
    mediaRecipeId: 1,
    derivedAssetId: preview.id,
    derivedGeneration: generation,
    derivedRecipeId: 1,
    kind: "PREVIEW",
    byteSize,
    sha256Hex: preview.sha256.toString("hex"),
    outputMime: "image/webp",
    width: preview.width,
    height: preview.height,
    producerJobId: preview.producerJobId,
    producerLeaseEpoch: BigInt(preview.producerLeaseEpoch),
    publishedAt: preview.publishedAt,
    configuredPreviewRecipeId: 1,
  };
}

function samePreviewIdentity(
  left: PreviewDownloadRecord,
  right: PreviewDownloadRecord,
) {
  return (
    left.lifecycleRevision === right.lifecycleRevision &&
    left.familyId === right.familyId &&
    left.albumId === right.albumId &&
    left.actorMemberId === right.actorMemberId &&
    left.mediaId === right.mediaId &&
    left.storageObjectId === right.storageObjectId &&
    left.sourceUploadId === right.sourceUploadId &&
    left.mediaGeneration === right.mediaGeneration &&
    left.mediaRecipeId === right.mediaRecipeId &&
    left.derivedAssetId === right.derivedAssetId &&
    left.derivedGeneration === right.derivedGeneration &&
    left.derivedRecipeId === right.derivedRecipeId &&
    left.kind === right.kind &&
    left.byteSize === right.byteSize &&
    left.sha256Hex === right.sha256Hex &&
    left.outputMime === right.outputMime &&
    left.width === right.width &&
    left.height === right.height &&
    left.producerJobId === right.producerJobId &&
    left.producerLeaseEpoch === right.producerLeaseEpoch &&
    left.publishedAt.getTime() === right.publishedAt.getTime() &&
    left.configuredPreviewRecipeId === right.configuredPreviewRecipeId
  );
}

async function readConnectionId(connection: PoolConnection) {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT CONNECTION_ID() AS connectionId",
  );
  const connectionId = Number(rows[0]?.connectionId);
  if (!Number.isSafeInteger(connectionId) || connectionId <= 0) {
    throw new Error("MYSQL_CONNECTION_ID_INVALID");
  }
  return connectionId;
}

export async function lockFamily(
  connection: PoolConnection,
  familyId: string,
  onDispatched?: () => void | Promise<void>,
) {
  const pending = connection.query<RowDataPacket[]>(
    "SELECT CAST(id AS CHAR) AS id FROM families WHERE id = ? FOR UPDATE",
    [familyId],
  );
  if (onDispatched) {
    // Observe rejection immediately while a test hook may pause. Awaiting the
    // original promise below still propagates SQL errors to normal rollback.
    void pending.catch(() => undefined);
    await onDispatched();
  }
  const [rows] = await pending;
  if (!rows[0]) throw new AlbumRepositoryError("NOT_FOUND");
}

export async function lockActor(
  connection: PoolConnection,
  familyId: string,
  actor: Phase1CActor,
): Promise<LockedActor> {
  const [located] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id FROM family_members
      WHERE family_id = ? AND user_id = ? LIMIT 1`,
    [familyId, actor.userId],
  );
  const memberId = located[0] ? String(located[0].id) : null;
  if (!memberId) throw new AlbumRepositoryError("NOT_FOUND");

  const [users] = await connection.query<UserRow[]>(
    `SELECT CAST(id AS CHAR) AS id, display_name AS displayName,
            disabled_at AS disabledAt
       FROM users WHERE id = ? FOR UPDATE`,
    [actor.userId],
  );
  const [sessions] = await connection.query<SessionRow[]>(
    `SELECT token_hash AS tokenHash, client_type AS clientType,
            authenticated_at AS authenticatedAt, last_seen_at AS lastSeenAt,
            expires_at AS expiresAt, revoked_at AS revokedAt
       FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE`,
    [actor.sessionId, actor.userId],
  );
  const [members] = await connection.query<ActorMemberRow[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            CAST(user_id AS CHAR) AS userId, role,
            disabled_at AS disabledAt, left_at AS leftAt
       FROM family_members WHERE id = ? AND family_id = ? FOR UPDATE`,
    [memberId, familyId],
  );
  const member = members[0];
  if (!member) throw new AlbumRepositoryError("NOT_FOUND");
  return { member, user: users[0], session: sessions[0] };
}

async function lockAclState(
  connection: PoolConnection,
  familyId: string,
  actor: Phase1CActor,
  input: { albumId: string; targetMemberId: string },
): Promise<AclState> {
  const actorLocation = await locateMemberByUser(
    connection,
    familyId,
    actor.userId,
  );
  if (!actorLocation) throw new AlbumRepositoryError("NOT_FOUND");
  const targetLocation = (
    await locateMembersByIds(connection, familyId, [input.targetMemberId])
  )[0];
  const locations = [
    actorLocation,
    ...(targetLocation ? [targetLocation] : []),
  ];
  const users = await lockUsers(
    connection,
    locations.map((member) => member.userId),
  );
  const session = await lockActorSession(connection, actor);
  const members = await lockMembers(
    connection,
    familyId,
    locations.map((member) => member.id),
  );
  const album = await lockAlbum(connection, familyId, input.albumId);
  const grants = await lockGrantsForMembers(
    connection,
    familyId,
    input.albumId,
    [actorLocation.id, input.targetMemberId],
  );
  const actorMember = members.get(actorLocation.id);
  if (!actorMember) throw new AlbumRepositoryError("NOT_FOUND");
  const targetMember = targetLocation
    ? members.get(targetLocation.id)
    : undefined;
  return {
    member: actorMember,
    user: users.get(actor.userId),
    session,
    album,
    actorGrant: grants.get(actorLocation.id),
    targetMember,
    targetUser: targetMember ? users.get(targetMember.userId) : undefined,
    targetGrant: grants.get(input.targetMemberId),
  };
}

async function locateMemberByUser(
  connection: PoolConnection,
  familyId: string,
  userId: string,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            CAST(user_id AS CHAR) AS userId
       FROM family_members WHERE family_id = ? AND user_id = ? LIMIT 1`,
    [familyId, userId],
  );
  return rows[0]
    ? {
        id: String(rows[0].id),
        familyId: String(rows[0].familyId),
        userId: String(rows[0].userId),
      }
    : undefined;
}

async function locateMembersByIds(
  connection: PoolConnection,
  familyId: string,
  memberIds: readonly string[],
) {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return [];
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            CAST(user_id AS CHAR) AS userId
       FROM family_members WHERE family_id = ? AND id IN (?)`,
    [familyId, unique],
  );
  return rows.map((row) => ({
    id: String(row.id),
    familyId: String(row.familyId),
    userId: String(row.userId),
  }));
}

async function lockUsers(
  connection: PoolConnection,
  userIds: readonly string[],
) {
  const users = new Map<string, UserRow>();
  for (const userId of [...new Set(userIds)].sort(compareIds)) {
    const [rows] = await connection.query<UserRow[]>(
      `SELECT CAST(id AS CHAR) AS id, display_name AS displayName,
              disabled_at AS disabledAt
         FROM users WHERE id = ? FOR UPDATE`,
      [userId],
    );
    if (rows[0]) users.set(String(rows[0].id), rows[0]);
  }
  return users;
}

async function lockActorSession(
  connection: PoolConnection,
  actor: Phase1CActor,
) {
  const [rows] = await connection.query<SessionRow[]>(
    `SELECT token_hash AS tokenHash, client_type AS clientType,
            authenticated_at AS authenticatedAt, last_seen_at AS lastSeenAt,
            expires_at AS expiresAt, revoked_at AS revokedAt
       FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE`,
    [actor.sessionId, actor.userId],
  );
  return rows[0];
}

async function lockMembers(
  connection: PoolConnection,
  familyId: string,
  memberIds: readonly string[],
) {
  const members = new Map<string, ActorMemberRow>();
  for (const memberId of [...new Set(memberIds)].sort(compareIds)) {
    const [rows] = await connection.query<ActorMemberRow[]>(
      `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
              CAST(user_id AS CHAR) AS userId, role,
              disabled_at AS disabledAt, left_at AS leftAt
         FROM family_members WHERE id = ? AND family_id = ? FOR UPDATE`,
      [memberId, familyId],
    );
    if (rows[0]) members.set(String(rows[0].id), rows[0]);
  }
  return members;
}

export async function lockGrantsForMembers(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
  memberIds: readonly string[],
) {
  const [locations] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(member_id AS CHAR) AS memberId
       FROM album_members
      WHERE family_id = ? AND album_id = ? AND member_id IN (?)`,
    [familyId, albumId, [...new Set(memberIds)]],
  );
  const grantsById = await lockGrantsByIds(
    connection,
    locations.map((row) => String(row.id)),
  );
  const byMember = new Map<string, GrantRow>();
  for (const location of locations) {
    const grant = grantsById.get(String(location.id));
    if (grant) byMember.set(String(location.memberId), grant);
  }
  return byMember;
}

export async function lockGrantsByIds(
  connection: PoolConnection,
  grantIds: readonly string[],
) {
  const grants = new Map<string, GrantRow>();
  for (const grantId of [...new Set(grantIds)].sort(compareIds)) {
    const [rows] = await connection.query<GrantRow[]>(
      `SELECT CAST(id AS CHAR) AS id, can_view AS canView,
              can_upload AS canUpload, can_edit AS canEdit,
              can_delete AS canDelete, can_manage_members AS canManageMembers
         FROM album_members WHERE id = ? FOR UPDATE`,
      [grantId],
    );
    if (rows[0]) grants.set(String(rows[0].id), rows[0]);
  }
  return grants;
}

export function assertActor(
  state: LockedActor,
  actor: Phase1CActor,
  now: Date,
) {
  const { member, user, session } = state;
  if (
    !user ||
    !session ||
    user.disabledAt ||
    member.userId !== actor.userId ||
    member.disabledAt ||
    member.leftAt ||
    session.clientType !== (actor.expectedClientType ?? "WEB") ||
    session.revokedAt ||
    !Buffer.isBuffer(session.tokenHash) ||
    !session.tokenHash.equals(actor.tokenHash) ||
    now.getTime() >= session.expiresAt.getTime() ||
    now.getTime() >= session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS
  ) {
    throw new AlbumRepositoryError("UNAUTHENTICATED");
  }
}

function assertRecentAuth(session: SessionRow | undefined, now: Date) {
  const age = session
    ? now.getTime() - session.authenticatedAt.getTime()
    : Number.POSITIVE_INFINITY;
  if (age < 0 || age >= RECENT_AUTH_MS) {
    throw new AlbumRepositoryError("FORBIDDEN");
  }
}

export async function lockAlbum(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
) {
  const [rows] = await connection.query<AlbumRow[]>(
    `${albumSelect()} WHERE id = ? AND family_id = ? FOR UPDATE`,
    [albumId, familyId],
  );
  return rows[0];
}

async function readAlbum(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
) {
  const [rows] = await connection.query<AlbumRow[]>(
    `${albumSelect()} WHERE id = ? AND family_id = ?`,
    [albumId, familyId],
  );
  return rows[0];
}

function albumSelect() {
  return `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
                 CAST(owner_member_id AS CHAR) AS ownerMemberId,
                 name, description, visibility, CAST(revision AS CHAR) AS revision,
                 created_at AS createdAt, updated_at AS updatedAt,
                 deleted_at AS deletedAt FROM albums`;
}

export async function lockGrant(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
  memberId: string,
) {
  const [ids] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id FROM album_members
      WHERE family_id = ? AND album_id = ? AND member_id = ? LIMIT 1`,
    [familyId, albumId, memberId],
  );
  if (!ids[0]) return undefined;
  const [rows] = await connection.query<GrantRow[]>(
    `SELECT CAST(id AS CHAR) AS id, can_view AS canView,
            can_upload AS canUpload, can_edit AS canEdit,
            can_delete AS canDelete, can_manage_members AS canManageMembers
       FROM album_members WHERE id = ? FOR UPDATE`,
    [String(ids[0].id)],
  );
  return rows[0];
}

export async function lockIds(
  connection: PoolConnection,
  table: "albums" | "album_members",
  ids: readonly string[],
) {
  const sorted = [...new Set(ids)].sort(compareIds);
  for (const id of sorted) {
    await connection.query(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [
      id,
    ]);
  }
}

type AlbumMediaRow = RowDataPacket & {
  mediaId: string;
  timelineKey: Date;
  timelineBasis: AlbumMediaRecord["timelineBasis"];
  displayWidth: number | null;
  displayHeight: number | null;
  orientation: number | null;
  capturedLocalAt: Date | null;
  cameraMake: string | null;
  cameraModel: string | null;
  isFavorite: number;
  isFamilyFeatured: number;
};

async function readFamilyTimeline(
  connection: PoolConnection,
  familyId: string,
  memberId: string,
  limit: number,
  cursor?: { timelineKey: Date; mediaId: string },
): Promise<FamilyTimelineRecord[]> {
  const [rows] = await connection.query<
    (RowDataPacket & FamilyTimelineRecord)[]
  >(
    `SELECT CAST(m.id AS CHAR) AS mediaId,
            CAST(MIN(a.id) AS CHAR) AS albumId,
            m.timeline_key AS timelineKey,
            m.timeline_basis AS timelineBasis,
            m.display_width AS displayWidth,
            m.display_height AS displayHeight,
            MAX(CASE WHEN favorite.id IS NULL THEN 0 ELSE 1 END) AS isFavorite,
            MAX(CASE WHEN featured.id IS NULL THEN 0 ELSE 1 END) AS isFamilyFeatured
       FROM media_items m
       JOIN album_media placement
         ON placement.family_id = m.family_id
        AND placement.media_id = m.id
       JOIN albums a
         ON a.family_id = placement.family_id
        AND a.id = placement.album_id
        AND a.deleted_at IS NULL
       LEFT JOIN album_members grant_row
         ON grant_row.family_id = a.family_id
        AND grant_row.album_id = a.id
        AND grant_row.member_id = ?
       LEFT JOIN user_favorites favorite
         ON favorite.family_id = m.family_id
        AND favorite.media_id = m.id
        AND favorite.member_id = ?
       LEFT JOIN family_featured featured
         ON featured.family_id = m.family_id
        AND featured.media_id = m.id
      WHERE m.family_id = ? AND ${activeMediaSql("m")}
        AND (a.owner_member_id = ? OR a.visibility = 'FAMILY'
             OR grant_row.can_view = 1)
        AND (
          ? = 0
          OR m.timeline_key < ?
          OR (m.timeline_key = ? AND m.id < ?)
        )
      GROUP BY m.id, m.timeline_key, m.timeline_basis,
               m.display_width, m.display_height
      ORDER BY m.timeline_key DESC, m.id DESC
      LIMIT ?`,
    [
      memberId,
      memberId,
      familyId,
      memberId,
      cursor ? 1 : 0,
      cursor?.timelineKey ?? new Date(0),
      cursor?.timelineKey ?? new Date(0),
      cursor?.mediaId ?? "0",
      limit,
    ],
  );
  return rows.map((row) => ({
    mediaId: String(row.mediaId),
    albumId: String(row.albumId),
    timelineKey: row.timelineKey,
    timelineBasis: row.timelineBasis,
    displayWidth: nullableInteger(row.displayWidth),
    displayHeight: nullableInteger(row.displayHeight),
    isFavorite: Number(row.isFavorite) === 1,
    isFamilyFeatured: Number(row.isFamilyFeatured) === 1,
  }));
}

async function readAlbumMedia(
  connection: PoolConnection,
  album: AlbumRecord,
  actorMemberId: string,
  limit: number,
  cursor?: { timelineKey: Date; mediaId: string },
  mediaId?: string,
): Promise<AlbumMediaRecord[]> {
  const [rows] = await connection.query<AlbumMediaRow[]>(
    `SELECT CAST(m.id AS CHAR) AS mediaId,
            m.timeline_key AS timelineKey,
            m.timeline_basis AS timelineBasis,
            m.display_width AS displayWidth,
            m.display_height AS displayHeight,
            m.orientation AS orientation,
            m.captured_local_at AS capturedLocalAt,
            m.camera_make AS cameraMake,
            m.camera_model AS cameraModel,
            CASE WHEN favorite.id IS NULL THEN 0 ELSE 1 END AS isFavorite,
            CASE WHEN featured.id IS NULL THEN 0 ELSE 1 END AS isFamilyFeatured
       FROM album_media am
       JOIN media_items m
         ON m.family_id = am.family_id AND m.id = am.media_id
       LEFT JOIN user_favorites favorite
         ON favorite.family_id = m.family_id
        AND favorite.media_id = m.id
        AND favorite.member_id = ?
       LEFT JOIN family_featured featured
         ON featured.family_id = m.family_id
        AND featured.media_id = m.id
      WHERE am.family_id = ? AND am.album_id = ? AND ${activeMediaSql("m")}
        AND (? IS NULL OR am.media_id = ?)
        AND (
          ? = 0
          OR m.timeline_key < ?
          OR (m.timeline_key = ? AND m.id < ?)
        )
      ORDER BY m.timeline_key DESC, m.id DESC
      LIMIT ?`,
    [
      actorMemberId,
      album.familyId,
      album.id,
      mediaId ?? null,
      mediaId ?? null,
      cursor ? 1 : 0,
      cursor?.timelineKey ?? new Date(0),
      cursor?.timelineKey ?? new Date(0),
      cursor?.mediaId ?? "0",
      limit,
    ],
  );
  return rows.map((row) => ({
    mediaId: String(row.mediaId),
    timelineKey: row.timelineKey,
    timelineBasis: row.timelineBasis,
    displayWidth: nullableInteger(row.displayWidth),
    displayHeight: nullableInteger(row.displayHeight),
    orientation: nullableInteger(row.orientation),
    capturedLocalAt: row.capturedLocalAt,
    cameraMake: row.cameraMake,
    cameraModel: row.cameraModel,
    isFavorite: Number(row.isFavorite) === 1,
    isFamilyFeatured: Number(row.isFamilyFeatured) === 1,
  }));
}

async function lockMediaPlacement(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
  mediaId: string,
) {
  const [media] = await connection.query<RowDataPacket[]>(
    `SELECT id FROM media_items
      WHERE family_id = ? AND id = ? AND ${activeMediaSql("media_items")} FOR UPDATE`,
    [familyId, mediaId],
  );
  if (!media[0]) return false;
  const [placement] = await connection.query<RowDataPacket[]>(
    `SELECT id FROM album_media
      WHERE family_id = ? AND album_id = ? AND media_id = ? FOR UPDATE`,
    [familyId, albumId, mediaId],
  );
  return Boolean(placement[0]);
}

async function lockFavorite(
  connection: PoolConnection,
  familyId: string,
  memberId: string,
  mediaId: string,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id FROM user_favorites
      WHERE family_id = ? AND member_id = ? AND media_id = ? FOR UPDATE`,
    [familyId, memberId, mediaId],
  );
  return rows[0] ? String(rows[0].id) : null;
}

async function lockFeatured(
  connection: PoolConnection,
  familyId: string,
  mediaId: string,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id FROM family_featured
      WHERE family_id = ? AND media_id = ? FOR UPDATE`,
    [familyId, mediaId],
  );
  return rows[0] ? String(rows[0].id) : null;
}

async function readMediaTags(
  connection: PoolConnection,
  familyId: string,
  mediaId: string,
): Promise<MediaTagRecord[]> {
  const [rows] = await connection.query<(RowDataPacket & MediaTagRecord)[]>(
    `SELECT CAST(t.id AS CHAR) AS id, t.name
       FROM media_tags mt
       JOIN tags t ON t.family_id = mt.family_id AND t.id = mt.tag_id
      WHERE mt.family_id = ? AND mt.media_id = ?
      ORDER BY t.name_normalized ASC, t.id ASC
      LIMIT 64`,
    [familyId, mediaId],
  );
  return rows.map((row) => ({ id: String(row.id), name: row.name }));
}

async function readMediaNote(
  connection: PoolConnection,
  familyId: string,
  mediaId: string,
) {
  const [rows] = await connection.query<
    (RowDataPacket & { note: string | null; noteRevision: string })[]
  >(
    `SELECT description AS note, CAST(note_revision AS CHAR) AS noteRevision
       FROM media_items WHERE family_id = ? AND id = ?`,
    [familyId, mediaId],
  );
  const row = rows[0];
  if (!row) throw new AlbumRepositoryError("NOT_FOUND");
  return { note: row.note, noteRevision: String(row.noteRevision) };
}

async function readCommentCount(
  connection: PoolConnection,
  familyId: string,
  mediaId: string,
) {
  const [rows] = await connection.query<
    (RowDataPacket & { commentCount: string })[]
  >(
    `SELECT CAST(COUNT(*) AS CHAR) AS commentCount
       FROM comments WHERE family_id = ? AND media_id = ?`,
    [familyId, mediaId],
  );
  return String(rows[0]?.commentCount ?? "0");
}

async function lockTagByIdentity(
  connection: PoolConnection,
  familyId: string,
  normalizedName: Buffer,
): Promise<MediaTagRecord | null> {
  const [rows] = await connection.query<(RowDataPacket & MediaTagRecord)[]>(
    `SELECT CAST(id AS CHAR) AS id, name FROM tags
      WHERE family_id = ? AND name_normalized = ? FOR UPDATE`,
    [familyId, normalizedName],
  );
  return rows[0] ? { id: String(rows[0].id), name: rows[0].name } : null;
}

async function lockVisibleTag(
  connection: PoolConnection,
  familyId: string,
  actorMemberId: string,
  tagId: string,
): Promise<MediaTagRecord | null> {
  const [rows] = await connection.query<(RowDataPacket & MediaTagRecord)[]>(
    `SELECT CAST(t.id AS CHAR) AS id, t.name
       FROM tags t
       JOIN media_tags mt
         ON mt.family_id = t.family_id AND mt.tag_id = t.id
       JOIN media_items m ON m.family_id=mt.family_id AND m.id=mt.media_id AND ${activeMediaSql("m")}
       JOIN album_media placement
         ON placement.family_id = mt.family_id
        AND placement.media_id = mt.media_id
       JOIN albums a
         ON a.family_id = placement.family_id
        AND a.id = placement.album_id
        AND a.deleted_at IS NULL
       LEFT JOIN album_members grant_row
         ON grant_row.family_id = a.family_id
        AND grant_row.album_id = a.id
        AND grant_row.member_id = ?
      WHERE t.family_id = ? AND t.id = ?
        AND (a.owner_member_id = ? OR a.visibility = 'FAMILY'
             OR grant_row.can_view = 1)
      ORDER BY placement.album_id ASC
      LIMIT 1 FOR UPDATE`,
    [actorMemberId, familyId, tagId, actorMemberId],
  );
  return rows[0] ? { id: String(rows[0].id), name: rows[0].name } : null;
}

async function attachMediaTag(
  connection: PoolConnection,
  familyId: string,
  mediaId: string,
  tagId: string,
) {
  const [existing] = await connection.query<RowDataPacket[]>(
    `SELECT id FROM media_tags
      WHERE family_id = ? AND media_id = ? AND tag_id = ? FOR UPDATE`,
    [familyId, mediaId, tagId],
  );
  if (existing[0]) return;
  const [counts] = await connection.query<
    (RowDataPacket & { tagCount: string })[]
  >(
    `SELECT CAST(COUNT(*) AS CHAR) AS tagCount FROM media_tags
      WHERE family_id = ? AND media_id = ?`,
    [familyId, mediaId],
  );
  if (BigInt(String(counts[0]?.tagCount ?? "0")) >= 64n) {
    throw new AlbumRepositoryError("CONFLICT");
  }
  try {
    await connection.query<ResultSetHeader>(
      `INSERT INTO media_tags (family_id, media_id, tag_id)
       VALUES (?, ?, ?)`,
      [familyId, mediaId, tagId],
    );
  } catch (error) {
    if (!isApprovedIdentityDuplicate(error, "uq_media_tags_identity")) {
      throw error;
    }
    const [raced] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM media_tags
        WHERE family_id = ? AND media_id = ? AND tag_id = ? FOR UPDATE`,
      [familyId, mediaId, tagId],
    );
    if (!raced[0]) throw error;
  }
}

async function readMediaComments(
  connection: PoolConnection,
  familyId: string,
  mediaId: string,
  actorMemberId: string,
  limit: number,
  cursor?: { createdAt: Date; id: string },
): Promise<MediaCommentRecord[]> {
  const [rows] = await connection.query<
    (RowDataPacket & {
      id: string;
      body: string;
      createdAt: Date;
      authorMemberId: string;
      displayName: string;
    })[]
  >(
    `SELECT CAST(c.id AS CHAR) AS id, c.body, c.created_at AS createdAt,
            CAST(c.author_member_id AS CHAR) AS authorMemberId,
            COALESCE(u.display_name, 'Family member') AS displayName
       FROM comments c
       JOIN family_members fm
         ON fm.family_id = c.family_id AND fm.id = c.author_member_id
       JOIN users u ON u.id = fm.user_id
      WHERE c.family_id = ? AND c.media_id = ?
        AND (
          ? = 0 OR c.created_at > ?
          OR (c.created_at = ? AND c.id > ?)
        )
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT ?`,
    [
      familyId,
      mediaId,
      cursor ? 1 : 0,
      cursor?.createdAt ?? new Date(0),
      cursor?.createdAt ?? new Date(0),
      cursor?.id ?? "0",
      limit,
    ],
  );
  return rows.map((row) => ({
    id: String(row.id),
    body: row.body,
    createdAt: row.createdAt,
    author: {
      memberId: String(row.authorMemberId),
      displayName: row.displayName,
    },
    canDelete: String(row.authorMemberId) === actorMemberId,
  }));
}

export function isApprovedIdentityDuplicate(
  error: unknown,
  constraint:
    | "uq_user_favorites_identity"
    | "uq_family_featured_identity"
    | "uq_tags_identity"
    | "uq_media_tags_identity",
) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    errno?: number;
    sqlState?: string;
    sqlMessage?: string;
    message?: string;
  };
  if (
    candidate.code !== "ER_DUP_ENTRY" ||
    candidate.errno !== 1062 ||
    candidate.sqlState !== "23000"
  ) {
    return false;
  }
  const message = candidate.sqlMessage ?? candidate.message;
  if (!message) return false;
  const match = /^Duplicate entry .* for key '([^']+)'$/u.exec(message);
  if (!match?.[1]) return false;
  const identifiers = match[1].split(".");
  if (
    identifiers.length < 1 ||
    identifiers.length > 3 ||
    identifiers.some((identifier) => !/^[A-Za-z0-9_$]+$/u.test(identifier))
  ) {
    return false;
  }
  return identifiers.at(-1) === constraint;
}

function nullableInteger(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

function assertVisible(
  album: AlbumRow | undefined,
  actor: ActorMemberRow,
  grant?: GrantRow,
): AlbumRecord {
  if (!album) throw new AlbumRepositoryError("NOT_FOUND");
  const result = toAlbumRecord(album, actor, grant);
  if (!result.effectivePermissions.canView) {
    throw new AlbumRepositoryError("NOT_FOUND");
  }
  return result;
}

function toAlbumRecord(
  row: AlbumRow,
  actor: ActorMemberRow,
  grant?: Partial<Record<keyof AlbumPermissionGrant, unknown>>,
): AlbumRecord {
  return {
    id: String(row.id),
    familyId: String(row.familyId),
    ownerMemberId: String(row.ownerMemberId),
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    revision: String(row.revision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    effectivePermissions: evaluateAlbumPermissions(
      albumPermissionContext(row, actor, grant),
    ),
  };
}

export function albumPermissionContext(
  row: AlbumRow,
  actor: ActorMemberRow,
  grant?: Partial<Record<keyof AlbumPermissionGrant, unknown>>,
): AlbumPermissionContext {
  return {
    membershipExists: true,
    memberActive: !actor.disabledAt && !actor.leftAt,
    sameFamily: actor.familyId === String(row.familyId),
    albumDeleted: row.deletedAt !== null,
    isOwner: actor.id === String(row.ownerMemberId),
    visibility: row.visibility,
    explicitGrant: grant ? grantPermissions(grant) : null,
    familyRole: actor.role,
  };
}

async function insertPlacement(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
  mediaId: string,
) {
  const media = await connection.query<RowDataPacket[]>(
    `SELECT id FROM media_items WHERE id = ? AND family_id = ? AND ${activeMediaSql("media_items")} FOR UPDATE`,
    [mediaId, familyId],
  );
  if (!media[0][0]) throw new AlbumRepositoryError("NOT_FOUND");
  const existing = await connection.query<RowDataPacket[]>(
    `SELECT id FROM album_media
      WHERE family_id = ? AND album_id = ? AND media_id = ? FOR UPDATE`,
    [familyId, albumId, mediaId],
  );
  if (existing[0][0]) return { albumId, mediaId, created: false };
  await connection.query(
    `INSERT INTO album_media (family_id, album_id, media_id) VALUES (?,?,?)`,
    [familyId, albumId, mediaId],
  );
  return { albumId, mediaId, created: true };
}

async function deletePlacement(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
  mediaId: string,
) {
  const [deleted] = await connection.query<ResultSetHeader>(
    `DELETE FROM album_media
      WHERE family_id = ? AND album_id = ? AND media_id = ?`,
    [familyId, albumId, mediaId],
  );
  return { albumId, mediaId, removed: deleted.affectedRows === 1 };
}

function ownerPermissions(): AlbumPermissionGrant {
  return {
    canView: true,
    canUpload: true,
    canEdit: true,
    canDelete: true,
    canManageMembers: true,
  };
}

function grantPermissions(
  grant: Partial<Record<keyof AlbumPermissionGrant, unknown>>,
): AlbumPermissionGrant {
  return {
    canView: isGranted(grant.canView),
    canUpload: isGranted(grant.canUpload),
    canEdit: isGranted(grant.canEdit),
    canDelete: isGranted(grant.canDelete),
    canManageMembers: isGranted(grant.canManageMembers),
  };
}

function isGranted(value: unknown) {
  return value === true || value === 1 || value === 1n || value === "1";
}

function assertCanMutateGrant(
  state: AclState,
  actorPermissions: AlbumPermissionGrant,
  requestedPermissions?: AlbumPermissionGrant,
) {
  if (!actorPermissions.canManageMembers) {
    throw new AlbumRepositoryError("FORBIDDEN");
  }
  const target = state.targetMember;
  if (!target) throw new AlbumRepositoryError("NOT_FOUND");
  if (
    target.id === state.member.id ||
    target.id === state.album?.ownerMemberId
  ) {
    throw new AlbumRepositoryError("FORBIDDEN");
  }
  const actorIsOwner = state.member.id === state.album?.ownerMemberId;
  const targetExisting = state.targetGrant
    ? grantPermissions(state.targetGrant)
    : null;

  if (requestedPermissions) {
    if (!Object.values(requestedPermissions).some(Boolean)) {
      throw new AlbumRepositoryError("CONFLICT");
    }
    if (
      !state.targetUser ||
      state.targetUser.disabledAt ||
      target.disabledAt ||
      target.leftAt
    ) {
      throw new AlbumRepositoryError("FORBIDDEN");
    }
    if (
      (requestedPermissions.canUpload ||
        requestedPermissions.canEdit ||
        requestedPermissions.canDelete ||
        requestedPermissions.canManageMembers) &&
      !requestedPermissions.canView
    ) {
      throw new AlbumRepositoryError("CONFLICT");
    }
  }

  if (actorIsOwner) return;
  if (
    targetExisting?.canManageMembers ||
    requestedPermissions?.canManageMembers ||
    (targetExisting && !isPermissionSubset(actorPermissions, targetExisting)) ||
    (requestedPermissions &&
      !isPermissionSubset(actorPermissions, requestedPermissions))
  ) {
    throw new AlbumRepositoryError("FORBIDDEN");
  }
}

async function advanceAlbumRevision(
  connection: PoolConnection,
  album: AlbumRow,
  expectedRevision: string,
  now: Date,
) {
  const [updated] = await connection.query<ResultSetHeader>(
    `UPDATE albums SET revision = revision + 1, updated_at = ?
      WHERE id = ? AND family_id = ? AND revision = ? AND deleted_at IS NULL`,
    [now, album.id, album.familyId, expectedRevision],
  );
  if (updated.affectedRows !== 1) {
    throw new AlbumRepositoryError("CONFLICT");
  }
  return (BigInt(expectedRevision) + 1n).toString();
}

function samePermissions(
  left: AlbumPermissionGrant,
  right: AlbumPermissionGrant,
) {
  return (
    left.canView === right.canView &&
    left.canUpload === right.canUpload &&
    left.canEdit === right.canEdit &&
    left.canDelete === right.canDelete &&
    left.canManageMembers === right.canManageMembers
  );
}

function compareIds(left: string, right: string) {
  return BigInt(left) < BigInt(right)
    ? -1
    : BigInt(left) > BigInt(right)
      ? 1
      : 0;
}

// Fixed SQL only; shared with bounded DEV EXPLAIN acceptance. No request-controlled fragments.
export function buildFamilySearchQuery(
  familyId: string,
  memberId: string,
  limit: number,
  cursor: { timelineKey: Date; mediaId: string } | undefined,
  filters: FamilySearchFilters,
) {
  const conditions: string[] = [];
  const filterValues: (string | Date)[] = [];
  if (filters.fromDate) {
    conditions.push("m.timeline_key >= ?");
    filterValues.push(filters.fromDate);
  }
  if (filters.toDate) {
    conditions.push("m.timeline_key <= ?");
    filterValues.push(filters.toDate);
  }
  if (filters.albumId) {
    conditions.push("a.id = ?");
    filterValues.push(filters.albumId);
  }
  if (filters.favoritesOnly) conditions.push("favorite.id IS NOT NULL");
  if (filters.filename) {
    conditions.push(
      "source.original_filename COLLATE utf8mb4_0900_bin LIKE CONVERT(? USING utf8mb4) COLLATE utf8mb4_0900_bin ESCAPE '!'",
    );
    filterValues.push(
      "%" +
        filters.filename
          .replaceAll("!", "!!")
          .replaceAll("%", "!%")
          .replaceAll("_", "!_") +
        "%",
    );
  }
  if (filters.uploaderMemberId) {
    conditions.push("source.created_by_member_id = ?");
    filterValues.push(filters.uploaderMemberId);
  }
  if (filters.tagId) {
    conditions.push(
      "EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.family_id=mt.family_id AND t.id=mt.tag_id WHERE mt.family_id=m.family_id AND mt.media_id=m.id AND t.id=?)",
    );
    filterValues.push(filters.tagId);
  }
  return {
    sql: `SELECT CAST(m.id AS CHAR) AS mediaId,
            CAST(MIN(a.id) AS CHAR) AS albumId,
            m.timeline_key AS timelineKey,
            m.timeline_basis AS timelineBasis,
            m.display_width AS displayWidth,
            m.display_height AS displayHeight,
            MAX(CASE WHEN favorite.id IS NULL THEN 0 ELSE 1 END) AS isFavorite,
            MAX(CASE WHEN featured.id IS NULL THEN 0 ELSE 1 END) AS isFamilyFeatured
       FROM media_items m
       JOIN upload_sessions source ON source.family_id=m.family_id AND source.id=m.source_upload_id
       JOIN album_media placement
         ON placement.family_id = m.family_id
        AND placement.media_id = m.id
       JOIN albums a
         ON a.family_id = placement.family_id
        AND a.id = placement.album_id
        AND a.deleted_at IS NULL
       LEFT JOIN album_members grant_row
         ON grant_row.family_id = a.family_id
        AND grant_row.album_id = a.id
        AND grant_row.member_id = ?
       LEFT JOIN user_favorites favorite
         ON favorite.family_id = m.family_id
        AND favorite.media_id = m.id
        AND favorite.member_id = ?
       LEFT JOIN family_featured featured
         ON featured.family_id = m.family_id
        AND featured.media_id = m.id
      WHERE m.family_id = ? AND ${activeMediaSql("m")}
        AND (a.owner_member_id = ? OR a.visibility = 'FAMILY'
             OR grant_row.can_view = 1)
        AND (
          ? = 0
          OR m.timeline_key < ?
          OR (m.timeline_key = ? AND m.id < ?)
        )
        ${conditions.length ? "AND " + conditions.join(" AND ") : ""}
      GROUP BY m.id, m.timeline_key, m.timeline_basis,
               m.display_width, m.display_height
      ORDER BY m.timeline_key DESC, m.id DESC
      LIMIT ?`,
    values: [
      memberId,
      memberId,
      familyId,
      memberId,
      cursor ? 1 : 0,
      cursor?.timelineKey ?? new Date(0),
      cursor?.timelineKey ?? new Date(0),
      cursor?.mediaId ?? "0",
      ...filterValues,
      limit,
    ],
  };
}

// Reuse the exact unfiltered search visibility FROM/WHERE; no media LIMIT precedes options.
export function buildFamilySearchOptionsQuery(
  familyId: string,
  memberId: string,
  kind: "tag" | "uploader",
  limit: number,
  afterId?: string,
) {
  const base = buildFamilySearchQuery(familyId, memberId, 1, undefined, {});
  const visible = base.sql.slice(
    base.sql.indexOf("FROM media_items m"),
    base.sql.indexOf("GROUP BY m.id"),
  );
  const joins =
    kind === "tag"
      ? "JOIN media_tags option_link ON option_link.family_id=m.family_id AND option_link.media_id=m.id JOIN tags candidate ON candidate.family_id=option_link.family_id AND candidate.id=option_link.tag_id "
      : "JOIN family_members candidate ON candidate.family_id=source.family_id AND candidate.id=source.created_by_member_id JOIN users option_user ON option_user.id=candidate.user_id ";
  const name =
    kind === "tag"
      ? "candidate.name"
      : "COALESCE(NULLIF(option_user.display_name,''),'家庭成员')";
  return {
    sql: `SELECT CAST(candidate.id AS CHAR) AS id, ${name} AS name ${visible.replace("WHERE m.family_id", joins + "WHERE m.family_id")} AND candidate.id > ? GROUP BY candidate.id, ${name} ORDER BY candidate.id ASC LIMIT ?`,
    values: [...base.values.slice(0, -1), afterId ?? "0", limit],
  };
}

export function buildFamilyLocationQuery(
  familyId: string,
  memberId: string,
  filters: FamilySearchFilters,
  projector: LocationProjector,
) {
  const base = buildFamilySearchQuery(
    familyId,
    memberId,
    1,
    undefined,
    filters,
  );
  const sql = base.sql
    .replace(
      "SELECT CAST(m.id",
      `SELECT MAX(p.h3_cell) AS h3Cell,MAX(p.country_code) AS countryCode,CAST(MAX(p.city_geoname_id) AS CHAR) AS cityGeonameId,MAX(m.gps_latitude IS NOT NULL AND m.gps_longitude IS NOT NULL) AS hasGps, CAST(m.id`,
    )
    .replace(
      "JOIN upload_sessions source",
      `LEFT JOIN media_location_projections p ON p.family_id=m.family_id AND p.media_id=m.id AND p.generation=m.generation AND m.metadata_generation=m.generation AND m.gps_latitude IS NOT NULL AND m.gps_longitude IS NOT NULL AND p.policy_version=? AND p.dataset_version=? JOIN upload_sessions source`,
    )
    .replace("LIMIT ?", "");
  return {
    sql,
    values: [
      projector.policyVersion,
      projector.datasetVersion,
      ...base.values.slice(0, -1),
    ],
  };
}

export type MemoriesRecord = FamilyTimelineRecord & {
  timelineDate: string;
  dateBasis: "CAPTURE_LOCAL" | "UPLOAD_UTC";
};
function memoryRecord(row: RowDataPacket): MemoriesRecord {
  return {
    mediaId: String(row.mediaId),
    albumId: String(row.albumId),
    timelineKey: row.timelineKey as Date,
    timelineBasis: row.timelineBasis as MemoriesRecord["timelineBasis"],
    displayWidth: row.displayWidth as number | null,
    displayHeight: row.displayHeight as number | null,
    isFavorite: Boolean(row.isFavorite),
    isFamilyFeatured: Boolean(row.isFamilyFeatured),
    timelineDate: String(row.timelineDate),
    dateBasis: row.dateBasis as MemoriesRecord["dateBasis"],
  };
}
export function buildFamilyMemoriesQuery(
  familyId: string,
  memberId: string,
  kind: MemoriesKind,
  context: MemoriesContext,
  limit: number,
  cursor?: Pick<MemoriesCursor, "timelineKey" | "mediaId">,
) {
  const effective = "DATE(COALESCE(m.captured_local_at,m.uploaded_at))";
  const datePredicate =
    kind === "ON_THIS_DAY"
      ? `YEAR(${effective}) < ? AND MONTH(${effective}) = ? AND DAYOFMONTH(${effective}) = ?`
      : `${effective} >= ? AND ${effective} < ?`;
  const dateValues =
    kind === "ON_THIS_DAY"
      ? context.anchorDate.split("-").map(Number)
      : [context.weekStart, context.weekEnd];
  const asset = (
    kind: "PREVIEW" | "THUMBNAIL",
    bytes: number,
    dimension: number,
  ) => `EXISTS (
    SELECT 1 FROM derived_assets d WHERE d.family_id=m.family_id AND d.media_id=m.id
      AND d.generation=m.generation AND d.recipe_id=m.recipe_id AND d.kind='${kind}'
      AND d.state='READY' AND d.cleaned_at IS NULL AND d.published_at IS NOT NULL
      AND d.output_mime='image/webp' AND d.byte_size>0 AND d.byte_size<=d.reserved_bytes
      AND d.reserved_bytes<=${bytes} AND OCTET_LENGTH(d.sha256)=32
      AND d.width BETWEEN 1 AND ${dimension} AND d.height BETWEEN 1 AND ${dimension}
      AND d.producer_job_id>0 AND d.producer_lease_epoch>0)`;
  return {
    sql: `SELECT CAST(m.id AS CHAR) mediaId, CAST(MIN(a.id) AS CHAR) albumId,
      m.timeline_key timelineKey, m.timeline_basis timelineBasis, m.display_width displayWidth, m.display_height displayHeight,
      MAX(favorite.id IS NOT NULL) isFavorite, MAX(featured.id IS NOT NULL) isFamilyFeatured,
      DATE_FORMAT(${effective},'%Y-%m-%d') timelineDate,
      CASE WHEN m.captured_local_at IS NULL THEN 'UPLOAD_UTC' ELSE 'CAPTURE_LOCAL' END dateBasis
    FROM media_items m
    JOIN storage_objects so ON so.family_id=m.family_id AND so.id=m.storage_object_id AND so.state='AVAILABLE'
    JOIN upload_sessions source ON source.family_id=m.family_id AND source.id=m.source_upload_id
      AND source.storage_object_id=so.id AND source.state='COMPLETE'
      AND source.committed_offset=source.declared_size AND source.declared_size=so.byte_size AND source.computed_sha256=so.sha256
    JOIN album_media p ON p.family_id=m.family_id AND p.media_id=m.id
    JOIN albums a ON a.family_id=p.family_id AND a.id=p.album_id AND a.deleted_at IS NULL
    LEFT JOIN album_members g ON g.family_id=a.family_id AND g.album_id=a.id AND g.member_id=?
    LEFT JOIN user_favorites favorite ON favorite.family_id=m.family_id AND favorite.media_id=m.id AND favorite.member_id=?
    LEFT JOIN family_featured featured ON featured.family_id=m.family_id AND featured.media_id=m.id
    WHERE m.family_id=? AND ${activeMediaSql("m")} AND m.media_type='IMAGE' AND m.processing_state='READY'
      AND m.metadata_generation=m.generation AND m.recipe_id=1
      AND (a.owner_member_id=? OR a.visibility='FAMILY' OR g.can_view=1)
      AND ${asset("PREVIEW", 4194304, 2560)} AND ${asset("THUMBNAIL", 524288, 480)}
      AND (${datePredicate})
      AND (?=0 OR m.timeline_key<? OR (m.timeline_key=? AND m.id<?))
    GROUP BY m.id,m.timeline_key,m.timeline_basis,m.display_width,m.display_height,m.captured_local_at,m.uploaded_at
    ORDER BY m.timeline_key DESC,m.id DESC LIMIT ?`,
    values: [
      memberId,
      memberId,
      familyId,
      memberId,
      ...dateValues,
      cursor ? 1 : 0,
      cursor ? new Date(cursor.timelineKey) : new Date(0),
      cursor ? new Date(cursor.timelineKey) : new Date(0),
      cursor?.mediaId ?? "0",
      limit,
    ],
  };
}

export class MemoriesAnchorExpiredError extends Error {
  constructor() {
    super("MEMORIES_ANCHOR_EXPIRED");
    this.name = "MemoriesAnchorExpiredError";
  }
}
