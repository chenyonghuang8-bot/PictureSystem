import { z } from "zod";
import {
  meResponseSchema,
  lifecycleResponseSchema,
  purgeRequestResponseSchema,
  purgeStatusResponseSchema,
  trashPageSchema,
} from "@family-album/contracts";
import {
  browserGalleryGet,
  browserGallerySend,
  GalleryClientError,
  readGalleryResponse,
} from "./gallery-client.js";
import { assertGalleryId, galleryQuery } from "./gallery-paths.js";

export type TrashItem = z.infer<typeof trashPageSchema>["items"][number];
export type PurgeStatus = z.infer<typeof purgeStatusResponseSchema>;
export type LifecycleAttempt = Readonly<{
  familyId: string;
  mediaId: string;
  revision: string;
  operationId: string;
  action: "trash" | "restore" | "permanent-delete";
  selectedAlbumId?: string;
}>;
export function trashPath(familyId: string) {
  assertGalleryId(familyId);
  return `/api/v1/families/${familyId}/trash`;
}
export function readTrash(familyId: string, cursor?: string) {
  return browserGalleryGet(
    galleryQuery(trashPath(familyId), { limit: 20, cursor }),
    trashPageSchema,
  );
}
export function readPurge(familyId: string, operationId: string) {
  return browserGalleryGet(
    `/api/v1/families/${familyId}/purge-requests/${operationId}`,
    purgeStatusResponseSchema,
  ).then((row) => {
    if (row.operationId !== operationId)
      throw new GalleryClientError("UNAVAILABLE");
    return row;
  });
}
export function newAttempt(
  familyId: string,
  mediaId: string,
  revision: string,
  action: LifecycleAttempt["action"],
  selectedAlbumId?: string,
): LifecycleAttempt {
  return Object.freeze({
    familyId,
    mediaId,
    revision,
    action,
    ...(selectedAlbumId ? { selectedAlbumId } : {}),
    operationId: crypto.randomUUID(),
  });
}
// Never retries a mutation. Wrong success status/body is an unknown outcome.
export async function sendLifecycle(attempt: LifecycleAttempt) {
  assertGalleryId(attempt.familyId);
  assertGalleryId(attempt.mediaId);
  const path =
    attempt.action === "trash"
      ? `/api/v1/families/${attempt.familyId}/media/${attempt.mediaId}/trash`
      : `${trashPath(attempt.familyId)}/${attempt.mediaId}/${attempt.action}`;
  const body = {
    expectedLifecycleRevision: attempt.revision,
    operationId: attempt.operationId,
    ...(attempt.action === "trash"
      ? { selectedAlbumId: attempt.selectedAlbumId }
      : {}),
  };
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GalleryClientError("UNAVAILABLE");
  }
  if (attempt.action === "permanent-delete") {
    const row = await readGalleryResponse(response, purgeRequestResponseSchema);
    if (response.status !== 202 || row.operationId !== attempt.operationId)
      throw new GalleryClientError("UNAVAILABLE");
    return row;
  }
  const row = await readGalleryResponse(response, lifecycleResponseSchema);
  if (
    response.status !== 200 ||
    row.mediaId !== attempt.mediaId ||
    row.state !== (attempt.action === "trash" ? "TRASHED" : "ACTIVE") ||
    row.lifecycleRevision !== (BigInt(attempt.revision) + 1n).toString()
  )
    throw new GalleryClientError("UNAVAILABLE");
  return row;
}
export function reauthenticate(password: string) {
  return browserGallerySend("POST", "/api/v1/auth/reauth", z.undefined(), {
    password,
  });
}
export function unknownOutcome(error: unknown) {
  return !(error instanceof GalleryClientError) || error.code === "UNAVAILABLE";
}
export function lifecycleMessage(error: unknown) {
  if (unknownOutcome(error))
    return "结果尚不能确认，请刷新状态；不要重复提交。";
  switch ((error as GalleryClientError).code) {
    case "UNAUTHENTICATED":
      return "请重新登录；本次操作不会自动重发。";
    case "FORBIDDEN":
      return "权限或身份验证状态已变化，请刷新。";
    case "NOT_FOUND":
      return "对象不可见或状态已变化，请刷新。";
    case "CONFLICT":
      return "状态已变化或保留期未结束，请刷新后重新确认。";
    default:
      return "结果尚不能确认，请刷新状态；不要重复提交。";
  }
}
export function purgeMessage(row: PurgeStatus | null) {
  if (!row) return "无法确认最新状态。";
  if (row.executionState === "DONE")
    return row.progress === "COMPLETED" && row.completedAt
      ? "永久删除流程完成。"
      : "无法确认最新状态。";
  if (row.progress === "COMPLETED") return "无法确认最新状态。";
  return {
    QUEUED: "已请求，等待后台处理。",
    RUNNING: "后台处理中。",
    RETRY_WAIT: "后台暂缓，将按服务端规则处理。",
    BLOCKED: "后台处理受阻，需要维护检查。",
  }[row.executionState];
}

// A client identity check narrows the cookie-switch window; it is not a
// server-side ticket binding the identity of a subsequent request.
export async function requireLifecycleActor(userId: string, familyId: string) {
  const me = await browserGalleryGet("/api/v1/auth/me", meResponseSchema);
  if (
    me.user.id !== userId ||
    !me.memberships.some((m) => m.familyId === familyId)
  )
    throw new GalleryClientError("UNAUTHENTICATED");
}
