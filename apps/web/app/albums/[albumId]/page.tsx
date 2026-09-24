import {
  albumResponseSchema,
  galleryMediaPageSchema,
} from "@family-album/contracts";

import { AlbumDetail } from "../../../components/gallery/album-detail.js";
import { GalleryFallback } from "../../../components/gallery/fallback.js";
import { GalleryShell } from "../../../components/gallery/shell.js";
import {
  albumMediaPath,
  albumPath,
  assertGalleryId,
} from "../../../lib/gallery-paths.js";
import { GalleryClientError } from "../../../lib/gallery-client.js";
import { loadFamily, serverGalleryGet } from "../../../lib/gallery-server.js";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

export default async function AlbumDetailPage({
  params,
}: {
  params: Promise<{ albumId: string }>;
}) {
  const { albumId } = await params;
  try {
    assertGalleryId(albumId);
    const family = await loadFamily();
    const album = await serverGalleryGet(
      albumPath(albumId),
      albumResponseSchema,
    );
    const page = await serverGalleryGet(
      albumMediaPath(albumId, { limit: PAGE_SIZE }),
      galleryMediaPageSchema,
    );
    return (
      <GalleryShell familyName={family.familyName} active="albums">
        <AlbumDetail
          albumId={albumId}
          albumName={album.name}
          familyId={family.familyId}
          initial={page}
        />
      </GalleryShell>
    );
  } catch (error) {
    const shown =
      error instanceof Error && error.message === "GALLERY_ID_INVALID"
        ? new GalleryClientError("NOT_FOUND")
        : error;
    return (
      <GalleryShell familyName="家庭相册" active="albums">
        <GalleryFallback error={shown} />
      </GalleryShell>
    );
  }
}
