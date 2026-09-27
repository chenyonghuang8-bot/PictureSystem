"use client";

import {
  albumsResponseSchema,
  galleryMediaDetailSchema,
} from "@family-album/contracts";
import { useEffect, useState } from "react";

import {
  GalleryClientError,
  browserGalleryGet,
} from "../../lib/gallery-client.js";
import {
  addMediaToAlbum,
  operableAlbums,
  placementErrorMessage,
} from "../../lib/gallery-placement.js";
import {
  albumsPath,
  derivedPath,
  mediaDetailPath,
} from "../../lib/gallery-paths.js";
import { AlbumSelector } from "./album-selector.js";
import { RemovePlacement } from "./remove-placement.js";

export type ViewerTarget = {
  mediaId: string;
  albumId: string;
};

export function PreviewFrame({
  preview,
  thumbnail,
  loading,
  broken,
  fallbackBroken,
  missing,
  onPreviewError,
  onThumbnailError,
  onLoaded,
}: {
  preview: string;
  thumbnail: string;
  loading: boolean;
  broken: boolean;
  fallbackBroken: boolean;
  missing: boolean;
  onPreviewError: () => void;
  onThumbnailError: () => void;
  onLoaded: () => void;
}) {
  return (
    <div
      className="gallery-viewer-preview"
      aria-busy={loading}
      data-state={missing ? "missing" : broken ? "fallback" : "preview"}
    >
      {missing ? (
        <p className="gallery-viewer-message">没有找到这张照片。</p>
      ) : broken ? (
        <>
          {fallbackBroken ? (
            <p className="gallery-viewer-message">暂时无法显示预览。</p>
          ) : null}
          {!fallbackBroken && loading ? (
            <span
              className="gallery-viewer-loading"
              aria-label="正在加载预览"
            />
          ) : null}
          {!fallbackBroken ? (
            <img
              className="gallery-viewer-image is-fallback"
              src={thumbnail}
              alt="家庭照片预览"
              onLoad={onLoaded}
              onError={onThumbnailError}
            />
          ) : null}
        </>
      ) : (
        <>
          {loading ? (
            <span
              className="gallery-viewer-loading"
              aria-label="正在加载预览"
            />
          ) : null}
          <img
            className={`gallery-viewer-image${loading ? " is-loading" : ""}`}
            src={preview}
            alt="家庭照片预览"
            onLoad={onLoaded}
            onError={onPreviewError}
          />
        </>
      )}
    </div>
  );
}

export function Viewer({
  items,
  index,
  familyId,
  onIndex,
  onClose,
  onRemovePlacement,
}: {
  items: ViewerTarget[];
  index: number;
  familyId: string;
  onIndex: (index: number) => void;
  onClose: () => void;
  onRemovePlacement?: (mediaId: string) => Promise<void>;
}) {
  const item = items[index];
  const [brokenPreview, setBrokenPreview] = useState(false);
  const [fallbackBroken, setFallbackBroken] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [detail, setDetail] = useState<string>("");
  const [missing, setMissing] = useState(false);
  const [albums, setAlbums] = useState<{ id: string; name: string }[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [placementMessage, setPlacementMessage] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setBrokenPreview(false);
    setFallbackBroken(false);
    setPreviewLoading(true);
    setDetail("");
    setMissing(false);
    browserGalleryGet(
      mediaDetailPath(item.albumId, item.mediaId),
      galleryMediaDetailSchema,
    )
      .then((row) => {
        if (cancelled) return;
        const lines = [
          row.displayWidth && row.displayHeight
            ? `${row.displayWidth} × ${row.displayHeight}`
            : null,
          row.orientation ? `方向 ${row.orientation}` : null,
          row.capturedLocalAt,
          [row.cameraMake, row.cameraModel].filter(Boolean).join(" ") || null,
        ].filter((line): line is string => line !== null);
        setDetail(lines.join("\n"));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMissing(
          error instanceof GalleryClientError && error.code === "NOT_FOUND",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [item?.albumId, item?.mediaId]);

  useEffect(() => {
    if (!item) return;
    setSelectedIds(new Set([item.albumId]));
    setConfirmingRemove(false);
    setPlacementMessage("");
  }, [item?.albumId, item?.mediaId]);

  useEffect(() => {
    let cancelled = false;
    browserGalleryGet(
      albumsPath(familyId, { limit: 100 }),
      albumsResponseSchema,
    )
      .then((page) => {
        if (cancelled) return;
        setAlbums(
          operableAlbums(page.albums).map((album) => ({
            id: album.id,
            name: album.name,
          })),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setPlacementMessage(placementErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [familyId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function addToAlbum(albumId: string) {
    if (!item) return;
    setPendingId(albumId);
    try {
      const result = await addMediaToAlbum(albumId, item.mediaId);
      setSelectedIds((current) => new Set(current).add(albumId));
      setPlacementMessage(
        result.created ? "已加入相册。" : "这张照片已经在这个相册里。",
      );
    } catch (error) {
      setPlacementMessage(placementErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  if (!item) return null;
  const preview = derivedPath(item.mediaId, "preview");
  const thumbnail = derivedPath(item.mediaId, "thumbnail");

  return (
    <div
      className="gallery-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="照片"
    >
      <button
        type="button"
        className="gallery-viewer-close"
        aria-label="关闭照片查看器"
        onClick={onClose}
      >
        <span aria-hidden="true">×</span>
        <span>关闭</span>
      </button>
      <div className="gallery-viewer-stage">
        <PreviewFrame
          preview={preview}
          thumbnail={thumbnail}
          loading={previewLoading}
          broken={brokenPreview}
          fallbackBroken={fallbackBroken}
          missing={missing}
          onPreviewError={() => {
            setBrokenPreview(true);
            setPreviewLoading(false);
          }}
          onThumbnailError={() => {
            setFallbackBroken(true);
            setPreviewLoading(false);
          }}
          onLoaded={() => setPreviewLoading(false)}
        />
      </div>
      <p className="gallery-viewer-meta">{detail}</p>
      <AlbumSelector
        albums={albums}
        selectedIds={selectedIds}
        pendingId={pendingId}
        message={placementMessage}
        onAdd={(albumId) => void addToAlbum(albumId)}
      />
      {onRemovePlacement && item ? (
        <RemovePlacement
          confirming={confirmingRemove}
          message={placementMessage}
          onAsk={() => setConfirmingRemove(true)}
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={() => {
            void onRemovePlacement(item.mediaId).catch((error: unknown) => {
              setPlacementMessage(placementErrorMessage(error));
            });
          }}
        />
      ) : null}
      <div className="gallery-viewer-nav">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => onIndex(index - 1)}
        >
          上一张
        </button>
        <button
          type="button"
          disabled={index === items.length - 1}
          onClick={() => onIndex(index + 1)}
        >
          下一张
        </button>
      </div>
    </div>
  );
}
