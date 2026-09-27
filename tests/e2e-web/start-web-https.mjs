import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const certificateDirectory = mkdtempSync(
  join(tmpdir(), "picturesystem-phase5-https-"),
);
const key = join(certificateDirectory, "localhost-key.pem");
const certificate = join(certificateDirectory, "localhost-cert.pem");
const generated = spawnSync(
  "/usr/bin/openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    certificate,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ],
  { stdio: "ignore" },
);

if (generated.status !== 0) {
  rmSync(certificateDirectory, { recursive: true, force: true });
  throw new Error("PHASE5_WEB_E2E_CERTIFICATE_GENERATION_FAILED");
}

const child = spawn(
  "pnpm",
  [
    "--dir",
    "apps/web",
    "exec",
    "next",
    "dev",
    "--webpack",
    "--experimental-https",
    "--experimental-https-key",
    key,
    "--experimental-https-cert",
    certificate,
    "--hostname",
    "localhost",
    "--port",
    "3443",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      FAMILY_ALBUM_API_ORIGIN: "http://127.0.0.1:4400",
    },
    stdio: "inherit",
  },
);

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

child.once("exit", (code, signal) => {
  rmSync(certificateDirectory, { recursive: true, force: true });
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
