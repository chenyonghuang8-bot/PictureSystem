import { randomBytes, randomUUID } from "node:crypto";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AlbumRepositoryError,
  assertMigrationReadiness,
  createDatabase,
  MySqlAlbumRepository,
  MySqlDerivedReadRepository,
} from "../../packages/db/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE5A_TIMELINE_DEV_DATABASE_URL_REQUIRED");

describe.sequential("Phase 5A home timeline", () => {
  const database = createDatabase(databaseUrl);
  const albums = new MySqlAlbumRepository(database.pool);
  const derived = new MySqlDerivedReadRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const tokenHash = randomBytes(32);
  const outsiderHash = randomBytes(32);
  let familyId = "";
  let viewerUserId = "";
  let viewerSessionId = "";
  let outsiderUserId = "";
  let outsiderSessionId = "";
  let lowAlbum = "";
  let highAlbum = "";
  let hiddenAlbum = "";
  let deletedAlbum = "";
  let olderMedia = "";
  let newerMedia = "";
  let hiddenMedia = "";
  let deletedMedia = "";

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      const [identity] = await connection.query<RowDataPacket[]>(
        `SELECT DATABASE() AS db, VERSION() AS version,
          CURRENT_USER() AS account,
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
        throw new Error("PHASE5A_TIMELINE_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 5A timeline ${suffix}`],
      );
      familyId = String(family.insertId);
      viewerUserId = await insertUser(connection, `p5at_v_${suffix}`);
      const otherUserId = await insertUser(connection, `p5at_o_${suffix}`);
      outsiderUserId = await insertUser(connection, `p5at_x_${suffix}`);
      const viewerMember = await insertMember(
        connection,
        familyId,
        viewerUserId,
      );
      const otherMember = await insertMember(connection, familyId, otherUserId);
      viewerSessionId = await insertSession(
        connection,
        viewerUserId,
        tokenHash,
      );
      outsiderSessionId = await insertSession(
        connection,
        outsiderUserId,
        outsiderHash,
      );
      lowAlbum = await insertAlbum(connection, familyId, viewerMember, "Low");
      highAlbum = await insertAlbum(connection, familyId, viewerMember, "High");
      hiddenAlbum = await insertAlbum(
        connection,
        familyId,
        otherMember,
        "Hidden",
      );
      deletedAlbum = await insertAlbum(
        connection,
        familyId,
        viewerMember,
        "Deleted",
      );
      olderMedia = await insertMedia(
        connection,
        familyId,
        viewerMember,
        "2020-01-01 00:00:00.000",
      );
      newerMedia = await insertMedia(
        connection,
        familyId,
        viewerMember,
        "2024-06-01 00:00:00.000",
        {
          width: 320,
          height: 240,
          latitude: "37.780000",
          longitude: "-122.420000",
        },
      );
      hiddenMedia = await insertMedia(
        connection,
        familyId,
        viewerMember,
        "2023-01-01 00:00:00.000",
      );
      deletedMedia = await insertMedia(
        connection,
        familyId,
        viewerMember,
        "2022-01-01 00:00:00.000",
      );
      await connection.query(
        `INSERT INTO album_media (family_id, album_id, media_id)
         VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?),(?,?,?)`,
        [
          familyId,
          lowAlbum,
          olderMedia,
          familyId,
          lowAlbum,
          newerMedia,
          familyId,
          highAlbum,
          newerMedia,
          familyId,
          hiddenAlbum,
          hiddenMedia,
          familyId,
          deletedAlbum,
          deletedMedia,
        ],
      );
      await connection.query(
        "UPDATE albums SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
        [deletedAlbum],
      );
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    if (familyId) {
      await database.pool.query("DELETE FROM album_media WHERE family_id = ?", [
        familyId,
      ]);
      await database.pool.query("DELETE FROM media_items WHERE family_id = ?", [
        familyId,
      ]);
      await database.pool.query(
        "DELETE FROM upload_sessions WHERE family_id = ?",
        [familyId],
      );
      await database.pool.query(
        "DELETE FROM storage_objects WHERE family_id = ?",
        [familyId],
      );
      await database.pool.query("DELETE FROM albums WHERE family_id = ?", [
        familyId,
      ]);
      await database.pool.query(
        "DELETE FROM sessions WHERE user_id IN (?, ?)",
        [viewerUserId, outsiderUserId],
      );
      await database.pool.query(
        "DELETE FROM family_members WHERE family_id = ?",
        [familyId],
      );
      await database.pool.query(
        "DELETE FROM users WHERE username IN (?, ?, ?)",
        [`p5at_v_${suffix}`, `p5at_o_${suffix}`, `p5at_x_${suffix}`],
      );
      await database.pool.query("DELETE FROM families WHERE id = ?", [
        familyId,
      ]);
    }
    await database.pool.end();
  });

  function viewer() {
    return { userId: viewerUserId, sessionId: viewerSessionId, tokenHash };
  }

  it("orders the visible timeline, dedupes albums, and pages with a cursor", async () => {
    const first = await albums.listFamilyTimeline({
      actor: viewer(),
      familyId,
      limit: 1,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      mediaId: newerMedia,
      albumId: lowAlbum,
      timelineBasis: "UPLOAD_UTC",
      displayWidth: 320,
      displayHeight: 240,
    });
    expect(first[0]).not.toHaveProperty("gpsLatitude");
    expect(JSON.stringify(first[0])).not.toContain("-122.420000");

    const second = await albums.listFamilyTimeline({
      actor: viewer(),
      familyId,
      limit: 20,
      cursor: {
        timelineKey: first[0]!.timelineKey,
        mediaId: first[0]!.mediaId,
      },
    });
    expect(second.map((row) => row.mediaId)).toEqual([olderMedia]);
    const ids = [first[0]!.mediaId, ...second.map((row) => row.mediaId)];
    expect(ids).not.toContain(hiddenMedia);
    expect(ids).not.toContain(deletedMedia);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects a non-member and keeps derived bytes on the existing read", async () => {
    await expect(
      albums.listFamilyTimeline({
        actor: {
          userId: outsiderUserId,
          sessionId: outsiderSessionId,
          tokenHash: outsiderHash,
        },
        familyId,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(AlbumRepositoryError);

    const detail = await albums.getAlbumMedia({
      actor: viewer(),
      albumId: lowAlbum,
      mediaId: newerMedia,
    });
    expect(detail.mediaId).toBe(newerMedia);
    await expect(
      albums.getAlbumMedia({
        actor: viewer(),
        albumId: hiddenAlbum,
        mediaId: newerMedia,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });

    const bytes = await derived.findViewableReadyDerived({
      userId: viewerUserId,
      mediaId: newerMedia,
      kind: "THUMBNAIL",
    });
    expect(bytes).toBeNull();
  });
});

type Query = (
  sql: string,
  values?: unknown[],
) => Promise<[ResultSetHeader, unknown]>;

async function insertUser(connection: { query: Query }, username: string) {
  const [user] = await connection.query(
    `INSERT INTO users
      (username, username_normalized, password_hash, display_name, password_changed_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
    [username, Buffer.from(username), "synthetic-not-used", "Phase 5A"],
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
  name: string,
) {
  const [album] = await connection.query(
    `INSERT INTO albums (family_id, owner_member_id, name, visibility)
     VALUES (?,?,?,'CUSTOM')`,
    [familyId, ownerMemberId, name],
  );
  return String(album.insertId);
}

async function insertMedia(
  connection: { query: Query },
  familyId: string,
  memberId: string,
  at: string,
  extra?: {
    width: number;
    height: number;
    latitude: string;
    longitude: string;
  },
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
      (family_id, storage_object_id, source_upload_id, uploaded_at, timeline_key,
       display_width, display_height, gps_latitude, gps_longitude)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      familyId,
      String(object.insertId),
      String(upload.insertId),
      at,
      at,
      extra?.width ?? null,
      extra?.height ?? null,
      extra?.latitude ?? null,
      extra?.longitude ?? null,
    ],
  );
  return String(media.insertId);
}
