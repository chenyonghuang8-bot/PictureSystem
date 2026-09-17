import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { UploadRepositoryError } from "@family-album/db";
import {
  buildOriginalPath,
  buildUploadPayloadPath,
  StorageRoot,
} from "@family-album/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UploadMutex } from "./mutex.js";
import { StorageReconciler } from "./recovery.js";
import { publicReconciliationReport } from "./recovery.js";
import { assessStorageStartup } from "./startup.js";

const UPLOAD = "a".repeat(32);
const OTHER = "b".repeat(32);

describe("Phase 3E bounded storage reconciliation safety", () => {
  let fixture: string;
  let root: StorageRoot;
  let repository: ReturnType<typeof fakeRepository>;

  beforeEach(() => {
    fixture = mkdtempSync(join(realpathSync(tmpdir()), "phase3e-unit-"));
    root = StorageRoot.open(join(fixture, "media"), { initialize: true });
    repository = fakeRepository();
  });

  afterEach(() => {
    root.close();
    expect(relative(realpathSync(tmpdir()), fixture)).toMatch(
      /^phase3e-unit-[^/]+$/u,
    );
    rmSync(fixture, { recursive: true, force: true });
    expect(existsSync(fixture)).toBe(false);
  });

  function scanner(capability = { state: "READ_WRITE" as const, root }) {
    return new StorageReconciler(
      repository as never,
      capability,
      new UploadMutex(),
    );
  }

  it("defaults to dry-run and never deletes an unlinked immutable original", async () => {
    const bytes = Buffer.from("synthetic-original");
    const sha = createHash("sha256").update(bytes).digest("hex");
    root.createUploadPayload("1", UPLOAD, bytes);
    root.publishOriginal({
      familyId: "1",
      uploadId: UPLOAD,
      sha256Hex: sha,
      byteSize: String(bytes.length),
    });
    const original = join(
      root.canonicalPath,
      buildOriginalPath("1", sha, String(bytes.length)),
    );
    const report = await scanner().run();
    expect(report.mode).toBe("dry-run");
    expect(report.orphanFinalCandidates).toBe(1);
    expect(report.finalizingAutoCompleted).toBe(0);
    expect(existsSync(original)).toBe(true);
    expect(repository.markStorageIntegrityIssue).not.toHaveBeenCalled();
  });

  it("distinguishes a verified frozen candidate from a late-page unknown original", async () => {
    const knownBytes = Buffer.from("known-candidate-only");
    const unknownBytes = Buffer.from("unknown-candidate-only");
    const knownSha = createHash("sha256").update(knownBytes).digest("hex");
    const unknownSha = createHash("sha256").update(unknownBytes).digest("hex");
    root.createUploadPayload("1", UPLOAD, knownBytes);
    root.publishOriginal({
      familyId: "1",
      uploadId: UPLOAD,
      sha256Hex: knownSha,
      byteSize: String(knownBytes.length),
    });
    root.createUploadPayload("1", OTHER, unknownBytes);
    root.publishOriginal({
      familyId: "1",
      uploadId: OTHER,
      sha256Hex: unknownSha,
      byteSize: String(unknownBytes.length),
    });
    repository.findFinalizingIntent.mockImplementation(async (input) =>
      input.sha256.equals(Buffer.from(knownSha, "hex")),
    );
    repository.trustedState.mockImplementation(
      async (publicId) =>
        ({
          publicId: publicId.toString("hex"),
          familyId: "1",
          state: "COMPLETE",
          stagingCleanedAt: new Date(),
        }) as never,
    );
    const assessed = await assessStorageStartup(
      repository as never,
      { state: "READ_WRITE", root },
      new UploadMutex(),
      { familyScope: "1" },
    );
    expect(assessed.report).toMatchObject({
      knownRecoverableFinalizingCandidates: 1,
      orphanFinalCandidates: 1,
      finalizingAutoCompleted: 0,
    });
    expect(assessed.capability.state).toBe("UNAVAILABLE");
    expect(
      existsSync(
        join(
          root.canonicalPath,
          buildOriginalPath("1", knownSha, String(knownBytes.length)),
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          root.canonicalPath,
          buildOriginalPath("1", unknownSha, String(unknownBytes.length)),
        ),
      ),
    ).toBe(true);
    const safe = publicReconciliationReport(assessed.report!);
    expect(JSON.stringify(safe)).not.toContain(knownSha);
    expect(JSON.stringify(safe)).not.toContain(unknownSha);
    const continued = publicReconciliationReport({
      ...assessed.report!,
      nextOriginalKey: `1/${knownSha.slice(0, 2)}/${knownSha.slice(2, 4)}/${knownSha}-${knownBytes.length}`,
    });
    expect(continued.nextOriginalKey).toMatch(/^oc1_[A-Za-z0-9_-]{43}$/u);
    expect(
      publicReconciliationReport({
        ...assessed.report!,
        nextOriginalKey: continued.nextOriginalKey,
      }).nextOriginalKey,
    ).toBe(continued.nextOriginalKey);
  });

  it("completes startup recovery across 1,250 known terminal dirs and rejects a late unsafe entry", async () => {
    root.createUploadPayload("1", UPLOAD);
    root.removeUploadPayload("1", UPLOAD);
    const parent = join(root.canonicalPath, "uploads", "1");
    for (let index = 1; index <= 1_250; index++)
      mkdirSync(join(parent, index.toString(16).padStart(32, "0")), {
        mode: 0o700,
      });
    repository.trustedState.mockImplementation(
      async (publicId) =>
        ({
          publicId: publicId.toString("hex"),
          familyId: "1",
          state: "ABORTED",
          stagingCleanedAt: new Date(),
        }) as never,
    );
    const first = await assessStorageStartup(
      repository as never,
      { state: "READ_WRITE", root },
      new UploadMutex(),
      { familyScope: "1" },
    );
    expect(first.capability.state).toBe("READ_WRITE");
    expect(first.report?.truncated).toBe(false);
    expect(repository.trustedState).toHaveBeenCalledTimes(1_251);
    symlinkSync(fixture, join(parent, "f".repeat(32)));
    const second = await assessStorageStartup(
      repository as never,
      { state: "READ_WRITE", root },
      new UploadMutex(),
      { familyScope: "1" },
    );
    expect(second.report?.skippedUnsafeEntries).toBeGreaterThan(0);
    expect(second.capability.state).toBe("UNAVAILABLE");
  }, 30_000);

  it("requires explicit cleanup, 24-hour grace and a second DB proof for orphan staging", async () => {
    const path = join(root.canonicalPath, buildUploadPayloadPath("1", UPLOAD));
    root.createUploadPayload("1", UPLOAD, Buffer.from("orphan synthetic"));
    const fresh = await scanner().run({ mode: "cleanup-staging" });
    expect(fresh.orphanStagingCandidates).toBe(1);
    expect(existsSync(path)).toBe(true);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    utimesSync(path, old, old);
    const dry = await scanner().run();
    expect(dry.orphanStagingCandidates).toBe(1);
    expect(existsSync(path)).toBe(true);
    const cleaned = await scanner().run({ mode: "cleanup-staging" });
    expect(cleaned.stagingCleaned).toBe(1);
    expect(repository.trustedState).toHaveBeenCalledTimes(4);
    expect(existsSync(path)).toBe(false);
  });

  it("reports symlink anomalies without following or deleting their targets", async () => {
    root.createUploadPayload("1", OTHER, Buffer.from("known"));
    const target = join(fixture, "outside");
    symlinkSync(
      target,
      join(root.canonicalPath, "uploads", "1", OTHER, "surprise"),
    );
    const report = await scanner().run({ mode: "cleanup-staging" });
    expect(report.skippedUnsafeEntries).toBeGreaterThan(0);
    expect(
      existsSync(join(root.canonicalPath, buildUploadPayloadPath("1", OTHER))),
    ).toBe(true);
  });

  it("bounds each scan and resumes orphan candidates by validated logical cursor", async () => {
    root.createUploadPayload("1", UPLOAD, Buffer.from("first synthetic"));
    root.createUploadPayload("1", OTHER, Buffer.from("second synthetic"));
    const first = await scanner().run({ maxCandidates: 1 });
    expect(first.truncated).toBe(true);
    expect(first.orphanStagingCandidates).toBe(1);
    expect(first.nextStagingKey).toBe(`1/${UPLOAD}`);
    const second = await scanner().run({
      maxCandidates: 1,
      afterStagingKey: first.nextStagingKey,
    });
    expect(second.orphanStagingCandidates).toBe(1);
    expect(second.nextStagingKey).toBe(`1/${OTHER}`);
    await expect(
      scanner().run({ afterStagingKey: "../outside" }),
    ).rejects.toThrow(/RECOVERY_PLAN_INVALID/u);
  });

  it("accepts the empty controlled directory left by a known cleaned terminal receipt", async () => {
    root.createUploadPayload("1", UPLOAD);
    root.removeUploadPayload("1", UPLOAD);
    repository.trustedState.mockResolvedValueOnce({
      publicId: UPLOAD,
      familyId: "1",
      state: "ABORTED",
      stagingCleanedAt: new Date(),
    } as never);
    const report = await scanner().run();
    expect(report.skippedUnsafeEntries).toBe(0);
    expect(report.orphanStagingCandidates).toBe(0);
  });

  it("re-cleans a proven terminal staging residue without changing an already-cleaned timestamp", async () => {
    const path = join(root.canonicalPath, buildUploadPayloadPath("1", UPLOAD));
    root.createUploadPayload("1", UPLOAD, Buffer.from("residue"));
    const receipt = {
      publicId: UPLOAD,
      familyId: "1",
      state: "ABORTED",
      stagingCleanedAt: new Date(),
      finalizeStartedAt: null,
    };
    repository.trustedState.mockResolvedValueOnce(receipt as never);
    repository.systemRevalidate.mockResolvedValueOnce({
      upload: receipt,
      expiredTransitioned: false,
    } as never);
    const report = await scanner().run({ mode: "recover" });
    expect(report.terminalStagingResidue).toBe(1);
    expect(report.stagingCleaned).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(repository.markCleaned).toHaveBeenCalledOnce();
  });

  it("fails closed when DB readiness is unavailable and in READ_ONLY recovery mode", async () => {
    repository.assertRecoveryReadiness.mockRejectedValueOnce(
      new Error("synthetic DB outage"),
    );
    await expect(scanner().run({ mode: "cleanup-staging" })).rejects.toThrow();
    expect(repository.trustedState).not.toHaveBeenCalled();
    await expect(
      scanner({ state: "READ_ONLY", root, reason: "MAINTENANCE" } as never).run(
        { mode: "recover" },
      ),
    ).rejects.toThrow(/STORAGE_RECOVERY_READ_ONLY/u);
    expect(
      (
        await scanner({
          state: "READ_ONLY",
          root,
          reason: "MAINTENANCE",
        } as never).run()
      ).capability,
    ).toBe("READ_ONLY");
  });

  it("does not advance a DB object cursor past a deferred hash-budget candidate", async () => {
    const objects = Array.from({ length: 17 }, (_, position) => ({
      id: String(position + 1),
      familyId: "1",
      sha256: Buffer.alloc(32, position + 1),
      byteSize: 1n,
      keyVersion: 1,
      state: "AVAILABLE" as const,
    }));
    repository.scanStorageObjects.mockImplementation(async (afterId, limit) =>
      objects
        .filter((object) => BigInt(object.id) > BigInt(afterId))
        .slice(0, limit),
    );
    const first = await scanner().run({ familyScope: "1" });
    expect(first.truncated).toBe(true);
    expect(first.nextObjectId).toBe("16");
    expect(first.dbMissingFinal).toBe(16);
    const next = await scanner().run({
      familyScope: "1",
      afterObjectId: first.nextObjectId,
    });
    expect(next.nextObjectId).toBe("17");
    expect(next.dbMissingFinal).toBe(1);
  });
});

function fakeRepository() {
  return {
    assertRecoveryReadiness: vi.fn(async () => undefined),
    recoveryServerTime: vi.fn(async () => new Date()),
    scanUploads: vi.fn(async () => []),
    scanRecoveryUploads: vi.fn(async () => []),
    scanStorageObjects: vi.fn(
      async (afterId: string, limit: number): Promise<unknown[]> => {
        if (afterId.length === 0 || limit < 1)
          throw new Error("invalid test scan");
        return [];
      },
    ),
    trustedState: vi.fn(async (_publicId: Buffer) => {
      void _publicId;
      throw new UploadRepositoryError("NOT_FOUND");
    }),
    systemRevalidate: vi.fn(async () => {
      throw new Error("unexpected system revalidation");
    }),
    systemFailStaging: vi.fn(async () => undefined),
    markCleaned: vi.fn(async () => undefined),
    findStorageObject: vi.fn(async () => null),
    findFinalizingIntent: vi.fn(
      async (_input: {
        familyId: string;
        sha256: Buffer;
        byteSize: bigint;
      }) => {
        void _input;
        return false;
      },
    ),
    markStorageIntegrityIssue: vi.fn(async () => undefined),
  };
}
