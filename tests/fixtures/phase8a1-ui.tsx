import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchGallery } from "../../apps/web/components/gallery/search-gallery.js";
const initialFilters = new URLSearchParams(location.search).has("favoritesOnly")
  ? { favoritesOnly: true }
  : { favoritesOnly: false };
function Host() {
  const [userId, setUserId] = useState("7");
  const mediaId = userId === "7" ? "11" : "12";
  return (
    <>
      <button id="switch-actor" onClick={() => setUserId("8")}>
        切换测试账号
      </button>
      <SearchGallery
        key={userId}
        userId={userId}
        familyId="4"
        initialFilters={initialFilters}
        initial={{
          media: [
            {
              mediaId,
              albumId: "3",
              timelineKey: "2024-02-29T00:00:00.000Z",
              timelineBasis: "UPLOAD_UTC",
              displayWidth: 100,
              displayHeight: 100,
              thumbnail: { kind: "thumbnail" },
              isFavorite: initialFilters.favoritesOnly,
              isFamilyFeatured: false,
            },
          ],
          nextCursor: "initial-cursor",
        }}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Host />
  </StrictMode>,
);
