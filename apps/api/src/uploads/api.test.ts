import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadRecord } from "@family-album/db";
import { StorageRoot } from "@family-album/storage";

import type { AuthContext } from "../auth/service.js";
import { createTusProtocol } from "./protocol.js";
import { UploadService, type UploadRepository } from "./service.js";

const origin = "https://localhost:3000";

describe("Phase 3C tus protocol", () => {
  let fixture: string;
  let root: StorageRoot;
  let current: UploadRecord | undefined;
  let protocol: ReturnType<typeof createTusProtocol>;

  beforeEach(() => {
    current = undefined;
    fixture = mkdtempSync(join(realpathSync(tmpdir()), "phase3c-protocol-"));
    root = StorageRoot.open(join(fixture, "media"), { initialize: true });
    const repository: UploadRepository = {
      admissionUsage: vi.fn(async () => ({
        reservedFutureBytes: 0n,
        retainedStagingBytes: 0n,
        outstanding: 0n,
        stored: 0n,
      })),
      createUpload: vi.fn(async (input) => {
        current = record(input.publicId.toString("hex"), input.declaredSize);
        return current;
      }),
      inspect: vi.fn(async () => required(current)),
      advanceOffset: vi.fn(async (input) => {
        current = {
          ...required(current),
          committedOffset: input.expectedOffset + input.durableBytes,
          state: "UPLOADING",
        };
        return current;
      }),
      abort: vi.fn(async () => {
        current = { ...required(current), state: "ABORTED" };
        return { upload: current, changed: true };
      }),
      markCleaned: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      trustedState: vi.fn(async () => required(current)),
      assertFinalizeDurability: vi.fn(async () => undefined),
      beginFinalize: vi.fn(async () => required(current)),
      findStorageObject: vi.fn(async () => null),
      markStorageIntegrityIssue: vi.fn(async () => undefined),
      completeFinalize: vi.fn(async () => required(current)),
    };
    protocol = createTusProtocol({
      service: new UploadService(repository, { state: "READ_WRITE", root }),
      trustedOrigins: new Set([origin]),
      publicApiOrigin: "https://localhost:4000",
    });
  });

  afterEach(() => {
    root.close();
    rmSync(fixture, { recursive: true, force: true });
  });

  it("supports OPTIONS, creation, HEAD, conflict and resumable PATCH", async () => {
    const options = await protocol.server.handleWeb(
      request("OPTIONS", "/api/v1/uploads/tus"),
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("tus-version")).toContain("1.0.0");

    const metadata = `filename ${Buffer.from("synthetic.bin").toString("base64")},filetype ${Buffer.from("application/octet-stream").toString("base64")}`;
    const created = await withContext(
      { auth: authContext(), familyId: "1" },
      request("POST", "/api/v1/families/1/uploads/tus", {
        "tus-resumable": "1.0.0",
        "upload-length": "8",
        "upload-metadata": metadata,
      }),
    );
    expect(created.status).toBe(201);
    const location = new URL(created.headers.get("location")!).pathname;
    expect(location).toMatch(/^\/api\/v1\/uploads\/tus\/[0-9a-f]{32}$/u);

    const head = await withContext(
      { auth: authContext() },
      request("HEAD", location, { "tus-resumable": "1.0.0" }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("upload-offset")).toBe("0");
    expect(head.headers.get("upload-length")).toBe("8");
    expect(head.headers.get("upload-metadata")).toBeNull();

    const patched = await patch(location, "0", "data");
    expect(patched.status).toBe(204);
    expect(patched.headers.get("upload-offset")).toBe("4");

    const conflict = await patch(location, "0", "more");
    expect(conflict.status).toBe(409);
    const afterConflict = await withContext(
      { auth: authContext() },
      request("HEAD", location, { "tus-resumable": "1.0.0" }),
    );
    expect(afterConflict.headers.get("upload-offset")).toBe("4");

    const resumed = await patch(location, "4", "more");
    expect(resumed.status).toBe(204);
    expect(resumed.headers.get("upload-offset")).toBe("8");
    expect(current).toMatchObject({ committedOffset: 8n, state: "UPLOADING" });
  });

  it("rejects missing/wrong tus versions and oversized declarations", async () => {
    const metadata = `filename ${Buffer.from("synthetic.bin").toString("base64")}`;
    for (const version of [undefined, "0.2.2"] as const) {
      const response = await withContext(
        { auth: authContext(), familyId: "1" },
        request("POST", "/api/v1/families/1/uploads/tus", {
          ...(version ? { "tus-resumable": version } : {}),
          "upload-length": "1",
          "upload-metadata": metadata,
        }),
      );
      expect([400, 412]).toContain(response.status);
    }
    const oversized = await withContext(
      { auth: authContext(), familyId: "1" },
      request("POST", "/api/v1/families/1/uploads/tus", {
        "tus-resumable": "1.0.0",
        "upload-length": (32n * 1024n ** 3n + 1n).toString(),
        "upload-metadata": metadata,
      }),
    );
    expect(oversized.status).toBe(413);
    expect(current).toBeUndefined();
  });

  async function patch(path: string, offset: string, body: string) {
    return withContext(
      { auth: authContext() },
      request(
        "PATCH",
        path,
        {
          "tus-resumable": "1.0.0",
          "upload-offset": offset,
          "content-type": "application/offset+octet-stream",
        },
        body,
      ),
    );
  }

  function withContext(
    context: { auth: AuthContext; familyId?: string },
    value: Request,
  ) {
    return protocol.contexts.run(context, () =>
      protocol.server.handleWeb(value),
    );
  }
});

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
) {
  return new Request(`https://localhost:4000${path}`, {
    method,
    headers: { origin, ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

function required(value: UploadRecord | undefined): UploadRecord {
  if (!value) throw new Error("missing synthetic upload");
  return value;
}

function record(publicId: string, size: bigint): UploadRecord {
  return {
    id: "1",
    publicId,
    familyId: "1",
    createdByMemberId: "1",
    declaredSize: size,
    committedOffset: 0n,
    state: "CREATED",
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

function authContext(): AuthContext {
  const now = new Date();
  return {
    identity: {
      sessionId: "1",
      userId: "1",
      username: "synthetic",
      displayName: null,
      passwordHash: "synthetic",
      clientType: "WEB",
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
