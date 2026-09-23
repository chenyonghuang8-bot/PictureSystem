import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

import {
  assertCanonicalTempIdentity,
  isDerivedTempAdmissionPermit,
  type DerivedTempAdmissionPermit,
  type DerivedTempPermitIdentity,
} from "./derived-admission-permit.js";
import {
  StorageSafetyError,
  type StorageCapability,
  type StorageRoot,
  type UnverifiedRenderedCandidate,
} from "./index.js";

const require = createRequire(import.meta.url);
const UINT64_MAX = 18446744073709551615n;
const KIND_CAP = {
  THUMBNAIL: 512 * 1024,
  PREVIEW: 4 * 1024 * 1024,
} as const;

type NativeStore = object;
type NativeWriter = object;
type NativeSnapshot = {
  jobId: string;
  epoch: string;
  kind: string;
  device: string;
  inode: string;
  byteSize: string;
  mode: number;
  linkCount: string;
  sha256Hex: string;
  epochDevice: string;
  epochInode: string;
  derivedDevice: string;
  derivedInode: string;
  durable: boolean;
};
type DerivedNative = {
  openDerivedStore(path: string, markerId: string): NativeStore;
  closeDerivedStore(store: NativeStore): void;
  createDerivedTemp(
    store: NativeStore,
    jobId: string,
    epoch: string,
    kind: string,
    familyId: string,
    mediaId: string,
    generation: string,
    recipeId: string,
    reservationId: string,
  ): NativeWriter;
  writeDerivedTemp(
    writer: NativeWriter,
    bytes: Buffer,
    sha256Hex: string,
  ): NativeSnapshot;
  cleanupDerivedTemp(writer: NativeWriter): void;
  sealDerivedTemp(
    writer: NativeWriter,
  ): NativeSnapshot & { handle: NativeSealed };
  consumeSealedOutput(sealed: NativeSealed, store: NativeStore): void;
  cleanupExactDerivedTemp(
    store: NativeStore,
    jobId: string,
    epoch: string,
    kind: string,
    device: string,
    inode: string,
    byteSize: string,
    sha256Hex: string,
    familyId: string,
    mediaId: string,
    generation: string,
    recipeId: string,
  ): boolean;
  publishSealedOutput(
    sealed: NativeSealed,
    store: NativeStore,
  ): {
    outcome: "PUBLISHED" | "IDENTICAL";
    sha256Hex: string;
    byteSize: string;
    inode: string;
    device: string;
    generation: string;
    kind: string;
  };
  verifySealedOutput(
    sealed: NativeSealed,
    store: NativeStore,
    scenario: string,
  ): {
    width: number;
    height: number;
    alpha: boolean;
    transparent: boolean;
    staticImage: boolean;
    sha256Hex: string;
  };
  failNextDerivedFsync(store: NativeStore): void;
  failNextSealFault(store: NativeStore, fault: "fsync" | "close"): void;
  failNextVerifyPost(store: NativeStore): void;
};

type NativeSealed = object;
const liveSealed = new WeakSet<SealedDerivedOutput>();

export type DerivedVerifyScenario =
  "run" | "timeout" | "crash" | "ignore-term" | "owner-death" | "high-fd";

export type DerivedPublishResult = {
  outcome: "PUBLISHED" | "IDENTICAL";
  sha256Hex: string;
  byteSize: string;
  inode: string;
  device: string;
  generation: string;
  kind: string;
};

export type DerivedVerifyResult = {
  width: number;
  height: number;
  staticImage: true;
  alpha: boolean;
  transparent: boolean;
  sha256Hex: string;
};

const VERIFY_SCENARIOS = new Set<DerivedVerifyScenario>([
  "run",
  "timeout",
  "crash",
  "ignore-term",
  "owner-death",
  "high-fd",
]);

let nativeBinding: DerivedNative | undefined;

function loadNative() {
  nativeBinding ??= require("../build/storage_native.node") as DerivedNative;
  return nativeBinding;
}

function safetyError(reason: string, cause: unknown) {
  return new StorageSafetyError(
    cause instanceof Error && "code" in cause
      ? `${reason}:${String(cause.code)}`
      : reason,
  );
}

function canonicalUint(value: string) {
  if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) return null;
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > UINT64_MAX || parsed.toString() !== value) {
    return null;
  }
  return parsed;
}

/** Physical identity captured after durability, with no path and no file descriptor. */
export type DerivedTempIdentitySnapshot = {
  familyId: string;
  mediaId: string;
  generation: bigint;
  recipeId: 1;
  kind: "THUMBNAIL" | "PREVIEW";
  jobId: string;
  epoch: bigint;
  reservationId: string;
  reservedBytes: bigint;
  device: string;
  inode: string;
  byteSize: bigint;
  mode: number;
  linkCount: bigint;
  sha256Hex: string;
  epochDevice: string;
  epochInode: string;
  derivedDevice: string;
  derivedInode: string;
  durable: true;
};

export type SealedDerivedIdentity = DerivedTempIdentitySnapshot & {
  readonly sealed: true;
};

function isCandidate(
  value: unknown,
): value is UnverifiedRenderedCandidate & { bytes: Buffer } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as UnverifiedRenderedCandidate & { bytes: unknown };
  return (
    (candidate.kind === "THUMBNAIL" || candidate.kind === "PREVIEW") &&
    candidate.recipe === 1 &&
    candidate.mime === "image/webp" &&
    Buffer.isBuffer(candidate.bytes) &&
    typeof candidate.sha256Hex === "string" &&
    /^[0-9a-f]{64}$/u.test(candidate.sha256Hex)
  );
}

function readSnapshot(
  raw: NativeSnapshot,
  business: {
    identity: DerivedTempPermitIdentity;
    reservationId: string;
    reservedBytes: bigint;
  },
  byteLength: number,
  expectedMode: number,
): DerivedTempIdentitySnapshot {
  const epoch = canonicalUint(raw.epoch);
  const byteSize = canonicalUint(raw.byteSize);
  const device = canonicalUint(raw.device);
  const inode = canonicalUint(raw.inode);
  const linkCount = canonicalUint(raw.linkCount);
  const epochDevice = canonicalUint(raw.epochDevice);
  const epochInode = canonicalUint(raw.epochInode);
  const derivedDevice = canonicalUint(raw.derivedDevice);
  const derivedInode = canonicalUint(raw.derivedInode);
  if (
    epoch === null ||
    byteSize === null ||
    device === null ||
    inode === null ||
    linkCount === null ||
    epochDevice === null ||
    epochInode === null ||
    derivedDevice === null ||
    derivedInode === null ||
    raw.jobId !== business.identity.jobId ||
    epoch !== business.identity.leaseEpoch ||
    raw.kind !== business.identity.kind ||
    raw.sha256Hex.length !== 64 ||
    byteSize !== BigInt(byteLength) ||
    linkCount !== 1n ||
    raw.mode !== expectedMode ||
    raw.durable !== true
  ) {
    throw new StorageSafetyError("DERIVED_TEMP_IDENTITY");
  }
  return {
    familyId: business.identity.familyId,
    mediaId: business.identity.mediaId,
    generation: business.identity.generation,
    recipeId: 1,
    kind: business.identity.kind,
    jobId: business.identity.jobId,
    epoch,
    reservationId: business.reservationId,
    reservedBytes: business.reservedBytes,
    device: device.toString(),
    inode: inode.toString(),
    byteSize,
    mode: raw.mode,
    linkCount,
    sha256Hex: raw.sha256Hex,
    epochDevice: epochDevice.toString(),
    epochInode: epochInode.toString(),
    derivedDevice: derivedDevice.toString(),
    derivedInode: derivedInode.toString(),
    durable: true,
  };
}

/**
 * Opaque owned-temp writer. It can only persist the candidate bound to its
 * permit, and it never exposes a path or file descriptor.
 */
export class DerivedTempWriter {
  readonly #native: DerivedNative;
  readonly #handle: NativeWriter;
  readonly #business: {
    identity: DerivedTempPermitIdentity;
    reservationId: string;
    reservedBytes: bigint;
  };
  #snapshot: DerivedTempIdentitySnapshot | null = null;
  #closed = false;

  constructor(
    native: DerivedNative,
    handle: NativeWriter,
    business: {
      identity: DerivedTempPermitIdentity;
      reservationId: string;
      reservedBytes: bigint;
    },
  ) {
    this.#native = native;
    this.#handle = handle;
    this.#business = business;
  }

  identity() {
    if (this.#snapshot === null) {
      throw new StorageSafetyError("DERIVED_WRITER_OPEN");
    }
    return this.#snapshot;
  }

  writeCandidate(capability: StorageCapability, candidate: unknown) {
    assertWritable(capability);
    if (this.#closed || this.#snapshot !== null) {
      throw new StorageSafetyError("DERIVED_WRITER_CLOSED");
    }
    const bytes = validateCandidate(candidate, this.#business);
    try {
      const snapshot = readSnapshot(
        this.#native.writeDerivedTemp(
          this.#handle,
          bytes,
          createHash("sha256").update(bytes).digest("hex"),
        ),
        this.#business,
        bytes.length,
        0o600,
      );
      this.#snapshot = snapshot;
      return snapshot;
    } catch (error) {
      this.#closed = true;
      throw safetyError("DERIVED_TEMP_WRITE_FAILED", error);
    }
  }

  cleanupOwnedFailure(capability: StorageCapability) {
    assertWritable(capability);
    if (this.#closed && this.#snapshot === null) {
      throw new StorageSafetyError("DERIVED_CLEANUP_REFUSED");
    }
    try {
      this.#native.cleanupDerivedTemp(this.#handle);
      this.#closed = true;
      this.#snapshot = null;
    } catch (error) {
      throw safetyError("DERIVED_CLEANUP_FAILED", error);
    }
  }

  seal(capability: StorageCapability, store: DerivedStore) {
    assertWritable(capability);
    if (this.#snapshot === null || this.#closed) {
      throw new StorageSafetyError("DERIVED_WRITER_CLOSED");
    }
    if (!store.sameCapabilityRoot(capability)) {
      throw new StorageSafetyError("DERIVED_STORE_MISMATCH");
    }
    try {
      const raw = this.#native.sealDerivedTemp(this.#handle);
      const identity = readSnapshot(
        raw,
        this.#business,
        Number(this.#snapshot.byteSize),
        0o400,
      );
      if (identity.sha256Hex !== this.#snapshot.sha256Hex) {
        throw new StorageSafetyError("DERIVED_HASH_MISMATCH");
      }
      const sealedIdentity: SealedDerivedIdentity = {
        ...identity,
        sealed: true,
      };
      this.#snapshot = identity;
      return new SealedDerivedOutput(
        this.#native,
        raw.handle,
        store,
        sealedIdentity,
        this,
      );
    } catch (error) {
      if (error instanceof StorageSafetyError) throw error;
      throw safetyError("DERIVED_SEAL_FAILED", error);
    }
  }
}

/**
 * Opaque sealed temp candidate. It is not a published asset and does not
 * expose a path, a root, or a file descriptor.
 */
export class SealedDerivedOutput {
  readonly #native: DerivedNative;
  readonly #handle: NativeSealed;
  readonly #store: DerivedStore;
  readonly #identity: SealedDerivedIdentity;
  readonly #writer: DerivedTempWriter;
  #consumed = false;

  constructor(
    native: DerivedNative,
    handle: NativeSealed,
    store: DerivedStore,
    identity: SealedDerivedIdentity,
    writer: DerivedTempWriter,
  ) {
    this.#native = native;
    this.#handle = handle;
    this.#store = store;
    this.#identity = identity;
    this.#writer = writer;
    liveSealed.add(this);
  }

  identity() {
    this.#assertLive();
    void this.#writer;
    return this.#identity;
  }

  assertBinding(epoch: bigint, kind: "THUMBNAIL" | "PREVIEW") {
    this.#assertLive();
    if (epoch !== this.#identity.epoch || kind !== this.#identity.kind) {
      throw new StorageSafetyError("DERIVED_PERMIT_IDENTITY");
    }
  }

  consume(store: DerivedStore) {
    this.#assertLive();
    store.consumeSealed(this);
  }

  /**
   * Exclusive no-clobber rename into the fixed final derived namespace.
   * This does not write READY, finish a job, or serve the asset.
   */
  publish(
    store: DerivedStore,
    capability: StorageCapability,
    binding: {
      familyId: string;
      mediaId: string;
      generation: bigint;
      recipeId: 1;
      kind: "THUMBNAIL" | "PREVIEW";
      jobId: string;
      epoch: bigint;
      reservationId: string;
    },
  ) {
    assertWritable(capability);
    this.#assertLive();
    if (!store.sameCapabilityRoot(capability) || store !== this.#store) {
      throw new StorageSafetyError("DERIVED_STORE_MISMATCH");
    }
    const identity = this.#identity;
    if (
      binding.familyId !== identity.familyId ||
      binding.mediaId !== identity.mediaId ||
      binding.generation !== identity.generation ||
      binding.recipeId !== identity.recipeId ||
      binding.kind !== identity.kind ||
      binding.jobId !== identity.jobId ||
      binding.epoch !== identity.epoch ||
      binding.reservationId !== identity.reservationId
    ) {
      throw new StorageSafetyError("DERIVED_PUBLISH_IDENTITY");
    }
    return store.publishSealed(this);
  }

  /**
   * Full-decode this sealed candidate in the fixed verifier.
   * The result is not a READY asset and is not published.
   */
  verify(
    store: DerivedStore,
    binding: { epoch: bigint; kind: "THUMBNAIL" | "PREVIEW" },
    scenario: DerivedVerifyScenario = "run",
  ): DerivedVerifyResult {
    this.#assertLive();
    if (!VERIFY_SCENARIOS.has(scenario)) {
      throw new StorageSafetyError("STORAGE_INVALID_ARGUMENT");
    }
    if (scenario !== "run" && process.env.NODE_ENV === "production") {
      throw new StorageSafetyError("DERIVED_FAULT_DEV_ONLY");
    }
    this.assertBinding(binding.epoch, binding.kind);
    if (store !== this.#store) {
      throw new StorageSafetyError("DERIVED_STORE_MISMATCH");
    }
    return store.verifySealed(this, scenario);
  }

  runVerify(
    store: DerivedStore,
    native: DerivedNative,
    handle: NativeStore,
    scenario: DerivedVerifyScenario,
  ): DerivedVerifyResult {
    if (
      !liveSealed.has(this) ||
      this.#consumed ||
      store !== this.#store ||
      native !== this.#native
    ) {
      throw new StorageSafetyError("DERIVED_STORE_MISMATCH");
    }
    try {
      const raw = native.verifySealedOutput(this.#handle, handle, scenario);
      if (
        raw.staticImage !== true ||
        raw.sha256Hex !== this.#identity.sha256Hex ||
        !Number.isInteger(raw.width) ||
        !Number.isInteger(raw.height) ||
        raw.width <= 0 ||
        raw.height <= 0
      ) {
        this.finish(store, native, handle);
        throw new StorageSafetyError("DERIVED_VERIFY_REJECTED");
      }
      return {
        width: raw.width,
        height: raw.height,
        staticImage: true,
        alpha: raw.alpha,
        transparent: raw.transparent,
        sha256Hex: raw.sha256Hex,
      };
    } catch (error) {
      if (error instanceof StorageSafetyError) {
        this.#consumed = true;
        liveSealed.delete(this);
        throw error;
      }
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "DERIVED_VERIFY_FAILED";
      if (
        code !== "DERIVED_SEALED_CLOSED" &&
        code !== "DERIVED_ALREADY_VERIFIED" &&
        code !== "DERIVED_VERIFIER_UNAVAILABLE" &&
        code !== "STORAGE_INVALID_ARGUMENT" &&
        code !== "DERIVED_FAULT_DEV_ONLY"
      ) {
        this.#consumed = true;
        liveSealed.delete(this);
      }
      throw new StorageSafetyError(code);
    }
  }

  finish(store: DerivedStore, native: DerivedNative, handle: NativeStore) {
    if (!liveSealed.has(this) || this.#consumed || store !== this.#store) {
      throw new StorageSafetyError("DERIVED_STORE_MISMATCH");
    }
    if (native !== this.#native) {
      throw new StorageSafetyError("DERIVED_STORE_MISMATCH");
    }
    native.consumeSealedOutput(this.#handle, handle);
    this.#consumed = true;
    liveSealed.delete(this);
  }

  finishPublish(
    store: DerivedStore,
    native: DerivedNative,
    handle: NativeStore,
  ) {
    if (
      !liveSealed.has(this) ||
      this.#consumed ||
      store !== this.#store ||
      native !== this.#native
    ) {
      throw new StorageSafetyError("DERIVED_STORE_MISMATCH");
    }
    try {
      const raw = native.publishSealedOutput(this.#handle, handle);
      this.#consumed = true;
      liveSealed.delete(this);
      if (
        (raw.outcome !== "PUBLISHED" && raw.outcome !== "IDENTICAL") ||
        raw.sha256Hex !== this.#identity.sha256Hex ||
        raw.kind !== this.#identity.kind ||
        raw.generation !== this.#identity.generation.toString()
      ) {
        throw new StorageSafetyError("DERIVED_PUBLISH_FAILED");
      }
      return raw;
    } catch (error) {
      if (error instanceof StorageSafetyError) {
        this.#consumed = true;
        liveSealed.delete(this);
        throw error;
      }
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "DERIVED_PUBLISH_FAILED";
      if (
        code !== "DERIVED_SEALED_CLOSED" &&
        code !== "DERIVED_PUBLISH_UNVERIFIED"
      ) {
        this.#consumed = true;
        liveSealed.delete(this);
      }
      throw new StorageSafetyError(code);
    }
  }

  #assertLive() {
    if (!liveSealed.has(this) || this.#consumed) {
      throw new StorageSafetyError("DERIVED_SEALED_CLOSED");
    }
  }
}

export function isSealedDerivedOutput(
  value: unknown,
): value is SealedDerivedOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    liveSealed.has(value as SealedDerivedOutput)
  );
}

/** Lifetime derived-writer capability. It seals an owned temp and does not publish. */
export class DerivedStore {
  readonly #native: DerivedNative;
  readonly #handle: NativeStore;
  readonly #rootPath: string;
  #closed = false;

  private constructor(
    native: DerivedNative,
    handle: NativeStore,
    rootPath: string,
  ) {
    this.#native = native;
    this.#handle = handle;
    this.#rootPath = rootPath;
  }

  static open(capability: StorageCapability) {
    assertWritable(capability);
    capability.root.assertIdentity();
    const native = loadNative();
    try {
      return new DerivedStore(
        native,
        native.openDerivedStore(
          capability.root.canonicalPath,
          capability.root.markerId,
        ),
        capability.root.canonicalPath,
      );
    } catch (error) {
      throw safetyError("DERIVED_STORE_UNAVAILABLE", error);
    }
  }

  sameCapabilityRoot(capability: StorageCapability) {
    return (
      capability.state === "READ_WRITE" &&
      capability.root.canonicalPath === this.#rootPath
    );
  }

  consumeSealed(output: SealedDerivedOutput) {
    output.finish(this, this.#native, this.#handle);
  }

  verifySealed(output: SealedDerivedOutput, scenario: DerivedVerifyScenario) {
    return output.runVerify(this, this.#native, this.#handle, scenario);
  }

  publishSealed(output: SealedDerivedOutput) {
    return output.finishPublish(this, this.#native, this.#handle);
  }

  /**
   * Deletes one open temp whose device, inode, size, and SHA still match.
   * A sealed temp, a symlink, or any existing final name is refused.
   */
  cleanupExactTemp(
    capability: StorageCapability,
    fact: {
      jobId: string;
      epoch: bigint;
      kind: "THUMBNAIL" | "PREVIEW";
      byteSize: bigint;
      device: string;
      inode: string;
      sha256Hex: string;
      familyId: string;
      mediaId: string;
      generation: bigint;
      recipeId: 1;
    },
  ) {
    assertWritable(capability);
    if (!this.sameCapabilityRoot(capability)) {
      throw new StorageSafetyError("DERIVED_STORE_MISMATCH");
    }
    const native = this.#required();
    try {
      const durable = native.cleanupExactDerivedTemp(
        this.#handle,
        fact.jobId,
        fact.epoch.toString(),
        fact.kind,
        fact.device,
        fact.inode,
        fact.byteSize.toString(),
        fact.sha256Hex,
        fact.familyId,
        fact.mediaId,
        fact.generation.toString(),
        String(fact.recipeId),
      );
      if (durable !== true)
        throw new StorageSafetyError("DERIVED_RECOVERY_DURABILITY_UNKNOWN");
    } catch (error) {
      if (error instanceof StorageSafetyError) throw error;
      throw safetyError("DERIVED_RECOVERY_CLEANUP", error);
    }
  }

  /** Dev-only: the next verifier discards a successful decode after the post-check. */
  failNextVerifyPostForDev() {
    if (process.env.NODE_ENV === "production") {
      throw new StorageSafetyError("DERIVED_FAULT_DEV_ONLY");
    }
    this.#required();
    this.#native.failNextVerifyPost(this.#handle);
  }

  /** Dev-only durability fault. The next owned write fails before it can be sealed. */
  failNextFsyncForDev() {
    if (process.env.NODE_ENV === "production") {
      throw new StorageSafetyError("DERIVED_FAULT_DEV_ONLY");
    }
    this.#required();
    this.#native.failNextDerivedFsync(this.#handle);
  }

  /** Dev-only seal fault. `fsync` fails after the mode change; `close` fails after durability. */
  failNextSealFaultForDev(fault: "fsync" | "close") {
    if (process.env.NODE_ENV === "production") {
      throw new StorageSafetyError("DERIVED_FAULT_DEV_ONLY");
    }
    this.#required();
    this.#native.failNextSealFault(this.#handle, fault);
  }

  async createOwnedTemp(
    capability: StorageCapability,
    permit: DerivedTempAdmissionPermit,
    candidate: unknown,
    confirmCurrentLease: (
      identity: DerivedTempPermitIdentity,
    ) => Promise<boolean>,
  ) {
    assertWritable(capability);
    if (capability.root.canonicalPath !== this.#rootPath) {
      throw new StorageSafetyError("DERIVED_ROOT_INVALID");
    }
    capability.root.assertIdentity();
    if (!isDerivedTempAdmissionPermit(permit)) {
      throw new StorageSafetyError("DERIVED_PERMIT_INVALID");
    }
    const peeked = permit.currentIdentity();
    assertCanonicalTempIdentity(peeked);
    const bytes = validateCandidate(candidate, {
      identity: peeked,
      reservationId: permit.reservationId,
      reservedBytes: permit.reservedBytes,
    });
    if (!(await confirmCurrentLease(peeked))) {
      throw new StorageSafetyError("DERIVED_LEASE_LOST");
    }
    if (performance.now() >= permit.deadline) {
      throw new StorageSafetyError("DERIVED_PERMIT_INVALID");
    }
    const consumed = permit.consume();
    const native = this.#required();
    let writer: DerivedTempWriter;
    try {
      writer = new DerivedTempWriter(
        this.#native,
        native.createDerivedTemp(
          this.#handle,
          consumed.identity.jobId,
          consumed.identity.leaseEpoch.toString(),
          consumed.identity.kind,
          consumed.identity.familyId,
          consumed.identity.mediaId,
          consumed.identity.generation.toString(),
          String(consumed.identity.recipeId),
          consumed.reservationId,
        ),
        consumed,
      );
    } catch (error) {
      throw safetyError("DERIVED_TEMP_CREATE_FAILED", error);
    }
    try {
      writer.writeCandidate(capability, {
        ...(candidate as UnverifiedRenderedCandidate),
        bytes,
      });
    } catch (error) {
      try {
        writer.cleanupOwnedFailure(capability);
      } catch {
        // The create failure already removed the owned leaf when it could.
      }
      throw error;
    }
    return writer;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#native.closeDerivedStore(this.#handle);
    } catch (error) {
      this.#closed = false;
      throw safetyError("DERIVED_STORE_CLOSE_FAILED", error);
    }
  }

  #required() {
    if (this.#closed) throw new StorageSafetyError("DERIVED_STORE_CLOSED");
    return this.#native;
  }
}

function assertWritable(
  capability: StorageCapability,
): asserts capability is { state: "READ_WRITE"; root: StorageRoot } {
  if (capability.state === "READ_ONLY") {
    throw new StorageSafetyError("DERIVED_READ_ONLY");
  }
  if (capability.state !== "READ_WRITE") {
    throw new StorageSafetyError("DERIVED_UNAVAILABLE");
  }
}

function validateCandidate(
  candidate: unknown,
  business: {
    identity: DerivedTempPermitIdentity;
    reservationId: string;
    reservedBytes: bigint;
  },
) {
  if (!isCandidate(candidate)) {
    throw new StorageSafetyError("DERIVED_CANDIDATE_INVALID");
  }
  if (
    candidate.kind !== business.identity.kind ||
    candidate.recipe !== business.identity.recipeId
  ) {
    throw new StorageSafetyError("DERIVED_PERMIT_IDENTITY");
  }
  if (
    candidate.bytes.length === 0 ||
    candidate.bytes.length > KIND_CAP[candidate.kind]
  ) {
    throw new StorageSafetyError("DERIVED_CANDIDATE_INVALID");
  }
  if (BigInt(candidate.bytes.length) > business.reservedBytes) {
    throw new StorageSafetyError("DERIVED_CANDIDATE_INVALID");
  }
  const actual = createHash("sha256").update(candidate.bytes).digest("hex");
  if (actual !== candidate.sha256Hex) {
    throw new StorageSafetyError("DERIVED_HASH_MISMATCH");
  }
  return Buffer.from(candidate.bytes);
}
