import { randomBytes, randomUUID } from "node:crypto";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createShareToken,
  hashShareToken,
} from "../../packages/auth/src/token.js";
import {
  assertMigrationReadiness,
  createDatabase,
  MySqlAlbumRepository,
  MySqlShareRepository,
} from "../../packages/db/src/index.js";
import { PublicAuthError } from "../../apps/api/src/auth/service.js";
import { ShareService } from "../../apps/api/src/shares/service.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE5C_DEV_DATABASE_URL_REQUIRED");

describe.sequential("Phase 5C share service", () => {
  const database = createDatabase(databaseUrl);
  const albums = new MySqlAlbumRepository(database.pool);
  const shares = new MySqlShareRepository(database.pool, albums);
  const service = new ShareService(shares);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const ownerHash = randomBytes(32);
  const viewerHash = randomBytes(32);
  const adminHash = randomBytes(32);
  const managerHash = randomBytes(32);
  const outsiderHash = randomBytes(32);
  let familyId = "";
  let otherFamilyId = "";
  let ownerUserId = "";
  let ownerSessionId = "";
  let viewerUserId = "";
  let viewerSessionId = "";
  let adminUserId = "";
  let adminSessionId = "";
  let managerUserId = "";
  let managerSessionId = "";
  let outsiderUserId = "";
  let outsiderSessionId = "";
  let ownerMemberId = "";
  let viewerMemberId = "";
  let managerMemberId = "";
  let ownedAlbum = "";
  let familyAlbum = "";
  let customAlbum = "";
  let managedAlbum = "";

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await assertDev(connection);
      await assertMigrationReadiness(connection);
      familyId = await insertFamily(connection, `Share svc ${suffix}`);
      otherFamilyId = await insertFamily(connection, `Share other ${suffix}`);
      ownerUserId = await insertUser(connection, `p5c_o_${suffix}`);
      viewerUserId = await insertUser(connection, `p5c_v_${suffix}`);
      adminUserId = await insertUser(connection, `p5c_a_${suffix}`);
      managerUserId = await insertUser(connection, `p5c_m_${suffix}`);
      outsiderUserId = await insertUser(connection, `p5c_x_${suffix}`);
      ownerMemberId = await insertMember(
        connection,
        familyId,
        ownerUserId,
        "MEMBER",
      );
      viewerMemberId = await insertMember(
        connection,
        familyId,
        viewerUserId,
        "MEMBER",
      );
      await insertMember(connection, familyId, adminUserId, "ADMIN");
      managerMemberId = await insertMember(
        connection,
        familyId,
        managerUserId,
        "MEMBER",
      );
      await insertMember(connection, otherFamilyId, outsiderUserId, "MEMBER");
      ownerSessionId = await insertSession(connection, ownerUserId, ownerHash);
      viewerSessionId = await insertSession(
        connection,
        viewerUserId,
        viewerHash,
      );
      adminSessionId = await insertSession(connection, adminUserId, adminHash);
      managerSessionId = await insertSession(
        connection,
        managerUserId,
        managerHash,
      );
      outsiderSessionId = await insertSession(
        connection,
        outsiderUserId,
        outsiderHash,
      );
      ownedAlbum = await insertAlbum(
        connection,
        familyId,
        ownerMemberId,
        "CUSTOM",
        "Owned",
      );
      familyAlbum = await insertAlbum(
        connection,
        familyId,
        ownerMemberId,
        "FAMILY",
        "Family",
      );
      customAlbum = await insertAlbum(
        connection,
        familyId,
        ownerMemberId,
        "CUSTOM",
        "Custom",
      );
      managedAlbum = await insertAlbum(
        connection,
        familyId,
        ownerMemberId,
        "CUSTOM",
        "Managed",
      );
      await connection.query(
        `INSERT INTO album_members
          (family_id, album_id, member_id, can_view, can_manage_members)
         VALUES (?,?,?,1,1)`,
        [familyId, managedAlbum, managerMemberId],
      );
      await connection.query(
        `INSERT INTO album_members
          (family_id, album_id, member_id, can_view, can_manage_members)
         VALUES (?,?,?,1,0)`,
        [familyId, managedAlbum, viewerMemberId],
      );
    } finally {
      connection.release();
    }
  }, 30_000);

  afterAll(async () => {
    const families = [familyId, otherFamilyId].filter((id) => id !== "");
    if (families.length > 0) {
      await database.pool.query(
        `DELETE FROM share_events WHERE family_id IN (?)`,
        [families],
      );
      await database.pool.query(`DELETE FROM shares WHERE family_id IN (?)`, [
        families,
      ]);
      await database.pool.query(
        `DELETE FROM album_members WHERE family_id IN (?)`,
        [families],
      );
      await database.pool.query(`DELETE FROM albums WHERE family_id IN (?)`, [
        families,
      ]);
      await database.pool.query(`DELETE FROM sessions WHERE user_id IN (?)`, [
        [ownerUserId, viewerUserId, adminUserId, managerUserId, outsiderUserId],
      ]);
      await database.pool.query(
        `DELETE FROM family_members WHERE family_id IN (?)`,
        [families],
      );
      await database.pool.query(
        `DELETE FROM users WHERE username_normalized IN (?)`,
        [
          [
            Buffer.from(`p5c_o_${suffix}`),
            Buffer.from(`p5c_v_${suffix}`),
            Buffer.from(`p5c_a_${suffix}`),
            Buffer.from(`p5c_m_${suffix}`),
            Buffer.from(`p5c_x_${suffix}`),
          ],
        ],
      );
      await database.pool.query(`DELETE FROM families WHERE id IN (?)`, [
        families,
      ]);
    }
    await database.pool.end();
  });

  it("stores only the token hash and rejects a duplicate hash", async () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const created = await service.createShare(owner(), ownedAlbum, expiresAt);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT token_hash AS tokenHash FROM shares WHERE id = ?`,
      [created.shareId],
    );
    const stored = rows[0]?.tokenHash as Buffer;
    expect(stored.equals(hashShareToken(created.token))).toBe(true);
    expect(stored.toString("utf8")).not.toContain(created.token);
    expect(stored.toString("hex")).not.toContain(created.token);
    await expect(
      shares.insertShare({
        actor: {
          userId: ownerUserId,
          sessionId: ownerSessionId,
          tokenHash: ownerHash,
        },
        albumId: ownedAlbum,
        tokenHash: hashShareToken(created.token),
        expiresAt,
      }),
    ).rejects.toMatchObject({ reason: "CONFLICT" });
    expect(await eventTypes(created.shareId)).toEqual([
      ["CREATE", ownerMemberId],
    ]);
  });

  it("verifies an active share and hides invalid, expired, and revoked tokens", async () => {
    const created = await service.createShare(
      owner(),
      ownedAlbum,
      new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    );
    await expect(
      service.verifyShareToken(created.token),
    ).resolves.toMatchObject({
      shareId: created.shareId,
      familyId,
      albumId: ownedAlbum,
    });
    const before = await eventCount();
    await expect(service.verifyShareToken("not-a-token")).rejects.toMatchObject(
      {
        statusCode: 404,
        code: "NOT_FOUND",
      },
    );
    await expect(
      service.verifyShareToken(createShareToken()),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await eventCount()).toBe(before);

    await database.pool.query(
      `UPDATE shares
          SET created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 HOUR),
              expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 HOUR)
        WHERE id = ?`,
      [created.shareId],
    );
    await expect(service.verifyShareToken(created.token)).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      },
    );

    const revokedShare = await service.createShare(
      owner(),
      ownedAlbum,
      new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    );
    const revoked = await service.revokeShare(owner(), revokedShare.shareId);
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(revoked)).not.toContain(revokedShare.token);
    await expect(
      service.verifyShareToken(revokedShare.token),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await eventTypes(revokedShare.shareId)).toEqual([
      ["CREATE", ownerMemberId],
      ["REVOKE", ownerMemberId],
    ]);
    await service.revokeShare(owner(), revokedShare.shareId);
    expect(await eventTypes(revokedShare.shareId)).toEqual([
      ["CREATE", ownerMemberId],
      ["REVOKE", ownerMemberId],
    ]);
  });

  it("allows only an owner or member manager to create and revoke", async () => {
    await expect(
      service.createShare(
        viewer(),
        familyAlbum,
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    await expect(
      service.createShare(
        admin(),
        customAlbum,
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });

    const managed = await service.createShare(
      manager(),
      managedAlbum,
      new Date(Date.now() + 24 * 60 * 60 * 1000),
    );
    await expect(
      service.revokeShare(viewer(), managed.shareId),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    await expect(
      service.revokeShare(outsider(), managed.shareId),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    const listed = await service.listShares(manager(), {
      familyId,
      limit: 20,
    });
    expect(listed.map((share) => share.shareId)).toContain(managed.shareId);
    expect(JSON.stringify(listed)).not.toContain(managed.token);
    const hidden = await service.listShares(viewer(), {
      familyId,
      limit: 20,
    });
    expect(hidden.map((share) => share.shareId)).not.toContain(managed.shareId);
  });

  function owner() {
    return actor(ownerUserId, ownerSessionId, ownerHash);
  }
  function viewer() {
    return actor(viewerUserId, viewerSessionId, viewerHash);
  }
  function admin() {
    return actor(adminUserId, adminSessionId, adminHash);
  }
  function manager() {
    return actor(managerUserId, managerSessionId, managerHash);
  }
  function outsider() {
    return actor(outsiderUserId, outsiderSessionId, outsiderHash);
  }

  function actor(userId: string, sessionId: string, tokenHash: Buffer) {
    return {
      identity: { userId, sessionId },
      tokenHash,
    } as Parameters<ShareService["createShare"]>[0];
  }

  async function eventTypes(shareId: string) {
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT event_type AS eventType, CAST(actor_member_id AS CHAR) AS actor
         FROM share_events WHERE share_id = ? ORDER BY id ASC`,
      [shareId],
    );
    return rows.map((row) => [String(row.eventType), String(row.actor ?? "")]);
  }

  async function eventCount() {
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS events FROM share_events WHERE family_id = ?`,
      [familyId],
    );
    return Number(rows[0]?.events);
  }
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
  const record = Array.isArray(identity) ? identity[0] : identity;
  if (
    record?.db !== "family_album_dev" ||
    !String(record.version).startsWith("9.7.2") ||
    String(record.account).split("@")[0]?.toLowerCase() === "root" ||
    String(record.nativeFk) !== "1" ||
    String(record.foreignKeyChecks) !== "1"
  ) {
    throw new Error("PHASE5C_SHARE_DEV_PREFLIGHT_FAILED");
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
    [username, Buffer.from(username), "synthetic-not-used", "Phase 5C"],
  );
  return String(user.insertId);
}

async function insertMember(
  connection: { query: Query },
  familyId: string,
  userId: string,
  role: "ADMIN" | "MEMBER",
) {
  const [member] = await connection.query(
    "INSERT INTO family_members (family_id, user_id, role) VALUES (?,?,?)",
    [familyId, userId, role],
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
