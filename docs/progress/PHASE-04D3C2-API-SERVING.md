# Phase 4D3c-2c — Derived asset API serving

Status: implemented. No UI, CDN, public URL, share link, or original-download change. Schema and migration are unchanged.

## Endpoint

`GET /api/v1/media/:mediaId/derived/:kind`

The client sends a canonical media id and a kind. Kind is only `thumbnail` or `preview`. The request has no path, filename, storage key, album id, generation, or recipe. Anything else is `400` and is not opened.

The response is the file bytes.

| Header | Value |
| --- | --- |
| `content-type` | `image/webp` |
| `content-length` | exact byte length |
| `cache-control` | `private, no-store` |

There is no second cache. A refusal is the existing auth error body. Hidden media, a deleted album, a missing association, a non-READY asset, a missing file, and a digest mismatch all return `404` with the same not-found message. They do not name the internal state.

## Authentication

The route uses the existing web session cookie and `AuthService.authenticate`. No new login, token, or anonymous mode was added. A missing cookie is `401` and does not query album or derived rows. An `Authorization` header is still rejected by the existing cookie parser.

## Authorization

One SQL statement is the whole visibility decision:

```text
active family member
  → album_media for the requested media
  → album in that family with deleted_at IS NULL
  → media_items in that family, not BLOCKED
  → storage_objects.state = AVAILABLE
  → derived_assets READY for the media's current generation, recipe 1, and requested kind
  → owner, FAMILY visibility, or explicit can_view
```

`evaluateAlbumPermissions` is not replaced. The SQL uses the same view rule: active member, same family, album not deleted, then owner, or `FAMILY`, or `can_view`. Family role is not an input. `ADMIN` does not bypass a `CUSTOM` album.

The derived join is only reachable through `album_media`. A media id by itself returns no row. If several albums can show the media, the query keeps one. The response and the success log do not include an album id, a hidden album, a path, or a digest.

## Storage

After that row exists, the API calls `CapacityGate.readDerivedFinal` with the family, media, generation, recipe, kind, SHA-256, and size from the database. The native read walks `derived/<family>/<media>/r1/g<generation>/{thumbnail,preview}.webp` from the pinned media root. It accepts only a regular file, mode `0400`, one link, the caller's ownership, the expected size, and the expected SHA-256.

The API method does not take a path. It does not call `open(path)` and it does not call `OriginalReader`. A file that exists only under `originals/` is not returned.

This read was added beside `inspectDerivedFinal` because no existing call returned derived bytes. It does not change publish, recovery decisions, the renderer, the verifier, or the worker.

## Tests

- Authenticated thumbnail and preview succeed for an explicit `can_view` member.
- No cookie is `401` before authorization.
- Same-family non-member, `ADMIN` without a grant, another family, an orphan with no `album_media` row, a soft-deleted album, and `BLOCKED` media are the same `404`. The storage read is not called.
- `RESERVED`, `PUBLISHING`, `FAILED`, and `MISSING` are `404` even when the final file exists.
- A digest mismatch and a missing final are `404`.
- `original`, a path segment, and `thumbnail.webp` are `400` and do not reach storage.
- Phase 2 album route tests, the permission unit tests, the `0004` migration test, and the worker processor unit tests were run again for regression.

## Not in this slice

No gallery UI, no placement API, and no original download. `SCHEMA` and `MIGRATION` stay as already reviewed. Serving does not write `album_media`.

The route lives in `apps/api/src/derived-serving/`. A directory named `derived/` is gitignored because that name is the on-disk media namespace.
