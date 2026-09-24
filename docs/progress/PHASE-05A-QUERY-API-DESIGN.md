# Phase 5A Query and API Design

Status: DESIGN ONLY. This document does not change code, schema, migrations, or the API implementation.

Baseline: `phase-4-complete` at `63cfee6`. Phase 4 is complete through authenticated derived serving. `PHASE_4_PRODUCTION_READY: NO`.

Inputs: `docs/progress/PHASE-05A-GALLERY-DESIGN.md`, Phase 2 album ACL (`GET /api/v1/albums` and `evaluateAlbumPermissions`), `album_media`, and Phase 4 derived serving.

## APIs

### Album list

`GET /api/v1/albums` already exists. Phase 5A uses that contract and does not add fields.

Request:

- `familyId` (required)
- `afterId` (optional cursor)
- `limit` (1–100, default 20)

Response:

- `albums`: existing album object (`id`, `familyId`, `ownerMemberId`, `name`, `description`, `visibility`, `revision`, `createdAt`, `updatedAt`, `effectivePermissions`)
- `nextAfterId`: last album id on a full page, otherwise null

Authorization is the existing Phase 2 list: active family member, album `deleted_at` is null, then owner or `FAMILY` visibility or `album_members.can_view = 1`. Hidden albums are excluded before `LIMIT`. Family role does not bypass `CUSTOM`.

Cover: not returned.

`mediaCount`: not returned. A live count is not part of this response, and a stored counter is not added. Either choice waits for a later review.

### Album media browse

`GET /api/v1/albums/:albumId/media`

This route does not exist yet. This document only defines it.

Request:

- `albumId` in the path
- `cursor` optional
- `limit` 1–100, default 20

Each item returns:

- `mediaId`
- `timelineKey`
- `timelineBasis` (`CAPTURE_LOCAL` or `UPLOAD_UTC`)
- `displayWidth` and `displayHeight` when present
- `thumbnail`: `{ "kind": "thumbnail" }`

The thumbnail field is not a path, filename, storage key, or byte payload. The client loads bytes from the existing `GET /api/v1/media/:mediaId/derived/thumbnail` route. Preview is not used on this list.

Rows are placements in the named album. A missing READY thumbnail stays a row; the derived route returns the existing not-found result. `processing_state` and failure codes are not returned.

### Media detail

Choice: **B**, `GET /api/v1/albums/:albumId/media/:mediaId`.

**A**, `GET /api/v1/media/:id`, is not the gallery detail route. A media id by itself is not a gallery capability. Option A would describe the media whenever any viewable placement exists, including a placement the client did not name.

Option B checks the named album. A caller who can view the media in album A and requests album B receives the same not-found result as a missing placement. The response does not reveal the other album.

The existing derived byte route stays `GET /api/v1/media/:mediaId/derived/:kind`. This design does not change it. Detail metadata is album-scoped; bytes remain on the Phase 4 route after that route repeats its own authorization.

Detail response:

- the browse fields
- `orientation` when present
- `capturedLocalAt` when capture time exists
- `cameraMake` and `cameraModel` when present
- `preview`: `{ "kind": "preview" }`

Preview bytes come from `GET /api/v1/media/:mediaId/derived/preview`. Detail does not inline bytes and does not return an original.

## Authorization

Gallery routes do not define a second permission model. They call the existing session authentication and the existing album view rule, then require the placement chain:

```text
Auth
  → Album ACL (owner, or FAMILY, or can_view; deleted albums excluded)
  → album_media
  → media_items
  → derived READY, only when bytes are requested
```

Browse and detail are one family-scoped query for the named album. A media id does not skip the album. An album id does not skip `album_media`. Derived READY is required only for bytes, on the existing derived route.

Missing membership, a deleted album, a `CUSTOM` album without `can_view`, a missing placement, and a cross-family id are the same not-found result on the new media routes. Unauthenticated requests stay 401. Invalid ids stay 400.

## Pagination

Album list keeps its Phase 2 cursor: `afterId` is an album id, order is `id ASC`, and the next page is `id > afterId`. That is keyset pagination, not offset pagination.

Album media uses a new cursor. It is not `album_media.created_at`. Placement time is not capture time.

Cursor contents, untrusted and checked on every request:

- `timelineKey`
- `mediaId`

Order: `timeline_key DESC, media_id DESC`.

The next page is the rows in that album whose `(timeline_key, media_id)` is strictly less than the cursor. The first page has no cursor. A full page returns the last row’s pair as `nextCursor`; a short page returns null.

An invalid cursor is 400. The server re-checks authentication, album ACL, and `album_media` on every page. The cursor is not a capability.

This keyset stays stable when new photos sort at the start of a later page. Offset pages would skip or repeat rows under inserts. The tie-break on `media_id` keeps equal timestamps ordered.

## Timeline

`media_items` already stores the rule:

- `timeline_basis = CAPTURE_LOCAL` and `timeline_key = captured_local_at` when capture time exists
- otherwise `timeline_basis = UPLOAD_UTC` and `timeline_key = uploaded_at`

Gallery sort uses `timeline_key DESC, id DESC`. It does not use filesystem mtime, `album_media.created_at`, or a new column.

No new timeline field is required. No migration is designed here.

## Detail

Detail is option B above. It returns metadata for one placement the caller can view. It does not return storage identity, original filename, SHA-256, or album ids other than the one in the path.

## Metadata

Returned on detail only:

- dimensions: `displayWidth`, `displayHeight`
- `orientation`
- capture time: `capturedLocalAt`, with `timelineBasis` showing whether the timeline fell back to upload time
- camera: `cameraMake`, `cameraModel`

### GPS

GPS is not returned on the album list, the browse list, or the detail response.

`gps_latitude` and `gps_longitude` already exist on `media_items`. Showing them would publish a location from the original. Phase 5A does not add a GPS field, a precision-reducing copy, or a viewer preference. A later review has to decide whether any member who can view the photo may see coordinates. Until that review, the API omits both values.

## Index Analysis

`uq_album_media_placement (family_id, album_id, media_id)` supports album → media. A browse query can find that album’s placements with the family and album prefix, then join `media_items`.

It does not order those placements by capture time. `album_media` has no timeline column.

`idx_media_items_family_timeline (family_id, timeline_key, id)` already supports a family timeline. It is not an album index. The album page filters placements first, then sorts the joined `timeline_key`.

`idx_album_media_media (family_id, media_id, album_id)` supports media → album. Detail for a named album uses the placement unique key, not this index.

No additional index is approved. At the current family size, the album filter plus a sort on the joined timeline key is the query. A stored album-scoped timeline index would be a new schema decision and is not part of this design.

## Schema Impact

```text
Schema change: NO
```

No cover column, media counter, timeline column, GPS copy, or index is added.

## Migration Required

```text
Migration: NO
```

## Security

- Album list authorization stays in the Phase 2 query.
- Browse and detail require album ACL, then `album_media`, then `media_items`.
- Bytes require derived READY through the existing derived route.
- Responses contain no original path, storage key, or filesystem metadata.
- GPS stays off the gallery responses.
- A media id is not enough to call the new detail route.
- Hidden albums and missing placements share one not-found result.

## Findings

P0: none

P1: none

P2: the existing derived byte route is still keyed by media id. This design does not change that route. Album-scoped metadata does not remove that byte path.

P3: cover, `mediaCount`, GPS, and custom ordering remain deferred. Album timeline order is not a dedicated index.

```text
QUERY_API_DESIGN_PASS: YES
READY_FOR_PHASE_5A_IMPLEMENTATION: NO
```

Implementation waits for review of this document.
