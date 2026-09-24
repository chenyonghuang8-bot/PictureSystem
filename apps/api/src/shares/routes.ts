import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import {
  albumParamsSchema,
  createAuthErrorResponse,
  createShareRequestSchema,
  createShareResponseSchema,
  emptyObjectRequestSchema,
  listSharesQuerySchema,
  revokeShareResponseSchema,
  shareListResponseSchema,
  shareManagementItemSchema,
  shareParamsSchema,
} from "@family-album/contracts";

import {
  readWebSessionCookie,
  requireTrustedJsonOrigin,
} from "../auth/http.js";
import { PublicAuthError, type AuthService } from "../auth/service.js";
import type { ShareService } from "./service.js";

export function registerShareManagementRoutes(
  app: FastifyInstance,
  options: {
    authService: AuthService;
    shareService: ShareService;
    trustedOrigins: ReadonlySet<string>;
  },
) {
  const { authService, shareService, trustedOrigins } = options;

  app.post(
    "/api/v1/albums/:albumId/share",
    { bodyLimit: 4_096 },
    async (request, reply) =>
      handleShare(request, reply, "share_create", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        const { albumId } = albumParamsSchema.parse(request.params);
        const body = createShareRequestSchema.parse(request.body);
        const context = await authenticate(request, authService);
        const created = await shareService.createShare(
          context,
          albumId,
          new Date(body.expiresAt),
        );
        logShareEvent(request, "share_created", {
          actorUserId: context.identity.userId,
          albumId: created.albumId,
          shareId: created.shareId,
        });
        return reply.status(201).send(
          createShareResponseSchema.parse({
            shareId: created.shareId,
            token: created.token,
            expiresAt: created.expiresAt.toISOString(),
          }),
        );
      }),
  );

  app.get("/api/v1/shares", async (request, reply) =>
    handleShare(request, reply, "share_list", async () => {
      const query = listSharesQuerySchema.parse(request.query);
      const context = await authenticate(request, authService);
      const shares = await shareService.listShares(context, {
        familyId: query.familyId,
        limit: query.limit,
        ...(query.afterId !== undefined ? { afterId: query.afterId } : {}),
      });
      const items = shares.map((share) =>
        shareManagementItemSchema.parse({
          shareId: share.shareId,
          albumId: share.albumId,
          createdAt: share.createdAt.toISOString(),
          expiresAt: share.expiresAt.toISOString(),
          revokedAt: share.revokedAt ? share.revokedAt.toISOString() : null,
        }),
      );
      logShareEvent(request, "share_list", {
        actorUserId: context.identity.userId,
        familyId: query.familyId,
      });
      return reply.header("cache-control", "no-store").send(
        shareListResponseSchema.parse({
          shares: items,
          nextAfterId:
            items.length === query.limit ? items.at(-1)!.shareId : null,
        }),
      );
    }),
  );

  app.delete(
    "/api/v1/shares/:shareId",
    { bodyLimit: 4_096 },
    async (request, reply) =>
      handleShare(request, reply, "share_revoke", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        emptyObjectRequestSchema.parse(request.body);
        const { shareId } = shareParamsSchema.parse(request.params);
        const context = await authenticate(request, authService);
        const revoked = await shareService.revokeShare(context, shareId);
        if (!revoked.revokedAt) {
          throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
        }
        logShareEvent(request, "share_revoked", {
          actorUserId: context.identity.userId,
          albumId: revoked.albumId,
          shareId: revoked.shareId,
        });
        return reply.header("cache-control", "no-store").send(
          revokeShareResponseSchema.parse({
            shareId: revoked.shareId,
            albumId: revoked.albumId,
            revokedAt: revoked.revokedAt.toISOString(),
          }),
        );
      }),
  );
}

async function authenticate(request: FastifyRequest, service: AuthService) {
  const token = readWebSessionCookie(request);
  if (!token) throw new PublicAuthError(401, "UNAUTHENTICATED");
  return service.authenticate(token);
}

async function handleShare(
  request: FastifyRequest,
  reply: FastifyReply,
  event: string,
  operation: () => Promise<unknown>,
) {
  try {
    return await operation();
  } catch (error) {
    const publicError =
      error instanceof PublicAuthError
        ? error
        : error instanceof ZodError
          ? new PublicAuthError(400, "INVALID_REQUEST")
          : new PublicAuthError(503, "SERVICE_UNAVAILABLE");
    request.log.warn(
      {
        event,
        requestId: request.id,
        resultCode: publicError.code,
        ...(publicError.errorCategory
          ? { errorCategory: publicError.errorCategory }
          : {}),
        timestamp: new Date().toISOString(),
      },
      "security event",
    );
    return reply
      .status(publicError.statusCode)
      .send(createAuthErrorResponse(publicError.code, request.id));
  }
}

function logShareEvent(
  request: FastifyRequest,
  event: string,
  identifiers: {
    actorUserId: string;
    familyId?: string;
    albumId?: string;
    shareId?: string;
  },
) {
  request.log.info(
    {
      event,
      requestId: request.id,
      resultCode: "SUCCESS",
      timestamp: new Date().toISOString(),
      actorUserId: identifiers.actorUserId,
      ...(identifiers.familyId ? { familyId: identifiers.familyId } : {}),
      ...(identifiers.albumId ? { albumId: identifiers.albumId } : {}),
      ...(identifiers.shareId ? { shareId: identifiers.shareId } : {}),
    },
    "security event",
  );
}
