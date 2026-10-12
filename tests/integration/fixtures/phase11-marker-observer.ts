import { createDatabase } from "../../../packages/db/src/index.js";
import { loadDeploymentControl } from "../../../apps/worker/src/deployment-control.js";

const db = createDatabase(process.env.DATABASE_URL!);
try {
  const control = await loadDeploymentControl(db.pool, {
    APP_ENV: "dev",
    DATABASE_URL: process.env.DATABASE_URL!,
  });
  if (control.startupWritable) throw Error("RESTART_GRANTED_WRITE");
  let admitted = false;
  await control.admission
    .run("MEDIA_WRITE", async () => {
      admitted = true;
    })
    .catch(() => {});
  if (admitted) throw Error("RESTART_ADMITTED_WRITE");
  const current = await control.repository.readCurrent();
  if (!current.faultLatched || current.enforcedMode !== "READ_ONLY")
    throw Error("RESTART_PROTECTION_UNCONFIRMED");
  console.log("FRESH_PROCESS_BOOTSTRAP_PROTECTED");
} catch {
  console.error("FRESH_PROCESS_BOOTSTRAP_UNCONFIRMED");
  process.exitCode = 1;
} finally {
  await db.pool.end();
}
