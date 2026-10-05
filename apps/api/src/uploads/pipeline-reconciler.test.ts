import { describe, expect, it, vi } from "vitest";
import {
  CommitOutcomeUnknownError,
  TransactionRollbackFailedError,
  type UploadPipelineObservation,
  type UploadPipelineCandidate,
} from "@family-album/db";
import { UploadPipelineReconciler } from "./pipeline-reconciler.js";

const candidate: UploadPipelineCandidate = {
  familyId: "1",
  uploadId: "1",
  expectedStorageObjectId: "1",
  expectedSha256Hex: "a".repeat(64),
  expectedByteSize: "100",
};
const media = {
  id: "2",
  sourceUploadId: "1",
  generation: "1",
  recipeId: 1,
  lifecycleRevision: "1",
  processingState: "PENDING",
  metadataGeneration: null,
};
function fixture(observations: UploadPipelineObservation[]) {
  const close = vi.fn();
  const repository = {
    readUploadPipelineHighWater: vi.fn(async () => "61"),
    listUploadPipelinePage: vi.fn(
      async (_input: { afterId: string; throughId: string; limit: 20 }) => {
        void _input;
        return [] as UploadPipelineCandidate[];
      },
    ),
    observeUploadPipeline: vi.fn(
      async (_candidate: UploadPipelineCandidate) => {
        void _candidate;
        return observations.shift()!;
      },
    ),
  };
  const create = vi.fn(async () => ({}) as never),
    enqueue = vi.fn(async () => ({}) as never),
    acquire = vi.fn(async () => ({ close })),
    wait = vi.fn(async (_milliseconds: number) => {
      void _milliseconds;
    });
  const worker = new UploadPipelineReconciler(
    {
      repository,
      media: { createOrGetCanonicalMedia: create },
      jobs: { enqueue },
      acquire,
    },
    undefined,
    wait,
  );
  return { worker, repository, create, enqueue, close, acquire, wait };
}
describe("durable receipt reconciliation", () => {
  it("repairs A with independent T1, re-observation, T2 and final observation", async () => {
    const f = fixture([
      { result: "MISSING_MEDIA" },
      { result: "MISSING_PROBE", media },
      { result: "PIPELINE_ATTACHED", media, jobState: "QUEUED" },
    ]);
    expect(await f.worker.reconcile(candidate)).toEqual({
      result: "PIPELINE_ATTACHED",
      jobState: "QUEUED",
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.repository.observeUploadPipeline).toHaveBeenCalledTimes(3);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("repairs B without recreating canonical source and preserves every existing/terminal/inactive state", async () => {
    const f = fixture([
      { result: "MISSING_PROBE", media: { ...media, sourceUploadId: "9" } },
      { result: "PIPELINE_ATTACHED", media, jobState: "RUNNING" },
    ]);
    await f.worker.reconcile(candidate);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    for (const result of [
      "PIPELINE_ATTACHED",
      "PIPELINE_TERMINAL_FAILED",
      "LIFECYCLE_INACTIVE",
      "INVARIANT_REJECTED",
      "NOT_APPLICABLE",
      "STALE",
    ] as const) {
      const skipped = fixture([{ result, media }]);
      expect((await skipped.worker.reconcile(candidate)).result).toBe(result);
      expect(skipped.enqueue).not.toHaveBeenCalled();
      expect(skipped.create).not.toHaveBeenCalled();
    }
  });
  it("unknown/rollback failure stops without compensation; fresh instance observes committed T1/T2", async () => {
    for (const error of [
      new CommitOutcomeUnknownError(),
      new TransactionRollbackFailedError(),
      new Error("db"),
    ]) {
      for (const step of ["create", "enqueue"] as const) {
        const f = fixture(
          step === "create"
            ? [{ result: "MISSING_MEDIA" }]
            : [{ result: "MISSING_PROBE", media }],
        );
        f[step].mockRejectedValueOnce(error);
        await expect(f.worker.reconcile(candidate)).rejects.toBe(error);
        expect(f[step]).toHaveBeenCalledTimes(1);
        expect(f.close).toHaveBeenCalledTimes(1);
        const restarted = fixture(
          step === "create"
            ? [
                { result: "MISSING_PROBE", media },
                { result: "PIPELINE_ATTACHED", media },
              ]
            : [{ result: "PIPELINE_ATTACHED", media }],
        );
        await restarted.worker.reconcile(candidate);
        expect(restarted.create).not.toHaveBeenCalled();
        expect(restarted.enqueue).toHaveBeenCalledTimes(
          step === "create" ? 1 : 0,
        );
      }
    }
  });
  it("rejects malformed K before acquisition and defers only proven contention", async () => {
    const f = fixture([]);
    expect(
      (await f.worker.reconcile({ ...candidate, expectedSha256Hex: "" }))
        .result,
    ).toBe("INVARIANT_REJECTED");
    expect(f.acquire).not.toHaveBeenCalled();
    f.acquire.mockRejectedValueOnce(new Error("COORD_ACQUIRE_TIMEOUT"));
    expect((await f.worker.reconcile(candidate)).result).toBe("DEFERRED");
    f.acquire.mockRejectedValueOnce(new Error("COORD_NAMESPACE_INVALID"));
    await expect(f.worker.reconcile(candidate)).rejects.toThrow(
      "COORD_NAMESPACE_INVALID",
    );
  });
  it("defers only confirmed rollback contention and stops on fatal driver or guard-release uncertainty", async () => {
    for (const code of ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]) {
      const f = fixture([]);
      f.repository.observeUploadPipeline.mockRejectedValueOnce(
        Object.assign(new Error("TRANSIENT"), { code }),
      );
      expect((await f.worker.reconcile(candidate)).result).toBe("DEFERRED");
      expect(f.create).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
      f.repository.observeUploadPipeline.mockResolvedValueOnce({
        result: "PIPELINE_ATTACHED",
      });
      expect((await f.worker.reconcile(candidate)).result).toBe(
        "PIPELINE_ATTACHED",
      );
    }
    const fatal = fixture([]);
    fatal.repository.observeUploadPipeline.mockRejectedValueOnce(
      Object.assign(new Error("UNCERTAIN"), {
        code: "ER_LOCK_DEADLOCK",
        fatal: true,
      }),
    );
    await expect(fatal.worker.reconcile(candidate)).rejects.toThrow(
      "UNCERTAIN",
    );
    await expect(fatal.worker.reconcile(candidate)).rejects.toThrow(
      "PIPELINE_STOPPED_RESTART_REQUIRED",
    );
    const close = fixture([{ result: "PIPELINE_ATTACHED" }]);
    close.close.mockImplementationOnce(() => {
      throw new Error("GUARD_CLOSE_FAILED");
    });
    await expect(close.worker.reconcile(candidate)).rejects.toThrow(
      "GUARD_CLOSE_FAILED",
    );
    await expect(close.worker.reconcile(candidate)).rejects.toThrow(
      "PIPELINE_STOPPED_RESTART_REQUIRED",
    );
  });
  it("generation/lifecycle drift after enqueue is stale rather than a second enqueue", async () => {
    for (const change of [
      { generation: "2" },
      { lifecycleRevision: "2" },
      { recipeId: 2 },
    ]) {
      const f = fixture([
        { result: "MISSING_PROBE", media },
        { result: "PIPELINE_ATTACHED", media: { ...media, ...change } },
      ]);
      expect((await f.worker.reconcile(candidate)).result).toBe("STALE");
      expect(f.enqueue).toHaveBeenCalledTimes(1);
    }
  });
  it("advances poisoned/deferred low IDs across more than two bounded pages, fixes high water and cools down", async () => {
    const f = fixture([]),
      all = Array.from({ length: 61 }, (_, n) => ({
        ...candidate,
        uploadId: String(n + 1),
      }));
    f.repository.listUploadPipelinePage.mockImplementation(
      async ({ afterId, throughId }) =>
        all
          .filter(
            (c) =>
              BigInt(c.uploadId) > BigInt(afterId) &&
              BigInt(c.uploadId) <= BigInt(throughId),
          )
          .slice(0, 20),
    );
    f.repository.observeUploadPipeline.mockImplementation(async (c) => ({
      result: c.uploadId === "1" ? "INVARIANT_REJECTED" : "PIPELINE_ATTACHED",
    }));
    for (let n = 0; n < 5; n++) await f.worker.page();
    expect(f.repository.readUploadPipelineHighWater).toHaveBeenCalledTimes(1);
    expect(
      f.repository.listUploadPipelinePage.mock.calls.map((c) => c[0].afterId),
    ).toEqual(["0", "20", "40", "60", "61"]);
    expect(f.repository.observeUploadPipeline).toHaveBeenCalledTimes(61);
    expect(f.wait.mock.calls.map((c) => c[0])).toEqual([
      250, 250, 250, 250, 30000,
    ]);
    await f.worker.page();
    expect(f.repository.readUploadPipelineHighWater).toHaveBeenCalledTimes(2);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("next round catches a lower ID completed late and limits continuous higher IDs to the fixed high water", async () => {
    const f = fixture([]);
    let completeLow = false;
    let high = "41";
    f.repository.readUploadPipelineHighWater.mockImplementation(
      async () => high,
    );
    f.repository.listUploadPipelinePage.mockImplementation(
      async ({ afterId, throughId }) =>
        Array.from({ length: 80 }, (_, n) => ({
          ...candidate,
          uploadId: String(n + 1),
        }))
          .filter(
            (c) =>
              (c.uploadId !== "1" || completeLow) &&
              BigInt(c.uploadId) > BigInt(afterId) &&
              BigInt(c.uploadId) <= BigInt(throughId),
          )
          .slice(0, 20),
    );
    f.repository.observeUploadPipeline.mockImplementation(async () => ({
      result: "PIPELINE_ATTACHED",
    }));
    await f.worker.page();
    completeLow = true;
    high = "80";
    await f.worker.page();
    await f.worker.page();
    expect(
      f.repository.observeUploadPipeline.mock.calls.map((c) => c[0].uploadId),
    ).not.toContain("1");
    expect(
      f.repository.observeUploadPipeline.mock.calls.map((c) => c[0].uploadId),
    ).not.toContain("42");
    await f.worker.page();
    expect(
      f.repository.observeUploadPipeline.mock.calls.map((c) => c[0].uploadId),
    ).toContain("1");
    expect(f.repository.readUploadPipelineHighWater).toHaveBeenCalledTimes(2);
  });
  it("stop drains an in-flight observation, selects no further candidate, and interrupts idle", async () => {
    const f = fixture([]);
    let resolve!: (o: UploadPipelineObservation) => void;
    f.repository.listUploadPipelinePage.mockResolvedValue([
      candidate,
      { ...candidate, uploadId: "2" },
    ]);
    f.repository.observeUploadPipeline.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const completion = f.worker.start();
    while (!resolve) await new Promise((r) => setTimeout(r, 1));
    f.worker.requestStop();
    resolve({ result: "PIPELINE_ATTACHED", media });
    await completion;
    await f.worker.drain();
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
