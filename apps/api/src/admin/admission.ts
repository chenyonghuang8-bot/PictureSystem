import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createAuthErrorResponse,
  updateMemberRequestSchema,
} from "@family-album/contracts";
import {
  ControlAdmissionError,
  type ControlledAction,
  type ControlAdmission,
} from "@family-album/storage";

// Keys are registered route templates, never untrusted URL prefixes. New
// mutation routes receive MEDIA_WRITE until their named category is explicit.
const authMutations = new Set([
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/android/login",
  "POST /api/v1/auth/logout",
  "POST /api/v1/auth/logout-all",
  "POST /api/v1/auth/reauth",
  "POST /api/v1/auth/password",
  "POST /api/v1/auth/android/logout",
  "POST /api/v1/auth/android/logout-all",
  "POST /api/v1/auth/android/reauth",
  "POST /api/v1/auth/android/password",
  "DELETE /api/v1/auth/sessions/:sessionId",
]);
const observations = new Set([
  "POST /api/v1/invitations/preview",
  "POST /api/v1/android/invitations/preview",
]);
const controlCommands = new Set([
  "POST /api/v1/admin/system/mode",
  "POST /api/v1/admin/system/recheck",
]);
const categories = new Map<string, ControlledAction>([
  ["POST /api/v1/families/:familyId/invitations", "INVITATION_CREATE"],
  [
    "POST /api/v1/families/:familyId/invitations/:invitationId/revoke",
    "INVITATION_REVOKE",
  ],
  ["POST /api/v1/invitations/consume", "INVITATION_CONSUME"],
  ["POST /api/v1/android/invitations/consume", "INVITATION_CONSUME"],
]);
function category(key: string, request: FastifyRequest): ControlledAction {
  if (key === "PATCH /api/v1/families/:familyId/members/:memberId") {
    const parsed = updateMemberRequestSchema.safeParse(request.body);
    return parsed.success && "disabled" in parsed.data && parsed.data.disabled
      ? "MEMBER_REVOKE"
      : "MEMBER_INCREASE";
  }
  return categories.get(key) ?? "MEDIA_WRITE";
}

/** Holds S through the original handler, including tus settlement/error paths.
 * It precedes the handler's UploadMutex/content/capacity/actor locks. */
export function installControlAdmission(
  app: FastifyInstance,
  admission: ControlAdmission,
) {
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.some((m) => ["POST", "PATCH", "PUT", "DELETE"].includes(m)))
      return;
    // Fastify registration currently uses a single mutation method per route.
    // Ambiguous mixed registration fails closed instead of exempting its writes.
    const key = `${methods.length === 1 ? methods[0] : "MULTI"} ${route.url}`;
    if (
      authMutations.has(key) ||
      observations.has(key) ||
      controlCommands.has(key)
    )
      return;
    const handler = route.handler;
    route.handler = async function (request, reply) {
      try {
        return await admission.run(category(key, request), async () =>
          handler.call(this, request, reply),
        );
      } catch (error) {
        if (!(error instanceof ControlAdmissionError)) throw error;
        return reply
          .header("cache-control", "private, no-store")
          .header("referrer-policy", "no-referrer")
          .status(503)
          .send({
            ...createAuthErrorResponse("SERVICE_UNAVAILABLE", request.id),
            reasonCode: error.reason,
          });
      }
    };
  });
}
