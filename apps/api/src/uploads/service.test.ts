import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadRecord } from "@family-album/db";
import {
  CommitOutcomeUnknownError,
  UploadRepositoryError,
} from "@family-album/db";
import {
  buildUploadPayloadPath,
  StorageRoot,
  StorageSafetyError,
} from "@family-album/storage";

import type { AuthContext } from "../auth/service.js";
import {
  parseTusDecimal,
  parseUploadPublicId,
  UploadService,
  UploadServiceError,
  type UploadRepository,
} from "./service.js";

const uploadId = "a".repeat(32);
const context = {
  identity: {
    sessionId: "1",
    userId: "1",
    username: "synthetic",
    displayName: null,
    passwordHash: "synthetic",
    clientType: "WEB",
    authenticatedAt: new Date(),
    createdAt: new Date(),
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    disabledAt: null,
    serverNow: new Date(),
  },
  tokenHash: Buffer.alloc(32, 1),
} satisfies AuthContext;

describe("Phase 3C upload service", () => {
  let fixture: string;
  let root: StorageRoot;
  let current: UploadRecord | undefined;
  let repository: UploadRepository;
  let service: UploadService;

  beforeEach(() => {
    fixture = mkdtempSync(join(realpathSync(tmpdir()), "phase3c-service-"));
    root = StorageRoot.open(join(fixture, "media"), { initialize: true });
    repository = {
      admissionUsage: vi.fn(async () => ({
        reservedFutureBytes: 0n,
        retainedStagingBytes: 0n,
        outstanding: 0n,
        stored: 0n,
      })),
      createUpload: vi.fn(async (input) => {
        current = record({
          publicId: input.publicId.toString("hex"),
          familyId: input.familyId,
          declaredSize: input.declaredSize,
        });
        return current;
      }),
      inspect: vi.fn(async (input) => {
        if (!current) throw new Error("missing");
        if (
          input.expectedOffset !== undefined &&
          input.expectedOffset !== current.committedOffset
        ) {
          throw new Error("offset");
        }
        return current;
      }),
      advanceOffset: vi.fn(async (input) => {
        if (!current) throw new Error("missing");
        current = {
          ...current,
          committedOffset: input.expectedOffset + input.durableBytes,
          state: "UPLOADING",
        };
        return current;
      }),
      abort: vi.fn(async () => {
        if (!current) throw new Error("missing");
        current = { ...current, state: "ABORTED" };
        return { upload: current, changed: true };
      }),
      markCleaned: vi.fn(async () => {
        if (current) current = { ...current, stagingCleanedAt: new Date() };
      }),
      markFailed: vi.fn(async () => undefined),
      trustedState: vi.fn(async () => {
        if (!current) throw new Error("missing");
        return current;
      }),
      assertFinalizeDurability: vi.fn(async () => undefined),
      beginFinalize: vi.fn(async () => {
        if (!current) throw new Error("missing");
        return current;
      }),
      findStorageObject: vi.fn(async () => null),
      markStorageIntegrityIssue: vi.fn(async () => undefined),
      completeFinalize: vi.fn(async () => {
        if (!current) throw new Error("missing");
        return current;
      }),
    };
    service = new UploadService(repository, { state: "READ_WRITE", root });
  });

  afterEach(() => {
    root.close();
    rmSync(fixture, { recursive: true, force: true });
  });

  it("creates, resumes, reaches declared size without finalizing, and aborts", async () => {
    const created = await service.create(context, {
      familyId: "1",
      publicId: Buffer.from(uploadId, "hex"),
      declaredSize: 10n,
      filename: "../synthetic.jpg",
      reportedMime: "application/octet-stream",
    });
    expect(created.state).toBe("CREATED");
    expect(
      await service.head(context, Buffer.from(uploadId, "hex")),
    ).toMatchObject({
      committedOffset: 0n,
    });

    const first = await service.patch(
      context,
      Buffer.from(uploadId, "hex"),
      0n,
      Readable.from([Buffer.from("first")]),
    );
    expect(first.committedOffset).toBe(5n);
    const second = await service.patch(
      context,
      Buffer.from(uploadId, "hex"),
      5n,
      Readable.from([Buffer.from("tail!")]),
    );
    expect(second).toMatchObject({ committedOffset: 10n, state: "UPLOADING" });
    expect(
      readFileSync(
        join(root.canonicalPath, buildUploadPayloadPath("1", uploadId)),
      ),
    ).toEqual(Buffer.from("firsttail!"));
    expect(second.completedAt).toBeNull();

    await service.abort(context, Buffer.from(uploadId, "hex"));
    expect(current?.state).toBe("ABORTED");
    expect(repository.markCleaned).toHaveBeenCalledOnce();
  });

  it("keeps safe HEAD/status inspection in READ_ONLY while rejecting all storage mutations", async () => {
    current = record({
      publicId: uploadId,
      familyId: "1",
      declaredSize: 8n,
    });
    root.createUploadPayload("1", uploadId);
    const readonly = new UploadService(repository, {
      state: "READ_ONLY",
      reason: "MAINTENANCE",
      root,
    });
    expect(
      (await readonly.head(context, Buffer.from(uploadId, "hex"))).state,
    ).toBe("CREATED");
    expect(
      (await readonly.status(context, Buffer.from(uploadId, "hex"))).state,
    ).toBe("CREATED");
    expect(repository.inspect).toHaveBeenCalledWith(
      expect.objectContaining({ transitionExpiry: false }),
    );
    await expect(
      readonly.create(context, {
        familyId: "1",
        publicId: Buffer.from("b".repeat(32), "hex"),
        declaredSize: 8n,
        filename: "synthetic",
        reportedMime: null,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(
      readonly.patch(
        context,
        Buffer.from(uploadId, "hex"),
        0n,
        Readable.from(["bytes"]),
      ),
    ).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    await expect(
      readonly.abort(context, Buffer.from(uploadId, "hex")),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(
      readonly.finalize(context, Buffer.from(uploadId, "hex")),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(repository.advanceOffset).not.toHaveBeenCalled();
    expect(repository.abort).not.toHaveBeenCalled();
  });

  it("never advances DB offset when durable append fails", async () => {
    await service.create(context, {
      familyId: "1",
      publicId: Buffer.from(uploadId, "hex"),
      declaredSize: 4n,
      filename: "synthetic.bin",
      reportedMime: null,
    });
    root.truncateUploadPayload("1", uploadId, 0n);
    const payload = join(
      root.canonicalPath,
      buildUploadPayloadPath("1", uploadId),
    );
    rmSync(payload);
    await expect(
      service.patch(
        context,
        Buffer.from(uploadId, "hex"),
        0n,
        Readable.from([Buffer.from("data")]),
      ),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(current?.committedOffset).toBe(0n);
    expect(repository.advanceOffset).not.toHaveBeenCalled();
  });

  it("restores the DB-trusted prefix when DB advancement fails after durable append", async () => {
    await service.create(context, {
      familyId: "1",
      publicId: Buffer.from(uploadId, "hex"),
      declaredSize: 8n,
      filename: "synthetic.bin",
      reportedMime: null,
    });
    vi.mocked(repository.advanceOffset).mockRejectedValueOnce(
      new UploadRepositoryError("CONFLICT"),
    );
    await expect(
      service.patch(
        context,
        Buffer.from(uploadId, "hex"),
        0n,
        Readable.from([Buffer.from("data")]),
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_STATE_CONFLICT" });
    expect(root.inspectUploadPayload("1", uploadId)).toBe(0n);
    expect(current?.committedOffset).toBe(0n);
  });

  it("marks a payload shorter than the trusted offset as an integrity failure", async () => {
    await service.create(context, {
      familyId: "1",
      publicId: Buffer.from(uploadId, "hex"),
      declaredSize: 8n,
      filename: "synthetic.bin",
      reportedMime: null,
    });
    current = { ...current!, committedOffset: 4n, state: "UPLOADING" };
    await expect(
      service.head(context, Buffer.from(uploadId, "hex")),
    ).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    expect(repository.markFailed).toHaveBeenCalledWith(
      Buffer.from(uploadId, "hex"),
      "STAGING_INTEGRITY_MISMATCH",
    );
  });

  it("enforces the global active declared-size budget", async () => {
    vi.mocked(repository.admissionUsage).mockResolvedValueOnce({
      reservedFutureBytes: 128n * 1024n ** 3n,
      retainedStagingBytes: 0n,
      outstanding: 128n * 1024n ** 3n,
      stored: 0n,
    });
    await expect(
      service.create(context, {
        familyId: "1",
        publicId: Buffer.from(uploadId, "hex"),
        declaredSize: 1n,
        filename: "synthetic.bin",
        reportedMime: null,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(repository.createUpload).not.toHaveBeenCalled();
  });

  it("includes retained staging in the global budget without reserving written bytes twice on disk", async () => {
    vi.mocked(repository.admissionUsage).mockResolvedValueOnce({
      reservedFutureBytes: 0n,
      retainedStagingBytes: 64n * 1024n ** 3n,
      outstanding: 64n * 1024n ** 3n,
      stored: 0n,
    });
    const created = await service.create(context, {
      familyId: "1",
      publicId: Buffer.from(uploadId, "hex"),
      declaredSize: 1n,
      filename: "synthetic.bin",
      reportedMime: null,
    });
    expect(created.state).toBe("CREATED");
    expect(repository.createUpload).toHaveBeenCalledTimes(1);
  });

  it("fails closed when storage is unavailable", async () => {
    const unavailable = new UploadService(repository, {
      state: "UNAVAILABLE",
      reason: "synthetic",
    });
    await expect(
      unavailable.create(context, {
        familyId: "1",
        publicId: Buffer.from(uploadId, "hex"),
        declaredSize: 1n,
        filename: "x",
        reportedMime: null,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });

  it("uses strict bigint-safe public IDs and tus decimals", () => {
    expect(parseUploadPublicId(uploadId)).toEqual(Buffer.from(uploadId, "hex"));
    expect(() => parseUploadPublicId("A".repeat(32))).toThrow(
      UploadServiceError,
    );
    expect(parseTusDecimal("9007199254740993", "INVALID_REQUEST")).toBe(
      9007199254740993n,
    );
    expect(() => parseTusDecimal("01", "INVALID_REQUEST")).toThrow(
      UploadServiceError,
    );
  });

  it("bounds untrusted filename metadata without using it as a path", async () => {
    await expect(
      service.create(context, {
        familyId: "1",
        publicId: Buffer.from(uploadId, "hex"),
        declaredSize: 1n,
        filename: "x".repeat(256),
        reportedMime: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status_code: 400 });
    expect(repository.createUpload).not.toHaveBeenCalled();
  });

  it("does not publish after an unknown T-intent COMMIT and waits for an explicit read-based retry", async () => {
    const bytes = Buffer.from("phase3d unknown intent synthetic bytes");
    root.createUploadPayload("1", uploadId, bytes);
    current = record({
      state: "UPLOADING",
      declaredSize: BigInt(bytes.length),
      committedOffset: BigInt(bytes.length),
    });
    const publish = vi.spyOn(root, "publishOriginal");
    vi.mocked(repository.beginFinalize)
      .mockRejectedValueOnce(new CommitOutcomeUnknownError())
      .mockImplementation(async (input) => {
        current = {
          ...current!,
          state: "FINALIZING",
          computedSha256: input.sha256,
          finalizeStartedAt: new Date(),
        };
        return current;
      });
    vi.mocked(repository.completeFinalize).mockImplementation(async () => {
      current = {
        ...current!,
        state: "COMPLETE",
        storageObjectId: "1",
        completedAt: new Date(),
      };
      return current;
    });
    await expect(
      service.finalize(context, Buffer.from(uploadId, "hex")),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(repository.beginFinalize).toHaveBeenCalledTimes(1);
    expect(repository.completeFinalize).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(current.state).toBe("UPLOADING");
    await service.finalize(context, Buffer.from(uploadId, "hex"));
    expect(current.state).toBe("COMPLETE");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not replay an ambiguous T-complete COMMIT or republish its durable candidate", async () => {
    const bytes = Buffer.from("phase3d unknown completion synthetic bytes");
    root.createUploadPayload("1", uploadId, bytes);
    current = record({
      state: "UPLOADING",
      declaredSize: BigInt(bytes.length),
      committedOffset: BigInt(bytes.length),
    });
    const publish = vi.spyOn(root, "publishOriginal");
    vi.mocked(repository.beginFinalize).mockImplementation(async (input) => {
      current = {
        ...current!,
        state: "FINALIZING",
        computedSha256: input.sha256,
        finalizeStartedAt: new Date(),
      };
      return current;
    });
    vi.mocked(repository.completeFinalize)
      .mockRejectedValueOnce(new CommitOutcomeUnknownError())
      .mockImplementation(async () => {
        current = {
          ...current!,
          state: "COMPLETE",
          storageObjectId: "1",
          completedAt: new Date(),
        };
        return current;
      });
    await expect(
      service.finalize(context, Buffer.from(uploadId, "hex")),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(repository.completeFinalize).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(current.state).toBe("FINALIZING");
    await service.finalize(context, Buffer.from(uploadId, "hex"));
    expect(repository.completeFinalize).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(current.state).toBe("COMPLETE");
  });

  it("fails closed when a canonical DB object exists but its original is missing", async () => {
    const bytes = Buffer.from("phase3d missing object synthetic bytes");
    const sha = createHash("sha256").update(bytes).digest();
    root.createUploadPayload("1", uploadId, bytes);
    current = record({
      state: "UPLOADING",
      declaredSize: BigInt(bytes.length),
      committedOffset: BigInt(bytes.length),
    });
    vi.mocked(repository.beginFinalize).mockImplementation(async () => {
      current = {
        ...current!,
        state: "FINALIZING",
        computedSha256: sha,
        finalizeStartedAt: new Date(),
      };
      return current;
    });
    vi.mocked(repository.findStorageObject).mockResolvedValue({
      id: "99",
      sha256: sha,
      byteSize: BigInt(bytes.length),
      keyVersion: 1,
      state: "AVAILABLE",
    });
    await expect(
      service.finalize(context, Buffer.from(uploadId, "hex")),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(repository.markStorageIntegrityIssue).toHaveBeenCalledWith({
      familyId: "1",
      sha256: sha,
      byteSize: BigInt(bytes.length),
      state: "MISSING",
    });
    expect(repository.completeFinalize).not.toHaveBeenCalled();
  });

  it("does not dedupe to a corrupt canonical object or overwrite its original", async () => {
    const bytes = Buffer.from("phase3d corrupt object synthetic bytes");
    const sha = createHash("sha256").update(bytes).digest();
    const firstUpload = "b".repeat(32);
    root.createUploadPayload("1", firstUpload, bytes);
    root.publishOriginal({
      familyId: "1",
      uploadId: firstUpload,
      sha256Hex: sha.toString("hex"),
      byteSize: String(bytes.length),
    });
    root.createUploadPayload("1", uploadId, bytes);
    current = record({
      state: "UPLOADING",
      declaredSize: BigInt(bytes.length),
      committedOffset: BigInt(bytes.length),
    });
    vi.mocked(repository.beginFinalize).mockImplementation(async () => {
      current = {
        ...current!,
        state: "FINALIZING",
        computedSha256: sha,
        finalizeStartedAt: new Date(),
      };
      return current;
    });
    vi.mocked(repository.findStorageObject).mockResolvedValue({
      id: "99",
      sha256: sha,
      byteSize: BigInt(bytes.length),
      keyVersion: 1,
      state: "AVAILABLE",
    });
    const publish = vi.spyOn(root, "publishOriginal");
    vi.spyOn(root, "verifyOriginal").mockImplementation(() => {
      throw new StorageSafetyError("ORIGINAL_INTEGRITY_MISMATCH");
    });
    await expect(
      service.finalize(context, Buffer.from(uploadId, "hex")),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(repository.markStorageIntegrityIssue).toHaveBeenCalledWith({
      familyId: "1",
      sha256: sha,
      byteSize: BigInt(bytes.length),
      state: "CORRUPT",
    });
    expect(repository.completeFinalize).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not commit a receipt after the client disconnects before T-complete", async () => {
    const bytes = Buffer.from("phase3d disconnected synthetic candidate");
    root.createUploadPayload("1", uploadId, bytes);
    current = record({
      state: "UPLOADING",
      declaredSize: BigInt(bytes.length),
      committedOffset: BigInt(bytes.length),
    });
    vi.mocked(repository.beginFinalize).mockImplementation(async (input) => {
      current = {
        ...current!,
        state: "FINALIZING",
        computedSha256: input.sha256,
        finalizeStartedAt: new Date(),
      };
      return current;
    });
    vi.mocked(repository.completeFinalize).mockImplementation(async () => {
      current = {
        ...current!,
        state: "COMPLETE",
        storageObjectId: "1",
        completedAt: new Date(),
      };
      return current;
    });
    const nativePublish = root.publishOriginal.bind(root);
    let disconnected = false;
    const publish = vi
      .spyOn(root, "publishOriginal")
      .mockImplementation((input) => {
        const result = nativePublish(input);
        disconnected = true;
        return result;
      });
    await expect(
      service.finalize(
        context,
        Buffer.from(uploadId, "hex"),
        () => !disconnected,
      ),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(current.state).toBe("FINALIZING");
    expect(repository.completeFinalize).not.toHaveBeenCalled();
    publish.mockRestore();
    await service.finalize(context, Buffer.from(uploadId, "hex"));
    expect(current.state).toBe("COMPLETE");
  });
});

function record(overrides: Partial<UploadRecord> = {}): UploadRecord {
  return {
    id: "1",
    publicId: uploadId,
    familyId: "1",
    createdByMemberId: "1",
    declaredSize: 10n,
    committedOffset: 0n,
    state: "CREATED",
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    completedAt: null,
    computedSha256: null,
    finalizeStartedAt: null,
    storageObjectId: null,
    failureCode: null,
    stagingCleanedAt: null,
    ...overrides,
  };
}
