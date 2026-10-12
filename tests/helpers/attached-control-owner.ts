import type { Pool } from "../../packages/db/src/index.js";
import { MySqlUploadRepository } from "../../packages/db/src/index.js";
import { StorageRoot } from "../../packages/storage/src/index.js";
import { ManagedControl } from "../../apps/worker/src/deployment-control.js";
import { StorageRuntimeOwner } from "../../apps/worker/src/storage-runtime-owner.js";
import { StorageReconciler } from "../../apps/api/src/uploads/recovery.js";
import { UploadMutex } from "../../apps/api/src/uploads/mutex.js";
import { startupRecoveryComplete } from "../../apps/api/src/uploads/startup.js";
import type { DevControlHarness } from "./dev-control-harness.js";

/** After the fixture's actual processes exit, start a new real owner. It gets
 * its own run/boot, acquires run.lock before the Original writer, and performs
 * the same authorized RECHECK. It never borrows the departed API's proof. */
export async function attachControlOwner(
  pool: Pool,
  fixture: DevControlHarness,
  media: { path: string; marker: string },
) {
  const managed = new ManagedControl(fixture.gate, fixture.repository);
  await managed.prepare(["API"], media.path, media.marker);
  const control = managed.public(false);
  // This fixture explicitly exercises an owner change and authorized recovery,
  // rather than the automatic CLEAN path tested by the built restart suite.
  await control.trip!("STARTUP_RECHECK_REQUIRED");
  let owner: StorageRuntimeOwner | undefined;
  try {
    const root = StorageRoot.open(media.path, {
      initialize: false,
      expectedMarkerId: media.marker,
    });
    owner = new StorageRuntimeOwner(
      { capability: { state: "READ_WRITE", root } },
      pool,
      fixture.repository,
      { mediaRoot: media.path, markerId: media.marker, roles: ["API"] },
      async (permit, resources) => {
        const report = await permit.run("STARTUP_ASSESS", () =>
          new StorageReconciler(
            new MySqlUploadRepository(pool),
            resources.capability,
            new UploadMutex(),
          ).run({ mode: "recover", scope: "startup", maxCandidates: 20_000 }),
        );
        if (!startupRecoveryComplete(report))
          throw Error("ATTACHED_OWNER_STARTUP_RECOVERY_INCOMPLETE");
        return true;
      },
    );
    control.bindOwner!(owner);
    await control.start!([{ role: "API", ready: () => owner!.ready() }]);
    await fixture.observeRoles(["API"], true);
    await fixture.recheck();
    await fixture.waitStable("READ_ONLY");
    await fixture.request("NORMAL");
    const resources = await owner.resources.withValue(async (r) => r);
    if (
      resources.capability.state !== "READ_WRITE" ||
      !resources.store ||
      !resources.gate
    )
      throw Error("ATTACHED_OWNER_RESOURCES_REQUIRED");
    return {
      root: resources.capability.root,
      store: resources.store,
      gate: resources.gate,
      admission: control.admission,
      close: async () => {
        let confirmed = false;
        try {
          const current = await fixture.repository.readCurrent();
          if (current.transitionState === "RECOVERY_REQUIRED")
            await fixture.recheck();
          await fixture.request("READ_ONLY");
          await control.beginShutdown!();
          confirmed = true;
        } finally {
          control.stop!();
          try {
            await control.drain!();
          } finally {
            try {
              await owner!.resources.close();
            } finally {
              await control.resourcesClosed!(confirmed);
            }
          }
        }
      },
    };
  } catch (error) {
    control.stop!();
    try {
      await control.drain!();
    } finally {
      try {
        await owner?.resources.close();
      } finally {
        await control.resourcesClosed!(false);
      }
    }
    throw error;
  }
}
