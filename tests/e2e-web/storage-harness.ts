import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { StorageRoot } from "../../packages/storage/src/index.js";

const ROOT_ENV = "PHASE5_WEB_E2E_MEDIA_ROOT";
const MARKER_ENV = "PHASE5_WEB_E2E_MARKER_ID";
const API_LOG_ENV = "PHASE6D5_API_OBSERVATION_LOG";
const CERTIFICATE_DIRECTORY_ENV = "PHASE6D5_HTTPS_CERTIFICATE_DIRECTORY";
const RUN_ROOT_ENV = "PHASE6D5_WEB_E2E_RUN_ROOT";
const OWNERSHIP_NONCE_ENV = "PHASE6D5_WEB_E2E_OWNERSHIP_NONCE";
const RUN_PREFIX = "picturesystem-phase5-web-e2e-";
const OWNERSHIP_FILE = ".picturesystem-web-e2e-owner.json";

export type WebAcceptanceStorage = {
  runRoot: string;
  ownershipNonce: string;
  mediaRoot: string;
  markerId: string;
  apiObservationLog: string;
  certificateDirectory: string;
};

const ownedRuns = new Map<string, WebAcceptanceStorage>();

export function prepareWebAcceptanceStorage(): WebAcceptanceStorage {
  const existingRunRoot = process.env[RUN_ROOT_ENV];
  if (existingRunRoot) {
    const registered = ownedRuns.get(existingRunRoot);
    if (registered) {
      if (!environmentMatches(registered)) {
        throw new Error("PHASE6D5_PREEXISTING_RUN_OWNERSHIP_REFUSED");
      }
      return registered;
    }
    const inherited = inheritedOwnedRun(existingRunRoot);
    assertOwnedLayout(inherited);
    ownedRuns.set(existingRunRoot, inherited);
    return inherited;
  }
  if (hasAnyHarnessEnvironment()) {
    throw new Error("PHASE6D5_PARTIAL_OR_EXTERNAL_RUN_REFUSED");
  }

  const temporaryParent = canonicalTemporaryParent();
  const runRoot = mkdtempSync(join(temporaryParent, RUN_PREFIX));
  chmodSync(runRoot, 0o700);
  const ownershipNonce = randomUUID();
  writeFileSync(
    join(runRoot, OWNERSHIP_FILE),
    JSON.stringify({ version: 1, ownershipNonce }),
    { flag: "wx", mode: 0o600 },
  );
  const mediaRoot = join(runRoot, "media");
  mkdirSync(mediaRoot, { mode: 0o700 });
  mkdirSync(join(mediaRoot, "derived"), { mode: 0o700 });
  const storage = StorageRoot.open(mediaRoot, { initialize: true });
  try {
    storage.provisionSharedCapacityLockForDev();
    const result: WebAcceptanceStorage = {
      runRoot,
      ownershipNonce,
      mediaRoot: storage.canonicalPath,
      markerId: storage.markerId,
      apiObservationLog: join(runRoot, "api-observation.log"),
      certificateDirectory: join(runRoot, "https-cert"),
    };
    assertOwnedLayout(result);
    ownedRuns.set(runRoot, result);
    setHarnessEnvironment(result);
    return result;
  } catch (error) {
    rmSync(runRoot, { recursive: true, force: true });
    throw error;
  } finally {
    storage.close();
  }
}

function inheritedOwnedRun(runRoot: string): WebAcceptanceStorage {
  const ownershipNonce = process.env[OWNERSHIP_NONCE_ENV];
  const mediaRoot = process.env[ROOT_ENV];
  const markerId = process.env[MARKER_ENV];
  const apiObservationLog = process.env[API_LOG_ENV];
  const certificateDirectory = process.env[CERTIFICATE_DIRECTORY_ENV];
  if (
    !ownershipNonce ||
    !mediaRoot ||
    !markerId ||
    !apiObservationLog ||
    !certificateDirectory
  ) {
    throw new Error("PHASE6D5_INHERITED_RUN_OWNERSHIP_INCOMPLETE");
  }
  return {
    runRoot,
    ownershipNonce,
    mediaRoot,
    markerId,
    apiObservationLog,
    certificateDirectory,
  };
}

export function cleanupWebAcceptanceStorage(
  candidate?: WebAcceptanceStorage,
): void {
  if (!candidate) return;
  assertOwnedLayout(candidate);
  rmSync(candidate.runRoot, { recursive: true, force: false });
  ownedRuns.delete(candidate.runRoot);
  clearMatchingHarnessEnvironment(candidate);
}

function assertOwnedLayout(candidate: WebAcceptanceStorage) {
  const temporaryParent = canonicalTemporaryParent();
  const normalizedRunRoot = resolve(candidate.runRoot);
  if (
    candidate.runRoot !== normalizedRunRoot ||
    dirname(normalizedRunRoot) !== temporaryParent ||
    !basename(normalizedRunRoot).startsWith(RUN_PREFIX)
  ) {
    throw new Error("PHASE6D5_RUN_ROOT_CONFINEMENT_REFUSED");
  }
  const rootStat = lstatSync(normalizedRunRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("PHASE6D5_RUN_ROOT_TYPE_REFUSED");
  }
  if (realpathSync(normalizedRunRoot) !== normalizedRunRoot) {
    throw new Error("PHASE6D5_RUN_ROOT_CANONICAL_REFUSED");
  }
  const expected = {
    mediaRoot: join(normalizedRunRoot, "media"),
    apiObservationLog: join(normalizedRunRoot, "api-observation.log"),
    certificateDirectory: join(normalizedRunRoot, "https-cert"),
  };
  if (
    candidate.mediaRoot !== expected.mediaRoot ||
    candidate.apiObservationLog !== expected.apiObservationLog ||
    candidate.certificateDirectory !== expected.certificateDirectory
  ) {
    throw new Error("PHASE6D5_RUN_CHILD_CONFINEMENT_REFUSED");
  }
  assertExpectedEntryType(expected.mediaRoot, "directory");
  assertExpectedEntryType(expected.certificateDirectory, "directory", true);
  assertExpectedEntryType(expected.apiObservationLog, "file", true);
  const ownershipPath = join(normalizedRunRoot, OWNERSHIP_FILE);
  assertExpectedEntryType(ownershipPath, "file");
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(ownershipPath, "utf8"));
  } catch {
    throw new Error("PHASE6D5_RUN_OWNERSHIP_INVALID");
  }
  if (
    !marker ||
    typeof marker !== "object" ||
    (marker as { version?: unknown }).version !== 1 ||
    (marker as { ownershipNonce?: unknown }).ownershipNonce !==
      candidate.ownershipNonce
  ) {
    throw new Error("PHASE6D5_RUN_OWNERSHIP_MISMATCH");
  }
}

function assertExpectedEntryType(
  path: string,
  type: "directory" | "file",
  optional = false,
) {
  if (!existsSync(path)) {
    if (optional) return;
    throw new Error("PHASE6D5_RUN_ENTRY_MISSING");
  }
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (type === "directory" ? !stat.isDirectory() : !stat.isFile())
  ) {
    throw new Error("PHASE6D5_RUN_ENTRY_TYPE_REFUSED");
  }
}

function canonicalTemporaryParent() {
  return realpathSync(tmpdir());
}

function hasAnyHarnessEnvironment() {
  return [
    ROOT_ENV,
    MARKER_ENV,
    API_LOG_ENV,
    CERTIFICATE_DIRECTORY_ENV,
    OWNERSHIP_NONCE_ENV,
  ].some((name) => process.env[name] !== undefined);
}

function environmentMatches(candidate: WebAcceptanceStorage) {
  return (
    process.env[ROOT_ENV] === candidate.mediaRoot &&
    process.env[MARKER_ENV] === candidate.markerId &&
    process.env[API_LOG_ENV] === candidate.apiObservationLog &&
    process.env[CERTIFICATE_DIRECTORY_ENV] === candidate.certificateDirectory &&
    process.env[OWNERSHIP_NONCE_ENV] === candidate.ownershipNonce
  );
}

function setHarnessEnvironment(candidate: WebAcceptanceStorage) {
  process.env[RUN_ROOT_ENV] = candidate.runRoot;
  process.env[OWNERSHIP_NONCE_ENV] = candidate.ownershipNonce;
  process.env[ROOT_ENV] = candidate.mediaRoot;
  process.env[MARKER_ENV] = candidate.markerId;
  process.env[API_LOG_ENV] = candidate.apiObservationLog;
  process.env[CERTIFICATE_DIRECTORY_ENV] = candidate.certificateDirectory;
}

function clearMatchingHarnessEnvironment(candidate: WebAcceptanceStorage) {
  const values = new Map([
    [RUN_ROOT_ENV, candidate.runRoot],
    [OWNERSHIP_NONCE_ENV, candidate.ownershipNonce],
    [ROOT_ENV, candidate.mediaRoot],
    [MARKER_ENV, candidate.markerId],
    [API_LOG_ENV, candidate.apiObservationLog],
    [CERTIFICATE_DIRECTORY_ENV, candidate.certificateDirectory],
  ]);
  for (const [name, value] of values) {
    if (process.env[name] === value) delete process.env[name];
  }
}
