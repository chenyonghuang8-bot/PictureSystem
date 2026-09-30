import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const logPath = process.env.PHASE6D5_API_OBSERVATION_LOG;
const envFile = process.env.PHASE6D5_API_ENV_FILE;
if (!logPath || !envFile) {
  throw new Error("PHASE6D5_API_OBSERVATION_CONFIG_REQUIRED");
}

const log = createWriteStream(logPath, { flags: "w", mode: 0o600 });
const child = spawn(
  process.execPath,
  [
    `--env-file=${envFile}`,
    "--import=tsx",
    resolve(root, "apps/api/src/index.ts"),
  ],
  { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);

for (const stream of [child.stdout, child.stderr]) {
  stream.pipe(log, { end: false });
  stream.pipe(stream === child.stdout ? process.stdout : process.stderr);
}

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

child.once("exit", (code, signal) => {
  log.end(() => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
});
