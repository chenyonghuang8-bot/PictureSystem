import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const configuredCertificateDirectory =
  process.env.PHASE6D5_HTTPS_CERTIFICATE_DIRECTORY;
const configuredRunRoot = process.env.PHASE6D5_WEB_E2E_RUN_ROOT;
const configuredOwnershipNonce = process.env.PHASE6D5_WEB_E2E_OWNERSHIP_NONCE;
if (configuredCertificateDirectory) {
  assertConfiguredCertificateOwnership({
    certificateDirectory: configuredCertificateDirectory,
    runRoot: configuredRunRoot,
    ownershipNonce: configuredOwnershipNonce,
  });
}
const certificateDirectory = configuredCertificateDirectory
  ? configuredCertificateDirectory
  : mkdtempSync(join(tmpdir(), "picturesystem-phase5-https-"));
const standaloneCertificateDirectory = !configuredCertificateDirectory;
if (configuredCertificateDirectory) {
  mkdirSync(certificateDirectory, { mode: 0o700 });
}
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
  if (standaloneCertificateDirectory) {
    rmSync(certificateDirectory, { recursive: true, force: true });
  }
  throw new Error("PHASE5_WEB_E2E_CERTIFICATE_GENERATION_FAILED");
}

// Capture actual Next stdout/stderr only inside the already-validated owned run.
// Forward both streams unchanged; the observer must not redact or silence logs.
const webLog =
  configuredCertificateDirectory && configuredRunRoot
    ? createWriteStream(join(configuredRunRoot, "web-observation.log"), {
        flags: "wx",
        mode: 0o600,
      })
    : null;

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
    stdio: webLog ? ["ignore", "pipe", "pipe"] : "inherit",
  },
);

if (webLog) {
  for (const stream of [child.stdout, child.stderr]) {
    stream.pipe(webLog, { end: false });
    stream.pipe(stream === child.stdout ? process.stdout : process.stderr);
  }
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
  if (standaloneCertificateDirectory) {
    rmSync(certificateDirectory, { recursive: true, force: true });
  }
  const finish = () => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  };
  if (webLog) webLog.end(finish);
  else finish();
});

function assertConfiguredCertificateOwnership(input) {
  if (!input.runRoot || !input.ownershipNonce) {
    throw new Error("PHASE6D5_HTTPS_OWNERSHIP_REQUIRED");
  }
  const temporaryParent = realpathSync(tmpdir());
  const normalizedRoot = resolve(input.runRoot);
  if (
    normalizedRoot !== input.runRoot ||
    dirname(normalizedRoot) !== temporaryParent ||
    !basename(normalizedRoot).startsWith("picturesystem-phase5-web-e2e-") ||
    input.certificateDirectory !== join(normalizedRoot, "https-cert")
  ) {
    throw new Error("PHASE6D5_HTTPS_CONFINEMENT_REFUSED");
  }
  const rootStat = lstatSync(normalizedRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    realpathSync(normalizedRoot) !== normalizedRoot
  ) {
    throw new Error("PHASE6D5_HTTPS_ROOT_REFUSED");
  }
  const markerPath = join(normalizedRoot, ".picturesystem-web-e2e-owner.json");
  const markerStat = lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error("PHASE6D5_HTTPS_OWNER_MARKER_REFUSED");
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error("PHASE6D5_HTTPS_OWNER_MARKER_INVALID");
  }
  if (
    marker?.version !== 1 ||
    marker?.ownershipNonce !== input.ownershipNonce
  ) {
    throw new Error("PHASE6D5_HTTPS_OWNER_MARKER_MISMATCH");
  }
}
