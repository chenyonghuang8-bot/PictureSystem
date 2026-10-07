import { albumsResponseSchema } from "@family-album/contracts";
// Bind the whole body lifetime to the caller's validated identity activation.
export async function privateAlbumPage(
  read: () => Promise<Response>,
  current: () => boolean,
  apply: (page: ReturnType<typeof albumsResponseSchema.parse>) => void,
) {
  if (!current()) return;
  const response = await read();
  if (!current()) return;
  const body = await response.json();
  if (!current()) return;
  const page = albumsResponseSchema.parse(body);
  apply(page);
}
