import type {
  MySqlUploadRepository,
  UploadRecord,
  StorageObjectRecord,
} from "@family-album/db";
import { UploadRepositoryError } from "@family-album/db";
import {
  type ControlledDirectoryEntry,
  type StorageCapability,
  type StorageRoot,
  StorageSafetyError,
} from "@family-album/storage";
import { createHash } from "node:crypto";

import type { UploadMutex } from "./mutex.js";

const GRACE_MS = 24 * 60 * 60_000;
const MAX_HASH_BYTES = 64n * 1024n ** 3n;
const MAX_SINGLE_ORIGINAL_BYTES = 32n * 1024n ** 3n;
const MAX_HASHES = 16;
const DIRECTORY_PAGE_LIMIT = 128;
const FAMILY = /^[1-9][0-9]*$/u;
const UPLOAD = /^[0-9a-f]{32}$/u;
const PREFIX = /^[0-9a-f]{2}$/u;
const FINAL = /^([0-9a-f]{64})-([1-9][0-9]*)$/u;

type RecoveryRepository = Pick<
  MySqlUploadRepository,
  | "assertRecoveryReadiness"
  | "recoveryServerTime"
  | "scanUploads"
  | "scanRecoveryUploads"
  | "scanStorageObjects"
  | "trustedState"
  | "systemRevalidate"
  | "systemFailStaging"
  | "markCleaned"
  | "findStorageObject"
  | "findFinalizingIntent"
  | "markStorageIntegrityIssue"
>;

export type ReconciliationMode = "dry-run" | "recover" | "cleanup-staging";
export type ReconciliationScope = "global" | "startup";

export type ReconciliationResult = {
  mode: ReconciliationMode;
  scope: ReconciliationScope;
  capability: StorageCapability["state"];
  scannedUploads: number;
  staleUploads: number;
  expiredTransitioned: number;
  stagingCleaned: number;
  finalizingCandidatesVerified: number;
  knownRecoverableFinalizingCandidates: number;
  finalizingAutoCompleted: 0;
  orphanStagingCandidates: number;
  terminalStagingResidue: number;
  orphanFinalCandidates: number;
  dbMissingFinal: number;
  integrityMismatches: number;
  skippedUnsafeEntries: number;
  errors: number;
  truncated: boolean;
  reasonCodes: string[];
  nextUploadId: string;
  nextObjectId: string;
  nextStagingKey: string;
  nextScratchKey: string;
  nextOriginalKey: string;
};

type ScanBudget = {
  remaining: number;
  hashes: number;
  hashBytes: bigint;
};

export class StorageReconciler {
  private readonly root: StorageRoot | null;

  constructor(
    private readonly repository: RecoveryRepository,
    private readonly capability: StorageCapability,
    private readonly mutex: UploadMutex,
  ) {
    this.root = capability.state === "UNAVAILABLE" ? null : capability.root;
  }

  async run(
    input: {
      mode?: ReconciliationMode;
      scope?: ReconciliationScope;
      familyScope?: string;
      maxCandidates?: number;
      afterUploadId?: string;
      afterObjectId?: string;
      afterStagingKey?: string;
      afterScratchKey?: string;
      afterOriginalKey?: string;
    } = {},
  ): Promise<ReconciliationResult> {
    const mode = input.mode ?? "dry-run";
    const scope = input.scope ?? "global";
    const maximum = input.maxCandidates ?? 128;
    if (
      !["dry-run", "recover", "cleanup-staging"].includes(mode) ||
      !["global", "startup"].includes(scope) ||
      !Number.isInteger(maximum) ||
      maximum < 1 ||
      maximum > 20_000 ||
      !validIdCursor(input.afterUploadId) ||
      !validIdCursor(input.afterObjectId) ||
      !validLogicalCursor(input.afterStagingKey) ||
      !validLogicalCursor(input.afterScratchKey) ||
      !(
        validLogicalCursor(input.afterOriginalKey) ||
        validOriginalCursor(input.afterOriginalKey)
      ) ||
      (input.familyScope !== undefined && !FAMILY.test(input.familyScope))
    ) {
      throw new Error("RECOVERY_PLAN_INVALID");
    }
    if (mode !== "dry-run" && this.capability.state !== "READ_WRITE") {
      throw new Error("STORAGE_RECOVERY_READ_ONLY");
    }
    if (!this.root) throw new Error("STORAGE_RECOVERY_UNAVAILABLE");

    // A failed DB health or migration-readiness check forbids even staging
    // cleanup. Neither a filesystem-only scan nor a cached journal is authority.
    await this.repository.assertRecoveryReadiness();
    this.root.assertIdentity();
    const now = await this.repository.recoveryServerTime();
    const result = emptyResult(mode, scope, this.capability.state);
    result.nextUploadId = input.afterUploadId ?? "0";
    result.nextObjectId = input.afterObjectId ?? "0";
    result.nextStagingKey = input.afterStagingKey ?? "";
    result.nextScratchKey = input.afterScratchKey ?? "";
    result.nextOriginalKey = input.afterOriginalKey ?? "";
    const budget: ScanBudget = {
      remaining: maximum,
      hashes: MAX_HASHES,
      hashBytes: MAX_HASH_BYTES,
    };

    let afterUpload = input.afterUploadId ?? "0";
    let uploadRemaining = maximum;
    while (uploadRemaining > 0) {
      const limit = Math.min(32, uploadRemaining);
      const uploads = await this.repository[
        scope === "startup" ? "scanRecoveryUploads" : "scanUploads"
      ](afterUpload, limit, input.familyScope);
      if (uploads.length === 0) break;
      for (const upload of uploads) {
        await this.mutex.runExclusive(upload.publicId, async () => {
          result.scannedUploads += 1;
          uploadRemaining -= 1;
          await this.inspectUpload(upload, now, mode, budget, result);
        });
        if (result.truncated) return result;
        afterUpload = upload.id;
        result.nextUploadId = afterUpload;
      }
      if (uploads.length < limit) break;
    }

    let afterObject = input.afterObjectId ?? "0";
    let objectRemaining = scope === "startup" ? 0 : maximum;
    while (objectRemaining > 0) {
      const limit = Math.min(16, objectRemaining);
      const objects = await this.repository.scanStorageObjects(
        afterObject,
        limit,
        input.familyScope,
      );
      if (objects.length === 0) break;
      for (const object of objects) {
        objectRemaining -= 1;
        await this.inspectObject(object, mode, budget, result);
        if (result.truncated) return result;
        afterObject = object.id;
        result.nextObjectId = afterObject;
      }
      if (objects.length < limit) break;
    }

    const stagingBudget = { ...budget, remaining: maximum };
    const scratchBudget = { ...budget, remaining: maximum };
    const originalBudget = { ...budget, remaining: maximum };
    await this.scanStagingNamespace(
      now,
      mode,
      stagingBudget,
      result,
      input.afterStagingKey ?? "",
      input.familyScope,
    );
    if (result.truncated) return result;
    budget.hashes = stagingBudget.hashes;
    budget.hashBytes = stagingBudget.hashBytes;
    if (scope === "global" && !input.familyScope) {
      await this.scanScratchNamespace(
        now,
        mode,
        scratchBudget,
        result,
        input.afterScratchKey ?? "",
      );
      if (result.truncated) return result;
    }
    originalBudget.hashes = budget.hashes;
    originalBudget.hashBytes = budget.hashBytes;
    await this.scanOriginalNamespace(
      originalBudget,
      result,
      input.afterOriginalKey ?? "",
      input.familyScope,
    );
    result.truncated ||=
      budget.remaining === 0 ||
      uploadRemaining === 0 ||
      (objectRemaining === 0 && scope === "global") ||
      stagingBudget.remaining === 0 ||
      (scratchBudget.remaining === 0 && scope === "global") ||
      originalBudget.remaining === 0;
    return result;
  }

  private async inspectUpload(
    candidate: UploadRecord,
    now: Date,
    mode: ReconciliationMode,
    budget: ScanBudget,
    result: ReconciliationResult,
  ) {
    const root = this.root!;
    let upload = candidate;
    if (mode !== "dry-run") {
      const checked = await this.repository.systemRevalidate(
        Buffer.from(candidate.publicId, "hex"),
        mode === "recover",
      );
      upload = checked.upload;
      if (checked.expiredTransitioned) {
        result.expiredTransitioned += 1;
      }
    }
    if (
      ["CREATED", "UPLOADING"].includes(upload.state) &&
      now.getTime() - (upload.updatedAt ?? upload.createdAt).getTime() >=
        GRACE_MS
    ) {
      result.staleUploads += 1;
    }
    if (
      mode === "dry-run" &&
      ["CREATED", "UPLOADING"].includes(upload.state) &&
      now >= upload.expiresAt
    ) {
      result.staleUploads += 1;
    }
    if (upload.state === "FINALIZING") {
      await this.inspectFinalizing(upload, budget, result);
      return;
    }
    if (["CREATED", "UPLOADING"].includes(upload.state)) {
      let size: bigint | null;
      try {
        size = root.inspectUploadPayload(upload.familyId, upload.publicId);
      } catch (error) {
        if (!missing(error)) {
          recordError(result, "STAGING_INSPECTION_FAILED");
          return;
        }
        size = null;
      }
      if (size === null) {
        if (upload.state === "CREATED" && upload.committedOffset === 0n) {
          if (mode === "recover" && now < upload.expiresAt) {
            root.assertIdentity();
            try {
              root.createUploadPayload(upload.familyId, upload.publicId);
            } catch (error) {
              if (!alreadyExists(error))
                recordError(result, "STAGING_RECREATE_FAILED");
            }
          }
        } else if (mode === "recover") {
          await this.repository.systemFailStaging(
            Buffer.from(upload.publicId, "hex"),
          );
          result.integrityMismatches += 1;
        } else {
          result.integrityMismatches += 1;
        }
      } else if (size < upload.committedOffset) {
        result.integrityMismatches += 1;
        if (mode === "recover") {
          await this.repository.systemFailStaging(
            Buffer.from(upload.publicId, "hex"),
          );
        }
      } else if (size > upload.committedOffset) {
        // The DB committed prefix is authoritative after a new healthy
        // connection has resolved any unknown prior writer outcome.
        if (mode === "recover") {
          root.assertIdentity();
          root.truncateUploadPayload(
            upload.familyId,
            upload.publicId,
            upload.committedOffset,
          );
        }
      }
      return;
    }
    if (
      ["EXPIRED", "ABORTED", "COMPLETE", "FAILED"].includes(upload.state) &&
      !(upload.state === "FAILED" && upload.finalizeStartedAt) &&
      !upload.stagingCleanedAt
    ) {
      await this.cleanupTerminal(upload, mode, budget, result);
    }
    // FAILED after a frozen finalize retains its candidate for diagnosis.
  }

  private async inspectFinalizing(
    upload: UploadRecord,
    budget: ScanBudget,
    result: ReconciliationResult,
  ) {
    if (!upload.computedSha256) {
      recordError(result, "FINALIZING_INTENT_INVALID");
      return;
    }
    if (upload.declaredSize > MAX_SINGLE_ORIGINAL_BYTES) {
      recordError(result, "FINALIZING_SIZE_UNSUPPORTED");
      return;
    }
    const shaHex = upload.computedSha256.toString("hex");
    if (!consumeHashBudget(budget, upload.declaredSize)) {
      result.truncated = true;
      return;
    }
    try {
      const verified = this.root!.verifyOriginal(
        upload.familyId,
        shaHex,
        upload.declaredSize.toString(),
      );
      if (verified.sha256.equals(upload.computedSha256)) {
        result.finalizingCandidatesVerified += 1;
      }
      return;
    } catch (error) {
      if (!missing(error)) {
        if (confirmedMismatch(error)) result.integrityMismatches += 1;
        else recordError(result, "FINALIZING_FINAL_UNKNOWN");
        return;
      }
    }
    try {
      const verified = this.root!.hashUploadPayload(
        upload.familyId,
        upload.publicId,
        true,
      );
      if (
        verified.byteSize === upload.declaredSize &&
        verified.sha256.equals(upload.computedSha256)
      ) {
        result.finalizingCandidatesVerified += 1;
      } else {
        result.integrityMismatches += 1;
      }
    } catch (error) {
      if (missing(error) || confirmedMismatch(error))
        result.integrityMismatches += 1;
      else recordError(result, "FINALIZING_STAGE_UNSAFE");
    }
    // A system scan has no user's live WEB token. Only the existing explicit,
    // authenticated finalize path may publish or link this frozen intent.
  }

  private async cleanupTerminal(
    upload: UploadRecord,
    mode: ReconciliationMode,
    budget: ScanBudget,
    result: ReconciliationResult,
  ) {
    const root = this.root!;
    if (upload.state === "COMPLETE") {
      if (upload.declaredSize > MAX_SINGLE_ORIGINAL_BYTES) {
        recordError(result, "COMPLETE_SIZE_UNSUPPORTED");
        return;
      }
      if (!upload.computedSha256 || !upload.storageObjectId) {
        result.integrityMismatches += 1;
        return;
      }
      const object = await this.repository.findStorageObject({
        familyId: upload.familyId,
        sha256: upload.computedSha256,
        byteSize: upload.declaredSize,
      });
      if (
        !object ||
        object.id !== upload.storageObjectId ||
        object.state !== "AVAILABLE"
      ) {
        result.integrityMismatches += 1;
        return;
      }
      if (!consumeHashBudget(budget, upload.declaredSize)) {
        result.truncated = true;
        return;
      }
      try {
        root.verifyOriginal(
          upload.familyId,
          upload.computedSha256.toString("hex"),
          upload.declaredSize.toString(),
        );
      } catch (error) {
        if (missing(error) || confirmedMismatch(error))
          result.integrityMismatches += 1;
        else recordError(result, "COMPLETE_OBJECT_UNKNOWN");
        return;
      }
    }
    if (mode === "dry-run") return;
    const publicId = Buffer.from(upload.publicId, "hex");
    const current = (await this.repository.systemRevalidate(publicId, false))
      .upload;
    if (
      current.familyId !== upload.familyId ||
      current.publicId !== upload.publicId ||
      !["EXPIRED", "ABORTED", "COMPLETE", "FAILED"].includes(current.state) ||
      (current.state === "FAILED" && current.finalizeStartedAt !== null)
    ) {
      recordError(result, "CLEANUP_STATE_CHANGED");
      return;
    }
    root.assertIdentity();
    try {
      root.removeUploadPayload(current.familyId, current.publicId);
      result.stagingCleaned += 1;
    } catch (error) {
      if (!missing(error)) {
        recordError(result, "CLEANUP_UNSAFE");
        return;
      }
    }
    await this.repository.markCleaned(publicId);
  }

  private async inspectObject(
    object: StorageObjectRecord & { familyId: string },
    mode: ReconciliationMode,
    budget: ScanBudget,
    result: ReconciliationResult,
  ) {
    if (
      object.keyVersion !== 1 ||
      object.byteSize > MAX_SINGLE_ORIGINAL_BYTES
    ) {
      recordError(result, "OBJECT_IDENTITY_UNSUPPORTED");
      return;
    }
    if (!consumeHashBudget(budget, object.byteSize)) {
      result.truncated = true;
      return;
    }
    let issue: "MISSING" | "CORRUPT" | null = null;
    try {
      this.root!.verifyOriginal(
        object.familyId,
        object.sha256.toString("hex"),
        object.byteSize.toString(),
      );
    } catch (error) {
      if (missing(error)) issue = "MISSING";
      else if (
        error instanceof StorageSafetyError &&
        error.reason === "ORIGINAL_INTEGRITY_MISMATCH"
      )
        issue = "CORRUPT";
      else {
        recordError(result, "OBJECT_VERIFICATION_UNKNOWN");
        return;
      }
    }
    if (!issue) return;
    if (issue === "MISSING") result.dbMissingFinal += 1;
    else result.integrityMismatches += 1;
    // The volume and marker were checked before making a definitive state
    // transition. Unknown native errors cannot authorize MISSING/CORRUPT.
    if (mode === "recover" && object.state === "AVAILABLE") {
      this.root!.assertIdentity();
      await this.repository.markStorageIntegrityIssue({
        familyId: object.familyId,
        sha256: object.sha256,
        byteSize: object.byteSize,
        state: issue,
      });
    }
  }

  private async scanStagingNamespace(
    now: Date,
    mode: ReconciliationMode,
    budget: ScanBudget,
    result: ReconciliationResult,
    afterKey: string,
    familyScope?: string,
  ) {
    for (const family of this.pagedEntries("uploads", result)) {
      if (!budget.remaining) return;
      if (familyScope && family.name !== familyScope) continue;
      if (!safeDirectory(family, FAMILY, this.root!)) {
        result.skippedUnsafeEntries += 1;
        continue;
      }
      for (const upload of this.pagedEntries(
        `uploads/${family.name}`,
        result,
      )) {
        if (!budget.remaining) return;
        const key = `${family.name}/${upload.name}`;
        if (key <= afterKey) continue;
        if (!safeDirectory(upload, UPLOAD, this.root!)) {
          result.skippedUnsafeEntries += 1;
          continue;
        }
        budget.remaining -= 1;
        const previousKey = result.nextStagingKey;
        result.nextStagingKey = key;
        const path = `uploads/${family.name}/${upload.name}`;
        const publicId = Buffer.from(upload.name, "hex");
        await this.mutex.runExclusive(upload.name, async () => {
          const receipt = await this.findReceipt(publicId);
          if (receipt) {
            if (receipt.familyId !== family.name) {
              result.skippedUnsafeEntries += 1;
              return;
            }
          }
          const entries = this.entries(path, result);
          if (entries.length === 0) {
            if (!receipt) result.skippedUnsafeEntries += 1;
            // Cleanup leaves the controlled per-upload directory in place.
            // An empty known terminal directory is not an orphan file.
            return;
          }
          if (
            entries.length !== 1 ||
            entries[0]?.name !== "payload" ||
            !safeStagingFile(entries[0], this.root!, receipt)
          ) {
            result.skippedUnsafeEntries += 1;
            return;
          }
          if (receipt) {
            if (
              ["EXPIRED", "ABORTED", "COMPLETE", "FAILED"].includes(
                receipt.state,
              ) &&
              !(receipt.state === "FAILED" && receipt.finalizeStartedAt)
            ) {
              result.terminalStagingResidue += 1;
              if (mode !== "dry-run")
                await this.cleanupTerminal(receipt, mode, budget, result);
            }
            return;
          }
          result.orphanStagingCandidates += 1;
          if (
            mode !== "cleanup-staging" ||
            now.getTime() - Number(entries[0]!.mtimeMs) < GRACE_MS
          )
            return;
          // The second scan and a fresh DB read happen while holding the same
          // upload mutex, under the root's exclusive OS writer lock.
          const second = this.entries(path, result);
          if (
            second.length !== 1 ||
            second[0]?.name !== "payload" ||
            !safeFile(second[0], this.root!) ||
            second[0].mtimeMs !== entries[0]!.mtimeMs ||
            (await this.findReceipt(publicId))
          ) {
            result.skippedUnsafeEntries += 1;
            return;
          }
          this.root!.assertIdentity();
          try {
            this.root!.removeUploadPayload(family.name, upload.name);
            result.stagingCleaned += 1;
          } catch (error) {
            if (!missing(error))
              recordError(result, "ORPHAN_STAGE_CLEANUP_FAILED");
          }
        });
        if (result.truncated) {
          result.nextStagingKey = previousKey;
          return;
        }
      }
    }
  }

  private async scanScratchNamespace(
    now: Date,
    mode: ReconciliationMode,
    budget: ScanBudget,
    result: ReconciliationResult,
    afterKey: string,
  ) {
    const topLevel = this.entries("temp", result);
    result.skippedUnsafeEntries += topLevel.filter(
      (entry) =>
        entry.name !== "chunks" ||
        !safeDirectory(entry, /^chunks$/u, this.root!),
    ).length;
    const chunks = topLevel.find(
      (entry) =>
        entry.name === "chunks" &&
        safeDirectory(entry, /^chunks$/u, this.root!),
    );
    if (!chunks) return;
    for (const upload of this.pagedEntries("temp/chunks", result)) {
      if (!budget.remaining) return;
      if (!safeDirectory(upload, UPLOAD, this.root!)) {
        result.skippedUnsafeEntries += 1;
        continue;
      }
      await this.mutex.runExclusive(upload.name, async () => {
        const receipt = await this.findReceipt(Buffer.from(upload.name, "hex"));
        for (const scratch of this.pagedEntries(
          `temp/chunks/${upload.name}`,
          result,
        )) {
          if (!budget.remaining) return;
          const key = `${upload.name}/${scratch.name}`;
          if (key <= afterKey) continue;
          budget.remaining -= 1;
          result.nextScratchKey = key;
          if (!safeFile(scratch, this.root!) || !UPLOAD.test(scratch.name)) {
            result.skippedUnsafeEntries += 1;
            continue;
          }
          if (
            receipt &&
            ["CREATED", "UPLOADING", "FINALIZING"].includes(receipt.state)
          )
            continue;
          result.orphanStagingCandidates += 1;
          if (
            mode !== "cleanup-staging" ||
            now.getTime() - Number(scratch.mtimeMs) < GRACE_MS
          )
            continue;
          let second: ControlledDirectoryEntry | undefined;
          for (const candidate of this.pagedEntries(
            `temp/chunks/${upload.name}`,
            result,
          )) {
            if (candidate.name === scratch.name) {
              second = candidate;
              break;
            }
          }
          if (
            !second ||
            !safeFile(second, this.root!) ||
            second.mtimeMs !== scratch.mtimeMs ||
            ["CREATED", "UPLOADING", "FINALIZING"].includes(
              (await this.findReceipt(Buffer.from(upload.name, "hex")))
                ?.state ?? "",
            )
          ) {
            result.skippedUnsafeEntries += 1;
            continue;
          }
          try {
            this.root!.assertIdentity();
            this.root!.removeChunkScratch(upload.name, scratch.name);
            result.stagingCleaned += 1;
          } catch (error) {
            if (!missing(error)) recordError(result, "SCRATCH_CLEANUP_FAILED");
          }
        }
      });
    }
  }

  private async scanOriginalNamespace(
    budget: ScanBudget,
    result: ReconciliationResult,
    afterKey: string,
    familyScope?: string,
  ) {
    let foundOpaqueCursor = !validOriginalCursor(afterKey);
    for (const family of this.pagedEntries("originals", result)) {
      if (!budget.remaining) return;
      if (familyScope && family.name !== familyScope) continue;
      if (!safeDirectory(family, FAMILY, this.root!)) {
        result.skippedUnsafeEntries += 1;
        continue;
      }
      for (const first of this.pagedEntries(
        `originals/${family.name}`,
        result,
      )) {
        if (!budget.remaining) return;
        if (!safeDirectory(first, PREFIX, this.root!)) {
          result.skippedUnsafeEntries += 1;
          continue;
        }
        for (const second of this.pagedEntries(
          `originals/${family.name}/${first.name}`,
          result,
        )) {
          if (!budget.remaining) return;
          if (!safeDirectory(second, PREFIX, this.root!)) {
            result.skippedUnsafeEntries += 1;
            continue;
          }
          for (const file of this.pagedEntries(
            `originals/${family.name}/${first.name}/${second.name}`,
            result,
          )) {
            if (!budget.remaining) return;
            const key = `${family.name}/${first.name}/${second.name}/${file.name}`;
            if (!foundOpaqueCursor) {
              if (originalContinuation(key) === afterKey)
                foundOpaqueCursor = true;
              continue;
            }
            if (!validOriginalCursor(afterKey) && key <= afterKey) continue;
            budget.remaining -= 1;
            const previousKey = result.nextOriginalKey;
            result.nextOriginalKey = key;
            const parsed = FINAL.exec(file.name);
            if (
              !parsed ||
              parsed[1]?.slice(0, 2) !== first.name ||
              parsed[1]?.slice(2, 4) !== second.name ||
              !safeFile(file, this.root!, 0o400)
            ) {
              result.skippedUnsafeEntries += 1;
              continue;
            }
            const sha256 = Buffer.from(parsed[1], "hex");
            const byteSize = BigInt(parsed[2]!);
            if (byteSize > MAX_SINGLE_ORIGINAL_BYTES) {
              result.skippedUnsafeEntries += 1;
              continue;
            }
            const object = await this.repository.findStorageObject({
              familyId: family.name,
              sha256,
              byteSize,
            });
            if (object) continue;
            const known = await this.repository.findFinalizingIntent({
              familyId: family.name,
              sha256,
              byteSize,
            });
            if (known && !consumeHashBudget(budget, byteSize)) {
              result.truncated = true;
              result.nextOriginalKey = previousKey;
              return;
            }
            if (known) {
              try {
                this.root!.verifyOriginal(family.name, parsed[1], parsed[2]!);
                result.finalizingCandidatesVerified += 1;
                result.knownRecoverableFinalizingCandidates += 1;
              } catch {
                result.integrityMismatches += 1;
              }
            } else {
              result.orphanFinalCandidates += 1;
            }
            // No original deletion or system-authenticated DB linkage exists.
          }
        }
      }
    }
    if (!foundOpaqueCursor) throw new Error("RECOVERY_CURSOR_NOT_FOUND");
  }

  private *pagedEntries(path: string, result: ReconciliationResult) {
    let cursor = "";
    let generation = "";
    for (;;) {
      let page: ReturnType<StorageRoot["listControlledDirectoryPage"]>;
      try {
        page = this.root!.listControlledDirectoryPage(
          path,
          cursor,
          DIRECTORY_PAGE_LIMIT,
          generation,
        );
      } catch (error) {
        if (
          missing(error) &&
          !["uploads", "originals", "temp"].includes(path) &&
          !cursor
        )
          return;
        recordError(result, "SCAN_NAMESPACE_UNSAFE");
        throw new Error("SCAN_NAMESPACE_UNSAFE", { cause: error });
      }
      generation = page.generation;
      for (const entry of page.entries) yield entry;
      if (!page.hasMore) return;
      if (!page.nextCursor || page.nextCursor <= cursor) {
        recordError(result, "SCAN_CURSOR_UNSAFE");
        throw new Error("SCAN_CURSOR_UNSAFE");
      }
      cursor = page.nextCursor;
    }
  }

  private entries(path: string, result: ReconciliationResult) {
    try {
      return this.root!.listControlledDirectory(path, 1_000).sort(
        (first, second) =>
          first.name < second.name ? -1 : first.name > second.name ? 1 : 0,
      );
    } catch (error) {
      if (missing(error) && !["uploads", "originals", "temp"].includes(path))
        return [];
      recordError(result, "SCAN_NAMESPACE_UNSAFE");
      throw new Error("SCAN_NAMESPACE_UNSAFE", { cause: error });
    }
  }

  private async findReceipt(publicId: Buffer) {
    try {
      return await this.repository.trustedState(publicId);
    } catch (error) {
      if (
        error instanceof UploadRepositoryError &&
        error.reason === "NOT_FOUND"
      )
        return null;
      throw error;
    }
  }
}

function emptyResult(
  mode: ReconciliationMode,
  scope: ReconciliationScope,
  capability: StorageCapability["state"],
): ReconciliationResult {
  return {
    mode,
    scope,
    capability,
    scannedUploads: 0,
    staleUploads: 0,
    expiredTransitioned: 0,
    stagingCleaned: 0,
    finalizingCandidatesVerified: 0,
    knownRecoverableFinalizingCandidates: 0,
    finalizingAutoCompleted: 0,
    orphanStagingCandidates: 0,
    terminalStagingResidue: 0,
    orphanFinalCandidates: 0,
    dbMissingFinal: 0,
    integrityMismatches: 0,
    skippedUnsafeEntries: 0,
    errors: 0,
    truncated: false,
    reasonCodes: [],
    nextUploadId: "0",
    nextObjectId: "0",
    nextStagingKey: "",
    nextScratchKey: "",
    nextOriginalKey: "",
  };
}

function validIdCursor(value: string | undefined) {
  return value === undefined || /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function validLogicalCursor(value: string | undefined) {
  return (
    value === undefined ||
    (value.length <= 128 &&
      /^[a-z0-9/._-]+$/u.test(value) &&
      !value.includes("..") &&
      !value.startsWith("/"))
  );
}

function validOriginalCursor(value: string | undefined) {
  return typeof value === "string" && /^oc1_[A-Za-z0-9_-]{43}$/u.test(value);
}

export function originalContinuation(key: string) {
  return `oc1_${createHash("sha256").update(key).digest("base64url")}`;
}

export function publicReconciliationReport(result: ReconciliationResult) {
  return {
    ...result,
    nextOriginalKey: result.nextOriginalKey
      ? validOriginalCursor(result.nextOriginalKey)
        ? result.nextOriginalKey
        : originalContinuation(result.nextOriginalKey)
      : "",
  };
}

function safeDirectory(
  entry: ControlledDirectoryEntry,
  pattern: RegExp,
  root: StorageRoot,
) {
  return (
    entry.kind === "directory" &&
    pattern.test(entry.name) &&
    entry.device === root.device &&
    entry.uid === String(process.getuid?.() ?? -1) &&
    entry.mode === 0o700
  );
}

function safeFile(
  entry: ControlledDirectoryEntry,
  root: StorageRoot,
  expectedMode = 0o600,
) {
  return (
    entry.kind === "file" &&
    entry.nlink === 1n &&
    entry.device === root.device &&
    entry.uid === String(process.getuid?.() ?? -1) &&
    entry.mode === expectedMode
  );
}

function safeStagingFile(
  entry: ControlledDirectoryEntry,
  root: StorageRoot,
  receipt: UploadRecord | null,
) {
  return (
    safeFile(entry, root, 0o600) ||
    (!!receipt &&
      (receipt.state === "FINALIZING" ||
        receipt.state === "COMPLETE" ||
        (receipt.state === "FAILED" && receipt.finalizeStartedAt !== null)) &&
      safeFile(entry, root, 0o400))
  );
}

function consumeHashBudget(budget: ScanBudget, bytes: bigint) {
  if (budget.hashes < 1 || bytes < 0n || bytes > budget.hashBytes) return false;
  budget.hashes -= 1;
  budget.hashBytes -= bytes;
  return true;
}

function recordError(result: ReconciliationResult, code: string) {
  result.errors += 1;
  if (result.reasonCodes.length < 16) result.reasonCodes.push(code);
}

function missing(error: unknown) {
  return (
    error instanceof StorageSafetyError &&
    error.reason.endsWith(":STORAGE_NOT_FOUND")
  );
}

function alreadyExists(error: unknown) {
  return (
    error instanceof StorageSafetyError &&
    error.reason.endsWith(":STORAGE_ALREADY_EXISTS")
  );
}

function confirmedMismatch(error: unknown) {
  return (
    error instanceof StorageSafetyError &&
    error.reason === "ORIGINAL_INTEGRITY_MISMATCH"
  );
}
