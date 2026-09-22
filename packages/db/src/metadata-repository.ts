import type {
  Phase4FailureCode,
  Phase4JobState,
  Phase4JobType,
  Phase4MediaType,
  Phase4ProcessingState,
} from "@family-album/contracts";
import { phase4WarningFlags } from "@family-album/contracts";
import type { NormalizedMetadataResult } from "@family-album/media";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import { readServerTime, runCheckedTransaction } from "./connection.js";
import type { LeaseFence } from "./job-repository.js";
import { isJobIdentityDuplicate } from "./job-repository.js";

const RETRY_RANGES_SECONDS = {
  1: [30, 45],
  2: [120, 150],
} as const;

export type MetadataPreparation = Readonly<{
  familyId: string;
  mediaId: string;
  storageObjectId: string;
  generation: bigint;
  recipeId: number;
  sha256Hex: string;
  byteSize: string;
  keyVersion: number;
  captureUpperBoundUtc: string;
}>;

export type MetadataCommitResult = Readonly<{
  affectedRows: 0 | 1;
  mediaState?: Phase4ProcessingState;
  jobState?: Extract<Phase4JobState, "SUCCEEDED" | "FAILED" | "RETRY_WAIT">;
  downstreamJobType?: Extract<
    Phase4JobType,
    "IMAGE_DERIVATIVES" | "VIDEO_POSTER"
  >;
}>;

export type MetadataOperationalFailure =
  "TIMEOUT" | "PARSER_FAILED" | "CAPABILITY_DISABLED";

export class MetadataRepositoryError extends Error {
  constructor(readonly reason: "INVALID_INPUT" | "CONFLICT") {
    super(reason);
    this.name = "MetadataRepositoryError";
  }
}

type StorageRow = RowDataPacket & {
  id: string;
  familyId: string;
  sha256: Buffer;
  byteSize: string;
  keyVersion: number;
  state: "AVAILABLE" | "MISSING" | "CORRUPT";
};

type MediaRow = RowDataPacket & {
  id: string;
  familyId: string;
  storageObjectId: string;
  sourceUploadId: string;
  uploadedAt: Date;
  generation: string;
  recipeId: number;
};

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
  workerId: Buffer | null;
  leaseEpoch: string;
  lockedUntil: Date | null;
};

type LockedContext = Readonly<{
  storage: StorageRow;
  media: MediaRow;
  job: JobRow;
  now: Date;
}>;

type Snapshot = Readonly<{
  mediaType: Phase4MediaType;
  detectedMime: string | null;
  metadataGeneration: string | null;
  rawWidth: number | null;
  rawHeight: number | null;
  displayWidth: number | null;
  displayHeight: number | null;
  durationMs: string | null;
  orientation: number | null;
  videoRotationDegrees: number | null;
  isAnimated: boolean;
  capturedLocalAt: string | null;
  capturedAtUtc: string | null;
  capturedOffsetMinutes: number | null;
  capturedSource: "NONE" | "EXIF_ORIGINAL" | "EXIF_CREATE";
  capturedTimeStatus: "ABSENT" | "OFFSET_KNOWN" | "OFFSET_UNKNOWN";
  timelineKey: Date | string;
  timelineBasis: "CAPTURE_LOCAL" | "UPLOAD_UTC";
  gpsLatitude: string | null;
  gpsLongitude: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  videoCodec: string | null;
  videoContainer: string | null;
  warningFlags: bigint;
}>;

export class MySqlMetadataRepository {
  private readonly random: () => number;

  constructor(
    private readonly pool: Pool,
    options: { random?: () => number } = {},
  ) {
    this.random = options.random ?? Math.random;
  }

  async prepare(fence: LeaseFence): Promise<MetadataPreparation | null> {
    assertFence(fence);
    return runCheckedTransaction(this.pool, async (connection) => {
      const context = await lockContext(connection, fence);
      if (!isCurrentProbeLease(context, fence)) return null;
      return {
        familyId: context.media.familyId,
        mediaId: context.media.id,
        storageObjectId: context.storage.id,
        generation: BigInt(context.media.generation),
        recipeId: context.media.recipeId,
        sha256Hex: context.storage.sha256.toString("hex"),
        byteSize: context.storage.byteSize,
        keyVersion: context.storage.keyVersion,
        captureUpperBoundUtc: context.media.uploadedAt.toISOString(),
      };
    });
  }

  async persistResult(
    fence: LeaseFence,
    preparation: MetadataPreparation,
    result: NormalizedMetadataResult,
  ): Promise<MetadataCommitResult> {
    assertFence(fence);
    assertPreparation(fence, preparation);
    const mapped = mapParserResult(result, fence.generation);
    return runCheckedTransaction(this.pool, async (connection) => {
      const context = await lockContext(connection, fence);
      if (!isCurrentProbeLease(context, fence, preparation)) {
        return { affectedRows: 0 };
      }

      const mediaState = mapped.mediaState;
      await replaceMetadataSnapshot(
        connection,
        context,
        fence,
        mapped.snapshot,
        mediaState,
        mapped.failureCode,
      );

      let downstreamJobType: "IMAGE_DERIVATIVES" | "VIDEO_POSTER" | undefined;
      if (
        mapped.jobState === "SUCCEEDED" &&
        result.parserStatus === "SUCCESS"
      ) {
        downstreamJobType = downstreamType(result.detectedMediaType);
        await enqueueDownstream(connection, context, fence, downstreamJobType);
      }

      await finishProbeJob(
        connection,
        context,
        fence,
        mapped.jobState,
        mapped.failureCode,
      );
      return {
        affectedRows: 1,
        mediaState,
        jobState: mapped.jobState,
        ...(downstreamJobType === undefined ? {} : { downstreamJobType }),
      };
    });
  }

  async persistOperationalFailure(
    fence: LeaseFence,
    preparation: MetadataPreparation,
    failure: MetadataOperationalFailure,
  ): Promise<MetadataCommitResult> {
    assertFence(fence);
    assertPreparation(fence, preparation);
    return runCheckedTransaction(this.pool, async (connection) => {
      const context = await lockContext(connection, fence);
      if (!isCurrentProbeLease(context, fence, preparation)) {
        return { affectedRows: 0 };
      }

      const failureCode = operationalFailureCode(failure);
      if (failure === "CAPABILITY_DISABLED") {
        const snapshot = emptySnapshot(context.media.uploadedAt);
        await replaceMetadataSnapshot(
          connection,
          context,
          fence,
          snapshot,
          "FAILED",
          failureCode,
        );
        await finishProbeJob(connection, context, fence, "FAILED", failureCode);
        return { affectedRows: 1, mediaState: "FAILED", jobState: "FAILED" };
      }

      const exhausted = context.job.attempts >= context.job.maxAttempts;
      const jobState = exhausted ? "FAILED" : "RETRY_WAIT";
      const mediaState = exhausted ? "FAILED" : "PENDING";
      await setMediaFailureState(
        connection,
        context,
        fence,
        mediaState,
        failureCode,
      );
      await retryProbeJob(
        connection,
        context,
        fence,
        jobState,
        failureCode,
        this.random,
      );
      return { affectedRows: 1, mediaState, jobState };
    });
  }
}

async function lockContext(
  connection: PoolConnection,
  fence: LeaseFence,
): Promise<LockedContext> {
  const [families] = await connection.query<RowDataPacket[]>(
    "SELECT CAST(id AS CHAR) AS id FROM families WHERE id=? FOR SHARE",
    [fence.familyId],
  );
  if (!families[0]) throw new MetadataRepositoryError("CONFLICT");

  const [locatorRows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(storage_object_id AS CHAR) AS storageObjectId
     FROM media_items WHERE id=? AND family_id=?`,
    [fence.mediaId, fence.familyId],
  );
  const storageObjectId = locatorRows[0]?.storageObjectId;
  if (typeof storageObjectId !== "string") {
    throw new MetadataRepositoryError("CONFLICT");
  }

  const [storageRows] = await connection.query<StorageRow[]>(
    `SELECT CAST(id AS CHAR) AS id,CAST(family_id AS CHAR) AS familyId,
      sha256,CAST(byte_size AS CHAR) AS byteSize,key_version AS keyVersion,state
     FROM storage_objects WHERE id=? AND family_id=? FOR SHARE`,
    [storageObjectId, fence.familyId],
  );
  const storage = storageRows[0];
  if (!storage) throw new MetadataRepositoryError("CONFLICT");

  const [mediaRows] = await connection.query<MediaRow[]>(
    `SELECT CAST(id AS CHAR) AS id,CAST(family_id AS CHAR) AS familyId,
      CAST(storage_object_id AS CHAR) AS storageObjectId,
      CAST(source_upload_id AS CHAR) AS sourceUploadId,uploaded_at AS uploadedAt,
      CAST(generation AS CHAR) AS generation,recipe_id AS recipeId
     FROM media_items WHERE id=? AND family_id=? FOR UPDATE`,
    [fence.mediaId, fence.familyId],
  );
  const media = mediaRows[0];
  if (!media || media.storageObjectId !== storage.id) {
    throw new MetadataRepositoryError("CONFLICT");
  }

  const [jobRows] = await connection.query<JobRow[]>(
    `SELECT CAST(id AS CHAR) AS id,CAST(family_id AS CHAR) AS familyId,
      CAST(media_id AS CHAR) AS mediaId,CAST(generation AS CHAR) AS generation,
      recipe_id AS recipeId,job_type AS jobType,state,attempts,
      max_attempts AS maxAttempts,worker_id AS workerId,
      CAST(lease_epoch AS CHAR) AS leaseEpoch,locked_until AS lockedUntil
     FROM background_jobs
     WHERE id=? AND family_id=? AND media_id=? AND generation=? FOR UPDATE`,
    [fence.jobId, fence.familyId, fence.mediaId, fence.generation.toString()],
  );
  const job = jobRows[0];
  if (!job) throw new MetadataRepositoryError("CONFLICT");
  const now = await readServerTime(connection);
  return { storage, media, job, now };
}

function isCurrentProbeLease(
  context: LockedContext,
  fence: LeaseFence,
  preparation?: MetadataPreparation,
) {
  return (
    context.storage.state === "AVAILABLE" &&
    context.storage.familyId === fence.familyId &&
    (preparation === undefined ||
      (context.storage.id === preparation.storageObjectId &&
        context.storage.sha256.toString("hex") === preparation.sha256Hex &&
        context.storage.byteSize === preparation.byteSize &&
        context.storage.keyVersion === preparation.keyVersion)) &&
    context.storage.keyVersion === 1 &&
    context.media.familyId === fence.familyId &&
    (preparation === undefined || context.media.id === preparation.mediaId) &&
    BigInt(context.media.generation) === fence.generation &&
    (preparation === undefined ||
      context.media.recipeId === preparation.recipeId) &&
    context.job.familyId === fence.familyId &&
    context.job.mediaId === fence.mediaId &&
    BigInt(context.job.generation) === fence.generation &&
    context.job.recipeId === context.media.recipeId &&
    context.job.jobType === "MEDIA_PROBE" &&
    context.job.state === "RUNNING" &&
    context.job.workerId?.equals(fence.workerId) === true &&
    BigInt(context.job.leaseEpoch) === fence.leaseEpoch &&
    context.job.lockedUntil !== null &&
    context.job.lockedUntil.getTime() > context.now.getTime()
  );
}

function mapParserResult(result: NormalizedMetadataResult, generation: bigint) {
  validateResult(result);
  const snapshot = metadataSnapshot(result, generation);
  switch (result.parserStatus) {
    case "SUCCESS":
      return {
        snapshot,
        mediaState: "PENDING" as const,
        jobState: "SUCCEEDED" as const,
        failureCode: null,
      };
    case "PARTIAL":
      return {
        snapshot,
        mediaState: "PARTIAL" as const,
        jobState: "SUCCEEDED" as const,
        failureCode: null,
      };
    case "UNSUPPORTED":
      return {
        snapshot: withWarning(snapshot, phase4WarningFlags.UNSUPPORTED_DECODER),
        mediaState: "PARTIAL" as const,
        jobState: "FAILED" as const,
        failureCode: "UNSUPPORTED_FORMAT" as const,
      };
    case "INVALID_MEDIA":
      return {
        snapshot: emptySnapshot(snapshot.timelineKey as Date),
        mediaState: "FAILED" as const,
        jobState: "FAILED" as const,
        failureCode: "MALFORMED_MEDIA" as const,
      };
    case "RESOURCE_LIMIT":
      return {
        snapshot,
        mediaState: "PARTIAL" as const,
        jobState: "FAILED" as const,
        failureCode: "RESOURCE_LIMIT" as const,
      };
  }
}

function metadataSnapshot(
  result: NormalizedMetadataResult,
  generation: bigint,
): Snapshot {
  const warningFlags = result.warnings.reduce(
    (flags, warning) => flags | phase4WarningFlags[warning],
    0n,
  );
  return {
    mediaType: result.detectedMediaType,
    detectedMime: result.detectedMime,
    metadataGeneration: generation.toString(),
    rawWidth: result.rawWidth,
    rawHeight: result.rawHeight,
    displayWidth: result.displayWidth,
    displayHeight: result.displayHeight,
    durationMs: result.durationMs,
    orientation: result.orientation,
    videoRotationDegrees: result.rotationDegrees,
    isAnimated: result.isAnimated,
    capturedLocalAt: result.capturedLocalAt,
    capturedAtUtc: result.capturedAtUtc,
    capturedOffsetMinutes: result.captureOffsetMinutes,
    capturedSource: result.captureTimeSource,
    capturedTimeStatus: result.captureTimeStatus,
    timelineKey: result.capturedLocalAt ?? new Date(0),
    timelineBasis:
      result.capturedLocalAt === null ? "UPLOAD_UTC" : "CAPTURE_LOCAL",
    gpsLatitude: result.gpsLatitude,
    gpsLongitude: result.gpsLongitude,
    cameraMake: result.cameraMake,
    cameraModel: result.cameraModel,
    videoCodec: result.videoCodec,
    videoContainer:
      result.detectedMediaType === "VIDEO" ? result.container : null,
    warningFlags,
  };
}

function emptySnapshot(uploadedAt: Date): Snapshot {
  return {
    mediaType: "UNKNOWN",
    detectedMime: null,
    metadataGeneration: null,
    rawWidth: null,
    rawHeight: null,
    displayWidth: null,
    displayHeight: null,
    durationMs: null,
    orientation: null,
    videoRotationDegrees: null,
    isAnimated: false,
    capturedLocalAt: null,
    capturedAtUtc: null,
    capturedOffsetMinutes: null,
    capturedSource: "NONE",
    capturedTimeStatus: "ABSENT",
    timelineKey: uploadedAt,
    timelineBasis: "UPLOAD_UTC",
    gpsLatitude: null,
    gpsLongitude: null,
    cameraMake: null,
    cameraModel: null,
    videoCodec: null,
    videoContainer: null,
    warningFlags: 0n,
  };
}

function withWarning(snapshot: Snapshot, warning: bigint): Snapshot {
  return { ...snapshot, warningFlags: snapshot.warningFlags | warning };
}

async function replaceMetadataSnapshot(
  connection: PoolConnection,
  context: LockedContext,
  fence: LeaseFence,
  inputSnapshot: Snapshot,
  mediaState: Phase4ProcessingState,
  failureCode: Phase4FailureCode | null,
) {
  const snapshot =
    inputSnapshot.timelineBasis === "UPLOAD_UTC"
      ? { ...inputSnapshot, timelineKey: context.media.uploadedAt }
      : inputSnapshot;
  const [changed] = await connection.execute<ResultSetHeader>(
    `UPDATE media_items SET
      media_type=?,detected_mime=?,processing_state=?,metadata_generation=?,
      raw_width=?,raw_height=?,display_width=?,display_height=?,duration_ms=?,
      orientation=?,video_rotation_degrees=?,is_animated=?,motion_hint=0,
      captured_local_at=?,captured_at_utc=?,captured_offset_minutes=?,
      captured_source=?,captured_time_status=?,timeline_key=?,timeline_basis=?,
      gps_latitude=?,gps_longitude=?,camera_make=?,camera_model=?,video_codec=?,
      video_container=?,video_transfer=NULL,warning_flags=?,last_failure_code=?,
      updated_at=?
     WHERE id=? AND family_id=? AND storage_object_id=? AND generation=?
       AND recipe_id=? AND source_upload_id=?`,
    [
      snapshot.mediaType,
      snapshot.detectedMime,
      mediaState,
      snapshot.metadataGeneration,
      snapshot.rawWidth,
      snapshot.rawHeight,
      snapshot.displayWidth,
      snapshot.displayHeight,
      snapshot.durationMs,
      snapshot.orientation,
      snapshot.videoRotationDegrees,
      snapshot.isAnimated,
      snapshot.capturedLocalAt,
      snapshot.capturedAtUtc,
      snapshot.capturedOffsetMinutes,
      snapshot.capturedSource,
      snapshot.capturedTimeStatus,
      snapshot.timelineKey,
      snapshot.timelineBasis,
      snapshot.gpsLatitude,
      snapshot.gpsLongitude,
      snapshot.cameraMake,
      snapshot.cameraModel,
      snapshot.videoCodec,
      snapshot.videoContainer,
      snapshot.warningFlags.toString(),
      failureCode,
      context.now,
      fence.mediaId,
      fence.familyId,
      context.storage.id,
      fence.generation.toString(),
      context.media.recipeId,
      context.media.sourceUploadId,
    ],
  );
  if (changed.affectedRows !== 1) throw new MetadataRepositoryError("CONFLICT");
}

async function setMediaFailureState(
  connection: PoolConnection,
  context: LockedContext,
  fence: LeaseFence,
  state: "PENDING" | "FAILED",
  failureCode: Phase4FailureCode,
) {
  const [changed] = await connection.execute<ResultSetHeader>(
    `UPDATE media_items SET processing_state=?,last_failure_code=?,updated_at=?
     WHERE id=? AND family_id=? AND storage_object_id=? AND generation=?
       AND recipe_id=? AND source_upload_id=?`,
    [
      state,
      state === "FAILED" ? failureCode : null,
      context.now,
      fence.mediaId,
      fence.familyId,
      context.storage.id,
      fence.generation.toString(),
      context.media.recipeId,
      context.media.sourceUploadId,
    ],
  );
  if (changed.affectedRows !== 1) throw new MetadataRepositoryError("CONFLICT");
}

async function enqueueDownstream(
  connection: PoolConnection,
  context: LockedContext,
  fence: LeaseFence,
  jobType: "IMAGE_DERIVATIVES" | "VIDEO_POSTER",
) {
  const identity = [
    fence.familyId,
    fence.mediaId,
    fence.generation.toString(),
    context.media.recipeId,
    jobType,
  ];
  const [existing] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id FROM background_jobs
     WHERE family_id=? AND media_id=? AND generation=? AND recipe_id=?
       AND job_type=? FOR SHARE`,
    identity,
  );
  if (existing[0]) return;
  try {
    await connection.execute<ResultSetHeader>(
      `INSERT INTO background_jobs
        (family_id,media_id,generation,recipe_id,job_type,available_at)
       VALUES (?,?,?,?,?,?)`,
      [...identity, context.now],
    );
  } catch (error) {
    if (!isJobIdentityDuplicate(error)) throw error;
    const [winner] = await connection.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id FROM background_jobs
       WHERE family_id=? AND media_id=? AND generation=? AND recipe_id=?
         AND job_type=? FOR SHARE`,
      identity,
    );
    if (!winner[0]) throw new MetadataRepositoryError("CONFLICT");
  }
}

async function finishProbeJob(
  connection: PoolConnection,
  context: LockedContext,
  fence: LeaseFence,
  state: "SUCCEEDED" | "FAILED",
  failureCode: Phase4FailureCode | null,
) {
  const [changed] = await connection.execute<ResultSetHeader>(
    `UPDATE background_jobs
     SET state=?,worker_id=NULL,locked_at=NULL,heartbeat_at=NULL,
       locked_until=NULL,last_failure_code=?,finished_at=?,updated_at=?
     WHERE id=? AND family_id=? AND media_id=? AND generation=?
       AND recipe_id=? AND job_type='MEDIA_PROBE' AND state='RUNNING'
       AND worker_id=? AND lease_epoch=? AND locked_until>? AND attempts=?`,
    [
      state,
      failureCode,
      context.now,
      context.now,
      fence.jobId,
      fence.familyId,
      fence.mediaId,
      fence.generation.toString(),
      context.media.recipeId,
      fence.workerId,
      fence.leaseEpoch.toString(),
      context.now,
      context.job.attempts,
    ],
  );
  if (changed.affectedRows !== 1) throw new MetadataRepositoryError("CONFLICT");
}

async function retryProbeJob(
  connection: PoolConnection,
  context: LockedContext,
  fence: LeaseFence,
  state: "FAILED" | "RETRY_WAIT",
  failureCode: Phase4FailureCode,
  random: () => number,
) {
  const availableAt =
    state === "FAILED"
      ? context.now
      : new Date(
          context.now.getTime() + retryDelay(context.job.attempts, random),
        );
  const [changed] = await connection.execute<ResultSetHeader>(
    `UPDATE background_jobs
     SET state=?,available_at=?,worker_id=NULL,locked_at=NULL,heartbeat_at=NULL,
       locked_until=NULL,last_failure_code=?,finished_at=?,updated_at=?
     WHERE id=? AND family_id=? AND media_id=? AND generation=?
       AND recipe_id=? AND job_type='MEDIA_PROBE' AND state='RUNNING'
       AND worker_id=? AND lease_epoch=? AND locked_until>? AND attempts=?`,
    [
      state,
      availableAt,
      failureCode,
      state === "FAILED" ? context.now : null,
      context.now,
      fence.jobId,
      fence.familyId,
      fence.mediaId,
      fence.generation.toString(),
      context.media.recipeId,
      fence.workerId,
      fence.leaseEpoch.toString(),
      context.now,
      context.job.attempts,
    ],
  );
  if (changed.affectedRows !== 1) throw new MetadataRepositoryError("CONFLICT");
}

function downstreamType(
  mediaType: NormalizedMetadataResult["detectedMediaType"],
): "IMAGE_DERIVATIVES" | "VIDEO_POSTER" {
  if (mediaType === "IMAGE") return "IMAGE_DERIVATIVES";
  if (mediaType === "VIDEO") return "VIDEO_POSTER";
  throw new MetadataRepositoryError("INVALID_INPUT");
}

function operationalFailureCode(
  failure: MetadataOperationalFailure,
): Phase4FailureCode {
  switch (failure) {
    case "TIMEOUT":
      return "PROCESS_TIMEOUT";
    case "PARSER_FAILED":
      return "TEMPORARY_IO";
    case "CAPABILITY_DISABLED":
      return "CAPABILITY_UNAVAILABLE";
  }
}

function retryDelay(attempts: number, random: () => number) {
  const range = RETRY_RANGES_SECONDS[attempts as 1 | 2];
  if (!range) throw new MetadataRepositoryError("CONFLICT");
  return Math.floor(range[0] + random() * (range[1] - range[0] + 1)) * 1_000;
}

function validateResult(result: NormalizedMetadataResult) {
  if (
    ![
      "SUCCESS",
      "PARTIAL",
      "UNSUPPORTED",
      "INVALID_MEDIA",
      "RESOURCE_LIMIT",
    ].includes(result.parserStatus) ||
    !["IMAGE", "VIDEO", "UNKNOWN"].includes(result.detectedMediaType)
  ) {
    throw new MetadataRepositoryError("INVALID_INPUT");
  }
  if (
    result.captureTimezoneKnown !==
    (result.captureTimeStatus === "OFFSET_KNOWN")
  ) {
    throw new MetadataRepositoryError("INVALID_INPUT");
  }
}

function assertFence(fence: LeaseFence) {
  for (const value of [fence.familyId, fence.mediaId, fence.jobId]) {
    if (!/^[1-9][0-9]*$/u.test(value)) {
      throw new MetadataRepositoryError("INVALID_INPUT");
    }
  }
  if (
    fence.generation < 1n ||
    fence.leaseEpoch < 1n ||
    !Buffer.isBuffer(fence.workerId) ||
    fence.workerId.byteLength !== 16
  ) {
    throw new MetadataRepositoryError("INVALID_INPUT");
  }
}

function assertPreparation(
  fence: LeaseFence,
  preparation: MetadataPreparation,
) {
  if (
    preparation.familyId !== fence.familyId ||
    preparation.mediaId !== fence.mediaId ||
    preparation.generation !== fence.generation ||
    preparation.keyVersion !== 1 ||
    !/^[1-9][0-9]*$/u.test(preparation.storageObjectId) ||
    !/^[0-9a-f]{64}$/u.test(preparation.sha256Hex) ||
    !/^[1-9][0-9]*$/u.test(preparation.byteSize) ||
    !Number.isSafeInteger(preparation.recipeId) ||
    preparation.recipeId < 1
  ) {
    throw new MetadataRepositoryError("INVALID_INPUT");
  }
}
