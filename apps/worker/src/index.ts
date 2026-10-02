import pino from "pino";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLoggerOptions, loadApiEnv } from "@family-album/config";
import {
  createDatabase,
  acquireCheckedConnection,
  assertMigrationReadiness,
  runCheckedTransaction,
} from "@family-album/db";
import { StorageRoot, DerivedStore, CapacityGate } from "@family-album/storage";
import { PurgeProcessor } from "./purge-processor.js";
import { PurgeScheduler } from "./purge-scheduler.js";
import { PurgeScheduleRepository } from "../../../packages/db/src/purge-scheduler.js";
export { MetadataProcessingService } from "./metadata-processor.js";

const logger = pino(createLoggerOptions());
async function main() {
  const env = loadApiEnv();
  if (env.APP_ENV !== "dev" || !env.DEV_STORAGE_MARKER_ID)
    throw new Error("PURGE_DEV_ROOT_REQUIRED");
  const database = createDatabase(env.DATABASE_URL);
  let root: StorageRoot | undefined,
    store: DerivedStore | undefined,
    gate: CapacityGate | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
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
    // Exclusive Original and Derived writers must belong to this controlled
    // process. A running API writer causes startup refusal before any claim.
    root = StorageRoot.open(resolve(env.DEV_MEDIA_ROOT), {
      initialize: false,
      expectedMarkerId: env.DEV_STORAGE_MARKER_ID,
    });
    store = DerivedStore.open({ state: "READ_WRITE", root });
    gate = CapacityGate.open({
      mediaRoot: root.canonicalPath,
      expectedMarkerId: root.markerId,
    });
    const processor = new PurgeProcessor(database.pool, root, store, gate);
    const scheduler = new PurgeScheduler(
      new PurgeScheduleRepository(database.pool),
      root,
    );
    logger.info(
      { service: "worker", appEnv: env.APP_ENV },
      "Purge worker ready",
    );
    let after: Parameters<PurgeScheduler["scan"]>[1];
    while (!stopping) {
      await runCheckedTransaction(database.pool, (c) =>
        processor.repository.recoverExhausted(c),
      );
      try {
        after = (await scheduler.scan(20, after)).next ?? undefined;
      } catch {
        logger.warn({ category: "TRANSIENT_DB" }, "Purge scheduler deferred");
      }
      if (stopping) break;
      try {
        if (!(await processor.runNext())) await delay(1000);
      } catch {
        logger.warn({ category: "TRANSIENT_DB" }, "Purge worker deferred");
        await delay(1000);
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    gate?.close();
    store?.close();
    root?.close();
    await database.pool.end();
  }
}
void main().catch(() => {
  logger.error(
    { category: "INVARIANT_VIOLATION" },
    "Purge worker startup or execution refused",
  );
  process.exitCode = 1;
});
