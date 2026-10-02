import { GalleryShell } from "../../components/gallery/shell.js";
import { GalleryFallback } from "../../components/gallery/fallback.js";
import { TrashPanel } from "../../components/gallery/trash-panel.js";
import { loadFamily, serverGalleryGet } from "../../lib/gallery-server.js";
import { trashPath } from "../../lib/trash-client.js";
import { trashPageSchema } from "@family-album/contracts";
export const dynamic = "force-dynamic";
export default async function TrashPage() {
  try {
    const family = await loadFamily();
    const initial = await serverGalleryGet(
      trashPath(family.familyId),
      trashPageSchema,
    );
    return (
      <GalleryShell familyName={family.familyName} active="trash">
        <h1>回收站</h1>
        <TrashPanel
          key={`${family.userId}:${family.familyId}`}
          familyId={family.familyId}
          userId={family.userId}
          initial={initial}
        />
      </GalleryShell>
    );
  } catch (error) {
    return (
      <GalleryShell familyName="家庭相册" active="trash">
        <h1>回收站</h1>
        <GalleryFallback error={error} />
      </GalleryShell>
    );
  }
}
