"use client";

import {
  publicSharePageSchema,
  type GalleryMediaPage,
} from "@family-album/contracts";
import { useState } from "react";

import { GalleryClientError } from "../../lib/gallery-client.js";
import { groupByMonth } from "../../lib/gallery-paths.js";
import {
  loadPublicSharePage,
  publicDerivedPath,
} from "../../lib/share-client.js";
import { PhotoPlaceholder } from "./states.js";

const PAGE_SIZE = 24;

type PublicMedia = GalleryMediaPage["media"][number];

export function PublicShareMissing() {
  return (
    <main className="gallery-public">
      <section className="gallery-state" role="status">
        <h1>没有找到</h1>
        <p>这个链接无法打开。</p>
      </section>
    </main>
  );
}

export function PublicPhotoGrid({
  token,
  items,
  onOpen,
}: {
  token: string;
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
            src={publicDerivedPath(token, item.mediaId, "thumbnail")}
            alt="照片"
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

export function PublicViewer({
  token,
  items,
  index,
  previewFailed,
  onIndex,
  onClose,
}: {
  token: string;
  items: { mediaId: string }[];
  index: number;
  previewFailed?: boolean;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  const [failed, setFailed] = useState(previewFailed === true);
  if (!item) return null;
  return (
    <div
      className="gallery-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="照片"
    >
      <button type="button" className="gallery-viewer-close" onClick={onClose}>
        关闭
      </button>
      <div className="gallery-viewer-stage">
        {failed ? (
          <p>没有找到</p>
        ) : (
          <img
            src={publicDerivedPath(token, item.mediaId, "preview")}
            alt="照片"
            onError={() => setFailed(true)}
          />
        )}
        <PhotoPlaceholder />
      </div>
      <div className="gallery-viewer-nav">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => {
            setFailed(false);
            onIndex(index - 1);
          }}
        >
          上一张
        </button>
        <button
          type="button"
          disabled={index === items.length - 1}
          onClick={() => {
            setFailed(false);
            onIndex(index + 1);
          }}
        >
          下一张
        </button>
      </div>
    </div>
  );
}

export function PublicShare({
  token,
  initial,
}: {
  token: string;
  initial: {
    album: { name: string };
    media: PublicMedia[];
    nextCursor: string | null;
  };
}) {
  const [items, setItems] = useState(initial.media);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const groups = groupByMonth(items);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = publicSharePageSchema.parse(
        await loadPublicSharePage(token, { cursor, limit: PAGE_SIZE }),
      );
      setItems((current) => {
        const seen = new Set(current.map((item) => item.mediaId));
        return current.concat(
          page.media.filter((item) => !seen.has(item.mediaId)),
        );
      });
      setCursor(page.nextCursor);
    } catch (error) {
      if (error instanceof GalleryClientError && error.code === "NOT_FOUND") {
        setMissing(true);
      }
    } finally {
      setLoading(false);
    }
  }

  if (missing) return <PublicShareMissing />;

  return (
    <main className="gallery-public">
      <h1 className="gallery-page-title">{initial.album.name}</h1>
      {items.length === 0 ? (
        <section className="gallery-state" role="status">
          <p>还没有照片</p>
        </section>
      ) : null}
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h2>{group.label}</h2>
          <PublicPhotoGrid
            token={token}
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
      {openIndex !== null ? (
        <PublicViewer
          token={token}
          items={items}
          index={openIndex}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      ) : null}
    </main>
  );
}
