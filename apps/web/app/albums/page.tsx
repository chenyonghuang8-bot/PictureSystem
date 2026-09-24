import { albumsResponseSchema } from "@family-album/contracts";

import { AlbumList } from "../../components/gallery/album-list.js";
import { GalleryFallback } from "../../components/gallery/fallback.js";
import { GalleryShell } from "../../components/gallery/shell.js";
import { albumsPath } from "../../lib/gallery-paths.js";
import { loadFamily, serverGalleryGet } from "../../lib/gallery-server.js";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export default async function AlbumsPage() {
  try {
    const family = await loadFamily();
    const page = await serverGalleryGet(
      albumsPath(family.familyId, { limit: PAGE_SIZE }),
      albumsResponseSchema,
    );
    return (
      <GalleryShell familyName={family.familyName} active="albums">
        <AlbumList familyId={family.familyId} initial={page} />
      </GalleryShell>
    );
  } catch (error) {
    return (
      <GalleryShell familyName="家庭相册" active="albums">
        <GalleryFallback error={error} />
      </GalleryShell>
    );
  }
}
