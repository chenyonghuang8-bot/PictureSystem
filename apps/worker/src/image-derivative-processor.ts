import type { Phase4FailureCode } from "@family-album/contracts";
import type {
  BackgroundJobRecord,
  DerivedFenceView,
  LeaseFence,
  MySqlDerivedAdmissionRepository,
  MySqlDerivedAssetFence,
  MySqlJobRepository,
  ReadyFinalEvidence,
  WorkerIdentity,
} from "@family-album/db";
import { derivativeFailureDisposition } from "@family-album/db";
import type {
  CapacityGate,
  DerivedStore,
  StorageCapability,
  UnverifiedRenderedCandidate,
} from "@family-album/storage";
import {
  StorageSafetyError,
  isSealedDerivedOutput,
} from "@family-album/storage";

import {
  admitDerivedReservation,
  createOwnedDerivedTemp,
} from "./derived-admission.js";

const KINDS = ["THUMBNAIL", "PREVIEW"] as const;

export type DerivativeRunResult = {
  outcome:
    | "IDLE"
    | "STALE"
    | "COMMIT_UNKNOWN"
    | "PUBLISHING"
    | "READY"
    | "RETRY_WAIT"
    | "FAILED";
  failureCode?: Phase4FailureCode;
};

type Jobs = Pick<MySqlJobRepository, "claimNext" | "heartbeat">;

type RenderInput = {
  familyId: string;
  sha256Hex: string;
  byteSize: string;
  kind: "THUMBNAIL" | "PREVIEW";
};

/**
 * Orchestrates one claimed IMAGE_DERIVATIVES lease.
 * Filesystem publish is the existing primitive. READY is a later fenced
 * database transaction and does not serve bytes.
 */
export class ImageDerivativeProcessor {
  constructor(
    private readonly jobs: Jobs,
    private readonly admission: MySqlDerivedAdmissionRepository,
    private readonly assets: MySqlDerivedAssetFence,
    private readonly storage: {
      capability: StorageCapability & { state: "READ_WRITE" };
      gate: CapacityGate;
      store: DerivedStore;
    },
    private readonly render: (
      input: RenderInput,
    ) => Promise<UnverifiedRenderedCandidate>,
  ) {}

  async run(workerId: WorkerIdentity): Promise<DerivativeRunResult> {
    const job = await this.jobs.claimNext(workerId, {
      jobType: "IMAGE_DERIVATIVES",
    });
    if (!job) return { outcome: "IDLE" };
    return this.runClaimed(job, workerId);
  }

  async runClaimed(
    job: BackgroundJobRecord,
    workerId: WorkerIdentity,
  ): Promise<DerivativeRunResult> {
    const fence: LeaseFence = {
      familyId: job.familyId,
      mediaId: job.mediaId,
      jobId: job.id,
      generation: job.generation,
      workerId,
      leaseEpoch: job.leaseEpoch,
    };
    if ((await this.jobs.heartbeat(fence)).affectedRows !== 1) {
      return { outcome: "STALE" };
    }
    for (const kind of KINDS) {
      const step = await this.produce(fence, kind);
      if (step !== "PUBLISHED") return step;
    }
    return this.finishReady(fence);
  }

  private async produce(
    fence: LeaseFence,
    kind: "THUMBNAIL" | "PREVIEW",
  ): Promise<DerivativeRunResult | "PUBLISHED"> {
    const described = await this.assets.describe(fence);
    if (described === "UNKNOWN") return { outcome: "COMMIT_UNKNOWN" };
    if (described === null) return { outcome: "STALE" };
    const existing = described.assets.find((asset) => asset.kind === kind);
    if (existing?.state === "PUBLISHING") {
      if (existing.sha256Hex === null || existing.byteSize === null) {
        return await this.fail(fence, "DERIVED_INTEGRITY");
      }
      if (existing.producerLeaseEpoch !== fence.leaseEpoch) {
        const observed = await this.observeFinal(
          fence,
          kind,
          existing.sha256Hex,
          BigInt(existing.byteSize),
        );
        if (!observed) return { outcome: "STALE" };
        return "PUBLISHED";
      }
      const confirmed = await this.assets.confirmPublishing(fence, {
        kind,
        reservationId: existing.id,
        sha256Hex: existing.sha256Hex,
      });
      if (confirmed === "UNKNOWN") return { outcome: "COMMIT_UNKNOWN" };
      if (confirmed !== "COMMITTED") return { outcome: "STALE" };
      return "PUBLISHED";
    }
    if (existing && existing.state !== "RESERVED") {
      return await this.fail(fence, "DERIVED_INTEGRITY");
    }
    if (
      existing?.state === "RESERVED" &&
      existing.producerLeaseEpoch !== fence.leaseEpoch
    ) {
      const adopted = await this.assets.adoptReserved(fence, kind);
      if (adopted === "UNKNOWN") return { outcome: "COMMIT_UNKNOWN" };
      if (adopted !== "COMMITTED" && adopted !== "ALREADY") {
        return { outcome: "STALE" };
      }
    }
    const admitted = await admitDerivedReservation(
      this.storage.capability,
      this.storage.gate,
      this.admission,
      {
        ...fence,
        recipeId: 1,
        kind,
      },
    );
    if (admitted.result.transaction === "UNKNOWN" || admitted.permit === null) {
      if (admitted.result.transaction === "UNKNOWN") {
        return { outcome: "COMMIT_UNKNOWN" };
      }
      if (
        admitted.result.reason === "LEASE" ||
        admitted.result.reason === "COORDINATION" ||
        admitted.result.reservation === "UNRESOLVED"
      ) {
        return { outcome: "STALE" };
      }
      if (
        admitted.result.reason === "CAPACITY" ||
        admitted.result.reason === "INVENTORY"
      ) {
        return this.fail(fence, "TEMPORARY_IO");
      }
      return this.fail(fence, "DERIVED_INTEGRITY");
    }
    const reservationId = admitted.result.row?.id;
    if (!reservationId) return { outcome: "COMMIT_UNKNOWN" };
    let sealed: { consume: (store: DerivedStore) => void } | null = null;
    try {
      const candidate = await this.render({
        familyId: fence.familyId,
        sha256Hex: described.sha256Hex,
        byteSize: described.byteSize,
        kind,
      });
      if (candidate.kind !== kind || candidate.recipe !== 1) {
        return await this.fail(fence, "DERIVED_INTEGRITY");
      }
      const writer = await createOwnedDerivedTemp(
        this.storage.capability,
        this.storage.store,
        this.admission,
        admitted.permit,
        candidate,
      );
      const output = writer.seal(this.storage.capability, this.storage.store);
      sealed = output;
      const verified = output.verify(this.storage.store, {
        epoch: fence.leaseEpoch,
        kind,
      });
      const identity = output.identity();
      if (
        verified.sha256Hex !== identity.sha256Hex ||
        verified.sha256Hex !== candidate.sha256Hex ||
        !verified.staticImage
      ) {
        return await this.fail(fence, "DERIVED_INTEGRITY");
      }
      const publishing = await this.assets.markPublishing(fence, {
        kind,
        reservationId,
        sha256Hex: verified.sha256Hex,
        byteSize: identity.byteSize,
        width: verified.width,
        height: verified.height,
      });
      if (publishing === "UNKNOWN") return { outcome: "COMMIT_UNKNOWN" };
      if (publishing === "ALREADY") return "PUBLISHED";
      if (publishing !== "COMMITTED") return { outcome: "STALE" };
      const again = await this.assets.describe(fence);
      if (again === "UNKNOWN") return { outcome: "COMMIT_UNKNOWN" };
      if (!sameSource(again, described)) return { outcome: "STALE" };
      output.publish(this.storage.store, this.storage.capability, {
        familyId: fence.familyId,
        mediaId: fence.mediaId,
        generation: fence.generation,
        recipeId: 1,
        kind,
        jobId: fence.jobId,
        epoch: fence.leaseEpoch,
        reservationId,
      });
      sealed = null;
      const confirmed = await this.assets.confirmPublishing(fence, {
        kind,
        reservationId,
        sha256Hex: verified.sha256Hex,
      });
      if (confirmed === "UNKNOWN") return { outcome: "COMMIT_UNKNOWN" };
      if (confirmed !== "COMMITTED") return { outcome: "STALE" };
      return "PUBLISHED";
    } catch (error) {
      return await this.fail(fence, classifyDerivativeFailure(error));
    } finally {
      if (sealed && isSealedDerivedOutput(sealed)) {
        sealed.consume(this.storage.store);
      }
    }
  }

  private async finishReady(fence: LeaseFence): Promise<DerivativeRunResult> {
    const described = await this.assets.describe(fence);
    if (described === "UNKNOWN") return { outcome: "COMMIT_UNKNOWN" };
    if (described === null) return { outcome: "STALE" };
    const evidence: ReadyFinalEvidence[] = [];
    for (const kind of KINDS) {
      const asset = described.assets.find((item) => item.kind === kind);
      if (
        asset?.state !== "PUBLISHING" ||
        asset.sha256Hex === null ||
        asset.byteSize === null
      ) {
        return { outcome: "STALE" };
      }
      const observed = await this.observeFinal(
        fence,
        kind,
        asset.sha256Hex,
        BigInt(asset.byteSize),
      );
      if (!observed) return { outcome: "PUBLISHING" };
      evidence.push(observed);
    }
    const marked = await this.assets.commitSucceeded(fence, evidence);
    if (marked === "UNKNOWN") {
      return (await this.assets.readSucceeded(fence))
        ? { outcome: "READY" }
        : { outcome: "COMMIT_UNKNOWN" };
    }
    if (marked === "COMMITTED" || marked === "ALREADY") {
      return { outcome: "READY" };
    }
    return { outcome: "STALE" };
  }

  private async observeFinal(
    fence: LeaseFence,
    kind: "THUMBNAIL" | "PREVIEW",
    sha256Hex: string,
    byteSize: bigint,
  ): Promise<ReadyFinalEvidence | null> {
    const fact = await this.storage.gate.withLock(async () =>
      this.storage.gate.inspectDerivedFinal({
        familyId: fence.familyId,
        mediaId: fence.mediaId,
        generation: fence.generation,
        recipeId: 1,
        kind,
      }),
    );
    if (
      fact.fileClass !== "REGULAR" ||
      fact.mode !== 0o400 ||
      fact.nlink !== 1 ||
      fact.sha256Hex !== sha256Hex ||
      fact.byteSize !== byteSize ||
      !/^[1-9][0-9]*$/u.test(fact.device) ||
      !/^[1-9][0-9]*$/u.test(fact.inode)
    ) {
      return null;
    }
    return {
      kind,
      sha256Hex,
      byteSize,
      device: fact.device,
      inode: fact.inode,
    };
  }

  private async fail(
    fence: LeaseFence,
    code: Phase4FailureCode,
  ): Promise<DerivativeRunResult> {
    const disposition = derivativeFailureDisposition(code);
    if (disposition === "STOP") {
      return { outcome: "COMMIT_UNKNOWN", failureCode: code };
    }
    const ready: ReadyFinalEvidence[] = [];
    const described = await this.assets.describe(fence);
    if (described === "UNKNOWN") {
      return { outcome: "COMMIT_UNKNOWN", failureCode: code };
    }
    if (described) {
      for (const kind of KINDS) {
        const asset = described.assets.find((item) => item.kind === kind);
        if (
          asset?.state !== "PUBLISHING" ||
          asset.sha256Hex === null ||
          asset.byteSize === null
        ) {
          continue;
        }
        const observed = await this.observeFinal(
          fence,
          kind,
          asset.sha256Hex,
          BigInt(asset.byteSize),
        );
        if (observed) ready.push(observed);
      }
    }
    const marked = await this.assets.commitAttempt(fence, {
      failureCode: code,
      disposition,
      ready,
    });
    if (marked === "UNKNOWN") {
      return { outcome: "COMMIT_UNKNOWN", failureCode: code };
    }
    if (marked === "STALE") return { outcome: "STALE", failureCode: code };
    return { outcome: marked.jobState, failureCode: code };
  }
}

function sameSource(again: DerivedFenceView | null, before: DerivedFenceView) {
  return (
    again !== null &&
    again.sha256Hex === before.sha256Hex &&
    again.byteSize === before.byteSize &&
    again.recipeId === before.recipeId
  );
}

export function classifyDerivativeFailure(error: unknown): Phase4FailureCode {
  const reason =
    error instanceof StorageSafetyError
      ? error.reason
      : error instanceof Error
        ? error.message
        : "TEMPORARY_IO";
  if (reason.includes("TIMEOUT")) return "PROCESS_TIMEOUT";
  if (
    reason.includes("CAPABILITY") ||
    reason.includes("LAUNCH") ||
    reason.includes("BUSY") ||
    reason.includes("VERIFIER_UNAVAILABLE")
  ) {
    return "CAPABILITY_UNAVAILABLE";
  }
  if (reason.includes("OUTPUT_LIMIT")) return "OUTPUT_LIMIT";
  if (reason.includes("INPUT_LIMIT")) return "INPUT_LIMIT";
  if (reason.includes("ORIGINAL_MISSING")) return "ORIGINAL_MISSING";
  if (
    reason.includes("ORIGINAL_CORRUPT") ||
    reason.includes("RIFF") ||
    reason.includes("MALFORMED") ||
    reason.includes("CONTROL_INVALID") ||
    reason.includes("FORBIDDEN")
  ) {
    return "MALFORMED_MEDIA";
  }
  if (reason.includes("RESOURCE") || reason.includes("ENOSPC")) {
    return "RESOURCE_LIMIT";
  }
  if (reason.includes("READ_ONLY") || reason.includes("UNAVAILABLE")) {
    return "STORAGE_UNAVAILABLE";
  }
  if (
    reason.includes("INTEGRITY") ||
    reason.includes("CONFLICT") ||
    reason.includes("HASH")
  ) {
    return "DERIVED_INTEGRITY";
  }
  return "TEMPORARY_IO";
}
