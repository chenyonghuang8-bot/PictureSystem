import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadApiEnv } from "@family-album/config";
import { createDatabase, MySqlUploadRepository } from "@family-album/db";
import { probeStorageCapability } from "@family-album/storage";

import { UploadMutex } from "./uploads/mutex.js";
import {
  type ReconciliationMode,
  publicReconciliationReport,
  StorageReconciler,
} from "./uploads/recovery.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function main() {
  const env = loadApiEnv();
  if (
    env.APP_ENV !== "dev" ||
    env.NODE_ENV === "production" ||
    !env.DEV_STORAGE_MARKER_ID
  )
    throw new Error("RECOVERY_DEV_ONLY");
  const plan = parsePlan(process.argv.slice(2));
  const database = createDatabase(env.DATABASE_URL);
  let root: ReturnType<typeof probeStorageCapability> | null = null;
  try {
    const repository = new MySqlUploadRepository(database.pool);
    await repository.assertRecoveryReadiness();
    // An API writer holding the same native OS lock prevents this CLI from
    // starting. The CLI does not impersonate an auth session.
    root = probeStorageCapability({
      mediaRoot: resolve(repositoryRoot, env.DEV_MEDIA_ROOT),
      initialize: false,
      expectedMarkerId: env.DEV_STORAGE_MARKER_ID,
    });
    if (root.state !== "READ_WRITE")
      throw new Error("RECOVERY_WRITER_LOCK_OR_ROOT_UNAVAILABLE");
    const result = await new StorageReconciler(
      repository,
      root,
      new UploadMutex(),
    ).run(plan);
    process.stdout.write(
      `${JSON.stringify(publicReconciliationReport(result))}\n`,
    );
    if (result.errors > 0 || result.truncated) process.exitCode = 2;
  } finally {
    if (root && root.state !== "UNAVAILABLE") root.root.close();
    await database.pool.end();
  }
}

function parsePlan(args: string[]) {
  let mode: ReconciliationMode = "dry-run";
  let maxCandidates = 128;
  const cursors: Record<string, string> = {};
  const names = new Map([
    ["--after-upload=", "afterUploadId"],
    ["--after-object=", "afterObjectId"],
    ["--after-staging=", "afterStagingKey"],
    ["--after-scratch=", "afterScratchKey"],
    ["--after-original=", "afterOriginalKey"],
  ]);
  for (const arg of args) {
    if (arg === "--dry-run") mode = "dry-run";
    else if (arg === "--recover") mode = "recover";
    else if (arg === "--cleanup-staging") mode = "cleanup-staging";
    else if (arg.startsWith("--max-candidates=")) {
      maxCandidates = Number(arg.slice("--max-candidates=".length));
    } else {
      const entry = [...names].find(([prefix]) => arg.startsWith(prefix));
      if (!entry) throw new Error("RECOVERY_PLAN_INVALID");
      cursors[entry[1]] = arg.slice(entry[0].length);
    }
  }
  return { mode, scope: "global" as const, maxCandidates, ...cursors };
}

await main().catch((error: unknown) => {
  // No raw driver/native error, stack, path or credential in CLI output.
  const code =
    error instanceof Error &&
    /^(?:RECOVERY_|STORAGE_RECOVERY_|SCAN_NAMESPACE_UNSAFE)/u.test(
      error.message,
    )
      ? error.message
      : "RECOVERY_FAILED_CLOSED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
