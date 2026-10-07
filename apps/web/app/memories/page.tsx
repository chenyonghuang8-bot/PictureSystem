import { memoriesKindSchema } from "@family-album/contracts";
import { GalleryShell } from "../../components/gallery/shell.js";
import { GalleryFallback } from "../../components/gallery/fallback.js";
import { Memories } from "../../components/gallery/memories.js";
import { loadFamily } from "../../lib/gallery-server.js";
export const dynamic = "force-dynamic";
export default async function MemoriesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    const family = await loadFamily(),
      query = searchParams ? await searchParams : {};
    const kind = memoriesKindSchema.parse(query.kind ?? "ON_THIS_DAY");
    return (
      <GalleryShell
        userId={family.userId}
        familyId={family.familyId}
        familyName={family.familyName}
        active="memories"
      >
        <header className="gallery-home-header">
          <h1>回忆</h1>
        </header>
        <nav aria-label="回忆类型">
          <a href="/memories?kind=ON_THIS_DAY">往年今日</a>{" "}
          <a href="/memories?kind=LAST_YEAR_WEEK">一年前的这周</a>
        </nav>
        <Memories
          userId={family.userId}
          familyId={family.familyId}
          kind={kind}
        />
      </GalleryShell>
    );
  } catch (error) {
    return (
      <GalleryShell familyName="家庭相册" active="memories">
        <GalleryFallback error={error} />
      </GalleryShell>
    );
  }
}
