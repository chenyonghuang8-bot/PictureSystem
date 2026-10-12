import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  createDatabase,
  acquireCheckedConnection,
  assertMigrationReadiness,
} from "../../../packages/db/src/index.js";
import { assertNoPhase11DevInstances } from "../../../packages/db/scripts/phase11-instance-proof.js";
import { hashPassword } from "../../../packages/auth/src/index.js";
import { StorageRoot } from "../../../packages/storage/src/index.js";
import { DevControlHarness } from "../../helpers/dev-control-harness.js";
const db = createDatabase(process.env.DATABASE_URL!),
  connections = new Set<Socket>(),
  upstream = new URL(process.env.DATABASE_URL!);
let online = true,
  api: ChildProcess | undefined,
  h: DevControlHarness | undefined,
  stage = "PREFLIGHT",
  base = "",
  token = "";
const proxy = createServer((client) => {
  if (!online) {
    client.destroy();
    return;
  }
  const remote = connect({
    host: upstream.hostname,
    port: Number(upstream.port || 3306),
  });
  for (const socket of [client, remote]) {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {
      client.destroy();
      remote.destroy();
    });
  }
  client.pipe(remote);
  remote.pipe(client);
});
async function until(run: () => Promise<boolean>, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await run()) return;
    await delay(100);
  }
  throw Error("BOUNDED_EVIDENCE_NOT_OBSERVED");
}
async function stop() {
  const child = api;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    api = undefined;
    return;
  }
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    closed,
    delay(15000).then(() => {
      throw Error("ACTUAL_API_DRAIN_UNCONFIRMED");
    }),
  ]);
  api = undefined;
}
async function marker() {
  const s = await h!.gate.acquire("S", 0);
  try {
    return !!s.readDeny();
  } finally {
    s.close();
  }
}
let apiEnv: NodeJS.ProcessEnv;
async function start() {
  api = spawn(process.execPath, ["--import", "tsx", "apps/api/dist/index.js"], {
    env: apiEnv,
    stdio: "ignore",
  });
  await until(() =>
    fetch(base + "/health")
      .then((r) => r.ok)
      .catch(() => false),
  );
  await h!.observeRoles(["API"], true);
}
async function write() {
  return fetch(base + "/api/v1/albums", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      familyId: h!.syntheticIdentity.familyId,
      name: "must-not-create",
      visibility: "FAMILY",
    }),
  });
}
try {
  const c = await acquireCheckedConnection(db.pool);
  try {
    await assertMigrationReadiness(c);
    await assertNoPhase11DevInstances(c, process.cwd());
  } finally {
    c.release();
  }
  h = await DevControlHarness.create(
    db.pool,
    await hashPassword("synthetic-outage-password"),
    [],
    "API",
  );
  const folder = mkdtempSync(join(realpathSync(tmpdir()), "phase11-outage-")),
    mediaRoot = join(folder, "r"),
    root = StorageRoot.open(mediaRoot, { initialize: true });
  mkdirSync(join(mediaRoot, "derived"), { mode: 0o700 });
  root.provisionSharedCapacityLockForDev();
  root.provisionDerivedWriterLockForDev();
  const storageMarker = root.markerId;
  root.close();
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyPort = (proxy.address() as { port: number }).port;
  const scopedUrl = new URL(upstream);
  scopedUrl.hostname = "127.0.0.1";
  scopedUrl.port = String(proxyPort);
  const portReservation = createServer();
  await new Promise<void>((r) => portReservation.listen(0, "127.0.0.1", r));
  const apiPort = (portReservation.address() as { port: number }).port;
  await new Promise<void>((r) => portReservation.close(() => r()));
  base = `http://127.0.0.1:${apiPort}`;
  apiEnv = {
    ...process.env,
    ...h.env,
    DATABASE_URL: scopedUrl.toString(),
    APP_ENV: "dev",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    API_PUBLIC_ORIGIN: `https://localhost:${apiPort}`,
    TRUSTED_WEB_ORIGINS: "https://localhost:3000",
    DEV_MEDIA_ROOT: mediaRoot,
    DEV_STORAGE_MARKER_ID: storageMarker,
    DEV_MEDIA_PIPELINE_ENABLED: "0",
  };
  stage = "BOOTSTRAP";
  await start();
  await h.waitStable("READ_ONLY");
  await h.request("NORMAL");
  const login = await fetch(base + "/api/v1/auth/android/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: h.syntheticIdentity.username,
      password: "synthetic-outage-password",
    }),
  });
  assert.equal(login.status, 200);
  token = ((await login.json()) as { token: string }).token;
  assert(token);
  stage = "ACTUAL_TCP_DISCONNECT";
  online = false;
  for (const socket of connections) socket.destroy();
  assert.equal((await write()).status, 503);
  await until(async () => {
    try {
      return await marker();
    } catch {
      return false;
    }
  }, 25000);
  assert(await marker());
  stage = "OFFLINE_STOP";
  await stop();
  assert(await marker());
  stage = "OFFLINE_RESTART";
  api = spawn(process.execPath, ["--import", "tsx", "apps/api/dist/index.js"], {
    env: apiEnv,
    stdio: "ignore",
  });
  // Database-unavailable bootstrap may keep the command-only HTTP control
  // plane alive. Prove actual denial rather than requiring process death.
  await until(() =>
    fetch(base + "/health")
      .then((r) => r.ok)
      .catch(() => false),
  );
  assert.equal((await write()).status, 503);
  assert(await marker());
  await stop();
  stage = "ONLINE_RESTART";
  online = true;
  await start();
  await until(async () => {
    const current = await h!.repository.readCurrent();
    return current.faultLatched && current.enforcedMode === "READ_ONLY";
  });
  assert.equal((await write()).status, 503);
  assert(await marker());
  stage = "AUTHORIZED_RECHECK";
  await h.reauthenticate("synthetic-outage-password");
  await h.recheck();
  assert.equal((await h.repository.readCurrent()).enforcedMode, "READ_ONLY");
  assert.equal((await write()).status, 503);
  assert.equal(await marker(), false);
  const proof = {
    recordedAt: new Date().toISOString(),
    deploymentId: h.env.DEV_CONTROL_DEPLOYMENT_ID,
    actualTcpDisconnect: true,
    offlineNativeDenyPersisted: true,
    offlineRestartStayedProtected: true,
    offlineControlPlaneOnly: true,
    offlineProcessJoinedBeforeOnlineRestart: true,
    onlineRestartStayedProtected: true,
    explicitRecheckStayedReadOnly: true,
    syntheticFamilyId: h.syntheticIdentity.familyId,
  };
  writeFileSync(
    ".cache/phase11-current/database-outage-proof.json",
    JSON.stringify(proof, null, 2),
    { mode: 0o600 },
  );
  console.log(
    "ACTUAL_TCP_OUTAGE_DURABLE_DENY_OFFLINE_RESTART_FRESH_RECHECK_PASS",
  );
  stage = "EXACT_CLEANUP";
  await stop();
  await h.cleanup();
  console.log("EXACT_OUTAGE_FIXTURE_CLEANED_HISTORY_RETAINED");
} catch (error) {
  console.error(
    JSON.stringify({
      event: "ACTUAL_OUTAGE_ACCEPTANCE_UNCONFIRMED",
      stage,
      category: error instanceof Error ? error.name : "UNKNOWN",
    }),
  );
  process.exitCode = 1;
} finally {
  online = true;
  try {
    await stop();
  } catch {
    process.exitCode = 1;
  }
  for (const socket of connections) socket.destroy();
  await new Promise<void>((r) => proxy.close(() => r()));
  await db.pool.end();
}
