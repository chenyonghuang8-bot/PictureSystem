import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import type { OriginalDownloadRecord } from "@family-album/db";

import { createApp } from "../app.js";
import type { AlbumService } from "../albums/service.js";
import type { AuthService } from "../auth/service.js";
import { OriginalDownloadLimiter } from "./limiter.js";
import {
  OriginalDownloadService,
  type OriginalDownloadReader,
} from "./service.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const payload = Buffer.alloc(256 * 1024, 7);
const record: OriginalDownloadRecord = {
  lifecycleRevision: "1",
  familyId: "1",
  albumId: "2",
  actorMemberId: "3",
  mediaId: "4",
  storageObjectId: "5",
  keyVersion: 1,
  sha256Hex: "a".repeat(64),
  byteSize: String(payload.length),
  sourceUploadId: "6",
  originalFilename: "synthetic.jpg",
  detectedMime: "image/jpeg",
};

class DelayedDestroyTransport extends Duplex {
  readonly writeEntered = deferred();
  readonly destroyEntered = deferred();
  readonly chunks: Buffer[] = [];
  terminal = false;
  destroyStarted = false;
  heldBytes = 0;
  #writeCallback: ((error?: Error | null) => void) | undefined;
  #destroyCallback: ((error?: Error | null) => void) | undefined;

  constructor(private readonly events: string[]) {
    super({ highWaterMark: 16 });
    this.on("error", () => undefined);
    this.on("close", () => {
      this.terminal = true;
      this.events.push("transport-terminal");
    });
  }

  override _read() {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(Buffer.from(chunk));
    this.heldBytes += chunk.length;
    this.#writeCallback = callback;
    this.writeEntered.resolve();
  }

  override _destroy(
    _error: Error | null,
    callback: (error?: Error | null) => void,
  ) {
    this.destroyStarted = true;
    this.#destroyCallback = callback;
    this.events.push("transport-destroy");
    this.destroyEntered.resolve();
  }

  failWrite() {
    const callback = this.#writeCallback;
    this.#writeCallback = undefined;
    this.events.push("send-failure");
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

class CountingLimiter extends OriginalDownloadLimiter {
  releaseCount = 0;

  constructor(private readonly events: string[]) {
    super();
  }

  override tryAcquire(familyId: string, memberId: string) {
    const lease = super.tryAcquire(familyId, memberId);
    if (!lease) return null;
    return {
      release: () => {
        this.releaseCount += 1;
        this.events.push("limiter-release");
        lease.release();
      },
    };
  }
}

function controlledReader(events: string[], holdCleanup = true) {
  const cleanupStarted = deferred();
  const cleanupCanSettle = deferred();
  if (!holdCleanup) cleanupCanSettle.resolve();
  let cleanupSettled = false;
  const reader: OriginalDownloadReader = {
    async withVerifiedDownload(_identity, { signal }, callback) {
      const onAbort = () => events.push("send-failure");
      signal.addEventListener("abort", onAbort, { once: true });
      let sent = false;
      try {
        return await callback({
          async readNext() {
            if (sent) return { done: true } as const;
            sent = true;
            return { done: false, bytes: payload, final: true } as const;
          },
          async cancel() {},
        });
      } finally {
        signal.removeEventListener("abort", onAbort);
        events.push("native-cleanup-start");
        cleanupStarted.resolve();
        await cleanupCanSettle.promise;
        cleanupSettled = true;
        events.push("native-cleanup-settle");
      }
    },
  };
  return {
    reader,
    cleanupStarted: cleanupStarted.promise,
    releaseCleanup: () => cleanupCanSettle.resolve(),
    cleanupSettled: () => cleanupSettled,
  };
}

function exchange(events: string[]) {
  const transport = new DelayedDestroyTransport(events);
  const socket = transport as unknown as Socket;
  const incoming = new IncomingMessage(socket);
  const response = new ServerResponse(incoming);
  response.assignSocket(socket);
  const socketCloseBaseline = transport.listenerCount("close");
  const request = Object.assign(new EventEmitter(), {
    aborted: false,
    destroyed: false,
  });
  return {
    transport,
    socketCloseBaseline,
    response,
    request,
    requestObject: { raw: request } as unknown as FastifyRequest,
    reply: { raw: response, hijack() {} } as unknown as FastifyReply,
  };
}

function repository() {
  return {
    prepareOriginalDownload: async () => record,
    recheckOriginalDownload: async () => record,
  };
}

function context() {
  return {
    identity: { userId: "7", sessionId: "8" },
    tokenHash: Buffer.alloc(32, 1),
  } as never;
}

function download(
  service: OriginalDownloadService,
  current: ReturnType<typeof exchange>,
) {
  return service.download(
    context(),
    { albumId: "2", mediaId: "4" },
    current.requestObject,
    current.reply,
  );
}

function app(service: OriginalDownloadService) {
  const authentication = {
    authenticate: async () => context(),
  } as unknown as AuthService;
  return createApp({
    authService: authentication,
    albumService: {} as AlbumService,
    originalDownloadService: service,
    trustedOrigins: new Set(["https://family.test"]),
  });
}

function expectBefore(
  limiter: CountingLimiter,
  current: ReturnType<typeof exchange>,
  serviceSettled: boolean,
) {
  expect(serviceSettled).toBe(false);
  expect(current.transport.terminal).toBe(false);
  expect(
    current.transport.writableLength + current.transport.heldBytes,
  ).toBeGreaterThan(0);
  expect(limiter.snapshot()).toEqual({ active: 1, activeMembers: 1 });
  expect(limiter.releaseCount).toBe(0);
  expect(
    Buffer.concat(current.transport.chunks).includes(Buffer.from('{"error"')),
  ).toBe(false);
}

describe("Original post-header transport settlement", () => {
  it.each([
    [
      "client abort",
      { verificationMs: 1_000, idleMs: 1_000, totalMs: 2_000 },
      "abort",
    ],
    [
      "idle timeout",
      { verificationMs: 1_000, idleMs: 5, totalMs: 2_000 },
      "timeout",
    ],
    [
      "total timeout",
      { verificationMs: 1_000, idleMs: 2_000, totalMs: 5 },
      "timeout",
    ],
    [
      "write error",
      { verificationMs: 1_000, idleMs: 1_000, totalMs: 2_000 },
      "write-error",
    ],
  ] as const)(
    "keeps capacity through native and transport settlement after %s",
    async (_name, timeouts, trigger) => {
      const events: string[] = [];
      const limiter = new CountingLimiter(events);
      const controlled = controlledReader(events);
      const service = new OriginalDownloadService(
        repository() as never,
        controlled.reader,
        limiter,
        timeouts,
      );
      const current = exchange(events);
      let serviceSettled = false;
      const pending = download(service, current).finally(() => {
        serviceSettled = true;
      });
      await current.transport.writeEntered.promise;
      if (trigger === "abort") {
        current.request.aborted = true;
        current.request.destroyed = true;
        current.request.emit("aborted");
      } else if (trigger === "write-error") {
        current.transport.failWrite();
      }

      await controlled.cleanupStarted;
      expect(controlled.cleanupSettled()).toBe(false);
      if (trigger !== "write-error") {
        expect(current.transport.destroyStarted).toBe(false);
      }
      expectBefore(limiter, current, serviceSettled);

      controlled.releaseCleanup();
      await current.transport.destroyEntered.promise;
      expect(controlled.cleanupSettled()).toBe(true);
      expectBefore(limiter, current, serviceSettled);

      current.transport.releaseDestroy();
      await expect(pending).resolves.toMatchObject({
        completed: false,
        resultCategory: "TRANSFER_FAILED",
      });
      expect(current.transport.terminal).toBe(true);
      expect(limiter.snapshot()).toEqual({ active: 0, activeMembers: 0 });
      expect(limiter.releaseCount).toBe(1);
      expect(current.request.listenerCount("aborted")).toBe(0);
      expect(current.response.listenerCount("error")).toBe(0);
      expect(current.response.listenerCount("close")).toBe(0);
      expect(current.transport.listenerCount("close")).toBe(
        current.socketCloseBaseline,
      );
      expect(events.indexOf("native-cleanup-start")).toBeLessThan(
        events.indexOf("native-cleanup-settle"),
      );
      if (trigger !== "write-error") {
        expect(events.indexOf("native-cleanup-settle")).toBeLessThan(
          events.indexOf("transport-destroy"),
        );
      }
      expect(events.indexOf("native-cleanup-settle")).toBeLessThan(
        events.indexOf("transport-terminal"),
      );
      expect(events.indexOf("transport-destroy")).toBeLessThan(
        events.indexOf("transport-terminal"),
      );
      expect(events.indexOf("transport-terminal")).toBeLessThan(
        events.indexOf("limiter-release"),
      );
    },
  );

  it("rejects another same-member request until failed transport settlement", async () => {
    const events: string[] = [];
    const limiter = new CountingLimiter(events);
    const controlled = controlledReader(events, false);
    const service = new OriginalDownloadService(
      repository() as never,
      controlled.reader,
      limiter,
      { verificationMs: 1_000, idleMs: 1_000, totalMs: 2_000 },
    );
    const current = exchange(events);
    const pending = download(service, current);
    await current.transport.writeEntered.promise;
    current.request.aborted = true;
    current.request.destroyed = true;
    current.request.emit("aborted");
    await current.transport.destroyEntered.promise;

    const server = app(service);
    const rejected = await server.inject({
      method: "GET",
      url: "/api/v1/albums/2/media/4/download/original",
      headers: { cookie: "__Host-family_session=synthetic" },
    });
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("1");
    expect(limiter.snapshot()).toEqual({ active: 1, activeMembers: 1 });
    expect(limiter.releaseCount).toBe(0);

    current.transport.releaseDestroy();
    await expect(pending).resolves.toMatchObject({ completed: false });
    expect(limiter.snapshot()).toEqual({ active: 0, activeMembers: 0 });

    const accepted = await server.inject({
      method: "GET",
      url: "/api/v1/albums/2/media/4/download/original",
      headers: { cookie: "__Host-family_session=synthetic" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.rawPayload).toEqual(payload);
    expect(limiter.releaseCount).toBe(2);
    await server.close();
  });

  it("does not accumulate unaccounted transports across three aborts", async () => {
    const events: string[] = [];
    const limiter = new CountingLimiter(events);
    const controlled = controlledReader(events, false);
    const service = new OriginalDownloadService(
      repository() as never,
      controlled.reader,
      limiter,
    );
    let maximumUnaccounted = 0;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const current = exchange(events);
      let settled = false;
      const pending = download(service, current).finally(() => {
        settled = true;
      });
      await current.transport.writeEntered.promise;
      current.request.aborted = true;
      current.request.destroyed = true;
      current.request.emit("aborted");
      await current.transport.destroyEntered.promise;
      const unaccounted =
        current.transport.terminal || limiter.snapshot().active > 0 ? 0 : 1;
      maximumUnaccounted = Math.max(maximumUnaccounted, unaccounted);
      expect(settled).toBe(false);
      expect(limiter.tryAcquire("1", "3")).toBeNull();
      current.transport.releaseDestroy();
      await pending;
      expect(current.transport.terminal).toBe(true);
      expect(limiter.snapshot()).toEqual({ active: 0, activeMembers: 0 });
    }
    expect(maximumUnaccounted).toBe(0);
    expect(limiter.releaseCount).toBe(3);
  });

  it("keeps capacity until finish without waiting for a successful socket close", async () => {
    const events: string[] = [];
    const limiter = new CountingLimiter(events);
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writable: true,
      writableEnded: false,
      writableFinished: false,
      socket: Object.assign(new EventEmitter(), { destroyed: false }),
      writeHead() {},
      destroy() {},
    });
    const request = Object.assign(new EventEmitter(), {
      aborted: false,
      destroyed: false,
    });
    let writeCallback!: (error?: Error) => void;
    let finish!: () => void;
    Object.assign(response, {
      write(_bytes: Buffer, callback: (error?: Error) => void) {
        writeCallback = callback;
        return false;
      },
      end() {
        response.writableEnded = true;
        finish = () => {
          response.writableFinished = true;
          response.emit("finish");
        };
      },
    });
    const controlled = controlledReader(events, false);
    const service = new OriginalDownloadService(
      repository() as never,
      controlled.reader,
      limiter,
    );
    const pending = service.download(
      context(),
      { albumId: "2", mediaId: "4" },
      { raw: request } as unknown as FastifyRequest,
      { raw: response, hijack() {} } as unknown as FastifyReply,
    );
    while (!writeCallback) await Promise.resolve();
    expect(limiter.snapshot()).toEqual({ active: 1, activeMembers: 1 });
    writeCallback();
    response.emit("drain");
    while (!finish) await Promise.resolve();
    expect(limiter.snapshot()).toEqual({ active: 1, activeMembers: 1 });
    finish();
    await expect(pending).resolves.toMatchObject({ completed: true });
    expect(limiter.snapshot()).toEqual({ active: 0, activeMembers: 0 });
    expect(limiter.releaseCount).toBe(1);
    expect(response.socket.listenerCount("close")).toBe(0);
  });
});
