import { randomUUID } from "node:crypto";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
} from "../../packages/auth/src/index.js";
import {
  createDatabase,
  MySqlAlbumRepository,
  MySqlPhase1CRepository,
  type Phase1CActor,
} from "../../packages/db/src/index.js";
import type { AlbumPermissionGrant } from "../../packages/permissions/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const VIEW: AlbumPermissionGrant = {
  canView: true,
  canUpload: false,
  canEdit: false,
  canDelete: false,
  canManageMembers: false,
};
const MANAGER: AlbumPermissionGrant = {
  canView: true,
  canUpload: true,
  canEdit: false,
  canDelete: false,
  canManageMembers: true,
};

run("Phase 2B MySQL album ACL boundaries and races", () => {
  const database = createDatabase(databaseUrl!);
  const repository = new MySqlAlbumRepository(database.pool);
  const familyRepository = new MySqlPhase1CRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const familyIds: string[] = [];
  const actors = new Map<string, Phase1CActor>();
  const memberIds = new Map<string, string>();
  let primaryFamilyId = "";

  beforeAll(async () => {
    const passwordHash = await hashPassword("phase2b-synthetic-password");
    primaryFamilyId = await seedFamily("primary", passwordHash, [
      ["owner", "MEMBER"],
      ["managerA", "MEMBER"],
      ["managerB", "MEMBER"],
      ["viewer", "MEMBER"],
      ["targetA", "MEMBER"],
      ["targetB", "MEMBER"],
      ["staleHidden", "MEMBER"],
      ["staleVisible", "MEMBER"],
      ["disabled", "MEMBER"],
      ["admin", "ADMIN"],
      ["super", "SUPER_ADMIN"],
    ]);
    await seedFamily("other", passwordHash, [["other", "SUPER_ADMIN"]]);
    await database.pool.query(
      "UPDATE family_members SET disabled_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [memberIds.get("disabled")!],
    );
    await database.pool.query(
      `UPDATE sessions
          SET authenticated_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 16 MINUTE)
        WHERE id IN (?, ?)`,
      [
        actors.get("staleHidden")!.sessionId,
        actors.get("staleVisible")!.sessionId,
      ],
    );
  }, 20_000);

  afterAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      await connection.beginTransaction();
      await connection.query(
        "DELETE FROM album_members WHERE family_id IN (?)",
        [familyIds],
      );
      await connection.query("DELETE FROM albums WHERE family_id IN (?)", [
        familyIds,
      ]);
      await connection.query(
        "DELETE s FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username LIKE ?",
        [`phase2b_%_${suffix}`],
      );
      await connection.query(
        "DELETE FROM family_members WHERE family_id IN (?)",
        [familyIds],
      );
      await connection.query("DELETE FROM users WHERE username LIKE ?", [
        `phase2b_%_${suffix}`,
      ]);
      await connection.query("DELETE FROM families WHERE id IN (?)", [
        familyIds,
      ]);
      await connection.commit();
      const [remaining] = await connection.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM families WHERE name LIKE ?) +
           (SELECT COUNT(*) FROM users WHERE username LIKE ?) AS rowCount`,
        [`Phase 2B % ${suffix}`, `phase2b_%_${suffix}`],
      );
      if (Number(remaining[0]?.rowCount ?? 1) !== 0) {
        throw new Error("Phase 2B synthetic fixture cleanup failed.");
      }
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await database.pool.end();
    }
  });

  it("limits the member list to Owner and delegated managers", async () => {
    const albumId = await createAlbum();
    await seedGrant(albumId, "managerA", MANAGER);
    await seedGrant(albumId, "viewer", VIEW);
    const ownerList = await repository.listAlbumMembers({
      actor: actor("owner"),
      albumId,
    });
    expect(ownerList.map((entry) => entry.memberId)).toEqual(
      ["owner", "managerA", "viewer"]
        .map((name) => memberIds.get(name)!)
        .sort(compareIds),
    );
    expect(ownerList.find((entry) => entry.isOwner)?.displayName).toBe("owner");
    await expect(
      repository.listAlbumMembers({ actor: actor("managerA"), albumId }),
    ).resolves.toHaveLength(3);
    await expect(
      repository.listAlbumMembers({ actor: actor("viewer"), albumId }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await expect(
      repository.listAlbumMembers({ actor: actor("other"), albumId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    const deletedId = await createAlbum();
    await repository.softDeleteAlbum({
      actor: actor("owner"),
      albumId: deletedId,
      expectedRevision: "1",
    });
    await expect(
      repository.listAlbumMembers({
        actor: actor("owner"),
        albumId: deletedId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
  });

  it("enforces Owner, self, manager and family-role boundaries", async () => {
    const albumId = await createAlbum();
    await seedGrant(albumId, "managerA", MANAGER);
    await seedGrant(albumId, "managerB", MANAGER);

    await expect(
      put("managerA", albumId, "targetA", {
        ...VIEW,
        canUpload: true,
      }),
    ).resolves.toMatchObject({ action: "ADDED", revision: "2" });
    await expect(
      put("managerA", albumId, "targetB", {
        ...VIEW,
        canEdit: true,
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await expect(
      put("managerA", albumId, "managerA", MANAGER),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await expect(
      put("managerA", albumId, "managerB", VIEW),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await expect(put("owner", albumId, "owner", VIEW)).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
    await expect(
      repository.removeAlbumMember({
        actor: actor("managerA"),
        albumId,
        targetMemberId: member("managerB"),
        expectedRevision: "2",
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await expect(
      repository.removeAlbumMember({
        actor: actor("owner"),
        albumId,
        targetMemberId: member("owner"),
        expectedRevision: "2",
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await expect(put("admin", albumId, "targetB", VIEW)).rejects.toMatchObject({
      reason: "NOT_FOUND",
    });
    await expect(put("super", albumId, "targetB", VIEW)).rejects.toMatchObject({
      reason: "NOT_FOUND",
    });
    await expect(put("owner", albumId, "other", VIEW)).rejects.toMatchObject({
      reason: "NOT_FOUND",
    });
    await expect(put("owner", albumId, "disabled", VIEW)).rejects.toMatchObject(
      { reason: "FORBIDDEN" },
    );
  });

  it("lets Owner grant managers while delegated managers cannot", async () => {
    const albumId = await createAlbum();
    await seedGrant(albumId, "managerA", MANAGER);
    await expect(
      put("owner", albumId, "targetA", MANAGER),
    ).resolves.toMatchObject({ action: "ADDED", revision: "2" });
    await expect(
      put("managerA", albumId, "targetB", MANAGER),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await expect(
      put("owner", albumId, "targetB", {
        canView: false,
        canUpload: false,
        canEdit: false,
        canDelete: false,
        canManageMembers: false,
      }),
    ).rejects.toMatchObject({ reason: "CONFLICT" });
  });

  it("requires both existing and requested target grants to be subsets", async () => {
    const albumId = await createAlbum();
    await seedGrant(albumId, "managerA", MANAGER);
    await seedGrant(albumId, "targetA", { ...VIEW, canEdit: true });
    await expect(
      put("managerA", albumId, "targetA", VIEW),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await expect(
      repository.removeAlbumMember({
        actor: actor("managerA"),
        albumId,
        targetMemberId: member("targetA"),
        expectedRevision: "1",
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
  });

  it("updates, removes and preserves FAMILY implicit view correctly", async () => {
    const customId = await createAlbum();
    await seedGrant(customId, "managerA", MANAGER);
    await seedGrant(customId, "targetA", VIEW);
    await expect(
      put("managerA", customId, "targetA", { ...VIEW, canUpload: true }),
    ).resolves.toMatchObject({ action: "CHANGED", revision: "2" });
    await expect(
      repository.removeAlbumMember({
        actor: actor("managerA"),
        albumId: customId,
        targetMemberId: member("targetA"),
        expectedRevision: "2",
      }),
    ).resolves.toMatchObject({ changed: true, revision: "3" });
    await expect(
      repository.getAlbum({ actor: actor("targetA"), albumId: customId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });

    const familyId = await createAlbum("FAMILY");
    await seedGrant(familyId, "targetA", VIEW);
    await repository.removeAlbumMember({
      actor: actor("owner"),
      albumId: familyId,
      targetMemberId: member("targetA"),
      expectedRevision: "1",
    });
    const stillVisible = await repository.getAlbum({
      actor: actor("targetA"),
      albumId: familyId,
    });
    expect(stillVisible.effectivePermissions).toEqual(VIEW);
  });

  it("lets Owner update a normal grant and rejects stale revisions", async () => {
    const albumId = await createAlbum();
    await seedGrant(albumId, "targetA", VIEW);
    await expect(
      put("owner", albumId, "targetA", { ...VIEW, canEdit: true }, "1"),
    ).resolves.toMatchObject({ action: "CHANGED", revision: "2" });
    await expect(
      put("owner", albumId, "targetA", VIEW, "1"),
    ).rejects.toMatchObject({ reason: "CONFLICT" });
  });

  it("keeps FK and permission prerequisite CHECKs enforced at runtime", async () => {
    const albumId = await createAlbum();
    await expect(
      database.pool.query(
        `INSERT INTO album_members
          (family_id, album_id, member_id, can_view)
         VALUES (?, ?, ?, 1)`,
        [primaryFamilyId, albumId, member("other")],
      ),
    ).rejects.toMatchObject({ errno: 1452 });
    await expect(
      database.pool.query(
        `INSERT INTO album_members
          (family_id, album_id, member_id, can_view, can_upload)
         VALUES (?, ?, ?, 0, 1)`,
        [primaryFamilyId, albumId, member("targetA")],
      ),
    ).rejects.toMatchObject({ errno: 3819 });
  });

  it("allows only one manager to mutate an ACL at the same revision", async () => {
    const albumId = await createAlbum();
    await seedGrant(albumId, "managerA", MANAGER);
    await seedGrant(albumId, "managerB", MANAGER);
    const attempts = await Promise.allSettled([
      put("managerA", albumId, "targetA", VIEW, "1"),
      put("managerB", albumId, "targetA", { ...VIEW, canUpload: true }, "1"),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { reason: "CONFLICT" } });
    expect((await album(albumId)).revision).toBe("2");
  });

  it("serializes real Owner delete/visibility changes against delegated ACL writes", async () => {
    const deleteRace = await createAlbum();
    await seedGrant(deleteRace, "managerA", MANAGER);
    const deleteResults = await Promise.allSettled([
      repository.softDeleteAlbum({
        actor: actor("owner"),
        albumId: deleteRace,
        expectedRevision: "1",
      }),
      put("managerA", deleteRace, "targetA", VIEW, "1"),
    ]);
    expect(
      deleteResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        deleteResults.find((result) => result.status === "rejected") as {
          reason: { reason: string };
        }
      ).reason.reason,
    ).toMatch(/^(CONFLICT|NOT_FOUND)$/);

    const visibilityRace = await createAlbum("FAMILY");
    await seedGrant(visibilityRace, "managerA", MANAGER);
    const visibilityResults = await Promise.allSettled([
      repository.updateAlbum({
        actor: actor("owner"),
        albumId: visibilityRace,
        expectedRevision: "1",
        visibility: "CUSTOM",
      }),
      put("managerA", visibilityRace, "targetA", VIEW, "1"),
    ]);
    expect(
      visibilityResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      visibilityResults.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { reason: "CONFLICT" } });
    expect((await album(visibilityRace)).revision).toBe("2");
  });

  it("revalidates manager and target state after a family-lock wait", async () => {
    const managerAlbum = await createAlbum();
    await seedGrant(managerAlbum, "managerA", MANAGER);
    await queuedAfterFamilyBarrier(
      () => put("owner", managerAlbum, "managerA", VIEW, "1"),
      () => put("managerA", managerAlbum, "targetA", VIEW, "1"),
      "FORBIDDEN",
    );

    const targetAlbum = await createAlbum();
    await seedGrant(targetAlbum, "managerA", MANAGER);
    await queuedAfterFamilyBarrier(
      () =>
        familyRepository.updateMember({
          actor: actor("super"),
          familyId: primaryFamilyId,
          targetMemberId: member("targetB"),
          mutation: { kind: "DISABLED", disabled: true },
        }),
      () => put("managerA", targetAlbum, "targetB", VIEW, "1"),
      "FORBIDDEN",
    );
  });

  it("revalidates album deletion, visibility and revision after lock waits", async () => {
    const deletedAlbum = await createAlbum();
    await seedGrant(deletedAlbum, "managerA", MANAGER);
    await barrierMutation(
      `UPDATE albums SET deleted_at = CURRENT_TIMESTAMP(3),
              revision = revision + 1 WHERE id = ?`,
      [deletedAlbum],
      () => put("managerA", deletedAlbum, "targetA", VIEW, "1"),
      "NOT_FOUND",
    );

    const visibilityAlbum = await createAlbum("FAMILY");
    await seedGrant(visibilityAlbum, "managerA", MANAGER);
    await barrierMutation(
      "UPDATE albums SET visibility = 'CUSTOM', revision = revision + 1 WHERE id = ?",
      [visibilityAlbum],
      () => put("managerA", visibilityAlbum, "targetA", VIEW, "1"),
      "CONFLICT",
    );
  });

  it("hides CUSTOM albums from stale-auth callers before every recent-auth mutation", async () => {
    const albumId = await createAlbum("CUSTOM");

    await expectRecentMutationReason(
      "staleHidden",
      albumId,
      member("targetA"),
      "1",
      "NOT_FOUND",
    );
  });

  it("hides deleted and cross-family albums before checking recent-auth", async () => {
    const deletedAlbumId = await createAlbum("CUSTOM");
    await seedGrant(deletedAlbumId, "staleVisible", MANAGER);
    await repository.softDeleteAlbum({
      actor: actor("owner"),
      albumId: deletedAlbumId,
      expectedRevision: "1",
    });
    await expectRecentMutationReason(
      "staleVisible",
      deletedAlbumId,
      member("targetA"),
      "2",
      "NOT_FOUND",
    );

    const otherAlbum = await repository.createAlbum({
      actor: actor("other"),
      familyId: familyIds[1]!,
      name: "Phase 2B cross-family oracle probe",
      description: null,
      visibility: "FAMILY",
    });
    await expectRecentMutationReason(
      "staleHidden",
      otherAlbum.id,
      member("other"),
      "1",
      "NOT_FOUND",
    );
  });

  it("returns FORBIDDEN only after stale-auth callers are confirmed visible", async () => {
    const staleAlbumId = await createAlbum("CUSTOM");
    await seedGrant(staleAlbumId, "staleVisible", MANAGER);
    await expectRecentMutationReason(
      "staleVisible",
      staleAlbumId,
      member("targetA"),
      "1",
      "FORBIDDEN",
    );

    const validAlbumId = await createAlbum("CUSTOM");
    await seedGrant(validAlbumId, "managerA", MANAGER);
    await expect(
      put("managerA", validAlbumId, "targetA", VIEW, "1"),
    ).resolves.toMatchObject({ action: "ADDED", revision: "2" });
    await expect(
      repository.updateAlbum({
        actor: actor("owner"),
        albumId: validAlbumId,
        expectedRevision: "2",
        visibility: "FAMILY",
      }),
    ).resolves.toMatchObject({ revision: "3", visibility: "FAMILY" });
  });

  async function barrierMutation(
    mutation: string,
    parameters: unknown[],
    operation: () => Promise<unknown>,
    expectedReason: string,
  ) {
    const barrier = await database.pool.getConnection();
    let committed = false;
    try {
      await barrier.query("SET SESSION time_zone = '+00:00'");
      await barrier.beginTransaction();
      await barrier.query("SELECT id FROM families WHERE id = ? FOR UPDATE", [
        primaryFamilyId,
      ]);
      await barrier.query(mutation, parameters);
      const pending = operation();
      const state = await Promise.race([
        pending.then(
          () => "finished",
          () => "finished",
        ),
        delay(40).then(() => "waiting"),
      ]);
      expect(state).toBe("waiting");
      await barrier.commit();
      committed = true;
      await expect(pending).rejects.toMatchObject({ reason: expectedReason });
    } finally {
      if (!committed) await barrier.rollback();
      barrier.release();
    }
  }

  async function queuedAfterFamilyBarrier(
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
    expectedSecondReason: string,
  ) {
    const barrier = await database.pool.getConnection();
    let committed = false;
    try {
      await barrier.query("SET SESSION time_zone = '+00:00'");
      await barrier.beginTransaction();
      await barrier.query("SELECT id FROM families WHERE id = ? FOR UPDATE", [
        primaryFamilyId,
      ]);
      const firstPending = first();
      await expectBlocked(firstPending);
      const secondPending = second();
      await expectBlocked(secondPending);
      await barrier.commit();
      committed = true;
      await expect(firstPending).resolves.toBeDefined();
      await expect(secondPending).rejects.toMatchObject({
        reason: expectedSecondReason,
      });
    } finally {
      if (!committed) await barrier.rollback();
      barrier.release();
    }
  }

  async function expectBlocked(operation: Promise<unknown>) {
    const state = await Promise.race([
      operation.then(
        () => "finished",
        () => "finished",
      ),
      delay(40).then(() => "waiting"),
    ]);
    expect(state).toBe("waiting");
  }

  async function expectRecentMutationReason(
    actorName: string,
    albumId: string,
    targetMemberId: string,
    expectedRevision: string,
    expectedReason: "NOT_FOUND" | "FORBIDDEN",
  ) {
    const currentActor = actor(actorName);
    const operations = [
      () =>
        repository.putAlbumMember({
          actor: currentActor,
          albumId,
          targetMemberId,
          expectedRevision,
          permissions: VIEW,
        }),
      () =>
        repository.removeAlbumMember({
          actor: currentActor,
          albumId,
          targetMemberId,
          expectedRevision,
        }),
      () =>
        repository.softDeleteAlbum({
          actor: currentActor,
          albumId,
          expectedRevision,
        }),
      () =>
        repository.updateAlbum({
          actor: currentActor,
          albumId,
          expectedRevision,
          visibility: "FAMILY",
        }),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({
        reason: expectedReason,
      });
    }
  }

  async function createAlbum(visibility: "FAMILY" | "CUSTOM" = "CUSTOM") {
    const created = await repository.createAlbum({
      actor: actor("owner"),
      familyId: primaryFamilyId,
      name: `Phase 2B ${visibility}`,
      description: null,
      visibility,
    });
    return created.id;
  }

  async function seedGrant(
    albumId: string,
    name: string,
    permissions: AlbumPermissionGrant,
  ) {
    await database.pool.query(
      `INSERT INTO album_members
        (family_id, album_id, member_id, can_view, can_upload, can_edit,
         can_delete, can_manage_members)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        primaryFamilyId,
        albumId,
        member(name),
        permissions.canView,
        permissions.canUpload,
        permissions.canEdit,
        permissions.canDelete,
        permissions.canManageMembers,
      ],
    );
  }

  async function put(
    actorName: string,
    albumId: string,
    targetName: string,
    permissions: AlbumPermissionGrant,
    expectedRevision?: string,
  ) {
    const currentRevision = expectedRevision ?? (await album(albumId)).revision;
    return repository.putAlbumMember({
      actor: actor(actorName),
      albumId,
      targetMemberId: member(targetName),
      expectedRevision: currentRevision,
      permissions,
    });
  }

  function album(albumId: string) {
    return repository.getAlbum({ actor: actor("owner"), albumId });
  }

  function actor(name: string) {
    return actors.get(name)!;
  }

  function member(name: string) {
    return memberIds.get(name)!;
  }

  async function seedFamily(
    label: string,
    passwordHash: string,
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
        [`Phase 2B ${label} ${suffix}`],
      );
      const familyId = String(family.insertId);
      familyIds.push(familyId);
      for (const [name, role] of memberships) {
        const username = `phase2b_${name}_${suffix}`;
        const [user] = await connection.query<ResultSetHeader>(
          `INSERT INTO users
            (username, username_normalized, password_hash, display_name,
             password_changed_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
          [
            username,
            normalizeUsername(username).normalizedBytes,
            passwordHash,
            name,
          ],
        );
        const userId = String(user.insertId);
        const [familyMember] = await connection.query<ResultSetHeader>(
          "INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, ?)",
          [familyId, userId, role],
        );
        const sessionToken = createSessionToken();
        const [session] = await connection.query<ResultSetHeader>(
          `INSERT INTO sessions
            (user_id, token_hash, client_type, authenticated_at, last_seen_at,
             expires_at)
           VALUES (?, ?, 'WEB', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
                   DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY))`,
          [userId, hashSessionToken(sessionToken)],
        );
        memberIds.set(name, String(familyMember.insertId));
        actors.set(name, {
          userId,
          sessionId: String(session.insertId),
          tokenHash: hashSessionToken(sessionToken),
        });
      }
      await connection.commit();
      return familyId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
});

function compareIds(left: string, right: string) {
  return BigInt(left) < BigInt(right)
    ? -1
    : BigInt(left) > BigInt(right)
      ? 1
      : 0;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
