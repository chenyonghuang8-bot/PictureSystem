import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql, { type PoolConnection, type RowDataPacket } from "mysql2/promise";
import {
  assertExactMigrationHistory,
  assertExactSchema,
  assertMigrationReadiness,
  buildPhase6PredecessorSchemaSnapshot,
  loadExpectedMigrationManifest,
  readActualSchemaSnapshot,
} from "../src/migration-readiness.js";
import { acquireCheckedConnection } from "../src/connection.js";
import {
  createPhase6SchemaFixture,
  cleanupPhase6MigrationFixture,
} from "./phase6-schema-fixture.js";

process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const url = process.env.DATABASE_URL;
if (!url) throw new Error("PHASE6A_ENV_REQUIRED");
const target = new URL(url);
if (
  target.protocol !== "mysql:" ||
  target.pathname !== "/family_album_dev" ||
  decodeURIComponent(target.username).toLowerCase() === "root"
)
  throw new Error("PHASE6A_DEV_ONLY");
if (process.argv.slice(2).some((arg) => arg !== "--apply"))
  throw new Error("PHASE6A_ARGUMENT_INVALID");
const pool = mysql.createPool({
  uri: url,
  connectionLimit: 1,
  multipleStatements: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  timezone: "Z",
});
const protectedTables = [
  "users",
  "families",
  "family_members",
  "albums",
  "album_members",
  "storage_objects",
  "upload_sessions",
  "media_items",
  "album_media",
  "derived_assets",
  "background_jobs",
  "shares",
  "share_events",
] as const;
async function counts(c: PoolConnection) {
  const result: Record<string, string> = {};
  for (const table of protectedTables) {
    const [rows] = await c.query<RowDataPacket[]>(
      `SELECT CAST(COUNT(*) AS CHAR) n FROM ${table}`,
    );
    result[table] = String(rows[0]!.n);
  }
  return result;
}
let connection: PoolConnection | undefined;
let fixture: Awaited<ReturnType<typeof createPhase6SchemaFixture>> | undefined;
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
  assert.equal(manifest.length, 7);
  assert.equal(manifest[6]?.tag, "0006_phase_06_album_features");
  const [journal] = await connection.query<RowDataPacket[]>(
    "SELECT hash,CAST(created_at AS CHAR) createdAt FROM __drizzle_migrations ORDER BY id",
  );
  assertExactMigrationHistory(
    manifest.slice(0, 6),
    journal.map((r) => ({ hash: r.hash, createdAt: r.createdAt })),
  );
  assertExactSchema(
    buildPhase6PredecessorSchemaSnapshot(),
    await readActualSchemaSnapshot(connection),
  );
  const baseline = await counts(connection);
  console.log(
    JSON.stringify({
      preflight: "PASS",
      database: "family_album_dev",
      mysql: "9.7.2",
      nonRoot: true,
      nativeFk: 1,
      foreignKeyChecks: 1,
      baseline,
    }),
  );
  if (process.argv.includes("--apply")) {
    await connection.beginTransaction();
    try {
      fixture = await createPhase6SchemaFixture(connection);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    const [before] = await connection.query<RowDataPacket[]>(
      "SELECT * FROM media_items WHERE id=? AND family_id=?",
      [fixture.mediaId, fixture.familyId],
    );
    const withFixture = await counts(connection);
    // Same Drizzle migrator and journal semantics as db:migrate, after guarded preflight.
    await migrate(drizzle({ client: connection }), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    assert.deepEqual(await counts(connection), withFixture);
    const [after] = await connection.query<RowDataPacket[]>(
      "SELECT * FROM media_items WHERE id=? AND family_id=?",
      [fixture.mediaId, fixture.familyId],
    );
    const { description, note_revision: revision, ...preserved } = after[0]!;
    assert.equal(description, null);
    assert.equal(String(revision), "1");
    assert.deepEqual(preserved, before[0]);
    const [defaults] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) invalid FROM media_items WHERE description IS NOT NULL OR note_revision <> 1",
    );
    assert.equal(Number(defaults[0]?.invalid), 0);
    assert.equal(
      (await assertMigrationReadiness(connection)).migrationCount,
      7,
    );
    // Readiness is deliberately read-only: no replay of CREATE or journal insertion.
    assert.equal(
      (await assertMigrationReadiness(connection)).migrationCount,
      7,
    );
    await cleanupPhase6MigrationFixture(connection, fixture);
    fixture = undefined;
    assert.deepEqual(await counts(connection), baseline);
    console.log(
      JSON.stringify({
        applied: true,
        migrationRows: 7,
        readiness: "PASS",
        existingMediaPreserved: true,
        noteDefaults: "NULL/1",
        syntheticResidue: 0,
        finalCounts: baseline,
      }),
    );
  }
} catch {
  console.error(
    "PHASE6A_MIGRATION_FAILED: stop; inspect schema/journal before any retry. No raw driver details emitted.",
  );
  process.exitCode = 1;
} finally {
  if (connection) {
    if (fixture) {
      try {
        await cleanupPhase6MigrationFixture(connection, fixture);
      } catch {
        console.error("PHASE6A_SYNTHETIC_CLEANUP_FAILED");
        process.exitCode = 1;
      }
    }
    connection.release();
  }
  await pool.end();
}
