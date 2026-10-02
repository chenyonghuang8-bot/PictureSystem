import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ZodError } from "zod";
import {
  trashMediaParamsSchema,
  trashRequestSchema,
  restoreRequestSchema,
  trashListQuerySchema,
  lifecycleResponseSchema,
  trashPageSchema,
  familyTimelineParamsSchema,
  createAuthErrorResponse,
} from "@family-album/contracts";
import {
  readWebSessionCookie,
  requireTrustedJsonOrigin,
} from "../auth/http.js";
import { PublicAuthError, type AuthService } from "../auth/service.js";
import type { TrashService } from "./service.js";

export function registerTrashRoutes(
  app: FastifyInstance,
  options: {
    authService: AuthService;
    trashService: TrashService;
    trustedOrigins: ReadonlySet<string>;
  },
) {
  const authenticate = async (request: FastifyRequest) => {
    const token = readWebSessionCookie(request);
    if (!token) throw new PublicAuthError(401, "UNAUTHENTICATED");
    return options.authService.authenticate(token);
  };
  const handle = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operation: () => Promise<unknown>,
  ) => {
    void reply.header("cache-control", "no-store");
    try {
      return await operation();
    } catch (error) {
      const safe =
        error instanceof PublicAuthError
          ? error
          : error instanceof ZodError
            ? new PublicAuthError(400, "INVALID_REQUEST")
            : new PublicAuthError(503, "SERVICE_UNAVAILABLE");
      request.log.warn(
        { event: "trash_request_failed", errorCode: safe.code },
        "lifecycle request failed",
      );
      return reply
        .status(safe.statusCode)
        .send(createAuthErrorResponse(safe.code, request.id));
    }
  };
  app.post(
    "/api/v1/families/:familyId/media/:mediaId/trash",
    { bodyLimit: 4096 },
    async (request, reply) =>
      handle(request, reply, async () => {
        requireTrustedJsonOrigin(request, options.trustedOrigins);
        const params = trashMediaParamsSchema.parse(request.params),
          body = trashRequestSchema.parse(request.body);
        const result = await options.trashService.mutate(
          await authenticate(request),
          { ...params, ...body, action: "TRASH" },
        );
        return reply.send(
          lifecycleResponseSchema.parse({
            ...result,
            trashedAt: result.trashedAt?.toISOString() ?? null,
            purgeAfter: result.purgeAfter?.toISOString() ?? null,
          }),
        );
      }),
  );
  app.post(
    "/api/v1/families/:familyId/trash/:mediaId/restore",
    { bodyLimit: 4096 },
    async (request, reply) =>
      handle(request, reply, async () => {
        requireTrustedJsonOrigin(request, options.trustedOrigins);
        const params = trashMediaParamsSchema.parse(request.params),
          body = restoreRequestSchema.parse(request.body);
        const result = await options.trashService.mutate(
          await authenticate(request),
          { ...params, ...body, action: "RESTORE" },
        );
        return reply.send(
          lifecycleResponseSchema.parse({
            ...result,
            trashedAt: result.trashedAt?.toISOString() ?? null,
            purgeAfter: result.purgeAfter?.toISOString() ?? null,
          }),
        );
      }),
  );
  app.get("/api/v1/families/:familyId/trash", async (request, reply) =>
    handle(request, reply, async () => {
      const params = familyTimelineParamsSchema.parse(request.params),
        query = trashListQuerySchema.parse(request.query);
      return reply.send(
        trashPageSchema.parse(
          await options.trashService.list(await authenticate(request), {
            ...params,
            limit: query.limit,
            ...(query.cursor ? { cursor: query.cursor } : {}),
          }),
        ),
      );
    }),
  );
}
