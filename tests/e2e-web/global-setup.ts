import type { FullConfig } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireCheckedConnection,
  assertMigrationReadiness,
  createDatabase,
  MySqlSystemRunRepository,
} from "../../packages/db/src/index.js";
import { hashPassword } from "../../packages/auth/src/index.js";
import { DevControlHarness } from "../helpers/dev-control-harness.js";
import {
  awaitControlledWebNoInstances,
  controlledWebPassword,
} from "../helpers/controlled-web-runtime.js";
import type { WebAcceptanceStorage } from "./storage-harness.js";
import {
  webClosureReceiptPath,
  writeWebClosureReceipt,
} from "../helpers/finalize-controlled-web.js";

export default async function globalSetup(config: FullConfig) {
  const receiptPath = webClosureReceiptPath(
    process.env.PHASE11_WEB_CLOSURE_RECEIPT,
  );
  process.loadEnvFile(resolve(".env"));
  const target = new URL(process.env.DATABASE_URL!);
  if (
    target.pathname !== "/family_album_dev" ||
    target.username.toLowerCase() === "root"
  )
    throw Error("WEB_CONTROL_DEV_DATABASE_REQUIRED");
  const storage = config.metadata
    .phase6d5WebAcceptanceStorage as WebAcceptanceStorage;
  const db = createDatabase(process.env.DATABASE_URL!);
  let control: DevControlHarness | undefined;
  let api: ChildProcess | undefined;
  let metadata: ChildProcess | undefined;
  let web: ChildProcess | undefined;
  const pipeline = process.env.DEV_MEDIA_PIPELINE_ENABLED === "1";
  const roles = pipeline ? ["API", "DERIVATIVE", "METADATA"] : ["API"];
  const apiLog = createWriteStream(storage.apiObservationLog, {
    flags: "wx",
    mode: 0o600,
  });
  async function until(check: () => Promise<boolean>) {
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      if (await check()) return;
      if (api?.exitCode !== null && api?.exitCode !== undefined)
        throw Error("WEB_CONTROL_API_EXITED");
      if (metadata?.exitCode !== null && metadata?.exitCode !== undefined)
        throw Error("WEB_CONTROL_METADATA_EXITED");
      await delay(100);
    }
    throw Error("WEB_CONTROL_READY_TIMEOUT");
  }
  async function stop(child: ChildProcess | undefined, media: boolean) {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("WEB_CONTROL_CHILD_JOIN_UNCONFIRMED")),
              15000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (media && child.exitCode !== 0)
      throw Error("WEB_CONTROL_MEDIA_EXIT_UNCONFIRMED");
    if (!media && child.exitCode !== 0 && child.signalCode !== "SIGTERM")
      throw Error("WEB_CONTROL_FRONTEND_EXIT_UNCONFIRMED");
  }
  async function shutdown(ready: boolean) {
    let failure: unknown;
    let finalControl: DevControlHarness | undefined;
    try {
      await stop(web, false);
      if (control) {
        // A test worker may have rotated this exact actor's session and added
        // the legitimate READ_ONLY operation to the persisted owned manifest.
        finalControl = await DevControlHarness.resume(
          db.pool,
          control.env.DEV_CONTROL_DEPLOYMENT_ID!,
        );
        await finalControl.reauthenticate(controlledWebPassword);
        await finalControl.request("READ_ONLY");
      }
    } catch (error) {
      failure = error;
    }
    for (const [child, media] of [
      [api, true],
      [metadata, true],
      [web, false],
    ] as const) {
      try {
        await stop(child, media);
      } catch (error) {
        failure ??= error;
      }
    }
    await new Promise<void>((done) => apiLog.end(done));
    try {
      if (failure) throw failure;
      if (!ready || !finalControl)
        throw Error("WEB_CONTROL_STARTUP_UNCONFIRMED_FIXTURE_RETAINED");
      const run = await new MySqlSystemRunRepository(db.pool).observeCurrent();
      if (run?.phase !== "CLEAN" || run.clean_at === null)
        throw Error("WEB_CONTROL_CLEAN_UNCONFIRMED_FIXTURE_RETAINED");
      writeWebClosureReceipt(receiptPath, {
        version: 1,
        state: "CLOSED_AWAITING_INSTANCE_PROOF",
        capturedAtUTC: new Date().toISOString(),
        deploymentId: finalControl.env.DEV_CONTROL_DEPLOYMENT_ID!,
        runId: run.id,
        cleanAt: run.clean_at,
        roles,
        childExitCodes: [api?.exitCode ?? null, metadata?.exitCode ?? null],
        storage,
      });
    } finally {
      await db.pool.end();
    }
  }
  try {
    const connection = await acquireCheckedConnection(db.pool);
    try {
      await assertMigrationReadiness(connection);
      await awaitControlledWebNoInstances(connection);
    } finally {
      connection.release();
    }
    control = await DevControlHarness.create(
      db.pool,
      await hashPassword(controlledWebPassword),
      [],
      roles.join(","),
    );
    process.env.PHASE11_WEB_CONTROL_DEPLOYMENT_ID =
      control.env.DEV_CONTROL_DEPLOYMENT_ID!;
    writeFileSync(
      resolve(
        `.cache/phase11-current/web-owned-${control.env.DEV_CONTROL_DEPLOYMENT_ID!}.json`,
      ),
      JSON.stringify({
        capturedAtUTC: new Date().toISOString(),
        deploymentId: control.env.DEV_CONTROL_DEPLOYMENT_ID,
        roles,
        storage,
      }),
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      ...control.env,
      APP_ENV: "dev",
      NODE_ENV: "test",
      API_HOST: "127.0.0.1",
      API_PORT: "4400",
      API_PUBLIC_ORIGIN: "https://localhost:3443",
      TRUSTED_WEB_ORIGINS: "https://localhost:3443",
      DEV_MEDIA_ROOT: storage.mediaRoot,
      DEV_STORAGE_MARKER_ID: storage.markerId,
      DEV_MEDIA_PIPELINE_ENABLED: pipeline ? "1" : "0",
      LOCATION_DATA_DIR: resolve("resources/location/2026-10-03"),
      LOG_LEVEL: "info",
    };
    api = spawn(
      process.execPath,
      ["--import", "tsx", "apps/api/dist/index.js"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    api.stdout!.pipe(apiLog, { end: false });
    api.stderr!.pipe(apiLog, { end: false });
    await until(async () =>
      fetch("http://127.0.0.1:4400/health")
        .then((r) => r.ok)
        .catch(() => false),
    );
    if (pipeline)
      metadata = spawn(
        process.execPath,
        ["--import", "tsx", "apps/worker/dist/metadata-main.js"],
        { env, stdio: "ignore" },
      );
    await control.observeRoles(roles, true);
    await control.waitStable("READ_ONLY");
    if (
      (await new MySqlSystemRunRepository(db.pool).observeCurrent())?.phase !==
      "ACTIVE"
    )
      throw Error("WEB_CONTROL_ACTIVE_RUN_REQUIRED");
    await control.request("NORMAL");
    web = spawn(process.execPath, ["tests/e2e-web/start-web-https.mjs"], {
      env: { ...env, NODE_ENV: "development" },
      stdio: "ignore",
    });
    await until(async () =>
      fetch("https://localhost:3443/login")
        .then((r) => r.ok)
        .catch(() => false),
    );
    return () => shutdown(true);
  } catch (error) {
    try {
      await shutdown(false);
    } catch {
      // Failure remains a failed setup; retain its exact control/media roots.
    }
    throw error;
  }
}
