"use client";

import {
  familyTimelinePageSchema,
  type FamilyTimelinePage,
  type FamilySearchFilters,
} from "@family-album/contracts";
import { useEffect, useRef, useState } from "react";

import {
  browserGalleryGet,
  GalleryClientError,
} from "../../lib/gallery-client.js";
import {
  groupByMonth,
  timelinePath,
  searchPath,
} from "../../lib/gallery-paths.js";
import { PhotoGrid } from "./photo-grid.js";
import { EmptyPhotos, UnavailableState } from "./states.js";
import { Viewer } from "./viewer.js";

const PAGE_SIZE = 24;

export function Timeline({
  userId,
  familyId,
  initial,
  filters,
  onRefresh,
  onAuthLost,
}: {
  userId: string;
  familyId: string;
  initial: FamilyTimelinePage;
  filters?: FamilySearchFilters;
  onRefresh?: () => void;
  onAuthLost?: () => void;
}) {
  const [items, setItems] = useState(initial.media);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  const pagePath = (nextCursor?: string) =>
    filters
      ? searchPath(familyId, filters, {
          limit: PAGE_SIZE,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        })
      : timelinePath(familyId, {
          limit: PAGE_SIZE,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        });

  async function loadMore() {
    if (!cursor || loading) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const page = await browserGalleryGet(
        pagePath(cursor),
        familyTimelinePageSchema,
        controller.signal,
      );
      if (!alive.current || controller.signal.aborted) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.mediaId));
        return current.concat(
          page.media.filter((item) => !seen.has(item.mediaId)),
        );
      });
      setCursor(page.nextCursor);
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return;
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      ) {
        setItems([]);
        setCursor(null);
        setOpenIndex(null);
        onAuthLost?.();
      }
      setFailed(true);
    } finally {
      if (alive.current && !controller.signal.aborted) setLoading(false);
    }
  }

  if (items.length === 0) return <EmptyPhotos />;
  const groups = groupByMonth(items);

  return (
    <div className="gallery-timeline">
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
        <>
          {loading ? (
            <div
              className="gallery-skeleton-grid"
              aria-label="正在加载"
              aria-live="polite"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <span
                  key={index}
                  className="gallery-skeleton-cell"
                  aria-hidden="true"
                />
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="gallery-text-button"
            onClick={() => void loadMore()}
            disabled={loading}
          >
            {loading ? "正在加载" : "加载更多"}
          </button>
        </>
      ) : null}
      {failed ? <UnavailableState /> : null}
      {openIndex !== null ? (
        <Viewer
          items={items.map((item) => ({
            mediaId: item.mediaId,
            albumId: item.albumId,
          }))}
          userId={userId}
          familyId={familyId}
          index={openIndex}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          onAuthLost={() => {
            onAuthLost?.();
            setOpenIndex(null);
            setItems([]);
            setCursor(null);
            setFailed(true);
          }}
          onTrashed={(mediaId) => {
            if (onRefresh) {
              onRefresh();
              return;
            }
            setOpenIndex(null);
            setItems((current) =>
              current.filter((item) => item.mediaId !== mediaId),
            );
            setCursor(null);
            void browserGalleryGet(pagePath(), familyTimelinePageSchema)
              .then((page) => {
                setItems(page.media);
                setCursor(page.nextCursor);
              })
              .catch(() => setFailed(true));
          }}
          onDetail={(detail) => {
            if (filters?.favoritesOnly && !detail.isFavorite) {
              onRefresh?.();
              return;
            }
            setItems((current) =>
              current.map((item) =>
                item.mediaId === detail.mediaId
                  ? {
                      ...item,
                      isFavorite: detail.isFavorite,
                      isFamilyFeatured: detail.isFamilyFeatured,
                    }
                  : item,
              ),
            );
          }}
        />
      ) : null}
    </div>
  );
}
