"use client";

export function AlbumSelector({
  albums,
  selectedIds,
  pendingId,
  message,
  onAdd,
}: {
  albums: { id: string; name: string }[];
  selectedIds: ReadonlySet<string>;
  pendingId: string | null;
  message: string;
  onAdd: (albumId: string) => void;
}) {
  return (
    <section className="gallery-selector" aria-label="加入相册">
      <p>加入相册</p>
      {albums.length === 0 ? <small>没有可以放入的相册。</small> : null}
      <div>
        {albums.map((album) => {
          const selected = selectedIds.has(album.id);
          return (
            <button
              key={album.id}
              type="button"
              aria-pressed={selected}
              disabled={pendingId === album.id}
              onClick={() => onAdd(album.id)}
            >
              <span>{album.name}</span>
              <small>{selected ? "已加入" : "加入"}</small>
            </button>
          );
        })}
      </div>
      {message ? <p className="gallery-selector-note">{message}</p> : null}
    </section>
  );
}
