import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ZodError } from "zod";
import {
  familyParamsSchema,
  adminOperationIdSchema,
  adminModeRequestSchema,
  adminRecheckRequestSchema,
  createAuthErrorResponse,
  type AdminStorageObservation,
} from "@family-album/contracts";
import {
  SystemControlError,
  Phase1CRepositoryError,
  type MySqlSystemControlRepository,
  type MySqlAdminReadRepository,
  type Phase1CActor,
} from "@family-album/db";
import type { AuthService } from "../auth/service.js";
import { PublicAuthError } from "../auth/service.js";
import {
  readSessionCredential,
  requireSessionJsonMutation,
} from "../auth/http.js";

export function registerAdminRoutes(
  app: FastifyInstance,
  options: {
    authService: AuthService;
    control: MySqlSystemControlRepository;
    reads: MySqlAdminReadRepository;
    trustedOrigins: ReadonlySet<string>;
    localDeny: () => boolean;
    configuredRoles?: readonly ("API" | "DERIVATIVE" | "METADATA" | "PURGE")[];
    observeStorage?: (now: Date) => Promise<AdminStorageObservation>;
  },
) {
  const { control, reads } = options;
  async function authenticate(request: FastifyRequest) {
    const credential = readSessionCredential(request);
    if (!credential) throw new PublicAuthError(401, "UNAUTHENTICATED");
    const c = await options.authService.authenticate(
      credential.token,
      credential.expectedClientType,
    );
    return {
      userId: c.identity.userId,
      sessionId: c.identity.sessionId,
      tokenHash: c.tokenHash,
      expectedClientType: credential.expectedClientType,
    } satisfies Phase1CActor;
  }
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: () => Promise<unknown>,
  ) {
    reply
      .header("cache-control", "private, no-store")
      .header("referrer-policy", "no-referrer");
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PublicAuthError)
        return reply
          .status(error.statusCode)
          .send(createAuthErrorResponse(error.code, request.id));
      if (error instanceof ZodError)
        return reply
          .status(400)
          .send(createAuthErrorResponse("INVALID_REQUEST", request.id));
      if (
        error instanceof SystemControlError ||
        error instanceof Phase1CRepositoryError
      ) {
        const code =
          error.reason === "FORBIDDEN"
            ? "FORBIDDEN"
            : error.reason === "NOT_FOUND"
              ? "NOT_FOUND"
              : error.reason === "CONFLICT"
                ? "CONFLICT"
                : error.reason === "UNAUTHENTICATED"
                  ? "UNAUTHENTICATED"
                  : "SERVICE_UNAVAILABLE";
        const status =
          code === "FORBIDDEN"
            ? 403
            : code === "NOT_FOUND"
              ? 404
              : code === "CONFLICT"
                ? 409
                : code === "UNAUTHENTICATED"
                  ? 401
                  : 503;
        return reply
          .status(status)
          .send(createAuthErrorResponse(code, request.id));
      }
      return reply
        .status(503)
        .send(createAuthErrorResponse("SERVICE_UNAVAILABLE", request.id));
    }
  }
  app.get("/api/v1/families/:familyId/admin/overview", async (request, reply) =>
    handle(request, reply, async () => {
      const { familyId } = familyParamsSchema.parse(request.params);
      const overview = await reads.overview(
        await authenticate(request),
        familyId,
      );
      return options.localDeny()
        ? { ...overview, mediaControl: "PAUSED" }
        : overview;
    }),
  );
  app.get("/api/v1/families/:familyId/admin/audit", async (request, reply) =>
    handle(request, reply, async () => {
      const { familyId } = familyParamsSchema.parse(request.params);
      return reads.audit(await authenticate(request), familyId, request.query);
    }),
  );
  app.get("/api/v1/admin/system/status", async (request, reply) =>
    handle(request, reply, async () => {
      const actor = await control.resolveActor(await authenticate(request));
      const status = await reads.systemStatus(
        actor,
        options.configuredRoles ?? ["API"],
        options.observeStorage ??
          (async () => ({
            state: "UNKNOWN",
            observedAt: null,
            staleAfter: null,
            source: "STORAGE_OWNER",
            reasonCode: "WRITER_NOT_READY",
            totalBytes: null,
            availableBytes: null,
          })),
      );
      return {
        ...status,
        localDeny: options.localDeny(),
      };
    }),
  );
  app.get("/api/v1/admin/system/audit", async (request, reply) =>
    handle(request, reply, async () => {
      const actor = await control.resolveActor(await authenticate(request));
      return reads.audit(actor, actor.familyId, request.query, true);
    }),
  );
  app.get("/api/v1/admin/system/operations/:id", async (request, reply) =>
    handle(request, reply, async () => {
      const id = adminOperationIdSchema.parse(
        (request.params as { id?: unknown }).id,
      );
      return control.operation(
        await control.resolveActor(await authenticate(request)),
        id,
      );
    }),
  );
  app.post(
    "/api/v1/admin/system/mode",
    { bodyLimit: 16384 },
    async (request, reply) =>
      handle(request, reply, async () => {
        requireSessionJsonMutation(request, options.trustedOrigins);
        const body = adminModeRequestSchema.parse(request.body),
          actor = await control.resolveActor(await authenticate(request));
        let operation;
        try {
          operation = await control.requestMode(actor, body);
        } catch (error) {
          if (
            error instanceof SystemControlError &&
            error.reason === "COMMIT_UNKNOWN"
          )
            return reply.status(503).send({
              ...createAuthErrorResponse("SERVICE_UNAVAILABLE", request.id),
              operationId: body.operationId,
              reasonCode: "COMMIT_UNKNOWN",
            });
          throw error;
        }
        return reply
          .status(operation.status === "APPLIED" ? 200 : 202)
          .send(operation);
      }),
  );
  app.post(
    "/api/v1/admin/system/recheck",
    { bodyLimit: 16384 },
    async (request, reply) =>
      handle(request, reply, async () => {
        requireSessionJsonMutation(request, options.trustedOrigins);
        const body = adminRecheckRequestSchema.parse(request.body),
          actor = await control.resolveActor(await authenticate(request));
        let operation;
        try {
          operation = await control.requestRecheck(actor, body);
        } catch (error) {
          if (
            error instanceof SystemControlError &&
            error.reason === "COMMIT_UNKNOWN"
          )
            return reply.status(503).send({
              ...createAuthErrorResponse("SERVICE_UNAVAILABLE", request.id),
              operationId: body.operationId,
              reasonCode: "COMMIT_UNKNOWN",
            });
          throw error;
        }
        return reply
          .status(operation.status === "APPLIED" ? 200 : 202)
          .send(operation);
      }),
  );
}
