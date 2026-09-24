# Phase 5C Sharing Management API Implementation

Status: IMPLEMENTED. Schema, migrations, public anonymous routes, CDN, rate limit, and original download are unchanged.

Baseline:

- `docs/progress/PHASE-05C-SHARING-PUBLIC-API-DESIGN.md`
- `docs/progress/PHASE-05C-SHARE-SERVICE-DESIGN.md`
- `ShareService` create, list, and revoke

`PHASE_4_PRODUCTION_READY: NO`.

## APIs

Authenticated management routes are in `apps/api/src/shares/routes.ts`.

`POST /api/v1/albums/:albumId/share` accepts `{ expiresAt }` and returns `201` `{ shareId, token, expiresAt }`.

`GET /api/v1/shares?familyId=` returns `{ shares, nextAfterId }`. Each share has `shareId`, `albumId`, `createdAt`, `expiresAt`, and `revokedAt`.

`DELETE /api/v1/shares/:shareId` accepts `{}` and returns `{ shareId, albumId, revokedAt }`.

Create and revoke use the trusted JSON origin. Responses use `Cache-Control: no-store`.

## Authorization

Every route requires the session cookie. `ShareService` then checks family membership and album management. The caller must be the album owner or have `canManageMembers`. A family role does not bypass a `CUSTOM` album. List returns only shares for albums that caller can manage in the requested family.

## Service Usage

The routes call `createShare`, `listShares`, and `revokeShare`. They do not generate tokens or write share rows themselves. Revoke sets `revoked_at` and `revoked_by_member_id` and writes `REVOKE` inside the service. A second revoke returns the same revoked state.

## Errors

Missing session is `401`. A member who can view but not manage receives `403`. An unknown share or an album the caller cannot see is `404` with the ordinary not-found message. The body does not say whether a share exists or what state a token is in.

## Tests

`apps/api/src/shares/routes.test.ts` and `packages/contracts/src/shares.test.ts` cover create success, missing session, view-without-manage, hidden custom album, token absent from later list results, list without token or hash, revoke success, duplicate revoke, and unknown share.

Targeted result: 9 tests PASS. `@family-album/api` and `@family-album/contracts` typecheck PASS.

## Security

The raw token is copied only into the create response. List and revoke DTOs name their fields and do not include `token` or `token_hash`. Security logs record actor, family, album, and share id. They do not record the token or the hash.

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

P2: public rate limiting remains unimplemented. These routes are the authenticated management API, not the public token routes.

P3: anonymous share reading is not part of this change.

```text
SHARING_MANAGEMENT_API_IMPLEMENTATION_PASS: YES
```
