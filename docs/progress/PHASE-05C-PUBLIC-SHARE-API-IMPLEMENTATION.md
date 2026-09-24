# Phase 5C Public Share API Implementation

Status: IMPLEMENTED. Schema, migrations, original download, CDN, rate limiting, and single-media shares are unchanged.

Baseline:

- `docs/progress/PHASE-05C-SHARING-PUBLIC-API-DESIGN.md`
- `docs/progress/PHASE-05C-SHARE-SERVICE-DESIGN.md`
- `ShareService.verifyShareToken`
- existing derived byte reader (`readDerivedFinal`)

`PHASE_4_PRODUCTION_READY: NO`.

## APIs

Anonymous routes are in `apps/api/src/shares/public-routes.ts`. They do not read the session cookie or `Authorization`.

`GET /api/v1/share/:token` returns `{ album: { name }, media, nextCursor }`. Each media item is the gallery item: `mediaId`, `timelineKey`, `timelineBasis`, `displayWidth`, `displayHeight`, and `thumbnail.kind = thumbnail`. The page uses the existing gallery cursor (`timelineKey`, `mediaId`) ordered `timeline_key DESC, id DESC`.

`GET /api/v1/share/:token/media/:mediaId/derived/:kind` returns `image/webp` bytes for `thumbnail` and `preview`.

Both responses set `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`.

## Share Verification

`PublicShareService.openAlbum` calls `ShareService.verifyShareToken`, then `MySqlShareRepository.readSharedAlbum`. Verification already collapses a missing, revoked, expired, or deleted-album token into one not-found result. The page query reads the album name only while `deleted_at IS NULL`, then the current `album_media` rows joined to `media_items`.

## Derived Serving

`openDerived` verifies the token, accepts only `thumbnail` or `preview`, and requires a numeric media id. `MySqlDerivedReadRepository.findReadyDerivedInAlbum` checks the current album placement, a non-deleted album, a non-blocked media item, available storage, and a READY webp derived asset at recipe 1. Bytes are read through the same `DerivedByteReader` identity used by member derived serving (`familyId`, `mediaId`, `generation`, `recipeId: 1`, `kind`, `sha256Hex`, `byteSize`) and `sharedCapacityGate.readDerivedFinal`. This change does not add a storage read path. `original` never reaches that lookup.

## ACCESS Events

A successful album page writes one `share_events` row with `event_type = ACCESS` and `actor_member_id = NULL`. The insert stores `family_id` and `share_id` only. Thumbnail and preview requests do not write `ACCESS`. A failed verification writes nothing.

A still-valid share whose media placement was removed returns the album name and an empty media list, and that successful page writes `ACCESS`. The removed media id is not served.

## Errors

Every public failure is HTTP 404 with `The requested resource was not found.` That includes an invalid, expired, or revoked token, a deleted album, a removed placement on the derived route, a missing or unready derived asset, `original`, a bad cursor, and a storage read failure. The body and security logs do not say whether the token, album, or media exists. Logs use `share_access` with `shareId`, `share_derived` with `kind`, or `share_public` with `NOT_FOUND`. They do not record the token, the token hash, or the public URL.

## Tests

`apps/api/src/shares/public-service.test.ts` covers a valid page and one access call, invalid / expired / revoked / deleted-album verification with no access event, a removed placement, thumbnail and preview through the existing reader, `original` rejection, and a missing derived asset.

`apps/api/src/shares/public-routes.test.ts` covers the page shape, `Cache-Control: private, no-store`, an ignored session cookie, thumbnail bytes, `original` as 404, and one not-found message.

`tests/integration/phase5c-public-share.test.ts` uses `family_album_dev`. It covers a live page, one `ACCESS` row with a null actor, thumbnail and preview bytes, no extra `ACCESS` on derived reads, `original` rejection, a missing preview, a removed placement, and expired, revoked, deleted-album, and invalid tokens. The page JSON does not contain the token, family data, a storage key, an original path, or GPS.

Targeted result: 13 tests PASS. `@family-album/api`, `@family-album/db`, and `@family-album/contracts` typecheck PASS.

## Security

The response schema is strict. It does not include family id, member id, storage key, original path, GPS, camera fields, or album permissions. `shareId` is used only in the success log and is removed before the response is sent. Anonymous callers cannot reach member derived serving or the management routes through these handlers.

## Schema Impact

```text
Schema: NO
```

## Migration

```text
Migration: NO
```

## Findings

P0: none.

P1: none.

P2: public rate limiting remains unimplemented. This task does not add it.

P3: none.

```text
PUBLIC_SHARE_API_IMPLEMENTATION_PASS: YES
```
