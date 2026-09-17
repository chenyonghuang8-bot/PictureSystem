import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import { validateDatabaseHealth } from "../src/health.js";

interface IdentityRow extends RowDataPacket {
  databaseName: string | null;
  currentUser: string;
}

interface NameRow extends RowDataPacket {
  name: string;
}

interface CreateTableRow extends RowDataPacket {
  Table: string;
  "Create Table": string;
}

interface LargeIdRow extends RowDataPacket {
  largeId: string;
}

interface BinaryRow extends RowDataPacket {
  value: Buffer;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const rootEnvFile = resolve(scriptDirectory, "../../..", ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvFile))
  process.loadEnvFile(rootEnvFile);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "mysql:" ||
  parsedDatabaseUrl.pathname !== "/family_album_dev"
) {
  throw new Error("Verification is restricted to family_album_dev");
}
if (decodeURIComponent(parsedDatabaseUrl.username).toLowerCase() === "root") {
  throw new Error("Verification refuses to connect as MySQL root");
}

const connection = await mysql.createConnection({
  uri: databaseUrl,
  multipleStatements: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  timezone: "Z",
});

const expectedBusinessTables = [
  "families",
  "family_members",
  "invitations",
  "sessions",
  "users",
];
const expectedChecks = [
  "chk_invitations_expiry",
  "chk_invitations_revoker_requires_revoked_at",
  "chk_invitations_used_or_revoked",
  "chk_invitations_used_pair",
  "chk_sessions_expiry",
  "chk_sessions_last_seen",
  "chk_sessions_revoked_pair",
];

try {
  await validateDatabaseHealth(connection);
  const [[identity]] = await connection.query<IdentityRow[]>(
    "SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser",
  );
  if (!identity || identity.databaseName !== "family_album_dev") {
    throw new Error("Connected database identity changed after migration");
  }
  if (identity.currentUser.split("@", 1)[0]?.toLowerCase() === "root") {
    throw new Error("Connected database user is root");
  }

  const [tableRows] = await connection.query<NameRow[]>(
    `SELECT TABLE_NAME AS name
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
      ORDER BY TABLE_NAME`,
  );
  const tables = tableRows.map((row) => row.name);
  const unexpectedTables = tables.filter(
    (name) =>
      !expectedBusinessTables.includes(name) && name !== "__drizzle_migrations",
  );
  if (unexpectedTables.length > 0) {
    throw new Error(`Unexpected tables: ${unexpectedTables.join(", ")}`);
  }
  for (const table of expectedBusinessTables) {
    if (!tables.includes(table)) throw new Error(`Missing table: ${table}`);
  }

  const createStatements: Record<string, string> = {};
  for (const table of expectedBusinessTables) {
    const [rows] = await connection.query<CreateTableRow[]>(
      `SHOW CREATE TABLE \`${table}\``,
    );
    const createStatement = rows[0]?.["Create Table"];
    if (!createStatement)
      throw new Error(`SHOW CREATE TABLE failed for ${table}`);
    if (
      !/ENGINE=InnoDB/.test(createStatement) ||
      !/CHARSET=utf8mb4/.test(createStatement)
    ) {
      throw new Error(`${table} is not InnoDB/utf8mb4`);
    }
    createStatements[table] = createStatement;
  }

  const [indexRows] = await connection.query<NameRow[]>(
    `SELECT DISTINCT INDEX_NAME AS name
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name IN ('users','families','family_members','invitations','sessions')
        AND INDEX_NAME <> 'PRIMARY'
      ORDER BY INDEX_NAME`,
  );
  const [foreignKeyRows] = await connection.query<NameRow[]>(
    `SELECT CONSTRAINT_NAME AS name
       FROM information_schema.referential_constraints
      WHERE constraint_schema = DATABASE()
      ORDER BY CONSTRAINT_NAME`,
  );
  const [checkRows] = await connection.query<NameRow[]>(
    `SELECT tc.CONSTRAINT_NAME AS name
       FROM information_schema.table_constraints tc
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
        AND tc.CONSTRAINT_TYPE = 'CHECK'
        AND tc.TABLE_NAME IN ('users','families','family_members','invitations','sessions')
      ORDER BY tc.CONSTRAINT_NAME`,
  );
  const checks = checkRows.map((row) => row.name);
  if (checks.join() !== expectedChecks.join()) {
    throw new Error(`CHECK constraint mismatch: ${checks.join(", ")}`);
  }

  await connection.beginTransaction();
  try {
    const createdAt = "2026-01-01 00:00:00.000";
    const future = "2026-01-02 00:00:00.000";
    const past = "2025-12-31 23:59:59.999";
    const usernameBytes = Buffer.from("phase1a-verification", "utf8");
    const invitationHash = Buffer.alloc(32, 0xa1);

    await connection.execute(
      `INSERT INTO users
         (id, username, username_normalized, password_hash, password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "1",
        "Phase1A-Verification",
        usernameBytes,
        "synthetic-phc-placeholder",
        createdAt,
        createdAt,
        createdAt,
      ],
    );
    await connection.execute(
      "INSERT INTO families (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ["1", "Synthetic verification family", createdAt, createdAt],
    );
    await connection.execute(
      `INSERT INTO family_members
         (id, family_id, user_id, role, joined_at, updated_at)
       VALUES (?, ?, ?, 'SUPER_ADMIN', ?, ?)`,
      ["1", "1", "1", createdAt, createdAt],
    );
    await connection.execute(
      `INSERT INTO invitations
         (id, family_id, created_by_member_id, role, token_hash, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, 'MEMBER', ?, ?, ?, ?)`,
      ["1", "1", "1", invitationHash, future, createdAt, createdAt],
    );

    const [[usernameRoundTrip]] = await connection.query<BinaryRow[]>(
      "SELECT username_normalized AS value FROM users WHERE id = ?",
      ["1"],
    );
    const [[tokenRoundTrip]] = await connection.query<BinaryRow[]>(
      "SELECT token_hash AS value FROM invitations WHERE id = ?",
      ["1"],
    );
    if (
      !usernameRoundTrip ||
      !Buffer.from(usernameRoundTrip.value).equals(usernameBytes)
    ) {
      throw new Error("VARBINARY username round-trip failed");
    }
    if (
      !tokenRoundTrip ||
      !Buffer.from(tokenRoundTrip.value).equals(invitationHash)
    ) {
      throw new Error("BINARY token round-trip failed");
    }

    const [[largeId]] = await connection.query<LargeIdRow[]>(
      "SELECT CAST(9007199254740993 AS UNSIGNED) AS largeId",
    );
    if (
      !largeId ||
      typeof largeId.largeId !== "string" ||
      largeId.largeId !== "9007199254740993"
    ) {
      throw new Error("BIGINT was not returned as a precision-safe string");
    }

    await expectConstraint(
      connection,
      `INSERT INTO invitations
         (id, family_id, created_by_member_id, role, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, 'MEMBER', ?, ?, ?)`,
      ["10", "1", "1", Buffer.alloc(32, 0x10), createdAt, createdAt],
      "chk_invitations_expiry",
    );
    await expectConstraint(
      connection,
      `INSERT INTO invitations
         (id, family_id, created_by_member_id, role, token_hash, expires_at, used_at, created_at)
       VALUES (?, ?, ?, 'MEMBER', ?, ?, ?, ?)`,
      ["11", "1", "1", Buffer.alloc(32, 0x11), future, createdAt, createdAt],
      "chk_invitations_used_pair",
    );
    await expectConstraint(
      connection,
      `INSERT INTO invitations
         (id, family_id, created_by_member_id, role, token_hash, expires_at, used_at, used_by_member_id, revoked_at, created_at)
       VALUES (?, ?, ?, 'MEMBER', ?, ?, ?, ?, ?, ?)`,
      [
        "12",
        "1",
        "1",
        Buffer.alloc(32, 0x12),
        future,
        createdAt,
        "1",
        createdAt,
        createdAt,
      ],
      "chk_invitations_used_or_revoked",
    );
    await expectConstraint(
      connection,
      `INSERT INTO invitations
         (id, family_id, created_by_member_id, role, token_hash, expires_at, revoked_by_member_id, created_at)
       VALUES (?, ?, ?, 'MEMBER', ?, ?, ?, ?)`,
      ["13", "1", "1", Buffer.alloc(32, 0x13), future, "1", createdAt],
      "chk_invitations_revoker_requires_revoked_at",
    );
    await expectConstraint(
      connection,
      `INSERT INTO sessions
         (id, user_id, token_hash, client_type, authenticated_at, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, 'WEB', ?, ?, ?, ?)`,
      [
        "20",
        "1",
        Buffer.alloc(32, 0x20),
        createdAt,
        createdAt,
        createdAt,
        createdAt,
      ],
      "chk_sessions_expiry",
    );
    await expectConstraint(
      connection,
      `INSERT INTO sessions
         (id, user_id, token_hash, client_type, authenticated_at, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, 'WEB', ?, ?, ?, ?)`,
      ["21", "1", Buffer.alloc(32, 0x21), createdAt, createdAt, past, future],
      "chk_sessions_last_seen",
    );
    await expectConstraint(
      connection,
      `INSERT INTO sessions
         (id, user_id, token_hash, client_type, authenticated_at, created_at, last_seen_at, expires_at, revoked_at)
       VALUES (?, ?, ?, 'WEB', ?, ?, ?, ?, ?)`,
      [
        "22",
        "1",
        Buffer.alloc(32, 0x22),
        createdAt,
        createdAt,
        createdAt,
        future,
        createdAt,
      ],
      "chk_sessions_revoked_pair",
    );
    const foreignKeyEnforced = await verifyForeignKey(connection);

    process.stdout.write(
      `${JSON.stringify(
        {
          status: foreignKeyEnforced ? "PASS" : "FAIL",
          database: identity.databaseName,
          currentUser: identity.currentUser,
          tables,
          indexes: indexRows.map((row) => row.name),
          foreignKeys: foreignKeyRows.map((row) => row.name),
          checks,
          showCreateValidated: Object.keys(createStatements),
          binaryRoundTrip: "PASS",
          varbinaryRoundTrip: "PASS",
          bigintAsString: "PASS",
          checkEnforcement: "7/7 PASS",
          foreignKeyEnforcement: foreignKeyEnforced ? "PASS" : "FAIL",
          syntheticRowsPersisted: false,
        },
        null,
        2,
      )}\n`,
    );
    if (!foreignKeyEnforced) process.exitCode = 2;
  } finally {
    await connection.rollback();
  }
} finally {
  await connection.end();
}

async function expectConstraint(
  connection: mysql.Connection,
  statement: string,
  parameters: Array<string | Buffer | null>,
  constraintName: string,
): Promise<void> {
  try {
    await connection.execute(statement, parameters);
  } catch (error) {
    const mysqlError = error as { code?: string; message?: string };
    if (
      mysqlError.code === "ER_CHECK_CONSTRAINT_VIOLATED" &&
      mysqlError.message?.includes(constraintName)
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`${constraintName} did not reject an invalid row`);
}

async function verifyForeignKey(
  connection: mysql.Connection,
): Promise<boolean> {
  try {
    await connection.execute(
      `INSERT INTO sessions
         (id, user_id, token_hash, client_type, authenticated_at, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, 'WEB', ?, ?, ?, ?)`,
      [
        "30",
        "999999",
        Buffer.alloc(32, 0x30),
        "2026-01-01 00:00:00.000",
        "2026-01-01 00:00:00.000",
        "2026-01-01 00:00:00.000",
        "2026-01-02 00:00:00.000",
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ER_NO_REFERENCED_ROW_2")
      return true;
    throw error;
  }
  return false;
}
