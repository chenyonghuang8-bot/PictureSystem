# Phase 5C Share Service Implementation

Status: IMPLEMENTED. Schema, migrations, UI, rate limit, CDN, and original download are unchanged.

Baseline:

- `docs/progress/PHASE-05C-SHARE-SERVICE-DESIGN.md`
- `docs/progress/PHASE-05C-SHARING-SCHEMA-API-DESIGN.md`

`PHASE_4_PRODUCTION_READY: NO`.

## Repository

`packages/db/src/share-repository.ts` provides `MySqlShareRepository`.

- `insertShare` writes the hash, album, creator, and expiry
- `findByTokenHash` reads one row by the unique hash, with album deletion and server time
- `listShares` returns shares for albums the caller may manage
- `revokeShare` sets `revoked_at` and `revoked_by_member_id`

Create and revoke call `MySqlAlbumRepository.withAlbumManager`. That uses the existing album lock and `canManageAlbumMembers`. The share repository does not define album ACL. A second revoke returns the existing row and does not write another event.

## Token

`createShareToken()` and `hashShareToken()` are in `packages/auth/src/token.ts`.

The token is 32 cryptographic random bytes, canonical base64url. The database insert receives only the SHA-256 hash. The raw token is returned only from `createShare`.

## Service

`apps/api/src/shares/service.ts` implements `ShareService`.

`createShare` checks the session through the album manager, generates the token, inserts the share, and inserts `CREATE`.

`verifyShareToken` hashes a canonical token, loads the row, and rejects revoked, expired, deleted-album, unknown, and malformed tokens as `404 NOT_FOUND`. The capability is `shareId`, `familyId`, `albumId`, and `expiresAt`.

`revokeShare` checks management permission, updates the revoke columns, and inserts `REVOKE`.

`listShares` returns share id, album id, created time, expiry, and revoke time.

A member who can view but not manage receives `403`. A hidden album or unknown share receives `404`. Family role does not bypass a `CUSTOM` album.

## Audit Events

`CREATE` is in the insert transaction, with the creating member. `REVOKE` is in the first revoke transaction, with the revoking member. A repeated revoke does not add a row. Failed verification writes nothing.

`ACCESS` is not written here. The design attaches it to a successful public album page, and this change does not add that route.

## Tests

- `packages/auth/src/token.test.ts`
- `apps/api/src/shares/service.test.ts`
- `tests/integration/phase5c-share-service.test.ts` on `family_album_dev`

Covered: unique hash, raw token absent from the row, verify success, expired, revoked, invalid token, create permission, revoke permission, and `CREATE` / `REVOKE` events.

Targeted result: 27 tests PASS. `@family-album/api` and `@family-album/db` typecheck PASS.

## Security

Lookup uses `token_hash`. The service does not log the raw token or the hash. List, revoke, and verify responses omit both. An active token can be presented again until expiry or revoke. Verification does not change those columns.

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

P2: the public rate-limit gate remains unimplemented, as this task required.

P3: `ACCESS` waits for the public album page. Verify does not write it.

```text
SHARE_SERVICE_IMPLEMENTATION_PASS: YES
```
