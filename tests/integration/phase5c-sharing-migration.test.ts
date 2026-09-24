import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertMigrationReadiness,
  createDatabase,
} from "../../packages/db/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE5C_DEV_DATABASE_URL_REQUIRED");

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sharingSql = readFileSync(
  new URL(
    "../../packages/db/drizzle/0005_phase_05c_sharing.sql",
    import.meta.url,
  ),
);
const sharingHash = createHash("sha256").update(sharingSql).digest("hex");

type Queryable = {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<[ResultSetHeader | RowDataPacket[], unknown]>;
};

function errno(error: unknown): number | undefined {
  if (error && typeof error === "object" && "errno" in error) {
    return Number((error as { errno: number }).errno);
  }
  return undefined;
}

describe.sequential("Phase 5C sharing migration", () => {
  const dev = createDatabase(databaseUrl!);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const createdAt = "2026-01-01 00:00:00.000";
  const expiresAt = "2026-01-08 00:00:00.000";

  beforeAll(async () => {
    const connection = await dev.pool.getConnection();
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
        throw new Error("PHASE5C_DEV_PREFLIGHT_FAILED");
      }
      const before = await protectedCounts(connection);
      execFileSync("pnpm", ["--filter", "@family-album/db", "db:migrate"], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      expect(await protectedCounts(connection)).toEqual(before);
      expect(await sharingCounts(connection)).toEqual({ shares: 0, events: 0 });
      await connection.query("DROP TABLE `share_events`");
      await connection.query("DROP TABLE `shares`");
      const [removed] = await connection.query<ResultSetHeader>(
        "DELETE FROM `__drizzle_migrations` WHERE hash = ?",
        [sharingHash],
      );
      expect(removed.affectedRows).toBe(1);
      execFileSync("pnpm", ["--filter", "@family-album/db", "db:migrate"], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      expect(await protectedCounts(connection)).toEqual(before);
      expect(await sharingCounts(connection)).toEqual({ shares: 0, events: 0 });
      const readiness = await assertMigrationReadiness(connection);
      expect(readiness.migrationCount).toBe(6);
    } finally {
      connection.release();
    }
  }, 60_000);

  afterAll(async () => {
    try {
      execFileSync("pnpm", ["--filter", "@family-album/db", "db:migrate"], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    } finally {
      await dev.pool.end();
    }
  });

  it("rejects a repeated token hash and a cross-family album or member", async () => {
    const pool = dev.pool;
    const fixture = await createFixture(
      pool,
      `${suffix}${pool === dev.pool ? "d" : "f"}`,
    );
    const hash = randomBytes(32);
    await insertShare(pool, fixture, hash);
    await expect(insertShare(pool, fixture, hash)).rejects.toSatisfy(
      (error: unknown) => errno(error) === 1062,
    );
    await expect(
      pool.query(
        `INSERT INTO shares
            (family_id, album_id, token_hash, created_by_member_id, created_at, expires_at)
           VALUES (?,?,?,?,?,?)`,
        [
          fixture.familyId,
          fixture.otherAlbumId,
          randomBytes(32),
          fixture.memberId,
          createdAt,
          expiresAt,
        ],
      ),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 1452);
    await expect(
      pool.query(
        `INSERT INTO shares
            (family_id, album_id, token_hash, created_by_member_id, created_at, expires_at)
           VALUES (?,?,?,?,?,?)`,
        [
          fixture.familyId,
          fixture.albumId,
          randomBytes(32),
          fixture.otherMemberId,
          createdAt,
          expiresAt,
        ],
      ),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 1452);
    await cleanup(pool, fixture);
  });

  it("rejects expiry and revoke pairs that break the share checks", async () => {
    const pool = dev.pool;
    const fixture = await createFixture(
      pool,
      `${suffix}${pool === dev.pool ? "e" : "g"}`,
    );
    await expect(
      pool.query(
        `INSERT INTO shares
            (family_id, album_id, token_hash, created_by_member_id, created_at, expires_at)
           VALUES (?,?,?,?,?,?)`,
        [
          fixture.familyId,
          fixture.albumId,
          randomBytes(32),
          fixture.memberId,
          createdAt,
          createdAt,
        ],
      ),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 3819);
    const shareId = await insertShare(pool, fixture, randomBytes(32));
    await expect(
      pool.query(`UPDATE shares SET revoked_at = ? WHERE id = ?`, [
        expiresAt,
        shareId,
      ]),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 3819);
    const [revoked] = await pool.query<ResultSetHeader>(
      `UPDATE shares
            SET revoked_at = ?, revoked_by_member_id = ?
          WHERE id = ?`,
      [expiresAt, fixture.memberId, shareId],
    );
    expect(revoked.affectedRows).toBe(1);
    await cleanup(pool, fixture);
  });

  it("requires an actor for create and revoke, and none for access", async () => {
    const pool = dev.pool;
    const fixture = await createFixture(
      pool,
      `${suffix}${pool === dev.pool ? "h" : "i"}`,
    );
    const shareId = await insertShare(pool, fixture, randomBytes(32));
    await expect(
      insertEvent(pool, fixture.familyId, shareId, "CREATE", null),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 3819);
    await expect(
      insertEvent(pool, fixture.familyId, shareId, "ACCESS", fixture.memberId),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 3819);
    await expect(
      insertEvent(pool, fixture.familyId, shareId, "REVOKE", null),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 3819);
    await insertEvent(
      pool,
      fixture.familyId,
      shareId,
      "CREATE",
      fixture.memberId,
    );
    await insertEvent(pool, fixture.familyId, shareId, "ACCESS", null);
    await insertEvent(
      pool,
      fixture.familyId,
      shareId,
      "REVOKE",
      fixture.memberId,
    );
    await expect(
      insertEvent(
        pool,
        fixture.familyId,
        shareId,
        "ACCESS",
        fixture.otherMemberId,
      ),
    ).rejects.toSatisfy(
      (error: unknown) => errno(error) === 3819 || errno(error) === 1452,
    );
    await cleanup(pool, fixture);
  });

  it("refuses to delete a family, album, member, or share that is still referenced", async () => {
    const pool = dev.pool;
    const fixture = await createFixture(
      pool,
      `${suffix}${pool === dev.pool ? "j" : "k"}`,
    );
    const shareId = await insertShare(pool, fixture, randomBytes(32));
    await insertEvent(
      pool,
      fixture.familyId,
      shareId,
      "CREATE",
      fixture.memberId,
    );
    await expect(
      pool.query(`DELETE FROM albums WHERE id = ?`, [fixture.albumId]),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 1451);
    await expect(
      pool.query(`DELETE FROM family_members WHERE id = ?`, [fixture.memberId]),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 1451);
    await expect(
      pool.query(`DELETE FROM families WHERE id = ?`, [fixture.familyId]),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 1451);
    await expect(
      pool.query(`DELETE FROM shares WHERE id = ?`, [shareId]),
    ).rejects.toSatisfy((error: unknown) => errno(error) === 1451);
    const [remaining] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS shares FROM shares WHERE id = ?`,
      [shareId],
    );
    expect(Number(remaining[0]?.shares)).toBe(1);
    await cleanup(pool, fixture);
  });

  async function insertShare(
    pool: Pool,
    fixture: Fixture,
    hash: Buffer,
  ): Promise<string> {
    const [inserted] = await pool.query<ResultSetHeader>(
      `INSERT INTO shares
        (family_id, album_id, token_hash, created_by_member_id, created_at, expires_at)
       VALUES (?,?,?,?,?,?)`,
      [
        fixture.familyId,
        fixture.albumId,
        hash,
        fixture.memberId,
        createdAt,
        expiresAt,
      ],
    );
    return String(inserted.insertId);
  }
});

type Fixture = {
  familyId: string;
  memberId: string;
  albumId: string;
  otherFamilyId: string;
  otherMemberId: string;
  otherAlbumId: string;
  usernames: Buffer[];
};

async function sharingCounts(connection: Queryable) {
  const [rows] = await connection.query(
    `SELECT
       (SELECT COUNT(*) FROM shares) AS shares,
       (SELECT COUNT(*) FROM share_events) AS events`,
  );
  const row = (rows as RowDataPacket[])[0];
  return {
    shares: Number(row?.shares),
    events: Number(row?.events),
  };
}

async function protectedCounts(connection: Queryable) {
  const [rows] = await connection.query(
    `SELECT
       (SELECT COUNT(*) FROM albums) AS albums,
       (SELECT COUNT(*) FROM album_media) AS albumMedia,
       (SELECT COUNT(*) FROM media_items) AS mediaItems,
       (SELECT COUNT(*) FROM derived_assets) AS derivedAssets`,
  );
  const row = (rows as RowDataPacket[])[0];
  return {
    albums: String(row?.albums),
    albumMedia: String(row?.albumMedia),
    mediaItems: String(row?.mediaItems),
    derivedAssets: String(row?.derivedAssets),
  };
}

async function createFixture(pool: Pool, suffix: string): Promise<Fixture> {
  const familyId = await insertId(
    pool,
    "INSERT INTO families (name) VALUES (?)",
    [`Share ${suffix}`],
  );
  const otherFamilyId = await insertId(
    pool,
    "INSERT INTO families (name) VALUES (?)",
    [`Other ${suffix}`],
  );
  const memberId = await createMember(pool, familyId, `s_${suffix}`);
  const otherMemberId = await createMember(pool, otherFamilyId, `o_${suffix}`);
  return {
    familyId,
    memberId,
    albumId: await createAlbum(pool, familyId, memberId),
    otherFamilyId,
    otherMemberId,
    otherAlbumId: await createAlbum(pool, otherFamilyId, otherMemberId),
    usernames: [Buffer.from(`s_${suffix}`), Buffer.from(`o_${suffix}`)],
  };
}

async function createMember(pool: Pool, familyId: string, username: string) {
  const userId = await insertId(
    pool,
    `INSERT INTO users
      (username, username_normalized, password_hash, display_name, password_changed_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
    [
      username,
      Buffer.from(username),
      "synthetic-not-used",
      "Sharing migration",
    ],
  );
  return insertId(
    pool,
    "INSERT INTO family_members (family_id, user_id, role) VALUES (?,?,'MEMBER')",
    [familyId, userId],
  );
}

async function createAlbum(
  pool: Pool,
  familyId: string,
  ownerMemberId: string,
) {
  return insertId(
    pool,
    `INSERT INTO albums (family_id, owner_member_id, name, visibility)
     VALUES (?,?,?,'FAMILY')`,
    [familyId, ownerMemberId, "Synthetic share album"],
  );
}

async function insertEvent(
  pool: Pool,
  familyId: string,
  shareId: string,
  eventType: "CREATE" | "ACCESS" | "REVOKE",
  actorMemberId: string | null,
) {
  await pool.query(
    `INSERT INTO share_events (family_id, share_id, event_type, actor_member_id)
     VALUES (?,?,?,?)`,
    [familyId, shareId, eventType, actorMemberId],
  );
}

async function insertId(pool: Pool, sql: string, values: unknown[]) {
  const [inserted] = await pool.query<ResultSetHeader>(sql, values);
  return String(inserted.insertId);
}

async function cleanup(pool: Pool, fixture: Fixture) {
  const families = [fixture.familyId, fixture.otherFamilyId];
  await pool.query(`DELETE FROM share_events WHERE family_id IN (?)`, [
    families,
  ]);
  await pool.query(`DELETE FROM shares WHERE family_id IN (?)`, [families]);
  await pool.query(`DELETE FROM albums WHERE family_id IN (?)`, [families]);
  await pool.query(`DELETE FROM family_members WHERE family_id IN (?)`, [
    families,
  ]);
  await pool.query(`DELETE FROM users WHERE username_normalized IN (?)`, [
    fixture.usernames,
  ]);
  await pool.query(`DELETE FROM families WHERE id IN (?)`, [families]);
}
