import { createRequire } from "node:module";
import { closeSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  runImageRendererProducerFd,
  type ImageProducerKind,
  type UnverifiedRenderedCandidate,
} from "./image-renderer-producer.js";

export type {
  ImageProducerKind,
  UnverifiedRenderedCandidate,
} from "./image-renderer-producer.js";

type NativeRoot = object;
type NativeOriginalReader = object;
type NativeOriginalHandle = object;
type NativeCapacityGate = object;
type NativeOpenResult = {
  handle: NativeRoot;
  canonicalPath: string;
  markerId: string;
  device: string;
};
type NativePublishResult = {
  byteSize: number;
  fileSynced: boolean;
  sourceDirectorySynced: boolean;
  destinationDirectorySynced: boolean;
  fullSynced: boolean;
};
type NativeRaceResult = { successes: number; alreadyExists: number };
type NativeVerifiedFile = { sha256: Buffer; byteSize: string };
export type ControlledDirectoryEntry = {
  name: string;
  kind: "directory" | "file" | "symlink" | "special";
  mtimeMs: bigint;
  nlink: bigint;
  device: string;
  uid: string;
  mode: number;
};
export type DerivedFilesystemObservation = {
  jobId: string;
  epoch: bigint;
  kind: "THUMBNAIL" | "PREVIEW";
  byteSize: bigint;
  device: string;
  inode: string;
};
type NativeDerivedObservation = {
  jobId: string;
  epoch: string;
  kind: string;
  byteSize: string;
  device: string;
  inode: string;
};
type NativeDerivedRecoveryFact = {
  fileClass: string;
  byteSize: string;
  device: string;
  inode: string;
  mode: string;
  nlink: string;
  sha256Hex: string;
};
type NativeDerivedInventoryPage = {
  outcome: string;
  nextCursor: string;
  generation: string;
  observations: NativeDerivedObservation[];
};
const UINT64_MAX = 18446744073709551615n;

function canonicalUint64(value: string, allowZero: boolean) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) {
    return null;
  }
  if (!allowZero && value === "0") return null;
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > UINT64_MAX || parsed.toString() !== value) {
    return null;
  }
  return parsed;
}

function readDerivedObservation(
  raw: NativeDerivedObservation,
): DerivedFilesystemObservation | null {
  const epoch = canonicalUint64(raw.epoch, false);
  const byteSize = canonicalUint64(raw.byteSize, true);
  const device = canonicalUint64(raw.device, true);
  const inode = canonicalUint64(raw.inode, true);
  if (
    canonicalUint64(raw.jobId, false) === null ||
    epoch === null ||
    byteSize === null ||
    device === null ||
    inode === null ||
    (raw.kind !== "THUMBNAIL" && raw.kind !== "PREVIEW")
  ) {
    return null;
  }
  return {
    jobId: raw.jobId,
    epoch,
    kind: raw.kind,
    byteSize,
    device: device.toString(),
    inode: inode.toString(),
  };
}

function readRecoveryFact(raw: NativeDerivedRecoveryFact) {
  if (raw.fileClass === "ABSENT") {
    return {
      fileClass: "ABSENT" as const,
      byteSize: 0n,
      device: "0",
      inode: "0",
      mode: 0,
      nlink: 0,
      sha256Hex: "",
    };
  }
  const byteSize = canonicalUint64(raw.byteSize, true);
  const device = canonicalUint64(raw.device, true);
  const inode = canonicalUint64(raw.inode, true);
  const mode = /^[0-7]{3,4}$/u.test(raw.mode)
    ? Number.parseInt(raw.mode, 8)
    : null;
  const nlink = canonicalUint64(raw.nlink, false);
  if (
    byteSize === null ||
    device === null ||
    inode === null ||
    mode === null ||
    nlink === null ||
    (raw.fileClass !== "REGULAR" &&
      raw.fileClass !== "SYMLINK" &&
      raw.fileClass !== "UNSAFE") ||
    (raw.fileClass === "REGULAR" && !/^[0-9a-f]{64}$/u.test(raw.sha256Hex))
  ) {
    return null;
  }
  return {
    fileClass: raw.fileClass,
    byteSize,
    device: device.toString(),
    inode: inode.toString(),
    mode,
    nlink: Number(nlink),
    sha256Hex: raw.sha256Hex,
  };
}

function readDerivedObservations(raw: readonly NativeDerivedObservation[]) {
  const observations: DerivedFilesystemObservation[] = [];
  for (const item of raw) {
    const observation = readDerivedObservation(item);
    if (observation === null) return null;
    observations.push(observation);
  }
  return observations;
}

type NativeBinding = {
  provisionCapacityGate(handle: NativeRoot): void;
  openCapacityGate(path: string, expectedMarkerId: string): NativeCapacityGate;
  tryAcquireCapacityGate(handle: NativeCapacityGate): boolean;
  releaseCapacityGate(handle: NativeCapacityGate): void;
  capacityGateSnapshot(handle: NativeCapacityGate): {
    totalBytes: string;
    availableBytes: string;
    derivedInventoryComplete: boolean;
    derivedObservations: NativeDerivedObservation[];
  };
  capacityGateDerivedInventoryPage(
    handle: NativeCapacityGate,
    cursor: string,
  ): NativeDerivedInventoryPage;
  describeDerivedTemp(
    handle: NativeCapacityGate,
    jobId: string,
    epoch: string,
    kind: string,
  ): NativeDerivedRecoveryFact;
  inspectDerivedFinal(
    handle: NativeCapacityGate,
    familyId: string,
    mediaId: string,
    generation: string,
    recipeId: string,
    kind: string,
  ): NativeDerivedRecoveryFact;
  readDerivedFinal(
    handle: NativeCapacityGate,
    familyId: string,
    mediaId: string,
    generation: string,
    recipeId: string,
    kind: string,
    sha256Hex: string,
    byteSize: string,
  ): Buffer;
  derivedFinalInventoryPage(
    handle: NativeCapacityGate,
    cursor: string,
  ): {
    outcome: string;
    nextCursor: string;
    finals: Array<
      NativeDerivedRecoveryFact & {
        familyId: string;
        mediaId: string;
        generation: string;
        recipeId: string;
        kind: string;
      }
    >;
  };
  closeCapacityGate(handle: NativeCapacityGate): void;
  provisionDerivedWriterLock(handle: NativeRoot): void;
  openRoot(path: string, initialize: boolean): NativeOpenResult;
  closeRoot(handle: NativeRoot): void;
  ensureDirectory(handle: NativeRoot, relativePath: string): void;
  createExclusive(
    handle: NativeRoot,
    relativePath: string,
    contents: Buffer,
  ): void;
  raceExclusiveCreate(
    handle: NativeRoot,
    relativePath: string,
    firstContents: Buffer,
    secondContents: Buffer,
  ): NativeRaceResult;
  publishOriginal(
    handle: NativeRoot,
    sourceRelativePath: string,
    destinationRelativePath: string,
  ): NativePublishResult;
  raceExclusivePublish(
    handle: NativeRoot,
    firstSourceRelativePath: string,
    secondSourceRelativePath: string,
    destinationRelativePath: string,
  ): NativeRaceResult;
  directoryDevice(handle: NativeRoot, relativePath: string): string;
  openOriginalReader(
    path: string,
    expectedMarkerId: string,
  ): {
    handle: NativeOriginalReader;
    markerId: string;
    device: string;
  };
  closeOriginalReader(handle: NativeOriginalReader): void;
  openVerifiedOriginal(
    handle: NativeOriginalReader,
    familyId: string,
    sha256Hex: string,
    byteSize: string,
  ): NativeOriginalHandle;
  closeOriginalHandle(handle: NativeOriginalHandle): void;
  consumeOriginalHandle(handle: NativeOriginalHandle): {
    fd: number;
    rootPath: string;
  };
  fileSize(handle: NativeRoot, relativePath: string): string;
  verifyControlledFile(
    handle: NativeRoot,
    relativePath: string,
    mode: "staging" | "prepared" | "finalizing" | "original",
  ): NativeVerifiedFile;
  appendFileFromFile(
    handle: NativeRoot,
    destinationRelativePath: string,
    sourceRelativePath: string,
    expectedOffset: string,
    maximumSize: string,
  ): string;
  truncateFile(handle: NativeRoot, relativePath: string, length: string): void;
  removeFile(
    handle: NativeRoot,
    relativePath: string,
    allowPrepared: boolean,
  ): void;
  verifyRootIdentity(handle: NativeRoot): string;
  listDirectory(
    handle: NativeRoot,
    relativePath: string,
    limit: number,
  ): Array<
    Omit<ControlledDirectoryEntry, "mtimeMs" | "nlink"> & {
      mtimeMs: string;
      nlink: string;
    }
  >;
  listDirectoryPage(
    handle: NativeRoot,
    relativePath: string,
    afterName: string,
    limit: number,
    expectedGeneration: string,
  ): {
    entries: Array<
      Omit<ControlledDirectoryEntry, "mtimeMs" | "nlink"> & {
        mtimeMs: string;
        nlink: string;
      }
    >;
    generation: string;
    nextCursor: string;
    hasMore: boolean;
  };
};

const FAMILY_ID = /^(?:[1-9][0-9]*)$/u;
const UPLOAD_ID = /^[0-9a-f]{32}$/u;
const REQUEST_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BYTE_SIZE = /^(?:[1-9][0-9]*)$/u;
const BIDI_OR_CONTROL =
  /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const require = createRequire(import.meta.url);

let binding: NativeBinding | undefined;

export type StorageCapability =
  | { state: "READ_WRITE"; root: StorageRoot }
  | { state: "READ_ONLY"; reason: string; root: StorageRoot }
  | { state: "UNAVAILABLE"; reason: string };

export class StorageSafetyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "StorageSafetyError";
  }
}

export interface VerifiedOriginalHandle {
  readonly consumed: boolean;
  close(): void;
}

export type ApprovedOriginalProbeKind =
  | "capabilities"
  | "fork-denied"
  | "exec-denied"
  | "timeout-ignore-term"
  | "crash"
  | "stdout-flood"
  | "stderr-flood"
  | "invalid-json"
  | "deep-json";

export type OriginalProbeResult = Readonly<{
  ok: true;
  read: true;
  seek: true;
  writeDenied: true;
  reopenDenied: true;
  secondDenied: true;
  secretDenied: true;
  browseDenied: true;
  mutationDenied: true;
  networkDenied: true;
  dnsDenied: true;
  envClean: true;
  fdAllowlist: true;
}>;

export type DeniedOperationProbeResult = Readonly<{ denied: true }>;

class VerifiedOriginalHandleImpl implements VerifiedOriginalHandle {
  #handle: NativeOriginalHandle | null;
  #native: NativeBinding;
  #consumed = false;

  constructor(handle: NativeOriginalHandle, native: NativeBinding) {
    this.#handle = handle;
    this.#native = native;
  }

  get consumed() {
    return this.#consumed;
  }

  consumeForFixedProbe() {
    if (this.#consumed || this.#handle === null) {
      throw new StorageSafetyError("ORIGINAL_HANDLE_CONSUMED");
    }
    try {
      const result = this.#native.consumeOriginalHandle(this.#handle);
      this.#consumed = true;
      this.#handle = null;
      return result;
    } catch (error) {
      throw safetyError("ORIGINAL_HANDOFF_FAILED", error);
    }
  }

  close() {
    const handle = this.#handle;
    if (handle === null) return;
    this.#handle = null;
    this.#consumed = true;
    try {
      this.#native.closeOriginalHandle(handle);
    } catch (error) {
      throw safetyError("ORIGINAL_HANDLE_CLOSE_FAILED", error);
    }
  }
}

export class OriginalReader {
  readonly markerId: string;
  readonly device: string;
  #handle: NativeOriginalReader | null;
  #native: NativeBinding;

  private constructor(
    result: {
      handle: NativeOriginalReader;
      markerId: string;
      device: string;
    },
    native: NativeBinding,
  ) {
    this.#handle = result.handle;
    this.#native = native;
    this.markerId = result.markerId;
    this.device = result.device;
  }

  static open(
    input: { mediaRoot: unknown; expectedMarkerId: string },
    native: NativeBinding = loadBinding(),
  ) {
    const root = canonicalizeMediaRoot(input.mediaRoot);
    if (!/^[0-9a-f]{32}$/u.test(input.expectedMarkerId)) {
      throw new StorageSafetyError("MEDIA_ROOT_MARKER_INVALID");
    }
    try {
      const result = native.openOriginalReader(root, input.expectedMarkerId);
      if (result.markerId !== input.expectedMarkerId) {
        native.closeOriginalReader(result.handle);
        throw new StorageSafetyError("MEDIA_ROOT_MARKER_MISMATCH");
      }
      return new OriginalReader(result, native);
    } catch (error) {
      if (error instanceof StorageSafetyError) throw error;
      throw safetyError("ORIGINAL_READER_UNAVAILABLE", error);
    }
  }

  async withVerifiedOriginal<T>(
    input: { familyId: string; sha256Hex: string; byteSize: string },
    callback: (handle: VerifiedOriginalHandle) => Promise<T> | T,
  ): Promise<T> {
    assertIdentifier(input.familyId, FAMILY_ID, "FAMILY_ID_INVALID");
    assertIdentifier(input.sha256Hex, SHA256, "SHA256_INVALID");
    assertIdentifier(input.byteSize, BYTE_SIZE, "BYTE_SIZE_INVALID");
    const reader = this.#requiredHandle();
    let nativeHandle: NativeOriginalHandle;
    try {
      nativeHandle = this.#native.openVerifiedOriginal(
        reader,
        input.familyId,
        input.sha256Hex,
        input.byteSize,
      );
    } catch (error) {
      throw safetyError("ORIGINAL_OPEN_FAILED", error);
    }
    const handle = new VerifiedOriginalHandleImpl(nativeHandle, this.#native);
    try {
      return await callback(handle);
    } finally {
      handle.close();
    }
  }

  close() {
    const handle = this.#handle;
    if (handle === null) return;
    this.#handle = null;
    try {
      this.#native.closeOriginalReader(handle);
    } catch (error) {
      throw safetyError("ORIGINAL_READER_CLOSE_FAILED", error);
    }
  }

  #requiredHandle() {
    if (this.#handle === null) {
      throw new StorageSafetyError("ORIGINAL_READER_CLOSED");
    }
    return this.#handle;
  }
}

export async function runApprovedOriginalProbe(
  handle: VerifiedOriginalHandle,
  kind: ApprovedOriginalProbeKind,
  options: { timeoutMs?: number } = {},
): Promise<OriginalProbeResult | DeniedOperationProbeResult> {
  if (!(handle instanceof VerifiedOriginalHandleImpl)) {
    throw new StorageSafetyError("ORIGINAL_HANDLE_INVALID");
  }
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) {
    throw new StorageSafetyError("PROBE_TIMEOUT_INVALID");
  }
  return (await runFixedOriginalChild(
    handle,
    "original_probe_child",
    kind,
    timeoutMs,
    (parsed) =>
      kind === "capabilities"
        ? isValidProbeResult(parsed, 0)
        : (kind === "fork-denied" || kind === "exec-denied") &&
          isDeniedOperationResult(parsed),
  )) as OriginalProbeResult | DeniedOperationProbeResult;
}

/** D3a-0 synthetic qualification only; never dispatches a real renderer. */
export async function runSyntheticRendererStartupProbe(
  handle: VerifiedOriginalHandle,
): Promise<void> {
  if (!(handle instanceof VerifiedOriginalHandleImpl)) {
    throw new StorageSafetyError("ORIGINAL_HANDLE_INVALID");
  }
  const { fd } = handle.consumeForFixedProbe();
  const supervisor = resolve(
    import.meta.dirname,
    "../build/image_renderer_supervisor",
  );
  await new Promise<void>((resolveResult, reject) => {
    let child;
    try {
      child = spawn(supervisor, [], {
        stdio: ["ignore", "pipe", "pipe", fd, "pipe"],
        env: { LANG: "C", LC_ALL: "C" },
      });
    } catch (error) {
      closeSync(fd);
      reject(safetyError("RENDERER_STARTUP_LAUNCH_FAILED", error));
      return;
    }
    closeSync(fd);
    let output = "";
    let errorBytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 4096) child.stdio[4]?.destroy();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > 16 * 1024) child.stdio[4]?.destroy();
    });
    child.once("error", () => {
      child.stdio[4]?.destroy();
      reject(new StorageSafetyError("RENDERER_STARTUP_LAUNCH_FAILED"));
    });
    child.once("close", (code, signal) => {
      child.stdio[4]?.destroy();
      if (
        code !== 0 ||
        signal !== null ||
        errorBytes !== 0 ||
        output !== 'PS_RENDER_READY_V1\n{"status":"ok"}\n'
      ) {
        reject(new StorageSafetyError("RENDERER_STARTUP_CAPABILITY_FAILED"));
      } else {
        resolveResult();
      }
    });
  });
}

/** D3a-2a candidate only; never authorizes derived publish or serving. */
export async function renderUnverifiedCandidate(
  handle: VerifiedOriginalHandle,
  kind: ImageProducerKind,
): Promise<UnverifiedRenderedCandidate> {
  if (!(handle instanceof VerifiedOriginalHandleImpl)) {
    throw new StorageSafetyError("ORIGINAL_HANDLE_INVALID");
  }
  const { fd } = handle.consumeForFixedProbe();
  return await runImageRendererProducerFd(fd, kind);
}

export async function runFixedMetadataParser(
  handle: VerifiedOriginalHandle,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  if (!(handle instanceof VerifiedOriginalHandleImpl)) {
    throw new StorageSafetyError("ORIGINAL_HANDLE_INVALID");
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) {
    throw new StorageSafetyError("PROBE_TIMEOUT_INVALID");
  }
  return await runFixedOriginalChild(
    handle,
    "metadata_parser_child",
    "metadata",
    timeoutMs,
    (parsed) => parsed !== null && typeof parsed === "object",
  );
}

async function runFixedOriginalChild(
  handle: VerifiedOriginalHandleImpl,
  executableName: "original_probe_child" | "metadata_parser_child",
  kind: ApprovedOriginalProbeKind | "metadata",
  timeoutMs: number,
  validate: (parsed: unknown) => boolean,
): Promise<unknown> {
  const { fd, rootPath } = handle.consumeForFixedProbe();
  const packageRoot = resolve(import.meta.dirname, "..");
  const supervisor = resolve(packageRoot, "build/original_probe_supervisor");
  const childExecutable = resolve(packageRoot, "build", executableName);
  const sandboxProfile = resolve(packageRoot, "native/original-probe.sb");

  return await new Promise<unknown>((resolveResult, reject) => {
    let child;
    try {
      child = spawn(
        supervisor,
        [
          sandboxProfile,
          childExecutable,
          rootPath,
          homedir(),
          kind,
          timeoutMs.toString(),
        ],
        {
          stdio: ["ignore", "pipe", "pipe", fd, "pipe"],
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
        },
      );
    } catch (error) {
      closeSync(fd);
      reject(safetyError("ISOLATED_PROBE_LAUNCH_FAILED", error));
      return;
    }
    closeSync(fd);
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (childStdout === null || childStderr === null) {
      child.stdio[4]?.destroy();
      child.kill("SIGTERM");
      reject(new StorageSafetyError("ISOLATED_PROBE_PIPE_MISSING"));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      child.stdio[4]?.destroy();
      reject(new StorageSafetyError(reason));
    };
    childStdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > 64 * 1024) {
        fail("PROBE_STDOUT_LIMIT");
        return;
      }
      stdout.push(chunk);
    });
    childStderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 16 * 1024) {
        fail("PROBE_STDERR_LIMIT");
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", () => fail("ISOLATED_PROBE_LAUNCH_FAILED"));
    child.once("close", (code, signal) => {
      child.stdio[4]?.destroy();
      if (settled) return;
      settled = true;
      if (signal !== null || code !== 0 || stderrSize !== 0) {
        reject(
          new StorageSafetyError(
            code === 78
              ? "PROBE_TIMEOUT"
              : `PROBE_EXECUTION_FAILED:${code ?? "SIGNAL"}`,
          ),
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        reject(new StorageSafetyError("PROBE_PROTOCOL_INVALID"));
        return;
      }
      if (!validate(parsed)) {
        reject(new StorageSafetyError("PROBE_PROTOCOL_INVALID"));
        return;
      }
      resolveResult(parsed);
    });
  });
}

function isValidProbeResult(
  value: unknown,
  depth: number,
): value is OriginalProbeResult {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  const expected = [
    "ok",
    "read",
    "seek",
    "writeDenied",
    "reopenDenied",
    "secondDenied",
    "secretDenied",
    "browseDenied",
    "mutationDenied",
    "networkDenied",
    "dnsDenied",
    "envClean",
    "fdAllowlist",
  ] as const;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === expected.length &&
    expected.every((key) => record[key] === true)
  );
}

function isDeniedOperationResult(value: unknown) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>).denied === true
  );
}

export function canonicalizeMediaRoot(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.includes("\0") ||
    !isAbsolute(input) ||
    input === "/" ||
    normalize(input) !== input ||
    resolve(input) !== input
  ) {
    throw new StorageSafetyError("MEDIA_ROOT_INVALID");
  }
  return input;
}

export function validateDisplayFilename(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new StorageSafetyError("FILENAME_INVALID");
  }
  const codePoints = [...input];
  if (
    codePoints.length > 255 ||
    Buffer.byteLength(input, "utf8") > 1_024 ||
    input.includes("\0") ||
    BIDI_OR_CONTROL.test(input)
  ) {
    throw new StorageSafetyError("FILENAME_INVALID");
  }
  return input;
}

export function buildUploadPayloadPath(familyId: string, uploadId: string) {
  assertIdentifier(familyId, FAMILY_ID, "FAMILY_ID_INVALID");
  assertIdentifier(uploadId, UPLOAD_ID, "UPLOAD_ID_INVALID");
  return `uploads/${familyId}/${uploadId}/payload`;
}

export function buildChunkScratchPath(uploadId: string, requestId: string) {
  assertIdentifier(uploadId, UPLOAD_ID, "UPLOAD_ID_INVALID");
  assertIdentifier(requestId, REQUEST_ID, "REQUEST_ID_INVALID");
  return `temp/chunks/${uploadId}/${requestId}`;
}

export function buildOriginalPath(
  familyId: string,
  sha256Hex: string,
  byteSize: string,
) {
  assertIdentifier(familyId, FAMILY_ID, "FAMILY_ID_INVALID");
  assertIdentifier(sha256Hex, SHA256, "SHA256_INVALID");
  assertIdentifier(byteSize, BYTE_SIZE, "BYTE_SIZE_INVALID");
  return `originals/${familyId}/${sha256Hex.slice(0, 2)}/${sha256Hex.slice(2, 4)}/${sha256Hex}-${byteSize}`;
}

export class StorageRoot {
  readonly canonicalPath: string;
  readonly markerId: string;
  readonly device: string;
  #handle: NativeRoot | null;
  #native: NativeBinding;

  private constructor(result: NativeOpenResult, native: NativeBinding) {
    this.#handle = result.handle;
    this.#native = native;
    this.canonicalPath = result.canonicalPath;
    this.markerId = result.markerId;
    this.device = result.device;
  }

  assertIdentity() {
    let marker: string;
    try {
      marker = this.#native.verifyRootIdentity(this.#requiredHandle());
    } catch (error) {
      throw safetyError("MEDIA_ROOT_REPLACED", error);
    }
    if (marker !== this.markerId) {
      throw new StorageSafetyError("MEDIA_ROOT_MARKER_MISMATCH");
    }
  }

  listControlledDirectory(relativePath: string, limit = 1_000) {
    if (
      !/^(?:uploads|originals|temp)(?:\/[a-z0-9._-]+){0,4}$/u.test(
        relativePath,
      ) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 4_096
    ) {
      throw new StorageSafetyError("SCAN_PATH_INVALID");
    }
    this.assertIdentity();
    try {
      return this.#native
        .listDirectory(this.#requiredHandle(), relativePath, limit)
        .map((entry) => ({
          ...entry,
          mtimeMs: BigInt(entry.mtimeMs),
          nlink: BigInt(entry.nlink),
        }));
    } catch (error) {
      throw safetyError("SCAN_FAILED", error);
    }
  }

  listControlledDirectoryPage(
    relativePath: string,
    afterName = "",
    limit = 128,
    expectedGeneration = "",
  ) {
    if (
      !/^(?:uploads|originals|temp)(?:\/[a-z0-9._-]+){0,4}$/u.test(
        relativePath,
      ) ||
      !/^[a-z0-9._-]{0,255}$/u.test(afterName) ||
      !/^[0-9:-]{0,190}$/u.test(expectedGeneration) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 256
    )
      throw new StorageSafetyError("SCAN_PATH_INVALID");
    this.assertIdentity();
    try {
      const page = this.#native.listDirectoryPage(
        this.#requiredHandle(),
        relativePath,
        afterName,
        limit,
        expectedGeneration,
      );
      return {
        ...page,
        entries: page.entries.map((entry) => ({
          ...entry,
          mtimeMs: BigInt(entry.mtimeMs),
          nlink: BigInt(entry.nlink),
        })),
      };
    } catch (error) {
      throw safetyError("SCAN_FAILED", error);
    }
  }

  static open(
    mediaRoot: unknown,
    options: { initialize: boolean; expectedMarkerId?: string },
    native: NativeBinding = loadBinding(),
  ) {
    const requested = canonicalizeMediaRoot(mediaRoot);
    let result: NativeOpenResult;
    try {
      result = native.openRoot(requested, options.initialize);
    } catch (error) {
      throw safetyError("MEDIA_ROOT_UNAVAILABLE", error);
    }
    if (result.canonicalPath !== requested) {
      native.closeRoot(result.handle);
      throw new StorageSafetyError("MEDIA_ROOT_NOT_CANONICAL");
    }
    if (
      options.expectedMarkerId !== undefined &&
      result.markerId !== options.expectedMarkerId
    ) {
      native.closeRoot(result.handle);
      throw new StorageSafetyError("MEDIA_ROOT_MARKER_MISMATCH");
    }
    return new StorageRoot(result, native);
  }

  /** Explicit DEV provisioning only; normal API/worker startup never creates this lock. */
  provisionSharedCapacityLockForDev() {
    if (process.env.NODE_ENV === "production") {
      throw new StorageSafetyError("CAPACITY_PROVISION_DEV_ONLY");
    }
    this.assertIdentity();
    try {
      this.#native.provisionCapacityGate(this.#requiredHandle());
    } catch (error) {
      throw safetyError("CAPACITY_PROVISION_FAILED", error);
    }
  }

  /** Explicit DEV provisioning only. Does not create a derived temp or final asset. */
  provisionDerivedWriterLockForDev() {
    if (process.env.NODE_ENV === "production") {
      throw new StorageSafetyError("DERIVED_PROVISION_DEV_ONLY");
    }
    this.assertIdentity();
    try {
      this.#native.provisionDerivedWriterLock(this.#requiredHandle());
    } catch (error) {
      throw safetyError("DERIVED_PROVISION_FAILED", error);
    }
  }

  createUploadPayload(
    familyId: string,
    uploadId: string,
    syntheticContents: Uint8Array = new Uint8Array(),
  ) {
    this.assertIdentity();
    const handle = this.#requiredHandle();
    const relativePath = buildUploadPayloadPath(familyId, uploadId);
    try {
      this.#native.createExclusive(
        handle,
        relativePath,
        Buffer.from(syntheticContents),
      );
    } catch (error) {
      throw safetyError("EXCLUSIVE_CREATE_FAILED", error);
    }
    return relativePath;
  }

  createChunkScratch(
    uploadId: string,
    requestId: string,
    contents: Uint8Array,
  ) {
    this.assertIdentity();
    const handle = this.#requiredHandle();
    const relativePath = buildChunkScratchPath(uploadId, requestId);
    try {
      this.#native.createExclusive(handle, relativePath, Buffer.from(contents));
    } catch (error) {
      throw safetyError("SCRATCH_CREATE_FAILED", error);
    }
    return relativePath;
  }

  inspectUploadPayload(familyId: string, uploadId: string) {
    this.assertIdentity();
    const handle = this.#requiredHandle();
    try {
      return BigInt(
        this.#native.fileSize(
          handle,
          buildUploadPayloadPath(familyId, uploadId),
        ),
      );
    } catch (error) {
      throw safetyError("PAYLOAD_STAT_FAILED", error);
    }
  }

  hashUploadPayload(familyId: string, uploadId: string, prepared = false) {
    return this.#verifyFile(
      buildUploadPayloadPath(familyId, uploadId),
      prepared ? "finalizing" : "staging",
    );
  }

  verifyOriginal(familyId: string, sha256Hex: string, byteSize: string) {
    const verified = this.#verifyFile(
      buildOriginalPath(familyId, sha256Hex, byteSize),
      "original",
    );
    if (
      verified.byteSize !== BigInt(byteSize) ||
      !verified.sha256.equals(Buffer.from(sha256Hex, "hex"))
    ) {
      throw new StorageSafetyError("ORIGINAL_INTEGRITY_MISMATCH");
    }
    return verified;
  }

  #verifyFile(
    relativePath: string,
    mode: "staging" | "prepared" | "finalizing" | "original",
  ) {
    this.assertIdentity();
    try {
      const result = this.#native.verifyControlledFile(
        this.#requiredHandle(),
        relativePath,
        mode,
      );
      if (!Buffer.isBuffer(result.sha256) || result.sha256.length !== 32) {
        throw new StorageSafetyError("HASH_INVALID");
      }
      return { sha256: result.sha256, byteSize: BigInt(result.byteSize) };
    } catch (error) {
      if (error instanceof StorageSafetyError) throw error;
      throw safetyError("FILE_VERIFY_FAILED", error);
    }
  }

  commitChunk(input: {
    familyId: string;
    uploadId: string;
    requestId: string;
    expectedOffset: bigint;
    declaredSize: bigint;
  }) {
    this.assertIdentity();
    const handle = this.#requiredHandle();
    if (
      input.expectedOffset < 0n ||
      input.declaredSize <= 0n ||
      input.expectedOffset > input.declaredSize
    ) {
      throw new StorageSafetyError("OFFSET_INVALID");
    }
    try {
      return BigInt(
        this.#native.appendFileFromFile(
          handle,
          buildUploadPayloadPath(input.familyId, input.uploadId),
          buildChunkScratchPath(input.uploadId, input.requestId),
          input.expectedOffset.toString(),
          input.declaredSize.toString(),
        ),
      );
    } catch (error) {
      throw safetyError("CHUNK_COMMIT_FAILED", error);
    }
  }

  truncateUploadPayload(
    familyId: string,
    uploadId: string,
    trustedOffset: bigint,
  ) {
    this.assertIdentity();
    if (trustedOffset < 0n) throw new StorageSafetyError("OFFSET_INVALID");
    try {
      this.#native.truncateFile(
        this.#requiredHandle(),
        buildUploadPayloadPath(familyId, uploadId),
        trustedOffset.toString(),
      );
    } catch (error) {
      throw safetyError("PAYLOAD_TRUNCATE_FAILED", error);
    }
  }

  removeChunkScratch(uploadId: string, requestId: string) {
    this.assertIdentity();
    try {
      this.#native.removeFile(
        this.#requiredHandle(),
        buildChunkScratchPath(uploadId, requestId),
        false,
      );
    } catch (error) {
      throw safetyError("SCRATCH_REMOVE_FAILED", error);
    }
  }

  removeUploadPayload(familyId: string, uploadId: string) {
    this.assertIdentity();
    try {
      this.#native.removeFile(
        this.#requiredHandle(),
        buildUploadPayloadPath(familyId, uploadId),
        true,
      );
    } catch (error) {
      throw safetyError("PAYLOAD_REMOVE_FAILED", error);
    }
  }

  capacity() {
    this.assertIdentity();
    try {
      const stats = statfsSync(this.canonicalPath, { bigint: true });
      return {
        availableBytes: stats.bavail * stats.bsize,
        totalBytes: stats.blocks * stats.bsize,
      };
    } catch (error) {
      throw safetyError("CAPACITY_CHECK_FAILED", error);
    }
  }

  publishOriginal(input: {
    familyId: string;
    uploadId: string;
    sha256Hex: string;
    byteSize: string;
  }) {
    this.assertIdentity();
    const handle = this.#requiredHandle();
    const source = buildUploadPayloadPath(input.familyId, input.uploadId);
    const destination = buildOriginalPath(
      input.familyId,
      input.sha256Hex,
      input.byteSize,
    );
    let result: NativePublishResult;
    try {
      result = this.#native.publishOriginal(handle, source, destination);
    } catch (error) {
      throw safetyError("ORIGINAL_PUBLISH_FAILED", error);
    }
    if (
      !result.fileSynced ||
      !result.sourceDirectorySynced ||
      !result.destinationDirectorySynced ||
      !result.fullSynced
    ) {
      throw new StorageSafetyError("DURABILITY_NOT_CONFIRMED");
    }
    return { relativePath: destination, ...result };
  }

  probeConcurrentExclusiveCreate(input: {
    familyId: string;
    uploadId: string;
    firstContents: Uint8Array;
    secondContents: Uint8Array;
  }) {
    const handle = this.#requiredHandle();
    const path = buildUploadPayloadPath(input.familyId, input.uploadId);
    try {
      return this.#native.raceExclusiveCreate(
        handle,
        path,
        Buffer.from(input.firstContents),
        Buffer.from(input.secondContents),
      );
    } catch (error) {
      throw safetyError("CONCURRENT_CREATE_PROBE_FAILED", error);
    }
  }

  probeConcurrentExclusivePublish(input: {
    familyId: string;
    firstUploadId: string;
    secondUploadId: string;
    sha256Hex: string;
    byteSize: string;
  }) {
    const handle = this.#requiredHandle();
    const firstSource = buildUploadPayloadPath(
      input.familyId,
      input.firstUploadId,
    );
    const secondSource = buildUploadPayloadPath(
      input.familyId,
      input.secondUploadId,
    );
    const destination = buildOriginalPath(
      input.familyId,
      input.sha256Hex,
      input.byteSize,
    );
    try {
      const result = this.#native.raceExclusivePublish(
        handle,
        firstSource,
        secondSource,
        destination,
      );
      return { relativePath: destination, ...result };
    } catch (error) {
      throw safetyError("CONCURRENT_PUBLISH_PROBE_FAILED", error);
    }
  }

  verifySameFilesystem() {
    const handle = this.#requiredHandle();
    try {
      const devices = ["uploads", "temp", "originals"].map((directory) =>
        this.#native.directoryDevice(handle, directory),
      );
      if (devices.some((device) => device !== this.device)) {
        throw new StorageSafetyError("CROSS_DEVICE_LAYOUT");
      }
      return true;
    } catch (error) {
      if (error instanceof StorageSafetyError) throw error;
      throw safetyError("FILESYSTEM_PROBE_FAILED", error);
    }
  }

  close() {
    const handle = this.#handle;
    if (handle === null) return;
    this.#handle = null;
    try {
      this.#native.closeRoot(handle);
    } catch (error) {
      throw safetyError("STORAGE_CLOSE_FAILED", error);
    }
  }

  #requiredHandle() {
    if (this.#handle === null) throw new StorageSafetyError("STORAGE_CLOSED");
    return this.#handle;
  }
}

const capacityQueues = new Map<string, Promise<void>>();

/** One stable root/marker-bound OS lock shared by upload admission and derived reservations. */
export class CapacityGate {
  readonly #native: NativeBinding;
  readonly #key: string;
  #handle: NativeCapacityGate | null;
  #holding = false;
  #pending = 0;

  private constructor(
    handle: NativeCapacityGate,
    native: NativeBinding,
    key: string,
  ) {
    this.#handle = handle;
    this.#native = native;
    this.#key = key;
  }

  static open(
    input: { mediaRoot: unknown; expectedMarkerId: string },
    native: NativeBinding = loadBinding(),
  ) {
    const root = canonicalizeMediaRoot(input.mediaRoot);
    if (!/^[0-9a-f]{32}$/u.test(input.expectedMarkerId)) {
      throw new StorageSafetyError("CAPACITY_MARKER_INVALID");
    }
    try {
      const handle = native.openCapacityGate(root, input.expectedMarkerId);
      return new CapacityGate(
        handle,
        native,
        `${root}:${input.expectedMarkerId}`,
      );
    } catch (error) {
      throw safetyError("CAPACITY_GATE_UNAVAILABLE", error);
    }
  }

  /** Bounded asynchronous wait. No DB lock may be held while entering here. */
  snapshotLocked() {
    if (!this.#holding || this.#handle === null) {
      throw new StorageSafetyError("CAPACITY_LOCK_REQUIRED");
    }
    const snapshot = this.#native.capacityGateSnapshot(this.#handle);
    const observations = snapshot.derivedInventoryComplete
      ? readDerivedObservations(snapshot.derivedObservations)
      : [];
    return {
      totalBytes: BigInt(snapshot.totalBytes),
      availableBytes: BigInt(snapshot.availableBytes),
      derivedInventoryComplete:
        snapshot.derivedInventoryComplete && observations !== null,
      derivedObservations: observations ?? [],
    };
  }

  /** One bounded, read-only page. Callers must not treat a partial page as complete. */
  derivedInventoryPage(cursor: string) {
    if (!this.#holding || this.#handle === null) {
      throw new StorageSafetyError("CAPACITY_LOCK_REQUIRED");
    }
    const page = this.#native.capacityGateDerivedInventoryPage(
      this.#handle,
      cursor,
    );
    const observations =
      page.outcome === "incomplete"
        ? []
        : readDerivedObservations(page.observations);
    const outcome =
      page.outcome === "complete" || page.outcome === "continue"
        ? page.outcome
        : "incomplete";
    if (observations === null || outcome === "incomplete") {
      return {
        outcome: "incomplete" as const,
        nextCursor: "",
        generation: page.generation,
        observations: [],
      };
    }
    return {
      outcome,
      nextCursor: page.nextCursor,
      generation: page.generation,
      observations,
    };
  }

  describeDerivedTemp(
    jobId: string,
    epoch: bigint,
    kind: "THUMBNAIL" | "PREVIEW",
  ) {
    this.#requireLock();
    const fact = readRecoveryFact(
      this.#native.describeDerivedTemp(
        this.#requiredGate(),
        jobId,
        epoch.toString(),
        kind,
      ),
    );
    if (fact === null)
      throw new StorageSafetyError("DERIVED_RECOVERY_INCOMPLETE");
    return fact;
  }

  inspectDerivedFinal(input: {
    familyId: string;
    mediaId: string;
    generation: bigint;
    recipeId: 1;
    kind: "THUMBNAIL" | "PREVIEW";
  }) {
    this.#requireLock();
    const fact = readRecoveryFact(
      this.#native.inspectDerivedFinal(
        this.#requiredGate(),
        input.familyId,
        input.mediaId,
        input.generation.toString(),
        String(input.recipeId),
        input.kind,
      ),
    );
    if (fact === null)
      throw new StorageSafetyError("DERIVED_RECOVERY_INCOMPLETE");
    return fact;
  }

  /**
   * Read one sealed final by canonical identity. The caller supplies the
   * authoritative family, media, generation, recipe, kind, SHA-256, and size.
   * This does not accept a path and does not open an original.
   */
  readDerivedFinal(input: {
    familyId: string;
    mediaId: string;
    generation: bigint;
    recipeId: 1;
    kind: "THUMBNAIL" | "PREVIEW";
    sha256Hex: string;
    byteSize: bigint;
  }): Buffer {
    this.#requireLock();
    try {
      const bytes = this.#native.readDerivedFinal(
        this.#requiredGate(),
        input.familyId,
        input.mediaId,
        input.generation.toString(),
        String(input.recipeId),
        input.kind,
        input.sha256Hex,
        input.byteSize.toString(),
      );
      if (!Buffer.isBuffer(bytes) || bytes.length !== Number(input.byteSize)) {
        throw new StorageSafetyError("DERIVED_SERVE_MISMATCH");
      }
      return bytes;
    } catch (error) {
      if (error instanceof StorageSafetyError) throw error;
      const code =
        error instanceof Error && "code" in error ? String(error.code) : "";
      if (
        code === "DERIVED_SERVE_ABSENT" ||
        code === "DERIVED_SERVE_MISMATCH" ||
        code === "DERIVED_SERVE_IDENTITY" ||
        code === "DERIVED_SERVE_UNAVAILABLE" ||
        code === "CAPACITY_LOCK_REQUIRED"
      ) {
        throw new StorageSafetyError(code);
      }
      throw new StorageSafetyError("DERIVED_SERVE_UNAVAILABLE");
    }
  }

  /**
   * One bounded page of canonical final files. A partial page is not complete.
   * This does not delete or rename.
   */
  derivedFinalPage(cursor: string) {
    this.#requireLock();
    let page: ReturnType<NativeBinding["derivedFinalInventoryPage"]>;
    try {
      page = this.#native.derivedFinalInventoryPage(
        this.#requiredGate(),
        cursor,
      );
    } catch (error) {
      throw safetyError("DERIVED_RECOVERY_INCOMPLETE", error);
    }
    if (page.outcome !== "complete" && page.outcome !== "continue") {
      throw new StorageSafetyError("DERIVED_RECOVERY_INCOMPLETE");
    }
    const finals = [];
    for (const item of page.finals) {
      const fact = readRecoveryFact(item);
      const generation = canonicalUint64(item.generation, false);
      if (
        fact === null ||
        generation === null ||
        canonicalUint64(item.familyId, false) === null ||
        canonicalUint64(item.mediaId, false) === null ||
        item.recipeId !== "1" ||
        (item.kind !== "THUMBNAIL" && item.kind !== "PREVIEW")
      ) {
        throw new StorageSafetyError("DERIVED_RECOVERY_INCOMPLETE");
      }
      finals.push({
        familyId: item.familyId,
        mediaId: item.mediaId,
        generation,
        recipeId: 1 as const,
        kind: item.kind,
        ...fact,
      });
    }
    return { outcome: page.outcome, nextCursor: page.nextCursor, finals };
  }

  /**
   * Startup recovery scan. Stops after eight pages. A generation change or a
   * fact that no longer matches the page fails closed.
   */
  async recoveryInventory(maxPages = 8) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 8) {
      throw new StorageSafetyError("DERIVED_RECOVERY_INCOMPLETE");
    }
    return this.withLock(async () => {
      const temps = [];
      let cursor = "";
      let generation = "";
      for (let page = 0; page < maxPages; page += 1) {
        const next = this.derivedInventoryPage(cursor);
        if (next.outcome === "incomplete") {
          throw new StorageSafetyError("DERIVED_RECOVERY_INCOMPLETE");
        }
        if (generation === "") generation = next.generation;
        if (generation !== next.generation) {
          throw new StorageSafetyError("DERIVED_RECOVERY_CHANGED");
        }
        for (const observation of next.observations) {
          const fact = this.describeDerivedTemp(
            observation.jobId,
            observation.epoch,
            observation.kind,
          );
          if (
            fact.fileClass !== "REGULAR" ||
            fact.device !== observation.device ||
            fact.inode !== observation.inode ||
            fact.byteSize !== observation.byteSize
          ) {
            throw new StorageSafetyError("DERIVED_RECOVERY_CHANGED");
          }
          temps.push({
            jobId: observation.jobId,
            epoch: observation.epoch,
            kind: observation.kind,
            ...fact,
          });
        }
        if (next.outcome === "complete") break;
        if (page + 1 === maxPages) {
          throw new StorageSafetyError("DERIVED_RECOVERY_INCOMPLETE");
        }
        cursor = next.nextCursor;
      }
      const finals = [];
      cursor = "";
      for (let page = 0; page < maxPages; page += 1) {
        const next = this.derivedFinalPage(cursor);
        finals.push(...next.finals);
        if (next.outcome === "complete") {
          return { complete: true as const, generation, temps, finals };
        }
        if (page + 1 === maxPages) {
          throw new StorageSafetyError("DERIVED_RECOVERY_INCOMPLETE");
        }
        cursor = next.nextCursor;
      }
      throw new StorageSafetyError("DERIVED_RECOVERY_INCOMPLETE");
    });
  }

  #requireLock() {
    if (!this.#holding || this.#handle === null) {
      throw new StorageSafetyError("CAPACITY_LOCK_REQUIRED");
    }
  }

  #requiredGate() {
    this.#requireLock();
    if (this.#handle === null)
      throw new StorageSafetyError("CAPACITY_GATE_CLOSED");
    return this.#handle;
  }

  async withLock<T>(
    operation: (
      capacity: {
        totalBytes: bigint;
        availableBytes: bigint;
      },
      deadline: number,
    ) => Promise<T>,
  ): Promise<T> {
    return this.#withLock(operation, true);
  }

  /**
   * Admission owns its COMMIT classification. A late confirmed COMMIT must
   * reach the coordinator instead of being replaced by a generic timeout.
   * The snapshot callback must be invoked only after the DB capacity barrier
   * and current reservation inventory have been acquired/read.
   */
  async withAdmissionLock<T>(
    operation: (
      deadline: number,
      snapshot: () => {
        totalBytes: bigint;
        availableBytes: bigint;
        derivedInventoryComplete: boolean;
        derivedObservations: readonly DerivedFilesystemObservation[];
      },
    ) => Promise<T>,
  ): Promise<T> {
    return this.#withLock(
      async (_initial, deadline) =>
        operation(deadline, () => this.snapshotLocked()),
      false,
    );
  }

  async #withLock<T>(
    operation: (
      capacity: { totalBytes: bigint; availableBytes: bigint },
      deadline: number,
    ) => Promise<T>,
    enforceCompletionDeadline: boolean,
  ): Promise<T> {
    const handle = this.#handle;
    if (handle === null) throw new StorageSafetyError("CAPACITY_GATE_CLOSED");
    const deadline = performance.now() + 2_000;
    this.#pending += 1;
    const previous = capacityQueues.get(this.#key) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const local = new Promise<void>((resolveLocal) => {
      releaseLocal = resolveLocal;
    });
    const tail = previous.then(() => local);
    capacityQueues.set(this.#key, tail);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolveWait, rejectWait) => {
          timer = setTimeout(
            () => rejectWait(new StorageSafetyError("CAPACITY_LOCK_TIMEOUT")),
            Math.max(0, deadline - performance.now()),
          );
          void previous.then(resolveWait, rejectWait);
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (performance.now() >= deadline) {
        throw new StorageSafetyError("CAPACITY_LOCK_TIMEOUT");
      }
      while (!this.#native.tryAcquireCapacityGate(handle)) {
        if (performance.now() >= deadline) {
          throw new StorageSafetyError("CAPACITY_LOCK_TIMEOUT");
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      this.#holding = true;
      try {
        const result = await operation(this.snapshotLocked(), deadline);
        if (enforceCompletionDeadline && performance.now() >= deadline) {
          throw new StorageSafetyError("CAPACITY_ADMISSION_TIMEOUT");
        }
        return result;
      } finally {
        this.#native.releaseCapacityGate(handle);
        this.#holding = false;
      }
    } catch (error) {
      if (error instanceof StorageSafetyError) throw error;
      throw safetyError("CAPACITY_GATE_FAILED", error);
    } finally {
      this.#pending -= 1;
      releaseLocal();
      if (capacityQueues.get(this.#key) === tail)
        capacityQueues.delete(this.#key);
    }
  }

  close() {
    if (this.#pending !== 0 || this.#holding) {
      throw new StorageSafetyError("CAPACITY_LOCK_HELD");
    }
    const handle = this.#handle;
    if (handle === null) return;
    this.#handle = null;
    try {
      this.#native.closeCapacityGate(handle);
    } catch (error) {
      throw safetyError("CAPACITY_GATE_CLOSE_FAILED", error);
    }
  }
}

export {
  DerivedTempAdmissionPermit,
  isDerivedTempAdmissionPermit,
  issueDerivedTempPermitForDev,
  mintDerivedTempAdmissionPermit,
} from "./derived-admission-permit.js";
export type { DerivedTempPermitIdentity } from "./derived-admission-permit.js";
export {
  DerivedStore,
  DerivedTempWriter,
  SealedDerivedOutput,
  isSealedDerivedOutput,
} from "./derived-store.js";
export type {
  DerivedPublishResult,
  DerivedTempIdentitySnapshot,
  DerivedVerifyResult,
  DerivedVerifyScenario,
  SealedDerivedIdentity,
} from "./derived-store.js";

export function probeStorageCapability(input: {
  mediaRoot: unknown;
  initialize: boolean;
  expectedMarkerId?: string;
  readOnlyReason?: string;
}): StorageCapability {
  let root: StorageRoot | undefined;
  try {
    root = StorageRoot.open(input.mediaRoot, {
      initialize: input.initialize,
      ...(input.expectedMarkerId === undefined
        ? {}
        : { expectedMarkerId: input.expectedMarkerId }),
    });
    root.verifySameFilesystem();
    root.assertIdentity();
    if (input.readOnlyReason) {
      return { state: "READ_ONLY", reason: input.readOnlyReason, root };
    }
    return { state: "READ_WRITE", root };
  } catch (error) {
    try {
      root?.close();
    } catch {
      // The capability is already unavailable; close failure remains fail-closed.
    }
    return {
      state: "UNAVAILABLE",
      reason:
        error instanceof StorageSafetyError
          ? error.reason
          : "STORAGE_PROBE_FAILED",
    };
  }
}

function loadBinding(): NativeBinding {
  binding ??= require("../build/storage_native.node") as NativeBinding;
  return binding;
}

function assertIdentifier(value: string, pattern: RegExp, reason: string) {
  if (!pattern.test(value)) throw new StorageSafetyError(reason);
}

function safetyError(reason: string, cause: unknown) {
  return new StorageSafetyError(
    cause instanceof Error && "code" in cause
      ? `${reason}:${String(cause.code)}`
      : reason,
  );
}
