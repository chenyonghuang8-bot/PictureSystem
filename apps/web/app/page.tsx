import { familyTimelinePageSchema } from "@family-album/contracts";

import { GalleryFallback } from "../components/gallery/fallback.js";
import { GalleryShell } from "../components/gallery/shell.js";
import { Timeline } from "../components/gallery/timeline.js";
import { derivedPath, timelinePath } from "../lib/gallery-paths.js";
import { loadFamily, serverGalleryGet } from "../lib/gallery-server.js";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

export default async function HomePage() {
  try {
    const family = await loadFamily();
    const page = await serverGalleryGet(
      timelinePath(family.familyId, { limit: PAGE_SIZE }),
      familyTimelinePageSchema,
    );
    const recent = page.media.slice(0, 4);
    return (
      <GalleryShell
        familyName={family.familyName}
        active="photos"
        aside={
          recent.length > 0 ? (
            <div className="gallery-recent">
              <p>近期照片</p>
              {recent.map((item) => (
                <img
                  key={item.mediaId}
                  src={derivedPath(item.mediaId, "thumbnail")}
                  alt="家庭照片"
                  loading="lazy"
                />
              ))}
            </div>
          ) : undefined
        }
      >
        <Timeline familyId={family.familyId} initial={page} />
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
