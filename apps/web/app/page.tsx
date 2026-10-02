import { familyTimelinePageSchema } from "@family-album/contracts";

import { GalleryFallback } from "../components/gallery/fallback.js";
import { GalleryShell } from "../components/gallery/shell.js";
import { HomeHeader } from "../components/gallery/home-header.js";
import { SearchGallery } from "../components/gallery/search-gallery.js";
import {
  searchPath,
  searchFiltersFromUrl,
  searchFilterQuery,
} from "../lib/gallery-paths.js";
import { loadFamily, serverGalleryGet } from "../lib/gallery-server.js";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    const family = await loadFamily();
    const filters = searchFiltersFromUrl(
      searchParams ? await searchParams : {},
    );
    const page = await serverGalleryGet(
      searchPath(family.familyId, filters, { limit: PAGE_SIZE }),
      familyTimelinePageSchema,
    );
    return (
      <GalleryShell
        familyName={family.familyName}
        active="photos"
        aside={
          <p className="gallery-aside-note">
            按照片时间、相册或我的收藏，找回熟悉的瞬间。
          </p>
        }
      >
        <HomeHeader
          familyName={family.familyName}
          displayName={family.displayName}
        />
        <SearchGallery
          key={`${family.userId}:${family.familyId}:${searchFilterQuery(filters)}`}
          userId={family.userId}
          familyId={family.familyId}
          initial={page}
          initialFilters={filters}
        />
      </GalleryShell>
    );
  } catch (error) {
    return (
      <GalleryShell familyName="家庭相册" active="photos">
        <GalleryFallback error={error} />
      </GalleryShell>
    );
  }
}
