import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { assertNoPhase11DevInstances } from "./phase11-instance-proof.js";
import { acquireCheckedConnection } from "../src/connection.js";
import {
  assertExactMigrationHistory,
  assertExactSchema,
  assertMigrationReadiness,
  buildRunProofPredecessorSchemaSnapshot,
  loadExpectedMigrationManifest,
  readActualSchemaSnapshot,
} from "../src/migration-readiness.js";
process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const url = process.env.DATABASE_URL;
if (!url) throw new Error("PHASE11_RUN_PROOFS_ENV_REQUIRED");
const target = new URL(url);
if (
  target.protocol !== "mysql:" ||
  target.pathname !== "/family_album_dev" ||
  decodeURIComponent(target.username).toLowerCase() === "root" ||
  (process.env.APP_ENV ?? "dev") !== "dev"
)
  throw new Error("PHASE11_RUN_PROOFS_DEV_ONLY");
if (process.argv.slice(2).some((a) => a !== "--apply"))
  throw new Error("PHASE11_RUN_PROOFS_ARGUMENT_INVALID");
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
  assert.equal(manifest.length, 12);
  assert.equal(manifest[11]?.tag, "0011_phase_11_run_proofs");
  const [journal] = await connection.query<RowDataPacket[]>(
    "SELECT hash,CAST(created_at AS CHAR) createdAt FROM __drizzle_migrations ORDER BY id",
  );
  if (journal.length === 12) {
    await assertMigrationReadiness(connection);
    console.log("PHASE11_RUN_PROOFS_ALREADY_CURRENT_NO_DDL");
  } else {
    assertExactMigrationHistory(
      manifest.slice(0, 11),
      journal.map((r) => ({ hash: r.hash, createdAt: r.createdAt })),
    );
    assertExactSchema(
      buildRunProofPredecessorSchemaSnapshot(),
      await readActualSchemaSnapshot(connection),
    );
    console.log("PHASE11_RUN_PROOFS_PREFLIGHT_PASS");
    if (process.argv.includes("--apply")) {
      const workspace = fileURLToPath(new URL("../../../", import.meta.url));
      const instanceProof = await assertNoPhase11DevInstances(
        connection,
        workspace,
      );
      const before: Record<string, string> = {};
      for (const table of buildRunProofPredecessorSchemaSnapshot().tables) {
        if (!/^[a-z0-9_]+$/.test(table.name))
          throw Error("PHASE11_RUN_PROOFS_BASELINE_INVALID");
        const [count] = await connection.query<RowDataPacket[]>(
          `SELECT CAST(COUNT(*) AS CHAR) n FROM \`${table.name}\``,
        );
        before[table.name] = String(count[0]!.n);
      }
      const folder = resolve(workspace, ".cache/phase11-r1");
      await mkdir(folder, { recursive: true });
      await writeFile(
        resolve(folder, `preapply-${randomUUID()}.json`),
        JSON.stringify(
          {
            instanceProof,
            predecessorJournal: journal.map((r) => ({
              hash: r.hash,
              createdAt: r.createdAt,
            })),
            rowCounts: before,
            migration: manifest[11],
          },
          null,
          2,
        ) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      console.log("PHASE11_RUN_PROOFS_NO_INSTANCES_AND_BASELINE_RECORDED");
      await migrate(drizzle({ client: connection }), {
        migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      });
      assert.equal(
        (await assertMigrationReadiness(connection)).migrationCount,
        12,
      );
      console.log("PHASE11_RUN_PROOFS_MIGRATION_APPLIED_AND_READY");
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
    "PHASE11_RUN_PROOFS_MIGRATION_REFUSED_OR_FAILED_INSPECT_SCHEMA_JOURNAL_NO_REPLAY",
  );
  process.exitCode = 1;
} finally {
  connection?.release();
  await pool.end();
}
