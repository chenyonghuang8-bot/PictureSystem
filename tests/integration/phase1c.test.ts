import { randomUUID } from "node:crypto";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createInvitationToken,
  createSessionToken,
  hashInvitationToken,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
} from "../../packages/auth/src/index.js";
import {
  assertMigrationReadiness,
  assertExactMigrationHistory,
  createDatabase,
  loadExpectedMigrationManifest,
  MySqlPhase1CRepository,
  Phase1CRepositoryError,
  runCheckedTransaction,
  type Phase1CActor,
} from "../../packages/db/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("Phase 1C MySQL invitation and role boundaries", () => {
  const database = createDatabase(databaseUrl!);
  const repository = new MySqlPhase1CRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const familyIds: string[] = [];
  const actors = new Map<string, Phase1CActor>();
  const memberIds = new Map<string, string>();
  let passwordHash = "";

  beforeAll(async () => {
    passwordHash = await hashPassword("phase1c-synthetic-password");
    await seedFamily("primary", [
      ["super1", "SUPER_ADMIN"],
      ["super2", "SUPER_ADMIN"],
      ["admin", "ADMIN"],
      ["member", "MEMBER"],
    ]);
    await seedFamily("other", [["other-super", "SUPER_ADMIN"]]);
  }, 20_000);

  afterAll(async () => {
    try {
      const orderedFamilyIds = [...familyIds].sort(compareDecimalIds);
      const usernameMarker = `^phase1c_[A-Za-z0-9_-]+_${suffix}$`;
      await runCheckedTransaction(database.pool, async (connection) => {
        if (orderedFamilyIds.length > 0) {
          const [families] = await connection.query<RowDataPacket[]>(
            "SELECT name FROM families WHERE id IN (?)",
            [orderedFamilyIds],
          );
          if (
            families.some(
              (row) =>
                !/^Phase 1C (primary|other) [0-9a-f]{32}$/u.test(
                  String(row.name),
                ) || !String(row.name).endsWith(suffix),
            )
          ) {
            throw new Error("PHASE1C_CLEANUP_FAMILY_IDENTITY_MISMATCH");
          }
        }
        const [users] = await connection.query<RowDataPacket[]>(
          "SELECT CAST(id AS CHAR) AS id FROM users WHERE username REGEXP ? ORDER BY id",
          [usernameMarker],
        );
        const userIds = users.map((row) => String(row.id));
        if (orderedFamilyIds.length > 0) {
          const [members] = await connection.query<RowDataPacket[]>(
            `SELECT COUNT(*) AS count FROM family_members m
               JOIN users u ON u.id=m.user_id
              WHERE m.family_id IN (?) AND u.username NOT REGEXP ?`,
            [orderedFamilyIds, usernameMarker],
          );
          if (Number(members[0]?.count ?? 0) !== 0) {
            throw new Error("PHASE1C_CLEANUP_NON_SYNTHETIC_MEMBER");
          }
        }
        // Child-first FK cleanup with exact keys avoids broad locking scans.
        for (const familyId of orderedFamilyIds)
          await connection.query("DELETE FROM invitations WHERE family_id=?", [
            familyId,
          ]);
        for (const userId of userIds)
          await connection.query("DELETE FROM sessions WHERE user_id=?", [
            userId,
          ]);
        for (const familyId of orderedFamilyIds)
          await connection.query(
            "DELETE FROM family_members WHERE family_id=?",
            [familyId],
          );
        for (const userId of userIds)
          await connection.query("DELETE FROM users WHERE id=?", [userId]);
        for (const familyId of orderedFamilyIds)
          await connection.query("DELETE FROM families WHERE id=?", [familyId]);
      });
      const [remaining] = await database.pool.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM families WHERE name REGEXP ?) AS families,
           (SELECT COUNT(*) FROM users WHERE username REGEXP ?) AS users`,
        [`^Phase 1C (primary|other) ${suffix}$`, usernameMarker],
      );
      expect(Number(remaining[0]?.families)).toBe(0);
      expect(Number(remaining[0]?.users)).toBe(0);
    } finally {
      await database.pool.end();
    }
  });

  it("enforces the final create and revoke authorization matrix", async () => {
    const familyId = familyIds[0]!;
    await expect(create("member", familyId, "MEMBER")).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
    await expect(create("admin", familyId, "ADMIN")).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
    await expect(create("admin", familyId, "MEMBER")).resolves.toBeDefined();
    await expect(create("super1", familyId, "ADMIN")).resolves.toBeDefined();
    const listed = await repository.listInvitations(
      actors.get("admin")!,
      familyId,
    );
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");

    const memberInvite = await create("super1", familyId, "MEMBER");
    await expect(
      repository.revokeInvitation({
        actor: actors.get("admin")!,
        familyId,
        invitationId: memberInvite.id,
      }),
    ).resolves.toMatchObject({ actorMemberId: memberIds.get("admin") });

    const adminInvite = await create("super1", familyId, "ADMIN");
    await expect(
      repository.revokeInvitation({
        actor: actors.get("admin")!,
        familyId,
        invitationId: adminInvite.id,
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await repository.revokeInvitation({
      actor: actors.get("super1")!,
      familyId,
      invitationId: adminInvite.id,
    });
    await expect(
      repository.revokeInvitation({
        actor: actors.get("admin")!,
        familyId,
        invitationId: adminInvite.id,
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
  });

  it("matches the complete reviewed migration history and current schema", async () => {
    const connection = await database.pool.getConnection();
    try {
      const expected = await loadExpectedMigrationManifest();
      const [journal] = await connection.query<RowDataPacket[]>(
        "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY id ASC",
      );
      expect(journal).toHaveLength(expected.length);
      expect(() =>
        assertExactMigrationHistory(expected, journal),
      ).not.toThrow();
      expect(expected.map((entry) => entry.index)).toEqual(
        expected.map((_, index) => index),
      );
      expect(expected.every((entry) => entry.tag.length > 0)).toBe(true);
      await expect(assertMigrationReadiness(connection)).resolves.toEqual({
        migrationCount: expected.length,
      });
    } finally {
      connection.release();
    }
  });

  it("allows only one concurrent consume and creates no session", async () => {
    const familyId = familyIds[0]!;
    const token = createInvitationToken();
    const invitation = await repository.createInvitation({
      actor: actors.get("super1")!,
      familyId,
      role: "MEMBER",
      expiresInHours: 48,
      tokenHash: hashInvitationToken(token),
    });
    const locator = await repository.findInvitationByHash(
      hashInvitationToken(token),
    );
    const usernames = [
      `phase1c_consume_a_${suffix}`,
      `phase1c_consume_b_${suffix}`,
    ];
    const attempts = await Promise.allSettled(
      usernames.map((username) =>
        repository.consumeInvitation({
          locator: locator!,
          tokenHash: hashInvitationToken(token),
          username,
          usernameNormalized: normalizeUsername(username).normalizedBytes,
          passwordHash,
          displayName: null,
        }),
      ),
    );
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM invitations WHERE id = ? AND used_at IS NOT NULL) AS usedCount,
         (SELECT COUNT(*) FROM users WHERE username IN (?, ?)) AS userCount,
         (SELECT COUNT(*) FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE u.username IN (?, ?)) AS sessionCount`,
      [invitation.id, ...usernames, ...usernames],
    );
    expect(String(rows[0]?.usedCount)).toBe("1");
    expect(String(rows[0]?.userCount)).toBe("1");
    expect(String(rows[0]?.sessionCount)).toBe("0");
    await expect(
      repository.previewInvitation(hashInvitationToken(token)),
    ).rejects.toMatchObject({ reason: "INVALID_INVITATION" });
    await expect(
      repository.revokeInvitation({
        actor: actors.get("super1")!,
        familyId,
        invitationId: invitation.id,
      }),
    ).rejects.toMatchObject({ reason: "CONFLICT" });
  });

  it("previews only a currently usable invitation without consuming it", async () => {
    const familyId = familyIds[0]!;
    const token = createInvitationToken();
    const invitation = await repository.createInvitation({
      actor: actors.get("super1")!,
      familyId,
      role: "ADMIN",
      expiresInHours: 48,
      tokenHash: hashInvitationToken(token),
    });
    await expect(
      repository.previewInvitation(hashInvitationToken(token)),
    ).resolves.toMatchObject({ role: "ADMIN" });
    const [before] = await database.pool.query<RowDataPacket[]>(
      "SELECT used_at AS usedAt FROM invitations WHERE id = ?",
      [invitation.id],
    );
    expect(before[0]?.usedAt).toBeNull();
    await repository.revokeInvitation({
      actor: actors.get("super1")!,
      familyId,
      invitationId: invitation.id,
    });
    await expect(
      repository.previewInvitation(hashInvitationToken(token)),
    ).rejects.toMatchObject({ reason: "INVALID_INVITATION" });
  });

  it("rejects expired invitations without consuming them", async () => {
    const familyId = familyIds[0]!;
    const token = createInvitationToken();
    const invitation = await repository.createInvitation({
      actor: actors.get("super1")!,
      familyId,
      role: "MEMBER",
      expiresInHours: 48,
      tokenHash: hashInvitationToken(token),
    });
    await database.pool.query(
      `UPDATE invitations
          SET created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 DAY),
              expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)
        WHERE id = ?`,
      [invitation.id],
    );
    await expect(
      repository.previewInvitation(hashInvitationToken(token)),
    ).rejects.toMatchObject({ reason: "INVALID_INVITATION" });
    const locator = await repository.findInvitationByHash(
      hashInvitationToken(token),
    );
    const username = `phase1c_expired_${suffix}`;
    await expect(
      repository.consumeInvitation({
        locator: locator!,
        tokenHash: hashInvitationToken(token),
        username,
        usernameNormalized: normalizeUsername(username).normalizedBytes,
        passwordHash,
        displayName: null,
      }),
    ).rejects.toMatchObject({ reason: "INVALID_INVITATION" });
  });

  it("rechecks invitation expiry after waiting for the family lock", async () => {
    const familyId = familyIds[0]!;
    const token = createInvitationToken();
    const invitation = await repository.createInvitation({
      actor: actors.get("super1")!,
      familyId,
      role: "MEMBER",
      expiresInHours: 48,
      tokenHash: hashInvitationToken(token),
    });
    await database.pool.query(
      "UPDATE invitations SET expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?",
      [invitation.id],
    );
    const locator = await repository.findInvitationByHash(
      hashInvitationToken(token),
    );
    const username = `phase1c_lock_expiry_${suffix}`;
    const barrier = await database.pool.getConnection();
    try {
      await barrier.query("SET SESSION time_zone = '+00:00'");
      await barrier.beginTransaction();
      await barrier.query("SELECT id FROM families WHERE id = ? FOR UPDATE", [
        familyId,
      ]);
      const waiting = repository.consumeInvitation({
        locator: locator!,
        tokenHash: hashInvitationToken(token),
        username,
        usernameNormalized: normalizeUsername(username).normalizedBytes,
        passwordHash,
        displayName: null,
      });
      await delay(1_150);
      await barrier.commit();
      await expect(waiting).rejects.toMatchObject({
        reason: "INVALID_INVITATION",
      });
    } catch (error) {
      await barrier.rollback();
      throw error;
    } finally {
      barrier.release();
    }
  });

  it("keeps the losing invitation usable in a concurrent username race", async () => {
    const familyId = familyIds[0]!;
    const firstToken = createInvitationToken();
    const secondToken = createInvitationToken();
    await repository.createInvitation({
      actor: actors.get("super1")!,
      familyId,
      role: "MEMBER",
      expiresInHours: 48,
      tokenHash: hashInvitationToken(firstToken),
    });
    await repository.createInvitation({
      actor: actors.get("super1")!,
      familyId,
      role: "MEMBER",
      expiresInHours: 48,
      tokenHash: hashInvitationToken(secondToken),
    });
    const first = await repository.findInvitationByHash(
      hashInvitationToken(firstToken),
    );
    const second = await repository.findInvitationByHash(
      hashInvitationToken(secondToken),
    );
    const username = `phase1c_duplicate_${suffix}`;
    const attempts = await Promise.allSettled(
      [
        [first, firstToken],
        [second, secondToken],
      ].map(([locator, rawToken]) =>
        repository.consumeInvitation({
          locator: locator!,
          tokenHash: hashInvitationToken(rawToken!),
          username,
          usernameNormalized: normalizeUsername(username).normalizedBytes,
          passwordHash,
          displayName: null,
        }),
      ),
    );
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS pending FROM invitations WHERE id IN (?, ?) AND used_at IS NULL",
      [first!.id, second!.id],
    );
    expect(String(rows[0]?.pending)).toBe("1");
  });

  it("rolls back user/member creation when a later write fails", async () => {
    const familyId = familyIds[0]!;
    const token = createInvitationToken();
    const invitation = await repository.createInvitation({
      actor: actors.get("super1")!,
      familyId,
      role: "MEMBER",
      expiresInHours: 48,
      tokenHash: hashInvitationToken(token),
    });
    const locator = await repository.findInvitationByHash(
      hashInvitationToken(token),
    );
    const username = `phase1c_rollback_${suffix}`;
    await expect(
      repository.consumeInvitation({
        locator: locator!,
        tokenHash: hashInvitationToken(token),
        username,
        usernameNormalized: normalizeUsername(username).normalizedBytes,
        passwordHash: "x".repeat(300),
        displayName: null,
      }),
    ).rejects.toBeDefined();
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE username = ?) AS userCount,
         (SELECT COUNT(*) FROM invitations WHERE id = ? AND used_at IS NULL) AS pendingCount`,
      [username, invitation.id],
    );
    expect(String(rows[0]?.userCount)).toBe("0");
    expect(String(rows[0]?.pendingCount)).toBe("1");
  });

  it("serializes consume versus revoke to one legal result", async () => {
    const familyId = familyIds[0]!;
    const token = createInvitationToken();
    const invitation = await repository.createInvitation({
      actor: actors.get("super1")!,
      familyId,
      role: "MEMBER",
      expiresInHours: 48,
      tokenHash: hashInvitationToken(token),
    });
    const locator = await repository.findInvitationByHash(
      hashInvitationToken(token),
    );
    const username = `phase1c_revoke_race_${suffix}`;
    const results = await Promise.allSettled([
      repository.consumeInvitation({
        locator: locator!,
        tokenHash: hashInvitationToken(token),
        username,
        usernameNormalized: normalizeUsername(username).normalizedBytes,
        passwordHash,
        displayName: null,
      }),
      repository.revokeInvitation({
        actor: actors.get("super1")!,
        familyId,
        invitationId: invitation.id,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT used_at AS usedAt, revoked_at AS revokedAt FROM invitations WHERE id = ?",
      [invitation.id],
    );
    expect(Boolean(rows[0]?.usedAt) !== Boolean(rows[0]?.revokedAt)).toBe(true);
  });

  it("invalidates invitations atomically when an inviter loses authority", async () => {
    const familyId = familyIds[0]!;
    const token = createInvitationToken();
    await repository.createInvitation({
      actor: actors.get("admin")!,
      familyId,
      role: "MEMBER",
      expiresInHours: 48,
      tokenHash: hashInvitationToken(token),
    });
    await repository.updateMember({
      actor: actors.get("super1")!,
      familyId,
      targetMemberId: memberIds.get("admin")!,
      mutation: { kind: "ROLE", role: "MEMBER" },
    });
    const locator = await repository.findInvitationByHash(
      hashInvitationToken(token),
    );
    await expect(
      repository.consumeInvitation({
        locator: locator!,
        tokenHash: hashInvitationToken(token),
        username: `phase1c_invalidated_${suffix}`,
        usernameNormalized: normalizeUsername(`phase1c_invalidated_${suffix}`)
          .normalizedBytes,
        passwordHash,
        displayName: null,
      }),
    ).rejects.toMatchObject({ reason: "INVALID_INVITATION" });
    await repository.updateMember({
      actor: actors.get("super1")!,
      familyId,
      targetMemberId: memberIds.get("admin")!,
      mutation: { kind: "ROLE", role: "ADMIN" },
    });
  });

  it("rejects consume after the inviter is disabled", async () => {
    const familyId = familyIds[0]!;
    const token = createInvitationToken();
    await repository.createInvitation({
      actor: actors.get("admin")!,
      familyId,
      role: "MEMBER",
      expiresInHours: 48,
      tokenHash: hashInvitationToken(token),
    });
    await repository.updateMember({
      actor: actors.get("super1")!,
      familyId,
      targetMemberId: memberIds.get("admin")!,
      mutation: { kind: "DISABLED", disabled: true },
    });
    const locator = await repository.findInvitationByHash(
      hashInvitationToken(token),
    );
    const username = `phase1c_disabled_inviter_${suffix}`;
    await expect(
      repository.consumeInvitation({
        locator: locator!,
        tokenHash: hashInvitationToken(token),
        username,
        usernameNormalized: normalizeUsername(username).normalizedBytes,
        passwordHash,
        displayName: null,
      }),
    ).rejects.toMatchObject({ reason: "INVALID_INVITATION" });
    await repository.updateMember({
      actor: actors.get("super1")!,
      familyId,
      targetMemberId: memberIds.get("admin")!,
      mutation: { kind: "DISABLED", disabled: false },
    });
  });

  it("disables only the selected family membership", async () => {
    const primaryFamily = familyIds[0]!;
    const otherFamily = familyIds[1]!;
    const memberUserId = actors.get("member")!.userId;
    const [otherMembership] = await database.pool.query<ResultSetHeader>(
      "INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'MEMBER')",
      [otherFamily, memberUserId],
    );
    await repository.updateMember({
      actor: actors.get("admin")!,
      familyId: primaryFamily,
      targetMemberId: memberIds.get("member")!,
      mutation: { kind: "DISABLED", disabled: true },
    });
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id, disabled_at AS disabledAt
         FROM family_members WHERE user_id = ? ORDER BY id`,
      [memberUserId],
    );
    expect(
      rows.find((row) => String(row.id) === String(otherMembership.insertId))
        ?.disabledAt,
    ).toBeNull();
    await repository.updateMember({
      actor: actors.get("super1")!,
      familyId: primaryFamily,
      targetMemberId: memberIds.get("member")!,
      mutation: { kind: "DISABLED", disabled: false },
    });
  });

  it("rejects all ordinary API mutations of every SUPER_ADMIN", async () => {
    const familyId = familyIds[0]!;
    const attempts = await Promise.allSettled([
      repository.updateMember({
        actor: actors.get("super1")!,
        familyId,
        targetMemberId: memberIds.get("super2")!,
        mutation: { kind: "DISABLED", disabled: true },
      }),
      repository.updateMember({
        actor: actors.get("super2")!,
        familyId,
        targetMemberId: memberIds.get("super1")!,
        mutation: { kind: "ROLE", role: "ADMIN" },
      }),
    ]);
    expect(attempts.every((result) => result.status === "rejected")).toBe(true);
    for (const result of attempts) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
        Phase1CRepositoryError,
      );
    }
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS active FROM family_members
        WHERE family_id = ? AND role = 'SUPER_ADMIN' AND disabled_at IS NULL`,
      [familyId],
    );
    expect(String(rows[0]?.active)).toBe("2");
  });

  it("rejects cross-family IDs without touching the target", async () => {
    const invitation = await create("super1", familyIds[0]!, "MEMBER");
    await expect(
      repository.revokeInvitation({
        actor: actors.get("super1")!,
        familyId: familyIds[1]!,
        invitationId: invitation.id,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT revoked_at AS revokedAt FROM invitations WHERE id = ?",
      [invitation.id],
    );
    expect(rows[0]?.revokedAt).toBeNull();
  });

  async function create(
    actorName: string,
    familyId: string,
    role: "ADMIN" | "MEMBER",
  ) {
    return repository.createInvitation({
      actor: actors.get(actorName)!,
      familyId,
      role,
      expiresInHours: 48,
      tokenHash: hashInvitationToken(createInvitationToken()),
    });
  }

  async function seedFamily(
    familyLabel: string,
    memberships: readonly (readonly [
      string,
      "SUPER_ADMIN" | "ADMIN" | "MEMBER",
    ])[],
  ) {
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      await connection.beginTransaction();
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 1C ${familyLabel} ${suffix}`],
      );
      const familyId = String(family.insertId);
      familyIds.push(familyId);
      for (const [name, role] of memberships) {
        const username = `phase1c_${name}_${suffix}`;
        const [user] = await connection.query<ResultSetHeader>(
          `INSERT INTO users
            (username, username_normalized, password_hash, display_name, password_changed_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
          [
            username,
            normalizeUsername(username).normalizedBytes,
            passwordHash,
            name,
          ],
        );
        const userId = String(user.insertId);
        const [member] = await connection.query<ResultSetHeader>(
          "INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, ?)",
          [familyId, userId, role],
        );
        const sessionToken = createSessionToken();
        const [session] = await connection.query<ResultSetHeader>(
          `INSERT INTO sessions
            (user_id, token_hash, client_type, authenticated_at, last_seen_at, expires_at)
           VALUES (?, ?, 'WEB', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
                   DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY))`,
          [userId, hashSessionToken(sessionToken)],
        );
        memberIds.set(name, String(member.insertId));
        actors.set(name, {
          userId,
          sessionId: String(session.insertId),
          tokenHash: hashSessionToken(sessionToken),
        });
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
});

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function compareDecimalIds(left: string, right: string) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
