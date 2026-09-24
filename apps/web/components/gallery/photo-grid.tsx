"use client";

import { derivedPath } from "../../lib/gallery-paths.js";
import { PhotoPlaceholder } from "./states.js";

export function PhotoGrid({
  items,
  onOpen,
}: {
  items: { mediaId: string }[];
  onOpen: (mediaId: string) => void;
}) {
  return (
    <div className="gallery-grid">
      {items.map((item) => (
        <button
          key={item.mediaId}
          type="button"
          className="gallery-cell"
          onClick={() => onOpen(item.mediaId)}
        >
          <img
            src={derivedPath(item.mediaId, "thumbnail")}
            alt="家庭照片"
            loading="lazy"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
          <PhotoPlaceholder />
        </button>
      ))}
    </div>
  );
}
