import type {
  Pool,
  PoolConnection,
  RowDataPacket,
  ResultSetHeader,
} from "mysql2/promise";
import type { Phase1CActor } from "./phase1c-repository.js";
import {
  AlbumRepositoryError,
  lockFamily,
  lockActor,
  assertActor,
  lockIds,
} from "./album-repository.js";
import { runCheckedTransaction, readServerTime } from "./connection.js";

export type LifecycleIdentity = {
  familyId: string;
  mediaId: string;
  storageObjectId: string;
  sha256Hex: string;
  byteSize: string;
  lifecycleRevision: string;
  trashedAt: Date | null;
  purgeAfter: Date | null;
};
export type LifecycleMutation = {
  actor: Phase1CActor;
  familyId: string;
  mediaId: string;
  selectedAlbumId?: string;
  expectedLifecycleRevision: string;
  operationId: string;
  action: "TRASH" | "RESTORE";
};
type MediaRow = RowDataPacket &
  LifecycleIdentity & { purgeIntentId: string | null };
type PlacementRow = RowDataPacket & {
  albumId: string;
  grantId: string | null;
  canView: number;
  canDelete: number;
};

// Trash has explicit access paths. Ordinary repositories have no includeTrash flag.
export class MySqlTrashRepository {
  constructor(private readonly pool: Pool) {}

  async preflight(input: LifecycleMutation): Promise<LifecycleIdentity> {
    return runCheckedTransaction(this.pool, async (connection) => {
      const scope = await this.lockScope(connection, input);
      return this.identity(scope.media);
    });
  }

  async transition(input: LifecycleMutation, expected: LifecycleIdentity) {
    return runCheckedTransaction(this.pool, async (connection) => {
      const { media, memberId, replay } = await this.lockScope(
        connection,
        input,
      );
      if (
        media.storageObjectId !== expected.storageObjectId ||
        media.sha256Hex !== expected.sha256Hex ||
        media.byteSize !== expected.byteSize
      )
        throw new AlbumRepositoryError("SERVICE_UNAVAILABLE");
      if (replay) return this.result(media);
      const revision = BigInt(media.lifecycleRevision);
      if (
        media.lifecycleRevision !== input.expectedLifecycleRevision ||
        revision === 18446744073709551615n ||
        (input.action === "TRASH"
          ? media.trashedAt !== null
          : media.trashedAt === null)
      )
        throw new AlbumRepositoryError("CONFLICT");
      const [changed] = await connection.execute<ResultSetHeader>(
        input.action === "TRASH"
          ? `UPDATE media_items SET trashed_at=CURRENT_TIMESTAMP(3),trashed_by_member_id=?,
          purge_after=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY), lifecycle_revision=lifecycle_revision+1
         WHERE family_id=? AND id=? AND lifecycle_revision=? AND trashed_at IS NULL AND purge_intent_id IS NULL`
          : `UPDATE media_items SET trashed_at=NULL,trashed_by_member_id=NULL,purge_after=NULL,
          lifecycle_revision=lifecycle_revision+1 WHERE family_id=? AND id=? AND lifecycle_revision=?
          AND trashed_at IS NOT NULL AND purge_intent_id IS NULL`,
        input.action === "TRASH"
          ? [
              memberId,
              input.familyId,
              input.mediaId,
              input.expectedLifecycleRevision,
            ]
          : [input.familyId, input.mediaId, input.expectedLifecycleRevision],
      );
      if (changed.affectedRows !== 1)
        throw new AlbumRepositoryError("CONFLICT");
      await connection.execute(
        `INSERT INTO audit_logs (family_id,operation_id,purge_intent_id,media_id,storage_object_id,
          actor_kind,actor_member_id,action,lifecycle_revision,transition_id,result_category)
         VALUES (?,?,NULL,?,?,'MEMBER',?,?,?,?,'SUCCESS')`,
        [
          input.familyId,
          input.operationId,
          input.mediaId,
          media.storageObjectId,
          memberId,
          input.action,
          (revision + 1n).toString(),
          input.operationId,
        ],
      );
      const updated = await this.readMedia(
        connection,
        input.familyId,
        input.mediaId,
      );
      if (!updated) throw new AlbumRepositoryError("SERVICE_UNAVAILABLE");
      return this.result(updated);
    });
  }

  async list(input: {
    actor: Phase1CActor;
    familyId: string;
    limit: number;
    cursor?: { trashedAt: Date; mediaId: string };
  }) {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const actor = await lockActor(connection, input.familyId, input.actor);
      assertActor(actor, input.actor, await readServerTime(connection));
      // EXISTS visibility and NOT EXISTS a non-deletable live placement run
      // before LIMIT and never reveal hidden placement identities or counts.
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(m.id AS CHAR) mediaId,m.media_type mediaType,m.timeline_key timelineKey,
          m.trashed_at trashedAt,m.purge_after purgeAfter,CAST(m.lifecycle_revision AS CHAR) lifecycleRevision,
          NOT EXISTS (SELECT 1 FROM album_media p JOIN albums a ON a.family_id=p.family_id AND a.id=p.album_id
            LEFT JOIN album_members g ON g.family_id=a.family_id AND g.album_id=a.id AND g.member_id=?
            WHERE p.family_id=m.family_id AND p.media_id=m.id AND a.deleted_at IS NULL
              AND NOT (a.owner_member_id=? OR (COALESCE(g.can_delete,0)=1 AND (a.visibility='FAMILY' OR g.can_view=1)))) canRestore
         FROM media_items m WHERE m.family_id=? AND m.trashed_at IS NOT NULL AND m.purge_intent_id IS NULL
           AND EXISTS (SELECT 1 FROM album_media p JOIN albums a ON a.family_id=p.family_id AND a.id=p.album_id
             LEFT JOIN album_members g ON g.family_id=a.family_id AND g.album_id=a.id AND g.member_id=?
             WHERE p.family_id=m.family_id AND p.media_id=m.id AND a.deleted_at IS NULL
               AND (a.owner_member_id=? OR a.visibility='FAMILY' OR g.can_view=1))
           AND (?=0 OR m.trashed_at<? OR (m.trashed_at=? AND m.id<?))
         ORDER BY m.trashed_at DESC,m.id DESC LIMIT ?`,
        [
          actor.member.id,
          actor.member.id,
          input.familyId,
          actor.member.id,
          actor.member.id,
          input.cursor ? 1 : 0,
          input.cursor?.trashedAt ?? new Date(0),
          input.cursor?.trashedAt ?? new Date(0),
          input.cursor?.mediaId ?? "0",
          input.limit,
        ],
      );
      return rows.map((row) => ({
        mediaId: String(row.mediaId),
        mediaType: row.mediaType as "IMAGE" | "VIDEO",
        timelineKey: row.timelineKey as Date,
        trashedAt: row.trashedAt as Date,
        purgeAfter: row.purgeAfter as Date,
        lifecycleRevision: String(row.lifecycleRevision),
        capabilities: { canRestore: Number(row.canRestore) === 1 },
      }));
    });
  }

  private async lockScope(
    connection: PoolConnection,
    input: LifecycleMutation,
  ) {
    await lockFamily(connection, input.familyId);
    const actor = await lockActor(connection, input.familyId, input.actor);
    const [located] = await connection.query<PlacementRow[]>(
      `SELECT CAST(a.id AS CHAR) albumId,CAST(g.id AS CHAR) grantId
        FROM album_media p JOIN albums a ON a.family_id=p.family_id AND a.id=p.album_id
        LEFT JOIN album_members g ON g.family_id=a.family_id AND g.album_id=a.id AND g.member_id=?
       WHERE p.family_id=? AND p.media_id=? AND a.deleted_at IS NULL ORDER BY a.id`,
      [actor.member.id, input.familyId, input.mediaId],
    );
    await lockIds(
      connection,
      "albums",
      located.map((row) => row.albumId),
    );
    await lockIds(
      connection,
      "album_members",
      located.flatMap((row) => (row.grantId ? [row.grantId] : [])),
    );
    const [placements] = await connection.query<PlacementRow[]>(
      `SELECT CAST(a.id AS CHAR) albumId,
        (a.owner_member_id=? OR a.visibility='FAMILY' OR COALESCE(g.can_view,0)=1) canView,
        (a.owner_member_id=? OR (COALESCE(g.can_delete,0)=1 AND (a.visibility='FAMILY' OR g.can_view=1))) canDelete
       FROM album_media p JOIN albums a ON a.family_id=p.family_id AND a.id=p.album_id
       LEFT JOIN album_members g ON g.family_id=a.family_id AND g.album_id=a.id AND g.member_id=?
       WHERE p.family_id=? AND p.media_id=? AND a.deleted_at IS NULL ORDER BY a.id`,
      [
        actor.member.id,
        actor.member.id,
        actor.member.id,
        input.familyId,
        input.mediaId,
      ],
    );
    const preliminary = await this.readMedia(
      connection,
      input.familyId,
      input.mediaId,
    );
    if (preliminary)
      await connection.execute(
        "SELECT id FROM storage_objects WHERE family_id=? AND id=? FOR UPDATE",
        [input.familyId, preliminary.storageObjectId],
      );
    await connection.execute(
      "SELECT id FROM media_items WHERE family_id=? AND id=? FOR UPDATE",
      [input.familyId, input.mediaId],
    );
    await connection.query(
      "SELECT id FROM album_media WHERE family_id=? AND media_id=? ORDER BY album_id,id FOR UPDATE",
      [input.familyId, input.mediaId],
    );
    const media = await this.readMedia(
      connection,
      input.familyId,
      input.mediaId,
    );
    assertActor(actor, input.actor, await readServerTime(connection));
    const visible =
      input.action === "TRASH"
        ? placements.some(
            (p) =>
              p.albumId === input.selectedAlbumId && Number(p.canView) === 1,
          )
        : placements.some((p) => Number(p.canView) === 1);
    if (!media || !visible || media.purgeIntentId !== null)
      throw new AlbumRepositoryError("NOT_FOUND");
    const [history] = await connection.query<RowDataPacket[]>(
      `SELECT CAST(media_id AS CHAR) mediaId,CAST(storage_object_id AS CHAR) storageObjectId,
        CAST(actor_member_id AS CHAR) actorMemberId,CAST(lifecycle_revision AS CHAR) lifecycleRevision,action,result_category resultCategory
       FROM audit_logs WHERE family_id=? AND operation_id=? ORDER BY id FOR UPDATE`,
      [input.familyId, input.operationId],
    );
    let replay = false;
    if (history.length) {
      const row = history[0]!;
      replay =
        history.length === 1 &&
        row.mediaId === input.mediaId &&
        row.storageObjectId === media.storageObjectId &&
        row.actorMemberId === actor.member.id &&
        row.action === input.action &&
        row.resultCategory === "SUCCESS" &&
        BigInt(row.lifecycleRevision) ===
          BigInt(input.expectedLifecycleRevision) + 1n &&
        row.lifecycleRevision === media.lifecycleRevision &&
        (input.action === "TRASH"
          ? media.trashedAt !== null
          : media.trashedAt === null);
      if (!replay) throw new AlbumRepositoryError("CONFLICT");
    }
    if (input.action === "RESTORE" && media.trashedAt === null && !replay)
      throw new AlbumRepositoryError("NOT_FOUND");
    if (placements.some((p) => Number(p.canDelete) !== 1))
      throw new AlbumRepositoryError("FORBIDDEN");
    return { media, memberId: actor.member.id, replay };
  }

  private async readMedia(
    connection: PoolConnection,
    familyId: string,
    mediaId: string,
  ) {
    const [rows] = await connection.query<MediaRow[]>(
      `SELECT CAST(m.family_id AS CHAR) familyId,CAST(m.id AS CHAR) mediaId,
        CAST(m.storage_object_id AS CHAR) storageObjectId,LOWER(HEX(s.sha256)) sha256Hex,
        CAST(s.byte_size AS CHAR) byteSize,CAST(m.lifecycle_revision AS CHAR) lifecycleRevision,
        m.trashed_at trashedAt,m.purge_after purgeAfter,CAST(m.purge_intent_id AS CHAR) purgeIntentId
       FROM media_items m JOIN storage_objects s ON s.family_id=m.family_id AND s.id=m.storage_object_id
       WHERE m.family_id=? AND m.id=? AND s.state='AVAILABLE'`,
      [familyId, mediaId],
    );
    return rows[0];
  }
  private identity(media: MediaRow): LifecycleIdentity {
    return {
      familyId: media.familyId,
      mediaId: media.mediaId,
      storageObjectId: media.storageObjectId,
      sha256Hex: media.sha256Hex,
      byteSize: media.byteSize,
      lifecycleRevision: media.lifecycleRevision,
      trashedAt: media.trashedAt,
      purgeAfter: media.purgeAfter,
    };
  }
  private result(media: MediaRow) {
    return {
      mediaId: media.mediaId,
      lifecycleRevision: media.lifecycleRevision,
      state:
        media.trashedAt === null ? ("ACTIVE" as const) : ("TRASHED" as const),
      trashedAt: media.trashedAt,
      purgeAfter: media.purgeAfter,
    };
  }
}
