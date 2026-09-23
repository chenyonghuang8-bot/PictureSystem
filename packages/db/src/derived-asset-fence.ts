import type { Phase4FailureCode } from "@family-album/contracts";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import { acquireCheckedConnection, readServerTime } from "./connection.js";
import {
  phase4RetryDelayMilliseconds,
  type LeaseFence,
} from "./job-repository.js";
import { CommitOutcomeUnknownError, runTransaction } from "./transaction.js";

export type DerivedAssetSnapshot = {
  id: string;
  kind: "THUMBNAIL" | "PREVIEW";
  state: string;
  sha256Hex: string | null;
  byteSize: string | null;
  producerLeaseEpoch: bigint | null;
};

export type DerivedFenceView = {
  sha256Hex: string;
  byteSize: string;
  recipeId: number;
  assets: DerivedAssetSnapshot[];
};

export type DerivedPublishingPayload = {
  kind: "THUMBNAIL" | "PREVIEW";
  reservationId: string;
  sha256Hex: string;
  byteSize: bigint;
  width: number;
  height: number;
};

export type DerivedFenceOutcome = "COMMITTED" | "ALREADY" | "STALE" | "UNKNOWN";

export type ReadyFinalEvidence = {
  kind: "THUMBNAIL" | "PREVIEW";
  sha256Hex: string;
  byteSize: bigint;
  device: string;
  inode: string;
};

class ReadyFenceLost extends Error {
  constructor() {
    super("READY_FENCE_LOST");
    this.name = "ReadyFenceLost";
  }
}

type AssetRow = RowDataPacket & {
  id: string;
  kind: "THUMBNAIL" | "PREVIEW";
  state: string;
  sha256Hex: string | null;
  byteSize: string | null;
  producerLeaseEpoch: string | null;
};

type FenceContext = {
  recipeId: number;
  mediaGeneration: string;
  jobType: string;
  jobState: string;
  jobGeneration: string;
  workerId: Buffer | null;
  leaseEpoch: string;
  lockedUntil: Date | null;
  storageState: string;
  sha256: Buffer;
  byteSize: string;
  now: Date;
};

function canonical(value: string) {
  return /^[1-9][0-9]*$/u.test(value);
}

function leaseHolds(context: FenceContext, fence: LeaseFence) {
  return (
    context.jobType === "IMAGE_DERIVATIVES" &&
    context.jobState === "RUNNING" &&
    context.mediaGeneration === fence.generation.toString() &&
    context.jobGeneration === fence.generation.toString() &&
    context.recipeId === 1 &&
    context.storageState === "AVAILABLE" &&
    context.workerId?.equals(fence.workerId) === true &&
    context.leaseEpoch === fence.leaseEpoch.toString() &&
    context.lockedUntil instanceof Date &&
    context.lockedUntil.getTime() > context.now.getTime()
  );
}

async function lockFence(
  connection: PoolConnection,
  fence: LeaseFence,
): Promise<FenceContext | null> {
  const [families] = await connection.query<RowDataPacket[]>(
    "SELECT CAST(id AS CHAR) AS id FROM families WHERE id=? FOR SHARE",
    [fence.familyId],
  );
  if (!families[0]) return null;
  const [locator] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(storage_object_id AS CHAR) AS storageObjectId
     FROM media_items WHERE id=? AND family_id=?`,
    [fence.mediaId, fence.familyId],
  );
  const storageObjectId = locator[0]?.storageObjectId;
  if (typeof storageObjectId !== "string") return null;
  const [storageRows] = await connection.query<RowDataPacket[]>(
    `SELECT state, sha256, CAST(byte_size AS CHAR) AS byteSize
     FROM storage_objects WHERE id=? AND family_id=? FOR SHARE`,
    [storageObjectId, fence.familyId],
  );
  const storage = storageRows[0];
  if (!storage || !Buffer.isBuffer(storage.sha256)) return null;
  const [mediaRows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(generation AS CHAR) AS generation, recipe_id AS recipeId
     FROM media_items WHERE id=? AND family_id=? FOR UPDATE`,
    [fence.mediaId, fence.familyId],
  );
  const media = mediaRows[0];
  const [jobRows] = await connection.query<RowDataPacket[]>(
    `SELECT job_type AS jobType, state,
       CAST(generation AS CHAR) AS generation, worker_id AS workerId,
       CAST(lease_epoch AS CHAR) AS leaseEpoch, locked_until AS lockedUntil
     FROM background_jobs
     WHERE id=? AND family_id=? AND media_id=? AND generation=?
     FOR UPDATE`,
    [fence.jobId, fence.familyId, fence.mediaId, fence.generation.toString()],
  );
  const job = jobRows[0];
  if (!media || !job) return null;
  return {
    recipeId: Number(media.recipeId),
    mediaGeneration: String(media.generation),
    jobType: String(job.jobType),
    jobState: String(job.state),
    jobGeneration: String(job.generation),
    workerId: Buffer.isBuffer(job.workerId) ? job.workerId : null,
    leaseEpoch: String(job.leaseEpoch),
    lockedUntil: job.lockedUntil instanceof Date ? job.lockedUntil : null,
    storageState: String(storage.state),
    sha256: storage.sha256 as Buffer,
    byteSize: String(storage.byteSize),
    now: await readServerTime(connection),
  };
}

async function readAssets(connection: PoolConnection, fence: LeaseFence) {
  const [rows] = await connection.query<AssetRow[]>(
    `SELECT CAST(id AS CHAR) AS id, kind, state,
       LOWER(HEX(sha256)) AS sha256Hex,
       CAST(byte_size AS CHAR) AS byteSize,
       CAST(producer_lease_epoch AS CHAR) AS producerLeaseEpoch
     FROM derived_assets
     WHERE family_id=? AND media_id=? AND generation=? AND recipe_id=1
     ORDER BY kind
     FOR UPDATE`,
    [fence.familyId, fence.mediaId, fence.generation.toString()],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    state: row.state,
    sha256Hex: row.sha256Hex,
    byteSize: row.byteSize,
    producerLeaseEpoch:
      row.producerLeaseEpoch === null ? null : BigInt(row.producerLeaseEpoch),
  }));
}

/**
 * Fenced derived-asset transitions for an already claimed image job.
 * PUBLISHING is evidence. READY, media state, and job completion share one
 * later transaction and are never inferred from a pathname.
 */
export class MySqlDerivedAssetFence {
  constructor(private readonly pool: Pool) {}

  async describe(
    fence: LeaseFence,
  ): Promise<DerivedFenceView | null | "UNKNOWN"> {
    return this.transact(async (connection) => {
      const context = await lockFence(connection, fence);
      if (!context || !leaseHolds(context, fence)) return null;
      return {
        sha256Hex: context.sha256.toString("hex"),
        byteSize: context.byteSize,
        recipeId: context.recipeId,
        assets: await readAssets(connection, fence),
      };
    });
  }

  async adoptReserved(
    fence: LeaseFence,
    kind: "THUMBNAIL" | "PREVIEW",
  ): Promise<DerivedFenceOutcome> {
    return this.transact(async (connection) => {
      const context = await lockFence(connection, fence);
      if (!context || !leaseHolds(context, fence)) return "STALE";
      const assets = await readAssets(connection, fence);
      const asset = assets.find((item) => item.kind === kind);
      if (!asset) return "COMMITTED";
      if (
        asset.producerLeaseEpoch === fence.leaseEpoch &&
        asset.state === "RESERVED"
      ) {
        return "ALREADY";
      }
      if (asset.state !== "RESERVED" || asset.sha256Hex !== null)
        return "STALE";
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE derived_assets
         SET producer_lease_epoch=?, updated_at=?
         WHERE id=? AND family_id=? AND media_id=? AND generation=?
           AND recipe_id=1 AND kind=? AND state='RESERVED'
           AND cleaned_at IS NULL AND sha256 IS NULL AND byte_size IS NULL
           AND producer_job_id=?`,
        [
          fence.leaseEpoch.toString(),
          context.now,
          asset.id,
          fence.familyId,
          fence.mediaId,
          fence.generation.toString(),
          kind,
          fence.jobId,
        ],
      );
      return changed.affectedRows === 1 ? "COMMITTED" : "STALE";
    });
  }

  async markPublishing(
    fence: LeaseFence,
    payload: DerivedPublishingPayload,
    options: { commit?: (connection: PoolConnection) => Promise<void> } = {},
  ): Promise<DerivedFenceOutcome> {
    if (!validPayload(payload)) return "STALE";
    return this.transact(async (connection) => {
      const context = await lockFence(connection, fence);
      if (!context || !leaseHolds(context, fence)) return "STALE";
      const [rows] = await connection.query<AssetRow[]>(
        `SELECT CAST(id AS CHAR) AS id, kind, state,
           LOWER(HEX(sha256)) AS sha256Hex,
           CAST(producer_lease_epoch AS CHAR) AS producerLeaseEpoch
         FROM derived_assets
         WHERE id=? AND family_id=? AND media_id=? AND generation=?
           AND recipe_id=1 AND kind=?
         FOR UPDATE`,
        [
          payload.reservationId,
          fence.familyId,
          fence.mediaId,
          fence.generation.toString(),
          payload.kind,
        ],
      );
      const asset = rows[0];
      if (!asset || asset.producerLeaseEpoch !== fence.leaseEpoch.toString()) {
        return "STALE";
      }
      if (
        asset.state === "PUBLISHING" &&
        asset.sha256Hex === payload.sha256Hex
      ) {
        return "ALREADY";
      }
      if (asset.state !== "RESERVED" || asset.sha256Hex !== null)
        return "STALE";
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE derived_assets
         SET state='PUBLISHING', byte_size=?, sha256=UNHEX(?), width=?, height=?,
             output_mime='image/webp', updated_at=?
         WHERE id=? AND family_id=? AND media_id=? AND generation=?
           AND recipe_id=1 AND kind=? AND state='RESERVED'
           AND cleaned_at IS NULL AND producer_job_id=?
           AND producer_lease_epoch=? AND byte_size IS NULL AND sha256 IS NULL`,
        [
          payload.byteSize.toString(),
          payload.sha256Hex,
          payload.width,
          payload.height,
          context.now,
          payload.reservationId,
          fence.familyId,
          fence.mediaId,
          fence.generation.toString(),
          payload.kind,
          fence.jobId,
          fence.leaseEpoch.toString(),
        ],
      );
      if (changed.affectedRows !== 1) return "STALE";
      return "COMMITTED";
    }, options.commit);
  }

  async confirmPublishing(
    fence: LeaseFence,
    payload: Pick<
      DerivedPublishingPayload,
      "kind" | "reservationId" | "sha256Hex"
    >,
  ): Promise<DerivedFenceOutcome> {
    return this.transact(async (connection) => {
      const context = await lockFence(connection, fence);
      if (!context || !leaseHolds(context, fence)) return "STALE";
      const assets = await readAssets(connection, fence);
      const asset = assets.find(
        (item) =>
          item.id === payload.reservationId && item.kind === payload.kind,
      );
      if (
        !asset ||
        asset.state !== "PUBLISHING" ||
        asset.sha256Hex !== payload.sha256Hex ||
        asset.producerLeaseEpoch !== fence.leaseEpoch
      ) {
        return "STALE";
      }
      return "COMMITTED";
    });
  }

  /**
   * One transaction: both required finals become READY, media becomes READY,
   * and the job becomes SUCCEEDED. A failed check writes nothing.
   */
  async commitSucceeded(
    fence: LeaseFence,
    evidence: readonly ReadyFinalEvidence[],
    options: { commit?: (connection: PoolConnection) => Promise<void> } = {},
  ): Promise<DerivedFenceOutcome> {
    if (!readyEvidence(evidence, ["THUMBNAIL", "PREVIEW"])) return "STALE";
    return this.transactReady(async (connection) => {
      const context = await lockFence(connection, fence);
      if (!context || !leaseHolds(context, fence)) return "STALE";
      const metadataGeneration = await readMetadataGeneration(
        connection,
        fence,
      );
      if (metadataGeneration !== fence.generation.toString()) return "STALE";
      const assets = await lockDerivedAssets(connection, fence);
      for (const item of evidence) {
        await markAssetReady(connection, fence, context.now, assets, item);
      }
      await markMedia(connection, fence, context.now, "READY", null);
      await finishJob(connection, fence, context.now, {
        state: "SUCCEEDED",
        failureCode: null,
        availableAt: null,
        attempts: null,
      });
      return "COMMITTED";
    }, options.commit);
  }

  /**
   * One transaction for a retry or permanent failure. A verified final may
   * become READY in the same transaction. The job never becomes SUCCEEDED.
   */
  async commitAttempt(
    fence: LeaseFence,
    input: {
      failureCode: Phase4FailureCode;
      disposition: "RETRY" | "FAIL";
      ready: readonly ReadyFinalEvidence[];
    },
    options: { commit?: (connection: PoolConnection) => Promise<void> } = {},
  ): Promise<
    | "STALE"
    | "UNKNOWN"
    | { outcome: "COMMITTED"; jobState: "FAILED" | "RETRY_WAIT" }
  > {
    if (!readyEvidence(input.ready)) return "STALE";
    return this.transactReady(async (connection) => {
      const context = await lockFence(connection, fence);
      if (!context || !leaseHolds(context, fence)) return "STALE";
      const [attemptRows] = await connection.query<RowDataPacket[]>(
        `SELECT attempts, max_attempts AS maxAttempts
         FROM background_jobs
         WHERE id=? AND family_id=? AND media_id=? AND generation=?`,
        [
          fence.jobId,
          fence.familyId,
          fence.mediaId,
          fence.generation.toString(),
        ],
      );
      const attempts = Number(attemptRows[0]?.attempts);
      const maxAttempts = Number(attemptRows[0]?.maxAttempts);
      if (!Number.isInteger(attempts) || !Number.isInteger(maxAttempts)) {
        return "STALE";
      }
      const exhausted = attempts >= maxAttempts;
      const mediaState = imageDerivativeMediaState(
        input.failureCode,
        input.disposition,
        exhausted,
      );
      const assets = await lockDerivedAssets(connection, fence);
      for (const item of input.ready) {
        await markAssetReady(connection, fence, context.now, assets, item);
      }
      await markMedia(
        connection,
        fence,
        context.now,
        mediaState,
        mediaState === "PENDING" ? null : input.failureCode,
      );
      const jobState =
        input.disposition === "FAIL" || exhausted ? "FAILED" : "RETRY_WAIT";
      if (jobState === "FAILED") {
        await finishJob(connection, fence, context.now, {
          state: "FAILED",
          failureCode: input.failureCode,
          availableAt: null,
          attempts,
        });
      } else {
        await finishJob(connection, fence, context.now, {
          state: "RETRY_WAIT",
          failureCode: input.failureCode,
          availableAt: new Date(
            context.now.getTime() +
              phase4RetryDelayMilliseconds(attempts, Math.random),
          ),
          attempts,
        });
      }
      return { outcome: "COMMITTED", jobState };
    }, options.commit);
  }

  async readSucceeded(fence: LeaseFence): Promise<boolean> {
    const seen = await runTransaction(
      this.pool,
      async (connection) => {
        const context = await lockFence(connection, fence);
        if (!context) return false;
        const [jobs] = await connection.query<RowDataPacket[]>(
          `SELECT state FROM background_jobs
         WHERE id=? AND family_id=? AND media_id=? AND generation=?`,
          [
            fence.jobId,
            fence.familyId,
            fence.mediaId,
            fence.generation.toString(),
          ],
        );
        const [media] = await connection.query<RowDataPacket[]>(
          `SELECT processing_state AS processingState
         FROM media_items WHERE id=? AND family_id=? AND generation=?`,
          [fence.mediaId, fence.familyId, fence.generation.toString()],
        );
        const assets = await lockDerivedAssets(connection, fence);
        return (
          jobs[0]?.state === "SUCCEEDED" &&
          media[0]?.processingState === "READY" &&
          assets.filter((asset) => asset.state === "READY").length === 2
        );
      },
      { acquire: () => acquireCheckedConnection(this.pool) },
    );
    return seen;
  }

  private async transact<T>(
    operation: (connection: PoolConnection) => Promise<T>,
    commit?: (connection: PoolConnection) => Promise<void>,
  ): Promise<T | "UNKNOWN"> {
    try {
      return await runTransaction(this.pool, operation, {
        acquire: () => acquireCheckedConnection(this.pool),
        ...(commit === undefined ? {} : { commit }),
      });
    } catch (error) {
      if (error instanceof CommitOutcomeUnknownError) return "UNKNOWN";
      throw error;
    }
  }

  private async transactReady<T>(
    operation: (connection: PoolConnection) => Promise<T>,
    commit?: (connection: PoolConnection) => Promise<void>,
  ): Promise<T | "UNKNOWN" | "STALE"> {
    try {
      return await this.transact(operation, commit);
    } catch (error) {
      if (error instanceof ReadyFenceLost) return "STALE";
      throw error;
    }
  }
}

export function imageDerivativeMediaState(
  code: Phase4FailureCode,
  disposition: "RETRY" | "FAIL",
  exhausted: boolean,
): "PENDING" | "PARTIAL" | "BLOCKED" {
  if (disposition === "RETRY" && !exhausted) return "PENDING";
  if (
    code === "ORIGINAL_MISSING" ||
    code === "ORIGINAL_CORRUPT" ||
    code === "STORAGE_UNAVAILABLE"
  ) {
    return "BLOCKED";
  }
  return "PARTIAL";
}

function readyEvidence(
  evidence: readonly ReadyFinalEvidence[],
  required?: readonly ("THUMBNAIL" | "PREVIEW")[],
) {
  const kinds = new Set(evidence.map((item) => item.kind));
  if (required && required.some((kind) => !kinds.has(kind))) return false;
  if (kinds.size !== evidence.length) return false;
  return evidence.every(
    (item) =>
      (item.kind === "THUMBNAIL" || item.kind === "PREVIEW") &&
      /^[0-9a-f]{64}$/u.test(item.sha256Hex) &&
      item.byteSize > 0n &&
      canonical(item.device) &&
      canonical(item.inode),
  );
}

async function readMetadataGeneration(
  connection: PoolConnection,
  fence: LeaseFence,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(metadata_generation AS CHAR) AS metadataGeneration
     FROM media_items WHERE id=? AND family_id=?`,
    [fence.mediaId, fence.familyId],
  );
  const value = rows[0]?.metadataGeneration;
  return typeof value === "string" ? value : null;
}

async function lockDerivedAssets(
  connection: PoolConnection,
  fence: LeaseFence,
) {
  const [rows] = await connection.query<AssetRow[]>(
    `SELECT CAST(id AS CHAR) AS id, kind, state,
       LOWER(HEX(sha256)) AS sha256Hex,
       CAST(byte_size AS CHAR) AS byteSize,
       CAST(producer_lease_epoch AS CHAR) AS producerLeaseEpoch
     FROM derived_assets
     WHERE family_id=? AND media_id=? AND generation=? AND recipe_id=1
     ORDER BY id
     FOR UPDATE`,
    [fence.familyId, fence.mediaId, fence.generation.toString()],
  );
  return rows;
}

async function markAssetReady(
  connection: PoolConnection,
  fence: LeaseFence,
  now: Date,
  assets: readonly AssetRow[],
  item: ReadyFinalEvidence,
) {
  const asset = assets.find((row) => row.kind === item.kind);
  if (
    !asset ||
    asset.sha256Hex !== item.sha256Hex ||
    asset.byteSize !== item.byteSize.toString()
  ) {
    throw new ReadyFenceLost();
  }
  if (asset.state === "READY") return;
  if (asset.state !== "PUBLISHING") throw new ReadyFenceLost();
  const [changed] = await connection.execute<ResultSetHeader>(
    `UPDATE derived_assets
     SET state='READY', published_at=?, producer_lease_epoch=?, updated_at=?
     WHERE id=? AND family_id=? AND media_id=? AND generation=?
       AND recipe_id=1 AND kind=? AND state='PUBLISHING'
       AND cleaned_at IS NULL AND published_at IS NULL
       AND output_mime='image/webp' AND byte_size=? AND sha256=UNHEX(?)
       AND producer_job_id=?`,
    [
      now,
      fence.leaseEpoch.toString(),
      now,
      asset.id,
      fence.familyId,
      fence.mediaId,
      fence.generation.toString(),
      item.kind,
      item.byteSize.toString(),
      item.sha256Hex,
      fence.jobId,
    ],
  );
  if (changed.affectedRows !== 1) throw new ReadyFenceLost();
}

async function markMedia(
  connection: PoolConnection,
  fence: LeaseFence,
  now: Date,
  state: "PENDING" | "READY" | "PARTIAL" | "BLOCKED",
  failureCode: Phase4FailureCode | null,
) {
  const [changed] = await connection.execute<ResultSetHeader>(
    `UPDATE media_items
     SET processing_state=?, last_failure_code=?, updated_at=?
     WHERE id=? AND family_id=? AND generation=? AND recipe_id=1
       ${state === "READY" ? "AND metadata_generation=?" : ""}`,
    [
      state,
      failureCode,
      now,
      fence.mediaId,
      fence.familyId,
      fence.generation.toString(),
      ...(state === "READY" ? [fence.generation.toString()] : []),
    ],
  );
  if (changed.affectedRows !== 1) throw new ReadyFenceLost();
}

async function finishJob(
  connection: PoolConnection,
  fence: LeaseFence,
  now: Date,
  input: {
    state: "SUCCEEDED" | "FAILED" | "RETRY_WAIT";
    failureCode: Phase4FailureCode | null;
    availableAt: Date | null;
    attempts: number | null;
  },
) {
  const terminal = input.state === "SUCCEEDED" || input.state === "FAILED";
  const [changed] = await connection.execute<ResultSetHeader>(
    `UPDATE background_jobs
     SET state=?, available_at=?, worker_id=NULL, locked_at=NULL,
         heartbeat_at=NULL, locked_until=NULL, last_failure_code=?,
         finished_at=?, updated_at=?
     WHERE id=? AND family_id=? AND media_id=? AND generation=?
       AND state='RUNNING' AND worker_id=? AND lease_epoch=?
       AND locked_until>?${input.attempts === null ? "" : " AND attempts=?"}`,
    [
      input.state,
      input.availableAt ?? now,
      input.failureCode,
      terminal ? now : null,
      now,
      fence.jobId,
      fence.familyId,
      fence.mediaId,
      fence.generation.toString(),
      fence.workerId,
      fence.leaseEpoch.toString(),
      now,
      ...(input.attempts === null ? [] : [input.attempts]),
    ],
  );
  if (changed.affectedRows !== 1) throw new ReadyFenceLost();
}

function validPayload(payload: DerivedPublishingPayload) {
  return (
    (payload.kind === "THUMBNAIL" || payload.kind === "PREVIEW") &&
    canonical(payload.reservationId) &&
    /^[0-9a-f]{64}$/u.test(payload.sha256Hex) &&
    payload.byteSize > 0n &&
    Number.isSafeInteger(payload.width) &&
    Number.isSafeInteger(payload.height) &&
    payload.width > 0 &&
    payload.height > 0 &&
    payload.width <= (payload.kind === "THUMBNAIL" ? 480 : 2560) &&
    payload.height <= (payload.kind === "THUMBNAIL" ? 480 : 2560)
  );
}

export function derivativeFailureDisposition(
  code: Phase4FailureCode,
): "FAIL" | "RETRY" | "STOP" {
  switch (code) {
    case "PROCESS_TIMEOUT":
    case "RESOURCE_LIMIT":
    case "TEMPORARY_IO":
    case "DB_UNAVAILABLE":
      return "RETRY";
    case "COMMIT_OUTCOME_UNKNOWN":
    case "WORKER_LOST":
      return "STOP";
    case "UNSUPPORTED_FORMAT":
    case "CAPABILITY_UNAVAILABLE":
    case "MALFORMED_MEDIA":
    case "INPUT_LIMIT":
    case "OUTPUT_LIMIT":
    case "ORIGINAL_MISSING":
    case "ORIGINAL_CORRUPT":
    case "DERIVED_INTEGRITY":
    case "STORAGE_UNAVAILABLE":
      return "FAIL";
    default:
      return "FAIL";
  }
}
