import { performance } from "node:perf_hooks";
import type {
  StorageRoot,
  DerivedStore,
  CapacityGate,
} from "@family-album/storage";
import { PurgeIntentRepository } from "../../../packages/db/src/purge-repository.js";
import { PurgeDerivedNormalizer } from "./purge-normalization.js";
import { ContentCoordination } from "../../../packages/storage/src/phase7-coordination.js";
import {
  PurgeDerivedNative,
  planPurgeDerivedNormalization,
  type PurgeNormalizationAsset,
} from "../../../packages/storage/src/purge-derived.js";
import {
  PurgeFilesNative,
  assertPurgeOwners,
} from "../../../packages/storage/src/purge-files.js";
import {
  lockPurgeNormalization,
  type PurgeNormalizationPool,
  type PurgeNormalizationConnection,
  type PurgeNormalizationLease,
  type PurgeNormalizationRow,
} from "../../../packages/db/src/purge-normalization.js";
import {
  readPurgeIntent,
  lockPurgeExecution,
  detachPurge,
  changePurgeFile,
  settlePurge,
  completePurge,
} from "../../../packages/db/src/purge-execution.js";
import {
  runCapacityTransaction,
  readCapacityOutcome,
} from "../../../packages/db/src/capacity-transaction.js";

export class PurgeProcessor {
  readonly repository: PurgeIntentRepository;
  constructor(
    private readonly pool: PurgeNormalizationPool,
    private readonly root: StorageRoot,
    private readonly store: DerivedStore,
    private readonly gate: CapacityGate,
    private readonly hooksForTest?: {
      boundary?: (name: string) => Promise<void>;
      nativeFilesBinding?: ConstructorParameters<typeof PurgeFilesNative>[3];
      commit?: (name: string, c: PurgeNormalizationConnection) => Promise<void>;
    },
  ) {
    if (hooksForTest && process.env.NODE_ENV !== "test")
      throw new Error("PURGE_TEST_ONLY");
    this.repository = new PurgeIntentRepository(pool);
  }
  async runNext() {
    // Startup obtains both exclusive native writers before this processor exists.
    this.root.assertIdentity();
    assertPurgeOwners(this.root, this.store);
    const lease = await this.repository.claim();
    if (!lease) return false;
    try {
      await this.run(lease);
    } catch (error) {
      const text = error instanceof Error ? error.message : "";
      const normalizedCode = text.startsWith("CAPACITY_GATE_FAILED:PURGE_")
        ? text.slice("CAPACITY_GATE_FAILED:".length)
        : text;
      if (
        normalizedCode.includes("PURGE_COMMIT_UNKNOWN") ||
        normalizedCode.includes("PURGE_STALE")
      )
        return true;
      // Only the positively identified busy result is a normal retry. Native
      // identity and uncertain-ledger errors must retain fail-closed handling.
      const category =
        normalizedCode === "COORD_ACQUIRE_TIMEOUT"
          ? "TRANSIENT_DB"
          : normalizedCode.includes("REFERENCE")
            ? "REFERENCE_CONFLICT"
            : normalizedCode.includes("CAPACITY")
              ? "CAPACITY_UNAVAILABLE"
              : normalizedCode.includes("FILESYSTEM") ||
                  normalizedCode.includes("RESIDUE") ||
                  normalizedCode.includes("HANDLE")
                ? "FILESYSTEM_UNCERTAIN"
                : normalizedCode.startsWith("PURGE_DB")
                  ? "TRANSIENT_DB"
                  : "INVARIANT_VIOLATION";
      await this.repository.fail(
        lease,
        category,
        ["REFERENCE_CONFLICT", "CAPACITY_UNAVAILABLE", "TRANSIENT_DB"].includes(
          category,
        )
          ? 30
          : null,
      );
    }
    return true;
  }
  async run(lease: PurgeNormalizationLease) {
    this.root.assertIdentity();
    assertPurgeOwners(this.root, this.store);
    const p = await readPurgeIntent(this.pool, lease.id);
    if (!p) throw new Error("PURGE_STALE");
    if (p.progress === "COMPLETED") return "COMPLETED";
    if (
      p.progress === "REQUESTED" &&
      (await new PurgeDerivedNormalizer(
        this.pool,
        this.root,
        this.store,
        this.gate,
      ).run(lease)) !== "NORMALIZED"
    )
      return "COMMIT_UNKNOWN";
    const [keys] = await this.pool.query<PurgeNormalizationRow[]>(
      "SELECT LOWER(HEX(sha256)) sha256Hex,CAST(byte_size AS CHAR) byteSize FROM storage_objects WHERE family_id=? AND id=?",
      [p.familyId, p.storageId],
    );
    const key = keys[0];
    if (!key) throw new Error("PURGE_STALE");
    const coord = new ContentCoordination(this.root, {
      familyId: p.familyId,
      sha256Hex: key.sha256Hex,
      byteSize: key.byteSize,
    });
    const life = await coord.acquireLifecycle("X", 0);
    try {
      const read = await coord.acquireRead(life, "X", 0);
      try {
        const derived = new PurgeDerivedNative(this.root, this.store, read),
          physical = new PurgeFilesNative(
            this.root,
            this.store,
            read,
            this.hooksForTest?.nativeFilesBinding,
          );
        const admitted = async <T>(
          operation: (deadline: number) => Promise<T>,
        ) => {
          const result = await this.gate.withAdmissionLock(async (deadline) => {
            try {
              return { ok: true as const, value: await operation(deadline) };
            } catch (error) {
              return { ok: false as const, error };
            }
          });
          if (!result.ok) throw result.error;
          return result.value;
        };
        const physicalStep = (
          file: Parameters<PurgeFilesNative["execute"]>[0],
          action: Parameters<PurgeFilesNative["execute"]>[1],
          permit: Parameters<PurgeFilesNative["execute"]>[2],
        ) => admitted(async () => physical.execute(file, action, permit));
        const tx = async <T>(
          name: string,
          operation: (c: PurgeNormalizationConnection) => Promise<T>,
        ) =>
          admitted(async (deadline) => {
            const outcome = await runCapacityTransaction(
              this.pool,
              deadline,
              operation,
              this.hooksForTest?.commit
                ? { commitForTest: (c) => this.hooksForTest!.commit!(name, c) }
                : {},
            );
            if (outcome.transaction === "UNKNOWN") {
              await readCapacityOutcome(
                this.pool,
                performance.now() + 2000,
                (c) => readPurgeIntent(c, lease.id),
              );
              throw new Error("PURGE_COMMIT_UNKNOWN");
            }
            if (outcome.transaction !== "COMMITTED") {
              if (
                outcome.error instanceof Error &&
                outcome.error.message.startsWith("PURGE_")
              )
                throw outcome.error;
              throw new Error("PURGE_DB_UNAVAILABLE");
            }
            return outcome.value;
          });
        const current = async () => {
          const start = derived.monotonicClock();
          const v = await tx("READ", (c) =>
            lockPurgeExecution(c, lease, p.familyId),
          );
          if (
            v.storage.sha256Hex !== key.sha256Hex ||
            v.storage.byteSize !== key.byteSize ||
            v.files.some(
              (f) =>
                f.markerId !== this.root.markerId ||
                f.device !== this.root.device,
            )
          )
            throw new Error("PURGE_MANIFEST_INVARIANT");
          return {
            ...v,
            permit: () => ({
              originalSha256Hex: key.sha256Hex,
              originalByteSize: key.byteSize,
              permitDeadlineMs:
                start + Math.min(89000, Number(v.intent.remainingMs)) - 1,
            }),
          };
        };
        if (
          (await readPurgeIntent(this.pool, lease.id))?.progress === "REQUESTED"
        ) {
          // OS guards precede SQL. Inspect only after the short read transaction
          // ends, then compare the authoritative rows again in atomic detach.
          const v = await tx("NORMALIZED_READ", (c) =>
            lockPurgeNormalization(c, lease, p.familyId),
          );
          const inventory = derived.inventory(
            p.familyId,
            p.mediaId,
            v.jobs.map((j) => j.id),
          );
          if (
            inventory.some(
              (f) =>
                f.name !== "FINAL" ||
                !v.assets.some(
                  (a) =>
                    a.state === "READY" &&
                    a.generation === f.generation &&
                    a.kind === f.kind,
                ),
            )
          )
            throw new Error("PURGE_UNKNOWN_RESIDUE");
          for (const a of v.assets) {
            const asset = {
              ...a,
              reservedBytes: BigInt(a.reservedBytes),
              byteSize: a.byteSize === null ? null : BigInt(a.byteSize),
            } as PurgeNormalizationAsset;
            planPurgeDerivedNormalization(asset, derived.inspect(asset));
            if (a.state !== "READY" && !a.cleanedAt)
              throw new Error("PURGE_UNCLEANED");
          }
          await tx("DETACH", (c) =>
            detachPurge(c, lease, p.familyId, v, this.root),
          );
          await this.hooksForTest?.boundary?.("DETACHED");
        }
        for (let count = 0; count < 8192; count++) {
          if (!(await this.repository.heartbeat(lease)))
            throw new Error("PURGE_STALE");
          const v = await current();
          if (v.intent.progress === "FILES_REMOVED") {
            for (const f of v.files)
              await physicalStep(f, "VERIFY", v.permit());
            await this.hooksForTest?.boundary?.("BEFORE_COMPLETE");
            await tx("COMPLETE", (c) => completePurge(c, lease, p.familyId));
            return "COMPLETED";
          }
          const f = v.files.find(
            (f) => !["REMOVED", "ABSENT_DERIVED"].includes(f.stage),
          );
          if (!f) {
            for (const terminal of v.files)
              await physicalStep(terminal, "VERIFY", v.permit());
            await tx("FILES_REMOVED", (c) => settlePurge(c, lease, p.familyId));
            await this.hooksForTest?.boundary?.("FILES_REMOVED");
            continue;
          }
          if (f.fileKind === "ORIGINAL") {
            for (const d of v.files.filter((d) => d.fileKind === "DERIVED"))
              await physicalStep(d, "VERIFY", v.permit());
            // Recovery can begin after the last REMOVED commit but before its
            // release transaction, including with an already quarantined Original.
            if (
              BigInt(v.intent.releasedBytes) < BigInt(v.intent.derivedBytes)
            ) {
              await tx("RELEASE", (c) => settlePurge(c, lease, p.familyId));
              continue; // Fresh lease/accounting read before any Original step.
            }
          }
          if (f.stage === "CATALOGUED") {
            await this.hooksForTest?.boundary?.("BEFORE_QUARANTINE");
            const fact = await physicalStep(f, "QUARANTINE", v.permit());
            await this.hooksForTest?.boundary?.("AFTER_QUARANTINE");
            await tx("QUARANTINED", (c) =>
              changePurgeFile(c, lease, p.familyId, f, fact.stage, fact),
            );
            await this.hooksForTest?.boundary?.("QUARANTINED");
          } else if (f.stage === "QUARANTINED") {
            await physicalStep(f, "VERIFY", v.permit());
            await tx("ARM", (c) =>
              changePurgeFile(c, lease, p.familyId, f, "UNLINK_ARMED"),
            );
            await this.hooksForTest?.boundary?.("UNLINK_ARMED");
          } else if (f.stage === "UNLINK_ARMED") {
            await this.hooksForTest?.boundary?.("BEFORE_UNLINK");
            await physicalStep(f, "UNLINK", v.permit());
            await this.hooksForTest?.boundary?.("AFTER_UNLINK");
            await tx("REMOVED", (c) =>
              changePurgeFile(c, lease, p.familyId, f, "REMOVED"),
            );
            await this.hooksForTest?.boundary?.("REMOVED");
          }
          // No per-file decrement: all Derived charge transfers together.
          await tx("RELEASE", (c) => settlePurge(c, lease, p.familyId));
          if (
            (await readPurgeIntent(this.pool, lease.id))?.progress ===
            "FILES_REMOVED"
          )
            await this.hooksForTest?.boundary?.("FILES_REMOVED");
        }
        throw new Error("PURGE_BOUND_EXCEEDED");
      } finally {
        read.close();
      }
    } finally {
      life.close();
    }
  }
}
