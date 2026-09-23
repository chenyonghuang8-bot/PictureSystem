import { randomBytes } from "node:crypto";

import type {
  Phase4FailureCode,
  Phase4JobState,
  Phase4JobType,
} from "@family-album/contracts";
import { phase4FailureCodes, phase4JobTypes } from "@family-album/contracts";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import { readServerTime, runCheckedTransaction } from "./connection.js";

const LEASE_MILLISECONDS = 90_000;
const RETRY_RANGES_SECONDS = {
  1: [30, 45],
  2: [120, 150],
} as const;

export type WorkerIdentity = Buffer;

export type BackgroundJobRecord = {
  id: string;
  familyId: string;
  mediaId: string;
  generation: bigint;
  recipeId: number;
  jobType: Phase4JobType;
  state: Phase4JobState;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  heartbeatAt: Date | null;
  lockedUntil: Date | null;
  workerId: Buffer | null;
  leaseEpoch: bigint;
  lastFailureCode: Phase4FailureCode | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};

export type EnqueueJobResult = {
  job: BackgroundJobRecord;
  created: boolean;
};

export type FencedMutationResult = {
  affectedRows: 0 | 1;
  state?: "SUCCEEDED" | "FAILED" | "RETRY_WAIT";
};

export class JobRepositoryError extends Error {
  constructor(readonly reason: "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT") {
    super(reason);
    this.name = "JobRepositoryError";
  }
}

type JobRow = RowDataPacket & {
  id: string;
  familyId: string;
  mediaId: string;
  generation: string;
  recipeId: number;
  jobType: Phase4JobType;
  state: Phase4JobState;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  heartbeatAt: Date | null;
  lockedUntil: Date | null;
  workerId: Buffer | null;
  leaseEpoch: string;
  lastFailureCode: Phase4FailureCode | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};

type MediaFenceRow = RowDataPacket & {
  generation: string;
  recipeId: number;
};

const JOB_SELECT = `SELECT CAST(id AS CHAR) AS id,
  CAST(family_id AS CHAR) AS familyId, CAST(media_id AS CHAR) AS mediaId,
  CAST(generation AS CHAR) AS generation, recipe_id AS recipeId,
  job_type AS jobType, state, attempts, max_attempts AS maxAttempts,
  available_at AS availableAt, locked_at AS lockedAt,
  heartbeat_at AS heartbeatAt, locked_until AS lockedUntil,
  worker_id AS workerId, CAST(lease_epoch AS CHAR) AS leaseEpoch,
  last_failure_code AS lastFailureCode, created_at AS createdAt,
  updated_at AS updatedAt, finished_at AS finishedAt
FROM background_jobs`;

export class MySqlJobRepository {
  private readonly random: () => number;

  constructor(
    private readonly pool: Pool,
    options: { random?: () => number } = {},
  ) {
    this.random = options.random ?? Math.random;
  }

  static createWorkerIdentity(): WorkerIdentity {
    return randomBytes(16);
  }

  async enqueue(input: {
    familyId: string;
    mediaId: string;
    generation: bigint;
    recipeId: number;
    jobType: Phase4JobType;
  }): Promise<EnqueueJobResult> {
    assertJobIdentity(input);
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const media = await lockMedia(connection, input.familyId, input.mediaId);
      if (
        BigInt(media.generation) !== input.generation ||
        media.recipeId !== input.recipeId
      ) {
        throw new JobRepositoryError("CONFLICT");
      }
      const existing = await findIdentity(connection, input, false);
      if (existing) return { job: existing, created: false };
      const now = await readServerTime(connection);
      try {
        await connection.execute<ResultSetHeader>(
          `INSERT INTO background_jobs
            (family_id,media_id,generation,recipe_id,job_type,available_at)
           VALUES (?,?,?,?,?,?)`,
          [
            input.familyId,
            input.mediaId,
            input.generation.toString(),
            input.recipeId,
            input.jobType,
            now,
          ],
        );
      } catch (error) {
        if (!isJobIdentityDuplicate(error)) throw error;
        const winner = await findIdentity(connection, input, true);
        if (!winner) throw new JobRepositoryError("CONFLICT");
        return { job: winner, created: false };
      }
      const created = await findIdentity(connection, input, true);
      if (!created) throw new JobRepositoryError("CONFLICT");
      return { job: created, created: true };
    });
  }

  async claimNext(
    workerId: WorkerIdentity,
    options: { jobType?: Phase4JobType } = {},
  ): Promise<BackgroundJobRecord | null> {
    assertWorkerId(workerId);
    if (
      options.jobType !== undefined &&
      !phase4JobTypes.includes(options.jobType)
    ) {
      throw new JobRepositoryError("INVALID_INPUT");
    }
    return runCheckedTransaction(this.pool, async (connection) => {
      const [rows] = await connection.query<JobRow[]>(
        `${JOB_SELECT} FORCE INDEX (idx_background_jobs_claim)
         WHERE state IN ('QUEUED','RETRY_WAIT')
           AND available_at <= CURRENT_TIMESTAMP(3)
           AND attempts < max_attempts
           ${options.jobType === undefined ? "" : "AND job_type=?"}
         ORDER BY available_at ASC,id ASC
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
        options.jobType === undefined ? [] : [options.jobType],
      );
      const candidate = rows[0];
      if (!candidate) return null;
      const now = await readServerTime(connection);
      if (
        candidate.availableAt.getTime() > now.getTime() ||
        candidate.attempts >= candidate.maxAttempts
      ) {
        return null;
      }
      const lockedUntil = new Date(now.getTime() + LEASE_MILLISECONDS);
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE background_jobs
         SET state='RUNNING',attempts=attempts+1,worker_id=?,
             lease_epoch=lease_epoch+1,locked_at=?,heartbeat_at=?,
             locked_until=?,updated_at=?
         WHERE id=? AND family_id=? AND media_id=? AND generation=?
           AND state IN ('QUEUED','RETRY_WAIT') AND available_at<=?
           AND attempts=? AND attempts<max_attempts AND lease_epoch=?`,
        [
          workerId,
          now,
          now,
          lockedUntil,
          now,
          candidate.id,
          candidate.familyId,
          candidate.mediaId,
          candidate.generation,
          now,
          candidate.attempts,
          candidate.leaseEpoch,
        ],
      );
      if (changed.affectedRows !== 1) throw new JobRepositoryError("CONFLICT");
      return {
        ...mapJob(candidate),
        state: "RUNNING",
        attempts: candidate.attempts + 1,
        workerId: Buffer.from(workerId),
        leaseEpoch: BigInt(candidate.leaseEpoch) + 1n,
        lockedAt: now,
        heartbeatAt: now,
        lockedUntil,
        updatedAt: now,
      };
    });
  }

  async heartbeat(input: LeaseFence): Promise<FencedMutationResult> {
    assertLeaseFence(input);
    return runCheckedTransaction(this.pool, async (connection) => {
      const job = await lockJobOnly(connection, input);
      if (!job) return { affectedRows: 0 };
      const now = await readServerTime(connection);
      if (!isCurrentUnexpiredLease(job, input, now)) {
        return { affectedRows: 0 };
      }
      const lockedUntil = new Date(now.getTime() + LEASE_MILLISECONDS);
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE background_jobs SET heartbeat_at=?,locked_until=?,updated_at=?
         WHERE id=? AND family_id=? AND media_id=? AND generation=?
           AND state='RUNNING' AND worker_id=? AND lease_epoch=?
           AND locked_until>?`,
        [
          now,
          lockedUntil,
          now,
          input.jobId,
          input.familyId,
          input.mediaId,
          input.generation.toString(),
          input.workerId,
          input.leaseEpoch.toString(),
          now,
        ],
      );
      return affected(changed.affectedRows);
    });
  }

  async complete(input: LeaseFence): Promise<FencedMutationResult> {
    return this.finish(input, "SUCCEEDED", null);
  }

  async fail(
    input: LeaseFence & { failureCode: Phase4FailureCode },
  ): Promise<FencedMutationResult> {
    assertFailureCode(input.failureCode);
    return this.finish(input, "FAILED", input.failureCode);
  }

  async retry(
    input: LeaseFence & { failureCode: Phase4FailureCode },
  ): Promise<FencedMutationResult> {
    assertFailureCode(input.failureCode);
    assertLeaseFence(input);
    return runCheckedTransaction(this.pool, async (connection) => {
      const { media, job } = await lockMediaThenJob(connection, input);
      const now = await readServerTime(connection);
      if (
        !job ||
        !mediaMatchesFence(media, job, input) ||
        !isCurrentUnexpiredLease(job, input, now)
      ) {
        return { affectedRows: 0 };
      }
      const exhausted = job.attempts >= job.maxAttempts;
      const state = exhausted ? "FAILED" : "RETRY_WAIT";
      const availableAt = exhausted
        ? now
        : new Date(
            now.getTime() + retryDelayMilliseconds(job.attempts, this.random),
          );
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE background_jobs
         SET state=?,available_at=?,worker_id=NULL,locked_at=NULL,
             heartbeat_at=NULL,locked_until=NULL,last_failure_code=?,
             finished_at=?,updated_at=?
         WHERE id=? AND family_id=? AND media_id=? AND generation=?
           AND state='RUNNING' AND worker_id=? AND lease_epoch=?
           AND locked_until>? AND attempts=?`,
        [
          state,
          availableAt,
          input.failureCode,
          exhausted ? now : null,
          now,
          input.jobId,
          input.familyId,
          input.mediaId,
          input.generation.toString(),
          input.workerId,
          input.leaseEpoch.toString(),
          now,
          job.attempts,
        ],
      );
      return { ...affected(changed.affectedRows), state };
    });
  }

  async recoverExpiredLease(input: {
    familyId: string;
    mediaId: string;
    jobId: string;
    generation: bigint;
  }): Promise<FencedMutationResult> {
    assertFenceIds(input);
    return runCheckedTransaction(this.pool, async (connection) => {
      const [rows] = await connection.query<JobRow[]>(
        `${JOB_SELECT}
         WHERE id=? AND family_id=? AND media_id=? AND generation=?
         FOR UPDATE`,
        [
          input.jobId,
          input.familyId,
          input.mediaId,
          input.generation.toString(),
        ],
      );
      const job = rows[0];
      if (!job || job.state !== "RUNNING" || job.lockedUntil === null) {
        return { affectedRows: 0 };
      }
      const now = await readServerTime(connection);
      if (job.lockedUntil.getTime() > now.getTime()) {
        return { affectedRows: 0 };
      }
      const exhausted = job.attempts >= job.maxAttempts;
      const state = exhausted ? "FAILED" : "RETRY_WAIT";
      const availableAt = exhausted
        ? now
        : new Date(
            now.getTime() + retryDelayMilliseconds(job.attempts, this.random),
          );
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE background_jobs
         SET state=?,available_at=?,worker_id=NULL,locked_at=NULL,
             heartbeat_at=NULL,locked_until=NULL,last_failure_code='WORKER_LOST',
             finished_at=?,updated_at=?
         WHERE id=? AND family_id=? AND media_id=? AND generation=?
           AND state='RUNNING' AND lease_epoch=? AND locked_until<=?
           AND attempts=?`,
        [
          state,
          availableAt,
          exhausted ? now : null,
          now,
          input.jobId,
          input.familyId,
          input.mediaId,
          input.generation.toString(),
          job.leaseEpoch,
          now,
          job.attempts,
        ],
      );
      return { ...affected(changed.affectedRows), state };
    });
  }

  private async finish(
    input: LeaseFence,
    state: "SUCCEEDED" | "FAILED",
    failureCode: Phase4FailureCode | null,
  ): Promise<FencedMutationResult> {
    assertLeaseFence(input);
    return runCheckedTransaction(this.pool, async (connection) => {
      const { media, job } = await lockMediaThenJob(connection, input);
      const now = await readServerTime(connection);
      if (
        !job ||
        !mediaMatchesFence(media, job, input) ||
        !isCurrentUnexpiredLease(job, input, now)
      ) {
        return { affectedRows: 0 };
      }
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE background_jobs
         SET state=?,worker_id=NULL,locked_at=NULL,heartbeat_at=NULL,
             locked_until=NULL,last_failure_code=?,finished_at=?,updated_at=?
         WHERE id=? AND family_id=? AND media_id=? AND generation=?
           AND state='RUNNING' AND worker_id=? AND lease_epoch=?
           AND locked_until>?`,
        [
          state,
          failureCode,
          now,
          now,
          input.jobId,
          input.familyId,
          input.mediaId,
          input.generation.toString(),
          input.workerId,
          input.leaseEpoch.toString(),
          now,
        ],
      );
      return { ...affected(changed.affectedRows), state };
    });
  }
}

export type LeaseFence = {
  familyId: string;
  mediaId: string;
  jobId: string;
  generation: bigint;
  workerId: WorkerIdentity;
  leaseEpoch: bigint;
};

export function isJobIdentityDuplicate(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    errno?: number;
    message?: string;
    sqlMessage?: string;
  };
  if (
    candidate.code !== "ER_DUP_ENTRY" ||
    (candidate.errno !== undefined && candidate.errno !== 1062)
  ) {
    return false;
  }
  return `${candidate.sqlMessage ?? ""}\n${candidate.message ?? ""}`.includes(
    "uq_background_jobs_identity",
  );
}

async function lockFamily(connection: PoolConnection, familyId: string) {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT CAST(id AS CHAR) AS id FROM families WHERE id=? FOR SHARE",
    [familyId],
  );
  if (!rows[0]) throw new JobRepositoryError("NOT_FOUND");
}

async function lockMedia(
  connection: PoolConnection,
  familyId: string,
  mediaId: string,
) {
  const [rows] = await connection.query<MediaFenceRow[]>(
    `SELECT CAST(generation AS CHAR) AS generation,recipe_id AS recipeId
     FROM media_items WHERE id=? AND family_id=? FOR UPDATE`,
    [mediaId, familyId],
  );
  const media = rows[0];
  if (!media) throw new JobRepositoryError("NOT_FOUND");
  return media;
}

async function lockMediaThenJob(connection: PoolConnection, input: LeaseFence) {
  const [mediaRows] = await connection.query<MediaFenceRow[]>(
    `SELECT CAST(generation AS CHAR) AS generation,recipe_id AS recipeId
     FROM media_items WHERE id=? AND family_id=? FOR UPDATE`,
    [input.mediaId, input.familyId],
  );
  const [jobRows] = await connection.query<JobRow[]>(
    `${JOB_SELECT}
     WHERE id=? AND family_id=? AND media_id=? AND generation=? FOR UPDATE`,
    [input.jobId, input.familyId, input.mediaId, input.generation.toString()],
  );
  return { media: mediaRows[0], job: jobRows[0] };
}

async function lockJobOnly(connection: PoolConnection, input: LeaseFence) {
  const [rows] = await connection.query<JobRow[]>(
    `${JOB_SELECT}
     WHERE id=? AND family_id=? AND media_id=? AND generation=? FOR UPDATE`,
    [input.jobId, input.familyId, input.mediaId, input.generation.toString()],
  );
  return rows[0];
}

async function findIdentity(
  connection: PoolConnection,
  input: {
    familyId: string;
    mediaId: string;
    generation: bigint;
    recipeId: number;
    jobType: Phase4JobType;
  },
  locking: boolean,
) {
  const [rows] = await connection.query<JobRow[]>(
    `${JOB_SELECT}
     WHERE family_id=? AND media_id=? AND generation=?
       AND recipe_id=? AND job_type=?${locking ? " FOR SHARE" : ""}`,
    [
      input.familyId,
      input.mediaId,
      input.generation.toString(),
      input.recipeId,
      input.jobType,
    ],
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

function mapJob(row: JobRow): BackgroundJobRecord {
  return {
    id: row.id,
    familyId: row.familyId,
    mediaId: row.mediaId,
    generation: BigInt(row.generation),
    recipeId: Number(row.recipeId),
    jobType: row.jobType,
    state: row.state,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.maxAttempts),
    availableAt: row.availableAt,
    lockedAt: row.lockedAt,
    heartbeatAt: row.heartbeatAt,
    lockedUntil: row.lockedUntil,
    workerId: row.workerId ? Buffer.from(row.workerId) : null,
    leaseEpoch: BigInt(row.leaseEpoch),
    lastFailureCode: row.lastFailureCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

function isCurrentUnexpiredLease(job: JobRow, input: LeaseFence, now: Date) {
  return (
    job.state === "RUNNING" &&
    job.workerId?.equals(input.workerId) === true &&
    BigInt(job.leaseEpoch) === input.leaseEpoch &&
    BigInt(job.generation) === input.generation &&
    job.lockedUntil !== null &&
    job.lockedUntil.getTime() > now.getTime()
  );
}

function mediaMatchesFence(
  media: MediaFenceRow | undefined,
  job: JobRow,
  input: LeaseFence,
) {
  return (
    media !== undefined &&
    BigInt(media.generation) === input.generation &&
    BigInt(job.generation) === input.generation &&
    media.recipeId === job.recipeId
  );
}

export function phase4RetryDelayMilliseconds(
  attempts: number,
  random: () => number,
) {
  const range = RETRY_RANGES_SECONDS[attempts as 1 | 2];
  if (!range) throw new JobRepositoryError("CONFLICT");
  const seconds = Math.floor(range[0] + random() * (range[1] - range[0] + 1));
  return seconds * 1_000;
}

function retryDelayMilliseconds(attempts: number, random: () => number) {
  return phase4RetryDelayMilliseconds(attempts, random);
}

function affected(value: number): { affectedRows: 0 | 1 } {
  if (value === 0 || value === 1) return { affectedRows: value };
  throw new JobRepositoryError("CONFLICT");
}

function assertJobIdentity(input: {
  familyId: string;
  mediaId: string;
  generation: bigint;
  recipeId: number;
  jobType: Phase4JobType;
}) {
  assertFenceIds({ ...input, jobId: "1" });
  if (
    input.generation < 1n ||
    !Number.isSafeInteger(input.recipeId) ||
    input.recipeId < 1 ||
    !phase4JobTypes.includes(input.jobType)
  ) {
    throw new JobRepositoryError("INVALID_INPUT");
  }
}

function assertLeaseFence(input: LeaseFence) {
  assertFenceIds(input);
  assertWorkerId(input.workerId);
  if (input.generation < 1n || input.leaseEpoch < 1n) {
    throw new JobRepositoryError("INVALID_INPUT");
  }
}

function assertFenceIds(input: {
  familyId: string;
  mediaId: string;
  jobId: string;
  generation: bigint;
}) {
  for (const value of [input.familyId, input.mediaId, input.jobId]) {
    if (!/^[1-9][0-9]*$/u.test(value)) {
      throw new JobRepositoryError("INVALID_INPUT");
    }
  }
  if (input.generation < 1n) throw new JobRepositoryError("INVALID_INPUT");
}

function assertWorkerId(workerId: WorkerIdentity) {
  if (!Buffer.isBuffer(workerId) || workerId.byteLength !== 16) {
    throw new JobRepositoryError("INVALID_INPUT");
  }
}

function assertFailureCode(code: Phase4FailureCode) {
  if (!phase4FailureCodes.includes(code)) {
    throw new JobRepositoryError("INVALID_INPUT");
  }
}
