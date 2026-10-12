import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hashPassword } from "../../packages/auth/src/index.js";
import {
  MySqlUploadRepository,
  type MySqlSystemRunRepository,
  type Pool,
} from "../../packages/db/src/index.js";
import {
  StorageRoot,
  type ControlAdmission,
  type OperationGate,
} from "../../packages/storage/src/index.js";
import { startupRecoveryComplete } from "../../apps/api/src/uploads/startup.js";
import { StorageReconciler } from "../../apps/api/src/uploads/recovery.js";
import { UploadMutex } from "../../apps/api/src/uploads/mutex.js";
import {
  ManagedControl,
  type DeploymentControl,
} from "../../apps/worker/src/deployment-control.js";
import {
  StorageRuntimeOwner,
  type RuntimeMediaResources,
} from "../../apps/worker/src/storage-runtime-owner.js";
import { DevControlHarness } from "./dev-control-harness.js";
import { freshStorageRootPath } from "../fixtures/fresh-storage-root.js";

/** Real native/SQL owner for an in-process integration service. It adopts the
 * fixture's writer, performs original startup and generation replacement, and
 * supplies the same deployment admission used by production entry points. */
export class InProcessControlOwner {
  private constructor(
    readonly fixture: DevControlHarness,
    readonly owner: StorageRuntimeOwner,
    private readonly control: DeploymentControl,
  ) {}
  static async start(
    pool: Pool,
    familyIds: readonly string[],
    root = StorageRoot.open(freshStorageRootPath("phase11-in-process-"), {
      initialize: true,
    }),
    existing: Omit<RuntimeMediaResources, "capability"> = {},
    startupFamilyScope?: string,
    controlGateFactory?: (gate: OperationGate) => OperationGate,
    runRepository?: MySqlSystemRunRepository,
  ) {
    mkdirSync(join(root.canonicalPath, "derived"), {
      recursive: true,
      mode: 0o700,
    });
    if (!existing.store) root.provisionDerivedWriterLockForDev();
    if (!existing.gate) root.provisionSharedCapacityLockForDev();
    const fixture = await DevControlHarness.create(
      pool,
      await hashPassword("synthetic-in-process-control-password"),
      familyIds,
      "API",
    );
    const controlGate = controlGateFactory?.(fixture.gate) ?? fixture.gate;
    const managed = new ManagedControl(
        controlGate,
        fixture.repository,
        runRepository,
      ),
      control = managed.public(false);
    await managed.prepare(["API"], root.canonicalPath, root.markerId);
    const owner = new StorageRuntimeOwner(
      { capability: { state: "READ_WRITE", root }, ...existing },
      pool,
      fixture.repository,
      {
        mediaRoot: root.canonicalPath,
        markerId: root.markerId,
        roles: ["API"],
      },
      async (permit, resources) => {
        const report = await permit.run("STARTUP_ASSESS", () =>
          new StorageReconciler(
            new MySqlUploadRepository(pool),
            resources.capability,
            new UploadMutex(),
          ).run({
            mode: "recover",
            scope: "startup",
            maxCandidates: 20_000,
            ...(startupFamilyScope ? { familyScope: startupFamilyScope } : {}),
          }),
        );
        if (!startupRecoveryComplete(report))
          throw Error(
            `FIXTURE_STARTUP_RECOVERY_INCOMPLETE:${report.reasonCodes.join(":")}`,
          );
        return true;
      },
    );
    let recoveryFailure = "";
    const recover = owner.recover.bind(owner);
    owner.recover = async (permit) => {
      try {
        return await recover(permit);
      } catch (error) {
        const reason =
          error && typeof error === "object" && "reason" in error
            ? error.reason
            : error instanceof Error
              ? error.message
              : "UNKNOWN";
        recoveryFailure =
          typeof reason === "string" && /^[A-Z][A-Z0-9_:]{0,160}$/u.test(reason)
            ? reason
            : `UNCLASSIFIED_${error instanceof Error ? error.name.replace(/[^A-Za-z0-9_]/gu, "") : "UNKNOWN"}_${error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : "NO_CODE"}_${error instanceof Error ? [...(error.stack ?? "").matchAll(/\/PictureSystem\/([^\s()]+\.ts:\d+:\d+)/gu)].map((match) => match[1]).join("|") : "NO_FRAME"}`;
        throw error;
      }
    };
    try {
      control.bindOwner!(owner);
      await control.start!([{ role: "API", ready: () => owner.ready() }]);
      await fixture.observeRoles(["API"], true);
      await fixture.waitStable("READ_ONLY");
      await fixture.request("NORMAL");
    } catch (error) {
      control.stop!();
      await control.drain!();
      await owner.resources.close();
      await control.resourcesClosed!(false);
      if (recoveryFailure)
        throw new Error(`FIXTURE_OWNER_RECOVERY:${recoveryFailure}`, {
          cause: error,
        });
      throw error;
    }
    return new InProcessControlOwner(fixture, owner, control);
  }
  /** Fault-matrix barrier: stop actual observation tasks without signing shutdown. */
  haltObservationsForFault() {
    this.control.stop!();
  }
  async trip(reason: string) {
    await this.control.trip!(reason);
  }
  async releaseForApiRestart() {
    await this.control.beginShutdown!().catch(() => {});
    this.control.stop!();
    await this.control.drain!();
    await this.owner.resources.close();
    await this.control.resourcesClosed!(true);
  }
  /** A faulted run cannot sign STOPPING/CLEAN. Join all callbacks anyway, then
   * close the actual resources and release the owner without any terminal ACK.
   * A successor must still perform the original protected fresh RECHECK. */
  async releaseProtectedForApiRestart() {
    await this.control.beginShutdown!().catch(() => {});
    this.control.stop!();
    await this.control.drain!().catch(() => {});
    await this.owner.resources.close();
    await this.control.resourcesClosed!(false);
  }
  async cleanupReleasedOwner() {
    const current = await this.fixture.repository.readCurrent();
    if (
      this.owner.resources.isAvailable() ||
      current.enforcedMode !== "READ_ONLY" ||
      current.transitionState !== "STABLE" ||
      current.faultLatched
    )
      throw Error("RELEASED_OWNER_PROTECTED_CLEANUP_REQUIRED");
    await this.fixture.cleanup();
  }
  get admission(): ControlAdmission {
    return this.control.admission;
  }
  withResources<T>(callback: (resources: RuntimeMediaResources) => Promise<T>) {
    return this.owner.resources.withValue(callback);
  }
  async close(options: { recheck?: boolean } = {}) {
    try {
      if (options.recheck) {
        const current = await this.fixture.repository.readCurrent();
        if (
          current.transitionState === "RECOVERY_REQUIRED" ||
          current.faultLatched
        )
          await this.fixture.recheck();
      }
      await this.fixture.request("READ_ONLY");
    } finally {
      await this.control.beginShutdown!().catch(() => {});
      this.control.stop!();
      await this.control.drain!();
      let closed = false;
      try {
        await this.owner.resources.close();
        closed = true;
      } finally {
        await this.control.resourcesClosed!(closed);
      }
    }
    await this.fixture.cleanup();
  }
}
