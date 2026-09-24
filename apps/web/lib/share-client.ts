import {
  createShareResponseSchema,
  publicSharePageSchema,
  revokeShareResponseSchema,
  shareListResponseSchema,
  type shareManagementItemSchema,
} from "@family-album/contracts";
import type { z } from "zod";

import {
  browserGalleryGet,
  browserGallerySend,
  GalleryClientError,
} from "./gallery-client.js";
import { assertGalleryId, galleryQuery } from "./gallery-paths.js";

const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type ShareListItem = z.infer<typeof shareManagementItemSchema>;

export function assertShareToken(token: string) {
  if (!SHARE_TOKEN.test(token)) throw new Error("SHARE_TOKEN_INVALID");
}

export function shareExpiry(days: 7 | 30, now = new Date()) {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

export function shareLink(origin: string, token: string) {
  assertShareToken(token);
  const url = new URL(origin);
  if (url.username || url.password || url.protocol === "javascript:") {
    throw new GalleryClientError("UNAVAILABLE");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GalleryClientError("UNAVAILABLE");
  }
  return `${url.origin}/share/${token}`;
}

export function sharesForAlbum(shares: ShareListItem[], albumId: string) {
  assertGalleryId(albumId);
  return shares.filter((share) => share.albumId === albumId);
}

export function shareTimeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function createSharePath(albumId: string) {
  assertGalleryId(albumId);
  return `/api/v1/albums/${albumId}/share`;
}

export function listSharesPath(familyId: string) {
  assertGalleryId(familyId);
  return galleryQuery("/api/v1/shares", { familyId, limit: 100 });
}

export function revokeSharePath(shareId: string) {
  assertGalleryId(shareId);
  return `/api/v1/shares/${shareId}`;
}

export function publicSharePath(
  token: string,
  input: { cursor?: string; limit: number },
) {
  assertShareToken(token);
  return galleryQuery(`/api/v1/share/${token}`, {
    limit: input.limit,
    cursor: input.cursor,
  });
}

export function publicDerivedPath(
  token: string,
  mediaId: string,
  kind: "thumbnail" | "preview",
) {
  assertShareToken(token);
  assertGalleryId(mediaId);
  if (kind !== "thumbnail" && kind !== "preview") {
    throw new Error("SHARE_DERIVED_KIND");
  }
  return `/api/v1/share/${token}/media/${mediaId}/derived/${kind}`;
}

export function shareErrorMessage(error: unknown) {
  if (!(error instanceof GalleryClientError)) return "暂时无法完成操作。";
  if (error.code === "UNAUTHENTICATED") return "需要登录后才能管理分享。";
  if (error.code === "FORBIDDEN") return "没有管理这个相册分享的权限。";
  if (error.code === "NOT_FOUND") return "没有找到。";
  return "暂时无法完成操作。";
}

export function createShare(albumId: string, expiresAt: Date) {
  return browserGallerySend(
    "POST",
    createSharePath(albumId),
    createShareResponseSchema,
    { expiresAt: expiresAt.toISOString() },
  );
}

export function listShares(familyId: string) {
  return browserGalleryGet(listSharesPath(familyId), shareListResponseSchema);
}

export function revokeShare(shareId: string) {
  return browserGallerySend(
    "DELETE",
    revokeSharePath(shareId),
    revokeShareResponseSchema,
    {},
  );
}

export function loadPublicSharePage(
  token: string,
  input: { cursor?: string; limit: number },
) {
  return browserGalleryGet(
    publicSharePath(token, input),
    publicSharePageSchema,
  );
}
