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

interface EngineRow extends RowDataPacket {
  Engine: string;
  Support: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const rootEnvFile = resolve(packageDirectory, "../..", ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvFile))
  process.loadEnvFile(rootEnvFile);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "mysql:" ||
  parsedDatabaseUrl.pathname !== "/family_album_dev"
) {
  throw new Error("Preflight is restricted to the family_album_dev database");
}
if (decodeURIComponent(parsedDatabaseUrl.username).toLowerCase() === "root") {
  throw new Error("Preflight refuses to connect as MySQL root");
}

const migrationPath = resolve(
  packageDirectory,
  "drizzle/0000_phase_01a_identity_foundation.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const expectedTables = [
  "users",
  "families",
  "family_members",
  "invitations",
  "sessions",
];
const createdTables = [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map(
  (match) => match[1],
);
if ([...createdTables].sort().join() !== [...expectedTables].sort().join()) {
  throw new Error(
    "Migration table manifest differs from the reviewed Phase 1A scope",
  );
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

  const currentUsername = identity.currentUser.split("@", 1)[0]?.toLowerCase();
  if (identity.databaseName !== "family_album_dev") {
    throw new Error(`Refusing database ${identity.databaseName ?? "NULL"}`);
  }
  if (currentUsername === "root")
    throw new Error("Refusing to use the MySQL root account");
  if (
    !/(^|,)(STRICT_TRANS_TABLES|STRICT_ALL_TABLES)(,|$)/.test(identity.sqlMode)
  ) {
    throw new Error("Strict MySQL SQL mode is required");
  }

  const [tableRows] = await connection.query<TableRow[]>(
    `SELECT TABLE_NAME AS tableName
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND TABLE_NAME IN ('users','families','family_members','invitations','sessions')
      ORDER BY TABLE_NAME`,
  );
  const [engineRows] = await connection.query<EngineRow[]>("SHOW ENGINES");
  const innoDb = engineRows.find(
    (row) => row.Engine.toLowerCase() === "innodb",
  );
  if (!innoDb || !["YES", "DEFAULT"].includes(innoDb.Support)) {
    throw new Error("InnoDB transaction support is unavailable");
  }

  const existingTables = tableRows.map((row) => row.tableName);
  const result = {
    status: existingTables.length === 0 ? "MIGRATION_READY" : "SCHEMA_CONFLICT",
    database: identity.databaseName,
    currentUser: identity.currentUser,
    mysqlVersion: identity.version,
    strictSqlMode: true,
    ...fkHealth,
    innoDbSupport: innoDb.Support,
    existingBusinessTables: existingTables,
    migrationPath,
    creates: createdTables,
    indexes: [
      ...migration.matchAll(/(?:CONSTRAINT|INDEX) `((?:uq|idx)_[^`]+)`/g),
    ].map((match) => match[1]),
    foreignKeys: [
      ...migration.matchAll(/CONSTRAINT `([^`]+)` FOREIGN KEY/g),
    ].map((match) => match[1]),
    checks: [...migration.matchAll(/CONSTRAINT `(chk_[^`]+)` CHECK/g)].map(
      (match) => match[1],
    ),
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (existingTables.length > 0) process.exitCode = 2;
} finally {
  await connection.end();
}
