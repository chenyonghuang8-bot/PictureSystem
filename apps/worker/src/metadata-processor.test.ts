import { CommitOutcomeUnknownError } from "@family-album/db";
import type { NormalizedMetadataResult } from "@family-album/media";
import type { OriginalReader } from "@family-album/storage";
import { StorageSafetyError } from "@family-album/storage";
import { describe, expect, it, vi } from "vitest";

import { MetadataProcessingService } from "./metadata-processor.js";

const fence = {
  familyId: "1",
  mediaId: "2",
  jobId: "3",
  generation: 1n,
  workerId: Buffer.alloc(16, 7),
  leaseEpoch: 1n,
};

const preparation = {
  familyId: "1",
  mediaId: "2",
  storageObjectId: "4",
  generation: 1n,
  recipeId: 1,
  sha256Hex: "a".repeat(64),
  byteSize: "123",
  keyVersion: 1,
  captureUpperBoundUtc: "2026-01-03T00:00:00.000Z",
};

const result: NormalizedMetadataResult = {
  parserStatus: "SUCCESS",
  detectedMediaType: "IMAGE",
  detectedMime: "image/jpeg",
  container: "JPEG",
  rawWidth: 10,
  rawHeight: 20,
  displayWidth: 20,
  displayHeight: 10,
  orientation: 6,
  isAnimated: false,
  capturedLocalAt: null,
  capturedAtUtc: null,
  captureOffsetMinutes: null,
  captureTimezoneKnown: false,
  captureTimeSource: "NONE",
  captureTimeStatus: "ABSENT",
  gpsLatitude: null,
  gpsLongitude: null,
  cameraMake: null,
  cameraModel: null,
  durationMs: null,
  rotationDegrees: null,
  videoCodec: null,
  warnings: [],
};

describe("metadata processing orchestration", () => {
  it("parses outside the repository transaction boundary and persists once", async () => {
    const calls: string[] = [];
    const repository = {
      prepare: vi.fn(async () => {
        calls.push("prepare");
        return preparation;
      }),
      persistResult: vi.fn(async () => {
        calls.push("persist");
        return { affectedRows: 1 as const };
      }),
      persistOperationalFailure: vi.fn(),
    };
    const runner = {
      probeMetadata: vi.fn(async () => {
        calls.push("parse");
        return result;
      }),
    };
    const service = new MetadataProcessingService(
      repository,
      runner,
      {} as OriginalReader,
    );
    await expect(service.process(fence)).resolves.toEqual({ affectedRows: 1 });
    expect(calls).toEqual(["prepare", "parse", "persist"]);
  });

  it("never replays persistence after COMMIT outcome becomes unknown", async () => {
    const persistResult = vi.fn(async () => {
      throw new CommitOutcomeUnknownError();
    });
    const service = new MetadataProcessingService(
      {
        prepare: vi.fn(async () => preparation),
        persistResult,
        persistOperationalFailure: vi.fn(),
      },
      { probeMetadata: vi.fn(async () => result) },
      {} as OriginalReader,
    );
    await expect(service.process(fence)).rejects.toBeInstanceOf(
      CommitOutcomeUnknownError,
    );
    expect(persistResult).toHaveBeenCalledOnce();
  });

  it("maps controlled runner failures without persisting raw error text", async () => {
    const persistOperationalFailure = vi.fn(async (_fence, failure) => ({
      affectedRows: 1 as const,
      failure,
    }));
    const service = new MetadataProcessingService(
      {
        prepare: vi.fn(async () => preparation),
        persistResult: vi.fn(),
        persistOperationalFailure,
      },
      {
        probeMetadata: vi.fn(async () => {
          throw new StorageSafetyError("PROBE_TIMEOUT");
        }),
      },
      {} as OriginalReader,
    );
    await service.process(fence);
    expect(persistOperationalFailure).toHaveBeenCalledWith(
      fence,
      preparation,
      "TIMEOUT",
    );
  });
});
