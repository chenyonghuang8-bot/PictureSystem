# Phase 5C Share Service Design

Status: DESIGN ONLY. This document does not change code, schema, or migrations.

Baseline:

- `docs/progress/PHASE-05C-SHARING-DESIGN.md`
- `docs/progress/PHASE-05C-SHARING-SCHEMA-API-DESIGN.md`
- `docs/progress/PHASE-05C-SHARING-MIGRATION-DESIGN.md`
- Existing opaque tokens in `packages/auth/src/token.ts`: 32 random bytes, canonical base64url, SHA-256
- Album ACL stays in `packages/permissions` and the album repository

`PHASE_4_PRODUCTION_READY: NO`.

## 1. Boundary

The share service is `apps/api/src/shares/service.ts`.

It owns four operations:

- `createShare`
- `verifyShareToken`
- `revokeShare`
- `listShares`

Token bytes and hashing live beside the session and invitation helpers in `packages/auth/src/token.ts`:

- `createShareToken()`
- `hashShareToken()`

Those two functions do not read the database. The service calls them.

Row reads and writes go through a share repository in `packages/db`. The repository inserts, looks up by hash, lists, and sets revoke columns. It does not decide who may manage an album.

The service does not own:

- album ACL rules
- storage reads
- image processing
- derived byte serving

For create and revoke it asks the existing album permission context. The caller must be able to view the album and must be its owner or have `canManageMembers`. Family role does not bypass a `CUSTOM` album. The service does not copy that SQL.

Public reading returns a capability. The public route then reads current `album_media` through the existing album read path and serves `thumbnail` or `preview` through the existing derived reader. The share service does not open files.

## 2. Token

`createShareToken()` uses the same generator as session and invitation tokens:

- 32 bytes from `crypto.randomBytes`
- canonical base64url, 43 characters, alphabet `A-Za-z0-9_-`
- no padding

`hashShareToken()` decodes that canonical form and stores SHA-256 of the 32 bytes. The column is `token_hash binary(32)`. The raw string is not a column.

Raw token lifetime:

1. `createShare` generates it in memory.
2. The service hashes it and inserts only the hash, in the same transaction as the `CREATE` event.
3. The create result is the only object that still holds the raw token: `{ shareId, token, expiresAt }`.
4. The route may place that token in the `201` body. After that response, the service has no copy.
5. `listShares`, `revokeShare`, and `verifyShareToken` never return the token or the hash.
6. Logs, `share_events`, and error bodies never receive it.

Loss of the raw token cannot be repaired by reading the row. The member creates a new share.

## 3. Verification

`verifyShareToken(rawToken)`:

```text
raw token
→ canonical decode, or one not-found error
→ SHA-256
→ one lookup by token_hash
→ revoked_at is null
→ expires_at > server now
→ album exists and deleted_at is null
→ capability
```

The lookup is the unique `token_hash` index. The service does not load candidate hashes and compare them in JavaScript.

The capability is:

```text
shareId
familyId
albumId
expiresAt
```

It does not include the token, the hash, member ids, permissions, storage keys, or GPS.

Any failed check throws the same not-found error. The service does not return a reason.

## 4. Lifecycle

There is no status column. The row is the share.

| State | Stored meaning |
| --- | --- |
| Created | Insert has committed. `revoked_at` is null. The raw token has been returned once. |
| Active | `revoked_at` is null, `expires_at` is after server now, and the album is not deleted. |
| Expired | `revoked_at` is null and `expires_at` is at or before server now. The row stays. |
| Revoked | `revoked_at` and `revoked_by_member_id` are both set. The row stays. |

Created and Active are the same row until time or revoke changes the read. Expiry is not a write. Revoke can happen while the share is still before `expires_at`. A revoked row stays Revoked after `expires_at` passes, because `revoked_at` is set. Public verify treats Expired, Revoked, and a deleted album as the same not-found result.

Management reads return `expiresAt` and `revokedAt`. They do not return a status name derived for the client.

A second revoke sees `revoked_at` already set, returns that state, and does not change the row.

## 5. Access Flow

Anonymous public read:

```text
token
→ verifyShareToken
→ capability
→ current album_media for that album
→ derived thumbnail or preview
```

This path does not read the family session. A session cookie on the same browser is ignored. An `Authorization` header is ignored. Neither one adds albums, originals, or member identity.

The internal management routes are separate. They use the session cookie and the trusted JSON origin. They do not accept the share token.

Each public request verifies again. A capability is not cached past that request. Revoke and expiry apply on the next request.

Placement changes apply immediately because the read uses current `album_media`. The share service does not copy media ids onto the share.

## 6. Audit

`share_events.event_type` is `CREATE`, `ACCESS`, or `REVOKE`.

| Event | When | Actor |
| --- | --- | --- |
| `CREATE` | Same transaction as the share insert, after the permission check | creating member |
| `REVOKE` | Same transaction as setting `revoked_at`, and only when the row was not already revoked | revoking member |
| `ACCESS` | After a public album page has verified and the page query has succeeded | null |

`ACCESS` is the page, not each derived byte. A thumbnail or preview request verifies the token and does not write another event.

Failed access writes nothing. A malformed or unknown token has no share row. An expired, revoked, or deleted-album token would require a row that the response is not allowed to distinguish. Skipping the event keeps that failure off the audit table. Rate limiting counts those attempts outside `share_events`.

Rows are append-only. Revoke does not delete `CREATE` or `ACCESS`.

## 7. Errors

Public failure is one error. The route maps it to HTTP `404` and one not-found body.

That single result covers:

- malformed token
- unknown hash
- expired
- revoked
- deleted album
- media that is not placed in the shared album
- missing derived asset is an empty asset, not a different existence error for the share itself

The body does not say that a token exists, that it expired, that it was revoked, or that the album exists. The service does not use `410`.

Management errors stay on the session routes. An unknown share id or a share in an album the caller cannot see is `404`. A member who can view the album but cannot manage it gets `403` for create and revoke. Those routes do not echo the token.

## 8. Rate Limit

This design does not implement a limiter.

The boundary sits in front of the service, on the public routes only:

- token verification
- the public album page
- public derived `thumbnail` and `preview`

One gate covers those routes. It limits by client address and by a keyed form of the token that is not the raw token and is not written to `share_events`. The attempt is counted before `verifyShareToken` returns success or not-found. A limited request is HTTP `429` with a body that does not say whether the token was valid.

Create, list, and revoke stay on the session routes. They are not this public gate.

Numeric production limits are not chosen here. The service can be implemented without the gate. Production use of the public routes waits until that gate exists.

## 9. Security

Timing:

- The hash is looked up by the unique index, not compared in application code.
- Expired, revoked, and missing share take the same error after that lookup and do not write an audit row.
- A malformed token never reaches a hash compare against stored rows. It still returns the same `404`. A timing difference between a bad shape and an unknown well-formed token does not reveal a stored share.

Token logging:

- The service does not log the raw token, the hash, or the public path segment that contains the token.
- The public route redacts that path segment before access logs.

Raw token exposure:

- Only the create result carries it.
- List, revoke, verify, audit, and later reads do not.

Replay:

- While the share is Active, presenting the same token again is normal use of the link. It is not a one-time nonce.
- After expiry or revoke, the same token is not-found.
- Verification does not extend `expires_at` and does not clear `revoked_at`.

Sharing still does not change album ACL, and it still does not serve originals.

## Findings

P0: none.

P1: none. Public failure stays one `404`. The raw token is returned only from create.

P2: the public rate-limit gate is defined and not implemented. Production use of the public routes waits for it.

P3: a timing difference between a malformed string and an unknown canonical token remains. It does not confirm a stored share.

```text
SHARE_SERVICE_DESIGN_PASS: YES
READY_FOR_IMPLEMENTATION: NO
```

Implementation waits for review of this service design.
