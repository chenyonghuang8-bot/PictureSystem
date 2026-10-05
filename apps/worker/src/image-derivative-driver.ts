import type { Pool, RowDataPacket } from "mysql2/promise";
import {
  MySqlJobRepository,
  MySqlDerivedAdmissionRepository,
  MySqlDerivedAssetFence,
  runCheckedTransaction,
} from "@family-album/db";
import {
  renderUnverifiedCandidate,
  type OriginalReader,
  type StorageCapability,
  type CapacityGate,
  type DerivedStore,
} from "@family-album/storage";
import { ImageDerivativeProcessor } from "./image-derivative-processor.js";
import { SerialJobLoop } from "./serial-job-loop.js";

/** Borrows the API owner's handles; never opens/closes an Original writer. */
export class ImageDerivativeDriver {
  private readonly identity = MySqlJobRepository.createWorkerIdentity();
  private readonly jobs: MySqlJobRepository;
  private readonly processor: ImageDerivativeProcessor;
  private readonly loop: SerialJobLoop;
  constructor(
    private readonly pool: Pool,
    storage: {
      capability: StorageCapability & { state: "READ_WRITE" };
      gate: CapacityGate;
      store: DerivedStore;
    },
    reader: OriginalReader,
  ) {
    this.jobs = new MySqlJobRepository(pool);
    this.processor = new ImageDerivativeProcessor(
      this.jobs,
      new MySqlDerivedAdmissionRepository(pool),
      new MySqlDerivedAssetFence(pool),
      storage,
      (input) =>
        reader.withVerifiedOriginal(input, (handle) =>
          renderUnverifiedCandidate(handle, input.kind),
        ),
    );
    this.loop = new SerialJobLoop(async () => {
      await this.recoverExpired();
      if (!this.loop.stopped && !(await this.runNext()))
        await this.loop.wait(1000);
    });
  }
  start() {
    return this.loop.start();
  }
  requestStop() {
    this.loop.requestStop();
  }
  drain() {
    return this.loop.drain();
  }
  async runNext() {
    if (this.loop.stopped)
      throw new Error("DERIVATIVE_STOPPED_RESTART_REQUIRED");
    try {
      const outcome = await this.processor.run(this.identity);
      if (outcome.outcome === "COMMIT_UNKNOWN")
        throw new Error("DERIVATIVE_OUTCOME_UNKNOWN");
      return outcome.outcome !== "IDLE";
    } catch (error) {
      this.requestStop();
      throw error;
    }
  }
  async recoverExpired() {
    try {
      const rows = await runCheckedTransaction(this.pool, async (c) => {
        const [rows] = await c.query<RowDataPacket[]>(
          "SELECT CAST(family_id AS CHAR) familyId,CAST(media_id AS CHAR) mediaId,CAST(id AS CHAR) jobId,CAST(generation AS CHAR) generation FROM background_jobs WHERE job_type='IMAGE_DERIVATIVES' AND state='RUNNING' AND locked_until<=CURRENT_TIMESTAMP(3) ORDER BY id LIMIT 20",
        );
        return rows;
      });
      for (const r of rows) {
        if (this.loop.stopped) break;
        await this.jobs.recoverExpiredLease({
          familyId: r.familyId,
          mediaId: r.mediaId,
          jobId: r.jobId,
          generation: BigInt(r.generation),
        });
      }
    } catch (error) {
      this.requestStop();
      throw error;
    }
  }
}
