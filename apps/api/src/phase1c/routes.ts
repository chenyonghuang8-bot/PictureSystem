import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import {
  consumeInvitationRequestSchema,
  createAuthErrorResponse,
  createInvitationRequestSchema,
  createInvitationResponseSchema,
  emptyObjectRequestSchema,
  familyParamsSchema,
  invitationParamsSchema,
  invitationPreviewResponseSchema,
  invitationsResponseSchema,
  invitationTokenRequestSchema,
  memberParamsSchema,
  membersResponseSchema,
  memberSummarySchema,
  updateMemberRequestSchema,
} from "@family-album/contracts";

import {
  readWebSessionCookie,
  requireTrustedJsonOrigin,
} from "../auth/http.js";
import { PublicAuthError, type AuthService } from "../auth/service.js";
import type { Phase1CService } from "./service.js";

export function registerPhase1CRoutes(
  app: FastifyInstance,
  options: {
    authService: AuthService;
    phase1cService: Phase1CService;
    trustedOrigins: ReadonlySet<string>;
  },
) {
  const { authService, phase1cService, trustedOrigins } = options;

  app.addHook("onSend", async (request, reply) => {
    if (isPhase1CPath(request.url)) {
      void reply.header("cache-control", "no-store");
      void reply.header("referrer-policy", "no-referrer");
    }
  });

  app.post(
    "/api/v1/families/:familyId/invitations",
    { bodyLimit: 16_384 },
    async (request, reply) =>
      handlePhase1C(request, reply, "invitation_created", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        const { familyId } = familyParamsSchema.parse(request.params);
        const body = createInvitationRequestSchema.parse(request.body);
        const context = await authenticate(request, authService);
        const created = await phase1cService.createInvitation(context, {
          familyId,
          role: body.role,
          expiresInHours: body.expiresInHours,
        });
        logSecurityEvent(request, "invitation_created", {
          actorUserId: context.identity.userId,
          actorMemberId: created.actorMemberId,
          familyId,
          invitationId: created.id,
        });
        return reply.status(201).send(
          createInvitationResponseSchema.parse({
            id: created.id,
            role: created.role,
            expiresAt: created.expiresAt.toISOString(),
            invitationUrl: created.invitationUrl,
          }),
        );
      }),
  );

  app.get("/api/v1/families/:familyId/invitations", async (request, reply) =>
    handlePhase1C(request, reply, "invitation_list", async () => {
      const { familyId } = familyParamsSchema.parse(request.params);
      const context = await authenticate(request, authService);
      const invitations = await phase1cService.listInvitations(
        context,
        familyId,
      );
      return reply.send(
        invitationsResponseSchema.parse({
          invitations: invitations.map((invitation) => ({
            id: invitation.id,
            role: invitation.role,
            createdAt: invitation.createdAt.toISOString(),
            expiresAt: invitation.expiresAt.toISOString(),
            usedAt: invitation.usedAt?.toISOString() ?? null,
            revokedAt: invitation.revokedAt?.toISOString() ?? null,
            status: invitation.status,
            creatorMemberId: invitation.creatorMemberId,
          })),
        }),
      );
    }),
  );

  app.post(
    "/api/v1/families/:familyId/invitations/:invitationId/revoke",
    async (request, reply) =>
      handlePhase1C(request, reply, "invitation_revoked", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        emptyObjectRequestSchema.parse(request.body);
        const { familyId, invitationId } = invitationParamsSchema.parse(
          request.params,
        );
        const context = await authenticate(request, authService);
        const result = await phase1cService.revokeInvitation(
          context,
          familyId,
          invitationId,
        );
        logSecurityEvent(request, "invitation_revoked", {
          actorUserId: context.identity.userId,
          actorMemberId: result.actorMemberId,
          familyId,
          invitationId,
        });
        return reply.status(204).send();
      }),
  );

  app.post(
    "/api/v1/invitations/preview",
    { bodyLimit: 16_384 },
    async (request, reply) =>
      handlePhase1C(request, reply, "invitation_preview", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        if (request.headers.authorization !== undefined) {
          throw new PublicAuthError(400, "INVALID_REQUEST");
        }
        const { token } = invitationTokenRequestSchema.parse(request.body);
        const preview = await phase1cService.previewInvitation(
          token,
          request.ip,
        );
        return reply.send(
          invitationPreviewResponseSchema.parse({
            ...preview,
            expiresAt: preview.expiresAt.toISOString(),
          }),
        );
      }),
  );

  app.post(
    "/api/v1/invitations/consume",
    { bodyLimit: 16_384 },
    async (request, reply) =>
      handlePhase1C(request, reply, "invitation_consumed", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        if (request.headers.authorization !== undefined) {
          throw new PublicAuthError(400, "INVALID_REQUEST");
        }
        const body = consumeInvitationRequestSchema.parse(request.body);
        const consumed = await phase1cService.consumeInvitation(
          body,
          request.ip,
        );
        logSecurityEvent(request, "invitation_consumed", {
          familyId: consumed.familyId,
          targetMemberId: consumed.memberId,
        });
        return reply.status(201).send();
      }),
  );

  app.get("/api/v1/families/:familyId/members", async (request, reply) =>
    handlePhase1C(request, reply, "member_list", async () => {
      const { familyId } = familyParamsSchema.parse(request.params);
      const context = await authenticate(request, authService);
      const members = await phase1cService.listMembers(context, familyId);
      return reply.send(
        membersResponseSchema.parse({
          members: members.map(memberDto),
        }),
      );
    }),
  );

  app.patch(
    "/api/v1/families/:familyId/members/:memberId",
    { bodyLimit: 16_384 },
    async (request, reply) =>
      handlePhase1C(request, reply, "member_changed", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        const { familyId, memberId } = memberParamsSchema.parse(request.params);
        const body = updateMemberRequestSchema.parse(request.body);
        const context = await authenticate(request, authService);
        const updated = await phase1cService.updateMember(
          context,
          familyId,
          memberId,
          body,
        );
        const event =
          "role" in body
            ? "member_role_changed"
            : body.disabled
              ? "member_disabled"
              : "member_restored";
        logSecurityEvent(request, event, {
          actorUserId: context.identity.userId,
          actorMemberId: updated.actorMemberId,
          familyId,
          targetMemberId: memberId,
        });
        return reply.send(memberSummarySchema.parse(memberDto(updated.member)));
      }),
  );
}

export async function handlePhase1C(
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
    else if (error instanceof ZodError || isValidationError(error)) {
      publicError = new PublicAuthError(400, "INVALID_REQUEST");
    } else publicError = new PublicAuthError(503, "SERVICE_UNAVAILABLE");
    if (publicError.retryAfterSeconds !== undefined) {
      void reply.header("retry-after", publicError.retryAfterSeconds);
    }
    logSecurityFailure(
      request,
      event,
      publicError.code,
      publicError.errorCategory,
    );
    return reply
      .status(publicError.statusCode)
      .send(createAuthErrorResponse(publicError.code, request.id));
  }
}

async function authenticate(request: FastifyRequest, service: AuthService) {
  const token = readWebSessionCookie(request);
  if (!token) throw new PublicAuthError(401, "UNAUTHENTICATED");
  return service.authenticate(token);
}

function memberDto(member: {
  id: string;
  userId: string;
  username: string;
  displayName: string | null;
  role: "SUPER_ADMIN" | "ADMIN" | "MEMBER";
  disabledAt: Date | null;
}) {
  return {
    id: member.id,
    userId: member.userId,
    username: member.username,
    displayName: member.displayName,
    role: member.role,
    disabled: member.disabledAt !== null,
  };
}

type SecurityIdentifiers = {
  actorUserId?: string;
  actorMemberId?: string;
  familyId?: string;
  invitationId?: string;
  targetMemberId?: string;
};

function logSecurityEvent(
  request: FastifyRequest,
  event: string,
  identifiers: SecurityIdentifiers = {},
) {
  request.log.info(
    {
      event,
      requestId: request.id,
      resultCode: "SUCCESS",
      timestamp: new Date().toISOString(),
      ...withoutUndefined(identifiers),
    },
    "security event",
  );
}

function logSecurityFailure(
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
    "security event",
  );
}

function withoutUndefined(input: SecurityIdentifiers) {
  return Object.fromEntries(
    Object.entries(input).filter((entry) => entry[1] !== undefined),
  );
}

function isValidationError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "UsernameValidationError" ||
      error.name === "PasswordValidationError" ||
      error.name === "TokenValidationError")
  );
}

export function isPhase1CPath(url: string) {
  return (
    url.startsWith("/api/v1/families/") ||
    url.startsWith("/api/v1/invitations/")
  );
}
