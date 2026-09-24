"use client";

import {
  galleryMediaPageSchema,
  type GalleryMediaPage,
} from "@family-album/contracts";
import { useState } from "react";

import { browserGalleryGet } from "../../lib/gallery-client.js";
import { albumMediaPath, groupByMonth } from "../../lib/gallery-paths.js";
import { PhotoGrid } from "./photo-grid.js";
import { EmptyPhotos, UnavailableState } from "./states.js";
import { Viewer } from "./viewer.js";

const PAGE_SIZE = 24;

export function AlbumDetail({
  albumId,
  albumName,
  initial,
}: {
  albumId: string;
  albumName: string;
  initial: GalleryMediaPage;
}) {
  const [items, setItems] = useState(initial.media);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const groups = groupByMonth(items);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const page = await browserGalleryGet(
        albumMediaPath(albumId, { cursor, limit: PAGE_SIZE }),
        galleryMediaPageSchema,
      );
      setItems((current) => {
        const seen = new Set(current.map((item) => item.mediaId));
        return current.concat(
          page.media.filter((item) => !seen.has(item.mediaId)),
        );
      });
      setCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 className="gallery-page-title">{albumName}</h1>
      {items.length === 0 ? <EmptyPhotos /> : null}
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h2>{group.label}</h2>
          <PhotoGrid
            items={group.items}
            onOpen={(mediaId) => {
              const index = items.findIndex((item) => item.mediaId === mediaId);
              if (index >= 0) setOpenIndex(index);
            }}
          />
        </section>
      ))}
      {cursor ? (
        <button
          type="button"
          className="gallery-text-button"
          onClick={() => void loadMore()}
        >
          {loading ? "正在加载" : "加载更多"}
        </button>
      ) : null}
      {failed ? <UnavailableState /> : null}
      {openIndex !== null ? (
        <Viewer
          items={items.map((item) => ({ mediaId: item.mediaId, albumId }))}
          index={openIndex}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      ) : null}
    </div>
  );
}
