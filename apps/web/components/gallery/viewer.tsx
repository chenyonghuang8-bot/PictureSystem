"use client";

import {
  albumsResponseSchema,
  galleryMediaDetailSchema,
  type GalleryMediaDetail,
} from "@family-album/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

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
import { ViewerDetails, viewerErrorMessage } from "./viewer-details.js";

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

type ViewerProps = {
  items: ViewerTarget[];
  index: number;
  familyId: string;
  onIndex: (index: number) => void;
  onClose: () => void;
  onRemovePlacement?: (mediaId: string) => Promise<void>;
  onDetail?: (detail: GalleryMediaDetail) => void;
};

export function Viewer(props: ViewerProps) {
  const target = props.items[props.index];
  if (!target) return null;
  return (
    <ViewerSession
      key={`${props.familyId}:${target.albumId}:${target.mediaId}`}
      {...props}
    />
  );
}

function ViewerSession({
  items,
  index,
  familyId,
  onIndex,
  onClose,
  onRemovePlacement,
  onDetail,
}: ViewerProps) {
  const item = items[index];
  const [brokenPreview, setBrokenPreview] = useState(false);
  const [fallbackBroken, setFallbackBroken] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [detail, setDetail] = useState<GalleryMediaDetail | null>(null);
  const [detailMessage, setDetailMessage] = useState("");
  const alive = useRef(false);
  const detailRequest = useRef(0);
  const detailCallback = useRef(onDetail);
  useEffect(() => {
    detailCallback.current = onDetail;
  }, [onDetail]);
  const [missing, setMissing] = useState(false);
  const [albums, setAlbums] = useState<{ id: string; name: string }[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [placementMessage, setPlacementMessage] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const onDetailFailure = useCallback((error: unknown) => {
    if (!alive.current) return;
    setDetailMessage(viewerErrorMessage(error));
    if (
      error instanceof GalleryClientError &&
      (error.code === "NOT_FOUND" || error.code === "UNAUTHENTICATED")
    ) {
      detailRequest.current += 1;
      setDetail(null);
      setMissing(true);
    }
  }, []);

  const reloadDetail = useCallback(async () => {
    if (!item) return;
    const request = ++detailRequest.current;
    try {
      const row = await browserGalleryGet(
        mediaDetailPath(item.albumId, item.mediaId),
        galleryMediaDetailSchema,
      );
      if (!alive.current || request !== detailRequest.current) return;
      setDetail(row);
      setMissing(false);
      setDetailMessage("");
      detailCallback.current?.(row);
    } catch (error) {
      if (request === detailRequest.current) onDetailFailure(error);
      throw error;
    }
  }, [item?.albumId, item?.mediaId, onDetailFailure]);

  useEffect(() => {
    alive.current = true;
    void reloadDetail().catch(() => undefined);
    return () => {
      alive.current = false;
      detailRequest.current += 1;
    };
  }, [reloadDetail]);

  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);

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
      if (!alive.current) return;
      setSelectedIds((current) => new Set(current).add(albumId));
      setPlacementMessage(
        result.created ? "已加入相册。" : "这张照片已经在这个相册里。",
      );
    } catch (error) {
      if (alive.current) setPlacementMessage(placementErrorMessage(error));
    } finally {
      if (alive.current) setPendingId(null);
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
        ref={closeButton}
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
      {detail ? (
        <ViewerDetails
          detail={detail}
          target={item}
          reload={reloadDetail}
          onFailure={onDetailFailure}
        />
      ) : null}
      {detailMessage ? (
        <p className="gallery-viewer-message" role="status">
          {detailMessage}
        </p>
      ) : null}
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
              if (alive.current)
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
