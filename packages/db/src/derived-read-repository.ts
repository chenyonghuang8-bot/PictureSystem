import { activeMediaSql } from "./media-lifecycle.js";
import { lockFamily, lockActor, assertActor } from "./album-repository.js";
import { runCheckedTransaction, readServerTime } from "./connection.js";
import type { Phase1CActor } from "./phase1c-repository.js";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

export type ReadyDerivedView = {
  lifecycleRevision: string;
  storageObjectId: string;
  originalSha256Hex: string;
  originalByteSize: string;
  derivedAssetId: string;
  familyId: string;
  mediaId: string;
  generation: bigint;
  kind: "THUMBNAIL" | "PREVIEW";
  byteSize: bigint;
  sha256Hex: string;
};

type ReadyRow = RowDataPacket & {
  lifecycleRevision: string;
  storageObjectId: string;
  originalSha256Hex: string;
  originalByteSize: string;
  derivedAssetId: string;
  familyId: string;
  mediaId: string;
  generation: string;
  byteSize: string;
  sha256Hex: string;
};

/**
 * One authorization lookup. The derived row is reachable only through a live
 * album_media placement the caller can view. A media id alone is not enough.
 */
export class MySqlDerivedReadRepository {
  constructor(private readonly pool: Pool) {}

  async findViewableReadyDerived(
    input: {
      userId: string;
      mediaId: string;
      kind: "THUMBNAIL" | "PREVIEW";
    },
    connection: Pick<PoolConnection, "query"> = this.pool,
  ): Promise<ReadyDerivedView | null> {
    const [rows] = await connection.query<ReadyRow[]>(
      `SELECT CAST(m.family_id AS CHAR) AS familyId,
              CAST(m.id AS CHAR) AS mediaId,
              CAST(m.generation AS CHAR) AS generation,
              CAST(d.byte_size AS CHAR) AS byteSize,
              LOWER(HEX(d.sha256)) AS sha256Hex,
              CAST(m.lifecycle_revision AS CHAR) lifecycleRevision,
              CAST(s.id AS CHAR) storageObjectId, LOWER(HEX(s.sha256)) originalSha256Hex,
              CAST(s.byte_size AS CHAR) originalByteSize, CAST(d.id AS CHAR) derivedAssetId
         FROM family_members fm
         JOIN album_media am
           ON am.family_id = fm.family_id
          AND am.media_id = ?
         JOIN albums a
           ON a.family_id = am.family_id
          AND a.id = am.album_id
          AND a.deleted_at IS NULL
         JOIN media_items m
           ON m.family_id = am.family_id
          AND m.id = am.media_id
          AND m.processing_state <> 'BLOCKED' AND ${activeMediaSql("m")}
         JOIN storage_objects s
           ON s.family_id = m.family_id
          AND s.id = m.storage_object_id
          AND s.state = 'AVAILABLE'
         JOIN derived_assets d
           ON d.family_id = m.family_id
          AND d.media_id = m.id
          AND d.generation = m.generation
          AND d.recipe_id = 1 AND m.recipe_id = d.recipe_id
          AND d.kind = ?
          AND d.state = 'READY'
          AND d.output_mime = 'image/webp'
          AND d.cleaned_at IS NULL
          AND d.byte_size IS NOT NULL
          AND d.sha256 IS NOT NULL
         LEFT JOIN album_members grant_row
           ON grant_row.family_id = a.family_id
          AND grant_row.album_id = a.id
          AND grant_row.member_id = fm.id
        WHERE fm.user_id = ?
          AND fm.disabled_at IS NULL
          AND fm.left_at IS NULL
          AND (
            a.owner_member_id = fm.id
            OR a.visibility = 'FAMILY'
            OR grant_row.can_view = 1
          )
        ORDER BY a.id
        LIMIT 1`,
      [input.mediaId, input.kind, input.userId],
    );
    const row = rows[0];
    if (!row || !validLifecycleIdentity(row)) return null;
    if (
      !/^[1-9][0-9]*$/u.test(row.familyId) ||
      row.mediaId !== input.mediaId ||
      !/^[1-9][0-9]*$/u.test(row.generation) ||
      !/^[1-9][0-9]*$/u.test(row.byteSize) ||
      !/^[0-9a-f]{64}$/u.test(row.sha256Hex)
    ) {
      return null;
    }
    return {
      lifecycleRevision: row.lifecycleRevision,
      storageObjectId: row.storageObjectId,
      originalSha256Hex: row.originalSha256Hex,
      originalByteSize: row.originalByteSize,
      derivedAssetId: row.derivedAssetId,
      familyId: row.familyId,
      mediaId: row.mediaId,
      generation: BigInt(row.generation),
      kind: input.kind,
      byteSize: BigInt(row.byteSize),
      sha256Hex: row.sha256Hex,
    };
  }

  async findReadyDerivedInAlbum(
    input: {
      familyId: string;
      albumId: string;
      mediaId: string;
      kind: "THUMBNAIL" | "PREVIEW";
    },
    connection: Pick<PoolConnection, "query"> = this.pool,
  ): Promise<ReadyDerivedView | null> {
    const [rows] = await connection.query<ReadyRow[]>(
      `SELECT CAST(m.family_id AS CHAR) AS familyId,
              CAST(m.id AS CHAR) AS mediaId,
              CAST(m.generation AS CHAR) AS generation,
              CAST(d.byte_size AS CHAR) AS byteSize,
              LOWER(HEX(d.sha256)) AS sha256Hex,
              CAST(m.lifecycle_revision AS CHAR) lifecycleRevision,
              CAST(s.id AS CHAR) storageObjectId, LOWER(HEX(s.sha256)) originalSha256Hex,
              CAST(s.byte_size AS CHAR) originalByteSize, CAST(d.id AS CHAR) derivedAssetId
         FROM album_media am
         JOIN albums a
           ON a.family_id = am.family_id
          AND a.id = am.album_id
          AND a.deleted_at IS NULL
         JOIN media_items m
           ON m.family_id = am.family_id
          AND m.id = am.media_id
          AND m.processing_state <> 'BLOCKED' AND ${activeMediaSql("m")}
         JOIN storage_objects s
           ON s.family_id = m.family_id
          AND s.id = m.storage_object_id
          AND s.state = 'AVAILABLE'
         JOIN derived_assets d
           ON d.family_id = m.family_id
          AND d.media_id = m.id
          AND d.generation = m.generation
          AND d.recipe_id = 1 AND m.recipe_id = d.recipe_id
          AND d.kind = ?
          AND d.state = 'READY'
          AND d.output_mime = 'image/webp'
          AND d.cleaned_at IS NULL
          AND d.byte_size IS NOT NULL
          AND d.sha256 IS NOT NULL
        WHERE am.family_id = ?
          AND am.album_id = ?
          AND am.media_id = ?
        LIMIT 1`,
      [input.kind, input.familyId, input.albumId, input.mediaId],
    );
    const row = rows[0];
    if (!row || !validLifecycleIdentity(row)) return null;
    if (
      row.familyId !== input.familyId ||
      row.mediaId !== input.mediaId ||
      !/^[1-9][0-9]*$/u.test(row.generation) ||
      !/^[1-9][0-9]*$/u.test(row.byteSize) ||
      !/^[0-9a-f]{64}$/u.test(row.sha256Hex)
    ) {
      return null;
    }
    return {
      lifecycleRevision: row.lifecycleRevision,
      storageObjectId: row.storageObjectId,
      originalSha256Hex: row.originalSha256Hex,
      originalByteSize: row.originalByteSize,
      derivedAssetId: row.derivedAssetId,
      familyId: row.familyId,
      mediaId: row.mediaId,
      generation: BigInt(row.generation),
      kind: input.kind,
      byteSize: BigInt(row.byteSize),
      sha256Hex: row.sha256Hex,
    };
  }
  async recheckViewableReadyDerived(input: {
    actor: Phase1CActor;
    expected: ReadyDerivedView;
  }) {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.expected.familyId);
      const actor = await lockActor(
        connection,
        input.expected.familyId,
        input.actor,
      );
      assertActor(actor, input.actor, await readServerTime(connection));
      const current = await this.findViewableReadyDerived(
        {
          userId: input.actor.userId,
          mediaId: input.expected.mediaId,
          kind: input.expected.kind,
        },
        connection,
      );
      return sameReadyDerivedIdentity(current, input.expected);
    });
  }
  async recheckSharedReadyDerived(input: {
    familyId: string;
    albumId: string;
    shareId: string;
    tokenHash: Buffer;
    expected: ReadyDerivedView;
  }) {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const [share] = await connection.query<RowDataPacket[]>(
        `SELECT s.id FROM shares s JOIN albums a ON a.family_id=s.family_id AND a.id=s.album_id
          WHERE s.family_id=? AND s.album_id=? AND s.id=? AND s.token_hash=?
            AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP(3) AND a.deleted_at IS NULL FOR UPDATE`,
        [input.familyId, input.albumId, input.shareId, input.tokenHash],
      );
      if (!share.length) return false;
      const current = await this.findReadyDerivedInAlbum(
        {
          familyId: input.familyId,
          albumId: input.albumId,
          mediaId: input.expected.mediaId,
          kind: input.expected.kind,
        },
        connection,
      );
      return sameReadyDerivedIdentity(current, input.expected);
    });
  }
}

export function sameReadyDerivedIdentity(
  current: ReadyDerivedView | null,
  expected: ReadyDerivedView,
) {
  return (
    current !== null &&
    current.familyId === expected.familyId &&
    current.mediaId === expected.mediaId &&
    current.generation === expected.generation &&
    current.kind === expected.kind &&
    current.byteSize === expected.byteSize &&
    current.sha256Hex === expected.sha256Hex &&
    current.lifecycleRevision === expected.lifecycleRevision &&
    current.storageObjectId === expected.storageObjectId &&
    current.originalSha256Hex === expected.originalSha256Hex &&
    current.originalByteSize === expected.originalByteSize &&
    current.derivedAssetId === expected.derivedAssetId
  );
}

function validLifecycleIdentity(row: ReadyRow) {
  const valid = (value: string) =>
    /^[1-9][0-9]{0,19}$/u.test(value) && BigInt(value) <= 18446744073709551615n;
  return (
    valid(row.lifecycleRevision) &&
    valid(row.storageObjectId) &&
    valid(row.originalByteSize) &&
    valid(row.derivedAssetId) &&
    /^[0-9a-f]{64}$/u.test(row.originalSha256Hex)
  );
}
