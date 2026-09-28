import { randomBytes, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

// SQL-only synthetic fixture: no original files and no real credentials.
// Caller owns the transaction; runtime probes always roll it back.
export async function createPhase6SchemaFixture(connection: PoolConnection) {
  const marker = `phase6a_${randomUUID().replaceAll("-", "")}`;
  async function insert(sql: string, values: unknown[]) {
    await connection.query(sql, values);
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id",
    );
    return String(rows[0]!.id);
  }
  const familyId = await insert("INSERT INTO families (name) VALUES (?)", [
    marker,
  ]);
  const userId = await insert(
    "INSERT INTO users (username,username_normalized,password_hash,password_changed_at) VALUES (?,?,?,CURRENT_TIMESTAMP(3))",
    [marker, Buffer.from(marker), "synthetic-not-a-password"],
  );
  const memberId = await insert(
    "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
    [familyId, userId],
  );
  const actorName = `${marker}_actor`;
  const actorUserId = await insert(
    "INSERT INTO users (username,username_normalized,password_hash,password_changed_at) VALUES (?,?,?,CURRENT_TIMESTAMP(3))",
    [actorName, Buffer.from(actorName), "synthetic-not-a-password"],
  );
  const actorMemberId = await insert(
    "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
    [familyId, actorUserId],
  );
  const digest = randomBytes(32);
  const objectId = await insert(
    "INSERT INTO storage_objects (family_id,sha256,byte_size,state,durable_at,verified_at) VALUES (?,?,16,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))",
    [familyId, digest],
  );
  const uploadId = await insert(
    `INSERT INTO upload_sessions
      (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,finalize_started_at,storage_object_id,completed_at,expires_at)
     VALUES (?,?,?,'phase6a-synthetic.bin',16,16,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
    [randomBytes(16), familyId, memberId, digest, objectId],
  );
  const mediaId = await insert(
    "INSERT INTO media_items (family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key) VALUES (?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))",
    [familyId, objectId, uploadId],
  );
  return {
    marker,
    familyId,
    userId,
    memberId,
    actorUserId,
    actorMemberId,
    objectId,
    uploadId,
    mediaId,
  };
}

// Only the migration runner commits a fixture, to test pre-existing-row defaults.
// No marker-wide deletion: cleanup binds exact generated IDs and ownership.
export async function cleanupPhase6MigrationFixture(
  connection: PoolConnection,
  fixture: Awaited<ReturnType<typeof createPhase6SchemaFixture>>,
) {
  await connection.beginTransaction();
  try {
    await connection.query(
      "DELETE FROM media_items WHERE id=? AND family_id=? AND source_upload_id=?",
      [fixture.mediaId, fixture.familyId, fixture.uploadId],
    );
    await connection.query(
      "DELETE FROM upload_sessions WHERE id=? AND family_id=?",
      [fixture.uploadId, fixture.familyId],
    );
    await connection.query(
      "DELETE FROM storage_objects WHERE id=? AND family_id=?",
      [fixture.objectId, fixture.familyId],
    );
    await connection.query(
      "DELETE FROM family_members WHERE family_id=? AND id IN (?,?)",
      [fixture.familyId, fixture.memberId, fixture.actorMemberId],
    );
    await connection.query(
      "DELETE FROM users WHERE (id=? AND username=?) OR (id=? AND username=?)",
      [
        fixture.userId,
        fixture.marker,
        fixture.actorUserId,
        `${fixture.marker}_actor`,
      ],
    );
    await connection.query("DELETE FROM families WHERE id=? AND name=?", [
      fixture.familyId,
      fixture.marker,
    ]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}
