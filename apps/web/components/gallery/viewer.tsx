"use client";

import { galleryMediaDetailSchema } from "@family-album/contracts";
import { useEffect, useState } from "react";

import {
  GalleryClientError,
  browserGalleryGet,
} from "../../lib/gallery-client.js";
import { derivedPath, mediaDetailPath } from "../../lib/gallery-paths.js";
import { PhotoPlaceholder } from "./states.js";

export type ViewerTarget = {
  mediaId: string;
  albumId: string;
};

export function Viewer({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: ViewerTarget[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  const [brokenPreview, setBrokenPreview] = useState(false);
  const [detail, setDetail] = useState<string>("");
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setBrokenPreview(false);
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
  }, [item]);

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
      <button type="button" className="gallery-viewer-close" onClick={onClose}>
        关闭
      </button>
      <div className="gallery-viewer-stage">
        {missing ? (
          <p>没有找到这张照片。</p>
        ) : brokenPreview ? (
          <img src={thumbnail} alt="家庭照片" />
        ) : (
          <img
            src={preview}
            alt="家庭照片"
            onError={() => setBrokenPreview(true)}
          />
        )}
        <PhotoPlaceholder />
      </div>
      <p className="gallery-viewer-meta">{detail}</p>
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
