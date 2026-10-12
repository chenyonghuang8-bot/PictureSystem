import pino from "pino";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLoggerOptions, loadApiEnv } from "@family-album/config";
import {
  createDatabase,
  acquireCheckedConnection,
  assertMigrationReadiness,
  runCheckedTransaction,
  MySqlUploadRepository,
} from "@family-album/db";
import { StorageRoot, DerivedStore, CapacityGate } from "@family-album/storage";
import { ControlAdmissionError } from "@family-album/storage";
import {
  loadDeploymentControl,
  configuredControlRoles,
} from "./deployment-control.js";
import { PurgeProcessor } from "./purge-processor.js";
import { PurgeScheduler } from "./purge-scheduler.js";
import { PurgeScheduleRepository } from "../../../packages/db/src/purge-scheduler.js";
import { StorageRuntimeOwner } from "./storage-runtime-owner.js";
import {
  assessStorageStartup,
  confirmStorageStartup,
} from "../../api/src/uploads/startup.js";
import { UploadMutex } from "../../api/src/uploads/mutex.js";
export { MetadataProcessingService } from "./metadata-processor.js";

const logger = pino(createLoggerOptions());
async function main() {
  const env = loadApiEnv();
  if (env.APP_ENV !== "dev" || !env.DEV_STORAGE_MARKER_ID)
    throw new Error("PURGE_DEV_ROOT_REQUIRED");
  const database = createDatabase(env.DATABASE_URL);
  const control = await loadDeploymentControl(database.pool, env, {
    path: process.env.DEV_CONTROL_PATH,
    deploymentId: process.env.DEV_CONTROL_DEPLOYMENT_ID,
    roles: ["PURGE"],
    mediaRoot: resolve(env.DEV_MEDIA_ROOT),
    markerId: env.DEV_STORAGE_MARKER_ID,
  });
  let root: StorageRoot | undefined,
    store: DerivedStore | undefined,
    gate: CapacityGate | undefined;
  let owner: StorageRuntimeOwner | undefined;
  let stopping = false;
  const stop = () => {
    void control.beginShutdown?.().catch(() => {});
    stopping = true;
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
    // Exclusive Original and Derived writers must belong to this controlled
    // process. A running API writer causes startup refusal before any claim.
    root = StorageRoot.open(resolve(env.DEV_MEDIA_ROOT), {
      initialize: false,
      expectedMarkerId: env.DEV_STORAGE_MARKER_ID,
    });
    root.assertCoordinationNamespace();
    store = DerivedStore.open({ state: "READ_WRITE", root });
    gate = CapacityGate.open({
      mediaRoot: root.canonicalPath,
      expectedMarkerId: root.markerId,
    });
    const uploadRepository = new MySqlUploadRepository(database.pool),
      uploadMutex = new UploadMutex();
    owner = new StorageRuntimeOwner(
      { capability: { state: "READ_WRITE", root }, store, gate },
      database.pool,
      control.repository,
      {
        mediaRoot: root.canonicalPath,
        markerId: root.markerId,
        roles: configuredControlRoles(["PURGE"]),
      },
      async (permit, resources) => {
        const assessed = await permit.run("STARTUP_ASSESS", () =>
          assessStorageStartup(
            uploadRepository,
            resources.capability,
            uploadMutex,
          ),
        );
        if (assessed.capability.state !== "READ_WRITE")
          throw Error("STORAGE_STARTUP_RECOVERY_INCOMPLETE");
        return true;
      },
      (resources) =>
        confirmStorageStartup(
          uploadRepository,
          resources.capability,
          uploadMutex,
        ),
    );
    control.bindOwner?.(owner);
    const resources = owner.resources;
    const withProcessor = <T>(
      operation: (processor: PurgeProcessor) => Promise<T>,
    ) =>
      resources.withValue(async (r) => {
        if (r.capability.state !== "READ_WRITE" || !r.store || !r.gate)
          throw new ControlAdmissionError("WRITE_PAUSED");
        return operation(
          new PurgeProcessor(
            database.pool,
            r.capability.root,
            r.store,
            r.gate,
            undefined,
            control.admission,
          ),
        );
      });
    await control.start?.([{ role: "PURGE", ready: () => !stopping }]);
    logger.info(
      { service: "worker", appEnv: env.APP_ENV },
      "Purge worker ready",
    );
    let after: Parameters<PurgeScheduler["scan"]>[1];
    while (!stopping) {
      try {
        await control.admission.run("MEDIA_WRITE", () =>
          withProcessor((processor) =>
            runCheckedTransaction(database.pool, (c) =>
              processor.repository.recoverExhausted(c),
            ),
          ),
        );
        try {
          after =
            (
              await control.admission.run("MEDIA_WRITE", () =>
                resources.withValue(async (r) => {
                  if (r.capability.state !== "READ_WRITE")
                    throw new ControlAdmissionError("WRITE_PAUSED");
                  return new PurgeScheduler(
                    new PurgeScheduleRepository(database.pool),
                    r.capability.root,
                  ).scan(20, after);
                }),
              )
            ).next ?? undefined;
        } catch (error) {
          if (error instanceof ControlAdmissionError) throw error;
          logger.warn({ category: "TRANSIENT_DB" }, "Purge scheduler deferred");
        }
        if (stopping) break;
        try {
          const run = () =>
            control.admission.run("MEDIA_WRITE", () =>
              withProcessor((processor) => processor.runNext()),
            );
          const processed = control.track
            ? await control.track("PURGE", run)
            : await run();
          if (!processed) await delay(1000);
        } catch {
          logger.warn({ category: "TRANSIENT_DB" }, "Purge worker deferred");
          await delay(1000);
        }
      } catch (error) {
        if (!(error instanceof ControlAdmissionError)) throw error;
        await delay(1000);
      }
    }
  } finally {
    let drained = true;
    control.stop?.();
    try {
      await control.drain?.();
    } catch {
      drained = false;
      logger.error(
        { category: "DB_UNAVAILABLE" },
        "Purge heartbeat exit unavailable",
      );
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    let resourcesClosed = false;
    try {
      if (owner) await owner.resources.close();
      else {
        gate?.close();
        store?.close();
        root?.close();
      }
      resourcesClosed = true;
    } finally {
      await control.resourcesClosed?.(resourcesClosed && drained);
      await database.pool.end();
    }
  }
}
void main().catch(() => {
  logger.error(
    { category: "INVARIANT_VIOLATION" },
    "Purge worker startup or execution refused",
  );
  process.exitCode = 1;
});
