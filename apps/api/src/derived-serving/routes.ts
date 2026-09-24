import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import {
  createAuthErrorResponse,
  derivedParamsSchema,
} from "@family-album/contracts";

import { readWebSessionCookie } from "../auth/http.js";
import { PublicAuthError, type AuthService } from "../auth/service.js";
import type { DerivedReadService } from "./service.js";

export function registerDerivedRoutes(
  app: FastifyInstance,
  options: {
    authService: AuthService;
    derivedService: DerivedReadService;
  },
) {
  const { authService, derivedService } = options;

  app.get(
    "/api/v1/media/:mediaId/derived/:kind",
    async (request, reply) =>
      handleDerived(request, reply, async () => {
        const { mediaId, kind } = derivedParamsSchema.parse(request.params);
        const token = readWebSessionCookie(request);
        if (!token) throw new PublicAuthError(401, "UNAUTHENTICATED");
        const context = await authService.authenticate(token);
        const served = await derivedService.serve(context, mediaId, kind);
        request.log.info(
          {
            event: "derived_read",
            requestId: request.id,
            resultCode: "SUCCESS",
            timestamp: new Date().toISOString(),
            actorUserId: context.identity.userId,
            familyId: served.familyId,
            mediaId,
            kind,
          },
          "security event",
        );
        return reply
          .header("content-type", served.contentType)
          .header("content-length", String(served.bytes.length))
          .header("cache-control", "private, no-store")
          .send(served.bytes);
      }),
  );
}

async function handleDerived(
  request: FastifyRequest,
  reply: FastifyReply,
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
        event: "derived_read",
        requestId: request.id,
        resultCode: publicError.code,
        timestamp: new Date().toISOString(),
      },
      "security event",
    );
    return reply
      .status(publicError.statusCode)
      .send(createAuthErrorResponse(publicError.code, request.id));
  }
}
