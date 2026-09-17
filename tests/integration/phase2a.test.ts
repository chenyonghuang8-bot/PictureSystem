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
  AlbumRepositoryError,
  createDatabase,
  MySqlAlbumRepository,
  type Phase1CActor,
} from "../../packages/db/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("Phase 2A MySQL albums and permission reads", () => {
  const database = createDatabase(databaseUrl!);
  const repository = new MySqlAlbumRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const familyIds: string[] = [];
  const actors = new Map<string, Phase1CActor>();
  const memberIds = new Map<string, string>();
  let customId = "";
  let familyVisibleId = "";

  beforeAll(async () => {
    const passwordHash = await hashPassword("phase2a-synthetic-password");
    await seedFamily("primary", passwordHash, [
      ["owner", "MEMBER"],
      ["super", "SUPER_ADMIN"],
      ["editor", "ADMIN"],
      ["viewer", "MEMBER"],
    ]);
    await seedFamily("other", passwordHash, [["other", "SUPER_ADMIN"]]);

    const custom = await repository.createAlbum({
      actor: actors.get("owner")!,
      familyId: familyIds[0]!,
      name: "Hidden custom",
      description: null,
      visibility: "CUSTOM",
    });
    customId = custom.id;
    const familyVisible = await repository.createAlbum({
      actor: actors.get("owner")!,
      familyId: familyIds[0]!,
      name: "Visible family",
      description: "synthetic",
      visibility: "FAMILY",
    });
    familyVisibleId = familyVisible.id;
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
        [`phase2a_%_${suffix}`],
      );
      await connection.query(
        "DELETE FROM family_members WHERE family_id IN (?)",
        [familyIds],
      );
      await connection.query("DELETE FROM users WHERE username LIKE ?", [
        `phase2a_%_${suffix}`,
      ]);
      await connection.query("DELETE FROM families WHERE id IN (?)", [
        familyIds,
      ]);
      await connection.commit();
      const [remaining] = await connection.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM families WHERE name LIKE ?) +
           (SELECT COUNT(*) FROM users WHERE username LIKE ?) AS rowCount`,
        [`Phase 2A % ${suffix}`, `phase2a_%_${suffix}`],
      );
      if (Number(remaining[0]?.rowCount ?? 1) !== 0) {
        throw new Error("Phase 2A synthetic fixture cleanup failed.");
      }
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await database.pool.end();
    }
  });

  it("does not give SUPER_ADMIN a CUSTOM bypass and filters before LIMIT", async () => {
    const familyId = familyIds[0]!;
    await expect(
      repository.getAlbum({ actor: actors.get("super")!, albumId: customId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    const page = await repository.listAlbums({
      actor: actors.get("super")!,
      familyId,
      limit: 1,
    });
    expect(page.map((album) => album.id)).toEqual([familyVisibleId]);
    expect(page[0]?.effectivePermissions).toEqual({
      canView: true,
      canUpload: false,
      canEdit: false,
      canDelete: false,
      canManageMembers: false,
    });
  });

  it("applies explicit grants without family-role bypass", async () => {
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      await connection.query(
        `INSERT INTO album_members
          (family_id, album_id, member_id, can_view, can_edit)
         VALUES (?, ?, ?, 1, 1)`,
        [familyIds[0]!, customId, memberIds.get("editor")!],
      );
    } finally {
      connection.release();
    }
    const album = await repository.getAlbum({
      actor: actors.get("editor")!,
      albumId: customId,
    });
    expect(album.effectivePermissions.canView).toBe(true);
    expect(album.effectivePermissions.canEdit).toBe(true);
    expect(album.effectivePermissions.canManageMembers).toBe(false);
  });

  it("returns explicit CUSTOM and FAMILY grants through listAlbums", async () => {
    const explicitCustom = await repository.createAlbum({
      actor: actors.get("owner")!,
      familyId: familyIds[0]!,
      name: "Explicit custom list result",
      description: null,
      visibility: "CUSTOM",
    });
    const explicitFamily = await repository.createAlbum({
      actor: actors.get("owner")!,
      familyId: familyIds[0]!,
      name: "Explicit family list result",
      description: null,
      visibility: "FAMILY",
    });
    await database.pool.query(
      `INSERT INTO album_members
        (family_id, album_id, member_id, can_view, can_edit)
       VALUES (?, ?, ?, 1, 0), (?, ?, ?, 1, 1)`,
      [
        familyIds[0]!,
        explicitCustom.id,
        memberIds.get("viewer")!,
        familyIds[0]!,
        explicitFamily.id,
        memberIds.get("viewer")!,
      ],
    );

    const listed = await repository.listAlbums({
      actor: actors.get("viewer")!,
      familyId: familyIds[0]!,
      limit: 100,
    });
    expect(
      listed.find((album) => album.id === explicitCustom.id),
    ).toMatchObject({
      effectivePermissions: {
        canView: true,
        canUpload: false,
        canEdit: false,
        canDelete: false,
        canManageMembers: false,
      },
    });
    expect(
      listed.find((album) => album.id === explicitFamily.id),
    ).toMatchObject({
      effectivePermissions: {
        canView: true,
        canUpload: false,
        canEdit: true,
        canDelete: false,
        canManageMembers: false,
      },
    });
    expect(listed.some((album) => album.id === customId)).toBe(false);
    expect(
      listed.find((album) => album.id === familyVisibleId)
        ?.effectivePermissions,
    ).toEqual({
      canView: true,
      canUpload: false,
      canEdit: false,
      canDelete: false,
      canManageMembers: false,
    });
  });

  it("keeps keyset pages complete across interleaved hidden albums", async () => {
    const first = await repository.createAlbum({
      actor: actors.get("owner")!,
      familyId: familyIds[0]!,
      name: "Page visible family",
      description: null,
      visibility: "FAMILY",
    });
    await repository.createAlbum({
      actor: actors.get("owner")!,
      familyId: familyIds[0]!,
      name: "Page hidden custom",
      description: null,
      visibility: "CUSTOM",
    });
    const third = await repository.createAlbum({
      actor: actors.get("owner")!,
      familyId: familyIds[0]!,
      name: "Page visible explicit custom",
      description: null,
      visibility: "CUSTOM",
    });
    await database.pool.query(
      `INSERT INTO album_members
        (family_id, album_id, member_id, can_view)
       VALUES (?, ?, ?, 1)`,
      [familyIds[0]!, third.id, memberIds.get("viewer")!],
    );

    const pageOne = await repository.listAlbums({
      actor: actors.get("viewer")!,
      familyId: familyIds[0]!,
      afterId: (BigInt(first.id) - 1n).toString(),
      limit: 1,
    });
    const pageTwo = await repository.listAlbums({
      actor: actors.get("viewer")!,
      familyId: familyIds[0]!,
      afterId: pageOne.at(-1)!.id,
      limit: 1,
    });
    const pageThree = await repository.listAlbums({
      actor: actors.get("viewer")!,
      familyId: familyIds[0]!,
      afterId: pageTwo.at(-1)!.id,
      limit: 1,
    });

    expect(pageOne.map((album) => album.id)).toEqual([first.id]);
    expect(pageTwo.map((album) => album.id)).toEqual([third.id]);
    expect(pageThree).toEqual([]);
    expect(
      new Set([...pageOne, ...pageTwo].map((album) => album.id)).size,
    ).toBe(2);
  });

  it("uses non-disclosure across families and for deleted albums", async () => {
    await expect(
      repository.getAlbum({ actor: actors.get("other")!, albumId: customId }),
    ).rejects.toBeInstanceOf(AlbumRepositoryError);
    await expect(
      repository.getAlbum({ actor: actors.get("other")!, albumId: customId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });

    const deleted = await repository.createAlbum({
      actor: actors.get("owner")!,
      familyId: familyIds[0]!,
      name: "To delete",
      description: null,
      visibility: "FAMILY",
    });
    await repository.softDeleteAlbum({
      actor: actors.get("owner")!,
      albumId: deleted.id,
      expectedRevision: "1",
    });
    await expect(
      repository.getAlbum({ actor: actors.get("owner")!, albumId: deleted.id }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      repository.softDeleteAlbum({
        actor: actors.get("owner")!,
        albumId: deleted.id,
        expectedRevision: "2",
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    const [stored] = await database.pool.query<RowDataPacket[]>(
      "SELECT deleted_at AS deletedAt FROM albums WHERE id = ?",
      [deleted.id],
    );
    expect(stored[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("checks permission before revision and advances revision atomically", async () => {
    await expect(
      repository.updateAlbum({
        actor: actors.get("super")!,
        albumId: familyVisibleId,
        expectedRevision: "999",
        name: "Forbidden",
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });

    const updated = await repository.updateAlbum({
      actor: actors.get("owner")!,
      albumId: familyVisibleId,
      expectedRevision: "1",
      name: "Updated",
    });
    expect(updated.revision).toBe("2");
    await expect(
      repository.updateAlbum({
        actor: actors.get("owner")!,
        albumId: familyVisibleId,
        expectedRevision: "1",
        name: "Stale",
      }),
    ).rejects.toMatchObject({ reason: "CONFLICT" });

    await expect(
      repository.updateAlbum({
        actor: actors.get("editor")!,
        albumId: customId,
        expectedRevision: "1",
        visibility: "FAMILY",
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
  });

  it("allows only one concurrent update with the same revision", async () => {
    const album = await repository.createAlbum({
      actor: actors.get("owner")!,
      familyId: familyIds[0]!,
      name: "Concurrent",
      description: null,
      visibility: "CUSTOM",
    });
    const results = await Promise.allSettled([
      repository.updateAlbum({
        actor: actors.get("owner")!,
        albumId: album.id,
        expectedRevision: "1",
        name: "Winner A",
      }),
      repository.updateAlbum({
        actor: actors.get("owner")!,
        albumId: album.id,
        expectedRevision: "1",
        name: "Winner B",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { reason: "CONFLICT" },
    });
    const current = await repository.getAlbum({
      actor: actors.get("owner")!,
      albumId: album.id,
    });
    expect(current.revision).toBe("2");
    expect(["Winner A", "Winner B"]).toContain(current.name);
  });

  it("keeps BIGINT identifiers and revisions as exact decimal strings", async () => {
    const album = await repository.getAlbum({
      actor: actors.get("owner")!,
      albumId: customId,
    });
    expect(album.id).toMatch(/^\d+$/);
    expect(album.familyId).toMatch(/^\d+$/);
    expect(album.ownerMemberId).toMatch(/^\d+$/);
    expect(album.revision).toMatch(/^\d+$/);
  });

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
        [`Phase 2A ${label} ${suffix}`],
      );
      const familyId = String(family.insertId);
      familyIds.push(familyId);
      for (const [name, role] of memberships) {
        const username = `phase2a_${name}_${suffix}`;
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
        const [member] = await connection.query<ResultSetHeader>(
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
