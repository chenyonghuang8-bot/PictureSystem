import {
  adminModeRequestSchema,
  adminRecheckRequestSchema,
  adminOperationResponseSchema,
  adminOperationIdSchema,
  meResponseSchema,
  type AdminMode,
} from "@family-album/contracts";
import type { z } from "zod";
import {
  browserGalleryGet,
  readGalleryResponse,
  GalleryClientError,
} from "./gallery-client.js";

export async function requireAdminIdentity(
  userId: string,
  familyId: string,
  signal?: AbortSignal,
) {
  const me = await browserGalleryGet(
    "/api/v1/auth/me",
    meResponseSchema,
    signal,
  );
  const member = me.memberships.find((m) => m.familyId === familyId);
  if (me.user.id !== userId || !member)
    throw new GalleryClientError("UNAUTHENTICATED");
  if (!(["ADMIN", "SUPER_ADMIN"] as const).some((r) => r === member.role))
    throw new GalleryClientError("FORBIDDEN");
  return member;
}
export class AdminActivation {
  private epoch = 0;
  private controller = new AbortController();
  begin() {
    this.clear();
    return { epoch: this.epoch, signal: this.controller.signal };
  }
  clear() {
    this.controller.abort();
    this.epoch++;
    this.controller = new AbortController();
  }
  current(ticket: { epoch: number; signal: AbortSignal }) {
    return ticket.epoch === this.epoch && !ticket.signal.aborted;
  }
}
export type ControlAttempt = Readonly<{
  operationId: string;
  expectedRevision: string;
  targetMode: AdminMode;
  kind: "MODE" | "RECHECK";
}>;
export function controlAttempt(
  expectedRevision: string,
  targetMode: AdminMode,
  kind: ControlAttempt["kind"],
): ControlAttempt {
  const attempt = Object.freeze({
    operationId: crypto.randomUUID(),
    expectedRevision,
    targetMode,
    kind,
  });
  adminRecheckRequestSchema.parse({
    operationId: attempt.operationId,
    expectedRevision,
  });
  return attempt;
}
async function adminRequest(
  path: string,
  body: unknown,
  method: "POST" | "PATCH",
) {
  if (!/^\/api\/v1\//.test(path) || path.includes("://"))
    throw new GalleryClientError("UNAVAILABLE");
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GalleryClientError("UNAVAILABLE");
  }
  return response;
}
export async function adminSend<S extends z.ZodType>(
  path: string,
  schema: S,
  body: unknown,
  method: "POST" | "PATCH" = "POST",
) {
  const response = await adminRequest(path, body, method);
  if (response.status === 204) return schema.parse(undefined);
  return readGalleryResponse(response, schema);
}
export async function sendControl(attempt: ControlAttempt) {
  const reason = {
    NORMAL: "MANUAL_RESUME",
    READ_ONLY: "MANUAL_READ_ONLY",
    MAINTENANCE: "MANUAL_MAINTENANCE",
  } as const;
  const body =
    attempt.kind === "RECHECK"
      ? adminRecheckRequestSchema.parse({
          operationId: attempt.operationId,
          expectedRevision: attempt.expectedRevision,
        })
      : adminModeRequestSchema.parse({
          operationId: attempt.operationId,
          expectedRevision: attempt.expectedRevision,
          targetMode: attempt.targetMode,
          reasonCode: reason[attempt.targetMode],
        });
  const response = await adminRequest(
    `/api/v1/admin/system/${attempt.kind === "RECHECK" ? "recheck" : "mode"}`,
    body,
    "POST",
  );
  const row = await readGalleryResponse(response, adminOperationResponseSchema);
  if (
    (row.status === "APPLIED" && response.status !== 200) ||
    (row.status !== "APPLIED" && response.status !== 202)
  )
    throw new GalleryClientError("UNAVAILABLE");
  if (
    row.operationId !== attempt.operationId ||
    row.targetMode !== attempt.targetMode ||
    row.kind !== attempt.kind
  )
    throw new GalleryClientError("UNAVAILABLE");
  return row;
}
export async function observeControl(
  operationId: string,
  signal?: AbortSignal,
) {
  const id = adminOperationIdSchema.parse(operationId);
  const row = await browserGalleryGet(
    `/api/v1/admin/system/operations/${id}`,
    adminOperationResponseSchema,
    signal,
  );
  if (row.operationId !== id) throw new GalleryClientError("UNAVAILABLE");
  return row;
}
export function exactBytes(value: string) {
  const bytes = BigInt(value),
    gib = 1024n ** 3n;
  return `${bytes / gib}.${(((bytes % gib) * 100n) / gib).toString().padStart(2, "0")} GiB (${value} bytes)`;
}
