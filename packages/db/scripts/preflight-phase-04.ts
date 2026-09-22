import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";

import { validateDatabaseHealth } from "../src/health.js";
import {
  assertExactMigrationHistory,
  assertExactSchema,
  buildPhase4PredecessorSchemaSnapshot,
  loadExpectedMigrationManifest,
  readActualSchemaSnapshot,
} from "../src/migration-readiness.js";

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
  throw new Error("Phase 4 preflight is restricted to family_album_dev");
}
if (decodeURIComponent(parsedDatabaseUrl.username).toLowerCase() === "root") {
  throw new Error("Phase 4 preflight refuses the MySQL root account");
}

const migrationPath = resolve(
  packageDirectory,
  "drizzle/0003_phase_04_media_processing.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const createdTables = [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map(
  (match) => match[1],
);
if (
  createdTables.join() !== "background_jobs,derived_assets,media_items" ||
  [...migration.matchAll(/ALTER TABLE `([^`]+)`/g)]
    .map((match) => match[1])
    .filter(
      (table) =>
        !["background_jobs", "derived_assets", "media_items"].includes(
          table ?? "",
        ),
    )
    .join() !== "upload_sessions" ||
  !migration.includes(
    "ALTER TABLE `upload_sessions` ADD CONSTRAINT `uq_upload_sessions_family_id_object` UNIQUE(`family_id`,`id`,`storage_object_id`)",
  ) ||
  /IF NOT EXISTS|DROP\s+(DATABASE|TABLE)|TRUNCATE/iu.test(migration)
) {
  throw new Error("Phase 4 migration differs from the reviewed scope");
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
    throw new Error("Refusing the MySQL root account");
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
  const existing = tableRows.map((row) => row.tableName);
  const unexpected = createdTables.filter(
    (table): table is string => table !== undefined && existing.includes(table),
  );
  if (unexpected.length > 0) {
    throw new Error(`Phase 4 tables already exist: ${unexpected.join(", ")}`);
  }

  const manifest = await loadExpectedMigrationManifest();
  if (
    manifest.length !== 4 ||
    manifest[2]?.tag !== "0002_phase_03_storage_uploads" ||
    manifest[3]?.tag !== "0003_phase_04_media_processing"
  ) {
    throw new Error("Expected migration manifest is not reviewed 0000..0003");
  }
  const [journal] = await connection.query<JournalRow[]>(
    "SELECT hash, CAST(created_at AS CHAR) AS createdAt FROM __drizzle_migrations ORDER BY id ASC",
  );
  assertExactMigrationHistory(manifest.slice(0, 3), journal);
  assertExactSchema(
    buildPhase4PredecessorSchemaSnapshot(),
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
        status: "PHASE_4_MIGRATION_READY",
        database: identity.databaseName,
        currentUser: identity.currentUser,
        mysqlVersion: identity.version,
        nativeFk: fkHealth.nativeFk,
        foreignKeyChecks: fkHealth.foreignKeyChecks,
        predecessorJournal: "PASS",
        predecessorSchema: "PASS",
        existingPhase4Tables: unexpected,
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
