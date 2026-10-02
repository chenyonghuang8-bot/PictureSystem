import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { acquireCheckedConnection } from "../src/connection.js";
import {
  assertExactMigrationHistory,
  assertExactSchema,
  assertMigrationReadiness,
  buildPhase7PredecessorSchemaSnapshot,
  loadExpectedMigrationManifest,
  readActualSchemaSnapshot,
} from "../src/migration-readiness.js";

// Read-only by default. The eventual --apply path is intentionally separate
// from the 7A task, and must be invoked only after independent review.
process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const url = process.env.DATABASE_URL;
if (!url) throw new Error("PHASE7_ENV_REQUIRED");
const target = new URL(url);
if (
  target.protocol !== "mysql:" ||
  target.pathname !== "/family_album_dev" ||
  decodeURIComponent(target.username).toLowerCase() === "root"
) {
  throw new Error("PHASE7_DEV_ONLY");
}
if (process.argv.slice(2).some((arg) => arg !== "--apply")) {
  throw new Error("PHASE7_ARGUMENT_INVALID");
}
const pool = mysql.createPool({
  uri: url,
  connectionLimit: 1,
  multipleStatements: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  timezone: "Z",
});
let connection;
try {
  connection = await acquireCheckedConnection(pool);
  const [identity] = await connection.query<RowDataPacket[]>(
    "SELECT DATABASE() db, VERSION() version, CURRENT_USER() account",
  );
  assert.equal(identity[0]?.db, "family_album_dev");
  assert.equal(identity[0]?.version, "9.7.2");
  assert.notEqual(
    String(identity[0]?.account).split("@")[0]?.toLowerCase(),
    "root",
  );
  const manifest = await loadExpectedMigrationManifest();
  assert.equal(manifest.length, 8);
  assert.equal(
    manifest[6]?.hash,
    "533b8f57d98dd10251d770326cd7df1d22481b087eb23c46edd7ec2a493017e4",
  );
  assert.equal(manifest[7]?.tag, "0007_phase_07_trash");
  const [journal] = await connection.query<RowDataPacket[]>(
    "SELECT hash, CAST(created_at AS CHAR) createdAt FROM __drizzle_migrations ORDER BY id",
  );
  assertExactMigrationHistory(
    manifest.slice(0, 7),
    journal.map((row) => ({ hash: row.hash, createdAt: row.createdAt })),
  );
  assertExactSchema(
    buildPhase7PredecessorSchemaSnapshot(),
    await readActualSchemaSnapshot(connection),
  );
  console.log("PHASE7_PREFLIGHT_PASS: exact 0006 DEV baseline; 0007 absent");
  if (process.argv.includes("--apply")) {
    // MySQL DDL is not transactional. On any error, stop and inspect the
    // physical schema/journal; never replay the whole migration blindly.
    await migrate(drizzle({ client: connection }), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    assert.equal(
      (await assertMigrationReadiness(connection)).migrationCount,
      8,
    );
    console.log("PHASE7_MIGRATION_APPLIED_AND_READY");
  }
} catch (error) {
  if (
    error instanceof Error &&
    error.name === "MigrationReadinessError" &&
    "reason" in error
  ) {
    console.error(`PHASE7_PREFLIGHT_REASON: ${String(error.reason)}`);
  } else if (error instanceof assert.AssertionError) {
    console.error(`PHASE7_PREFLIGHT_ASSERTION: ${error.operator}`);
  }
  console.error(
    "PHASE7_MIGRATION_FAILED: stop and inspect exact schema/journal; no blind replay.",
  );
  process.exitCode = 1;
} finally {
  connection?.release();
  await pool.end();
}
