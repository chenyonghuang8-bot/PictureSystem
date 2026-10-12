import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { writeFileSync, appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { DevControlHarness } from "./dev-control-harness.js";
import { restartBuiltControlApi } from "./restart-built-control-api.js";

/** Actual bundled API/DERIVATIVE and independent bundled METADATA. */
export async function restartBuiltFullProcessSet(
  h: DevControlHarness,
  media: { path: string; marker: string },
  options: { pauseReadyHeartbeat?: boolean } = {},
) {
  writeFileSync(
    resolve(`.cache/phase11-r1/full-set-media-${h.deploymentId}.json`),
    JSON.stringify({ deploymentId: h.deploymentId, media }),
    { mode: 0o600 },
  );
  const api = await restartBuiltControlApi(h, media, {
    fullProcessSet: true,
    pauseRecoveryReturn: options.pauseReadyHeartbeat === true,
  });
  const metadata = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      ...(options.pauseReadyHeartbeat
        ? [
            "--import",
            resolve(
              "tests/integration/fixtures/phase11-ready-heartbeat-pause.mjs",
            ),
          ]
        : []),
      "apps/worker/dist/metadata-main.js",
    ],
    {
      env: {
        ...process.env,
        ...h.env,
        APP_ENV: "dev",
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        DEV_MEDIA_ROOT: media.path,
        DEV_STORAGE_MARKER_ID: media.marker,
        DEV_MEDIA_PIPELINE_ENABLED: "1",
        DEV_CONTROL_REQUIRED_ROLES: "API,DERIVATIVE,METADATA",
        LOCATION_DATA_DIR: resolve("resources/location/2026-10-03"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const log = resolve(
    `.cache/phase11-r1/full-set-metadata-${h.deploymentId}.log`,
  );
  for (const stream of [metadata.stdout, metadata.stderr])
    stream?.on("data", (chunk) => appendFileSync(log, chunk, { mode: 0o600 }));
  let readyHeartbeatPaused = false;
  let stoppingRecordPaused = false;
  metadata.on("message", (message) => {
    if (message === "ready-heartbeat-paused") readyHeartbeatPaused = true;
    if (message === "stopping-record-paused") stoppingRecordPaused = true;
  });
  const resumeReadyHeartbeat = () => {
    if (options.pauseReadyHeartbeat && metadata.connected)
      metadata.send("release-ready-heartbeat");
  };
  const waitReadyHeartbeatPaused = async () => {
    if (!options.pauseReadyHeartbeat)
      throw Error("READY_BARRIER_NOT_CONFIGURED");
    const end = Date.now() + 15000;
    while (!readyHeartbeatPaused) {
      if (Date.now() > end) throw Error("ACTUAL_READY_HEARTBEAT_NOT_PAUSED");
      await delay(50);
    }
  };
  const resumeStoppingRecord = () => {
    if (options.pauseReadyHeartbeat && metadata.connected)
      metadata.send("release-stopping-record");
  };
  const waitStoppingRecordPaused = async () => {
    if (!options.pauseReadyHeartbeat)
      throw Error("READY_BARRIER_NOT_CONFIGURED");
    const end = Date.now() + 10000;
    while (!stoppingRecordPaused) {
      if (Date.now() > end) throw Error("ACTUAL_STOPPING_RECORD_NOT_PAUSED");
      await delay(50);
    }
  };
  const stop = async () => {
    const exited =
      metadata.exitCode === null && metadata.signalCode === null
        ? once(metadata, "exit")
        : Promise.resolve();
    let apiFailure: unknown;
    try {
      await api.stop();
    } catch (error) {
      apiFailure = error;
    } finally {
      // An unconfirmed/recovery run may never enter STOPPING, so its peer
      // cannot rely on the coordinator callback to receive the stop intent.
      if (metadata.exitCode === null && metadata.signalCode === null)
        metadata.kill("SIGTERM");
    }
    await Promise.race([
      exited,
      delay(15000).then(() => {
        if (metadata.exitCode === null && metadata.signalCode === null)
          throw Error("OWNED_METADATA_DRAIN_UNCONFIRMED");
      }),
    ]);
    if (apiFailure) throw apiFailure;
  };
  try {
    await h.observeRoles(["DERIVATIVE", "METADATA"], true);
    return {
      base: api.base,
      stop,
      waitReadyHeartbeatPaused,
      resumeReadyHeartbeat,
      waitStoppingRecordPaused,
      resumeStoppingRecord,
      waitRecoveryReturnPaused: api.waitRecoveryReturnPaused,
      resumeRecoveryReturn: api.resumeRecoveryReturn,
    };
  } catch (error) {
    api.resumeRecoveryReturn();
    resumeReadyHeartbeat();
    resumeStoppingRecord();
    if (metadata.exitCode === null && metadata.signalCode === null)
      metadata.kill("SIGTERM");
    await stop();
    throw error;
  }
}
