# Phase 5C Sharing Schema And API Design

Status: DESIGN ONLY. This document does not change code, schema, or migrations.

Baseline:

- `docs/progress/PHASE-05C-SHARING-DESIGN.md`
- `project-spec/PROJECT.md`
- `project-spec/database/DATABASE_SCHEMA.md`
- Implemented invitation and session tokens: 32-byte opaque token, SHA-256 hash, `BINARY(32)`
- `audit_logs` is named in the logical schema and is not a table in the current Drizzle schema

`PHASE_4_PRODUCTION_READY: NO`.

## 1. Share Target

V1 shares an album. It does not share a single media item.

An album is already the permission boundary. A share follows that album's current `album_media` placements. Removing a placement removes the photo from the share. A deleted album makes the share unreadable. No second ownership model is created.

A media share would need its own rule for which album authorizes the photo, and a photo in two albums would make that rule ambiguous. It would also let a link bypass the album the family uses to hide or gather photos. That target waits for a later design. The V1 table has `album_id` and no `media_id`.

The family product already groups photos into albums. One link for one album matches that grouping. Member download in `PROJECT.md` stays an internal member action. It is not this share.

## 2. Database Model

New table `shares`.

| Column | Type | Rule |
| --- | --- | --- |
| `id` | unsigned bigint | primary key |
| `family_id` | unsigned bigint | same family as the album |
| `album_id` | unsigned bigint | required |
| `token_hash` | binary(32) | unique, not the raw token |
| `created_by_member_id` | unsigned bigint | active member who created it |
| `created_at` | datetime(3) | server time |
| `expires_at` | datetime(3) | required, after `created_at` |
| `revoked_at` | datetime(3) nullable | set on revoke, row kept |
| `revoked_by_member_id` | unsigned bigint nullable | set with `revoked_at` |

Indexes:

- unique `token_hash`
- `(family_id, album_id, id)` for management listing
- foreign key `(family_id, album_id)` to `albums`, `RESTRICT`
- foreign key `created_by_member_id` and `revoked_by_member_id` to `family_members`, `RESTRICT`

No cascade. Soft-deleting an album does not delete the share row. A live share read also requires `albums.deleted_at IS NULL`.

V1 does not add a permissions column. The only capability is to view the album's current placements through thumbnail and preview. Upload, edit, member management, and original download are not share capabilities. A later original-download flag would be a new column with default off, reviewed on its own.

## 3. Token Design

Generation matches invitation and session tokens:

- 32 random bytes from a cryptographic generator
- encoded as canonical base64url, 43 characters
- stored hash is SHA-256 of those 32 bytes, 32 bytes in `token_hash`

The create response returns the raw token once, with `shareId` and `expiresAt`. Later management reads return the share id, album id, expiry, and revoke time. They never return the token or the hash.

Logs, audit rows, and error bodies do not contain the raw token. The public path contains the token, so access logs for that route must redact the path segment.

## 4. Public Viewer API

Anonymous. No session and no `Authorization` header. A browser that also has a session cookie can open the link; the cookie is ignored and does not add access.

`GET /api/v1/share/:token`

Returns the album name and one page of placements:

- `album.name`
- `media[]`: `mediaId`, `timelineKey`, `timelineBasis`, `displayWidth`, `displayHeight`, `thumbnail.kind = "thumbnail"`
- `nextCursor` using the existing gallery cursor

Order is `timeline_key DESC, media_id DESC`. Only placements in the shared album are included.

`GET /api/v1/share/:token/media/:mediaId/derived/:kind`

`kind` is `thumbnail` or `preview`. Bytes are the existing derived asset when it is READY and the media is still placed in the shared album. `Cache-Control: private, no-store`. `Referrer-Policy: no-referrer`.

The public responses do not include:

- GPS
- storage key, original path, filename
- family id, member id, owner, permissions
- token hash
- camera serial data

Missing preview or thumbnail stays absent. The response does not fall back to the original.

## 5. Internal Management API

These routes use the session cookie and the trusted JSON origin, same as other album mutations.

`POST /api/v1/albums/:albumId/share`

Body: `{ "expiresAt": "<ISO datetime>" }`. The server accepts it only when it is after server now and no later than 30 days after server now. Response `201`: `{ shareId, token, expiresAt }`. The token is only in this response.

`GET /api/v1/shares?familyId=`

Lists shares for albums in that family that the caller is allowed to manage. Each item has `shareId`, `albumId`, `createdAt`, `expiresAt`, `revokedAt`. No token and no hash. Cursor is `afterId`, ordered by share id.

`DELETE /api/v1/shares/:shareId`

Sets `revoked_at` and `revoked_by_member_id`. The row stays. A second revoke of an already revoked share returns the same revoked state. Response has no token.

## 6. Authorization

Internal management:

```text
Session
→ active family membership
→ album ACL
→ share row
```

Create and revoke require the caller to view the album and to be its owner or to have `canManageMembers`. Family role does not bypass a `CUSTOM` album. A member who can only view cannot create or revoke a share.

Public read:

```text
Token
→ SHA-256 lookup
→ share row not revoked and not expired
→ album not deleted
→ album_media placement
→ derived asset
```

The share does not change `album_members` or family membership. It does not grant the internal API. The internal API does not accept the share token.

## 7. Expiration

`expires_at <= server now`, `revoked_at` set, unknown token, malformed token, deleted album, and a media id that is not in the album all return `404` with the same not-found body.

They do not return `410`. A `410` would confirm that the link once existed. The body does not say whether the cause was expiry, revoke, or absence.

## 8. Audit

`audit_logs` is not an implemented table. V1 does not build the general audit log. Sharing gets a narrow table, `share_events`.

| Column | Rule |
| --- | --- |
| `id` | primary key |
| `family_id` | share family |
| `share_id` | the share row |
| `action` | `CREATE`, `ACCESS`, `REVOKE` |
| `actor_member_id` | member for create and revoke; null for anonymous access |
| `created_at` | server time |

`ACCESS` is written for the public album page, not for each derived byte. Rows are append-only. Revoke does not delete them. The raw token is not a column.

Create and revoke also keep the existing allowlisted security log, still without the token or hash.

## 9. Original Download

V1 share viewers cannot download the original. There is no original URL, path, or kind on the public API.

`PROJECT.md` member download stays inside the authenticated member product and is not opened by this token. A future design can add an explicit column, default off, plus its own audit action. Until that review, the share cannot be widened to originals.

## 10. Schema Impact

```text
Schema change: YES
```

Tables to add later, not in this change:

- `shares`
- `share_events`

No change to `album_media`, `media_items`, `storage_objects`, or `derived_assets`.

## Migration

```text
Migration: YES
```

The migration is not written here. When implementation is approved, it is an additive migration with the foreign keys and the unique `token_hash` index above. No backfill. No rewrite of migrations `0000`–`0004`.

## Findings

P0: none.

P1: the logical `audit_logs` table does not exist. Share audit is `share_events`, not a reuse of that missing table.

P2: the public token route needs rate limiting before production use. Access logs must redact the token path. Those are deployment controls, not extra columns.

P3: single-media shares, original download, and per-image access rows wait for a later review.

```text
SHARING_SCHEMA_API_DESIGN_PASS: YES
READY_FOR_IMPLEMENTATION: NO
```

Implementation waits for review of this schema and API design.
