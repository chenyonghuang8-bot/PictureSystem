import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createShareToken } from "../../packages/auth/src/token.js";
import {
  assertMigrationReadiness,
  createDatabase,
  MySqlAlbumRepository,
  MySqlDerivedReadRepository,
  MySqlShareRepository,
} from "../../packages/db/src/index.js";
import { PublicShareService } from "../../apps/api/src/shares/public-service.js";
import { ShareService } from "../../apps/api/src/shares/service.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE5C_PUBLIC_SHARE_DATABASE_URL_REQUIRED");

describe.sequential("Phase 5C public share API", () => {
  const database = createDatabase(databaseUrl);
  const albums = new MySqlAlbumRepository(database.pool);
  const shares = new MySqlShareRepository(database.pool, albums);
  const management = new ShareService(shares);
  const derived = new MySqlDerivedReadRepository(database.pool);
  const reads: string[] = [];
  const service = new PublicShareService(management, shares, derived, {
    async read(identity) {
      reads.push(identity.kind);
      return Buffer.alloc(Number(identity.byteSize), 7);
    },
  });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const ownerHash = randomBytes(32);
  let familyId = "";
  let ownerUserId = "";
  let ownerSessionId = "";
  let ownerMemberId = "";
  let albumId = "";
  let mediaId = "";
  let token = "";
  let shareId = "";

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      const [identity] = await connection.query<RowDataPacket[]>(
        `SELECT DATABASE() AS db, VERSION() AS version, CURRENT_USER() AS account,
                @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
                @@SESSION.foreign_key_checks AS foreignKeyChecks`,
      );
      const row = identity[0];
      if (
        row?.db !== "family_album_dev" ||
        !String(row.version).startsWith("9.7.2") ||
        String(row.account).split("@")[0]?.toLowerCase() === "root" ||
        String(row.nativeFk) !== "1" ||
        String(row.foreignKeyChecks) !== "1"
      ) {
        throw new Error("PHASE5C_PUBLIC_SHARE_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Public ${suffix}`],
      );
      familyId = String(family.insertId);
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username, username_normalized, password_hash, display_name, password_changed_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [
          `p5c_pub_${suffix}`,
          Buffer.from(`p5c_pub_${suffix}`),
          "synthetic-not-used",
          "Public",
        ],
      );
      ownerUserId = String(user.insertId);
      const [member] = await connection.query<ResultSetHeader>(
        "INSERT INTO family_members (family_id, user_id, role) VALUES (?,?,'MEMBER')",
        [familyId, ownerUserId],
      );
      ownerMemberId = String(member.insertId);
      const [session] = await connection.query<ResultSetHeader>(
        `INSERT INTO sessions
          (user_id, token_hash, client_type, authenticated_at, last_seen_at, expires_at)
         VALUES (?, ?, 'WEB', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
                 DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))`,
        [ownerUserId, ownerHash],
      );
      ownerSessionId = String(session.insertId);
      const [album] = await connection.query<ResultSetHeader>(
        `INSERT INTO albums (family_id, owner_member_id, name, visibility)
         VALUES (?,?,?,'CUSTOM')`,
        [familyId, ownerMemberId, "公开相册"],
      );
      albumId = String(album.insertId);
      const media = await insertMedia(connection, familyId, ownerMemberId);
      mediaId = media.mediaId;
      await connection.query(
        "INSERT INTO album_media (family_id, album_id, media_id) VALUES (?,?,?)",
        [familyId, albumId, mediaId],
      );
      await insertReady(
        connection,
        familyId,
        mediaId,
        media.jobId,
        "THUMBNAIL",
      );
      await insertReady(connection, familyId, mediaId, media.jobId, "PREVIEW");
    } finally {
      connection.release();
    }
    const created = await management.createShare(
      {
        identity: { userId: ownerUserId, sessionId: ownerSessionId },
        tokenHash: ownerHash,
      },
      albumId,
      new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    );
    token = created.token;
    shareId = created.shareId;
  }, 30_000);

  afterAll(async () => {
    if (familyId) {
      await database.pool.query(
        `DELETE FROM share_events WHERE family_id = ?`,
        [familyId],
      );
      await database.pool.query(`DELETE FROM shares WHERE family_id = ?`, [
        familyId,
      ]);
      await database.pool.query(
        `DELETE FROM derived_assets WHERE family_id = ?`,
        [familyId],
      );
      await database.pool.query(
        `DELETE FROM background_jobs WHERE family_id = ?`,
        [familyId],
      );
      await database.pool.query(`DELETE FROM album_media WHERE family_id = ?`, [
        familyId,
      ]);
      await database.pool.query(`DELETE FROM media_items WHERE family_id = ?`, [
        familyId,
      ]);
      await database.pool.query(
        `DELETE FROM upload_sessions WHERE family_id = ?`,
        [familyId],
      );
      await database.pool.query(
        `DELETE FROM storage_objects WHERE family_id = ?`,
        [familyId],
      );
      await database.pool.query(`DELETE FROM albums WHERE family_id = ?`, [
        familyId,
      ]);
      await database.pool.query(`DELETE FROM sessions WHERE user_id = ?`, [
        ownerUserId,
      ]);
      await database.pool.query(
        `DELETE FROM family_members WHERE family_id = ?`,
        [familyId],
      );
      await database.pool.query(`DELETE FROM users WHERE id = ?`, [
        ownerUserId,
      ]);
      await database.pool.query(`DELETE FROM families WHERE id = ?`, [
        familyId,
      ]);
    }
    await database.pool.end();
  });

  it("shows the album page once and serves only thumbnail and preview", async () => {
    const opened = await service.openAlbum(token, { limit: 20 });
    expect(opened.album).toEqual({ name: "公开相册" });
    expect(opened.media.map((item) => item.mediaId)).toEqual([mediaId]);
    expect(opened.media[0]?.thumbnail).toEqual({ kind: "thumbnail" });
    expect(JSON.stringify(opened)).not.toMatch(
      /familyId|storage|original|gps|latitude|permission|token_hash/i,
    );
    expect(JSON.stringify(opened)).not.toContain(token);
    expect(await accessCount()).toBe(1);

    const thumbnail = await service.openDerived(token, mediaId, "thumbnail");
    const preview = await service.openDerived(token, mediaId, "preview");
    expect(thumbnail.bytes.length).toBeGreaterThan(0);
    expect(preview.contentType).toBe("image/webp");
    expect(reads).toEqual(["THUMBNAIL", "PREVIEW"]);
    expect(await accessCount()).toBe(1);
    await expect(
      service.openDerived(token, mediaId, "original"),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
    expect(await accessCount()).toBe(1);
  });

  it("hides removed, missing, expired, revoked, deleted, and invalid links", async () => {
    await database.pool.query(
      `DELETE FROM derived_assets
        WHERE family_id = ? AND media_id = ? AND kind = 'PREVIEW'`,
      [familyId, mediaId],
    );
    await expect(
      service.openDerived(token, mediaId, "preview"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await database.pool.query(
      `DELETE FROM album_media WHERE family_id = ? AND album_id = ? AND media_id = ?`,
      [familyId, albumId, mediaId],
    );
    const afterRemoval = await service.openAlbum(token, { limit: 20 });
    expect(afterRemoval.media).toEqual([]);
    await expect(
      service.openDerived(token, mediaId, "thumbnail"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await database.pool.query(
      `UPDATE shares
          SET created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 HOUR),
              expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 HOUR)
        WHERE id = ?`,
      [shareId],
    );
    await expect(service.openAlbum(token, { limit: 20 })).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      },
    );

    const again = await management.createShare(
      {
        identity: { userId: ownerUserId, sessionId: ownerSessionId },
        tokenHash: ownerHash,
      },
      albumId,
      new Date(Date.now() + 24 * 60 * 60 * 1000),
    );
    await management.revokeShare(
      {
        identity: { userId: ownerUserId, sessionId: ownerSessionId },
        tokenHash: ownerHash,
      },
      again.shareId,
    );
    await expect(
      service.openAlbum(again.token, { limit: 20 }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const live = await management.createShare(
      {
        identity: { userId: ownerUserId, sessionId: ownerSessionId },
        tokenHash: ownerHash,
      },
      albumId,
      new Date(Date.now() + 24 * 60 * 60 * 1000),
    );
    await database.pool.query(
      `UPDATE albums SET deleted_at = created_at WHERE id = ?`,
      [albumId],
    );
    await expect(
      service.openAlbum(live.token, { limit: 20 }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      service.openAlbum(createShareToken(), { limit: 20 }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const [events] = await database.pool.query<RowDataPacket[]>(
      `SELECT event_type AS eventType, actor_member_id AS actor
         FROM share_events WHERE share_id = ? AND event_type = 'ACCESS'`,
      [shareId],
    );
    expect(events.every((event) => event.actor === null)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  async function accessCount() {
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total
         FROM share_events
        WHERE share_id = ? AND event_type = 'ACCESS' AND actor_member_id IS NULL`,
      [shareId],
    );
    return Number(rows[0]?.total);
  }
});

async function insertMedia(
  connection: {
    query: (
      sql: string,
      values?: unknown[],
    ) => Promise<[ResultSetHeader, unknown]>;
  },
  familyId: string,
  memberId: string,
) {
  const sha = randomBytes(32);
  const [object] = await connection.query(
    `INSERT INTO storage_objects
      (family_id, sha256, byte_size, key_version, state, durable_at, verified_at)
     VALUES (?,?,8,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [familyId, sha],
  );
  const [upload] = await connection.query(
    `INSERT INTO upload_sessions
      (public_id, family_id, created_by_member_id, original_filename,
       declared_size, committed_offset, state, computed_sha256,
       finalize_started_at, storage_object_id, completed_at, expires_at)
     VALUES (?,?,?,'synthetic.png',8,8,'COMPLETE',?,
       CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),
       DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))`,
    [randomBytes(16), familyId, memberId, sha, String(object.insertId)],
  );
  const [media] = await connection.query(
    `INSERT INTO media_items
      (family_id, storage_object_id, source_upload_id, uploaded_at, timeline_key)
     VALUES (?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [familyId, String(object.insertId), String(upload.insertId)],
  );
  const mediaId = String(media.insertId);
  const [job] = await connection.query(
    `INSERT INTO background_jobs
      (family_id, media_id, generation, recipe_id, job_type, state, available_at)
     VALUES (?,?,1,1,'IMAGE_DERIVATIVES','QUEUED',CURRENT_TIMESTAMP(3))`,
    [familyId, mediaId],
  );
  return { mediaId, jobId: String(job.insertId) };
}

async function insertReady(
  connection: {
    query: (
      sql: string,
      values?: unknown[],
    ) => Promise<[ResultSetHeader, unknown]>;
  },
  familyId: string,
  mediaId: string,
  jobId: string,
  kind: "THUMBNAIL" | "PREVIEW",
) {
  const digest = createHash("sha256").update(`${kind}-${mediaId}`).digest();
  await connection.query(
    `INSERT INTO derived_assets
      (family_id, media_id, generation, recipe_id, kind, state, reserved_bytes,
       byte_size, sha256, width, height, output_mime, producer_job_id,
       producer_lease_epoch, published_at)
     VALUES (?,?,1,1,?,'READY',8,8,?,8,4,'image/webp',?,1,CURRENT_TIMESTAMP(3))`,
    [familyId, mediaId, kind, digest, jobId],
  );
}
