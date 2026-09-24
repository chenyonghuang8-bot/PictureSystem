import type { Pool, RowDataPacket } from "mysql2/promise";

export type ReadyDerivedView = {
  familyId: string;
  mediaId: string;
  generation: bigint;
  kind: "THUMBNAIL" | "PREVIEW";
  byteSize: bigint;
  sha256Hex: string;
};

type ReadyRow = RowDataPacket & {
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

  async findViewableReadyDerived(input: {
    userId: string;
    mediaId: string;
    kind: "THUMBNAIL" | "PREVIEW";
  }): Promise<ReadyDerivedView | null> {
    const [rows] = await this.pool.query<ReadyRow[]>(
      `SELECT CAST(m.family_id AS CHAR) AS familyId,
              CAST(m.id AS CHAR) AS mediaId,
              CAST(m.generation AS CHAR) AS generation,
              CAST(d.byte_size AS CHAR) AS byteSize,
              LOWER(HEX(d.sha256)) AS sha256Hex
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
          AND m.processing_state <> 'BLOCKED'
         JOIN storage_objects s
           ON s.family_id = m.family_id
          AND s.id = m.storage_object_id
          AND s.state = 'AVAILABLE'
         JOIN derived_assets d
           ON d.family_id = m.family_id
          AND d.media_id = m.id
          AND d.generation = m.generation
          AND d.recipe_id = 1
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
    if (!row) return null;
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
      familyId: row.familyId,
      mediaId: row.mediaId,
      generation: BigInt(row.generation),
      kind: input.kind,
      byteSize: BigInt(row.byteSize),
      sha256Hex: row.sha256Hex,
    };
  }

  async findReadyDerivedInAlbum(input: {
    familyId: string;
    albumId: string;
    mediaId: string;
    kind: "THUMBNAIL" | "PREVIEW";
  }): Promise<ReadyDerivedView | null> {
    const [rows] = await this.pool.query<ReadyRow[]>(
      `SELECT CAST(m.family_id AS CHAR) AS familyId,
              CAST(m.id AS CHAR) AS mediaId,
              CAST(m.generation AS CHAR) AS generation,
              CAST(d.byte_size AS CHAR) AS byteSize,
              LOWER(HEX(d.sha256)) AS sha256Hex
         FROM album_media am
         JOIN albums a
           ON a.family_id = am.family_id
          AND a.id = am.album_id
          AND a.deleted_at IS NULL
         JOIN media_items m
           ON m.family_id = am.family_id
          AND m.id = am.media_id
          AND m.processing_state <> 'BLOCKED'
         JOIN storage_objects s
           ON s.family_id = m.family_id
          AND s.id = m.storage_object_id
          AND s.state = 'AVAILABLE'
         JOIN derived_assets d
           ON d.family_id = m.family_id
          AND d.media_id = m.id
          AND d.generation = m.generation
          AND d.recipe_id = 1
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
    if (!row) return null;
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
      familyId: row.familyId,
      mediaId: row.mediaId,
      generation: BigInt(row.generation),
      kind: input.kind,
      byteSize: BigInt(row.byteSize),
      sha256Hex: row.sha256Hex,
    };
  }
}
