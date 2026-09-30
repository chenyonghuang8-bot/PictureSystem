import type { FastifyReply, FastifyRequest } from "fastify";

import {
  AlbumRepositoryError,
  CommitOutcomeUnknownError,
  TransactionRollbackFailedError,
  type MySqlAlbumRepository,
  type OriginalDownloadRecord,
} from "@family-album/db";
import type { VerifiedOriginalDownload } from "@family-album/storage";

import { PublicAuthError, type AuthContext } from "../auth/service.js";
import { decideOriginalMime, originalContentDisposition } from "./headers.js";
import { OriginalDownloadLimiter } from "./limiter.js";
import {
  commitAttachmentHeaders,
  finishResponse,
  writeBackpressured,
} from "./sender.js";

type OriginalDownloadRepository = Pick<
  MySqlAlbumRepository,
  "prepareOriginalDownload" | "recheckOriginalDownload"
>;

export type OriginalDownloadReader = {
  withVerifiedDownload<T>(
    identity: { familyId: string; sha256Hex: string; byteSize: string },
    options: { signal: AbortSignal },
    callback: (download: VerifiedOriginalDownload) => Promise<T> | T,
  ): Promise<T>;
};

export type OriginalDownloadTimeouts = {
  verificationMs: number;
  idleMs: number;
  totalMs: number;
};

const DEFAULT_TIMEOUTS: OriginalDownloadTimeouts = {
  verificationMs: 120_000,
  idleMs: 60_000,
  totalMs: 60 * 60_000,
};

export class OriginalDownloadService {
  constructor(
    private readonly repository: OriginalDownloadRepository,
    private readonly reader: OriginalDownloadReader,
    private readonly limiter = new OriginalDownloadLimiter(),
    private readonly timeouts = DEFAULT_TIMEOUTS,
  ) {}

  async download(
    context: AuthContext,
    input: { albumId: string; mediaId: string },
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{
    completed: boolean;
    bytesWritten: string;
    record: OriginalDownloadRecord;
    resultCategory: "SUCCESS" | "TRANSFER_FAILED";
  }> {
    const actor = actorFrom(context);
    const controller = new AbortController();
    let initial: OriginalDownloadRecord | undefined;
    let lease: ReturnType<OriginalDownloadLimiter["tryAcquire"]> = null;
    let verificationTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let binaryStarted = false;
    let completed = false;
    let bytesWritten = 0n;

    const abort = (reason: string) => {
      if (!controller.signal.aborted) controller.abort(new Error(reason));
    };
    const onRequestAborted = () => abort("CLIENT_ABORTED");
    const onResponseError = () => abort("RESPONSE_ERROR");
    const onResponseClose = () => {
      if (!reply.raw.writableFinished) abort("RESPONSE_CLOSED");
    };
    request.raw.once("aborted", onRequestAborted);
    reply.raw.once("error", onResponseError);
    reply.raw.once("close", onResponseClose);

    const clearTimers = () => {
      if (verificationTimer) clearTimeout(verificationTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      verificationTimer = undefined;
      idleTimer = undefined;
      totalTimer = undefined;
    };
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => abort("TRANSFER_IDLE_TIMEOUT"),
        this.timeouts.idleMs,
      );
    };

    try {
      abortIfConnectionUnavailable(request, reply, abort);
      controller.signal.throwIfAborted();
      const authorized = await this.database(() =>
        this.repository.prepareOriginalDownload({ actor, ...input }),
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
      verificationTimer = setTimeout(
        () => abort("VERIFICATION_TIMEOUT"),
        this.timeouts.verificationMs,
      );
      await this.reader.withVerifiedDownload(
        {
          familyId: authorized.familyId,
          sha256Hex: authorized.sha256Hex,
          byteSize: authorized.byteSize,
        },
        { signal: controller.signal },
        async (source) => {
          if (verificationTimer) clearTimeout(verificationTimer);
          verificationTimer = undefined;
          totalTimer = setTimeout(
            () => abort("TRANSFER_TOTAL_TIMEOUT"),
            this.timeouts.totalMs,
          );
          resetIdle();
          const current = await this.database(() =>
            this.repository.recheckOriginalDownload({
              actor,
              ...input,
              expected: authorized,
            }),
          );
          controller.signal.throwIfAborted();
          const first = await source.readNext();
          if (first.done || first.bytes.length === 0) {
            throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
          }
          controller.signal.throwIfAborted();
          if (reply.raw.destroyed || !reply.raw.writable) {
            throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
          }
          const mime = decideOriginalMime(current.detectedMime);
          reply.hijack();
          binaryStarted = true;
          commitAttachmentHeaders(reply.raw, {
            contentLength: current.byteSize,
            contentType: mime.contentType,
            contentDisposition: originalContentDisposition({
              originalFilename: current.originalFilename,
              mediaId: current.mediaId,
              extension: mime.extension,
            }),
          });

          let chunk = first;
          for (;;) {
            await writeBackpressured(reply.raw, chunk.bytes, controller.signal);
            bytesWritten += BigInt(chunk.bytes.length);
            resetIdle();
            if (chunk.final) break;
            const next = await source.readNext();
            if (next.done || next.bytes.length === 0) {
              throw new Error("ORIGINAL_STREAM_EARLY_EOF");
            }
            chunk = next;
          }
          if (bytesWritten.toString() !== current.byteSize) {
            throw new Error("ORIGINAL_STREAM_SIZE_MISMATCH");
          }
          await finishResponse(reply.raw, controller.signal);
          completed = true;
        },
      );
      return {
        completed: true,
        bytesWritten: bytesWritten.toString(),
        record: authorized,
        resultCategory: "SUCCESS",
      };
    } catch (error) {
      abort("ORIGINAL_DOWNLOAD_FAILED");
      if (binaryStarted) {
        if (!initial) throw mapOriginalDownloadError(error);
        if (!reply.raw.destroyed) reply.raw.destroy();
        return {
          completed: false,
          bytesWritten: bytesWritten.toString(),
          record: initial,
          resultCategory: "TRANSFER_FAILED",
        };
      }
      throw mapOriginalDownloadError(error);
    } finally {
      clearTimers();
      request.raw.off("aborted", onRequestAborted);
      reply.raw.off("error", onResponseError);
      reply.raw.off("close", onResponseClose);
      if (!completed && binaryStarted && !reply.raw.destroyed)
        reply.raw.destroy();
      lease?.release();
    }
  }

  private async database<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      throw mapOriginalDownloadError(error);
    }
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

function mapOriginalDownloadError(error: unknown) {
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
