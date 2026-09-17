import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

import {
  CommitOutcomeUnknownError,
  type MySqlUploadRepository,
  TransactionRollbackFailedError,
  UploadRepositoryError,
} from "@family-album/db";
import {
  type StorageCapability,
  type StorageRoot,
  StorageSafetyError,
  validateDisplayFilename,
} from "@family-album/storage";

import { PublicAuthError, type AuthContext } from "../auth/service.js";

const MAX_FILE_SIZE = 32n * 1024n ** 3n;
const MAX_CHUNK_SIZE = 16n * 1024n ** 2n;
const GLOBAL_ACTIVE_DECLARED_BUDGET = 128n * 1024n ** 3n;
const SCRATCH_RESERVE = 64n * 1024n ** 2n;
const MIN_FREE_RESERVE = 10n * 1024n ** 3n;
const BODY_IDLE_TIMEOUT_MS = 30_000;
const PATCH_TIMEOUT_MS = 120_000;
const FINALIZE_TIMEOUT_MS = 15 * 60_000;

export type UploadRepository = Pick<
  MySqlUploadRepository,
  | "admissionUsage"
  | "createUpload"
  | "inspect"
  | "advanceOffset"
  | "abort"
  | "markCleaned"
  | "markFailed"
  | "trustedState"
  | "assertFinalizeDurability"
  | "beginFinalize"
  | "findStorageObject"
  | "markStorageIntegrityIssue"
  | "completeFinalize"
>;

export class UploadServiceError extends Error {
  readonly status_code: number;
  readonly body: string;

  constructor(
    statusCode: number,
    readonly code:
      | "INVALID_REQUEST"
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "OFFSET_MISMATCH"
      | "UPLOAD_STATE_CONFLICT"
      | "UPLOAD_EXPIRED"
      | "UPLOAD_TOO_LARGE"
      | "RATE_LIMITED"
      | "STORAGE_UNAVAILABLE"
      | "INSUFFICIENT_STORAGE"
      | "OUTCOME_UNKNOWN",
    readonly currentOffset?: bigint,
    readonly internalCategory?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "UploadServiceError";
    this.status_code = statusCode;
    this.body = `${code}\n`;
  }
}

export class UploadService {
  readonly maxFileSize = MAX_FILE_SIZE;
  readonly maxChunkSize = MAX_CHUNK_SIZE;
  #root: StorageRoot | null;
  #capabilityState: StorageCapability["state"];
  #admission = Promise.resolve();
  #bodySlots = 0;
  #frozen = new Set<string>();
  #finalizeFrozen = new Set<string>();
  #hashTails = new Map<string, Promise<void>>();
  #hashWaiters = new Map<string, number>();
  #hashInFlight = false;

  constructor(
    private readonly repository: UploadRepository,
    capability: StorageCapability,
  ) {
    this.#root = capability.state === "UNAVAILABLE" ? null : capability.root;
    this.#capabilityState = capability.state;
  }

  async create(
    context: AuthContext,
    input: {
      familyId: string;
      publicId: Buffer;
      declaredSize: bigint;
      filename: unknown;
      reportedMime: unknown;
    },
  ) {
    const filename = validateFilename(input.filename);
    const reportedMime = validateMime(input.reportedMime);
    if (input.declaredSize <= 0n || input.declaredSize > MAX_FILE_SIZE) {
      throw new UploadServiceError(413, "UPLOAD_TOO_LARGE");
    }
    return this.withAdmission(async () => {
      const root = this.requireWritable();
      const usage = await this.database(() => this.repository.admissionUsage());
      if (
        usage.outstanding + input.declaredSize >
        GLOBAL_ACTIVE_DECLARED_BUDGET
      ) {
        throw new UploadServiceError(
          429,
          "RATE_LIMITED",
          undefined,
          undefined,
          60,
        );
      }
      const capacity = root.capacity();
      const reserve = maximum(MIN_FREE_RESERVE, capacity.totalBytes / 10n);
      // The filesystem's available bytes already exclude written staging and
      // originals. Reserve only bytes that future PATCH requests may still add.
      const futureBytes = usage.reservedFutureBytes ?? usage.outstanding;
      if (
        capacity.availableBytes <
        reserve + SCRATCH_RESERVE + futureBytes + input.declaredSize
      ) {
        throw new UploadServiceError(507, "INSUFFICIENT_STORAGE");
      }
      const publicId = input.publicId;
      const upload = await this.database(() =>
        this.repository.createUpload({
          actor: actor(context),
          familyId: input.familyId,
          publicId,
          originalFilename: filename,
          reportedMime,
          declaredSize: input.declaredSize,
        }),
      );
      try {
        root.createUploadPayload(upload.familyId, upload.publicId);
      } catch {
        await this.database(() =>
          this.repository.markFailed(publicId, "STAGING_CREATE_FAILED"),
        );
        throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
      }
      return upload;
    });
  }

  async head(context: AuthContext, publicId: Buffer) {
    const upload = await this.inspect(context, publicId, undefined, true);
    if (upload.state === "COMPLETE") {
      await this.verifyCompletedUpload(upload);
      return upload;
    }
    if (upload.state === "FINALIZING") return upload;
    if (upload.state === "EXPIRED") {
      if (this.#capabilityState === "READ_WRITE")
        await this.cleanupExpired(publicId);
      throw new UploadServiceError(410, "UPLOAD_EXPIRED");
    }
    if (upload.state !== "CREATED" && upload.state !== "UPLOADING") {
      throw new UploadServiceError(409, "UPLOAD_STATE_CONFLICT");
    }
    const root = this.requireReadable();
    const size = this.storage(() =>
      root.inspectUploadPayload(upload.familyId, upload.publicId),
    );
    if (size !== upload.committedOffset) {
      this.#frozen.add(upload.publicId);
      if (size < upload.committedOffset) {
        await this.database(() =>
          this.repository.markFailed(publicId, "STAGING_INTEGRITY_MISMATCH"),
        );
      }
      throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
    }
    return upload;
  }

  async patch(
    context: AuthContext,
    publicId: Buffer,
    expectedOffset: bigint,
    stream: Readable,
  ) {
    const key = publicId.toString("hex");
    if (this.#frozen.has(key)) {
      throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
    }
    const t1 = await this.inspect(context, publicId, expectedOffset);
    const root = this.requireWritable();
    const releaseBody = this.acquireBodySlot();
    let chunk: Buffer;
    try {
      chunk = await readBoundedBody(
        stream,
        minimum(MAX_CHUNK_SIZE, t1.declaredSize - t1.committedOffset),
      );
    } finally {
      releaseBody();
    }
    if (chunk.byteLength === 0) return t1;

    const requestId = randomBytes(16).toString("hex");
    this.storage(() => root.createChunkScratch(key, requestId, chunk));
    let payloadMayHaveAdvanced = false;
    try {
      const t2 = await this.inspect(context, publicId, expectedOffset);
      const payloadSize = this.storage(() =>
        root.inspectUploadPayload(t2.familyId, t2.publicId),
      );
      if (payloadSize !== expectedOffset) {
        this.#frozen.add(key);
        if (payloadSize < expectedOffset) {
          await this.database(() =>
            this.repository.markFailed(publicId, "STAGING_INTEGRITY_MISMATCH"),
          );
        }
        throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
      }
      // A native append can advance the payload before a later write/fsync error.
      // From this point until the DB offset commits, restore from the DB authority
      // on every known failure.
      payloadMayHaveAdvanced = true;
      const durableBytes = this.storage(() =>
        root.commitChunk({
          familyId: t2.familyId,
          uploadId: t2.publicId,
          requestId,
          expectedOffset,
          declaredSize: t2.declaredSize,
        }),
      );
      this.storage(() => root.removeChunkScratch(key, requestId));
      const committed = await this.database(() =>
        this.repository.advanceOffset({
          actor: actor(context),
          publicId,
          expectedOffset,
          durableBytes,
        }),
      );
      payloadMayHaveAdvanced = false;
      return committed;
    } catch (error) {
      if (
        payloadMayHaveAdvanced &&
        !(
          error instanceof UploadServiceError &&
          error.code === "OUTCOME_UNKNOWN"
        )
      ) {
        await this.restoreTrustedPrefix(root, publicId, key);
      } else if (
        error instanceof UploadServiceError &&
        error.code === "OUTCOME_UNKNOWN"
      ) {
        this.#frozen.add(key);
      }
      throw error;
    } finally {
      try {
        root.removeChunkScratch(key, requestId);
      } catch {
        // An exact scratch cleanup failure is observable but must not mask the
        // stronger upload result. Phase 3D reconciliation owns retry cleanup.
      }
    }
  }

  async status(context: AuthContext, publicId: Buffer) {
    const upload = await this.inspect(context, publicId, undefined, true);
    if (upload.state === "COMPLETE") await this.verifyCompletedUpload(upload);
    if (
      upload.state === "EXPIRED" &&
      !upload.stagingCleanedAt &&
      this.#capabilityState === "READ_WRITE"
    ) {
      await this.cleanupExpired(publicId);
    }
    return upload;
  }

  async finalize(
    context: AuthContext,
    publicId: Buffer,
    shouldContinue: () => boolean = () => true,
    onSecurityEvent: (
      event:
        "upload_finalize_started" | "upload_failed" | "storage_integrity_issue",
    ) => void = () => undefined,
  ) {
    const startedAt = Date.now();
    const key = publicId.toString("hex");
    if (this.#frozen.has(key) && !this.#finalizeFrozen.has(key)) {
      throw new UploadServiceError(
        503,
        "OUTCOME_UNKNOWN",
        undefined,
        undefined,
        5,
      );
    }
    const root = this.requireWritable();
    const initial = await this.inspect(context, publicId, undefined, true);
    // An explicit authenticated retry obtains a fresh locking DB snapshot before
    // resolving a prior ambiguous finalize outcome. The old transaction is not replayed.
    if (this.#finalizeFrozen.has(key)) {
      this.#finalizeFrozen.delete(key);
      this.#frozen.delete(key);
    }
    if (initial.state === "COMPLETE") {
      await this.verifyCompletedUpload(initial);
      await this.cleanupCompleted(initial, publicId, root);
      return this.publicComplete(initial);
    }
    if (initial.state === "EXPIRED") {
      await this.cleanupExpired(publicId);
      throw new UploadServiceError(410, "UPLOAD_EXPIRED");
    }
    if (initial.state !== "UPLOADING" && initial.state !== "FINALIZING") {
      throw new UploadServiceError(409, "UPLOAD_STATE_CONFLICT");
    }
    if (initial.committedOffset !== initial.declaredSize) {
      throw new UploadServiceError(409, "UPLOAD_STATE_CONFLICT");
    }

    let hash: Buffer;
    if (initial.state === "UPLOADING") {
      const verified = this.hashStaging(root, initial.familyId, key);
      if (verified.byteSize !== initial.declaredSize) {
        await this.database(() =>
          this.repository.markFailed(publicId, "FINALIZE_SIZE_MISMATCH"),
        );
        onSecurityEvent("upload_failed");
        throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
      }
      hash = verified.sha256;
    } else {
      if (!initial.computedSha256) {
        throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
      }
      hash = initial.computedSha256;
    }
    const hashKey = `${initial.familyId}:${hash.toString("hex")}:${initial.declaredSize}`;
    const pending = this.#hashWaiters.get(hashKey) ?? 0;
    if (pending >= 4) {
      throw new UploadServiceError(
        429,
        "RATE_LIMITED",
        undefined,
        undefined,
        1,
      );
    }
    this.#hashWaiters.set(hashKey, pending + 1);
    const previous = this.#hashTails.get(hashKey);
    let releaseHash!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    this.#hashTails.set(hashKey, current);
    if (previous) await previous;
    try {
      const intent = await this.database(() =>
        this.repository.beginFinalize({
          actor: actor(context),
          publicId,
          sha256: hash,
        }),
      );
      if (intent.state === "COMPLETE") {
        await this.verifyCompletedUpload(intent);
        await this.cleanupCompleted(intent, publicId, root);
        return this.publicComplete(intent);
      }
      onSecurityEvent("upload_finalize_started");
      this.assertFinalizeDeadline(startedAt, shouldContinue);
      await this.database(() => this.repository.assertFinalizeDurability());
      const shaHex = hash.toString("hex");
      const byteSize = intent.declaredSize.toString();
      const object = await this.database(() =>
        this.repository.findStorageObject({
          familyId: intent.familyId,
          sha256: hash,
          byteSize: intent.declaredSize,
        }),
      );
      if (
        object &&
        (object.state !== "AVAILABLE" ||
          object.keyVersion !== 1 ||
          object.byteSize !== intent.declaredSize ||
          !object.sha256.equals(hash))
      ) {
        throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
      }
      let originalExists = false;
      try {
        const verified = this.hashOriginal(
          root,
          intent.familyId,
          shaHex,
          byteSize,
        );
        if (
          !verified.sha256.equals(hash) ||
          verified.byteSize !== intent.declaredSize
        ) {
          throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
        }
        originalExists = true;
      } catch (error) {
        if (object && (isNotFound(error) || isCorruptOriginal(error))) {
          await this.database(() =>
            this.repository.markStorageIntegrityIssue({
              familyId: intent.familyId,
              sha256: hash,
              byteSize: intent.declaredSize,
              state: isNotFound(error) ? "MISSING" : "CORRUPT",
            }),
          );
          onSecurityEvent("storage_integrity_issue");
        }
        if (!isNotFound(error) || object)
          throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
      }
      if (!originalExists) {
        this.assertFinalizeDeadline(startedAt, shouldContinue);
        const staged = this.hashStaging(root, intent.familyId, key, true);
        if (
          staged.byteSize !== intent.declaredSize ||
          !staged.sha256.equals(hash)
        ) {
          await this.database(() =>
            this.repository.markFailed(publicId, "FINALIZE_HASH_MISMATCH"),
          );
          onSecurityEvent("upload_failed");
          throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
        }
        try {
          root.publishOriginal({
            familyId: intent.familyId,
            uploadId: key,
            sha256Hex: shaHex,
            byteSize,
          });
        } catch (error) {
          if (!isAlreadyExists(error)) {
            throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
          }
        }
        const published = this.hashOriginal(
          root,
          intent.familyId,
          shaHex,
          byteSize,
        );
        if (
          published.byteSize !== intent.declaredSize ||
          !published.sha256.equals(hash)
        ) {
          throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
        }
      }
      this.assertFinalizeDeadline(startedAt, shouldContinue);
      this.storage(() => root.assertIdentity());
      const complete = await this.database(() =>
        this.repository.completeFinalize({
          actor: actor(context),
          publicId,
          sha256: hash,
          byteSize: intent.declaredSize,
        }),
      );
      await this.cleanupCompleted(complete, publicId, root);
      return this.publicComplete(complete);
    } catch (error) {
      if (
        error instanceof UploadServiceError &&
        error.code === "UPLOAD_EXPIRED"
      ) {
        await this.cleanupExpired(publicId);
      }
      if (
        error instanceof UploadServiceError &&
        error.code === "OUTCOME_UNKNOWN"
      ) {
        this.#frozen.add(key);
        this.#finalizeFrozen.add(key);
      }
      throw error;
    } finally {
      releaseHash();
      const remaining = (this.#hashWaiters.get(hashKey) ?? 1) - 1;
      if (remaining === 0) this.#hashWaiters.delete(hashKey);
      else this.#hashWaiters.set(hashKey, remaining);
      if (this.#hashTails.get(hashKey) === current)
        this.#hashTails.delete(hashKey);
    }
  }

  private assertFinalizeDeadline(
    startedAt: number,
    shouldContinue: () => boolean,
  ) {
    if (Date.now() - startedAt >= FINALIZE_TIMEOUT_MS || !shouldContinue()) {
      throw new UploadServiceError(
        503,
        "STORAGE_UNAVAILABLE",
        undefined,
        undefined,
        5,
      );
    }
  }

  private hashStaging(
    root: StorageRoot,
    familyId: string,
    uploadId: string,
    finalizing = false,
  ) {
    if (this.#hashInFlight) {
      throw new UploadServiceError(
        429,
        "RATE_LIMITED",
        undefined,
        undefined,
        1,
      );
    }
    this.#hashInFlight = true;
    try {
      return root.hashUploadPayload(familyId, uploadId, finalizing);
    } finally {
      this.#hashInFlight = false;
    }
  }

  private hashOriginal(
    root: StorageRoot,
    familyId: string,
    shaHex: string,
    byteSize: string,
  ) {
    if (this.#hashInFlight) {
      throw new UploadServiceError(
        429,
        "RATE_LIMITED",
        undefined,
        undefined,
        1,
      );
    }
    this.#hashInFlight = true;
    try {
      return root.verifyOriginal(familyId, shaHex, byteSize);
    } finally {
      this.#hashInFlight = false;
    }
  }

  private publicComplete(upload: {
    publicId: string;
    state: string;
    committedOffset: bigint;
    completedAt: Date | null;
  }) {
    return {
      uploadId: upload.publicId,
      state: "COMPLETE" as const,
      committedOffset: upload.committedOffset.toString(),
      completedAt: upload.completedAt?.toISOString() ?? null,
    };
  }

  private async cleanupCompleted(
    upload: {
      familyId: string;
      publicId: string;
      stagingCleanedAt: Date | null;
    },
    publicId: Buffer,
    root: StorageRoot,
  ) {
    if (upload.stagingCleanedAt) return;
    try {
      root.removeUploadPayload(upload.familyId, upload.publicId);
    } catch (error) {
      if (!isNotFound(error)) return;
    }
    try {
      await this.database(() => this.repository.markCleaned(publicId));
    } catch {
      // A completed receipt and immutable original cannot be rolled back by cleanup.
    }
  }

  private async verifyCompletedUpload(upload: {
    familyId: string;
    declaredSize: bigint;
    computedSha256: Buffer | null;
    storageObjectId: string | null;
  }) {
    if (!upload.computedSha256 || !upload.storageObjectId) {
      throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
    }
    const object = await this.database(() =>
      this.repository.findStorageObject({
        familyId: upload.familyId,
        sha256: upload.computedSha256!,
        byteSize: upload.declaredSize,
      }),
    );
    if (
      !object ||
      object.id !== upload.storageObjectId ||
      object.state !== "AVAILABLE" ||
      object.keyVersion !== 1
    ) {
      throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
    }
    try {
      this.requireReadable().verifyOriginal(
        upload.familyId,
        upload.computedSha256.toString("hex"),
        upload.declaredSize.toString(),
      );
    } catch (error) {
      if (isNotFound(error) || isCorruptOriginal(error)) {
        await this.database(() =>
          this.repository.markStorageIntegrityIssue({
            familyId: upload.familyId,
            sha256: upload.computedSha256!,
            byteSize: upload.declaredSize,
            state: isNotFound(error) ? "MISSING" : "CORRUPT",
          }),
        );
      }
      throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
    }
  }

  async abort(context: AuthContext, publicId: Buffer) {
    const root = this.requireWritable();
    let result: Awaited<ReturnType<UploadRepository["abort"]>>;
    try {
      result = await this.database(() =>
        this.repository.abort({ actor: actor(context), publicId }),
      );
    } catch (error) {
      if (
        error instanceof UploadServiceError &&
        error.code === "UPLOAD_EXPIRED"
      ) {
        if (this.#capabilityState === "READ_WRITE")
          await this.cleanupExpired(publicId);
      }
      throw error;
    }
    if (!result.upload.stagingCleanedAt) {
      try {
        root.removeUploadPayload(
          result.upload.familyId,
          result.upload.publicId,
        );
      } catch (error) {
        if (!isNotFound(error)) {
          throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
        }
      }
      await this.database(() => this.repository.markCleaned(publicId));
    }
    return result.upload;
  }

  private async inspect(
    context: AuthContext,
    publicId: Buffer,
    expectedOffset?: bigint,
    allowTerminal = false,
  ) {
    try {
      return await this.database(() =>
        this.repository.inspect({
          actor: actor(context),
          publicId,
          ...(expectedOffset === undefined ? {} : { expectedOffset }),
          ...(allowTerminal ? { allowTerminal: true } : {}),
          ...(this.#capabilityState === "READ_WRITE"
            ? {}
            : { transitionExpiry: false }),
        }),
      );
    } catch (error) {
      if (
        error instanceof UploadServiceError &&
        error.code === "UPLOAD_EXPIRED"
      ) {
        if (this.#capabilityState === "READ_WRITE")
          await this.cleanupExpired(publicId);
      }
      throw error;
    }
  }

  private async cleanupExpired(publicId: Buffer) {
    const root = this.requireWritable();
    const upload = await this.database(() =>
      this.repository.trustedState(publicId),
    );
    try {
      root.removeUploadPayload(upload.familyId, upload.publicId);
    } catch (error) {
      if (!isNotFound(error)) return;
    }
    await this.database(() => this.repository.markCleaned(publicId));
  }

  private async restoreTrustedPrefix(
    root: StorageRoot,
    publicId: Buffer,
    key: string,
  ) {
    try {
      const trusted = await this.repository.trustedState(publicId);
      if (!["CREATED", "UPLOADING"].includes(trusted.state)) {
        this.#frozen.add(key);
        return;
      }
      root.truncateUploadPayload(
        trusted.familyId,
        trusted.publicId,
        trusted.committedOffset,
      );
    } catch {
      this.#frozen.add(key);
    }
  }

  private acquireBodySlot() {
    if (this.#bodySlots >= 2) {
      throw new UploadServiceError(
        429,
        "RATE_LIMITED",
        undefined,
        undefined,
        1,
      );
    }
    this.#bodySlots += 1;
    return () => {
      this.#bodySlots -= 1;
    };
  }

  private requireWritable() {
    if (!this.#root || this.#capabilityState !== "READ_WRITE") {
      throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
    }
    try {
      this.#root.assertIdentity();
      const capacity = this.#root.capacity();
      if (
        capacity.availableBytes <
        maximum(MIN_FREE_RESERVE, capacity.totalBytes / 10n)
      ) {
        this.#capabilityState = "READ_ONLY";
        throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
      }
      return this.#root;
    } catch (error) {
      if (error instanceof UploadServiceError) throw error;
      this.#capabilityState = "UNAVAILABLE";
      throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
    }
  }

  private requireReadable() {
    if (!this.#root || this.#capabilityState === "UNAVAILABLE") {
      throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
    }
    try {
      this.#root.assertIdentity();
      return this.#root;
    } catch {
      this.#capabilityState = "UNAVAILABLE";
      throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
    }
  }

  private storage<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof UploadServiceError) throw error;
      if (error instanceof StorageSafetyError) {
        if (
          error.reason.endsWith(":STORAGE_NOT_WRITABLE") ||
          error.reason.endsWith(":STORAGE_NO_SPACE")
        ) {
          this.#capabilityState = "READ_ONLY";
        }
        if (
          error.reason.startsWith("MEDIA_ROOT_") ||
          error.reason.startsWith("CAPACITY_CHECK_FAILED")
        ) {
          this.#capabilityState = "UNAVAILABLE";
        }
        if (/STORAGE_NO_SPACE/u.test(error.reason)) {
          throw new UploadServiceError(507, "INSUFFICIENT_STORAGE");
        }
        throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
      }
      throw error;
    }
  }

  private async database<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof UploadServiceError) throw error;
      if (error instanceof CommitOutcomeUnknownError) {
        throw new UploadServiceError(503, "OUTCOME_UNKNOWN");
      }
      if (error instanceof TransactionRollbackFailedError) {
        throw new UploadServiceError(503, "STORAGE_UNAVAILABLE");
      }
      if (error instanceof UploadRepositoryError) {
        const map = {
          UNAUTHENTICATED: [401, "UNAUTHENTICATED"],
          NOT_FOUND: [404, "NOT_FOUND"],
          OFFSET_MISMATCH: [409, "OFFSET_MISMATCH"],
          UPLOAD_STATE_CONFLICT: [409, "UPLOAD_STATE_CONFLICT"],
          UPLOAD_EXPIRED: [410, "UPLOAD_EXPIRED"],
          QUOTA_EXCEEDED: [429, "RATE_LIMITED"],
          CONFLICT: [409, "UPLOAD_STATE_CONFLICT"],
        } as const;
        const [status, code] = map[error.reason];
        throw new UploadServiceError(status, code, error.currentOffset);
      }
      if (error instanceof PublicAuthError) throw error;
      throw new UploadServiceError(
        503,
        "STORAGE_UNAVAILABLE",
        undefined,
        classifyInternalError(error),
      );
    }
  }

  private async withAdmission<T>(operation: () => Promise<T>) {
    const previous = this.#admission;
    let release!: () => void;
    this.#admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function actor(context: AuthContext) {
  return {
    userId: context.identity.userId,
    sessionId: context.identity.sessionId,
    tokenHash: context.tokenHash,
  };
}

function validateMime(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 127 ||
    !/^[\x20-\x7e]+$/u.test(value) ||
    /[\r\n]/u.test(value)
  ) {
    throw new UploadServiceError(400, "INVALID_REQUEST");
  }
  return value;
}

function validateFilename(value: unknown) {
  try {
    return validateDisplayFilename(value);
  } catch (error) {
    if (error instanceof StorageSafetyError) {
      throw new UploadServiceError(400, "INVALID_REQUEST");
    }
    throw error;
  }
}

async function readBoundedBody(stream: Readable, maximum: bigint) {
  if (maximum < 0n || maximum > MAX_CHUNK_SIZE) {
    throw new UploadServiceError(413, "UPLOAD_TOO_LARGE");
  }
  const chunks: Buffer[] = [];
  let length = 0n;
  const started = Date.now();
  let idle: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(
      () => stream.destroy(new Error("UPLOAD_BODY_TIMEOUT")),
      BODY_IDLE_TIMEOUT_MS,
    );
  };
  resetIdle();
  try {
    for await (const value of stream) {
      if (Date.now() - started > PATCH_TIMEOUT_MS) {
        throw new UploadServiceError(400, "INVALID_REQUEST");
      }
      resetIdle();
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value as Uint8Array);
      length += BigInt(chunk.byteLength);
      if (length > maximum || length > MAX_CHUNK_SIZE) {
        throw new UploadServiceError(413, "UPLOAD_TOO_LARGE");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof UploadServiceError) throw error;
    throw new UploadServiceError(400, "INVALID_REQUEST");
  } finally {
    if (idle) clearTimeout(idle);
  }
  return Buffer.concat(chunks, Number(length));
}

function minimum(left: bigint, right: bigint) {
  return left < right ? left : right;
}

function maximum(left: bigint, right: bigint) {
  return left > right ? left : right;
}

function isNotFound(error: unknown) {
  return (
    error instanceof StorageSafetyError &&
    /STORAGE_NOT_FOUND/u.test(error.reason)
  );
}

function isAlreadyExists(error: unknown) {
  return (
    error instanceof StorageSafetyError &&
    /STORAGE_ALREADY_EXISTS/u.test(error.reason)
  );
}

function isCorruptOriginal(error: unknown) {
  return (
    error instanceof StorageSafetyError &&
    error.reason === "ORIGINAL_INTEGRITY_MISMATCH"
  );
}

function classifyInternalError(error: unknown) {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    reason?: unknown;
    message?: unknown;
  };
  if (
    candidate.code === "ER_BAD_FIELD_ERROR" &&
    typeof candidate.message === "string"
  ) {
    const field = /Unknown column '([a-z_]+)'/u.exec(candidate.message)?.[1];
    if (field) return `ER_BAD_FIELD_ERROR_${field.toUpperCase()}`;
  }
  if (
    typeof candidate.code === "string" &&
    /^[A-Z0-9_]+$/u.test(candidate.code)
  ) {
    return candidate.code;
  }
  if (
    typeof candidate.reason === "string" &&
    /^[A-Z0-9_]+$/u.test(candidate.reason)
  ) {
    return candidate.reason;
  }
  return typeof candidate.name === "string" ? candidate.name : "UNKNOWN";
}

export function parseUploadPublicId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value)) {
    throw new UploadServiceError(404, "NOT_FOUND");
  }
  return Buffer.from(value, "hex");
}

export function parseTusDecimal(
  value: unknown,
  missingCode: "INVALID_REQUEST" | "OFFSET_MISMATCH",
) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new UploadServiceError(
      missingCode === "OFFSET_MISMATCH" ? 409 : 400,
      missingCode,
    );
  }
  return BigInt(value);
}
