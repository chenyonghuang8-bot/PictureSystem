import { performance } from "node:perf_hooks";

import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import {
  CAPACITY_OUTCOME_RESOLUTION_MS,
  CapacityDeadlineError,
  readCapacityOutcome,
  runCapacityTransaction,
} from "./capacity-transaction.js";
import {
  readDerivedCapacityInventory,
  readUploadCapacityInventory,
} from "./capacity-inventory.js";
import { acquireCheckedConnection, readServerTime } from "./connection.js";

const THUMBNAIL_CAP = 512n * 1_024n;
const PREVIEW_CAP = 4n * 1_024n * 1_024n;
const FAMILY_DERIVED_CAP = 32n * 1_024n ** 3n;
const GLOBAL_DERIVED_CAP = 64n * 1_024n ** 3n;
const SCRATCH_RESERVE = 64n * 1_024n ** 2n;
const MIN_FREE_RESERVE = 10n * 1_024n ** 3n;

export type DerivedReservationIdentity = {
  familyId: string;
  mediaId: string;
  generation: bigint;
  recipeId: 1;
  kind: "THUMBNAIL" | "PREVIEW";
  jobId: string;
  leaseEpoch: bigint;
  workerId: Buffer;
};

export type DerivedReservationRecord = {
  id: string;
  familyId: string;
  mediaId: string;
  generation: bigint;
  recipeId: number;
  kind: "THUMBNAIL" | "PREVIEW";
  state: string;
  reservedBytes: bigint;
  producerJobId: string;
  producerLeaseEpoch: bigint | null;
  cleanedAt: Date | null;
};

export type DerivedAdmissionResult = {
  transaction: "NOT_STARTED" | "ROLLED_BACK" | "COMMITTED" | "UNKNOWN";
  reservation:
    "CONFIRMED_MATCHING" | "CONFIRMED_ABSENT" | "CONFLICTING" | "UNRESOLVED";
  deadline: "WITHIN_BUDGET" | "EXCEEDED";
  evidence:
    "COMMIT_ACK" | "SERIALIZED_READBACK" | "CONFIRMED_ROLLBACK" | "NONE";
  identity: DerivedReservationIdentity;
  row: DerivedReservationRecord | null;
  reservedBytes: bigint;
  reason?:
    | "CAPACITY"
    | "LEASE"
    | "INVENTORY"
    | "IDENTITY"
    | "COORDINATION"
    | undefined;
};

type AssetRow = RowDataPacket & {
  id: string;
  familyId: string;
  mediaId: string;
  generation: string;
  recipeId: number;
  kind: "THUMBNAIL" | "PREVIEW";
  state: string;
  reservedBytes: string;
  byteSize: string | null;
  producerJobId: string;
  producerLeaseEpoch: string | null;
  cleanedAt: Date | null;
};

const ASSET_SELECT = `SELECT CAST(id AS CHAR) AS id,
  CAST(family_id AS CHAR) AS familyId,
  CAST(media_id AS CHAR) AS mediaId,
  CAST(generation AS CHAR) AS generation,
  recipe_id AS recipeId, kind, state,
  CAST(reserved_bytes AS CHAR) AS reservedBytes,
  CAST(byte_size AS CHAR) AS byteSize,
  CAST(producer_job_id AS CHAR) AS producerJobId,
  CAST(producer_lease_epoch AS CHAR) AS producerLeaseEpoch,
  cleaned_at AS cleanedAt
FROM derived_assets`;

class AdmissionRejected extends Error {
  constructor(
    readonly reason: NonNullable<DerivedAdmissionResult["reason"]>,
    readonly conflicting = false,
  ) {
    super("Capacity admission rejected.");
  }
}

function assertIdentity(input: DerivedReservationIdentity) {
  const id = /^[1-9][0-9]*$/u;
  if (
    !id.test(input.familyId) ||
    !id.test(input.mediaId) ||
    !id.test(input.jobId) ||
    input.generation < 1n ||
    input.leaseEpoch < 1n ||
    input.recipeId !== 1 ||
    (input.kind !== "THUMBNAIL" && input.kind !== "PREVIEW") ||
    !Buffer.isBuffer(input.workerId) ||
    input.workerId.length !== 16
  ) {
    throw new AdmissionRejected("IDENTITY");
  }
}

function toRecord(row: AssetRow): DerivedReservationRecord {
  return {
    id: row.id,
    familyId: row.familyId,
    mediaId: row.mediaId,
    generation: BigInt(row.generation),
    recipeId: row.recipeId,
    kind: row.kind,
    state: row.state,
    reservedBytes: BigInt(row.reservedBytes),
    producerJobId: row.producerJobId,
    producerLeaseEpoch:
      row.producerLeaseEpoch === null ? null : BigInt(row.producerLeaseEpoch),
    cleanedAt: row.cleanedAt,
  };
}

function exactMatch(
  row: DerivedReservationRecord,
  input: DerivedReservationIdentity,
  cap: bigint,
) {
  return (
    row.familyId === input.familyId &&
    row.mediaId === input.mediaId &&
    row.generation === input.generation &&
    row.recipeId === input.recipeId &&
    row.kind === input.kind &&
    row.producerJobId === input.jobId &&
    row.producerLeaseEpoch === input.leaseEpoch &&
    row.reservedBytes === cap &&
    row.state === "RESERVED" &&
    row.cleanedAt === null
  );
}

async function findIdentity(
  connection: PoolConnection,
  input: DerivedReservationIdentity,
  locking: boolean,
) {
  const [rows] = await connection.query<AssetRow[]>(
    `${ASSET_SELECT}
     WHERE family_id=? AND media_id=? AND generation=?
       AND recipe_id=? AND kind=?${locking ? " FOR UPDATE" : ""}`,
    [
      input.familyId,
      input.mediaId,
      input.generation.toString(),
      input.recipeId,
      input.kind,
    ],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

function isIdentityDuplicate(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    errno?: number;
    sqlMessage?: string;
    message?: string;
  };
  return (
    candidate.code === "ER_DUP_ENTRY" &&
    (candidate.errno === undefined || candidate.errno === 1062) &&
    `${candidate.sqlMessage ?? ""}\n${candidate.message ?? ""}`.includes(
      "uq_derived_assets_identity",
    )
  );
}

/**
 * DB-side reservation protocol only. It never creates a filesystem object or
 * issues a filesystem permit. The trusted coordinator owns the root/OS gate.
 */
export class MySqlDerivedAdmissionRepository {
  constructor(private readonly pool: Pool) {}

  async currentLease(input: DerivedReservationIdentity): Promise<boolean> {
    assertIdentity(input);
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT state, CAST(generation AS CHAR) AS generation,
           recipe_id AS recipeId, CAST(lease_epoch AS CHAR) AS leaseEpoch,
           worker_id AS workerId, locked_until AS lockedUntil
         FROM background_jobs
         WHERE id=? AND family_id=? AND media_id=? AND job_type='IMAGE_DERIVATIVES'`,
        [input.jobId, input.familyId, input.mediaId],
      );
      const job = rows[0];
      const now = await readServerTime(connection);
      return (
        !!job &&
        job.state === "RUNNING" &&
        BigInt(String(job.generation)) === input.generation &&
        Number(job.recipeId) === input.recipeId &&
        BigInt(String(job.leaseEpoch)) === input.leaseEpoch &&
        Buffer.isBuffer(job.workerId) &&
        job.workerId.equals(input.workerId) &&
        job.lockedUntil instanceof Date &&
        job.lockedUntil.getTime() > now.getTime()
      );
    } finally {
      connection.release();
    }
  }

  async reserve(
    input: DerivedReservationIdentity,
    admissionDeadline: number,
    finalCapacitySnapshot: () => {
      totalBytes: bigint;
      availableBytes: bigint;
      complete: boolean;
    },
    options: {
      commitForTest?: (connection: PoolConnection) => Promise<void>;
      rollbackForTest?: (connection: PoolConnection) => Promise<void>;
      readbackUnavailableForTest?: boolean;
      beforeCommitForTest?: (connection: PoolConnection) => Promise<void>;
    } = {},
  ): Promise<DerivedAdmissionResult> {
    assertIdentity(input);
    const cap = input.kind === "THUMBNAIL" ? THUMBNAIL_CAP : PREVIEW_CAP;
    const deadline = () =>
      performance.now() >= admissionDeadline ? "EXCEEDED" : "WITHIN_BUDGET";
    let prior: DerivedReservationRecord | null = null;
    let leaseUntil: Date | null = null;
    const outcome = await runCapacityTransaction(
      this.pool,
      admissionDeadline,
      async (connection) => {
        // The shared transaction runner can retry a confirmed deadlock. Never
        // carry a prior-row or lease observation from an earlier attempt.
        prior = null;
        leaseUntil = null;
        const [families] = await connection.query<RowDataPacket[]>(
          "SELECT CAST(id AS CHAR) AS id FROM families WHERE id=? FOR UPDATE",
          [input.familyId],
        );
        if (!families[0]) throw new AdmissionRejected("IDENTITY");
        const [media] = await connection.query<RowDataPacket[]>(
          `SELECT CAST(id AS CHAR) AS id,
             CAST(generation AS CHAR) AS generation, recipe_id AS recipeId
           FROM media_items WHERE id=? AND family_id=? FOR UPDATE`,
          [input.mediaId, input.familyId],
        );
        if (
          !media[0] ||
          BigInt(String(media[0].generation)) !== input.generation ||
          Number(media[0].recipeId) !== input.recipeId
        ) {
          throw new AdmissionRejected("IDENTITY");
        }
        const [jobs] = await connection.query<RowDataPacket[]>(
          `SELECT CAST(id AS CHAR) AS id, CAST(generation AS CHAR) AS generation,
             recipe_id AS recipeId, job_type AS jobType, state,
             CAST(lease_epoch AS CHAR) AS leaseEpoch,
             worker_id AS workerId, locked_until AS lockedUntil
           FROM background_jobs
           WHERE id=? AND family_id=? AND media_id=? FOR UPDATE`,
          [input.jobId, input.familyId, input.mediaId],
        );
        const job = jobs[0];
        const now = await readServerTime(connection);
        if (
          !job ||
          job.jobType !== "IMAGE_DERIVATIVES" ||
          job.state !== "RUNNING" ||
          BigInt(String(job.generation)) !== input.generation ||
          Number(job.recipeId) !== input.recipeId ||
          BigInt(String(job.leaseEpoch)) !== input.leaseEpoch ||
          !Buffer.isBuffer(job.workerId) ||
          !job.workerId.equals(input.workerId) ||
          !(job.lockedUntil instanceof Date) ||
          job.lockedUntil.getTime() <= now.getTime()
        ) {
          throw new AdmissionRejected("LEASE");
        }
        leaseUntil = job.lockedUntil as Date;
        // Current reads occur only after acquiring the global session lock.
        // Any unsafe/unclassified filesystem entry must cause the supplied
        // storage snapshot to report incomplete and reject this admission.
        const { familyUsage, globalUsage, unsettled } =
          await readDerivedCapacityInventory(connection);
        prior = await findIdentity(connection, input, true);
        if (prior && !exactMatch(prior, input, cap)) {
          throw new AdmissionRejected("IDENTITY", true);
        }
        const usage = await readUploadCapacityInventory(connection);
        const physical = finalCapacitySnapshot();
        if (
          !physical.complete ||
          physical.availableBytes < 0n ||
          physical.totalBytes <= 0n
        ) {
          throw new AdmissionRejected("INVENTORY");
        }
        const delta = prior ? 0n : cap;
        if (
          (familyUsage.get(input.familyId) ?? 0n) + delta >
            FAMILY_DERIVED_CAP ||
          globalUsage + delta > GLOBAL_DERIVED_CAP
        ) {
          throw new AdmissionRejected("CAPACITY");
        }
        const reserve =
          physical.totalBytes / 10n > MIN_FREE_RESERVE
            ? physical.totalBytes / 10n
            : MIN_FREE_RESERVE;
        if (
          physical.availableBytes <
          reserve +
            SCRATCH_RESERVE +
            usage.reservedFutureBytes +
            unsettled +
            delta
        ) {
          throw new AdmissionRejected("CAPACITY");
        }
        if (prior) return prior;
        try {
          await connection.execute<ResultSetHeader>(
            `INSERT INTO derived_assets
               (family_id,media_id,generation,recipe_id,kind,state,
                reserved_bytes,producer_job_id,producer_lease_epoch)
             VALUES (?,?,?,?,?,'RESERVED',?,?,?)`,
            [
              input.familyId,
              input.mediaId,
              input.generation.toString(),
              input.recipeId,
              input.kind,
              cap.toString(),
              input.jobId,
              input.leaseEpoch.toString(),
            ],
          );
        } catch (error) {
          if (!isIdentityDuplicate(error)) throw error;
          const winner = await findIdentity(connection, input, true);
          if (!winner || !exactMatch(winner, input, cap)) {
            throw new AdmissionRejected("IDENTITY", true);
          }
          return winner;
        }
        const created = await findIdentity(connection, input, true);
        if (!created) throw new AdmissionRejected("IDENTITY");
        return created;
      },
      {
        ...options,
        beforeCommit: async (connection) => {
          const now = await readServerTime(connection);
          if (!leaseUntil || leaseUntil.getTime() <= now.getTime()) {
            throw new AdmissionRejected("LEASE");
          }
          await options.beforeCommitForTest?.(connection);
        },
      },
    );
    if (outcome.transaction === "COMMITTED") {
      return {
        transaction: "COMMITTED",
        reservation: "CONFIRMED_MATCHING",
        deadline: outcome.deadlineExceeded ? "EXCEEDED" : deadline(),
        evidence: "COMMIT_ACK",
        identity: input,
        row: outcome.value,
        reservedBytes: cap,
      };
    }
    if (outcome.transaction === "NOT_STARTED") {
      return {
        transaction: "NOT_STARTED",
        reservation: "UNRESOLVED",
        deadline: deadline(),
        evidence: "NONE",
        identity: input,
        row: null,
        reservedBytes: cap,
        reason: "COORDINATION",
      };
    }
    if (outcome.transaction === "ROLLED_BACK") {
      const rejected = outcome.error;
      const classified =
        rejected instanceof AdmissionRejected ||
        rejected instanceof CapacityDeadlineError;
      if (!classified) throw rejected;
      return {
        transaction: "ROLLED_BACK",
        reservation:
          rejected instanceof AdmissionRejected && rejected.conflicting
            ? "CONFLICTING"
            : prior
              ? "CONFIRMED_MATCHING"
              : "CONFIRMED_ABSENT",
        deadline: deadline(),
        evidence: "CONFIRMED_ROLLBACK",
        identity: input,
        row: prior,
        reservedBytes: cap,
        reason:
          rejected instanceof AdmissionRejected
            ? rejected.reason
            : rejected instanceof CapacityDeadlineError
              ? undefined
              : "COORDINATION",
      };
    }
    // Never replay INSERT after an ambiguous COMMIT or rollback failure.
    const readback = options.readbackUnavailableForTest
      ? null
      : await readCapacityOutcome(
          this.pool,
          admissionDeadline + CAPACITY_OUTCOME_RESOLUTION_MS,
          async (connection) => ({
            row: await findIdentity(connection, input, true),
          }),
        );
    const row = readback?.row ?? null;
    return {
      transaction: "UNKNOWN",
      reservation: !readback
        ? "UNRESOLVED"
        : !row
          ? "CONFIRMED_ABSENT"
          : exactMatch(row, input, cap)
            ? "CONFIRMED_MATCHING"
            : "CONFLICTING",
      deadline: deadline(),
      evidence: readback ? "SERIALIZED_READBACK" : "NONE",
      identity: input,
      row,
      reservedBytes: cap,
      reason: readback ? undefined : "COORDINATION",
    };
  }
}
