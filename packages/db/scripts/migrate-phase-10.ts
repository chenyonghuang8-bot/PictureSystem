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
  buildPhase10PredecessorSchemaSnapshot,
  loadExpectedMigrationManifest,
  readActualSchemaSnapshot,
} from "../src/migration-readiness.js";
process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const url = process.env.DATABASE_URL;
if (!url) throw new Error("PHASE10_ENV_REQUIRED");
const target = new URL(url);
if (
  target.protocol !== "mysql:" ||
  target.pathname !== "/family_album_dev" ||
  decodeURIComponent(target.username).toLowerCase() === "root" ||
  (process.env.APP_ENV ?? "dev") !== "dev"
)
  throw new Error("PHASE10_DEV_ONLY");
if (process.argv.slice(2).some((a) => a !== "--apply"))
  throw new Error("PHASE10_ARGUMENT_INVALID");
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
    "SELECT DATABASE() db,VERSION() version,CURRENT_USER() account",
  );
  assert.equal(identity[0]?.db, "family_album_dev");
  assert.equal(identity[0]?.version, "9.7.2");
  assert.notEqual(
    String(identity[0]?.account).split("@")[0]?.toLowerCase(),
    "root",
  );
  const manifest = await loadExpectedMigrationManifest();
  assert.equal(manifest.length, 10);
  assert.equal(manifest[9]?.tag, "0009_phase_10_android");
  const [journal] = await connection.query<RowDataPacket[]>(
    "SELECT hash,CAST(created_at AS CHAR) createdAt FROM __drizzle_migrations ORDER BY id",
  );
  if (journal.length === 10) {
    await assertMigrationReadiness(connection);
    console.log("PHASE10_ALREADY_CURRENT_NO_DDL");
  } else {
    assertExactMigrationHistory(
      manifest.slice(0, 9),
      journal.map((r) => ({ hash: r.hash, createdAt: r.createdAt })),
    );
    assertExactSchema(
      buildPhase10PredecessorSchemaSnapshot(),
      await readActualSchemaSnapshot(connection),
    );
    console.log("PHASE10_PREFLIGHT_PASS");
    if (process.argv.includes("--apply")) {
      await migrate(drizzle({ client: connection }), {
        migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      });
      assert.equal(
        (await assertMigrationReadiness(connection)).migrationCount,
        10,
      );
      console.log("PHASE10_MIGRATION_APPLIED_AND_READY");
    }
  }
} catch (error) {
  console.error(
    JSON.stringify({
      category: error instanceof Error ? error.name : "UNKNOWN",
      reason:
        error && typeof error === "object" && "reason" in error
          ? error.reason
          : null,
      code:
        error && typeof error === "object" && "code" in error
          ? error.code
          : null,
    }),
  );
  console.error(
    "PHASE10_MIGRATION_REFUSED_OR_FAILED_INSPECT_SCHEMA_JOURNAL_NO_REPLAY",
  );
  process.exitCode = 1;
} finally {
  connection?.release();
  await pool.end();
}
