// Synthetic component host for 7D actor/modal regressions; all API traffic is
// intercepted by the browser test. No application server or media is used.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TrashAction } from "../../apps/web/components/gallery/trash-action.js";
import { TrashPanel } from "../../apps/web/components/gallery/trash-panel.js";
const item = {
  mediaId: "11",
  lifecycleRevision: "1",
  mediaType: "IMAGE" as const,
  timelineKey: "2026-09-18T00:00:00.000Z",
  trashedAt: "2026-09-01T00:00:00.000Z",
  purgeAfter: "2026-10-01T00:00:00.000Z",
  capabilities: {
    canRestore: true,
    permanentDeleteEligibility: "READY" as const,
  },
};
const detail = {
  mediaId: "11",
  timelineKey: item.timelineKey,
  timelineBasis: "UPLOAD_UTC" as const,
  displayWidth: 100,
  displayHeight: 80,
  thumbnail: { kind: "thumbnail" as const },
  preview: { kind: "preview" as const },
  isFavorite: false,
  isFamilyFeatured: false,
  orientation: 1,
  capturedLocalAt: null,
  cameraMake: null,
  cameraModel: null,
  tags: [],
  note: null,
  noteRevision: "1",
  lifecycleRevision: "1",
  commentCount: "0",
  capabilities: {
    canTrash: true,
    canManageFeatured: false,
    canEditTags: true,
    canEditNote: true,
    canComment: true,
    canDownloadOriginal: true,
    canDownloadPreview: true,
  },
};
function Host() {
  const [invalid, setInvalid] = useState(false),
    [trashed, setTrashed] = useState(false);
  return (
    <>
      <a id="outside" href="#outside">
        背景导航
      </a>
      {invalid ? (
        <p role="status">身份已变化，旧查看器已清空。</p>
      ) : new URLSearchParams(location.search).has("viewer") ? (
        <TrashAction
          userId="7"
          familyId="4"
          target={{ albumId: "3", mediaId: "11" }}
          detail={detail}
          onUnavailable={() => setInvalid(true)}
          onTrashed={() => setTrashed(true)}
          onLeave={() => setInvalid(true)}
          onBlock={() => {}}
        />
      ) : (
        <TrashPanel
          familyId="4"
          userId="7"
          initial={{
            items: [item, { ...item, mediaId: "12" }],
            nextCursor: null,
          }}
        />
      )}
      {trashed ? <p role="status">已移入回收站。</p> : null}
      <script type="application/json" id="synthetic-detail">
        {JSON.stringify(detail)}
      </script>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Host />);
