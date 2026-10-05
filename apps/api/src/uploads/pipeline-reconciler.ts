import {
  JobRepositoryError,
  MediaRepositoryError,
  isDeadlock,
  isLockWaitTimeout,
  validUploadPipelineCandidate,
  type MySqlMediaRepository,
  type MySqlJobRepository,
  type MySqlUploadPipelineRepository,
  type UploadPipelineCandidate,
  type UploadPipelineObservation,
  type UploadPipelineOutcome,
} from "@family-album/db";
import { type StorageRoot } from "@family-album/storage";
import { ContentCoordination } from "../../../../packages/storage/src/phase7-coordination.js";
import { SerialJobLoop } from "../../../worker/src/serial-job-loop.js";

type Guard = { close(): void };
type Dependencies = {
  repository: Pick<
    MySqlUploadPipelineRepository,
    | "readUploadPipelineHighWater"
    | "listUploadPipelinePage"
    | "observeUploadPipeline"
  >;
  media: Pick<MySqlMediaRepository, "createOrGetCanonicalMedia">;
  jobs: Pick<MySqlJobRepository, "enqueue">;
  acquire: (candidate: UploadPipelineCandidate) => Promise<Guard>;
};
export class UploadPipelineReconciler {
  private readonly loop: SerialJobLoop;
  private afterId = "0";
  private throughId: string | null = null;
  constructor(
    private readonly dependencies: Dependencies,
    private readonly onRound: (
      counts: Partial<Record<UploadPipelineOutcome, number>>,
    ) => void = () => {},
    private readonly wait?: (milliseconds: number) => Promise<void>,
  ) {
    this.loop = new SerialJobLoop(async () => {
      try {
        await this.page();
      } catch (error) {
        this.requestStop();
        throw error;
      }
    });
  }
  static acquire(root: StorageRoot) {
    return (c: UploadPipelineCandidate) =>
      new ContentCoordination(root, {
        familyId: c.familyId,
        sha256Hex: c.expectedSha256Hex,
        byteSize: c.expectedByteSize,
      }).acquireLifecycle("S", 30_000);
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
  private pause(milliseconds: number) {
    return this.wait ? this.wait(milliseconds) : this.loop.wait(milliseconds);
  }
  private counts: Partial<Record<UploadPipelineOutcome, number>> = {};
  async page() {
    if (this.loop.stopped) return;
    if (this.throughId === null)
      this.throughId =
        await this.dependencies.repository.readUploadPipelineHighWater();
    if (this.loop.stopped) return;
    const candidates =
      this.throughId === null
        ? []
        : await this.dependencies.repository.listUploadPipelinePage({
            afterId: this.afterId,
            throughId: this.throughId,
            limit: 20,
          });
    if (!candidates.length) {
      this.onRound(this.counts);
      this.counts = {};
      this.afterId = "0";
      this.throughId = null;
      await this.pause(30_000);
      return;
    }
    for (const candidate of candidates) {
      if (this.loop.stopped) break;
      this.afterId = candidate.uploadId;
      const observed = await this.reconcile(candidate);
      this.counts[observed.result] = (this.counts[observed.result] ?? 0) + 1;
    }
    await this.pause(250);
  }
  async reconcile(
    candidate: UploadPipelineCandidate,
  ): Promise<{ result: UploadPipelineOutcome; jobState?: string }> {
    if (this.loop.stopped) throw new Error("PIPELINE_STOPPED_RESTART_REQUIRED");
    if (!validUploadPipelineCandidate(candidate))
      return { result: "INVARIANT_REJECTED" };
    let guard: Guard | undefined;
    try {
      guard = await this.dependencies.acquire(candidate);
      let observation =
        await this.dependencies.repository.observeUploadPipeline(candidate);
      if (observation.result === "MISSING_MEDIA") {
        await this.dependencies.media.createOrGetCanonicalMedia({
          familyId: candidate.familyId,
          uploadId: candidate.uploadId,
        });
        observation =
          await this.dependencies.repository.observeUploadPipeline(candidate);
      }
      if (observation.result !== "MISSING_PROBE") return result(observation);
      const before = observation.media!;
      await this.dependencies.jobs.enqueue({
        familyId: candidate.familyId,
        mediaId: before.id,
        generation: BigInt(before.generation),
        recipeId: before.recipeId,
        jobType: "MEDIA_PROBE",
      });
      const final =
        await this.dependencies.repository.observeUploadPipeline(candidate);
      if (
        final.media &&
        (final.media.id !== before.id ||
          final.media.generation !== before.generation ||
          final.media.recipeId !== before.recipeId ||
          final.media.lifecycleRevision !== before.lifecycleRevision)
      )
        return { result: "STALE" };
      return result(final);
    } catch (error) {
      if (error instanceof Error && error.message === "COORD_ACQUIRE_TIMEOUT")
        return { result: "DEFERRED" };
      if (
        error instanceof JobRepositoryError &&
        ["NOT_FOUND", "CONFLICT"].includes(error.reason)
      )
        return { result: "DEFERRED" };
      if (error instanceof MediaRepositoryError)
        return {
          result: ["NOT_FOUND", "CONFLICT"].includes(error.reason)
            ? "DEFERRED"
            : "INVARIANT_REJECTED",
        };
      // Only raw errors from a successfully rolled-back transaction qualify.
      // Unknown/rollback-failure wrappers expose no driver code and stop the loop.
      if (
        !(
          error &&
          typeof error === "object" &&
          "fatal" in error &&
          error.fatal === true
        ) &&
        (isDeadlock(error) || isLockWaitTimeout(error))
      )
        return { result: "DEFERRED" };
      this.requestStop();
      throw error;
    } finally {
      this.closeGuard(guard);
    }
  }
  private closeGuard(guard: Guard | undefined) {
    try {
      guard?.close();
    } catch (error) {
      this.requestStop();
      throw error;
    }
  }
}
function result(o: UploadPipelineObservation): {
  result: UploadPipelineOutcome;
  jobState?: string;
} {
  return {
    result:
      o.result === "MISSING_MEDIA" || o.result === "MISSING_PROBE"
        ? "DEFERRED"
        : o.result,
    ...(o.jobState ? { jobState: o.jobState } : {}),
  };
}
