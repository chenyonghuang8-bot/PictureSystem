import { Map as MapLibreMap, LngLatBounds } from "maplibre-gl";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchGallery } from "../../apps/web/components/gallery/search-gallery.js";
// Synthetic viewport boundary injection exercises the real UI emit -> URL ->
// API query contract around zero; remote hosted-load testing has no injection.
if (new URLSearchParams(location.search).has("nearZeroBounds")) {
  MapLibreMap.prototype.getBounds = function () {
    return new LngLatBounds([-0.0000001, -0.0000001], [10, 10]);
  };
}
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
