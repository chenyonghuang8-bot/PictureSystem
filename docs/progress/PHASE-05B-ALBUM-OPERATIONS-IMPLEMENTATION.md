# Phase 5B Album Operations Implementation

Status: IMPLEMENTATION. No schema change and no migration.

Baseline: `docs/progress/PHASE-05B-ALBUM-OPERATIONS-DESIGN.md`.

## APIs

`POST /api/v1/albums/:albumId/media`

```json
{ "mediaId": "..." }
```

Response `200`:

```json
{ "albumId": "...", "mediaId": "...", "created": true }
```

`created` is false when that placement already exists. The unique key stays one row.

`DELETE /api/v1/albums/:albumId/media/:mediaId`

Body is an empty JSON object so the existing trusted-origin guard applies. Response `200`:

```json
{ "albumId": "...", "mediaId": "...", "removed": true }
```

`removed` is false when that placement is already gone.

Neither response includes GPS, a storage key, or an original path.

## Authorization

The route authenticates the session, then the repository uses the existing album transaction: family lock, actor lock, album lock, and grant lock.

Visibility still goes through `assertVisible`, which calls `evaluateAlbumPermissions`. A missing album, a deleted album, a non-member, and a hidden album return `NOT_FOUND`.

Add is allowed when `canUploadToAlbum` or `canEditAlbum` is true. Remove is allowed when `canDeleteFromAlbum` is true. Those helpers are the Phase 2 permission service. A member who can view a `FAMILY` album but has none of those grants receives `FORBIDDEN`.

The media row must belong to the album's family. Another family's media id returns `NOT_FOUND`. The insert writes `family_id` from the locked album, not from the client.

## Transactions

Add and remove each run in one checked transaction. Add locks the media row and the existing placement, then inserts. Remove deletes only the matching `album_media` row. No storage call runs.

## Multi Album

A media item can stay in another album after one placement is removed. The home timeline still returns it while any visible placement remains. After the last placement is removed, the timeline omits it. `media_items`, `storage_objects`, and `derived_assets` stay.

## Tests

Targeted run passed:

- Route: missing session is 401; add and remove responses have no original fields.
- MySQL: success, duplicate add, cross-family reject, missing upload/edit permission, deleted album, hidden album, non-member, unknown media id.
- MySQL: remove one of two placements, timeline remains, remove the last placement, media, storage object, and derived asset remain.

## Schema Impact

```text
Schema change: NO
```

## Migration

```text
Migration: NO
```

## Findings

P0: none.

P1: none.

P2: add uses upload or edit. Remove uses the existing delete-from-album permission. Bulk placement is still deferred.

P3: ordering fields are still deferred. The delete request carries an empty JSON object so the current origin check can run.

```text
ALBUM_OPERATIONS_IMPLEMENTATION_PASS: YES
```
