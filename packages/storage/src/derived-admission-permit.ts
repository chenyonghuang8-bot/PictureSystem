import { performance } from "node:perf_hooks";

const permitSecret = Symbol("derived-temp-admission");
const livePermits = new WeakSet<DerivedTempAdmissionPermit>();
const UINT64_MAX = 18446744073709551615n;

export type DerivedTempPermitIdentity = {
  familyId: string;
  mediaId: string;
  generation: bigint;
  recipeId: 1;
  kind: "THUMBNAIL" | "PREVIEW";
  jobId: string;
  leaseEpoch: bigint;
  workerId: Buffer;
};

function permitError(reason: string) {
  const error = new Error(reason);
  (error as Error & { code: string }).code = reason;
  return error;
}

function canonicalDecimal(value: string) {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) return null;
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > UINT64_MAX || parsed.toString() !== value) {
    return null;
  }
  return value;
}

function canonicalBigint(value: bigint) {
  if (typeof value !== "bigint" || value <= 0n || value > UINT64_MAX)
    return null;
  const text = value.toString();
  return canonicalDecimal(text) === null ? null : text;
}

export function assertCanonicalTempIdentity(
  identity: DerivedTempPermitIdentity,
) {
  if (
    canonicalDecimal(identity.familyId) === null ||
    canonicalDecimal(identity.mediaId) === null ||
    canonicalBigint(identity.generation) === null ||
    identity.recipeId !== 1 ||
    (identity.kind !== "THUMBNAIL" && identity.kind !== "PREVIEW") ||
    canonicalDecimal(identity.jobId) === null ||
    canonicalBigint(identity.leaseEpoch) === null ||
    !Buffer.isBuffer(identity.workerId) ||
    identity.workerId.length !== 16
  ) {
    throw permitError("DERIVED_TEMP_IDENTITY");
  }
}

/**
 * One-use authority minted only after a confirmed derived reservation.
 * A plain object, spread copy, or TypeScript cast is not in the live set.
 */
export class DerivedTempAdmissionPermit {
  #consumed = false;
  #identity: DerivedTempPermitIdentity;

  constructor(
    secret: typeof permitSecret,
    identity: DerivedTempPermitIdentity,
    readonly reservationId: string,
    readonly reservedBytes: bigint,
    readonly deadline: number,
  ) {
    if (secret !== permitSecret) {
      throw permitError("DERIVED_PERMIT_INVALID");
    }
    assertCanonicalTempIdentity(identity);
    if (!/^[1-9][0-9]{0,19}$/u.test(reservationId)) {
      throw permitError("DERIVED_TEMP_IDENTITY");
    }
    if (
      typeof reservedBytes !== "bigint" ||
      reservedBytes <= 0n ||
      reservedBytes > UINT64_MAX
    ) {
      throw permitError("DERIVED_TEMP_IDENTITY");
    }
    this.#identity = {
      ...identity,
      workerId: Buffer.from(identity.workerId),
    };
    Object.freeze(this);
    livePermits.add(this);
  }

  currentIdentity() {
    this.#assertUsable();
    return {
      ...this.#identity,
      workerId: Buffer.from(this.#identity.workerId),
    };
  }

  consume() {
    this.#assertUsable();
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

  #assertUsable() {
    if (
      !livePermits.has(this) ||
      this.#consumed ||
      performance.now() >= this.deadline
    ) {
      throw permitError("DERIVED_PERMIT_INVALID");
    }
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

/** Mints the branded permit. Callers must already have a confirmed reservation. */
export function mintDerivedTempAdmissionPermit(
  identity: DerivedTempPermitIdentity,
  reservationId: string,
  reservedBytes: bigint,
  deadline: number,
) {
  return new DerivedTempAdmissionPermit(
    permitSecret,
    identity,
    reservationId,
    reservedBytes,
    deadline,
  );
}

/** Synthetic permit for DEV tests. Production startup cannot mint one. */
export function issueDerivedTempPermitForDev(
  identity: DerivedTempPermitIdentity,
  reservationId: string,
  reservedBytes: bigint,
  deadline: number,
) {
  if (process.env.NODE_ENV === "production") {
    throw permitError("DERIVED_PERMIT_DEV_ONLY");
  }
  return new DerivedTempAdmissionPermit(
    permitSecret,
    identity,
    reservationId,
    reservedBytes,
    deadline,
  );
}
