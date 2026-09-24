# Phase 5 Final Summary

# PHASE_05_FINAL_SUMMARY

## Overview

Phase 5 is Core Web UI & Sharing.

It moves the product from the Phase 4 media backend to the family gallery, album placement, and controlled album sharing. Gallery reads and album changes stay behind the existing album ACL and `album_media`. Sharing adds a separate token capability for one album. Original media stays immutable.

Baseline is `phase-4-complete` at `63cfee6`. Committed Phase 5 work runs from `0f36681` through `380f833` (Phase 5B album operations UI). Phase 5C implementation is complete. Git checkpoint is pending. There is no `phase-5-complete` tag.

```text
PHASE_4_PRODUCTION_READY: NO
PHASE_5_COMPLETE: YES
PHASE_5_PRODUCTION_READY: NO
```

## Phase 5A Gallery

Committed in `642734b`, `195427a`, and `4318599`.

- Album API: `GET /api/v1/albums`, `GET /api/v1/albums/:albumId/media`, and `GET /api/v1/albums/:albumId/media/:mediaId`. A member sees a photo only when album ACL and a current `album_media` placement both allow it.
- Timeline API: `GET /api/v1/families/:familyId/timeline`. The home lists media that appears in at least one album the member can view, newest `timelineKey` first. The same photo in two visible albums appears once.
- Web Gallery: warm three-column shell, 照片 timeline, and 相册 browse. Month groups are client-side. Empty and missing states stay quiet.
- Viewer: grid cells load `GET /api/v1/media/:mediaId/derived/thumbnail`. The detail viewer loads `preview`. The client does not receive an original path, storage key, or filename.

Phase 5A does not change schema.

## Phase 5B Album Operations

Committed in `d7483b4` and `380f833`.

- Add media to album: `POST /api/v1/albums/:albumId/media` with `{ mediaId }`. A duplicate placement returns `created: false` and does not insert a second row.
- Remove media from album: `DELETE /api/v1/albums/:albumId/media/:mediaId`. A missing placement returns `removed: false`.
- `album_media` placement is the only row these calls write or delete. The media item, original storage object, and derived assets remain. One photo can stay in another album after one placement is removed.

Add requires upload or edit permission. Remove requires delete-from-album permission. Cross-family placement is not found. The web viewer can add a photo to an operable album and remove it from the current album, and tells the member the photo stays in the family.

Phase 5B does not change schema. Display ordering was not added.

## Phase 5C Sharing

Phase 5C implementation is complete. Git checkpoint is pending. V1 shares an album, not a single media item.

Completed:

- sharing migration
- share service
- management API
- public API
- public UI

- `shares` stores `token_hash`, album, creator, `created_at`, `expires_at`, and revoke fields. The raw token is 32 random bytes, shown once in the create response, and is not stored.
- `share_events` records `CREATE`, `ACCESS`, and `REVOKE`. `ACCESS` is written for a successful public album page with `actor_member_id` NULL. Derived image requests do not write another event. Failed verification writes nothing.
- Management API: `POST /api/v1/albums/:albumId/share`, `GET /api/v1/shares`, and `DELETE /api/v1/shares/:shareId`. Create and revoke require album management permission. Revoke stops the link and keeps the row.
- Public viewer: anonymous `GET /api/v1/share/:token` and `GET /api/v1/share/:token/media/:mediaId/derived/:kind` for `thumbnail` and `preview` only. The web page is `/share/[token]`. Album detail can create a link, list shares, and stop access. Every public failure is the same not-found result.

## Security

- ACL first. Gallery and album operations authenticate the session, then apply family membership and album permissions. A hidden or deleted album is not found. A share token does not change internal ACL.
- Share capability. The public route trusts only the token hash lookup. Expired, revoked, and deleted-album links collapse to not found. The session cookie is ignored on those routes.
- No original exposure. Share responses omit family data, member data, storage keys, original paths, GPS, and internal permissions. `original` is rejected.
- Derived only. Member grids and the public page serve READY thumbnail and preview bytes through the existing derived reader. Public serving checks the current album placement before that read.

## Schema

New migration: `packages/db/drizzle/0005_phase_05c_sharing.sql`.

It creates `shares` and `share_events` only. Journal `0000`–`0004` is unchanged. Foreign keys are `RESTRICT`. `family_album_dev` has been migrated through `0005`.

```text
Phase 5A/5B: NO schema
Phase 5C: YES
```

## Validation

Phase 5 used targeted checks.

```text
Phase 5 full validation gate: NOT RUN
```

No single regression gate covering the whole of Phase 5 was recorded.

- Tests: Phase 5A gallery and timeline tests landed with the gallery commits. Phase 5B route and MySQL placement tests passed, including duplicate add, cross-family rejection, and removal that leaves media and derived assets in place. Phase 5C migration, share service (27), management API (9), public API (13), and share UI (6) tests passed on their targeted runs.
- Typecheck: `@family-album/api`, `@family-album/db`, `@family-album/contracts`, and `@family-album/web` passed on the Phase 5C slices that changed them.
- Migration: `0005` unit tests and the `family_album_dev` integration passed. Reapplying `0005` left existing album, placement, media, and derived rows in place.

## Deferred

- Rate limit. Public token and page limits are still required before production exposure.
- QR. Share links are copied as text. No QR image is generated.
- Analytics. Share events are the access record. There is no analytics dashboard.
- Bulk album operations. Add and remove are one placement at a time. Album display ordering is also still deferred.

Phase 4 production checks remain open: deployment validation, real power-loss validation, SSD disconnect validation, and persistent audit storage.

## Final State

```text
PHASE_5_COMPLETE: YES
PHASE_5_PRODUCTION_READY: NO
```

Phase 5 scope for the web gallery, album placement, and album sharing is implemented. That is not a production-ready claim. The Phase 5C git checkpoint is pending, and public rate limiting is not implemented.
