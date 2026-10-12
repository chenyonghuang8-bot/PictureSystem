import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DevControlHarness } from "./dev-control-harness.js";

/** Called only after the prior fixture owner has drained and closed. */
export async function restartBuiltControlApi(
  h: DevControlHarness,
  media: { path: string; marker: string },
  options: {
    requireMetadata?: boolean;
    fullProcessSet?: boolean;
    pauseRecoveryReturn?: boolean;
    recordLoss?: {
      stage: "BEGIN" | "AUTO_ACTIVE" | "STOPPING" | "ACK" | "CLEAN";
      evidencePath: string;
    };
    failureBoundary?: {
      stage: "PREPARING" | "STOPPING" | "CLOSE_FAILURE" | "CLEAN_AUDIT_FAILURE";
      evidencePath: string;
    };
  } = {},
) {
  const reservation = createServer();
  await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((r) => reservation.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      ...(options.recordLoss
        ? [
            "--import",
            resolve("tests/integration/fixtures/phase11-run-commit-loss.mjs"),
          ]
        : []),
      ...(options.failureBoundary
        ? [
            "--import",
            resolve(
              "tests/integration/fixtures/phase11-run-failure-boundary.mjs",
            ),
          ]
        : []),
      ...(options.pauseRecoveryReturn
        ? [
            "--import",
            resolve(
              "tests/integration/fixtures/phase11-recovery-return-pause.mjs",
            ),
          ]
        : []),
      "apps/api/dist/index.js",
    ],
    {
      env: {
        ...process.env,
        ...h.env,
        APP_ENV: "dev",
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        API_HOST: "127.0.0.1",
        API_PORT: String(port),
        API_PUBLIC_ORIGIN: `https://localhost:${port}`,
        TRUSTED_WEB_ORIGINS: "https://localhost:3000",
        DEV_MEDIA_ROOT: media.path,
        DEV_STORAGE_MARKER_ID: media.marker,
        DEV_MEDIA_PIPELINE_ENABLED: options.fullProcessSet ? "1" : "0",
        DEV_CONTROL_REQUIRED_ROLES: options.fullProcessSet
          ? "API,DERIVATIVE,METADATA"
          : options.requireMetadata
            ? "API,METADATA"
            : "API",
        LOCATION_DATA_DIR: resolve("resources/location/2026-10-03"),
        ...(options.recordLoss
          ? {
              PHASE11_RUN_RECORD_LOSS: options.recordLoss.stage,
              PHASE11_RUN_RECORD_EVIDENCE: options.recordLoss.evidencePath,
            }
          : {}),
        ...(options.failureBoundary
          ? {
              PHASE11_RUN_FAILURE_BOUNDARY: options.failureBoundary.stage,
              PHASE11_RUN_FAILURE_EVIDENCE:
                options.failureBoundary.evidencePath,
            }
          : {}),
      },
      stdio: options.pauseRecoveryReturn
        ? ["ignore", "ignore", "ignore", "ipc"]
        : "ignore",
    },
  );
  let recoveryReturnPaused = false;
  child.on("message", (message) => {
    if (message === "recovery-return-paused") recoveryReturnPaused = true;
  });
  const resumeRecoveryReturn = () => {
    if (options.pauseRecoveryReturn && child.connected)
      child.send("release-recovery-return");
  };
  const waitRecoveryReturnPaused = async () => {
    if (!options.pauseRecoveryReturn)
      throw Error("RECOVERY_BARRIER_NOT_CONFIGURED");
    const end = Date.now() + 15000;
    while (!recoveryReturnPaused) {
      if (Date.now() > end) throw Error("ACTUAL_RECOVERY_RETURN_NOT_PAUSED");
      await delay(50);
    }
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      delay(15_000).then(() => {
        if (child.exitCode === null && child.signalCode === null) {
          throw Error("OWNED_API_DRAIN_UNCONFIRMED");
        }
      }),
    ]);
  };
  const crash = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    // Intentional crash injection on this exact freshly spawned owned child.
    // Ordinary timeout/shutdown never reaches this method.
    child.kill("SIGKILL");
    await exited;
  };
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      if (child.exitCode !== null) throw Error("OWNED_API_BOOTSTRAP_EXITED");
      if (
        await fetch(base + "/health")
          .then((r) => r.ok)
          .catch(() => false)
      )
        break;
      if (Date.now() >= deadline) throw Error("OWNED_API_BOOTSTRAP_TIMEOUT");
      await delay(50);
    }
    await h.observeRoles(["API"], true);
    return {
      base,
      stop,
      crash,
      waitRecoveryReturnPaused,
      resumeRecoveryReturn,
    };
  } catch (error) {
    resumeRecoveryReturn();
    await stop();
    throw error;
  }
}
