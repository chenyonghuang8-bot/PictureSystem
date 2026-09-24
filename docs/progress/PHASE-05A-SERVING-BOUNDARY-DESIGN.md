# Phase 5A Serving Boundary Design

Status: DESIGN ONLY. This document does not change code, schema, migrations, or the API implementation.

Baseline: `phase-4-complete` at `63cfee6`. Gallery metadata is designed as `GET /api/v1/albums/:albumId/media/:mediaId`. Derived bytes remain `GET /api/v1/media/:mediaId/derived/:kind`.

## Current Problem

The two routes name different resources.

Metadata names an album. A caller who can view the photo in album A and requests album B is not found.

Bytes name only the media. The server allows the read when any live placement is viewable. The response does not include an album id.

The bytes are one derived object per family, media, generation, recipe, and kind. They are not stored once per album.

## Options

### Scheme A

Keep `GET /api/v1/media/:mediaId/derived/:kind`.

The server still requires authentication, then at least one live `album_media` row in an album the caller can view, then the media row, then a READY derived asset. A media id without that chain returns the same not-found result as a hidden album.

### Scheme B

Add or replace that route with `GET /api/v1/albums/:albumId/media/:mediaId/derived/:kind`.

The named album would have to pass the same view rule and contain the placement. Another viewable album would not satisfy this URL.

## Security Analysis

Media X is placed in album A and album B. The caller can view A and cannot view B.

Scheme A returns the derived bytes. It does not return B’s id, name, or a placement count. Phase 4 visibility already defines this: access is the union of view rights, and lack of access to B does not veto A.

Scheme A does not let a caller who can view neither album read the bytes. An orphan, a deleted album, a `CUSTOM` album without `can_view`, and a non-READY asset stay not-found.

The remaining difference is contextual. Scheme A succeeds whenever any viewable placement exists. Scheme B fails when the named album is B, even though A would allow the same bytes. That hides the B placement from an album-scoped probe. It does not remove the caller’s right to the bytes through A.

Replacing the Phase 4 route with scheme B would change a shipped contract. A caller who already received the media id from a viewable album would need to carry that album id only to fetch the same bytes. A leaked media id still fails for a caller with no viewable placement under either scheme.

## Multi Album Behavior

The same derived URL may be reused.

The caller who can view A uses `GET /api/v1/media/:mediaId/derived/thumbnail` and the matching preview URL. Those URLs do not name B and do not become a grant for B. If the placement in A is removed and no other viewable placement remains, the next request is not found. Bytes already held by the client are a client copy, not a new server grant.

Metadata stays album-scoped. Requesting album B’s detail remains not-found. That does not withdraw the byte grant that A still provides.

## API Decision

Keep scheme A for derived bytes.

Do not add scheme B in Phase 5A, and do not change the Phase 4 route.

Gallery metadata stays `GET /api/v1/albums/:albumId/media/:mediaId`.

The permission chain is one chain:

```text
Auth
  → Album ACL
  → album_media
  → media_items
  → derived READY
```

Metadata binds one album id from the path. Bytes existentially check the caller’s viewable placements. Both use the Phase 2 view rule: owner, or `FAMILY`, or `can_view`, and the album is not deleted. Family role is not a bypass. Neither route copies a second permission model.

## Cache Decision

The derived response is `Cache-Control: private, no-store`. It is not a shared or CDN cache entry.

If a later review allows a private cache, the cache key is the media and the kind. The bytes do not vary by album. An album-scoped URL would store the same body once per album and would make that URL look like an album grant. The media-scoped URL matches the derived object.

`private` keeps the response off shared caches. `no-store` means Phase 5A does not rely on reuse after access is revoked. Revocation is enforced on the next request by the placement check.

## Schema Impact

```text
Schema change: NO
```

Derived assets do not gain an album id, a visibility flag, or a per-album copy.

## Migration Required

```text
Migration: NO
```

## Findings

P0: none. A caller who cannot view A does not receive bytes or B’s identity.

P1: none.

P2: metadata names an album and bytes do not. This is an intentional split of URL scope, not a second authorization model. Scheme B would change the shipped derived route.

P3: `no-store` avoids a private cache outliving a removed placement. A later private-cache review must keep the key on media and kind.

```text
SERVING_BOUNDARY_DESIGN_PASS: YES
READY_FOR_PHASE_5A_IMPLEMENTATION: NO
```

Implementation waits for review of this boundary.
