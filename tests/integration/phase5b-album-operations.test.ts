import { randomBytes, randomUUID } from "node:crypto";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AlbumRepositoryError,
  assertMigrationReadiness,
  createDatabase,
  MySqlAlbumRepository,
} from "../../packages/db/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE5B_DEV_DATABASE_URL_REQUIRED");

describe.sequential("Phase 5B album operations", () => {
  const database = createDatabase(databaseUrl);
  const albums = new MySqlAlbumRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const editorHash = randomBytes(32);
  const outsiderHash = randomBytes(32);
  let familyId = "";
  let otherFamilyId = "";
  let editorUserId = "";
  let editorSessionId = "";
  let outsiderUserId = "";
  let outsiderSessionId = "";
  let editorAlbum = "";
  let secondAlbum = "";
  let familyAlbum = "";
  let hiddenAlbum = "";
  let deletedAlbum = "";
  let mediaId = "";
  let foreignMediaId = "";
  let storageId = "";

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await assertDev(connection);
      await assertMigrationReadiness(connection);
      familyId = await insertFamily(connection, `Phase 5B ${suffix}`);
      otherFamilyId = await insertFamily(
        connection,
        `Phase 5B other ${suffix}`,
      );
      editorUserId = await insertUser(connection, `p5b_e_${suffix}`);
      const ownerUserId = await insertUser(connection, `p5b_o_${suffix}`);
      outsiderUserId = await insertUser(connection, `p5b_x_${suffix}`);
      const editorMember = await insertMember(
        connection,
        familyId,
        editorUserId,
      );
      const ownerMember = await insertMember(connection, familyId, ownerUserId);
      const foreignMember = await insertMember(
        connection,
        otherFamilyId,
        ownerUserId,
      );
      editorSessionId = await insertSession(
        connection,
        editorUserId,
        editorHash,
      );
      outsiderSessionId = await insertSession(
        connection,
        outsiderUserId,
        outsiderHash,
      );
      editorAlbum = await insertAlbum(
        connection,
        familyId,
        editorMember,
        "CUSTOM",
        "Editor",
      );
      secondAlbum = await insertAlbum(
        connection,
        familyId,
        editorMember,
        "CUSTOM",
        "Second",
      );
      familyAlbum = await insertAlbum(
        connection,
        familyId,
        ownerMember,
        "FAMILY",
        "Family",
      );
      hiddenAlbum = await insertAlbum(
        connection,
        familyId,
        ownerMember,
        "CUSTOM",
        "Hidden",
      );
      deletedAlbum = await insertAlbum(
        connection,
        familyId,
        editorMember,
        "CUSTOM",
        "Deleted",
      );
      const media = await insertMedia(connection, familyId, editorMember);
      mediaId = media.mediaId;
      storageId = media.storageId;
      foreignMediaId = (
        await insertMedia(connection, otherFamilyId, foreignMember)
      ).mediaId;
      await connection.query(
        "UPDATE albums SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
        [deletedAlbum],
      );
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    for (const id of [familyId, otherFamilyId]) {
      if (!id) continue;
      await database.pool.query(
        "DELETE FROM derived_assets WHERE family_id = ?",
        [id],
      );
      await database.pool.query(
        "DELETE FROM background_jobs WHERE family_id = ?",
        [id],
      );
      await database.pool.query("DELETE FROM album_media WHERE family_id = ?", [
        id,
      ]);
      await database.pool.query("DELETE FROM media_items WHERE family_id = ?", [
        id,
      ]);
      await database.pool.query(
        "DELETE FROM upload_sessions WHERE family_id = ?",
        [id],
      );
      await database.pool.query(
        "DELETE FROM storage_objects WHERE family_id = ?",
        [id],
      );
      await database.pool.query("DELETE FROM albums WHERE family_id = ?", [id]);
      await database.pool.query(
        "DELETE FROM family_members WHERE family_id = ?",
        [id],
      );
      await database.pool.query("DELETE FROM families WHERE id = ?", [id]);
    }
    await database.pool.query("DELETE FROM sessions WHERE user_id IN (?, ?)", [
      editorUserId,
      outsiderUserId,
    ]);
    await database.pool.query("DELETE FROM users WHERE username IN (?, ?, ?)", [
      `p5b_e_${suffix}`,
      `p5b_o_${suffix}`,
      `p5b_x_${suffix}`,
    ]);
    await database.pool.end();
  });

  function editor() {
    return {
      userId: editorUserId,
      sessionId: editorSessionId,
      tokenHash: editorHash,
    };
  }

  it("adds a placement once and rejects the guarded cases", async () => {
    const added = await albums.addAlbumMedia({
      actor: editor(),
      albumId: editorAlbum,
      mediaId,
    });
    expect(added).toEqual({ albumId: editorAlbum, mediaId, created: true });
    const again = await albums.addAlbumMedia({
      actor: editor(),
      albumId: editorAlbum,
      mediaId,
    });
    expect(again.created).toBe(false);
    expect(await countPlacements(database, familyId, mediaId)).toBe(1);

    await expect(
      albums.addAlbumMedia({
        actor: editor(),
        albumId: editorAlbum,
        mediaId: foreignMediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.addAlbumMedia({
        actor: editor(),
        albumId: familyAlbum,
        mediaId,
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await expect(
      albums.addAlbumMedia({
        actor: editor(),
        albumId: deletedAlbum,
        mediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.addAlbumMedia({
        actor: editor(),
        albumId: hiddenAlbum,
        mediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.addAlbumMedia({
        actor: {
          userId: outsiderUserId,
          sessionId: outsiderSessionId,
          tokenHash: outsiderHash,
        },
        albumId: editorAlbum,
        mediaId,
      }),
    ).rejects.toBeInstanceOf(AlbumRepositoryError);
    await expect(
      albums.addAlbumMedia({
        actor: editor(),
        albumId: editorAlbum,
        mediaId: "9007199254740991",
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
  });

  it("removes one placement and keeps the media after the last placement", async () => {
    await albums.addAlbumMedia({
      actor: editor(),
      albumId: secondAlbum,
      mediaId,
    });
    const removed = await albums.removeAlbumMedia({
      actor: editor(),
      albumId: editorAlbum,
      mediaId,
    });
    expect(removed.removed).toBe(true);
    const stillThere = await albums.getAlbumMedia({
      actor: editor(),
      albumId: secondAlbum,
      mediaId,
    });
    expect(stillThere.mediaId).toBe(mediaId);
    const timeline = await albums.listFamilyTimeline({
      actor: editor(),
      familyId,
      limit: 20,
    });
    expect(timeline.map((row) => row.mediaId)).toContain(mediaId);

    await albums.removeAlbumMedia({
      actor: editor(),
      albumId: secondAlbum,
      mediaId,
    });
    const after = await albums.listFamilyTimeline({
      actor: editor(),
      familyId,
      limit: 20,
    });
    expect(after.map((row) => row.mediaId)).not.toContain(mediaId);
    expect(await countRows(database, "media_items", familyId, mediaId)).toBe(1);
    expect(
      await countRows(database, "storage_objects", familyId, storageId),
    ).toBe(1);
    expect(
      await countRows(
        database,
        "derived_assets",
        familyId,
        mediaId,
        "media_id",
      ),
    ).toBe(1);
    expect(await countPlacements(database, familyId, mediaId)).toBe(0);
  });
});

type Query = (
  sql: string,
  values?: unknown[],
) => Promise<[ResultSetHeader, unknown]>;

async function assertDev(connection: { query: Query }) {
  const [identity] = await connection.query(
    `SELECT DATABASE() AS db, VERSION() AS version, CURRENT_USER() AS account,
            @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
            @@SESSION.foreign_key_checks AS foreignKeyChecks`,
  );
  const row = identity as unknown as RowDataPacket;
  const record = Array.isArray(identity) ? identity[0] : row;
  if (
    record?.db !== "family_album_dev" ||
    !String(record.version).startsWith("9.7.2") ||
    String(record.account).split("@")[0]?.toLowerCase() === "root" ||
    String(record.nativeFk) !== "1" ||
    String(record.foreignKeyChecks) !== "1"
  ) {
    throw new Error("PHASE5B_DEV_PREFLIGHT_FAILED");
  }
}

async function insertFamily(connection: { query: Query }, name: string) {
  const [family] = await connection.query(
    "INSERT INTO families (name) VALUES (?)",
    [name],
  );
  return String(family.insertId);
}

async function insertUser(connection: { query: Query }, username: string) {
  const [user] = await connection.query(
    `INSERT INTO users
      (username, username_normalized, password_hash, display_name, password_changed_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
    [username, Buffer.from(username), "synthetic-not-used", "Phase 5B"],
  );
  return String(user.insertId);
}

async function insertMember(
  connection: { query: Query },
  familyId: string,
  userId: string,
) {
  const [member] = await connection.query(
    "INSERT INTO family_members (family_id, user_id, role) VALUES (?,?,'MEMBER')",
    [familyId, userId],
  );
  return String(member.insertId);
}

async function insertSession(
  connection: { query: Query },
  userId: string,
  tokenHash: Buffer,
) {
  const [session] = await connection.query(
    `INSERT INTO sessions
      (user_id, token_hash, client_type, authenticated_at, last_seen_at, expires_at)
     VALUES (?, ?, 'WEB', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
             DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))`,
    [userId, tokenHash],
  );
  return String(session.insertId);
}

async function insertAlbum(
  connection: { query: Query },
  familyId: string,
  ownerMemberId: string,
  visibility: "FAMILY" | "CUSTOM",
  name: string,
) {
  const [album] = await connection.query(
    `INSERT INTO albums (family_id, owner_member_id, name, visibility)
     VALUES (?,?,?,?)`,
    [familyId, ownerMemberId, name, visibility],
  );
  return String(album.insertId);
}

async function insertMedia(
  connection: { query: Query },
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
  const storageId = String(object.insertId);
  const [upload] = await connection.query(
    `INSERT INTO upload_sessions
      (public_id, family_id, created_by_member_id, original_filename,
       declared_size, committed_offset, state, computed_sha256,
       finalize_started_at, storage_object_id, completed_at, expires_at)
     VALUES (?,?,?,'synthetic.png',8,8,'COMPLETE',?,
       CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),
       DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))`,
    [randomBytes(16), familyId, memberId, sha, storageId],
  );
  const [media] = await connection.query(
    `INSERT INTO media_items
      (family_id, storage_object_id, source_upload_id, uploaded_at, timeline_key)
     VALUES (?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [familyId, storageId, String(upload.insertId)],
  );
  const mediaId = String(media.insertId);
  const [job] = await connection.query(
    `INSERT INTO background_jobs
      (family_id, media_id, generation, recipe_id, job_type, state, available_at)
     VALUES (?,?,1,1,'IMAGE_DERIVATIVES','QUEUED',CURRENT_TIMESTAMP(3))`,
    [familyId, mediaId],
  );
  await connection.query(
    `INSERT INTO derived_assets
      (family_id, media_id, generation, recipe_id, kind, state, reserved_bytes, producer_job_id)
     VALUES (?,?,1,1,'THUMBNAIL','RESERVED',8,?)`,
    [familyId, mediaId, String(job.insertId)],
  );
  return { mediaId, storageId };
}

async function countPlacements(
  database: { pool: { query: Query } },
  familyId: string,
  mediaId: string,
) {
  const [rows] = await database.pool.query(
    `SELECT COUNT(*) AS total FROM album_media WHERE family_id = ? AND media_id = ?`,
    [familyId, mediaId],
  );
  return Number((rows as unknown as RowDataPacket[])[0]?.total);
}

async function countRows(
  database: { pool: { query: Query } },
  table: "media_items" | "storage_objects" | "derived_assets",
  familyId: string,
  id: string,
  column = "id",
) {
  const [rows] = await database.pool.query(
    `SELECT COUNT(*) AS total FROM ${table} WHERE family_id = ? AND ${column} = ?`,
    [familyId, id],
  );
  return Number((rows as unknown as RowDataPacket[])[0]?.total);
}
