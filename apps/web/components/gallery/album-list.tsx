"use client";

import { albumsResponseSchema } from "@family-album/contracts";
import { useState } from "react";
import type { z } from "zod";

import { browserGalleryGet } from "../../lib/gallery-client.js";
import { albumsPath } from "../../lib/gallery-paths.js";
import { EmptyAlbums, UnavailableState } from "./states.js";

type AlbumPage = z.infer<typeof albumsResponseSchema>;

const PAGE_SIZE = 20;

const VISIBILITY = {
  FAMILY: "家庭可见",
  CUSTOM: "指定成员",
} as const;

export function AlbumList({
  familyId,
  initial,
}: {
  familyId: string;
  initial: AlbumPage;
}) {
  const [albums, setAlbums] = useState(initial.albums);
  const [afterId, setAfterId] = useState(initial.nextAfterId);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function loadMore() {
    if (!afterId || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const page = await browserGalleryGet(
        albumsPath(familyId, { afterId, limit: PAGE_SIZE }),
        albumsResponseSchema,
      );
      setAlbums((current) => {
        const seen = new Set(current.map((album) => album.id));
        return current.concat(
          page.albums.filter((album) => !seen.has(album.id)),
        );
      });
      setAfterId(page.nextAfterId);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  if (albums.length === 0) return <EmptyAlbums />;

  return (
    <div>
      <h1 className="gallery-page-title">相册</h1>
      <div className="gallery-albums">
        {albums.map((album) => (
          <a
            key={album.id}
            className="gallery-album-card"
            href={`/albums/${album.id}`}
          >
            <span>{album.name}</span>
            <small>{VISIBILITY[album.visibility]}</small>
          </a>
        ))}
      </div>
      {afterId ? (
        <button
          type="button"
          className="gallery-text-button"
          onClick={() => void loadMore()}
        >
          {loading ? "正在加载" : "加载更多"}
        </button>
      ) : null}
      {failed ? <UnavailableState /> : null}
    </div>
  );
}
