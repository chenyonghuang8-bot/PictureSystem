import type { ServerResponse } from "node:http";

export type AttachmentHeaders = {
  contentLength: string;
  contentType: string;
  contentDisposition: string;
};

export function commitAttachmentHeaders(
  response: ServerResponse,
  headers: AttachmentHeaders,
) {
  response.writeHead(200, {
    "Content-Length": headers.contentLength,
    "Content-Type": headers.contentType,
    "Content-Disposition": headers.contentDisposition,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "none",
    "Referrer-Policy": "no-referrer",
  });
}

export async function writeBackpressured(
  response: ServerResponse,
  bytes: Buffer,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let callbackDone = false;
    let drainDone = false;
    let writeReturned = false;
    let settled = false;
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("error", onError);
      response.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const maybeDone = () => {
      if (writeReturned && callbackDone && drainDone) settle();
    };
    const onDrain = () => {
      drainDone = true;
      maybeDone();
    };
    const onError = () => settle(new Error("ORIGINAL_RESPONSE_ERROR"));
    const onClose = () => settle(new Error("ORIGINAL_RESPONSE_CLOSED"));
    const onAbort = () =>
      settle(
        signal.reason instanceof Error ? signal.reason : new Error("ABORTED"),
      );
    response.once("error", onError);
    response.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const accepted = response.write(bytes, (error) => {
        if (error) return settle(new Error("ORIGINAL_RESPONSE_WRITE_FAILED"));
        callbackDone = true;
        maybeDone();
      });
      writeReturned = true;
      drainDone = accepted;
      if (!accepted) {
        response.once("drain", onDrain);
      }
      maybeDone();
    } catch {
      settle(new Error("ORIGINAL_RESPONSE_WRITE_FAILED"));
    }
  });
}

export async function finishResponse(
  response: ServerResponse,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off("finish", onFinish);
      response.off("error", onError);
      response.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onFinish = () => settle();
    const onError = () => settle(new Error("ORIGINAL_RESPONSE_ERROR"));
    const onClose = () => {
      if (response.writableFinished) settle();
      else settle(new Error("ORIGINAL_RESPONSE_CLOSED"));
    };
    const onAbort = () =>
      settle(
        signal.reason instanceof Error ? signal.reason : new Error("ABORTED"),
      );
    response.once("finish", onFinish);
    response.once("error", onError);
    response.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    response.end();
  });
}
