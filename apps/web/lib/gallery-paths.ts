import {
  familySearchQuerySchema,
  type FamilySearchFilters,
} from "@family-album/contracts";

const ID = /^[1-9][0-9]*$/;

export function assertGalleryId(id: string) {
  if (!ID.test(id)) throw new Error("GALLERY_ID_INVALID");
}

export function galleryQuery(
  path: string,
  query: Record<string, string | number | undefined>,
) {
  const url = new URL(path, "http://gallery.local");
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

export function timelinePath(
  familyId: string,
  input: { cursor?: string; limit: number },
) {
  assertGalleryId(familyId);
  return galleryQuery(`/api/v1/families/${familyId}/timeline`, {
    limit: input.limit,
    cursor: input.cursor,
  });
}

export function searchPath(
  familyId: string,
  filters: FamilySearchFilters,
  input: { cursor?: string; limit: number },
) {
  assertGalleryId(familyId);
  return galleryQuery(`/api/v1/families/${familyId}/search`, {
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    albumId: filters.albumId,
    favoritesOnly: filters.favoritesOnly ? "true" : undefined,
    limit: input.limit,
    cursor: input.cursor,
  });
}

export function searchFiltersFromUrl(
  values: Record<string, string | string[] | undefined>,
): FamilySearchFilters {
  if (
    Object.keys(values).some(
      (key) =>
        !["fromDate", "toDate", "albumId", "favoritesOnly"].includes(key),
    )
  )
    throw new Error("SEARCH_FILTERS_INVALID");
  const query = familySearchQuerySchema.parse(values);
  return {
    ...(query.fromDate ? { fromDate: query.fromDate } : {}),
    ...(query.toDate ? { toDate: query.toDate } : {}),
    ...(query.albumId ? { albumId: query.albumId } : {}),
    favoritesOnly: query.favoritesOnly,
  };
}

export function searchFilterQuery(filters: FamilySearchFilters) {
  return galleryQuery("/", {
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    albumId: filters.albumId,
    favoritesOnly: filters.favoritesOnly ? "true" : undefined,
  });
}

export function albumsPath(
  familyId: string,
  input: { afterId?: string; limit: number },
) {
  assertGalleryId(familyId);
  if (input.afterId !== undefined) assertGalleryId(input.afterId);
  return galleryQuery("/api/v1/albums", {
    familyId,
    limit: input.limit,
    afterId: input.afterId,
  });
}

export function albumPath(albumId: string) {
  assertGalleryId(albumId);
  return `/api/v1/albums/${albumId}`;
}

export function albumPlacementPath(albumId: string, mediaId?: string) {
  assertGalleryId(albumId);
  if (mediaId === undefined) return `/api/v1/albums/${albumId}/media`;
  assertGalleryId(mediaId);
  return `/api/v1/albums/${albumId}/media/${mediaId}`;
}

export function albumMediaPath(
  albumId: string,
  input: { cursor?: string; limit: number },
) {
  assertGalleryId(albumId);
  return galleryQuery(`/api/v1/albums/${albumId}/media`, {
    limit: input.limit,
    cursor: input.cursor,
  });
}

export function mediaDetailPath(albumId: string, mediaId: string) {
  assertGalleryId(albumId);
  assertGalleryId(mediaId);
  return `/api/v1/albums/${albumId}/media/${mediaId}`;
}

export function derivedPath(mediaId: string, kind: "thumbnail" | "preview") {
  assertGalleryId(mediaId);
  return `/api/v1/media/${mediaId}/derived/${kind}`;
}

export function mediaFeaturePath(
  albumId: string,
  mediaId: string,
  feature: "favorite" | "featured" | "tags" | "note" | "comments",
  childId?: string,
) {
  if (childId !== undefined) assertGalleryId(childId);
  return `${mediaDetailPath(albumId, mediaId)}/${feature}${childId ? `/${childId}` : ""}`;
}

export function originalDownloadPath(albumId: string, mediaId: string) {
  return `${mediaDetailPath(albumId, mediaId)}/download/original`;
}

export function previewDownloadPath(albumId: string, mediaId: string) {
  return `${mediaDetailPath(albumId, mediaId)}/download/preview`;
}

export function monthKey(timelineKey: string) {
  return timelineKey.slice(0, 7);
}

export function monthLabel(key: string) {
  const [year, month] = key.split("-");
  return `${year}年${Number(month)}月`;
}

export function groupByMonth<T extends { timelineKey: string }>(items: T[]) {
  const groups: { key: string; label: string; items: T[] }[] = [];
  for (const item of items) {
    const key = monthKey(item.timelineKey);
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, label: monthLabel(key), items: [item] });
  }
  return groups;
}
