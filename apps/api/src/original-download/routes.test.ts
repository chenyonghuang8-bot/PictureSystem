import { EventEmitter } from "node:events";

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import {
  CommitOutcomeUnknownError,
  type OriginalDownloadRecord,
} from "@family-album/db";
import type { VerifiedOriginalDownload } from "@family-album/storage";

import { createApp } from "../app.js";
import type { AlbumService } from "../albums/service.js";
import type { AuthService } from "../auth/service.js";
import { OriginalDownloadLimiter } from "./limiter.js";
import {
  OriginalDownloadService,
  type OriginalDownloadReader,
} from "./service.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const record: OriginalDownloadRecord = {
  familyId: "1",
  albumId: "2",
  actorMemberId: "3",
  mediaId: "4",
  storageObjectId: "5",
  keyVersion: 1,
  sha256Hex: "a".repeat(64),
  byteSize: "11",
  sourceUploadId: "6",
  originalFilename: "家庭照片.jpg",
  detectedMime: "image/jpeg",
};

function authService() {
  return {
    authenticate: async () => ({
      identity: { userId: "7", sessionId: "8" },
      tokenHash: Buffer.alloc(32, 1),
    }),
  } as unknown as AuthService;
}

function repository(
  overrides: Partial<{
    prepareOriginalDownload: () => Promise<OriginalDownloadRecord>;
    recheckOriginalDownload: () => Promise<OriginalDownloadRecord>;
  }> = {},
) {
  return {
    prepareOriginalDownload:
      overrides.prepareOriginalDownload ?? (async () => record),
    recheckOriginalDownload:
      overrides.recheckOriginalDownload ?? (async () => record),
  };
}

function reader(bytes = Buffer.from("hello world")): OriginalDownloadReader {
  return {
    async withVerifiedDownload(_identity, { signal }, callback) {
      signal.throwIfAborted();
      let sent = false;
      const source = {
        async readNext() {
          if (sent) return { done: true } as const;
          sent = true;
          return { done: false, bytes, final: true } as const;
        },
        async cancel() {},
      } satisfies VerifiedOriginalDownload;
      return callback(source);
    },
  };
}

function app(service: OriginalDownloadService) {
  return createApp({
    authService: authService(),
    albumService: {} as AlbumService,
    originalDownloadService: service,
    trustedOrigins: new Set(["https://family.test"]),
  });
}

describe("private original download route", () => {
  it.each(["bytes=0-99", "bytes=-100", "bytes=0-10,20-30"])(
    "ignores Range %s and returns a full 200 attachment",
    async (range) => {
      const server = app(
        new OriginalDownloadService(repository() as never, reader()),
      );
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/albums/2/media/4/download/original",
        headers: {
          cookie: "__Host-family_session=token",
          range,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(Buffer.from("hello world"));
      expect(response.headers["content-length"]).toBe("11");
      expect(response.headers["content-type"]).toBe("image/jpeg");
      expect(response.headers["accept-ranges"]).toBe("none");
      expect(response.headers["content-range"]).toBeUndefined();
      expect(response.headers["content-disposition"]).toMatch(
        /^attachment; filename="media-4\.jpg"; filename\*=UTF-8''/u,
      );
      await server.close();
    },
  );

  it("does not expose an automatic HEAD shortcut", async () => {
    let calls = 0;
    const server = app(
      new OriginalDownloadService(
        repository({
          prepareOriginalDownload: async () => {
            calls += 1;
            return record;
          },
        }) as never,
        reader(),
      ),
    );
    const response = await server.inject({
      method: "HEAD",
      url: "/api/v1/albums/2/media/4/download/original",
      headers: { cookie: "__Host-family_session=token" },
    });
    expect([404, 405]).toContain(response.statusCode);
    expect(calls).toBe(0);
    await server.close();
  });

  it("does not enter storage when the client disconnects during initial authorization", async () => {
    const authorization = deferred<OriginalDownloadRecord>();
    const authorizationEntered = deferred<void>();
    let storageCalls = 0;
    let successHeaders = 0;
    let bodyBytes = 0;
    const limiter = new OriginalDownloadLimiter();
    const service = new OriginalDownloadService(
      repository({
        prepareOriginalDownload: async () => {
          authorizationEntered.resolve();
          return authorization.promise;
        },
      }) as never,
      {
        async withVerifiedDownload() {
          storageCalls += 1;
          throw new Error("storage must not start");
        },
      },
      limiter,
    );
    const rawRequest = Object.assign(new EventEmitter(), {
      aborted: false,
      destroyed: false,
    });
    const rawResponse = Object.assign(new EventEmitter(), {
      destroyed: false,
      writable: true,
      writableEnded: false,
      writableFinished: false,
      writeHead: () => {
        successHeaders += 1;
      },
      write: (bytes: Buffer) => {
        bodyBytes += bytes.length;
        return true;
      },
    });
    const pending = service.download(
      {
        identity: { userId: "7", sessionId: "8" } as never,
        tokenHash: Buffer.alloc(32, 1),
      },
      { albumId: "2", mediaId: "4" },
      { raw: rawRequest } as unknown as FastifyRequest,
      { raw: rawResponse } as unknown as FastifyReply,
    );
    void pending.catch(() => undefined);
    await authorizationEntered.promise;
    rawRequest.aborted = true;
    rawRequest.destroyed = true;
    rawResponse.destroyed = true;
    rawResponse.writable = false;
    rawRequest.emit("aborted");
    rawResponse.emit("close");
    authorization.resolve(record);
    await expect(pending).rejects.toMatchObject({ statusCode: 503 });
    expect(storageCalls).toBe(0);
    expect(successHeaders).toBe(0);
    expect(bodyBytes).toBe(0);
    expect(limiter.snapshot()).toEqual({ active: 0, activeMembers: 0 });
    expect(rawRequest.listenerCount("aborted")).toBe(0);
    expect(rawResponse.listenerCount("error")).toBe(0);
    expect(rawResponse.listenerCount("close")).toBe(0);
  });

  it("checks current connection state before capacity and storage admission", async () => {
    let storageCalls = 0;
    const limiter = new OriginalDownloadLimiter();
    const rawRequest = Object.assign(new EventEmitter(), {
      aborted: false,
      destroyed: false,
    });
    const rawResponse = Object.assign(new EventEmitter(), {
      destroyed: false,
      writable: true,
      writableEnded: false,
      writableFinished: false,
    });
    const service = new OriginalDownloadService(
      repository({
        prepareOriginalDownload: async () => {
          rawResponse.destroyed = true;
          rawResponse.writable = false;
          return record;
        },
      }) as never,
      {
        async withVerifiedDownload() {
          storageCalls += 1;
          throw new Error("storage must not start");
        },
      },
      limiter,
    );
    await expect(
      service.download(
        {
          identity: { userId: "7", sessionId: "8" } as never,
          tokenHash: Buffer.alloc(32, 1),
        },
        { albumId: "2", mediaId: "4" },
        { raw: rawRequest } as unknown as FastifyRequest,
        { raw: rawResponse } as unknown as FastifyReply,
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(storageCalls).toBe(0);
    expect(limiter.snapshot()).toEqual({ active: 0, activeMembers: 0 });
    expect(rawRequest.listenerCount("aborted")).toBe(0);
    expect(rawResponse.listenerCount("error")).toBe(0);
    expect(rawResponse.listenerCount("close")).toBe(0);
  });

  it("fails closed before headers on a recheck COMMIT unknown", async () => {
    const server = app(
      new OriginalDownloadService(
        repository({
          recheckOriginalDownload: async () => {
            throw new CommitOutcomeUnknownError();
          },
        }) as never,
        reader(),
      ),
    );
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/albums/2/media/4/download/original",
      headers: { cookie: "__Host-family_session=token" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await server.close();
  });

  it("fails before headers when the first verified read fails", async () => {
    const failingReader: OriginalDownloadReader = {
      async withVerifiedDownload(_identity, _options, callback) {
        return callback({
          readNext: async () => {
            throw new Error("synthetic read failure");
          },
          cancel: async () => {},
        });
      },
    };
    const server = app(
      new OriginalDownloadService(repository() as never, failingReader),
    );
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/albums/2/media/4/download/original",
      headers: { cookie: "__Host-family_session=token" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await server.close();
  });

  it("aborts verification at its deadline and releases capacity after settlement", async () => {
    const limiter = new OriginalDownloadLimiter();
    const waitingReader: OriginalDownloadReader = {
      async withVerifiedDownload<T>(
        identity: { familyId: string; sha256Hex: string; byteSize: string },
        { signal }: { signal: AbortSignal },
      ) {
        void identity;
        return new Promise<T>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    };
    const server = app(
      new OriginalDownloadService(
        repository() as never,
        waitingReader,
        limiter,
        { verificationMs: 5, idleMs: 1_000, totalMs: 1_000 },
      ),
    );
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/albums/2/media/4/download/original",
      headers: { cookie: "__Host-family_session=token" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(limiter.snapshot()).toEqual({ active: 0, activeMembers: 0 });
    await server.close();
  });

  it.each([
    ["idle", { verificationMs: 1_000, idleMs: 5, totalMs: 1_000 }],
    ["total", { verificationMs: 1_000, idleMs: 1_000, totalMs: 5 }],
  ] as const)(
    "aborts a stalled first read on the %s transfer deadline",
    async (_name, timeouts) => {
      const stalledReader: OriginalDownloadReader = {
        async withVerifiedDownload(_identity, { signal }, callback) {
          return callback({
            readNext: async () =>
              new Promise<never>((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              }),
            cancel: async () => {},
          });
        },
      };
      const server = app(
        new OriginalDownloadService(
          repository() as never,
          stalledReader,
          new OriginalDownloadLimiter(),
          timeouts,
        ),
      );
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/albums/2/media/4/download/original",
        headers: { cookie: "__Host-family_session=token" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers["content-disposition"]).toBeUndefined();
      await server.close();
    },
  );

  it("terminates a binary response after a later read failure without appending JSON", async () => {
    let reads = 0;
    const failingReader: OriginalDownloadReader = {
      async withVerifiedDownload(_identity, _options, callback) {
        return callback({
          readNext: async () => {
            reads += 1;
            if (reads === 1) {
              return {
                done: false,
                bytes: Buffer.from("hello "),
                final: false,
              };
            }
            throw new Error("synthetic later read failure");
          },
          cancel: async () => {},
        });
      },
    };
    const server = app(
      new OriginalDownloadService(repository() as never, failingReader),
    );
    await expect(
      server.inject({
        method: "GET",
        url: "/api/v1/albums/2/media/4/download/original",
        headers: { cookie: "__Host-family_session=token" },
      }),
    ).rejects.toThrow("response destroyed before completion");
    expect(reads).toBe(2);
    await server.close();
  });

  it("returns 429 immediately for a second active request by one member", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const blockedReader: OriginalDownloadReader = {
      async withVerifiedDownload(_identity, { signal }, callback) {
        enter();
        await Promise.race([
          barrier,
          new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
        ]);
        return callback({
          readNext: async () => ({
            done: false,
            bytes: Buffer.from("hello world"),
            final: true,
          }),
          cancel: async () => {},
        });
      },
    };
    const limiter = new OriginalDownloadLimiter();
    const server = app(
      new OriginalDownloadService(
        repository() as never,
        blockedReader,
        limiter,
      ),
    );
    const first = server.inject({
      method: "GET",
      url: "/api/v1/albums/2/media/4/download/original",
      headers: { cookie: "__Host-family_session=token" },
    });
    await entered;
    const second = await server.inject({
      method: "GET",
      url: "/api/v1/albums/2/media/4/download/original",
      headers: { cookie: "__Host-family_session=token" },
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("1");
    release();
    expect((await first).statusCode).toBe(200);
    expect(limiter.snapshot()).toEqual({ active: 0, activeMembers: 0 });
    await server.close();
  });

  it("keeps the lease until client-abort storage cleanup settles", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let settleCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => (settleCleanup = resolve));
    const limiter = new OriginalDownloadLimiter();
    const abortingReader: OriginalDownloadReader = {
      async withVerifiedDownload(identity, { signal }) {
        void identity;
        enter();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await cleanup;
        throw signal.reason;
      },
    };
    const service = new OriginalDownloadService(
      repository() as never,
      abortingReader,
      limiter,
    );
    const rawRequest = new EventEmitter();
    const rawResponse = new EventEmitter();
    const pending = service.download(
      {
        identity: { userId: "7", sessionId: "8" } as never,
        tokenHash: Buffer.alloc(32, 1),
      },
      { albumId: "2", mediaId: "4" },
      { raw: rawRequest } as unknown as FastifyRequest,
      { raw: rawResponse } as unknown as FastifyReply,
    );
    void pending.catch(() => undefined);
    await entered;
    rawRequest.emit("aborted");
    await Promise.resolve();
    expect(limiter.snapshot()).toEqual({ active: 1, activeMembers: 1 });
    settleCleanup();
    await pending.catch(() => undefined);
    expect(limiter.snapshot()).toEqual({ active: 0, activeMembers: 0 });
  });
});
