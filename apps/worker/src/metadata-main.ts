import { resolve } from "node:path";
import { loadApiEnv } from "@family-album/config";
import {
  createDatabase,
  acquireCheckedConnection,
  assertMigrationReadiness,
} from "@family-album/db";
import { OriginalReader } from "@family-album/storage";
import { loadLocationProjector } from "@family-album/media";
import { MetadataJobDriver } from "./metadata-driver.js";
import { MetadataJobLoop } from "./metadata-job-loop.js";
async function main() {
  const env = loadApiEnv(),
    target = new URL(env.DATABASE_URL);
  if (
    env.APP_ENV !== "dev" ||
    !env.DEV_STORAGE_MARKER_ID ||
    !process.env.LOCATION_DATA_DIR ||
    target.pathname !== "/family_album_dev" ||
    decodeURIComponent(target.username).toLowerCase() === "root"
  )
    throw new Error("PROBE_DEV_CONFIG_REQUIRED");
  const projector = loadLocationProjector(
    resolve(process.env.LOCATION_DATA_DIR),
  );
  const database = createDatabase(env.DATABASE_URL);
  let reader: OriginalReader | undefined,
    stopping = false;
  let loop: MetadataJobLoop | undefined;
  const stop = () => {
    stopping = true;
    loop?.requestStop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const c = await acquireCheckedConnection(database.pool);
    try {
      await assertMigrationReadiness(c);
    } finally {
      c.release();
    }
    reader = OriginalReader.open({
      mediaRoot: resolve(env.DEV_MEDIA_ROOT),
      expectedMarkerId: env.DEV_STORAGE_MARKER_ID,
    });
    const driver = new MetadataJobDriver(database.pool, reader, projector, () =>
      console.error(
        '{"event":"location_projection_deferred","category":"PROJECTION_FAILED"}',
      ),
    );
    console.log('{"event":"metadata_driver_ready","scope":"DEV_MEDIA_PROBE"}');
    loop = new MetadataJobLoop(driver);
    if (stopping) loop.requestStop();
    await loop.start();
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    reader?.close();
    await database.pool.end();
  }
}
// DB failures (including COMMIT unknown) terminate the process. No compensating
// metadata failure write, replay, or catch-and-continue loop is permitted.
void main().catch(() => {
  console.error(
    '{"event":"metadata_driver_stopped","category":"EXECUTION_REFUSED_OR_UNKNOWN"}',
  );
  process.exitCode = 1;
});
