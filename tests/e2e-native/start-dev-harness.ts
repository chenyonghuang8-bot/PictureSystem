import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  writeFileSync,
  mkdirSync,
  chmodSync,
  createWriteStream,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  type RowDataPacket,
} from "../../packages/db/src/index.js";
import { hashPassword } from "../../packages/auth/src/index.js";
import { MemoriesFixture } from "../fixtures/memories-db.js";
import { syntheticHistoryJpeg } from "../fixtures/location-jpeg.js";
import {
  prepareWebAcceptanceStorage,
  cleanupWebAcceptanceStorage,
} from "../e2e-web/storage-harness.js";
process.loadEnvFile(resolve(".env"));
const target = new URL(process.env.DATABASE_URL!);
if (
  target.pathname !== "/family_album_dev" ||
  target.username.toLowerCase() === "root"
)
  throw new Error("SYNTHETIC_DEV_ONLY");
process.env.DEV_MEDIA_PIPELINE_ENABLED = "1";
if (
  !process.env.PHASE10_CLIENT_TLS_CERT_FILE ||
  !process.env.PHASE10_CLIENT_TLS_KEY_FILE
)
  throw new Error("TRUSTED_EXISTING_DEV_TLS_REQUIRED");
const storage = prepareWebAcceptanceStorage(),
  db = createDatabase(process.env.DATABASE_URL!),
  fixture = new MemoriesFixture(db.pool);
const children: ChildProcess[] = [];
let stopping = false;
const artifacts = resolve(".cache/phase10-native-tests");
mkdirSync(artifacts, { recursive: true });
chmodSync(artifacts, 0o700);
const password = "synthetic-" + randomUUID(),
  usernamePrefix = "p9mem_0";
const env = {
  ...process.env,
  APP_ENV: "dev",
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: "4400",
  API_PUBLIC_ORIGIN: "https://localhost:3443",
  TRUSTED_WEB_ORIGINS: "https://localhost:3443",
  DEV_MEDIA_ROOT: storage.mediaRoot,
  DEV_STORAGE_MARKER_ID: storage.markerId,
  LOG_LEVEL: "silent",
  PHASE6D5_API_ENV_FILE: resolve(".env"),
  LOCATION_DATA_DIR: resolve("resources/location/2026-10-03"),
};
function start(args: string[], name: string) {
  const p = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(resolve(artifacts, name + ".log"), {
    mode: 0o600,
  });
  p.stdout!.pipe(log, { end: false });
  p.stderr!.pipe(log, { end: false });
  p.once("exit", () => log.end());
  children.push(p);
  return p;
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    for (const c of [...children].reverse())
      if (c.exitCode === null && c.signalCode === null) {
        const done = once(c, "exit");
        c.kill("SIGTERM");
        const timer = setTimeout(() => c.kill("SIGKILL"), 10000);
        try {
          await done;
        } finally {
          clearTimeout(timer);
        }
      }
    const [members] = await db.pool.query<RowDataPacket[]>(
      "SELECT CAST(user_id AS CHAR) id FROM family_members WHERE family_id=?",
      [fixture.familyId],
    );
    for (const m of members)
      if (!fixture.users.includes(m.id)) fixture.users.push(m.id);
    await db.pool.query("DELETE FROM invitations WHERE family_id=?", [
      fixture.familyId,
    ]);
    await db.pool.query("DELETE FROM upload_album_targets WHERE family_id=?", [
      fixture.familyId,
    ]);
    await fixture.cleanup();
    await db.pool.end();
    cleanupWebAcceptanceStorage(storage);
    console.log("NATIVE_OWNED_FIXTURE_AND_SERVICES_CLEANED");
    process.exitCode = 0;
  } catch {
    console.error(
      "NATIVE_OWNED_CLEANUP_FAILED; retain protected metadata for exact cleanup",
    );
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await fixture.setup();
await db.pool.query("UPDATE users SET password_hash=? WHERE id=?", [
  await hashPassword(password),
  fixture.users[0],
]);
await db.pool.query("UPDATE family_members SET role='ADMIN' WHERE id=?", [
  fixture.memberId,
]);
await db.pool.query("UPDATE family_members SET role='SUPER_ADMIN' WHERE id=?", [
  fixture.otherMemberId,
]);
const base = await syntheticHistoryJpeg("2020-10-06");
const fileName = "phase10-native-" + fixture.suffix.slice(0, 8) + ".jpg";
// Valid synthetic JPEG with harmless trailing synthetic padding allows partial 4MiB observation.
writeFileSync(
  resolve(artifacts, fileName),
  Buffer.concat([base, Buffer.alloc(9 * 1024 * 1024, 0x61)]),
  { mode: 0o600 },
);
writeFileSync(
  resolve(artifacts, "runtime.json"),
  JSON.stringify({
    familyId: fixture.familyId,
    familyName: "p9-memories-" + fixture.suffix,
    users: fixture.users,
    username: usernamePrefix + fixture.suffix,
    password,
    fileName,
    runRoot: storage.runRoot,
    storage,
  }),
  { mode: 0o600 },
);
start(["--import=tsx", "tests/e2e-web/start-api-observed.mjs"], "api");
start(["tests/e2e-web/start-web-https.mjs"], "web");
start(
  ["--env-file=.env", "--import=tsx", "apps/worker/src/metadata-main.ts"],
  "metadata",
);
console.log(
  "NATIVE_DEV_HARNESS_STARTED; loopback only; protected synthetic runtime metadata saved",
);
