# Phase 5B Album Operations UI Implementation

Status: IMPLEMENTATION. No schema change, no migration, and no API change.

Baseline:

- `docs/progress/PHASE-05B-ALBUM-OPERATIONS-UI-DESIGN.md`
- `docs/progress/PHASE-05B-ALBUM-OPERATIONS-DESIGN.md`

## Components

The photo viewer contains an album selector. It lists albums whose effective permissions include upload or edit. A known placement is shown as selected, with the label 已加入.

Album detail opens the same viewer and adds a confirmation step titled 从相册移除. The confirmation says the photo stays in the family and other albums are unaffected. The screen does not say 删除照片.

## API Usage

Add calls `POST /api/v1/albums/:albumId/media` with `{ mediaId }`. A response with `created: false` stays on the selected album.

Remove calls `DELETE /api/v1/albums/:albumId/media/:mediaId` with an empty JSON object. After success, that photo leaves the open album grid and the page says the photo remains in the family.

Album choices come from `GET /api/v1/albums`. The client does not invent covers or counts.

## UI Flow

Opening a photo loads the selector. Choosing an album creates a placement. Choosing it again repeats the same request and keeps the selected state.

On an album page, 从相册移除 asks for confirmation before the delete request. The photo then disappears from that album only.

## Security

401, 403, and 404 become short status text: sign in, no permission, or not found. The client does not decide whether the mutation is allowed. Responses are not shown if they fail the placement schema. The UI does not show GPS, a storage key, or an original path.

## Tests

Targeted web tests passed, including selector render, add success, duplicate placement, remove success, permission text, and the kept-photo message.

The signed-out album page still renders in the browser. The selector itself needs a signed-in family with photos, so that overlay was not clicked in the browser.

## Schema Impact

```text
Schema change: NO
```

## Migration

```text
Migration: NO
```

```text
ALBUM_OPERATIONS_UI_IMPLEMENTATION_PASS: YES
```
