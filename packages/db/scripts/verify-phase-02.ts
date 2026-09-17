import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";
import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import { validateDatabaseHealth } from "../src/health.js";

interface IdentityRow extends RowDataPacket {
  databaseName: string | null;
  currentUser: string;
  version: string;
}

interface TableRow extends RowDataPacket {
  tableName: string;
  engine: string;
  collation: string;
}

interface NameRow extends RowDataPacket {
  name: string;
}

interface IndexRow extends NameRow {
  tableName: string;
}

interface IdRow extends RowDataPacket {
  id: string;
}

interface RevisionRow extends RowDataPacket {
  revision: string;
}

interface CountRow extends RowDataPacket {
  count: string;
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootEnvFile = resolve(packageDirectory, "../..", ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "mysql:" ||
  parsedDatabaseUrl.pathname !== "/family_album_dev"
) {
  throw new Error("Phase 2 verifier is restricted to family_album_dev");
}
if (decodeURIComponent(parsedDatabaseUrl.username).toLowerCase() === "root") {
  throw new Error("Phase 2 verifier refuses the MySQL root account");
}

const migration = readFileSync(
  resolve(packageDirectory, "drizzle/0001_phase_02_albums_permissions.sql"),
);
const expectedMigrationHash = createHash("sha256")
  .update(migration)
  .digest("hex");
const expectedIndexes = [
  "album_members.idx_album_members_family_album",
  "album_members.idx_album_members_family_member",
  "album_members.PRIMARY",
  "album_members.uq_album_members_album_member",
  "albums.idx_albums_family_deleted_id",
  "albums.idx_albums_family_owner",
  "albums.PRIMARY",
  "albums.uq_albums_family_id",
];
const expectedForeignKeys = [
  "fk_album_members_album",
  "fk_album_members_member",
  "fk_albums_family",
  "fk_albums_owner_member",
];
const expectedChecks = [
  "chk_album_members_delete_boolean",
  "chk_album_members_edit_boolean",
  "chk_album_members_manage_members_boolean",
  "chk_album_members_upload_boolean",
  "chk_album_members_view_boolean",
  "chk_album_members_view_required",
  "chk_albums_deleted_at",
  "chk_albums_revision",
];

const pool = mysql.createPool({
  uri: databaseUrl,
  connectionLimit: 2,
  multipleStatements: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  timezone: "Z",
});

try {
  const connection = await pool.getConnection();
  try {
    const health = await validateDatabaseHealth(connection);
    const [[identity]] = await connection.query<IdentityRow[]>(
      "SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser, VERSION() AS version",
    );
    if (!identity) throw new Error("Database identity query returned no row");
    if (
      identity.databaseName !== "family_album_dev" ||
      identity.version !== "9.7.2" ||
      identity.currentUser.split("@", 1)[0]?.toLowerCase() === "root"
    ) {
      throw new Error("Database identity changed after Phase 2 migration");
    }

    const [tables] = await connection.query<TableRow[]>(
      `SELECT TABLE_NAME AS tableName, ENGINE AS engine,
              TABLE_COLLATION AS collation
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND TABLE_NAME IN ('albums','album_members')
        ORDER BY TABLE_NAME`,
    );
    if (
      tables.map((row) => row.tableName).join() !== "album_members,albums" ||
      tables.some(
        (row) =>
          row.engine !== "InnoDB" || !row.collation.startsWith("utf8mb4_"),
      )
    ) {
      throw new Error("Phase 2 table engine or charset verification failed");
    }

    const [indexRows] = await connection.query<IndexRow[]>(
      `SELECT DISTINCT TABLE_NAME AS tableName, INDEX_NAME AS name
         FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND TABLE_NAME IN ('albums','album_members')
        ORDER BY TABLE_NAME, INDEX_NAME`,
    );
    const indexes = indexRows.map((row) => `${row.tableName}.${row.name}`);
    if (indexes.join() !== expectedIndexes.join()) {
      throw new Error("Phase 2 index manifest mismatch");
    }

    const [foreignKeyRows] = await connection.query<NameRow[]>(
      `SELECT CONSTRAINT_NAME AS name
         FROM information_schema.referential_constraints
        WHERE constraint_schema = DATABASE()
          AND TABLE_NAME IN ('albums','album_members')
        ORDER BY CONSTRAINT_NAME`,
    );
    const foreignKeys = foreignKeyRows.map((row) => row.name);
    if (foreignKeys.join() !== expectedForeignKeys.join()) {
      throw new Error("Phase 2 foreign-key manifest mismatch");
    }

    const [checkRows] = await connection.query<NameRow[]>(
      `SELECT tc.CONSTRAINT_NAME AS name
         FROM information_schema.table_constraints tc
        WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
          AND tc.TABLE_NAME IN ('albums','album_members')
          AND tc.CONSTRAINT_TYPE = 'CHECK'
        ORDER BY tc.CONSTRAINT_NAME`,
    );
    const checks = checkRows.map((row) => row.name);
    if (checks.join() !== expectedChecks.join()) {
      throw new Error("Phase 2 CHECK manifest mismatch");
    }

    const [journalRows] = await connection.query<
      (RowDataPacket & { count: string; latestHash: string | null })[]
    >(
      `SELECT CAST(COUNT(*) AS CHAR) AS count,
              (SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1) AS latestHash
         FROM __drizzle_migrations`,
    );
    if (
      journalRows[0]?.count !== "2" ||
      journalRows[0]?.latestHash !== expectedMigrationHash
    ) {
      throw new Error("Phase 2 migration journal hash mismatch");
    }

    const [albumCreate] = await connection.query<RowDataPacket[]>(
      "SHOW CREATE TABLE `albums`",
    );
    const [albumMemberCreate] = await connection.query<RowDataPacket[]>(
      "SHOW CREATE TABLE `album_members`",
    );
    const albumDdl = String(albumCreate[0]?.["Create Table"] ?? "");
    const memberDdl = String(albumMemberCreate[0]?.["Create Table"] ?? "");
    for (const required of [
      "`revision` bigint unsigned NOT NULL DEFAULT '1'",
      "`visibility` enum('FAMILY','CUSTOM')",
      "`deleted_at` datetime(3)",
      "ENGINE=InnoDB",
      "CHARSET=utf8mb4",
    ]) {
      if (!albumDdl.includes(required)) {
        throw new Error(`albums SHOW CREATE is missing ${required}`);
      }
    }
    if (
      !memberDdl.includes("ENGINE=InnoDB") ||
      !memberDdl.includes("CHARSET=utf8mb4")
    ) {
      throw new Error("album_members SHOW CREATE engine/charset mismatch");
    }

    const suffix = randomUUID().replaceAll("-", "");
    const usernames = [`p2_verify_a_${suffix}`, `p2_verify_b_${suffix}`];
    const familyNames = [
      `Phase 2 verification A ${suffix}`,
      `Phase 2 verification B ${suffix}`,
    ];
    let transactionStarted = false;
    let familyA = "";
    let familyB = "";
    let userA = "";
    let userB = "";
    let memberA = "";
    let memberB = "";
    let albumA = "";
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      familyA = await insertAndReadId(
        connection,
        "INSERT INTO families (name) VALUES (?)",
        [familyNames[0]],
      );
      familyB = await insertAndReadId(
        connection,
        "INSERT INTO families (name) VALUES (?)",
        [familyNames[1]],
      );
      userA = await insertAndReadId(
        connection,
        `INSERT INTO users
          (username, username_normalized, password_hash, password_changed_at)
         VALUES (?, ?, 'synthetic-verification-placeholder', CURRENT_TIMESTAMP(3))`,
        [usernames[0], Buffer.from(usernames[0]!)],
      );
      userB = await insertAndReadId(
        connection,
        `INSERT INTO users
          (username, username_normalized, password_hash, password_changed_at)
         VALUES (?, ?, 'synthetic-verification-placeholder', CURRENT_TIMESTAMP(3))`,
        [usernames[1], Buffer.from(usernames[1]!)],
      );
      memberA = await insertAndReadId(
        connection,
        "INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'MEMBER')",
        [familyA, userA],
      );
      memberB = await insertAndReadId(
        connection,
        "INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'MEMBER')",
        [familyB, userB],
      );
      albumA = await insertAndReadId(
        connection,
        "INSERT INTO albums (family_id, owner_member_id, name) VALUES (?, ?, 'Synthetic album')",
        [familyA, memberA],
      );

      await expectMySqlRejection(
        () =>
          connection.query(
            "INSERT INTO albums (family_id, owner_member_id, name) VALUES (?, ?, 'Cross-family owner')",
            [familyA, memberB],
          ),
        1452,
        "fk_albums_owner_member",
      );
      await expectMySqlRejection(
        () =>
          connection.query(
            "UPDATE albums SET owner_member_id = ? WHERE id = ?",
            [memberB, albumA],
          ),
        1452,
        "fk_albums_owner_member",
      );
      await expectMySqlRejection(
        () =>
          connection.query(
            "INSERT INTO album_members (family_id, album_id, member_id, can_view) VALUES (?, ?, ?, 1)",
            [familyA, albumA, memberB],
          ),
        1452,
        "fk_album_members_member",
      );
      await expectMySqlRejection(
        () =>
          connection.query(
            "INSERT INTO album_members (family_id, album_id, member_id, can_view) VALUES (?, ?, ?, 1)",
            [familyB, albumA, memberB],
          ),
        1452,
        "fk_album_members_album",
      );
      await expectMySqlRejection(
        () =>
          connection.query(
            "INSERT INTO albums (family_id, owner_member_id, name, revision) VALUES (?, ?, 'Invalid revision', 0)",
            [familyA, memberA],
          ),
        3819,
        "chk_albums_revision",
      );
      await expectMySqlRejection(
        () =>
          connection.query(
            "INSERT INTO album_members (family_id, album_id, member_id, can_view) VALUES (?, ?, ?, 2)",
            [familyA, albumA, memberA],
          ),
        3819,
        "chk_album_members_view_boolean",
      );
      for (const [column, constraint] of [
        ["can_upload", "chk_album_members_view_required"],
        ["can_edit", "chk_album_members_view_required"],
        ["can_delete", "chk_album_members_view_required"],
        ["can_manage_members", "chk_album_members_view_required"],
      ] as const) {
        await expectMySqlRejection(
          () =>
            connection.query(
              `INSERT INTO album_members (family_id, album_id, member_id, can_view, ${column}) VALUES (?, ?, ?, 0, 1)`,
              [familyA, albumA, memberA],
            ),
          3819,
          constraint,
        );
      }

      const [defaultRows] = await connection.query<RevisionRow[]>(
        "SELECT CAST(revision AS CHAR) AS revision FROM albums WHERE id = ?",
        [albumA],
      );
      if (defaultRows[0]?.revision !== "1") {
        throw new Error("Album revision default is not 1");
      }
      const [incremented] = await connection.query<ResultSetHeader>(
        "UPDATE albums SET revision = revision + 1 WHERE id = ? AND revision = ?",
        [albumA, "1"],
      );
      const [stale] = await connection.query<ResultSetHeader>(
        "UPDATE albums SET revision = revision + 1 WHERE id = ? AND revision = ?",
        [albumA, "1"],
      );
      const [revisedRows] = await connection.query<RevisionRow[]>(
        "SELECT CAST(revision AS CHAR) AS revision FROM albums WHERE id = ?",
        [albumA],
      );
      if (
        incremented.affectedRows !== 1 ||
        stale.affectedRows !== 0 ||
        revisedRows[0]?.revision !== "2"
      ) {
        throw new Error("Conditional revision update semantics failed");
      }
      await expectMySqlRejection(
        () =>
          connection.query(
            "UPDATE albums SET deleted_at = DATE_SUB(created_at, INTERVAL 1 SECOND) WHERE id = ?",
            [albumA],
          ),
        3819,
        "chk_albums_deleted_at",
      );

      await connection.rollback();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await connection.rollback();
      throw error;
    }

    const syntheticRowsRemaining = await countSyntheticRows(connection, {
      albumA,
      familyA,
      familyB,
      memberA,
      memberB,
      userA,
      userB,
    });
    if (syntheticRowsRemaining !== "0") {
      throw new Error("Synthetic Phase 2 verification rows remain");
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          status: "PHASE_2_LIVE_VERIFICATION_PASS",
          database: identity.databaseName,
          mysqlVersion: identity.version,
          currentUser: identity.currentUser,
          ...health,
          tables: tables.map((row) => row.tableName),
          indexes,
          foreignKeys,
          checks,
          ownerFamilyFkRuntime: "PASS (INSERT + UPDATE rejected with 1452)",
          albumMemberFamilyFkRuntime:
            "PASS (member and album boundary rejected with 1452)",
          aclPrerequisiteRuntime: "PASS",
          invalidBooleanRuntime: "PASS",
          revision: "PASS (default 1, conditional 1 -> 2, stale update 0 rows)",
          softDeleteCheck: "PASS",
          syntheticRowsRemaining,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    connection.release();
  }
} finally {
  await pool.end();
}

async function insertAndReadId(
  connection: PoolConnection,
  sql: string,
  values: unknown[],
) {
  await connection.query(sql, values);
  const [rows] = await connection.query<IdRow[]>(
    "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id",
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Synthetic insert ID is unavailable");
  return id;
}

async function expectMySqlRejection(
  operation: () => Promise<unknown>,
  expectedErrno: number,
  expectedConstraint: string,
) {
  try {
    await operation();
  } catch (error) {
    const mysqlError = error as { errno?: number; sqlMessage?: string };
    if (
      mysqlError.errno === expectedErrno &&
      mysqlError.sqlMessage?.includes(expectedConstraint)
    ) {
      return;
    }
    throw new Error(
      `Expected MySQL ${expectedErrno} for ${expectedConstraint}, received a different error`,
      { cause: error },
    );
  }
  throw new Error(
    `Expected MySQL ${expectedErrno} for ${expectedConstraint}, but the write succeeded`,
  );
}

async function countSyntheticRows(
  connection: PoolConnection,
  ids: Record<string, string>,
) {
  const [rows] = await connection.query<CountRow[]>(
    `SELECT CAST(
       (SELECT COUNT(*) FROM albums WHERE id = ?) +
       (SELECT COUNT(*) FROM album_members
         WHERE album_id = ? OR family_id IN (?, ?) OR member_id IN (?, ?)) +
       (SELECT COUNT(*) FROM family_members WHERE id IN (?, ?)) +
       (SELECT COUNT(*) FROM users WHERE id IN (?, ?)) +
       (SELECT COUNT(*) FROM families WHERE id IN (?, ?))
       AS CHAR) AS count`,
    [
      ids.albumA,
      ids.albumA,
      ids.familyA,
      ids.familyB,
      ids.memberA,
      ids.memberB,
      ids.memberA,
      ids.memberB,
      ids.userA,
      ids.userB,
      ids.familyA,
      ids.familyB,
    ],
  );
  return rows[0]?.count ?? "unknown";
}
