import { performance } from "node:perf_hooks";
import type {
  StorageRoot,
  DerivedStore,
  CapacityGate,
} from "@family-album/storage";
import { ContentCoordination } from "../../../packages/storage/src/phase7-coordination.js";
import {
  PurgeDerivedNative,
  planPurgeDerivedNormalization,
  type PurgeNormalizationAsset,
} from "../../../packages/storage/src/purge-derived.js";
import {
  lockPurgeNormalization,
  markPurgeDerivedCleaned,
  type PurgeNormalizationLease,
  type PurgeNormalizationPool,
  type PurgeNormalizationRow,
  type PurgeNormalizationConnection,
} from "../../../packages/db/src/purge-normalization.js";
import {
  runCapacityTransaction,
  readCapacityOutcome,
} from "../../../packages/db/src/capacity-transaction.js";

export class PurgeDerivedNormalizer {
  constructor(
    private readonly pool: PurgeNormalizationPool,
    private readonly root: StorageRoot,
    private readonly store: DerivedStore,
    private readonly gate: CapacityGate,
    private readonly hooksForTest?: {
      afterPhysicalAbsence?: () => Promise<void>;
      commitCleaned?: (
        connection: PurgeNormalizationConnection,
      ) => Promise<void>;
      nativeBinding?: ConstructorParameters<typeof PurgeDerivedNative>[3];
    },
  ) {
    if (hooksForTest && process.env.NODE_ENV !== "test")
      throw new Error("PURGE_TEST_ONLY");
  }
  async run(lease: PurgeNormalizationLease) {
    this.root.assertIdentity();
    const [before] = await this.pool.query<PurgeNormalizationRow[]>(
      `SELECT CAST(p.family_id AS CHAR) familyId, LOWER(HEX(s.sha256)) sha256Hex,
       CAST(s.byte_size AS CHAR) byteSize FROM purge_intents p JOIN storage_objects s
       ON s.family_id=p.family_id AND s.id=p.storage_object_id WHERE p.id=?`,
      [lease.id],
    );
    const key = before[0];
    if (!key) throw new Error("PURGE_STALE");
    const coordination = new ContentCoordination(this.root, {
      familyId: key.familyId,
      sha256Hex: key.sha256Hex,
      byteSize: key.byteSize,
    });
    const life = await coordination.acquireLifecycle("X", 0);
    try {
      const read = await coordination.acquireRead(life, "X", 0);
      try {
        const native = new PurgeDerivedNative(
          this.root,
          this.store,
          read,
          this.hooksForTest?.nativeBinding,
        );
        return await this.gate.withAdmissionLock(async (deadline) => {
          let step = "INITIAL";
          try {
            const current = async () => {
              // Node hrtime and CLOCK_MONOTONIC have different epochs on macOS.
              // Use the deleting primitive's clock before the SQL round trip.
              const start = native.monotonicClock();
              const result = await runCapacityTransaction(
                this.pool,
                deadline,
                (connection) =>
                  lockPurgeNormalization(connection, lease, key.familyId),
              );
              if (result.transaction !== "COMMITTED") {
                if (
                  (result.transaction === "ROLLED_BACK" ||
                    result.transaction === "NOT_STARTED") &&
                  result.error instanceof Error
                ) {
                  const code =
                    "code" in result.error
                      ? String(result.error.code)
                      : result.error.message;
                  throw new Error(
                    /^PURGE_|^ER_[A-Z_]+$/u.test(code)
                      ? `PURGE_DB_${code}`
                      : "PURGE_DB_UNAVAILABLE",
                  );
                }
                throw new Error("PURGE_COMMIT_UNKNOWN");
              }
              const view = result.value;
              if (
                view.storage.sha256Hex !== key.sha256Hex ||
                view.storage.byteSize !== key.byteSize
              )
                throw new Error("PURGE_KEY_CHANGED");
              return {
                ...view,
                permitDeadlineMs:
                  start + Math.min(89_000, Number(view.intent.remainingMs)) - 1,
              };
            };
            const view = await current();
            const inventory = () => {
              const observations = native.inventory(
                key.familyId,
                view.intent.mediaId,
                view.jobs.map((job) => String(job.id)),
              );
              for (const fact of observations) {
                const owner = view.assets.find(
                  (asset) =>
                    asset.kind === fact.kind &&
                    (fact.name === "TEMP"
                      ? asset.jobId === fact.jobId && asset.epoch === fact.epoch
                      : asset.generation === fact.generation),
                );
                if (!owner) throw new Error("PURGE_UNKNOWN_RESIDUE");
              }
            };
            step = "INVENTORY";
            inventory();
            for (const expected of view.assets) {
              const asset: PurgeNormalizationAsset = {
                familyId: expected.familyId,
                mediaId: expected.mediaId,
                generation: expected.generation,
                jobId: expected.jobId,
                epoch: expected.epoch,
                kind: expected.kind,
                state: expected.state,
                cleanedAt: expected.cleanedAt,
                reservedBytes: BigInt(expected.reservedBytes),
                byteSize:
                  expected.byteSize === null ? null : BigInt(expected.byteSize),
                sha256Hex: expected.sha256Hex,
              };
              step = "INSPECT";
              const facts = native.inspect(asset);
              step = "PLAN";
              const plan = planPurgeDerivedNormalization(asset, facts);
              if (plan === "READY" || expected.cleanedAt) continue;
              for (const name of plan) {
                const fresh = await current();
                const row = fresh.assets.find(
                  (candidate) => candidate.id === expected.id,
                );
                if (!row || JSON.stringify(row) !== JSON.stringify(expected))
                  throw new Error("PURGE_ASSET_CHANGED");
                inventory();
                const actual = native.inspect(asset);
                const refreshedPlan = planPurgeDerivedNormalization(
                  asset,
                  actual,
                );
                if (refreshedPlan === "READY" || !refreshedPlan.includes(name))
                  throw new Error("PURGE_FILE_CHANGED");
                step = "REMOVE";
                native.remove(
                  asset,
                  name,
                  name === "TEMP" ? facts.temp : facts.final,
                  {
                    originalSha256Hex: key.sha256Hex,
                    originalByteSize: key.byteSize,
                    permitDeadlineMs: fresh.permitDeadlineMs,
                  },
                  name === "TEMP" && actual.final.fileClass === "REGULAR"
                    ? actual.final
                    : undefined,
                );
              }
              step = "ABSENCE";
              const absent = native.inspect(asset);
              if (
                absent.temp.fileClass !== "ABSENT" ||
                absent.final.fileClass !== "ABSENT"
              )
                throw new Error("PURGE_RESIDUE");
              inventory();
              await this.hooksForTest?.afterPhysicalAbsence?.();
              step = "ACCOUNTING";
              const committed = await runCapacityTransaction(
                this.pool,
                deadline,
                (connection) =>
                  markPurgeDerivedCleaned(
                    connection,
                    lease,
                    key.familyId,
                    expected,
                  ),
                this.hooksForTest?.commitCleaned
                  ? { commitForTest: this.hooksForTest.commitCleaned }
                  : {},
              );
              if (committed.transaction === "UNKNOWN") {
                // Stop this invocation regardless of readback. A new invocation
                // reacquires all authority and uses absence, never blind unlink.
                await readCapacityOutcome(
                  this.pool,
                  performance.now() + 2_000,
                  async (connection) => {
                    const [rows] = await connection.query<
                      PurgeNormalizationRow[]
                    >(
                      "SELECT cleaned_at FROM derived_assets WHERE family_id=? AND id=?",
                      [key.familyId, expected.id],
                    );
                    return rows[0]?.cleaned_at ?? null;
                  },
                );
                return "COMMIT_UNKNOWN" as const;
              }
              if (committed.transaction !== "COMMITTED")
                throw new Error("PURGE_ACCOUNTING_UNSETTLED");
            }
            const final = await current();
            step = "INVENTORY";
            inventory();
            for (const row of final.assets) {
              const asset = {
                ...row,
                reservedBytes: BigInt(row.reservedBytes),
                byteSize: row.byteSize === null ? null : BigInt(row.byteSize),
              } as PurgeNormalizationAsset;
              planPurgeDerivedNormalization(asset, native.inspect(asset));
              if (row.state !== "READY" && !row.cleanedAt)
                throw new Error("PURGE_UNCLEANED");
            }
            return "NORMALIZED" as const;
          } catch (error) {
            const category =
              error instanceof Error && /^PURGE_[A-Z_]+$/u.test(error.message)
                ? error.message
                : "PURGE_FILESYSTEM_UNCERTAIN";
            throw Object.assign(new Error(category), {
              code: `${category}_${step}`,
            });
          }
        });
      } finally {
        read.close();
      }
    } finally {
      life.close();
    }
  }
}
