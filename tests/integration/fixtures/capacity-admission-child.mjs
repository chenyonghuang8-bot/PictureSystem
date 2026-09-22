import {
  createDatabase,
  MySqlDerivedAdmissionRepository,
} from "../../../packages/db/dist/index.js";
import { CapacityGate } from "../../../packages/storage/dist/index.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../../../packages/storage/build/storage_native.node");

process.once("message", async (message) => {
  const database = createDatabase(process.env.DATABASE_URL);
  let gate;
  try {
    gate = CapacityGate.open({
      mediaRoot: message.mediaRoot,
      expectedMarkerId: message.markerId,
    });
    const repository = new MySqlDerivedAdmissionRepository(database.pool);
    const identity = {
      familyId: message.identity.familyId,
      mediaId: message.identity.mediaId,
      generation: BigInt(message.identity.generation),
      recipeId: 1,
      kind: "THUMBNAIL",
      jobId: message.identity.jobId,
      leaseEpoch: BigInt(message.identity.leaseEpoch),
      workerId: Buffer.from(message.identity.workerId, "base64url"),
    };
    const probe = native.openCapacityGate(message.mediaRoot, message.markerId);
    try {
      if (native.tryAcquireCapacityGate(probe)) {
        native.releaseCapacityGate(probe);
        throw new Error("Expected the parent to hold the OS capacity lock.");
      }
      process.send?.({ stage: "os-busy" });
    } finally {
      native.closeCapacityGate(probe);
    }
    const result = await gate.withAdmissionLock(async (deadline, snapshot) =>
      repository.reserve(identity, deadline, () => {
        const physical = snapshot();
        return {
          totalBytes: 100n * 1_024n ** 3n,
          availableBytes:
            10n * 1_024n ** 3n + 64n * 1_024n ** 2n + 2n * 512n * 1_024n - 1n,
          complete: physical.derivedInventoryComplete,
        };
      }),
    );
    process.send?.({
      stage: "done",
      transaction: result.transaction,
      reservation: result.reservation,
      reason: result.reason ?? null,
    });
  } catch {
    process.send?.({ stage: "failed" });
  } finally {
    gate?.close();
    await database.pool.end();
    process.disconnect?.();
  }
});
