import { performance } from "node:perf_hooks";

import type {
  DerivedAdmissionResult,
  DerivedReservationIdentity,
  MySqlDerivedAdmissionRepository,
} from "@family-album/db";
import type { CapacityGate, StorageCapability } from "@family-album/storage";

const permitSecret = Symbol("derived-temp-admission");
const livePermits = new WeakSet<DerivedTempAdmissionPermit>();

/**
 * Internal one-use authority for a future native temp stage. No filesystem
 * consumer exists in D3b-0; a plain object or TypeScript cast cannot pass the
 * runtime brand check.
 */
export class DerivedTempAdmissionPermit {
  #consumed = false;
  #identity: DerivedReservationIdentity;

  constructor(
    secret: typeof permitSecret,
    identity: DerivedReservationIdentity,
    readonly reservationId: string,
    readonly reservedBytes: bigint,
    readonly deadline: number,
  ) {
    if (secret !== permitSecret) {
      throw new Error("Invalid derived admission permit.");
    }
    this.#identity = {
      ...identity,
      workerId: Buffer.from(identity.workerId),
    };
    Object.freeze(this);
    livePermits.add(this);
  }

  consume() {
    if (
      !livePermits.has(this) ||
      this.#consumed ||
      performance.now() >= this.deadline
    ) {
      throw new Error("Derived admission permit is no longer valid.");
    }
    this.#consumed = true;
    return {
      identity: {
        ...this.#identity,
        workerId: Buffer.from(this.#identity.workerId),
      },
      reservationId: this.reservationId,
      reservedBytes: this.reservedBytes,
    };
  }
}

export function isDerivedTempAdmissionPermit(
  value: unknown,
): value is DerivedTempAdmissionPermit {
  return (
    typeof value === "object" &&
    value !== null &&
    livePermits.has(value as DerivedTempAdmissionPermit)
  );
}

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
      permit: new DerivedTempAdmissionPermit(
        permitSecret,
        identity,
        result.row.id,
        result.reservedBytes,
        deadline,
      ),
    };
  });
}
