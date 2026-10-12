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
import { loadDeploymentControl } from "./deployment-control.js";
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
  const control = await loadDeploymentControl(database.pool, env, {
    path: process.env.DEV_CONTROL_PATH,
    deploymentId: process.env.DEV_CONTROL_DEPLOYMENT_ID,
    roles: ["METADATA"],
    mediaRoot: resolve(env.DEV_MEDIA_ROOT),
    markerId: env.DEV_STORAGE_MARKER_ID,
  });
  let reader: OriginalReader | undefined,
    stopping = false;
  let loop: MetadataJobLoop | undefined;
  const stop = () => {
    void control.beginShutdown?.().catch(() => {});
    stopping = true;
    loop?.requestStop();
    control.stop?.();
  };
  control.onStopping?.(stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (!control.gate) throw Error("CONTROL_RUN_REQUIRED");
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
    const currentReader = reader;
    // Read-only reader identity is checked before claim and in every heartbeat.
    // This process never acquires the Original writer or coordinates recovery.
    control.bindHealth?.(async () => currentReader.assertIdentity());
    const driver = new MetadataJobDriver(
      database.pool,
      reader,
      projector,
      () =>
        console.error(
          '{"event":"location_projection_deferred","category":"PROJECTION_FAILED"}',
        ),
      {
        run: (action, operation) =>
          control.admission.run(action, () =>
            control.track ? control.track("METADATA", operation) : operation(),
          ),
      },
    );
    console.log('{"event":"metadata_driver_ready","scope":"DEV_MEDIA_PROBE"}');
    loop = new MetadataJobLoop(driver);
    await control.start?.([
      { role: "METADATA", ready: () => reader !== undefined && !stopping },
    ]);
    if (stopping) loop.requestStop();
    await loop.start();
  } finally {
    control.stop?.();
    const loopDrain = await Promise.allSettled([loop?.drain()]);
    let closed = loopDrain.every((r) => r.status === "fulfilled");
    try {
      await control.drain?.();
    } catch {
      closed = false;
      console.error(
        '{"event":"metadata_heartbeat_exit_failed","category":"DB_UNAVAILABLE"}',
      );
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      reader?.close();
    } catch {
      closed = false;
    }
    await control.resourcesClosed?.(closed);
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
