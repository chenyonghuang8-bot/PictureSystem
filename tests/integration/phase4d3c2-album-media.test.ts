import { randomBytes, randomUUID } from "node:crypto";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertMigrationReadiness,
  createDatabase,
} from "../../packages/db/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE4D3C2_DEV_DATABASE_URL_REQUIRED");

function errno(error: unknown): number | undefined {
  if (error && typeof error === "object" && "errno" in error) {
    return Number((error as { errno: number }).errno);
  }
  return undefined;
}

describe.sequential("Phase 4D3c-2 album_media migration", () => {
  const database = createDatabase(databaseUrl!);
  const suffix = randomUUID().replaceAll("-", "");
  let familyA = "";
  let familyB = "";
  let albumA = "";
  let albumB = "";
  let mediaA = "";
  let mediaB = "";

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
        throw new Error("PHASE4D3C2_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);

      familyA = await createFamily(connection, `A ${suffix}`);
      familyB = await createFamily(connection, `B ${suffix}`);
      const memberA = await createMember(connection, familyA, `a_${suffix}`);
      const memberB = await createMember(connection, familyB, `b_${suffix}`);
      albumA = await createAlbum(connection, familyA, memberA);
      albumB = await createAlbum(connection, familyB, memberB);
      mediaA = await createMedia(connection, familyA, memberA);
      mediaB = await createMedia(connection, familyB, memberB);
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    const ids = [familyA, familyB].filter((id) => id !== "");
    if (ids.length > 0) {
      await database.pool.query(
        `DELETE am FROM album_media am WHERE am.family_id IN (?)`,
        [ids],
      );
      await database.pool.query(
        `DELETE FROM media_items WHERE family_id IN (?)`,
        [ids],
      );
      await database.pool.query(
        `DELETE FROM upload_sessions WHERE family_id IN (?)`,
        [ids],
      );
      await database.pool.query(
        `DELETE FROM storage_objects WHERE family_id IN (?)`,
        [ids],
      );
      await database.pool.query(`DELETE FROM albums WHERE family_id IN (?)`, [
        ids,
      ]);
      await database.pool.query(
        `DELETE FROM family_members WHERE family_id IN (?)`,
        [ids],
      );
      await database.pool.query(
        `DELETE FROM users WHERE username_normalized IN (?, ?)`,
        [Buffer.from(`a_${suffix}`), Buffer.from(`b_${suffix}`)],
      );
      await database.pool.query(`DELETE FROM families WHERE id IN (?)`, [ids]);
    }
    await database.pool.end();
  });

  it("accepts one placement inside a family and answers both lookup directions", async () => {
    const [placed] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO album_media (family_id, album_id, media_id)
       VALUES (?,?,?)`,
      [familyA, albumA, mediaA],
    );
    expect(placed.affectedRows).toBe(1);

    const [byAlbum] = await database.pool.query<RowDataPacket[]>(
      `SELECT media_id AS mediaId
         FROM album_media
        WHERE family_id=? AND album_id=?`,
      [familyA, albumA],
    );
    const [byMedia] = await database.pool.query<RowDataPacket[]>(
      `SELECT album_id AS albumId
         FROM album_media
        WHERE family_id=? AND media_id=?`,
      [familyA, mediaA],
    );
    expect(byAlbum.map((row) => String(row.mediaId))).toEqual([mediaA]);
    expect(byMedia.map((row) => String(row.albumId))).toEqual([albumA]);
  });

  it("rejects a duplicate placement and both cross-family references", async () => {
    await expect(
      database.pool.query(
        `INSERT INTO album_media (family_id, album_id, media_id)
         VALUES (?,?,?)`,
        [familyA, albumA, mediaA],
      ),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 1062);

    await expect(
      database.pool.query(
        `INSERT INTO album_media (family_id, album_id, media_id)
         VALUES (?,?,?)`,
        [familyA, albumB, mediaA],
      ),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 1452);

    await expect(
      database.pool.query(
        `INSERT INTO album_media (family_id, album_id, media_id)
         VALUES (?,?,?)`,
        [familyB, albumB, mediaA],
      ),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 1452);
  });

  it("refuses album and media deletion while the placement exists", async () => {
    await expect(
      database.pool.query(`DELETE FROM albums WHERE id=? AND family_id=?`, [
        albumA,
        familyA,
      ]),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 1451);
    await expect(
      database.pool.query(
        `DELETE FROM media_items WHERE id=? AND family_id=?`,
        [mediaA, familyA],
      ),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 1451);

    const [remaining] = await database.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS placements
         FROM album_media
        WHERE family_id=? AND album_id=? AND media_id=?`,
      [familyA, albumA, mediaA],
    );
    expect(Number(remaining[0]?.placements)).toBe(1);
    expect(mediaB).not.toBe("");
    expect(albumB).not.toBe("");
  });
});

async function createFamily(
  connection: {
    query: (
      sql: string,
      values: unknown[],
    ) => Promise<[ResultSetHeader, unknown]>;
  },
  name: string,
): Promise<string> {
  const [family] = await connection.query(
    "INSERT INTO families (name) VALUES (?)",
    [name],
  );
  return String(family.insertId);
}

async function createMember(
  connection: {
    query: (
      sql: string,
      values: unknown[],
    ) => Promise<[ResultSetHeader, unknown]>;
  },
  familyId: string,
  username: string,
): Promise<string> {
  const [user] = await connection.query(
    `INSERT INTO users
      (username,username_normalized,password_hash,display_name,password_changed_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
    [username, Buffer.from(username), "synthetic-not-used", "Album media"],
  );
  const [member] = await connection.query(
    "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
    [familyId, String(user.insertId)],
  );
  return String(member.insertId);
}

async function createAlbum(
  connection: {
    query: (
      sql: string,
      values: unknown[],
    ) => Promise<[ResultSetHeader, unknown]>;
  },
  familyId: string,
  ownerMemberId: string,
): Promise<string> {
  const [album] = await connection.query(
    `INSERT INTO albums (family_id, owner_member_id, name, visibility)
     VALUES (?,?,?,'FAMILY')`,
    [familyId, ownerMemberId, "Synthetic album"],
  );
  return String(album.insertId);
}

async function createMedia(
  connection: {
    query: (
      sql: string,
      values: unknown[],
    ) => Promise<[ResultSetHeader, unknown]>;
  },
  familyId: string,
  memberId: string,
): Promise<string> {
  const sha = randomBytes(32);
  const [object] = await connection.query(
    `INSERT INTO storage_objects
      (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
     VALUES (?,?,8,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [familyId, sha],
  );
  const [upload] = await connection.query(
    `INSERT INTO upload_sessions
      (public_id,family_id,created_by_member_id,original_filename,
       declared_size,committed_offset,state,computed_sha256,
       finalize_started_at,storage_object_id,completed_at,expires_at)
     VALUES (?,?,?,'synthetic.png',8,8,'COMPLETE',?,
       CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),
       DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
    [randomBytes(16), familyId, memberId, sha, String(object.insertId)],
  );
  const [media] = await connection.query(
    `INSERT INTO media_items
      (family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key)
     VALUES (?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [familyId, String(object.insertId), String(upload.insertId)],
  );
  return String(media.insertId);
}
