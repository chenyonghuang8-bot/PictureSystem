import { performance } from "node:perf_hooks";

import type {
  DerivedAdmissionResult,
  DerivedReservationIdentity,
  MySqlDerivedAdmissionRepository,
} from "@family-album/db";
import {
  mintDerivedTempAdmissionPermit,
  type DerivedStore,
  type DerivedTempAdmissionPermit,
  type StorageCapability,
  type UnverifiedRenderedCandidate,
} from "@family-album/storage";
import type { CapacityGate } from "@family-album/storage";

export {
  DerivedTempAdmissionPermit,
  isDerivedTempAdmissionPermit,
} from "@family-album/storage";

export type DerivedAdmissionDecision = {
  result: DerivedAdmissionResult;
  permit: DerivedTempAdmissionPermit | null;
};

/** Compose the storage OS gate and DB session/transaction gate in that order. */
export async function admitDerivedReservation(
  capability: StorageCapability,
  gate: CapacityGate,
  repository: MySqlDerivedAdmissionRepository,
  identity: DerivedReservationIdentity,
): Promise<DerivedAdmissionDecision> {
  if (capability.state !== "READ_WRITE") {
    throw new Error("Derived capacity admission requires READ_WRITE storage.");
  }
  return gate.withAdmissionLock(async (deadline, snapshot) => {
    const result = await repository.reserve(identity, deadline, () => {
      const physical = snapshot();
      return {
        totalBytes: physical.totalBytes,
        availableBytes: physical.availableBytes,
        complete: physical.derivedInventoryComplete,
        observations: physical.derivedObservations,
      };
    });
    if (
      result.transaction !== "COMMITTED" ||
      result.reservation !== "CONFIRMED_MATCHING" ||
      result.deadline !== "WITHIN_BUDGET" ||
      !result.row ||
      performance.now() >= deadline ||
      !(await repository.currentLease(identity)) ||
      performance.now() >= deadline
    ) {
      return { result, permit: null };
    }
    capability.root.assertIdentity();
    return {
      result,
      permit: mintDerivedTempAdmissionPermit(
        identity,
        result.row.id,
        result.reservedBytes,
        deadline,
      ),
    };
  });
}

/**
 * Consumes a live permit and creates the deterministic owned temp.
 * Does not seal, publish, or complete the job.
 */
export async function createOwnedDerivedTemp(
  capability: StorageCapability,
  store: DerivedStore,
  repository: MySqlDerivedAdmissionRepository,
  permit: DerivedTempAdmissionPermit,
  candidate: UnverifiedRenderedCandidate,
) {
  return store.createOwnedTemp(capability, permit, candidate, (identity) =>
    repository.currentLease(identity),
  );
}
