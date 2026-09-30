import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

import type { FastifyReply, FastifyRequest } from "fastify";

import {
  AlbumRepositoryError,
  CommitOutcomeUnknownError,
  TransactionRollbackFailedError,
  type MySqlAlbumRepository,
  type PreviewDownloadRecord,
} from "@family-album/db";
import { StorageSafetyError } from "@family-album/storage";

import { PublicAuthError, type AuthContext } from "../auth/service.js";
import { originalContentDisposition } from "../original-download/headers.js";
import {
  commitAttachmentHeaders,
  finishResponse,
  writeBackpressured,
} from "../original-download/sender.js";
import { PreviewDownloadLimiter } from "./limiter.js";

const MAX_PREVIEW_BYTES = 4_194_304;
const HIDDEN_STORAGE_FAILURES = new Set([
  "DERIVED_SERVE_ABSENT",
  "DERIVED_SERVE_MISMATCH",
  "DERIVED_SERVE_IDENTITY",
]);

type PreviewDownloadRepository = Pick<
  MySqlAlbumRepository,
  "preparePreviewDownload" | "recheckPreviewDownload"
>;

export type PreviewDownloadReader = {
  read(
    identity: {
      familyId: string;
      mediaId: string;
      generation: bigint;
      recipeId: 1;
      kind: "PREVIEW";
      sha256Hex: string;
      byteSize: bigint;
    },
    options: { signal: AbortSignal },
  ): Promise<Buffer>;
};

export type PreviewDownloadTimeouts = { idleMs: number; totalMs: number };

const DEFAULT_TIMEOUTS: PreviewDownloadTimeouts = {
  idleMs: 30_000,
  totalMs: 120_000,
};

export class PreviewDownloadService {
  constructor(
    private readonly repository: PreviewDownloadRepository,
    private readonly reader: PreviewDownloadReader,
    private readonly limiter = new PreviewDownloadLimiter(),
    private readonly timeouts = DEFAULT_TIMEOUTS,
  ) {}

  async download(
    input: { albumId: string; mediaId: string },
    request: FastifyRequest,
    reply: FastifyReply,
    authenticate: () => Promise<AuthContext>,
  ): Promise<{
    completed: boolean;
    bytesWritten: string;
    record: PreviewDownloadRecord;
    resultCategory: "SUCCESS" | "TRANSFER_FAILED";
  }> {
    const controller = new AbortController();
    let lease: ReturnType<PreviewDownloadLimiter["tryAcquire"]> = null;
    let initial: PreviewDownloadRecord | undefined;
    let bytes: Buffer | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let binaryStarted = false;
    let bytesWritten = 0;
    let responseClosed = false;
    let socketClosed = false;
    const responseSocket = reply.raw.socket;

    const abort = (reason: string) => {
      if (!controller.signal.aborted) controller.abort(new Error(reason));
    };
    const onRequestAborted = () => abort("CLIENT_ABORTED");
    const onResponseError = () => abort("RESPONSE_ERROR");
    const onResponseClose = () => {
      responseClosed = true;
      if (!reply.raw.writableFinished) abort("RESPONSE_CLOSED");
    };
    const onSocketClose = () => {
      socketClosed = true;
      if (!reply.raw.writableFinished) abort("SOCKET_CLOSED");
    };
    request.raw.once("aborted", onRequestAborted);
    reply.raw.once("error", onResponseError);
    reply.raw.once("close", onResponseClose);
    responseSocket?.once("close", onSocketClose);

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      idleTimer = undefined;
      totalTimer = undefined;
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => abort("TRANSFER_IDLE_TIMEOUT"),
        this.timeouts.idleMs,
      );
    };

    try {
      abortIfConnectionUnavailable(request, reply, abort);
      controller.signal.throwIfAborted();
      const context = await authenticate();
      abortIfConnectionUnavailable(request, reply, abort);
      controller.signal.throwIfAborted();
      const actor = actorFrom(context);
      const authorized = await this.database(() =>
        this.repository.preparePreviewDownload({ actor, ...input }),
      );
      initial = authorized;
      abortIfConnectionUnavailable(request, reply, abort);
      controller.signal.throwIfAborted();
      lease = this.limiter.tryAcquire(
        authorized.familyId,
        authorized.actorMemberId,
      );
      if (!lease) throw new PublicAuthError(429, "RATE_LIMITED", 1);
      abortIfConnectionUnavailable(request, reply, abort);
      controller.signal.throwIfAborted();
      assertTrustedBound(authorized);
      bytes = await this.read(
        {
          familyId: authorized.familyId,
          mediaId: authorized.mediaId,
          generation: authorized.derivedGeneration,
          recipeId: authorized.derivedRecipeId,
          kind: "PREVIEW",
          sha256Hex: authorized.sha256Hex,
          byteSize: authorized.byteSize,
        },
        controller.signal,
      );
      abortIfConnectionUnavailable(request, reply, abort);
      controller.signal.throwIfAborted();
      verifyFinalBuffer(bytes, authorized);
      const current = await this.database(() =>
        this.repository.recheckPreviewDownload({
          actor,
          ...input,
          expected: authorized,
        }),
      );
      abortIfConnectionUnavailable(request, reply, abort);
      controller.signal.throwIfAborted();
      if (reply.raw.destroyed || !reply.raw.writable) {
        throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
      }
      totalTimer = setTimeout(
        () => abort("TRANSFER_TOTAL_TIMEOUT"),
        this.timeouts.totalMs,
      );
      armIdle();
      reply.hijack();
      binaryStarted = true;
      commitAttachmentHeaders(reply.raw, {
        contentLength: String(bytes.length),
        contentType: "image/webp",
        contentDisposition: originalContentDisposition({
          originalFilename: `media-${current.mediaId}-preview.webp`,
          mediaId: `${current.mediaId}-preview`,
          extension: "webp",
        }),
      });
      await writeBackpressured(reply.raw, bytes, controller.signal);
      bytesWritten = bytes.length;
      armIdle();
      await finishResponse(reply.raw, controller.signal);
      return {
        completed: true,
        bytesWritten: String(bytesWritten),
        record: current,
        resultCategory: "SUCCESS",
      };
    } catch (error) {
      abort("PREVIEW_DOWNLOAD_FAILED");
      if (binaryStarted) {
        if (!initial) throw mapPreviewDownloadError(error);
        await destroyAndAwaitPreviewResponseSettlement(
          reply.raw,
          responseSocket,
          () => responseClosed,
          () => socketClosed,
        );
        return {
          completed: false,
          bytesWritten: String(bytesWritten),
          record: initial,
          resultCategory: "TRANSFER_FAILED",
        };
      }
      throw mapPreviewDownloadError(error);
    } finally {
      clearTimers();
      request.raw.off("aborted", onRequestAborted);
      reply.raw.off("error", onResponseError);
      reply.raw.off("close", onResponseClose);
      responseSocket?.off("close", onSocketClose);
      lease?.release();
    }
  }

  private async database<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      throw mapPreviewDownloadError(error);
    }
  }

  private async read(
    identity: Parameters<PreviewDownloadReader["read"]>[0],
    signal: AbortSignal,
  ) {
    try {
      return await this.reader.read(identity, { signal });
    } catch (error) {
      throw mapPreviewDownloadError(error);
    }
  }
}

async function destroyAndAwaitPreviewResponseSettlement(
  response: ServerResponse,
  socket: ServerResponse["socket"],
  responseCloseObserved: () => boolean,
  socketCloseObserved: () => boolean,
) {
  const isSettled = () =>
    response.writableFinished ||
    (socket ? socketCloseObserved() : responseCloseObserved());
  if (isSettled()) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const cleanup = () => {
      response.off("close", onResponseClose);
      socket?.off("close", onSocketClose);
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onResponseClose = () => {
      if (isSettled()) settle();
    };
    const onSocketClose = () => settle();

    // Install both terminal observers before initiating destruction so a
    // synchronous close cannot be lost between destroy() and listener setup.
    response.once("close", onResponseClose);
    socket?.once("close", onSocketClose);
    if (isSettled()) return settle();
    try {
      response.destroy();
    } catch {
      // A thrown destroy is not settlement. Keep ownership until a real
      // response/socket terminal event is observed.
    }
    if (isSettled()) settle();
  });
}

function assertTrustedBound(record: PreviewDownloadRecord) {
  if (record.byteSize <= 0n || record.byteSize > BigInt(MAX_PREVIEW_BYTES)) {
    throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
  }
}

function verifyFinalBuffer(bytes: Buffer, record: PreviewDownloadRecord) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_PREVIEW_BYTES ||
    BigInt(bytes.length) !== record.byteSize ||
    createHash("sha256").update(bytes).digest("hex") !== record.sha256Hex
  ) {
    throw new PublicAuthError(404, "NOT_FOUND");
  }
}

function abortIfConnectionUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  abort: (reason: string) => void,
) {
  if (
    request.raw.aborted === true ||
    request.raw.destroyed === true ||
    reply.raw.destroyed === true ||
    reply.raw.writableEnded === true ||
    reply.raw.writableFinished === true ||
    reply.raw.writable === false ||
    reply.raw.socket?.destroyed === true
  ) {
    abort("CLIENT_DISCONNECTED");
  }
}

function actorFrom(context: AuthContext) {
  return {
    userId: context.identity.userId,
    sessionId: context.identity.sessionId,
    tokenHash: context.tokenHash,
  };
}

function mapPreviewDownloadError(error: unknown) {
  if (error instanceof PublicAuthError) return error;
  if (error instanceof AlbumRepositoryError) {
    if (error.reason === "UNAUTHENTICATED") {
      return new PublicAuthError(401, "UNAUTHENTICATED");
    }
    if (error.reason === "NOT_FOUND") {
      return new PublicAuthError(404, "NOT_FOUND");
    }
    return new PublicAuthError(503, "SERVICE_UNAVAILABLE");
  }
  if (error instanceof StorageSafetyError) {
    if (HIDDEN_STORAGE_FAILURES.has(error.reason)) {
      return new PublicAuthError(404, "NOT_FOUND");
    }
    return new PublicAuthError(503, "SERVICE_UNAVAILABLE");
  }
  if (error instanceof CommitOutcomeUnknownError) {
    return new PublicAuthError(
      503,
      "SERVICE_UNAVAILABLE",
      undefined,
      "COMMIT_OUTCOME_UNKNOWN",
    );
  }
  if (error instanceof TransactionRollbackFailedError) {
    return new PublicAuthError(
      503,
      "SERVICE_UNAVAILABLE",
      undefined,
      "ROLLBACK_FAILED",
    );
  }
  return new PublicAuthError(503, "SERVICE_UNAVAILABLE");
}
