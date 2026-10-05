import type { Pool, RowDataPacket } from "mysql2/promise";
import { runCheckedTransaction } from "./connection.js";
import { isActiveMedia } from "./media-lifecycle.js";

export type UploadPipelineCandidate = {
  uploadId: string;
  familyId: string;
  expectedStorageObjectId: string;
  expectedSha256Hex: string;
  expectedByteSize: string;
  discovery?: {
    storageState: string | null;
    mediaId: string | null;
    generation: string | null;
    recipeId: number | null;
    metadataGeneration: string | null;
    processingState: string | null;
    trashedAt: Date | null;
    purgeIntentId: string | null;
    jobState: string | null;
  };
};
export type UploadPipelineMedia = {
  id: string;
  generation: string;
  recipeId: number;
  lifecycleRevision: string;
  sourceUploadId: string;
  processingState: string;
  metadataGeneration: string | null;
};
export type UploadPipelineOutcome =
  | "PIPELINE_ATTACHED"
  | "PIPELINE_TERMINAL_FAILED"
  | "LIFECYCLE_INACTIVE"
  | "NOT_APPLICABLE"
  | "STALE"
  | "INVARIANT_REJECTED"
  | "DEFERRED";
export type UploadPipelineObservation = {
  result: UploadPipelineOutcome | "MISSING_MEDIA" | "MISSING_PROBE";
  media?: UploadPipelineMedia;
  jobState?: string;
};
function id(value: string, zero = false) {
  return (
    typeof value === "string" &&
    (zero ? /^(0|[1-9][0-9]{0,19})$/ : /^[1-9][0-9]{0,19}$/).test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}
export function validUploadPipelineCandidate(input: UploadPipelineCandidate) {
  return (
    id(input.uploadId) &&
    id(input.familyId) &&
    id(input.expectedStorageObjectId) &&
    id(input.expectedByteSize) &&
    /^[a-f0-9]{64}$/.test(input.expectedSha256Hex)
  );
}
/** Discovery is a hint. Only observeUploadPipeline's current locking reads
 * authorize the existing independent canonical/enqueue transactions. */
export class MySqlUploadPipelineRepository {
  constructor(private readonly pool: Pool) {}
  async readUploadPipelineHighWater(): Promise<string | null> {
    return runCheckedTransaction(this.pool, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT CAST(MAX(id) AS CHAR) id FROM upload_sessions",
      );
      return rows[0]?.id ?? null;
    });
  }
  async listUploadPipelinePage(input: {
    afterId: string;
    throughId: string;
    limit: 20;
  }): Promise<readonly UploadPipelineCandidate[]> {
    if (!id(input.afterId, true) || !id(input.throughId) || input.limit !== 20)
      throw new Error("PIPELINE_PAGE_INVALID");
    return runCheckedTransaction(this.pool, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        `SELECT CAST(u.id AS CHAR) uploadId,CAST(u.family_id AS CHAR) familyId,
          CAST(u.storage_object_id AS CHAR) expectedStorageObjectId,
          LOWER(HEX(u.computed_sha256)) expectedSha256Hex,CAST(u.declared_size AS CHAR) expectedByteSize,
          s.state storageState,CAST(m.id AS CHAR) mediaId,m.processing_state processingState,
          CAST(m.generation AS CHAR) generation,CAST(m.metadata_generation AS CHAR) metadataGeneration,
          m.recipe_id recipeId,m.trashed_at trashedAt,CAST(m.purge_intent_id AS CHAR) purgeIntentId,j.state jobState
         FROM upload_sessions u
         LEFT JOIN storage_objects s ON s.family_id=u.family_id AND s.id=u.storage_object_id
         LEFT JOIN media_items m ON m.family_id=u.family_id AND m.storage_object_id=u.storage_object_id
         LEFT JOIN background_jobs j ON j.family_id=m.family_id AND j.media_id=m.id AND j.generation=m.generation AND j.recipe_id=m.recipe_id AND j.job_type='MEDIA_PROBE'
         WHERE u.state='COMPLETE' AND u.id>? AND u.id<=? ORDER BY u.id LIMIT 20`,
        [input.afterId, input.throughId],
      );
      return rows.map((r) => ({
        uploadId: r.uploadId,
        familyId: r.familyId,
        expectedStorageObjectId: r.expectedStorageObjectId,
        expectedSha256Hex: r.expectedSha256Hex,
        expectedByteSize: r.expectedByteSize,
        discovery: {
          storageState: r.storageState,
          mediaId: r.mediaId,
          generation: r.generation,
          recipeId: r.recipeId,
          metadataGeneration: r.metadataGeneration,
          processingState: r.processingState,
          trashedAt: r.trashedAt,
          purgeIntentId: r.purgeIntentId,
          jobState: r.jobState,
        },
      }));
    });
  }
  async observeUploadPipeline(
    input: UploadPipelineCandidate,
  ): Promise<UploadPipelineObservation> {
    if (!validUploadPipelineCandidate(input))
      return { result: "INVARIANT_REJECTED" };
    return runCheckedTransaction(this.pool, async (c) => {
      const [families] = await c.query<RowDataPacket[]>(
        "SELECT id FROM families WHERE id=? FOR SHARE",
        [input.familyId],
      );
      if (!families[0]) return { result: "NOT_APPLICABLE" };
      const [receipts] = await c.query<RowDataPacket[]>(
        `SELECT state,CAST(storage_object_id AS CHAR) storageId,LOWER(HEX(computed_sha256)) hash,
          CAST(declared_size AS CHAR) size,CAST(committed_offset AS CHAR) offset,completed_at completedAt
         FROM upload_sessions WHERE family_id=? AND id=? FOR SHARE`,
        [input.familyId, input.uploadId],
      );
      const receipt = receipts[0];
      if (!receipt || receipt.state !== "COMPLETE")
        return { result: "NOT_APPLICABLE" };
      if (
        receipt.storageId !== input.expectedStorageObjectId ||
        receipt.hash !== input.expectedSha256Hex ||
        receipt.size !== input.expectedByteSize
      )
        return { result: "STALE" };
      if (
        receipt.offset !== receipt.size ||
        !(receipt.completedAt instanceof Date)
      )
        return { result: "INVARIANT_REJECTED" };
      const [objects] = await c.query<RowDataPacket[]>(
        `SELECT state,key_version keyVersion,LOWER(HEX(sha256)) hash,CAST(byte_size AS CHAR) size
         FROM storage_objects WHERE family_id=? AND id=? FOR SHARE`,
        [input.familyId, input.expectedStorageObjectId],
      );
      const object = objects[0];
      if (
        !object ||
        object.state !== "AVAILABLE" ||
        object.keyVersion !== 1 ||
        object.hash !== receipt.hash ||
        object.size !== receipt.size
      )
        return { result: "INVARIANT_REJECTED" };
      const [mediaRows] = await c.query<RowDataPacket[]>(
        `SELECT CAST(id AS CHAR) id,CAST(generation AS CHAR) generation,recipe_id recipeId,
          CAST(lifecycle_revision AS CHAR) lifecycleRevision,CAST(source_upload_id AS CHAR) sourceUploadId,
          processing_state processingState,CAST(metadata_generation AS CHAR) metadataGeneration,
          media_type mediaType,trashed_at trashedAt,CAST(purge_intent_id AS CHAR) purgeIntentId
         FROM media_items WHERE family_id=? AND storage_object_id=? FOR SHARE`,
        [input.familyId, input.expectedStorageObjectId],
      );
      const m = mediaRows[0];
      if (!m) return { result: "MISSING_MEDIA" };
      const media: UploadPipelineMedia = {
        id: m.id,
        generation: m.generation,
        recipeId: m.recipeId,
        lifecycleRevision: m.lifecycleRevision,
        sourceUploadId: m.sourceUploadId,
        processingState: m.processingState,
        metadataGeneration: m.metadataGeneration,
      };
      if (
        !isActiveMedia(
          m as { trashedAt: Date | null; purgeIntentId: string | null },
        )
      )
        return { result: "LIFECYCLE_INACTIVE", media };
      if (
        !id(media.sourceUploadId) ||
        !id(media.generation) ||
        !id(media.lifecycleRevision) ||
        media.recipeId !== 1
      )
        return { result: "INVARIANT_REJECTED", media };
      const identity = [
        input.familyId,
        media.id,
        media.generation,
        media.recipeId,
      ];
      const [jobs] = await c.query<RowDataPacket[]>(
        `SELECT state FROM background_jobs WHERE family_id=? AND media_id=? AND generation=? AND recipe_id=? AND job_type='MEDIA_PROBE' FOR SHARE`,
        identity,
      );
      const job = jobs[0];
      if (!job) {
        const unstarted =
          media.processingState === "PENDING" &&
          (media.metadataGeneration === null ||
            BigInt(media.metadataGeneration) < BigInt(media.generation));
        return {
          result: unstarted ? "MISSING_PROBE" : "INVARIANT_REJECTED",
          media,
        };
      }
      if (job.state === "FAILED")
        return {
          result: "PIPELINE_TERMINAL_FAILED",
          media,
          jobState: job.state,
        };
      if (job.state === "SUCCEEDED") {
        if (
          media.metadataGeneration !== media.generation ||
          !["IMAGE", "VIDEO"].includes(m.mediaType)
        )
          return { result: "INVARIANT_REJECTED", media, jobState: job.state };
        const [downstream] = await c.query<RowDataPacket[]>(
          `SELECT state FROM background_jobs WHERE family_id=? AND media_id=? AND generation=? AND recipe_id=? AND job_type=? FOR SHARE`,
          [
            ...identity,
            m.mediaType === "IMAGE" ? "IMAGE_DERIVATIVES" : "VIDEO_POSTER",
          ],
        );
        if (!downstream[0])
          return { result: "INVARIANT_REJECTED", media, jobState: job.state };
      } else if (!["QUEUED", "RUNNING", "RETRY_WAIT"].includes(job.state))
        return { result: "INVARIANT_REJECTED", media };
      return { result: "PIPELINE_ATTACHED", media, jobState: job.state };
    });
  }
}
