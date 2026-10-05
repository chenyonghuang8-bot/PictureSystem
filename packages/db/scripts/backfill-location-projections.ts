import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadLocationProjector } from "@family-album/media";
import {
  createDatabase,
  acquireCheckedConnection,
  assertMigrationReadiness,
  MySqlLocationProjectionRepository,
} from "../src/index.js";
process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const args = process.argv.slice(2),
  apply = args.includes("--apply");
const options = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const key = args[i]!;
  if (key === "--apply") continue;
  if (
    !["--family", "--batch-size", "--max-batches", "--dataset"].includes(key) ||
    options.has(key) ||
    !args[i + 1] ||
    args[i + 1]!.startsWith("--")
  )
    throw new Error("LOCATION_ARGUMENT_INVALID");
  options.set(key, args[++i]!);
}
const familyId = options.get("--family"),
  directory = options.get("--dataset") ?? process.env.LOCATION_DATA_DIR;
const size = Number(options.get("--batch-size") ?? 20),
  max = Number(options.get("--max-batches") ?? 1);
if (
  !familyId ||
  !/^[1-9][0-9]{0,19}$/.test(familyId) ||
  BigInt(familyId) > 18446744073709551615n ||
  !directory ||
  !Number.isInteger(size) ||
  size < 1 ||
  size > 100 ||
  !Number.isInteger(max) ||
  max < 1 ||
  max > 1000
)
  throw new Error("LOCATION_ARGUMENT_INVALID");
const target = new URL(process.env.DATABASE_URL ?? "");
if (
  target.protocol !== "mysql:" ||
  target.pathname !== "/family_album_dev" ||
  decodeURIComponent(target.username).toLowerCase() === "root" ||
  (process.env.APP_ENV ?? "dev") !== "dev"
)
  throw new Error("LOCATION_DEV_ONLY");
const projector = loadLocationProjector(resolve(directory)),
  database = createDatabase(target.href),
  repository = new MySqlLocationProjectionRepository(database.pool, projector);
try {
  const c = await acquireCheckedConnection(database.pool);
  try {
    await assertMigrationReadiness(c);
  } finally {
    c.release();
  }
  let after = "0";
  const counts = { SCANNED: 0, INSERTED: 0, UPDATED: 0, NOOP: 0, STALE: 0 };
  for (let batch = 0; batch < max; batch++) {
    const rows = await repository.scan(familyId, size, after);
    if (!rows.length) break;
    counts.SCANNED += rows.length;
    for (const row of rows) {
      if (apply) ++counts[await repository.apply(row)];
      else projector.project(row.gpsLatitude, row.gpsLongitude);
    }
    after = rows.at(-1)!.mediaId;
  }
  console.log(
    JSON.stringify({
      mode: apply ? "APPLY" : "DRY_RUN",
      policyVersion: projector.policyVersion,
      datasetVersion: projector.datasetVersion,
      counts,
    }),
  );
} catch {
  console.error("LOCATION_BACKFILL_STOPPED_NO_REPLAY_RESCAN_IN_NEW_RUN");
  process.exitCode = 1;
} finally {
  await database.pool.end();
}
