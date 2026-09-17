import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";

import { validateDatabaseHealth } from "../src/health.js";

interface IdentityRow extends RowDataPacket {
  databaseName: string | null;
  currentUser: string;
  version: string;
  sqlMode: string;
}

interface TableRow extends RowDataPacket {
  tableName: string;
}

interface JournalRow extends RowDataPacket {
  migrationCount: string;
  latestHash: string | null;
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
  throw new Error("Phase 2 preflight is restricted to family_album_dev");
}
if (decodeURIComponent(parsedDatabaseUrl.username).toLowerCase() === "root") {
  throw new Error("Phase 2 preflight refuses the MySQL root account");
}

const migrationPath = resolve(
  packageDirectory,
  "drizzle/0001_phase_02_albums_permissions.sql",
);
const phase1MigrationPath = resolve(
  packageDirectory,
  "drizzle/0000_phase_01a_identity_foundation.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const expectedPhase1Hash = createHash("sha256")
  .update(readFileSync(phase1MigrationPath))
  .digest("hex");
const expectedPhase1Tables = [
  "families",
  "family_members",
  "invitations",
  "sessions",
  "users",
];
const expectedPhase2Tables = ["album_members", "albums"];
const createdTables = [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map(
  (match) => match[1],
);
if (createdTables.join() !== expectedPhase2Tables.join()) {
  throw new Error("Phase 2 migration table manifest differs from review scope");
}

const connection = await mysql.createConnection({
  uri: databaseUrl,
  multipleStatements: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  timezone: "Z",
});

try {
  const fkHealth = await validateDatabaseHealth(connection);
  const [[identity]] = await connection.query<IdentityRow[]>(
    "SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser, VERSION() AS version, @@SESSION.sql_mode AS sqlMode",
  );
  if (!identity) throw new Error("Database identity query returned no row");
  if (identity.databaseName !== "family_album_dev") {
    throw new Error(`Refusing database ${identity.databaseName ?? "NULL"}`);
  }
  if (identity.currentUser.split("@", 1)[0]?.toLowerCase() === "root") {
    throw new Error("Refusing to use the MySQL root account");
  }
  if (identity.version !== "9.7.2") {
    throw new Error(`Expected MySQL 9.7.2, received ${identity.version}`);
  }
  if (
    !/(^|,)(STRICT_TRANS_TABLES|STRICT_ALL_TABLES)(,|$)/.test(identity.sqlMode)
  ) {
    throw new Error("Strict MySQL SQL mode is required");
  }

  const [tableRows] = await connection.query<TableRow[]>(
    `SELECT TABLE_NAME AS tableName
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
      ORDER BY TABLE_NAME`,
  );
  const tableNames = tableRows.map((row) => row.tableName);
  const missingPhase1 = expectedPhase1Tables.filter(
    (table) => !tableNames.includes(table),
  );
  const existingPhase2 = expectedPhase2Tables.filter((table) =>
    tableNames.includes(table),
  );
  if (!tableNames.includes("__drizzle_migrations") || missingPhase1.length) {
    throw new Error(
      `Phase 1 migration is incomplete: ${missingPhase1.join(", ") || "journal missing"}`,
    );
  }
  if (existingPhase2.length) {
    throw new Error(
      `Phase 2 tables already exist: ${existingPhase2.join(", ")}`,
    );
  }

  const [[journal]] = await connection.query<JournalRow[]>(
    `SELECT CAST(COUNT(*) AS CHAR) AS migrationCount,
            (SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1) AS latestHash
       FROM __drizzle_migrations`,
  );
  if (
    !journal ||
    journal.migrationCount !== "1" ||
    journal.latestHash !== expectedPhase1Hash
  ) {
    throw new Error("Phase 1 migration journal does not match reviewed 0000");
  }

  const indexes = [
    ...migration.matchAll(/(?:CONSTRAINT|INDEX) `((?:uq|idx)_[^`]+)`/g),
  ].map((match) => match[1]);
  const foreignKeys = [
    ...migration.matchAll(/CONSTRAINT `([^`]+)` FOREIGN KEY/g),
  ].map((match) => match[1]);
  const checks = [...migration.matchAll(/CONSTRAINT `(chk_[^`]+)` CHECK/g)].map(
    (match) => match[1],
  );
  const result = {
    status: "PHASE_2_MIGRATION_READY",
    database: identity.databaseName,
    currentUser: identity.currentUser,
    mysqlVersion: identity.version,
    nativeFk: fkHealth.nativeFk,
    foreignKeyChecks: fkHealth.foreignKeyChecks,
    phase1MigrationJournal: "PASS",
    existingPhase2Tables: existingPhase2,
    migrationPath,
    creates: createdTables,
    primaryKeys: ["album_members_id", "albums_id"],
    indexes,
    foreignKeys,
    checks,
    revisionConstraints: [
      "albums.revision BIGINT UNSIGNED NOT NULL DEFAULT 1",
      "chk_albums_revision: revision >= 1",
      "all future album/ACL writes require conditional revision updates",
    ],
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await connection.end();
}
