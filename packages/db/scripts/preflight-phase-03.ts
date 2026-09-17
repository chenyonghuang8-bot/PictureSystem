import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";

import { validateDatabaseHealth } from "../src/health.js";
import {
  assertExactMigrationHistory,
  assertExactSchema,
  buildExpectedSchemaSnapshot,
  loadExpectedMigrationManifest,
  readActualSchemaSnapshot,
} from "../src/migration-readiness.js";
import {
  albumMembers,
  albums,
  families,
  familyMembers,
  invitations,
  sessions,
  users,
} from "../src/schema.js";

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
  hash: string;
  createdAt: string;
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
  throw new Error("Phase 3 preflight is restricted to family_album_dev");
}
if (decodeURIComponent(parsedDatabaseUrl.username).toLowerCase() === "root") {
  throw new Error("Phase 3 preflight refuses the MySQL root account");
}

const migrationPath = resolve(
  packageDirectory,
  "drizzle/0002_phase_03_storage_uploads.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const createdTables = [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map(
  (match) => match[1],
);
if (createdTables.join() !== "storage_objects,upload_sessions") {
  throw new Error("Phase 3 migration table manifest differs from review scope");
}

const pool = mysql.createPool({
  uri: databaseUrl,
  connectionLimit: 1,
  multipleStatements: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  timezone: "Z",
});
const connection = await pool.getConnection();

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
    !/(^|,)(STRICT_TRANS_TABLES|STRICT_ALL_TABLES)(,|$)/u.test(identity.sqlMode)
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
  const unexpectedPhase3Tables = ["storage_objects", "upload_sessions"].filter(
    (table) => tableNames.includes(table),
  );
  if (unexpectedPhase3Tables.length > 0) {
    throw new Error(
      `Phase 3 tables already exist: ${unexpectedPhase3Tables.join(", ")}`,
    );
  }

  const manifest = await loadExpectedMigrationManifest();
  if (
    manifest.length !== 3 ||
    manifest[2]?.tag !== "0002_phase_03_storage_uploads"
  ) {
    throw new Error(
      "Expected migration manifest does not end at reviewed 0002",
    );
  }
  const phase2Manifest = manifest.slice(0, 2);
  const [journal] = await connection.query<JournalRow[]>(
    "SELECT hash, CAST(created_at AS CHAR) AS createdAt FROM __drizzle_migrations ORDER BY id ASC",
  );
  assertExactMigrationHistory(phase2Manifest, journal);
  assertExactSchema(
    buildExpectedSchemaSnapshot([
      users,
      families,
      familyMembers,
      invitations,
      sessions,
      albums,
      albumMembers,
    ]),
    await readActualSchemaSnapshot(connection),
  );

  const indexes = [
    ...migration.matchAll(/(?:CONSTRAINT|INDEX) `((?:uq|idx)_[^`]+)`/g),
  ].map((match) => match[1]);
  const foreignKeys = [
    ...migration.matchAll(/CONSTRAINT `([^`]+)` FOREIGN KEY/g),
  ].map((match) => match[1]);
  const checks = [...migration.matchAll(/CONSTRAINT `(chk_[^`]+)` CHECK/g)].map(
    (match) => match[1],
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "PHASE_3_MIGRATION_READY",
        database: identity.databaseName,
        currentUser: identity.currentUser,
        mysqlVersion: identity.version,
        nativeFk: fkHealth.nativeFk,
        foreignKeyChecks: fkHealth.foreignKeyChecks,
        phase2MigrationJournal: "PASS",
        baselineSchemaReadiness: "PASS",
        existingPhase3Tables: unexpectedPhase3Tables,
        migrationPath,
        creates: createdTables,
        indexes,
        foreignKeys,
        checks,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  connection.release();
  await pool.end();
}
