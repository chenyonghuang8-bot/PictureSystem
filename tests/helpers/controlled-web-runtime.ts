import { DevControlHarness } from "./dev-control-harness.js";
import type {
  Pool,
  RowDataPacket,
  acquireCheckedConnection,
} from "../../packages/db/src/index.js";
import { assertNoPhase11DevInstances } from "../../packages/db/scripts/phase11-instance-proof.js";
import { setTimeout as delay } from "node:timers/promises";

export const controlledWebPassword = "synthetic-web-control-password";

/** CLI exit can precede an owned loader/compiler's final OS exit. Admission
 * still requires the unchanged strict proof to actually pass; time alone is
 * never evidence of drain, and persistent/unknown observations fail closed. */
export async function awaitControlledWebNoInstances(
  connection: Awaited<ReturnType<typeof acquireCheckedConnection>>,
) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return await assertNoPhase11DevInstances(connection, process.cwd());
    } catch (error) {
      if (
        !(error instanceof Error) ||
        ![
          "PHASE11_OTHER_WORKSPACE_PROCESS_PRESENT",
          "PHASE11_INSTANCE_PROOF_UNAVAILABLE",
        ].includes(error.message) ||
        Date.now() >= deadline
      )
        throw error;
      await delay(100);
    }
  }
}

/** The global setup owns this exact synthetic deployment. Drain its actual
 * media work before a worker removes its own disposable database fixtures. */
export async function pauseControlledWebRuntime(pool: Pool) {
  const deploymentId = process.env.PHASE11_WEB_CONTROL_DEPLOYMENT_ID;
  if (!deploymentId) throw Error("OWNED_WEB_CONTROL_DEPLOYMENT_REQUIRED");
  const control = await DevControlHarness.resume(pool, deploymentId);
  await control.reauthenticate(controlledWebPassword);
  await control.request("READ_ONLY");
}

export async function assertControlledMetadataAvailable(pool: Pool) {
  const deploymentId = process.env.PHASE11_WEB_CONTROL_DEPLOYMENT_ID;
  if (!deploymentId) throw Error("OWNED_WEB_CONTROL_DEPLOYMENT_REQUIRED");
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) n FROM system_control c JOIN system_control_runs r ON r.id=c.current_run_id JOIN system_control_run_members m ON m.run_id=r.id JOIN admin_runtime_observations b ON b.boot_id=m.boot_id WHERE c.id=1 AND c.deployment_id=? AND r.phase='ACTIVE' AND m.role='METADATA' AND m.state='READY' AND b.exited_at IS NULL AND b.received_at>=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 10 SECOND)",
    [deploymentId],
  );
  if (String(rows[0]?.n) !== "1") throw Error("REAL_METADATA_UNAVAILABLE");
}
