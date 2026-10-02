import {
  StorageSafetyError,
  type CapacityGate,
  type StorageCapability,
} from "@family-album/storage";
import { ContentCoordination } from "../../../../packages/storage/src/phase7-coordination.js";
import type { DerivedReadIdentity } from "./service.js";

// Shared by authenticated thumbnails/previews, attachment Preview and public
// derived serving. R precedes CapacityGate and ends before second auth/send.
export function coordinatedDerivedReader(
  capability: StorageCapability,
  gate: CapacityGate | undefined,
) {
  return {
    async read(
      identity: DerivedReadIdentity,
      options?: { signal: AbortSignal },
    ) {
      if (!gate || capability.state === "UNAVAILABLE")
        throw new StorageSafetyError("DERIVED_SERVE_UNAVAILABLE");
      options?.signal.throwIfAborted();
      const read = await new ContentCoordination(capability.root, {
        familyId: identity.familyId,
        sha256Hex: identity.originalSha256Hex,
        byteSize: identity.originalByteSize,
      }).acquireReadOnly(30_000);
      try {
        return await gate.withLock(() => {
          options?.signal.throwIfAborted();
          return Promise.resolve(gate.readDerivedFinal(identity));
        });
      } finally {
        read.close();
      }
    },
  };
}
