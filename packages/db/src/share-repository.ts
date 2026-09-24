import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import type { MySqlAlbumRepository } from "./album-repository.js";
import { acquireCheckedConnection } from "./connection.js";
import type { Phase1CActor } from "./phase1c-repository.js";

const SHARE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export class ShareRepositoryError extends Error {
  constructor(
    readonly reason:
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "INVALID_EXPIRY",
  ) {
    super("Share repository request failed.");
    this.name = "ShareRepositoryError";
  }
}

export type ShareRecord = {
  shareId: string;
  familyId: string;
  albumId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type ShareTokenRow = {
  shareId: string;
  familyId: string;
  albumId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  albumDeleted: boolean;
  serverNow: Date;
};

export type SharedAlbumMedia = {
  mediaId: string;
  timelineKey: Date;
  timelineBasis: "CAPTURE_LOCAL" | "UPLOAD_UTC";
  displayWidth: number | null;
  displayHeight: number | null;
};

export type SharedAlbumPage = {
  name: string;
  media: SharedAlbumMedia[];
};

type SharedMediaRow = RowDataPacket & SharedAlbumMedia;

type ShareRow = RowDataPacket & {
  shareId: string;
  familyId: string;
  albumId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export class MySqlShareRepository {
  constructor(
    private readonly pool: Pool,
    private readonly albums: MySqlAlbumRepository,
  ) {}

  async insertShare(input: {
    actor: Phase1CActor;
    albumId: string;
    tokenHash: Buffer;
    expiresAt: Date;
  }): Promise<ShareRecord> {
    assertTokenHash(input.tokenHash);
    return this.albums.withAlbumManager(
      { actor: input.actor, albumId: input.albumId },
      async (connection, scope) => {
        if (
          input.expiresAt.getTime() <= scope.now.getTime() ||
          input.expiresAt.getTime() > scope.now.getTime() + SHARE_LIFETIME_MS
        ) {
          throw new ShareRepositoryError("INVALID_EXPIRY");
        }
        try {
          await connection.query(
            `INSERT INTO shares
              (family_id, album_id, token_hash, created_by_member_id, expires_at)
             VALUES (?,?,?,?,?)`,
            [
              scope.album.familyId,
              scope.album.id,
              input.tokenHash,
              scope.actorMemberId,
              input.expiresAt,
            ],
          );
        } catch (error) {
          if (isDuplicateKey(error)) throw new ShareRepositoryError("CONFLICT");
          throw error;
        }
        const shareId = await lastInsertId(connection);
        await connection.query(
          `INSERT INTO share_events
            (family_id, share_id, event_type, actor_member_id)
           VALUES (?,?,'CREATE',?)`,
          [scope.album.familyId, shareId, scope.actorMemberId],
        );
        return readShare(connection, scope.album.familyId, shareId);
      },
    );
  }

  async findByTokenHash(tokenHash: Buffer): Promise<ShareTokenRow | null> {
    assertTokenHash(tokenHash);
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(s.id AS CHAR) AS shareId,
                CAST(s.family_id AS CHAR) AS familyId,
                CAST(s.album_id AS CHAR) AS albumId,
                s.expires_at AS expiresAt,
                s.revoked_at AS revokedAt,
                a.deleted_at IS NOT NULL AS albumDeleted,
                UTC_TIMESTAMP(3) AS serverNow
           FROM shares s
           JOIN albums a ON a.family_id = s.family_id AND a.id = s.album_id
          WHERE s.token_hash = ?
          LIMIT 1`,
        [tokenHash],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        shareId: String(row.shareId),
        familyId: String(row.familyId),
        albumId: String(row.albumId),
        expiresAt: row.expiresAt as Date,
        revokedAt: (row.revokedAt as Date | null) ?? null,
        albumDeleted: Number(row.albumDeleted) === 1,
        serverNow: row.serverNow as Date,
      };
    } finally {
      connection.release();
    }
  }

  async listShares(input: {
    actor: Phase1CActor;
    familyId: string;
    afterId?: string;
    limit: number;
  }): Promise<ShareRecord[]> {
    const albumIds = await this.albums.listManagedAlbumIds({
      actor: input.actor,
      familyId: input.familyId,
    });
    if (albumIds.length === 0) return [];
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<ShareRow[]>(
        `SELECT CAST(id AS CHAR) AS shareId,
                CAST(family_id AS CHAR) AS familyId,
                CAST(album_id AS CHAR) AS albumId,
                created_at AS createdAt,
                expires_at AS expiresAt,
                revoked_at AS revokedAt
           FROM shares
          WHERE family_id = ? AND album_id IN (?) AND id > ?
          ORDER BY id ASC
          LIMIT ?`,
        [input.familyId, albumIds, input.afterId ?? "0", input.limit],
      );
      return rows.map(shareRecord);
    } finally {
      connection.release();
    }
  }

  async revokeShare(input: {
    actor: Phase1CActor;
    shareId: string;
  }): Promise<ShareRecord> {
    const located = await this.locateShare(input.shareId);
    if (!located) throw new ShareRepositoryError("NOT_FOUND");
    return this.albums.withAlbumManager(
      { actor: input.actor, albumId: located.albumId },
      async (connection, scope) => {
        if (scope.album.familyId !== located.familyId) {
          throw new ShareRepositoryError("NOT_FOUND");
        }
        const [locked] = await connection.query<ShareRow[]>(
          `SELECT CAST(id AS CHAR) AS shareId,
                  CAST(family_id AS CHAR) AS familyId,
                  CAST(album_id AS CHAR) AS albumId,
                  created_at AS createdAt,
                  expires_at AS expiresAt,
                  revoked_at AS revokedAt
             FROM shares
            WHERE id = ? AND family_id = ? AND album_id = ?
            FOR UPDATE`,
          [input.shareId, located.familyId, located.albumId],
        );
        const current = locked[0];
        if (!current) throw new ShareRepositoryError("NOT_FOUND");
        if (current.revokedAt) return shareRecord(current);
        await connection.query(
          `UPDATE shares
              SET revoked_at = ?, revoked_by_member_id = ?
            WHERE id = ? AND family_id = ? AND revoked_at IS NULL`,
          [scope.now, scope.actorMemberId, input.shareId, located.familyId],
        );
        await connection.query(
          `INSERT INTO share_events
            (family_id, share_id, event_type, actor_member_id)
           VALUES (?,?,'REVOKE',?)`,
          [located.familyId, input.shareId, scope.actorMemberId],
        );
        return readShare(connection, located.familyId, input.shareId);
      },
    );
  }

  private async locateShare(shareId: string) {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(family_id AS CHAR) AS familyId,
                CAST(album_id AS CHAR) AS albumId
           FROM shares WHERE id = ? LIMIT 1`,
        [shareId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        familyId: String(row.familyId),
        albumId: String(row.albumId),
      };
    } finally {
      connection.release();
    }
  }

  async readSharedAlbum(input: {
    familyId: string;
    albumId: string;
    limit: number;
    cursor?: { timelineKey: Date; mediaId: string };
  }): Promise<SharedAlbumPage | null> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [albums] = await connection.query<RowDataPacket[]>(
        `SELECT name
           FROM albums
          WHERE family_id = ? AND id = ? AND deleted_at IS NULL
          LIMIT 1`,
        [input.familyId, input.albumId],
      );
      const album = albums[0];
      if (!album || typeof album.name !== "string") return null;
      const cursor = input.cursor;
      const [rows] = await connection.query<SharedMediaRow[]>(
        `SELECT CAST(m.id AS CHAR) AS mediaId,
                m.timeline_key AS timelineKey,
                m.timeline_basis AS timelineBasis,
                m.display_width AS displayWidth,
                m.display_height AS displayHeight
           FROM album_media am
           JOIN media_items m
             ON m.family_id = am.family_id AND m.id = am.media_id
          WHERE am.family_id = ? AND am.album_id = ?
            AND (
              ? = 0
              OR m.timeline_key < ?
              OR (m.timeline_key = ? AND m.id < ?)
            )
          ORDER BY m.timeline_key DESC, m.id DESC
          LIMIT ?`,
        [
          input.familyId,
          input.albumId,
          cursor ? 1 : 0,
          cursor?.timelineKey ?? new Date(0),
          cursor?.timelineKey ?? new Date(0),
          cursor?.mediaId ?? "0",
          input.limit,
        ],
      );
      return {
        name: album.name,
        media: rows.map((row) => ({
          mediaId: String(row.mediaId),
          timelineKey: row.timelineKey,
          timelineBasis: row.timelineBasis,
          displayWidth:
            row.displayWidth === null || row.displayWidth === undefined
              ? null
              : Number(row.displayWidth),
          displayHeight:
            row.displayHeight === null || row.displayHeight === undefined
              ? null
              : Number(row.displayHeight),
        })),
      };
    } finally {
      connection.release();
    }
  }

  async recordAccess(input: { familyId: string; shareId: string }) {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      await connection.query(
        `INSERT INTO share_events (family_id, share_id, event_type, actor_member_id)
         VALUES (?, ?, 'ACCESS', NULL)`,
        [input.familyId, input.shareId],
      );
    } finally {
      connection.release();
    }
  }
}

function assertTokenHash(tokenHash: Buffer) {
  if (!Buffer.isBuffer(tokenHash) || tokenHash.byteLength !== 32) {
    throw new Error("Share token hash must be 32 bytes.");
  }
}

function isDuplicateKey(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "errno" in error &&
    Number((error as { errno: unknown }).errno) === 1062
  );
}

async function lastInsertId(connection: PoolConnection) {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id",
  );
  const id = String(rows[0]?.id ?? "");
  if (!id || id === "0") throw new Error("Share insert result is unavailable.");
  return id;
}

async function readShare(
  connection: PoolConnection,
  familyId: string,
  shareId: string,
) {
  const [rows] = await connection.query<ShareRow[]>(
    `SELECT CAST(id AS CHAR) AS shareId,
            CAST(family_id AS CHAR) AS familyId,
            CAST(album_id AS CHAR) AS albumId,
            created_at AS createdAt,
            expires_at AS expiresAt,
            revoked_at AS revokedAt
       FROM shares
      WHERE family_id = ? AND id = ?`,
    [familyId, shareId],
  );
  const row = rows[0];
  if (!row) throw new ShareRepositoryError("NOT_FOUND");
  return shareRecord(row);
}

function shareRecord(row: ShareRow): ShareRecord {
  return {
    shareId: String(row.shareId),
    familyId: String(row.familyId),
    albumId: String(row.albumId),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}
