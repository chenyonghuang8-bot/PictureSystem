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
if (!databaseUrl) throw new Error("PHASE5A_DEV_DATABASE_URL_REQUIRED");

describe.sequential("Phase 5A gallery media", () => {
  const database = createDatabase(databaseUrl);
  const suffix = randomUUID().replaceAll("-", "");
  const tokenHash = randomBytes(32);
  const repository = new MySqlAlbumRepository(database.pool);
  let familyId = "";
  let viewerUserId = "";
  let viewerSessionId = "";
  let otherUserId = "";
  let albumA = "";
  let albumB = "";
  let olderMedia = "";
  let newerMedia = "";

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
        throw new Error("PHASE5A_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 5A ${suffix}`],
      );
      familyId = String(family.insertId);
      viewerUserId = await insertUser(connection, `p5a_v_${suffix}`);
      otherUserId = await insertUser(connection, `p5a_o_${suffix}`);
      const viewerMember = await insertMember(
        connection,
        familyId,
        viewerUserId,
      );
      const otherMember = await insertMember(connection, familyId, otherUserId);
      const [session] = await connection.query<ResultSetHeader>(
        `INSERT INTO sessions
          (user_id, token_hash, client_type, authenticated_at, last_seen_at, expires_at)
         VALUES (?, ?, 'WEB', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
                 DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))`,
        [viewerUserId, tokenHash],
      );
      viewerSessionId = String(session.insertId);
      albumA = await insertAlbum(connection, familyId, viewerMember, "A");
      albumB = await insertAlbum(connection, familyId, otherMember, "B");
      olderMedia = await insertMedia(connection, familyId, viewerMember, {
        at: "2020-01-01 00:00:00.000",
      });
      newerMedia = await insertMedia(connection, familyId, viewerMember, {
        at: "2024-06-01 00:00:00.000",
        width: 320,
        height: 240,
        orientation: 6,
        cameraMake: "Synthetic",
        cameraModel: "Gallery",
        latitude: "37.780000",
        longitude: "-122.420000",
      });
      await connection.query(
        `INSERT INTO album_media (family_id, album_id, media_id) VALUES (?,?,?),(?,?,?),(?,?,?)`,
        [
          familyId,
          albumA,
          olderMedia,
          familyId,
          albumA,
          newerMedia,
          familyId,
          albumB,
          newerMedia,
        ],
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
        [viewerUserId, otherUserId],
      );
      await database.pool.query(
        "DELETE FROM family_members WHERE family_id = ?",
        [familyId],
      );
      await database.pool.query("DELETE FROM users WHERE id IN (?, ?)", [
        viewerUserId,
        otherUserId,
      ]);
      await database.pool.query("DELETE FROM families WHERE id = ?", [
        familyId,
      ]);
    }
    await database.pool.end();
  });

  function actor() {
    return {
      userId: viewerUserId,
      sessionId: viewerSessionId,
      tokenHash,
    };
  }

  it("pages a viewable album by timeline and hides the other album", async () => {
    const first = await repository.listAlbumMedia({
      actor: actor(),
      albumId: albumA,
      limit: 1,
    });
    expect(first.map((row) => row.mediaId)).toEqual([newerMedia]);
    expect(first[0]).not.toHaveProperty("gpsLatitude");

    const second = await repository.listAlbumMedia({
      actor: actor(),
      albumId: albumA,
      limit: 1,
      cursor: {
        timelineKey: first[0]!.timelineKey,
        mediaId: first[0]!.mediaId,
      },
    });
    expect(second.map((row) => row.mediaId)).toEqual([olderMedia]);

    await expect(
      repository.listAlbumMedia({
        actor: actor(),
        albumId: albumB,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(AlbumRepositoryError);
  });

  it("returns detail only for the named viewable placement and omits coordinates", async () => {
    const visible = await repository.getAlbumMedia({
      actor: actor(),
      albumId: albumA,
      mediaId: newerMedia,
    });
    expect(visible).toMatchObject({
      mediaId: newerMedia,
      timelineBasis: "UPLOAD_UTC",
      displayWidth: 320,
      displayHeight: 240,
      orientation: 6,
      cameraMake: "Synthetic",
      cameraModel: "Gallery",
    });
    expect(visible).not.toHaveProperty("gpsLatitude");
    expect(JSON.stringify(visible)).not.toContain("-122.420000");

    await expect(
      repository.getAlbumMedia({
        actor: actor(),
        albumId: albumB,
        mediaId: newerMedia,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      repository.getAlbumMedia({
        actor: actor(),
        albumId: albumA,
        mediaId: "9007199254740991",
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
  });
});

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
  input: {
    at: string;
    width?: number;
    height?: number;
    orientation?: number;
    cameraMake?: string;
    cameraModel?: string;
    latitude?: string;
    longitude?: string;
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
       display_width, display_height, orientation, camera_make, camera_model,
       gps_latitude, gps_longitude)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      familyId,
      String(object.insertId),
      String(upload.insertId),
      input.at,
      input.at,
      input.width ?? null,
      input.height ?? null,
      input.orientation ?? null,
      input.cameraMake ?? null,
      input.cameraModel ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
    ],
  );
  return String(media.insertId);
}

type Query = (
  sql: string,
  values?: unknown[],
) => Promise<[ResultSetHeader, unknown]>;
