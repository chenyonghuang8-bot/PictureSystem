import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  AlbumRepositoryError,
  CommitOutcomeUnknownError,
  type PreviewDownloadRecord,
} from "@family-album/db";

import { createApp } from "../app.js";
import type { AlbumService } from "../albums/service.js";
import type { AuthService } from "../auth/service.js";
import { PreviewDownloadLimiter } from "./limiter.js";
import {
  PreviewDownloadService,
  type PreviewDownloadReader,
} from "./service.js";

const bytes = Buffer.from("synthetic-preview-webp");
const sha256Hex = createHash("sha256").update(bytes).digest("hex");
const record: PreviewDownloadRecord = {
  familyId: "1",
  albumId: "2",
  actorMemberId: "3",
  mediaId: "4",
  storageObjectId: "5",
  sourceUploadId: "6",
  mediaGeneration: 7n,
  mediaRecipeId: 1,
  derivedAssetId: "8",
  derivedGeneration: 7n,
  derivedRecipeId: 1,
  kind: "PREVIEW",
  byteSize: BigInt(bytes.length),
  sha256Hex,
  outputMime: "image/webp",
  width: 80,
  height: 60,
  producerJobId: "9",
  producerLeaseEpoch: 2n,
  publishedAt: new Date("2026-09-30T00:00:00.000Z"),
  configuredPreviewRecipeId: 1,
};

function authService() {
  return {
    authenticate: vi.fn(async () => ({
      identity: { userId: "10", sessionId: "11" },
      tokenHash: Buffer.alloc(32, 1),
    })),
  } as unknown as AuthService;
}

function repository(
  overrides: Partial<{
    preparePreviewDownload: () => Promise<PreviewDownloadRecord>;
    recheckPreviewDownload: () => Promise<PreviewDownloadRecord>;
  }> = {},
) {
  return {
    preparePreviewDownload:
      overrides.preparePreviewDownload ?? (async () => record),
    recheckPreviewDownload:
      overrides.recheckPreviewDownload ?? (async () => record),
  };
}

function reader(payload = bytes): PreviewDownloadReader {
  return {
    async read(_identity, { signal }) {
      signal.throwIfAborted();
      return payload;
    },
  };
}

function app(service: PreviewDownloadService, authentication = authService()) {
  return {
    authentication,
    server: createApp({
      authService: authentication,
      albumService: {} as AlbumService,
      previewDownloadService: service,
      trustedOrigins: new Set(["https://family.test"]),
    }),
  };
}

function rawExchange() {
  const request = Object.assign(new EventEmitter(), {
    aborted: false,
    destroyed: false,
  });
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
    writableEnded: false,
    writableFinished: false,
    socket: Object.assign(new EventEmitter(), {
      destroyed: false,
      closed: false,
    }),
    writeHead: vi.fn(),
    destroy() {
      this.destroyed = true;
      this.writable = false;
    },
  });
  return {
    request,
    response,
    requestObject: { raw: request } as unknown as FastifyRequest,
    reply: {
      raw: response,
      hijack: vi.fn(),
    } as unknown as FastifyReply,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

class DelayedDestroyTransport extends Duplex {
  readonly writeEntered = deferred();
  readonly destroyEntered = deferred();
  readonly chunks: Buffer[] = [];
  terminal = false;
  heldBytes = 0;
  #writeCallback: ((error?: Error | null) => void) | undefined;
  #destroyCallback: ((error?: Error | null) => void) | undefined;

  constructor() {
    super({ highWaterMark: 16 });
    this.on("error", () => undefined);
    this.on("close", () => {
      this.terminal = true;
    });
  }

  override _read() {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    const copy = Buffer.from(chunk);
    this.chunks.push(copy);
    this.heldBytes += copy.length;
    this.#writeCallback = callback;
    this.writeEntered.resolve();
  }

  override _destroy(
    _error: Error | null,
    callback: (error?: Error | null) => void,
  ) {
    this.#destroyCallback = callback;
    this.destroyEntered.resolve();
  }

  failWrite() {
    const callback = this.#writeCallback;
    this.#writeCallback = undefined;
    callback?.(new Error("CONTROLLED_WRITE_FAILURE"));
  }

  releaseDestroy() {
    const writeCallback = this.#writeCallback;
    const destroyCallback = this.#destroyCallback;
    this.#writeCallback = undefined;
    this.#destroyCallback = undefined;
    this.heldBytes = 0;
    writeCallback?.(new Error("CONTROLLED_TRANSPORT_DESTROYED"));
    destroyCallback?.();
  }
}

class CountingLimiter extends PreviewDownloadLimiter {
  releaseCount = 0;

  override tryAcquire(familyId: string, memberId: string) {
    const lease = super.tryAcquire(familyId, memberId);
    if (!lease) return null;
    return {
      release: () => {
        this.releaseCount += 1;
        lease.release();
      },
    };
  }
}

function delayedTransportExchange() {
  const transport = new DelayedDestroyTransport();
  const socket = transport as unknown as Socket;
  const incoming = new IncomingMessage(socket);
  const response = new ServerResponse(incoming);
  response.assignSocket(socket);
  const request = Object.assign(new EventEmitter(), {
    aborted: false,
    destroyed: false,
  });
  return {
    transport,
    response,
    request,
    requestObject: { raw: request } as unknown as FastifyRequest,
    reply: {
      raw: response,
      hijack: vi.fn(),
    } as unknown as FastifyReply,
  };
}

describe("private preview download route", () => {
  it.each(["bytes=0-99", "bytes=-100", "bytes=0-10,20-30"])(
    "ignores Range %s and returns the full attachment",
    async (range) => {
      const { server } = app(
        new PreviewDownloadService(repository() as never, reader()),
      );
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/albums/2/media/4/download/preview",
        headers: { cookie: "__Host-family_session=token", range },
      });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(bytes);
      expect(response.headers["content-length"]).toBe(String(bytes.length));
      expect(response.headers["content-type"]).toBe("image/webp");
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["accept-ranges"]).toBe("none");
      expect(response.headers["content-range"]).toBeUndefined();
      expect(response.headers["content-disposition"]).toContain(
        'filename="media-4-preview.webp"',
      );
      await server.close();
    },
  );

  it("blocks automatic HEAD without auth, repository, reader or capacity", async () => {
    const prepare = vi.fn(async () => record);
    const read = vi.fn(async () => bytes);
    const limiter = new PreviewDownloadLimiter();
    const acquire = vi.spyOn(limiter, "tryAcquire");
    const { server, authentication } = app(
      new PreviewDownloadService(
        repository({ preparePreviewDownload: prepare }) as never,
        { read },
        limiter,
      ),
    );
    const response = await server.inject({
      method: "HEAD",
      url: "/api/v1/albums/2/media/4/download/preview",
      headers: { cookie: "__Host-family_session=token" },
    });
    expect([404, 405]).toContain(response.statusCode);
    expect(authentication.authenticate).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    await server.close();
  });

  it("does not combine a share-token query with a private session", async () => {
    const prepare = vi.fn(async () => record);
    const { server } = app(
      new PreviewDownloadService(
        repository({ preparePreviewDownload: prepare }) as never,
        reader(),
      ),
    );
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/albums/2/media/4/download/preview?token=public",
      headers: { cookie: "__Host-family_session=token" },
    });
    expect(response.statusCode).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
    await server.close();
  });

  it.each([
    {},
    { authorization: "Bearer public-share-token" },
    {
      cookie: "__Host-family_session=token",
      authorization: "Bearer another-token",
    },
  ])("requires only the private WEB cookie", async (headers) => {
    const prepare = vi.fn(async () => record);
    const { server } = app(
      new PreviewDownloadService(
        repository({ preparePreviewDownload: prepare }) as never,
        reader(),
      ),
    );
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/albums/2/media/4/download/preview",
      headers,
    });
    expect(response.statusCode).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
    await server.close();
  });

  it.each([
    ["wrong contents", Buffer.alloc(bytes.length, 9)],
    ["wrong length", Buffer.from("short")],
    ["zero bytes", Buffer.alloc(0)],
    ["oversized", Buffer.alloc(4_194_305)],
  ] as const)("rejects a final Buffer with %s", async (_name, payload) => {
    const recheck = vi.fn(async () => record);
    const { server } = app(
      new PreviewDownloadService(
        repository({ recheckPreviewDownload: recheck }) as never,
        reader(payload),
      ),
    );
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/albums/2/media/4/download/preview",
      headers: { cookie: "__Host-family_session=token" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(recheck).not.toHaveBeenCalled();
    await server.close();
  });

  it.each([
    new AlbumRepositoryError("NOT_FOUND"),
    new CommitOutcomeUnknownError(),
  ])(
    "fails before headers when second authorization rejects",
    async (error) => {
      const limiter = new PreviewDownloadLimiter();
      const { server } = app(
        new PreviewDownloadService(
          repository({
            recheckPreviewDownload: async () => {
              throw error;
            },
          }) as never,
          reader(),
          limiter,
        ),
      );
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/albums/2/media/4/download/preview",
        headers: { cookie: "__Host-family_session=token" },
      });
      expect([404, 503]).toContain(response.statusCode);
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(limiter.snapshot().active).toBe(0);
      await server.close();
    },
  );

  it("does not enter capacity/read after disconnect during authentication", async () => {
    let finishAuth!: (value: {
      identity: { userId: string; sessionId: string };
      tokenHash: Buffer;
    }) => void;
    const authPending = new Promise<{
      identity: { userId: string; sessionId: string };
      tokenHash: Buffer;
    }>((resolve) => (finishAuth = resolve));
    let prepareCalls = 0;
    let readCalls = 0;
    const limiter = new PreviewDownloadLimiter();
    const service = new PreviewDownloadService(
      repository({
        preparePreviewDownload: async () => {
          prepareCalls += 1;
          return record;
        },
      }) as never,
      {
        async read() {
          readCalls += 1;
          return bytes;
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
    });
    const pending = service.download(
      { albumId: "2", mediaId: "4" },
      { raw: rawRequest } as unknown as FastifyRequest,
      { raw: rawResponse } as unknown as FastifyReply,
      () => authPending as never,
    );
    void pending.catch(() => undefined);
    rawRequest.aborted = true;
    rawRequest.destroyed = true;
    rawResponse.destroyed = true;
    rawResponse.writable = false;
    rawRequest.emit("aborted");
    rawResponse.emit("close");
    finishAuth({
      identity: { userId: "10", sessionId: "11" },
      tokenHash: Buffer.alloc(32, 1),
    });
    await expect(pending).rejects.toMatchObject({ statusCode: 503 });
    expect(prepareCalls).toBe(0);
    expect(readCalls).toBe(0);
    expect(limiter.snapshot().active).toBe(0);
    expect(rawRequest.listenerCount("aborted")).toBe(0);
    expect(rawResponse.listenerCount("close")).toBe(0);
  });

  it("does not enter the native read after abort while a gate wait settles", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    let nativeReads = 0;
    const limiter = new PreviewDownloadLimiter();
    const service = new PreviewDownloadService(
      repository() as never,
      {
        async read(_identity, { signal }) {
          enter();
          await barrier;
          signal.throwIfAborted();
          nativeReads += 1;
          return bytes;
        },
      },
      limiter,
    );
    const exchange = rawExchange();
    const pending = service.download(
      { albumId: "2", mediaId: "4" },
      exchange.requestObject,
      exchange.reply,
      async () =>
        ({
          identity: { userId: "10", sessionId: "11" },
          tokenHash: Buffer.alloc(32, 1),
        }) as never,
    );
    void pending.catch(() => undefined);
    await entered;
    exchange.request.aborted = true;
    exchange.request.destroyed = true;
    exchange.request.emit("aborted");
    expect(limiter.snapshot().active).toBe(1);
    release();
    await expect(pending).rejects.toMatchObject({ statusCode: 503 });
    expect(nativeReads).toBe(0);
    expect(limiter.snapshot().active).toBe(0);
  });

  it("holds the capacity lease through write and finish settlement", async () => {
    const limiter = new PreviewDownloadLimiter();
    const exchange = rawExchange();
    let writeCallback!: (error?: Error) => void;
    let finish!: () => void;
    Object.assign(exchange.response, {
      write(_payload: Buffer, callback: (error?: Error) => void) {
        writeCallback = callback;
        return false;
      },
      end: () => {
        exchange.response.writableEnded = true;
        finish = () => {
          exchange.response.writableFinished = true;
          exchange.response.emit("finish");
        };
      },
    });
    const service = new PreviewDownloadService(
      repository() as never,
      reader(),
      limiter,
    );
    const pending = service.download(
      { albumId: "2", mediaId: "4" },
      exchange.requestObject,
      exchange.reply,
      async () =>
        ({
          identity: { userId: "10", sessionId: "11" },
          tokenHash: Buffer.alloc(32, 1),
        }) as never,
    );
    while (!writeCallback) await Promise.resolve();
    expect(limiter.snapshot().active).toBe(1);
    writeCallback();
    await Promise.resolve();
    expect(limiter.snapshot().active).toBe(1);
    exchange.response.emit("drain");
    while (!finish) await Promise.resolve();
    expect(limiter.snapshot().active).toBe(1);
    finish();
    await expect(pending).resolves.toMatchObject({ completed: true });
    expect(limiter.snapshot().active).toBe(0);
    expect(exchange.response.listenerCount("error")).toBe(0);
    expect(exchange.response.listenerCount("close")).toBe(0);
  });

  it.each([
    ["client abort", { idleMs: 1_000, totalMs: 2_000 }, "abort"],
    ["idle timeout", { idleMs: 5, totalMs: 2_000 }, "timeout"],
    ["total timeout", { idleMs: 2_000, totalMs: 5 }, "timeout"],
    ["write error", { idleMs: 1_000, totalMs: 2_000 }, "write-error"],
  ] as const)(
    "holds capacity until real transport settlement after %s",
    async (_name, timeouts, trigger) => {
      const payload = Buffer.alloc(4_194_304, 1);
      const downloadRecord = {
        ...record,
        byteSize: BigInt(payload.length),
        sha256Hex: createHash("sha256").update(payload).digest("hex"),
      };
      const limiter = new CountingLimiter();
      const exchange = delayedTransportExchange();
      let serviceSettled = false;
      const service = new PreviewDownloadService(
        {
          preparePreviewDownload: async () => downloadRecord,
          recheckPreviewDownload: async () => downloadRecord,
        } as never,
        reader(payload),
        limiter,
        timeouts,
      );
      const pending = service
        .download(
          { albumId: "2", mediaId: "4" },
          exchange.requestObject,
          exchange.reply,
          async () =>
            ({
              identity: { userId: "10", sessionId: "11" },
              tokenHash: Buffer.alloc(32, 1),
            }) as never,
        )
        .finally(() => {
          serviceSettled = true;
        });
      await exchange.transport.writeEntered.promise;
      if (trigger === "abort") {
        exchange.request.aborted = true;
        exchange.request.destroyed = true;
        exchange.request.emit("aborted");
      } else if (trigger === "write-error") {
        exchange.transport.failWrite();
      }
      await exchange.transport.destroyEntered.promise;

      expect(serviceSettled).toBe(false);
      expect(exchange.transport.terminal).toBe(false);
      expect(exchange.transport.heldBytes).toBeGreaterThan(0);
      expect(limiter.snapshot()).toEqual({
        active: 1,
        activeMembers: 1,
        memberCounts: [1],
      });
      expect(limiter.releaseCount).toBe(0);
      expect(
        Buffer.concat(exchange.transport.chunks).includes(
          Buffer.from('{"error"'),
        ),
      ).toBe(false);

      exchange.transport.releaseDestroy();
      await expect(pending).resolves.toMatchObject({
        completed: false,
        resultCategory: "TRANSFER_FAILED",
      });
      expect(exchange.transport.terminal).toBe(true);
      expect(limiter.snapshot()).toEqual({
        active: 0,
        activeMembers: 0,
        memberCounts: [],
      });
      expect(limiter.releaseCount).toBe(1);
      expect(exchange.request.listenerCount("aborted")).toBe(0);
      expect(exchange.response.listenerCount("error")).toBe(0);
      expect(exchange.response.listenerCount("close")).toBe(0);
    },
  );

  it("returns 429 with Retry-After when one member has two active reads", async () => {
    let enteredCount = 0;
    let notifyEntered!: () => void;
    const twoEntered = new Promise<void>(
      (resolve) => (notifyEntered = resolve),
    );
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const limiter = new PreviewDownloadLimiter();
    const blockedReader: PreviewDownloadReader = {
      async read(_identity, { signal }) {
        enteredCount += 1;
        if (enteredCount === 2) notifyEntered();
        await barrier;
        signal.throwIfAborted();
        return bytes;
      },
    };
    const { server } = app(
      new PreviewDownloadService(repository() as never, blockedReader, limiter),
    );
    const request = () =>
      server.inject({
        method: "GET",
        url: "/api/v1/albums/2/media/4/download/preview",
        headers: { cookie: "__Host-family_session=token" },
      });
    const first = request();
    const second = request();
    await twoEntered;
    const rejected = await request();
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("1");
    release();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(limiter.snapshot().active).toBe(0);
    await server.close();
  });
});
