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
  denyControlAdmission,
  ControlAdmissionError,
  type ControlAdmission,
} from "@family-album/storage";
import { ImageDerivativeProcessor } from "./image-derivative-processor.js";
import { SerialJobLoop } from "./serial-job-loop.js";

/** Borrows the API owner's handles; never opens/closes an Original writer. */
export class ImageDerivativeDriver {
  private readonly identity = MySqlJobRepository.createWorkerIdentity();
  private readonly jobs: MySqlJobRepository;
  private readonly processor: ImageDerivativeProcessor | undefined;
  private readonly loop: SerialJobLoop;
  constructor(
    private readonly pool: Pool,
    storage:
      | {
          capability: StorageCapability & { state: "READ_WRITE" };
          gate: CapacityGate;
          store: DerivedStore;
        }
      | undefined,
    reader: OriginalReader | undefined,
    private readonly admission: ControlAdmission = denyControlAdmission,
    private readonly withProcessor?: <T>(
      operation: (processor: ImageDerivativeProcessor) => Promise<T>,
    ) => Promise<T>,
  ) {
    this.jobs = new MySqlJobRepository(pool);
    this.processor =
      storage && reader
        ? ImageDerivativeDriver.createProcessor(
            pool,
            storage,
            reader,
            this.jobs,
          )
        : undefined;
    if (!this.processor && !withProcessor)
      throw Error("DERIVATIVE_PROVIDER_REQUIRED");
    this.loop = new SerialJobLoop(async () => {
      try {
        await this.recoverExpired();
        if (!this.loop.stopped && !(await this.runNext()))
          await this.loop.wait(1000);
      } catch (error) {
        if (!(error instanceof ControlAdmissionError)) throw error;
        await this.loop.wait(1000);
      }
    });
  }
  static createProcessor(
    pool: Pool,
    storage: {
      capability: StorageCapability & { state: "READ_WRITE" };
      gate: CapacityGate;
      store: DerivedStore;
    },
    reader: OriginalReader,
    jobs = new MySqlJobRepository(pool),
  ) {
    return new ImageDerivativeProcessor(
      jobs,
      new MySqlDerivedAdmissionRepository(pool),
      new MySqlDerivedAssetFence(pool),
      storage,
      (input) =>
        reader.withVerifiedOriginal(input, (handle) =>
          renderUnverifiedCandidate(handle, input.kind),
        ),
    );
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
  get stopped() {
    return this.loop.stopped;
  }
  async runNext() {
    return this.admission.run("MEDIA_WRITE", () => this.runAdmitted());
  }
  private async runAdmitted() {
    if (this.loop.stopped)
      throw new Error("DERIVATIVE_STOPPED_RESTART_REQUIRED");
    try {
      const outcome = this.withProcessor
        ? await this.withProcessor((processor) => processor.run(this.identity))
        : await this.processor!.run(this.identity);
      if (outcome.outcome === "COMMIT_UNKNOWN")
        throw new Error("DERIVATIVE_OUTCOME_UNKNOWN");
      return outcome.outcome !== "IDLE";
    } catch (error) {
      this.requestStop();
      throw error;
    }
  }
  async recoverExpired() {
    return this.admission.run("MEDIA_WRITE", () => this.recoverAdmitted());
  }
  private async recoverAdmitted() {
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
