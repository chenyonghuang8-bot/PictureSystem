import { GalleryShell } from "../../components/gallery/shell.js";
import { GalleryFallback } from "../../components/gallery/fallback.js";
import { AdminWorkspace } from "../../components/admin/workspace.js";
import { loadFamily } from "../../lib/gallery-server.js";
export const dynamic = "force-dynamic";
export default async function AdminPage() {
  try {
    const family = await loadFamily();
    return (
      <GalleryShell familyName={family.familyName} active="admin">
        <AdminWorkspace
          key={`${family.userId}:${family.familyId}`}
          userId={family.userId}
          familyId={family.familyId}
        />
      </GalleryShell>
    );
  } catch (error) {
    return (
      <GalleryShell familyName="家庭相册" active="admin">
        <h1>家庭管理</h1>
        <GalleryFallback error={error} />
      </GalleryShell>
    );
  }
}
