import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createUploadErrorResponse,
  uploadFinalizeResponseSchema,
  uploadStatusResponseSchema,
} from "@family-album/contracts";

import {
  readWebSessionCookie,
  requireTrustedJsonOrigin,
} from "../auth/http.js";
import { PublicAuthError, type AuthService } from "../auth/service.js";
import { createTusProtocol } from "./protocol.js";
import type { UploadMutex } from "./mutex.js";
import { UploadRateLimiter } from "./rate-limit.js";
import {
  parseTusDecimal,
  parseUploadPublicId,
  UploadServiceError,
  type UploadService,
} from "./service.js";

const TUS_VERSION = "1.0.0";
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

export function registerUploadRoutes(
  app: FastifyInstance,
  options: {
    authService: AuthService;
    uploadService: UploadService;
    trustedOrigins: ReadonlySet<string>;
    publicApiOrigin: string;
    mutex?: UploadMutex;
  },
) {
  const protocol = createTusProtocol({
    service: options.uploadService,
    trustedOrigins: options.trustedOrigins,
    publicApiOrigin: options.publicApiOrigin,
    ...(options.mutex ? { mutex: options.mutex } : {}),
  });
  const rateLimiter = new UploadRateLimiter();

  if (!app.hasContentTypeParser("application/offset+octet-stream")) {
    app.addContentTypeParser(
      "application/offset+octet-stream",
      (_request, _payload, done) => done(null),
    );
  }

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/v1/uploads")) {
      void reply.header("cache-control", "no-store");
    }
  });

  const optionsHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    requireOptionsOrigin(request, options.trustedOrigins);
    return handoff(
      request,
      reply,
      protocol.server,
      protocol.contexts,
      undefined,
    );
  };
  app.options("/api/v1/uploads/tus", optionsHandler);
  app.options("/api/v1/uploads/tus/:uploadId", optionsHandler);
  app.options("/api/v1/families/:familyId/uploads/tus", optionsHandler);

  app.post(
    "/api/v1/families/:familyId/uploads/tus",
    { bodyLimit: 1 },
    async (request, reply) => {
      try {
        requireTusOrigin(request, options.trustedOrigins);
        requireTusVersion(request);
        requireEmptyCreateBody(request);
        const declaredSize = parseTusDecimal(
          singleHeader(request.headers["upload-length"]),
          "INVALID_REQUEST",
        );
        if (
          declaredSize <= 0n ||
          declaredSize > options.uploadService.maxFileSize
        ) {
          throw new UploadServiceError(413, "UPLOAD_TOO_LARGE");
        }
        validateMetadataHeader(
          singleHeader(request.headers["upload-metadata"]),
        );
        const familyId = parseDecimalId(
          (request.params as { familyId?: unknown }).familyId,
        );
        const auth = await authenticate(request, options.authService);
        rateLimiter.create(auth.identity.userId, request.ip);
        return handoff(request, reply, protocol.server, protocol.contexts, {
          auth,
          familyId,
        });
      } catch (error) {
        return sendUploadError(request, reply, error);
      }
    },
  );

  app.head("/api/v1/uploads/tus/:uploadId", async (request, reply) => {
    try {
      requireOptionalTusOrigin(request, options.trustedOrigins);
      requireTusVersion(request);
      parseUploadPublicId((request.params as { uploadId?: unknown }).uploadId);
      const auth = await authenticate(request, options.authService);
      rateLimiter.access(auth.identity.userId, request.ip);
      return handoff(request, reply, protocol.server, protocol.contexts, {
        auth,
      });
    } catch (error) {
      return sendUploadError(request, reply, error, true);
    }
  });

  app.patch(
    "/api/v1/uploads/tus/:uploadId",
    { bodyLimit: MAX_CHUNK_BYTES },
    async (request, reply) => {
      try {
        requireTusOrigin(request, options.trustedOrigins);
        requireTusVersion(request);
        const expectedOffset = requirePatchHeaders(request);
        const publicId = parseUploadPublicId(
          (request.params as { uploadId?: unknown }).uploadId,
        );
        const auth = await authenticate(request, options.authService);
        rateLimiter.access(auth.identity.userId, request.ip);
        const upload = await protocol.mutex.runExclusive(
          publicId.toString("hex"),
          () =>
            options.uploadService.patch(
              auth,
              publicId,
              expectedOffset,
              request.raw,
            ),
        );
        return reply
          .header("Tus-Resumable", TUS_VERSION)
          .header("Upload-Offset", upload.committedOffset.toString())
          .header("Upload-Expires", upload.expiresAt.toUTCString())
          .status(204)
          .send();
      } catch (error) {
        return sendUploadError(request, reply, error);
      }
    },
  );

  app.get("/api/v1/uploads/:uploadId", async (request, reply) => {
    try {
      requireOptionalTusOrigin(request, options.trustedOrigins);
      const publicId = parseUploadPublicId(
        (request.params as { uploadId?: unknown }).uploadId,
      );
      const auth = await authenticate(request, options.authService);
      rateLimiter.access(auth.identity.userId, request.ip);
      const upload = await protocol.mutex.runExclusive(
        publicId.toString("hex"),
        () => options.uploadService.status(auth, publicId),
      );
      return reply.send(
        uploadStatusResponseSchema.parse({
          uploadId: upload.publicId,
          state: upload.state,
          declaredSize: upload.declaredSize.toString(),
          committedOffset: upload.committedOffset.toString(),
          expiresAt: upload.expiresAt.toISOString(),
          completedAt: upload.completedAt?.toISOString() ?? null,
          failureCode: upload.failureCode,
        }),
      );
    } catch (error) {
      return sendUploadError(request, reply, error);
    }
  });

  app.post(
    "/api/v1/uploads/:uploadId/finalize",
    { bodyLimit: 64 },
    async (request, reply) => {
      try {
        requireTrustedJsonOrigin(request, options.trustedOrigins);
        if (!isEmptyObject(request.body)) {
          throw new UploadServiceError(400, "INVALID_REQUEST");
        }
        const publicId = parseUploadPublicId(
          (request.params as { uploadId?: unknown }).uploadId,
        );
        const auth = await authenticate(request, options.authService);
        rateLimiter.finalize(auth.identity.userId, request.ip);
        const receipt = await protocol.mutex.runExclusive(
          publicId.toString("hex"),
          () =>
            options.uploadService.finalize(
              auth,
              publicId,
              () => !request.raw.aborted && !reply.raw.destroyed,
              (event) =>
                logUploadEvent(
                  request,
                  event,
                  {
                    uploadId: publicId.toString("hex"),
                    actorUserId: auth.identity.userId,
                  },
                  "STATE",
                ),
            ),
        );
        logUploadEvent(request, "upload_completed", {
          uploadId: publicId.toString("hex"),
          actorUserId: auth.identity.userId,
        });
        return reply
          .status(200)
          .send(uploadFinalizeResponseSchema.parse(receipt));
      } catch (error) {
        return sendUploadError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/uploads/:uploadId/abort",
    { bodyLimit: 64 },
    async (request, reply) => {
      try {
        requireTrustedJsonOrigin(request, options.trustedOrigins);
        if (!isEmptyObject(request.body)) {
          throw new UploadServiceError(400, "INVALID_REQUEST");
        }
        const publicId = parseUploadPublicId(
          (request.params as { uploadId?: unknown }).uploadId,
        );
        const auth = await authenticate(request, options.authService);
        rateLimiter.access(auth.identity.userId, request.ip);
        await protocol.mutex.runExclusive(publicId.toString("hex"), () =>
          options.uploadService.abort(auth, publicId),
        );
        logUploadEvent(request, "upload_aborted", {
          uploadId: publicId.toString("hex"),
          actorUserId: auth.identity.userId,
        });
        return reply.status(204).send();
      } catch (error) {
        return sendUploadError(request, reply, error);
      }
    },
  );
}

async function handoff(
  request: FastifyRequest,
  reply: FastifyReply,
  server: {
    handle(
      request: FastifyRequest["raw"],
      response: FastifyReply["raw"],
    ): Promise<unknown>;
  },
  contexts: ReturnType<typeof createTusProtocol>["contexts"],
  context: Parameters<typeof contexts.run>[0] | undefined,
) {
  reply.hijack();
  if (context) {
    await contexts.run(context, () => server.handle(request.raw, reply.raw));
  } else {
    await server.handle(request.raw, reply.raw);
  }
  return reply;
}

async function authenticate(request: FastifyRequest, service: AuthService) {
  const token = readWebSessionCookie(request);
  if (!token) throw new PublicAuthError(401, "UNAUTHENTICATED");
  return service.authenticate(token);
}

function requireTusVersion(request: FastifyRequest) {
  if (singleHeader(request.headers["tus-resumable"]) !== TUS_VERSION) {
    throw new UploadServiceError(412, "INVALID_REQUEST");
  }
}

function requirePatchHeaders(request: FastifyRequest) {
  if (
    singleHeader(request.headers["content-type"]) !==
    "application/offset+octet-stream"
  ) {
    throw new UploadServiceError(415, "INVALID_REQUEST");
  }
  const encoding = singleHeader(request.headers["content-encoding"]);
  if (encoding !== undefined && encoding.toLowerCase() !== "identity") {
    throw new UploadServiceError(415, "INVALID_REQUEST");
  }
  const expectedOffset = parseTusDecimal(
    singleHeader(request.headers["upload-offset"]),
    "OFFSET_MISMATCH",
  );
  const contentLength = singleHeader(request.headers["content-length"]);
  if (contentLength !== undefined) {
    const parsed = parseTusDecimal(contentLength, "INVALID_REQUEST");
    if (parsed > BigInt(MAX_CHUNK_BYTES)) {
      throw new UploadServiceError(413, "UPLOAD_TOO_LARGE");
    }
  }
  if (
    request.headers["upload-length"] !== undefined ||
    request.headers["upload-defer-length"] !== undefined ||
    request.headers["upload-concat"] !== undefined ||
    request.headers["upload-metadata"] !== undefined
  ) {
    throw new UploadServiceError(400, "INVALID_REQUEST");
  }
  return expectedOffset;
}

function requireEmptyCreateBody(request: FastifyRequest) {
  const contentLength = singleHeader(request.headers["content-length"]);
  if (
    (contentLength !== undefined && contentLength !== "0") ||
    request.headers["transfer-encoding"] !== undefined ||
    request.headers["upload-defer-length"] !== undefined ||
    request.headers["upload-concat"] !== undefined
  ) {
    throw new UploadServiceError(400, "INVALID_REQUEST");
  }
}

export function validateMetadataHeader(header: string | undefined) {
  if (!header || Buffer.byteLength(header, "utf8") > 4096) {
    throw new UploadServiceError(400, "INVALID_REQUEST");
  }
  const result = new Map<string, string>();
  for (const pair of header.split(",")) {
    const match = /^(filename|filetype) ([A-Za-z0-9+/]*={0,2})$/u.exec(pair);
    if (!match || result.has(match[1]!)) {
      throw new UploadServiceError(400, "INVALID_REQUEST");
    }
    const encoded = match[2]!;
    if (encoded.length % 4 !== 0) {
      throw new UploadServiceError(400, "INVALID_REQUEST");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) {
      throw new UploadServiceError(400, "INVALID_REQUEST");
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new UploadServiceError(400, "INVALID_REQUEST");
    }
    result.set(match[1]!, decoded);
  }
  if (!result.has("filename")) {
    throw new UploadServiceError(400, "INVALID_REQUEST");
  }
  return result;
}

function requireTusOrigin(
  request: FastifyRequest,
  trustedOrigins: ReadonlySet<string>,
) {
  const origin = exactOrigin(request.headers.origin);
  if (!trustedOrigins.has(origin)) throw new PublicAuthError(403, "FORBIDDEN");
}

function requireOptionalTusOrigin(
  request: FastifyRequest,
  trustedOrigins: ReadonlySet<string>,
) {
  if (request.headers.origin !== undefined)
    requireTusOrigin(request, trustedOrigins);
}

function requireOptionsOrigin(
  request: FastifyRequest,
  trustedOrigins: ReadonlySet<string>,
) {
  if (request.headers.origin !== undefined)
    requireTusOrigin(request, trustedOrigins);
}

function exactOrigin(value: unknown) {
  if (typeof value !== "string" || value === "null" || value.includes(",")) {
    throw new PublicAuthError(403, "FORBIDDEN");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value) throw new Error();
    return value;
  } catch {
    throw new PublicAuthError(403, "FORBIDDEN");
  }
}

function parseDecimalId(value: unknown) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new UploadServiceError(404, "NOT_FOUND");
  }
  return value;
}

function singleHeader(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

function isEmptyObject(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 0
  );
}

function sendUploadError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  head = false,
) {
  const mapped =
    error instanceof UploadServiceError
      ? error
      : error instanceof PublicAuthError
        ? new UploadServiceError(
            error.statusCode,
            error.code === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "FORBIDDEN",
          )
        : new UploadServiceError(503, "STORAGE_UNAVAILABLE");
  logUploadFailure(request, mapped.code);
  void reply
    .header("Tus-Resumable", TUS_VERSION)
    .header("Cache-Control", "no-store");
  if (mapped.currentOffset !== undefined) {
    void reply.header("Upload-Offset", mapped.currentOffset.toString());
  }
  if (mapped.retryAfterSeconds !== undefined) {
    void reply.header("Retry-After", mapped.retryAfterSeconds.toString());
  }
  return head
    ? reply.status(mapped.status_code).send()
    : reply
        .status(mapped.status_code)
        .send(createUploadErrorResponse(mapped.code, request.id));
}

function logUploadEvent(
  request: FastifyRequest,
  event: string,
  identifiers: { uploadId?: string; actorUserId?: string },
  resultCode: "SUCCESS" | "STATE" = "SUCCESS",
) {
  request.log.info(
    {
      event,
      requestId: request.id,
      resultCode,
      timestamp: new Date().toISOString(),
      ...(identifiers.uploadId ? { uploadId: identifiers.uploadId } : {}),
      ...(identifiers.actorUserId
        ? { actorUserId: identifiers.actorUserId }
        : {}),
    },
    "security event",
  );
}

function logUploadFailure(request: FastifyRequest, resultCode: string) {
  request.log.warn(
    {
      event: "upload_request",
      requestId: request.id,
      resultCode,
      timestamp: new Date().toISOString(),
    },
    "security event",
  );
}
