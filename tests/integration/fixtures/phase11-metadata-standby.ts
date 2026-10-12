import { resolve } from "node:path";
import { loadApiEnv } from "../../../packages/config/src/index.js";
import {
  createDatabase,
  MySqlJobRepository,
  runCheckedTransaction,
} from "../../../packages/db/dist/index.js";
import { setTimeout as delay } from "node:timers/promises";
import { OriginalReader } from "../../../packages/storage/src/index.js";
import { loadLocationProjector } from "../../../packages/media/src/index.js";
import { loadDeploymentControl } from "../../../apps/worker/src/deployment-control.js";
import { MetadataJobDriver } from "../../../apps/worker/src/metadata-driver.js";
import { MetadataJobLoop } from "../../../apps/worker/src/metadata-job-loop.js";

/** Real independent METADATA participant with an explicit scheduler barrier.
 * It registers before activation and holds its actual reader/health heartbeat.
 * IPC controls scheduling only; every transaction still uses real admission. */
async function main() {
  const env = loadApiEnv();
  const target = new URL(env.DATABASE_URL);
  if (
    env.APP_ENV !== "dev" ||
    target.pathname !== "/family_album_dev" ||
    target.username.toLowerCase() === "root" ||
    !env.DEV_STORAGE_MARKER_ID ||
    !process.connected ||
    !process.env.LOCATION_DATA_DIR
  )
    throw Error("METADATA_STANDBY_DEV_ONLY");
  const db = createDatabase(env.DATABASE_URL);
  const control = await loadDeploymentControl(db.pool, env, {
    path: process.env.DEV_CONTROL_PATH,
    deploymentId: process.env.DEV_CONTROL_DEPLOYMENT_ID,
    roles: ["METADATA"],
    mediaRoot: resolve(env.DEV_MEDIA_ROOT),
    markerId: env.DEV_STORAGE_MARKER_ID,
  });
  let reader: OriginalReader | undefined,
    loop: MetadataJobLoop | undefined,
    stopping = false;
  let seedWork: Promise<unknown> | undefined;
  let resume!: () => void;
  const barrier = new Promise<void>((r) => {
    resume = r;
  });
  const message = (m: unknown) => {
    if (m === "resume-metadata") resume();
    if (m === "prepare-expired-test-leases") {
      if (seedWork || stopping) return;
      seedWork = control.admission
        .run("MEDIA_WRITE", () =>
          control.track!("METADATA", async () => {
            const familyId = process.env.PHASE11_METADATA_TEST_FAMILY;
            if (!familyId || !/^[1-9][0-9]*$/.test(familyId))
              throw Error("EXACT_SYNTHETIC_FAMILY_REQUIRED");
            const jobs = new MySqlJobRepository(db.pool),
              identity = MySqlJobRepository.createWorkerIdentity();
            const claims = [];
            for (
              let attempt = 0;
              attempt < 40 && claims.length < 2;
              attempt++
            ) {
              const claim = await jobs.claimNext(identity, {
                jobType: "MEDIA_PROBE",
              });
              if (claim) {
                if (claim.familyId !== familyId)
                  throw Error("EXACT_SYNTHETIC_CLAIM_REQUIRED");
                claims.push(claim);
              } else await delay(50);
            }
            if (claims.length !== 2)
              throw Error("TEST_LEASE_PREPARATION_UNCONFIRMED");
            await runCheckedTransaction(db.pool, async (c) => {
              for (const claim of claims)
                await c.query(
                  "UPDATE background_jobs SET locked_at=UTC_TIMESTAMP(3)-INTERVAL 2 MINUTE,heartbeat_at=UTC_TIMESTAMP(3)-INTERVAL 2 MINUTE,locked_until=UTC_TIMESTAMP(3)-INTERVAL 1 MINUTE WHERE family_id=? AND id=? AND state='RUNNING' AND worker_id=? AND lease_epoch=?",
                  [familyId, claim.id, identity, claim.leaseEpoch.toString()],
                );
            });
            process.send?.({
              kind: "expired-test-leases-ready",
              claims: claims.map((c) => ({
                id: c.id,
                familyId: c.familyId,
                mediaId: c.mediaId,
                generation: c.generation.toString(),
              })),
            });
          }),
        )
        .catch(() => process.send?.({ kind: "expired-test-leases-failed" }));
    }
  };
  const stop = () => {
    void control.beginShutdown?.().catch(() => {});
    stopping = true;
    loop?.requestStop();
    resume();
    control.stop?.();
  };
  process.on("message", message);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  control.onStopping?.(stop);
  try {
    if (!control.gate) throw Error("CONTROL_RUN_REQUIRED");
    reader = OriginalReader.open({
      mediaRoot: resolve(env.DEV_MEDIA_ROOT),
      expectedMarkerId: env.DEV_STORAGE_MARKER_ID,
    });
    const current = reader;
    control.bindHealth?.(async () => current.assertIdentity());
    const driver = new MetadataJobDriver(
      db.pool,
      reader,
      loadLocationProjector(resolve(process.env.LOCATION_DATA_DIR)),
      undefined,
      {
        run: (action, operation) =>
          control.admission.run(action, () =>
            control.track!("METADATA", operation),
          ),
      },
    );
    loop = new MetadataJobLoop(driver);
    await control.start!([
      { role: "METADATA", ready: () => reader !== undefined && !stopping },
    ]);
    process.send?.("metadata-standby-ready");
    await barrier;
    if (!stopping) await loop.start();
  } finally {
    control.stop?.();
    let closed = true;
    try {
      await seedWork;
      await loop?.drain();
      await control.drain?.();
    } catch {
      closed = false;
    }
    process.off("message", message);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    try {
      reader?.close();
    } catch {
      closed = false;
    }
    await control.resourcesClosed?.(closed);
    await db.pool.end();
  }
}
void main().catch(() => {
  console.error(
    '{"event":"metadata_standby_failed","category":"EXECUTION_REFUSED_OR_UNKNOWN"}',
  );
  process.exitCode = 1;
});
