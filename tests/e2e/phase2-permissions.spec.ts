import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";

import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
} from "../../packages/auth/src/index.js";
import { createDatabase } from "../../packages/db/src/index.js";

process.loadEnvFile(resolve(process.cwd(), ".env"));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Phase 2 E2E.");

test.describe("Phase 2 album permission E2E", () => {
  const database = createDatabase(databaseUrl);
  const suffix = randomUUID().replaceAll("-", "");
  const tokens = new Map<string, string>();
  const userIds: string[] = [];
  let familyId = "";
  let albumId = "";

  test.beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      const [environment] = await connection.query<RowDataPacket[]>(
        `SELECT DATABASE() AS databaseName, VERSION() AS mysqlVersion,
                CURRENT_USER() AS currentUser,
                @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
                @@SESSION.foreign_key_checks AS foreignKeyChecks`,
      );
      const current = environment[0];
      expect(current?.databaseName).toBe("family_album_dev");
      expect(String(current?.mysqlVersion)).toMatch(/^9\.7\.2/);
      expect(String(current?.currentUser).toLowerCase()).not.toMatch(/^root@/);
      expect(String(current?.nativeFk)).toBe("1");
      expect(String(current?.foreignKeyChecks)).toBe("1");

      const passwordHash = await hashPassword("phase2-e2e-synthetic-password");
      await connection.beginTransaction();
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 2 E2E ${suffix}`],
      );
      familyId = String(family.insertId);

      const memberIds = new Map<string, string>();
      for (const [name, role] of [
        ["owner", "MEMBER"],
        ["viewer", "MEMBER"],
        ["unauthorized", "MEMBER"],
        ["super", "SUPER_ADMIN"],
      ] as const) {
        const username = `phase2_e2e_${name}_${suffix}`;
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
        userIds.push(userId);
        const [member] = await connection.query<ResultSetHeader>(
          "INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, ?)",
          [familyId, userId, role],
        );
        memberIds.set(name, String(member.insertId));
        const token = createSessionToken();
        tokens.set(name, token);
        await connection.query(
          `INSERT INTO sessions
            (user_id, token_hash, client_type, authenticated_at, last_seen_at,
             expires_at)
           VALUES (?, ?, 'WEB', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
                   DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY))`,
          [userId, hashSessionToken(token)],
        );
      }

      const [album] = await connection.query<ResultSetHeader>(
        `INSERT INTO albums
          (family_id, owner_member_id, name, visibility, revision)
         VALUES (?, ?, ?, 'CUSTOM', 1)`,
        [familyId, memberIds.get("owner")!, `Phase 2 E2E album ${suffix}`],
      );
      albumId = String(album.insertId);
      await connection.query(
        `INSERT INTO album_members
          (family_id, album_id, member_id, can_view)
         VALUES (?, ?, ?, 1)`,
        [familyId, albumId, memberIds.get("viewer")!],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });

  test.afterAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      if (familyId) {
        await connection.beginTransaction();
        await connection.query(
          "DELETE FROM album_members WHERE family_id = ?",
          [familyId],
        );
        await connection.query("DELETE FROM albums WHERE family_id = ?", [
          familyId,
        ]);
        if (userIds.length > 0) {
          await connection.query("DELETE FROM sessions WHERE user_id IN (?)", [
            userIds,
          ]);
        }
        await connection.query(
          "DELETE FROM family_members WHERE family_id = ?",
          [familyId],
        );
        if (userIds.length > 0) {
          await connection.query("DELETE FROM users WHERE id IN (?)", [
            userIds,
          ]);
        }
        await connection.query("DELETE FROM families WHERE id = ?", [familyId]);
        await connection.commit();
      }
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await database.pool.end();
    }
  });

  for (const [name, expectedStatus] of [
    ["owner", 200],
    ["viewer", 200],
    ["unauthorized", 404],
    ["super", 404],
  ] as const) {
    test(`${name} receives ${expectedStatus} for the CUSTOM album`, async ({
      request,
    }) => {
      const response = await request.get(`/api/v1/albums/${albumId}`, {
        headers: {
          cookie: `__Host-family_session=${tokens.get(name)!}`,
        },
      });
      expect(response.status()).toBe(expectedStatus);
      if (expectedStatus === 200) {
        expect(await response.json()).toMatchObject({ id: albumId });
      } else {
        expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
      }
    });
  }
});
