# Phase 5A Home Timeline Design

Status: DESIGN ONLY. This document does not change code, schema, migrations, or the API implementation.

Baseline: `phase-4-complete` at `63cfee6`. Album list, album media browse, album-scoped detail, and derived bytes already exist. `PHASE_4_PRODUCTION_READY: NO`.

Inputs: `project-spec/PROJECT.md`, `project-spec/ROADMAP.md`, and `docs/progress/PHASE-05A-GALLERY-UI-DESIGN.md`. The home screen is the family’s photographs, grouped by month. It is not one album grid.

## Endpoint

`GET /api/v1/families/:familyId/timeline`

Query:

- `cursor` optional
- `limit` 1–100, default 20

The path family must be the caller’s active family membership. Another family, a missing family, and a non-member are the same not-found result. Unauthenticated requests stay 401. An invalid cursor or id is 400.

No other route is added. Album browse stays `GET /api/v1/albums/:albumId/media`.

## Authorization

The read does not trust the client and does not copy a second permission model.

```text
Auth
  → active family membership in :familyId
  → album visibility
  → album_media placement
  → media_items
```

Album visibility is the Phase 2 view rule: the album is not deleted, and the member is the owner, or the album is `FAMILY`, or `album_members.can_view` is set. Family role does not bypass a `CUSTOM` album.

A media item appears only when at least one placement passes that rule. An orphan, a placement that exists only in a hidden album, and a placement that exists only in a deleted album are absent. Derived READY is not required for the row. Bytes are requested later on the existing derived route, which repeats its own check.

## Deduplication

A media item placed in several albums is one home row.

There is no stored canonical album. The media item remains the canonical photograph. The response carries one jump album so the client can open album-scoped detail.

Jump-album rule: among the live albums that contain this media and that this caller can view, choose the lowest album id. Hidden albums are not candidates and are not returned. The choice is stable for a caller whose view set does not change. It is not a grant. Detail still calls `GET /api/v1/albums/:albumId/media/:mediaId`, which checks that album again.

If the caller can view album A and not album B, the row exists because of A. The jump album is A when A is the lowest viewable album id. B is not named.

## Timeline Ordering

Order is `timeline_key DESC, media_id DESC`.

`timeline_key` already stores the product rule:

- capture time when `timeline_basis` is `CAPTURE_LOCAL`
- upload time when `timeline_basis` is `UPLOAD_UTC`

The home does not sort by filesystem time, `album_media.created_at`, or album id. Album id is only the jump-album tie break inside one media item.

Month headings are not a query. The client starts a new month when `timelineKey` enters a different calendar month. A page may contain the end of one month and the start of the next.

## Pagination

The cursor is untrusted and is checked on every request. It contains:

- `timelineKey`
- `mediaId`

Order is descending. The next page is the deduplicated rows whose `(timeline_key, media_id)` is strictly less than the cursor. The first page has no cursor. A full page returns the last row’s pair as `nextCursor`. A short page returns null.

Deduplication happens before `LIMIT`. Two placements of the same media do not take two slots and do not make that media appear on the next page.

This is keyset pagination. Offset pages are not used. The cursor is not a capability. Removing the last viewable placement removes the row on the next request.

## Response

Each item returns:

- `mediaId`
- `albumId` (the jump album)
- `timelineKey`
- `timelineBasis`
- `displayWidth` and `displayHeight` when present
- `thumbnail`: `{ "kind": "thumbnail" }`

The thumbnail field is not bytes, a path, a filename, or a storage key. The client loads `GET /api/v1/media/:mediaId/derived/thumbnail`.

Detail opens `GET /api/v1/albums/:albumId/media/:mediaId` with the returned `albumId` and `mediaId`. The viewer then loads derived `preview`.

The response has no GPS, no album list, no photo count, no original filename, and no processing state. Month grouping uses `timelineKey` on the client.

## Index Analysis

`idx_media_items_family_timeline (family_id, timeline_key, id)` already orders one family’s media by the timeline key. It does not know which albums the caller can view.

`uq_album_media_placement (family_id, album_id, media_id)` finds placements inside one album. `idx_album_media_media (family_id, media_id, album_id)` finds the albums that contain one media item.

The home query starts from the caller’s viewable placements, joins `media_items`, collapses to one row per media id, and sorts by `timeline_key, media_id`. At the current family size that plan is enough. Visibility is not an indexed column on `media_items`, and this design does not add one.

No new index is approved.

## Security

- ACL first. Membership and album view are evaluated on the server for every page.
- No original path, storage key, or filename is returned.
- Derived only. The timeline row does not include image bytes.
- A hidden album cannot contribute a jump album id.
- The same not-found result covers a non-member, a missing family, and no visible rows only when the caller is not a member. A member with no visible photographs gets an empty page, not a forged album.

## Schema Impact

```text
Schema change: NO
```

## Migration

```text
Migration: NO
```

## Findings

P0: none. Hidden placements do not create a home row or a jump album.

P1: none.

P2: the jump album is the lowest viewable album id, not a user-chosen cover album. Detail must recheck that album.

P3: the family timeline index does not store visibility. A later query review can revisit the plan. This design does not add an index.

```text
TIMELINE_DESIGN_PASS: YES
READY_FOR_IMPLEMENTATION: NO
```

Implementation waits for review of this contract.
