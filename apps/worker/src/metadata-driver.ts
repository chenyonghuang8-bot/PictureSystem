import type { Pool, RowDataPacket } from "mysql2/promise";
import {
  MySqlJobRepository,
  MySqlMetadataRepository,
  type LeaseFence,
} from "@family-album/db";
import {
  IsolatedProbeRunner,
  type LocationProjector,
} from "@family-album/media";
import type { OriginalReader } from "@family-album/storage";
import { MetadataProcessingService } from "./metadata-processor.js";

/** Read-only Original driver. Reuses existing claims, epochs, expiry and recovery;
 * it does not own an Original/Derived writer or run purge. */
export class MetadataJobDriver {
  private stopping = false;
  requestStop() {
    this.stopping = true;
  }
  private readonly identity = MySqlJobRepository.createWorkerIdentity();
  private readonly jobs: MySqlJobRepository;
  private readonly metadata: MySqlMetadataRepository;
  private readonly runner = new IsolatedProbeRunner({ allowDevBackend: true });
  private readonly service: MetadataProcessingService;
  constructor(
    private readonly pool: Pool,
    private readonly reader: OriginalReader,
    projector: LocationProjector,
    onProjectionFailure?: () => void,
  ) {
    this.jobs = new MySqlJobRepository(pool);
    this.metadata = new MySqlMetadataRepository(pool, {
      locationProjector: projector,
      ...(onProjectionFailure ? { onProjectionFailure } : {}),
    });
    this.service = new MetadataProcessingService(
      this.metadata,
      this.runner,
      reader,
    );
  }
  async runNext() {
    if (this.stopping) return false;
    const job = await this.jobs.claimNext(this.identity, {
      jobType: "MEDIA_PROBE",
    });
    if (!job) return false;
    if (job.lifecycleRevision === undefined)
      throw new Error("PROBE_LIFECYCLE_FENCE_MISSING");
    const fence: LeaseFence = {
      familyId: job.familyId,
      mediaId: job.mediaId,
      jobId: job.id,
      generation: job.generation,
      workerId: this.identity,
      leaseEpoch: job.leaseEpoch,
      lifecycleRevision: job.lifecycleRevision,
    };
    if (!this.runner.enabled) {
      const preparation = await this.metadata.prepare(fence);
      if (!preparation) return true;
      await this.runner.verifyCapabilities(this.reader, preparation);
    }
    await this.service.process(fence);
    return true;
  }
  async recoverExpired() {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT CAST(family_id AS CHAR) familyId,CAST(media_id AS CHAR) mediaId,CAST(id AS CHAR) jobId,CAST(generation AS CHAR) generation FROM background_jobs WHERE job_type='MEDIA_PROBE' AND state='RUNNING' AND locked_until<=CURRENT_TIMESTAMP(3) ORDER BY id LIMIT 20",
    );
    for (const row of rows) {
      if (this.stopping) break;
      await this.jobs.recoverExpiredLease({
        familyId: String(row.familyId),
        mediaId: String(row.mediaId),
        jobId: String(row.jobId),
        generation: BigInt(row.generation),
      });
    }
  }
}
