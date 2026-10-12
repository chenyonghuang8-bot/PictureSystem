import {
  MySqlJobRepository,
  reconcileDerivedPublishRecovery,
  type MySqlSystemControlRepository,
  type Pool,
  type RowDataPacket,
  type RuntimeRole,
} from "@family-album/db";
import {
  CapacityGate,
  DerivedStore,
  OriginalReader,
  probeStorageCapability,
  VersionedOwner,
  type StorageCapability,
  type ControlRecoveryPermit,
} from "@family-album/storage";
import { ContentCoordination } from "../../../packages/storage/src/phase7-coordination.js";
import { PurgeProcessor } from "./purge-processor.js";
import { assertStorageOwnerHealth } from "./storage-owner-health.js";
import type { AdminStorageObservation } from "@family-album/contracts";

export type RuntimeMediaResources = {
  capability: StorageCapability;
  gate?: CapacityGate;
  reader?: OriginalReader;
  store?: DerivedStore;
};
export async function closeMediaResources(value: RuntimeMediaResources) {
  let failed = false;
  for (const resource of [
    value.store,
    value.reader,
    value.gate,
    value.capability.state === "UNAVAILABLE"
      ? undefined
      : value.capability.root,
  ]) {
    try {
      resource?.close();
    } catch {
      failed = true;
    }
  }
  if (failed) throw Error("OWNER_CLOSE_UNCERTAIN");
}

/** The original process that actually acquired the unique writer can reopen its
 * own generation. It never launches an alternate owner, normal claim or codec. */
export class StorageRuntimeOwner {
  readonly resources: VersionedOwner<RuntimeMediaResources>;
  private readonly eligible: boolean;
  constructor(
    initial: RuntimeMediaResources,
    private readonly pool: Pool,
    private readonly repository: MySqlSystemControlRepository,
    private readonly config: {
      mediaRoot: string;
      markerId: string;
      roles: readonly RuntimeRole[];
    },
    private readonly recoverOriginal: (
      permit: ControlRecoveryPermit,
      resources: RuntimeMediaResources,
    ) => Promise<boolean>,
    private readonly confirmOriginal?: (
      resources: RuntimeMediaResources,
    ) => Promise<void>,
  ) {
    this.eligible = initial.capability.state !== "UNAVAILABLE";
    this.resources = new VersionedOwner(initial, closeMediaResources);
  }
  ready() {
    return this.eligible;
  }
  changing() {
    return this.resources.isChanging();
  }
  health() {
    return this.resources.withValue(async (r) => {
      if (r.capability.state === "UNAVAILABLE") throw Error("WRITER_NOT_READY");
      await assertStorageOwnerHealth(r.capability.root, this.repository, {
        ...(r.reader ? { reader: r.reader } : {}),
        ...(r.gate ? { gate: r.gate } : {}),
      });
    });
  }
  async observe(now: Date): Promise<AdminStorageObservation> {
    const basis = {
      observedAt: now.toISOString(),
      staleAfter: new Date(now.getTime() + 5000).toISOString(),
      source: "STORAGE_OWNER" as const,
    };
    try {
      const capacity = await this.resources.withValue(async (r) => {
        if (r.capability.state === "UNAVAILABLE")
          throw Error("WRITER_NOT_READY");
        return assertStorageOwnerHealth(r.capability.root, this.repository, {
          ...(r.reader ? { reader: r.reader } : {}),
          ...(r.gate ? { gate: r.gate } : {}),
        });
      });
      return {
        ...basis,
        state: "HEALTHY",
        reasonCode: "NONE",
        totalBytes: capacity.totalBytes.toString(),
        availableBytes: capacity.availableBytes.toString(),
      };
    } catch (error) {
      return {
        ...basis,
        state: "UNAVAILABLE",
        reasonCode:
          error instanceof Error && error.message === "STORAGE_CAPACITY_LOW"
            ? "CAPACITY_MARGIN"
            : "STORAGE_UNAVAILABLE",
        totalBytes: null,
        availableBytes: null,
      };
    }
  }
  async confirmFresh() {
    if (!this.eligible || !this.confirmOriginal) throw Error("OWNER_NOT_READY");
    await this.resources.withValue(async (r) => {
      if (r.capability.state !== "READ_WRITE" || !r.gate)
        throw Error("WRITER_NOT_READY");
      r.capability.root.assertCoordinationNamespace();
      await assertStorageOwnerHealth(r.capability.root, this.repository, {
        gate: r.gate,
        ...(r.reader ? { reader: r.reader } : {}),
      });
      await this.confirmOriginal!(r);
      if (
        !(await this.repository.verifyRecoveryInventory(
          await r.gate.recoveryInventory(),
        ))
      )
        throw Error("STORAGE_STARTUP_RECOVERY_INCOMPLETE");
      const current = await this.repository.readCurrent();
      if (
        !(await this.repository.participantsReady(
          this.config.roles,
          current.revision,
        ))
      )
        throw Error("WRITER_NOT_READY");
    });
  }
  async recover(permit: ControlRecoveryPermit): Promise<void | "NOT_READY"> {
    if (
      !this.eligible ||
      !(await this.repository.participantsReady(
        this.config.roles,
        permit.revision,
      ))
    )
      return "NOT_READY";
    let verified = false;
    const outcome = await this.resources.replace(permit, async () => {
      const capability = probeStorageCapability({
        mediaRoot: this.config.mediaRoot,
        initialize: false,
        expectedMarkerId: this.config.markerId,
      });
      const fresh: RuntimeMediaResources = { capability };
      try {
        if (capability.state !== "READ_WRITE") throw Error("WRITER_NOT_READY");
        // Existing namespace/locks only. No initialize/provision or enum flip.
        capability.root.assertCoordinationNamespace();
        fresh.gate = CapacityGate.open({
          mediaRoot: capability.root.canonicalPath,
          expectedMarkerId: capability.root.markerId,
        });
        fresh.reader = OriginalReader.open({
          mediaRoot: capability.root.canonicalPath,
          expectedMarkerId: capability.root.markerId,
        });
        fresh.store = DerivedStore.open(capability);
        if (!(await this.recoverOriginal(permit, fresh))) return fresh;
        // Original expiry/epoch/retry strategy, at most twenty existing jobs.
        await permit.run("CANONICAL_RECONCILE", async () => {
          const [jobs] = await this.pool.query<
            RowDataPacket[]
          >(`SELECT CAST(family_id AS CHAR) familyId,CAST(media_id AS CHAR) mediaId,
            CAST(id AS CHAR) jobId,CAST(generation AS CHAR) generation FROM background_jobs
            WHERE state='RUNNING' AND locked_until<=CURRENT_TIMESTAMP(3) ORDER BY id LIMIT 20`);
          const repository = new MySqlJobRepository(this.pool);
          for (const job of jobs)
            await repository.recoverExpiredLease({
              familyId: String(job.familyId),
              mediaId: String(job.mediaId),
              jobId: String(job.jobId),
              generation: BigInt(job.generation),
            });
        });
        await new PurgeProcessor(
          this.pool,
          capability.root,
          fresh.store,
          fresh.gate,
        ).recoverFenced(permit);
        await permit.run("CAPACITY_RECONCILE", async () => {
          const inventory = await fresh.gate!.recoveryInventory();
          // Exact existing unsealed-temp cleanup only. Sealed/PUBLISHING output
          // remains protected; this never invents READY or a reservation.
          const actions = await reconcileDerivedPublishRecovery({
            pool: this.pool,
            capability: "READ_WRITE",
            inventoryComplete: inventory.complete,
            temps: inventory.temps,
            finals: [],
            acquireLifecycle: (identity) =>
              new ContentCoordination(
                capability.root,
                identity,
              ).acquireLifecycle("S", 30_000),
            cleanupExact: async (temp, row) =>
              fresh.store!.cleanupExactTemp(capability, {
                ...temp,
                familyId: row.familyId,
                mediaId: row.mediaId,
                generation: row.generation,
                recipeId: 1,
              }),
          });
          if (actions.some((a) => a.code === "COMMIT_UNKNOWN"))
            throw Error("DERIVATIVE_OUTCOME_UNKNOWN");
          if (
            actions.some(
              (a) =>
                ![
                  "TEMP_ONLY_RELEASED",
                  "TEMP_ONLY_RETAIN",
                  "ACCOUNTING_RETAINED",
                ].includes(a.code),
            )
          )
            return;
          const settled = await fresh.gate!.recoveryInventory();
          verified = await this.repository.verifyRecoveryInventory(settled);
          if (verified)
            await assertStorageOwnerHealth(capability.root, this.repository, {
              reader: fresh.reader!,
              gate: fresh.gate!,
            });
        });
        return fresh;
      } catch (error) {
        await closeMediaResources(fresh);
        throw error;
      }
    });
    if (
      outcome !== "READY" ||
      !verified ||
      !(await this.repository.participantsReady(
        this.config.roles,
        permit.revision,
      ))
    )
      return "NOT_READY";
  }
}
