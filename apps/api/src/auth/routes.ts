import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import {
  createAuthErrorResponse,
  emptyObjectRequestSchema,
  loginRequestSchema,
  meResponseSchema,
  passwordChangeRequestSchema,
  passwordProofRequestSchema,
  sessionParamsSchema,
  sessionsResponseSchema,
} from "@family-album/contracts";

import {
  clearSessionCookie,
  readWebSessionCookie,
  requireTrustedJsonOrigin,
  sessionCookie,
} from "./http.js";
import { PublicAuthError, type AuthService } from "./service.js";

type AuthRouteOptions = {
  service: AuthService;
  trustedOrigins: ReadonlySet<string>;
};

export function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
) {
  const { service, trustedOrigins } = options;

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/v1/auth/")) {
      void reply.header("cache-control", "no-store");
    }
  });

  app.post(
    "/api/v1/auth/login",
    { bodyLimit: 16_384 },
    async (request, reply) =>
      handle(request, reply, "auth.login", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        if (request.headers.authorization !== undefined) {
          throw new PublicAuthError(400, "INVALID_REQUEST");
        }
        const body = loginRequestSchema.parse(request.body);
        const issued = await service.login({
          username: body.username,
          password: body.password,
          deviceLabel: body.deviceLabel ?? null,
          ip: request.ip,
        });
        reply.header(
          "set-cookie",
          sessionCookie(issued.token, issued.expiresAt, issued.serverNow),
        );
        logAuthSuccess(request, "auth.login");
        return reply.status(204).send();
      }),
  );

  app.get("/api/v1/auth/me", async (request, reply) =>
    handle(request, reply, "auth.me", async () => {
      const context = await authenticate(request, service);
      const { memberships } = await service.me(context);
      return reply.send(
        meResponseSchema.parse({
          user: {
            id: context.identity.userId,
            username: context.identity.username,
            displayName: context.identity.displayName,
          },
          memberships,
        }),
      );
    }),
  );

  app.post("/api/v1/auth/logout", async (request, reply) =>
    handle(request, reply, "auth.logout", async () => {
      requireTrustedJsonOrigin(request, trustedOrigins);
      emptyObjectRequestSchema.parse(request.body);
      const token = readWebSessionCookie(request);
      const result = await service.logout(token);
      if (result.clearCookie) reply.header("set-cookie", clearSessionCookie());
      logAuthSuccess(request, "auth.logout");
      return reply.status(204).send();
    }),
  );

  app.post("/api/v1/auth/logout-all", async (request, reply) =>
    handle(request, reply, "auth.logout_all", async () => {
      requireTrustedJsonOrigin(request, trustedOrigins);
      emptyObjectRequestSchema.parse(request.body);
      const context = await authenticate(request, service);
      await service.logoutAll(context);
      reply.header("set-cookie", clearSessionCookie());
      logAuthSuccess(request, "auth.logout_all", {
        userId: context.identity.userId,
        sessionId: context.identity.sessionId,
      });
      return reply.status(204).send();
    }),
  );

  app.post(
    "/api/v1/auth/reauth",
    { bodyLimit: 16_384 },
    async (request, reply) =>
      handle(request, reply, "auth.reauth", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        const body = passwordProofRequestSchema.parse(request.body);
        const context = await authenticate(request, service);
        const issued = await service.reauthenticate(
          context,
          body.password,
          request.ip,
        );
        reply.header(
          "set-cookie",
          sessionCookie(issued.token, issued.expiresAt, issued.serverNow),
        );
        logAuthSuccess(request, "auth.reauth", {
          userId: context.identity.userId,
          sessionId: context.identity.sessionId,
        });
        return reply.status(204).send();
      }),
  );

  app.post(
    "/api/v1/auth/password",
    { bodyLimit: 16_384 },
    async (request, reply) =>
      handle(request, reply, "auth.password_change", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        const body = passwordChangeRequestSchema.parse(request.body);
        const context = await authenticate(request, service);
        const issued = await service.changePassword(context, {
          currentPassword: body.currentPassword,
          newPassword: body.newPassword,
          ip: request.ip,
        });
        reply.header(
          "set-cookie",
          sessionCookie(issued.token, issued.expiresAt, issued.serverNow),
        );
        logAuthSuccess(request, "auth.password_change", {
          userId: context.identity.userId,
          sessionId: context.identity.sessionId,
        });
        return reply.status(204).send();
      }),
  );

  app.get("/api/v1/auth/sessions", async (request, reply) =>
    handle(request, reply, "auth.sessions", async () => {
      const context = await authenticate(request, service);
      const sessions = await service.sessions(context);
      return reply.send(
        sessionsResponseSchema.parse({
          sessions: sessions.map((session) => ({
            id: session.id,
            clientType: session.clientType,
            deviceLabel: session.deviceLabel,
            createdAt: session.createdAt.toISOString(),
            authenticatedAt: session.authenticatedAt.toISOString(),
            lastSeenAt: session.lastSeenAt.toISOString(),
            expiresAt: session.expiresAt.toISOString(),
            current: session.id === context.identity.sessionId,
          })),
        }),
      );
    }),
  );

  app.delete("/api/v1/auth/sessions/:sessionId", async (request, reply) =>
    handle(request, reply, "auth.session_revoke", async () => {
      requireTrustedJsonOrigin(request, trustedOrigins);
      emptyObjectRequestSchema.parse(request.body);
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const context = await authenticate(request, service);
      const result = await service.revokeSession(context, sessionId);
      if (result.revokedCurrent)
        reply.header("set-cookie", clearSessionCookie());
      logAuthSuccess(request, "auth.session_revoke", {
        userId: context.identity.userId,
        sessionId: context.identity.sessionId,
      });
      return reply.status(204).send();
    }),
  );
}

export function handleAuthFrameworkError(
  error: Error & { statusCode?: number },
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (
    !request.url.startsWith("/api/v1/auth/") &&
    !request.url.startsWith("/api/v1/families/") &&
    !request.url.startsWith("/api/v1/invitations/") &&
    !request.url.startsWith("/api/v1/albums")
  )
    throw error;
  const statusCode =
    error.statusCode === 404 ||
    error.statusCode === 413 ||
    error.statusCode === 415
      ? error.statusCode
      : error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? 400
        : 503;
  const code =
    statusCode === 503
      ? "SERVICE_UNAVAILABLE"
      : statusCode === 404
        ? request.url.startsWith("/api/v1/albums")
          ? "NOT_FOUND"
          : "FORBIDDEN"
        : "INVALID_REQUEST";
  logAuthFailure(request, "auth.framework", code);
  return reply
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .status(statusCode)
    .send(createAuthErrorResponse(code, request.id));
}

async function authenticate(request: FastifyRequest, service: AuthService) {
  const token = readWebSessionCookie(request);
  if (!token) throw new PublicAuthError(401, "UNAUTHENTICATED");
  return service.authenticate(token);
}

async function handle(
  request: FastifyRequest,
  reply: FastifyReply,
  event: string,
  operation: () => Promise<unknown>,
) {
  try {
    return await operation();
  } catch (error) {
    let publicError: PublicAuthError;
    if (error instanceof PublicAuthError) publicError = error;
    else if (error instanceof ZodError || isInputValidationError(error)) {
      publicError = new PublicAuthError(400, "INVALID_REQUEST");
    } else publicError = new PublicAuthError(503, "SERVICE_UNAVAILABLE");

    if (publicError.retryAfterSeconds !== undefined) {
      void reply.header("retry-after", publicError.retryAfterSeconds);
    }
    logAuthFailure(request, event, publicError.code, publicError.errorCategory);
    return reply
      .status(publicError.statusCode)
      .send(createAuthErrorResponse(publicError.code, request.id));
  }
}

type AuthLogIdentifiers = { userId?: string; sessionId?: string };

function logAuthSuccess(
  request: FastifyRequest,
  event: string,
  identifiers: AuthLogIdentifiers = {},
) {
  request.log.info(
    {
      event,
      requestId: request.id,
      resultCode: "SUCCESS",
      timestamp: new Date().toISOString(),
      ...identifiers,
    },
    "auth event",
  );
}

function logAuthFailure(
  request: FastifyRequest,
  event: string,
  resultCode: string,
  errorCategory?: string,
) {
  request.log.warn(
    {
      event,
      requestId: request.id,
      resultCode,
      ...(errorCategory ? { errorCategory } : {}),
      timestamp: new Date().toISOString(),
    },
    "auth event",
  );
}

function isInputValidationError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "UsernameValidationError" ||
      error.name === "PasswordValidationError" ||
      error.name === "TokenValidationError")
  );
}
