import {
  albumMediaPlacementSchema,
  albumMediaRemovalSchema,
  type albumsResponseSchema,
} from "@family-album/contracts";
import type { z } from "zod";

import { browserGallerySend, GalleryClientError } from "./gallery-client.js";
import { albumPlacementPath } from "./gallery-paths.js";

type AlbumRecord = z.infer<typeof albumsResponseSchema>["albums"][number];

export function operableAlbums(albums: AlbumRecord[]) {
  return albums.filter(
    (album) =>
      album.effectivePermissions.canUpload ||
      album.effectivePermissions.canEdit,
  );
}

export function placementErrorMessage(error: unknown) {
  if (!(error instanceof GalleryClientError)) return "暂时无法完成操作。";
  if (error.code === "UNAUTHENTICATED") return "需要登录后才能调整相册。";
  if (error.code === "FORBIDDEN") return "没有操作这个相册的权限。";
  if (error.code === "NOT_FOUND") return "没有找到这个相册。";
  return "暂时无法完成操作。";
}

export function removalKeptMessage() {
  return "已从相册移除。照片仍保留在家庭中，其他相册不受影响。";
}

export function addMediaToAlbum(albumId: string, mediaId: string) {
  return browserGallerySend(
    "POST",
    albumPlacementPath(albumId),
    albumMediaPlacementSchema,
    { mediaId },
  );
}

export function removeMediaFromAlbum(albumId: string, mediaId: string) {
  return browserGallerySend(
    "DELETE",
    albumPlacementPath(albumId, mediaId),
    albumMediaRemovalSchema,
    {},
  );
}
