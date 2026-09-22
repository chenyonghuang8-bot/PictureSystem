import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertMigrationReadiness,
  createDatabase,
  MySqlMediaRepository,
} from "../../packages/db/dist/index.js";
import type { MediaRepositoryError } from "../../packages/db/dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE4B_DEV_DATABASE_URL_REQUIRED");

type FixtureObject = { id: string; sha256: Buffer; byteSize: bigint };

describe("Phase 4B canonical media repository integration", () => {
  const database = createDatabase(databaseUrl);
  const repository = new MySqlMediaRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  let familyId = "";
  let crossFamilyId = "";
  let memberId = "";

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      const [preflight] = await connection.query<RowDataPacket[]>(
        `SELECT DATABASE() AS db, VERSION() AS mysqlVersion,
          CURRENT_USER() AS account,
          @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
          @@SESSION.foreign_key_checks AS foreignKeyChecks`,
      );
      const ready = preflight[0];
      if (
        !ready ||
        ready.db !== "family_album_dev" ||
        !String(ready.mysqlVersion).startsWith("9.7.2") ||
        String(ready.account).split("@")[0]?.toLowerCase() === "root" ||
        Number(ready.nativeFk) !== 1 ||
        Number(ready.foreignKeyChecks) !== 1
      ) {
        throw new Error("PHASE4B_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      await connection.beginTransaction();
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 4B synthetic ${suffix}`],
      );
      familyId = String(family.insertId);
      const [crossFamily] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 4B cross synthetic ${suffix}`],
      );
      crossFamilyId = String(crossFamily.insertId);
      const username = `phase4b_${suffix}`;
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username,username_normalized,password_hash,display_name,password_changed_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [username, Buffer.from(username), "synthetic-not-used", "Phase 4B"],
      );
      const [member] = await connection.query<ResultSetHeader>(
        "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
        [familyId, String(user.insertId)],
      );
      memberId = String(member.insertId);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      await connection.beginTransaction();
      await connection.query(
        "DELETE FROM media_items WHERE family_id IN (?,?)",
        [familyId, crossFamilyId],
      );
      await connection.query(
        "DELETE FROM upload_sessions WHERE family_id IN (?,?)",
        [familyId, crossFamilyId],
      );
      await connection.query(
        "DELETE FROM storage_objects WHERE family_id IN (?,?)",
        [familyId, crossFamilyId],
      );
      await connection.query(
        "DELETE FROM family_members WHERE family_id IN (?,?)",
        [familyId, crossFamilyId],
      );
      await connection.query("DELETE FROM users WHERE username=?", [
        `phase4b_${suffix}`,
      ]);
      await connection.query("DELETE FROM families WHERE id IN (?,?)", [
        familyId,
        crossFamilyId,
      ]);
      await connection.commit();
      const [remaining] = await connection.query<RowDataPacket[]>(
        `SELECT
          (SELECT COUNT(*) FROM media_items WHERE family_id IN (?,?)) +
          (SELECT COUNT(*) FROM upload_sessions WHERE family_id IN (?,?)) +
          (SELECT COUNT(*) FROM storage_objects WHERE family_id IN (?,?)) AS count`,
        [
          familyId,
          crossFamilyId,
          familyId,
          crossFamilyId,
          familyId,
          crossFamilyId,
        ],
      );
      expect(Number(remaining[0]?.count ?? 1)).toBe(0);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await database.pool.end();
    }
  });

  async function createObject(label: string): Promise<FixtureObject> {
    const sha256 = createHash("sha256").update(`${suffix}:${label}`).digest();
    const byteSize = BigInt(1024 + label.length);
    const [result] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO storage_objects
        (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
       VALUES (?,?,?,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      [familyId, sha256, byteSize.toString()],
    );
    return { id: String(result.insertId), sha256, byteSize };
  }

  async function createCompleteReceipt(object: FixtureObject) {
    const [result] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO upload_sessions
        (public_id,family_id,created_by_member_id,original_filename,
         reported_mime,declared_size,committed_offset,state,computed_sha256,
         finalize_started_at,storage_object_id,completed_at,expires_at)
       VALUES (?,?,?,'synthetic.bin','application/octet-stream',?,?,'COMPLETE',?,
         CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
      [
        randomBytes(16),
        familyId,
        memberId,
        object.byteSize.toString(),
        object.byteSize.toString(),
        object.sha256,
        object.id,
      ],
    );
    return String(result.insertId);
  }

  it("creates once and is idempotent for the same completed receipt", async () => {
    const object = await createObject("first-create");
    const uploadId = await createCompleteReceipt(object);

    const first = await repository.createOrGetCanonicalMedia({
      familyId,
      uploadId,
    });
    const second = await repository.createOrGetCanonicalMedia({
      familyId,
      uploadId,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.media).toEqual(first.media);
    expect(first.media).toMatchObject({
      familyId,
      storageObjectId: object.id,
      sourceUploadId: uploadId,
      generation: 1n,
      recipeId: 1,
      mediaType: "UNKNOWN",
      processingState: "PENDING",
      timelineBasis: "UPLOAD_UTC",
    });
    expect(first.media.timelineKey).toEqual(first.media.uploadedAt);
  });

  it("reuses one media for duplicate receipts without replacing first provenance", async () => {
    const object = await createObject("sequential-dedupe");
    const firstUploadId = await createCompleteReceipt(object);
    const duplicateUploadId = await createCompleteReceipt(object);
    const first = await repository.createOrGetCanonicalMedia({
      familyId,
      uploadId: firstUploadId,
    });
    const duplicate = await repository.createOrGetCanonicalMedia({
      familyId,
      uploadId: duplicateUploadId,
    });

    expect(duplicate.created).toBe(false);
    expect(duplicate.media.id).toBe(first.media.id);
    expect(duplicate.media.sourceUploadId).toBe(firstUploadId);
  });

  it("rejects incomplete receipts, unavailable storage, and cross-family access", async () => {
    const [incomplete] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO upload_sessions
        (public_id,family_id,created_by_member_id,original_filename,
         declared_size,committed_offset,state,expires_at)
       VALUES (?,?,?,'incomplete.bin',16,0,'CREATED',
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
      [randomBytes(16), familyId, memberId],
    );
    await expect(
      repository.createOrGetCanonicalMedia({
        familyId,
        uploadId: String(incomplete.insertId),
      }),
    ).rejects.toMatchObject<Partial<MediaRepositoryError>>({
      reason: "RECEIPT_NOT_COMPLETE",
    });

    const object = await createObject("unavailable");
    const uploadId = await createCompleteReceipt(object);
    await database.pool.query(
      "UPDATE storage_objects SET state='MISSING' WHERE id=?",
      [object.id],
    );
    await expect(
      repository.createOrGetCanonicalMedia({ familyId, uploadId }),
    ).rejects.toMatchObject<Partial<MediaRepositoryError>>({
      reason: "STORAGE_UNAVAILABLE",
    });
    await expect(
      repository.createOrGetCanonicalMedia({
        familyId: crossFamilyId,
        uploadId,
      }),
    ).rejects.toMatchObject<Partial<MediaRepositoryError>>({
      reason: "NOT_FOUND",
    });
  });

  it("converges real concurrent duplicate receipt creation on one identity", async () => {
    const object = await createObject("concurrent-dedupe");
    const uploadA = await createCompleteReceipt(object);
    const uploadB = await createCompleteReceipt(object);
    const repositoryB = new MySqlMediaRepository(database.pool);

    const [left, right] = await Promise.all([
      repository.createOrGetCanonicalMedia({ familyId, uploadId: uploadA }),
      repositoryB.createOrGetCanonicalMedia({ familyId, uploadId: uploadB }),
    ]);

    expect(left.media.id).toBe(right.media.id);
    expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
    expect([uploadA, uploadB]).toContain(left.media.sourceUploadId);
    const loserUpload =
      left.media.sourceUploadId === uploadA ? uploadB : uploadA;
    const replay = await repository.createOrGetCanonicalMedia({
      familyId,
      uploadId: loserUpload,
    });
    expect(replay.media.sourceUploadId).toBe(left.media.sourceUploadId);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM media_items WHERE family_id=? AND storage_object_id=?",
      [familyId, object.id],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("does not mutate the receipt or canonical storage record", async () => {
    const object = await createObject("immutability");
    const uploadId = await createCompleteReceipt(object);
    const before = await immutableSnapshot(uploadId, object.id);

    await repository.createOrGetCanonicalMedia({ familyId, uploadId });

    expect(await immutableSnapshot(uploadId, object.id)).toEqual(before);
  });

  async function immutableSnapshot(uploadId: string, objectId: string) {
    const [receipt] = await database.pool.query<RowDataPacket[]>(
      `SELECT state,CAST(storage_object_id AS CHAR) AS storageObjectId,
        HEX(computed_sha256) AS computedSha256,
        CAST(declared_size AS CHAR) AS declaredSize,
        CAST(committed_offset AS CHAR) AS committedOffset,
        completed_at AS completedAt,updated_at AS updatedAt
       FROM upload_sessions WHERE id=?`,
      [uploadId],
    );
    const [storage] = await database.pool.query<RowDataPacket[]>(
      `SELECT state,HEX(sha256) AS sha256,CAST(byte_size AS CHAR) AS byteSize,
        key_version AS keyVersion,durable_at AS durableAt,
        verified_at AS verifiedAt,updated_at AS updatedAt
       FROM storage_objects WHERE id=?`,
      [objectId],
    );
    return { receipt: receipt[0], storage: storage[0] };
  }
});
