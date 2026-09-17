import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UploadRepositoryError, type UploadRecord } from "@family-album/db";
import { StorageRoot } from "@family-album/storage";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import { UploadService, type UploadRepository } from "./service.js";

const origin = "https://localhost:3000";
const uploadId = "c".repeat(32);

describe("Phase 3C Fastify PATCH adapter", () => {
  let fixture: string;
  let root: StorageRoot;
  let current: UploadRecord;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    fixture = mkdtempSync(join(realpathSync(tmpdir()), "phase3c-http-"));
    root = StorageRoot.open(join(fixture, "media"), { initialize: true });
    root.createUploadPayload("1", uploadId, Buffer.from("data"));
    current = record();
    const repository: UploadRepository = {
      admissionUsage: vi.fn(async () => ({
        reservedFutureBytes: 0n,
        retainedStagingBytes: 0n,
        outstanding: 0n,
        stored: 0n,
      })),
      createUpload: vi.fn(async () => current),
      inspect: vi.fn(async (input) => {
        if (
          input.expectedOffset !== undefined &&
          input.expectedOffset !== current.committedOffset
        ) {
          throw new UploadRepositoryError(
            "OFFSET_MISMATCH",
            current.committedOffset,
          );
        }
        return current;
      }),
      advanceOffset: vi.fn(async (input) => {
        current = {
          ...current,
          committedOffset: input.expectedOffset + input.durableBytes,
          state: "UPLOADING",
        };
        return current;
      }),
      abort: vi.fn(async () => ({ upload: current, changed: false })),
      markCleaned: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      trustedState: vi.fn(async () => current),
      assertFinalizeDurability: vi.fn(async () => undefined),
      beginFinalize: vi.fn(async (input) => {
        current = {
          ...current,
          state: "FINALIZING",
          computedSha256: input.sha256,
          finalizeStartedAt: new Date(),
        };
        return current;
      }),
      findStorageObject: vi.fn(async () =>
        current.state === "COMPLETE"
          ? {
              id: "1",
              sha256: current.computedSha256!,
              byteSize: current.declaredSize,
              keyVersion: 1,
              state: "AVAILABLE" as const,
            }
          : null,
      ),
      markStorageIntegrityIssue: vi.fn(async () => undefined),
      completeFinalize: vi.fn(async () => {
        current = {
          ...current,
          state: "COMPLETE",
          storageObjectId: "1",
          completedAt: new Date(),
        };
        return current;
      }),
    };
    const authService = {
      authenticate: vi.fn(async () => authContext()),
    } as unknown as AuthService;
    app = createApp({
      authService,
      uploadService: new UploadService(repository, {
        state: "READ_WRITE",
        root,
      }),
      trustedOrigins: new Set([origin]),
      publicApiOrigin: "https://localhost:4000",
    });
  });

  afterEach(async () => {
    await app.close();
    root.close();
    rmSync(fixture, { recursive: true, force: true });
  });

  it("returns the current trusted offset on 409 and resumes from it", async () => {
    const conflict = await patch("0", "more");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.headers["upload-offset"]).toBe("4");
    expect(conflict.json()).toMatchObject({ code: "OFFSET_MISMATCH" });

    const resumed = await patch("4", "more");
    expect(resumed.statusCode).toBe(204);
    expect(resumed.headers["upload-offset"]).toBe("8");
    expect(current).toMatchObject({ committedOffset: 8n, state: "UPLOADING" });
  });

  it("requires strict JSON and exact Origin, then returns only the upload's own durable receipt", async () => {
    current = { ...current, declaredSize: 4n, committedOffset: 4n };
    const base = {
      method: "POST" as const,
      url: `/api/v1/uploads/${uploadId}/finalize`,
      headers: {
        origin,
        cookie: "__Host-family_session=synthetic",
        "content-type": "application/json",
      },
    };
    const bodyAttack = await app.inject({
      ...base,
      payload: { role: "SUPER_ADMIN" },
    });
    expect(bodyAttack.statusCode).toBe(400);
    const fakeHash = await app.inject({
      ...base,
      payload: { sha256: "fake" },
    });
    expect(fakeHash.statusCode).toBe(400);
    const originAttack = await app.inject({
      ...base,
      headers: { ...base.headers, origin: "https://evil.invalid" },
      payload: {},
    });
    expect(originAttack.statusCode).toBe(403);
    const success = await app.inject({ ...base, payload: {} });
    expect(success.statusCode).toBe(200);
    expect(success.json()).toMatchObject({
      uploadId,
      state: "COMPLETE",
      committedOffset: "4",
    });
    expect(Object.keys(success.json()).sort()).toEqual([
      "committedOffset",
      "completedAt",
      "state",
      "uploadId",
    ]);
    expect(success.headers["cache-control"]).toBe("no-store");
    const retry = await app.inject({ ...base, payload: {} });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(success.json());
  });

  function patch(offset: string, payload: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/uploads/tus/${uploadId}`,
      headers: {
        origin,
        cookie: "__Host-family_session=synthetic",
        "tus-resumable": "1.0.0",
        "upload-offset": offset,
        "content-type": "application/offset+octet-stream",
      },
      payload: Buffer.from(payload),
    });
  }
});

function record(): UploadRecord {
  return {
    id: "1",
    publicId: uploadId,
    familyId: "1",
    createdByMemberId: "1",
    declaredSize: 8n,
    committedOffset: 4n,
    state: "UPLOADING",
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    completedAt: null,
    computedSha256: null,
    finalizeStartedAt: null,
    storageObjectId: null,
    failureCode: null,
    stagingCleanedAt: null,
  };
}

function authContext() {
  const now = new Date();
  return {
    identity: {
      sessionId: "1",
      userId: "1",
      username: "synthetic",
      displayName: null,
      passwordHash: "synthetic",
      clientType: "WEB" as const,
      authenticatedAt: now,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null,
      disabledAt: null,
      serverNow: now,
    },
    tokenHash: Buffer.alloc(32, 1),
  };
}
