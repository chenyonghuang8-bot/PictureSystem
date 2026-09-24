# Phase 5C Sharing Migration Implementation

Status: IMPLEMENTED. API, UI, and the sharing token service are not part of this change.

Baseline:

- `docs/progress/PHASE-05C-SHARING-MIGRATION-DESIGN.md`
- `docs/progress/PHASE-05C-SHARING-SCHEMA-API-DESIGN.md`

`PHASE_4_PRODUCTION_READY: NO`.

## Migration

`packages/db/drizzle/0005_phase_05c_sharing.sql` is the only new SQL file.

Journal entry `idx` 5, tag `0005_phase_05c_sharing`. Snapshot `0005` `prevId` is `29b5833a-bb05-466f-b3d3-288112405627`, the unchanged `0004` snapshot id. Files `0000` through `0004` are unchanged.

The migration creates `shares` and `share_events` only. It does not alter `albums`, `album_media`, `media_items`, or `derived_assets`.

Drizzle schema tables `shares` and `shareEvents` match that SQL. `PROJECT_TABLES` in migration readiness includes them after `album_media`. The Phase 4 predecessor list is still the first nine tables.

`family_album_dev` has been migrated. Readiness reports 6 migrations.

## Tables

`shares`: `id`, `family_id`, `album_id`, `token_hash`, `created_by_member_id`, `created_at`, `expires_at`, `revoked_at`, `revoked_by_member_id`.

`share_events`: `id`, `family_id`, `share_id`, `event_type`, `actor_member_id`, `created_at`.

`event_type` is `CREATE`, `ACCESS`, or `REVOKE`. There is no metadata, IP, or user agent column.

## Constraints

- `uq_shares_token_hash`
- `chk_shares_expiry`: `expires_at > created_at`
- `chk_shares_revoke_pair`: revoke time and revoking member are both empty or both set
- `chk_shares_revoke_after_create`
- `chk_share_events_actor`: `CREATE` and `REVOKE` require an actor; `ACCESS` requires an empty actor
- Foreign keys are `ON DELETE RESTRICT` and `ON UPDATE RESTRICT` for family, album, creator, revoker, share, and actor

## Indexes

- unique `token_hash`
- `idx_shares_family_album_id` on `(family_id, album_id, id)`
- `idx_shares_expires` on `(expires_at, id)`
- `idx_share_events_share` on `(family_id, share_id, id)`
- unique `(family_id, id)` so share events can reference the share inside the family

## Tests

- `packages/db/src/phase5c-migration.test.ts`: journal chain, additive SQL, constraints, and unchanged album/media columns
- `tests/integration/phase5c-sharing-migration.test.ts` on `family_album_dev`: migrate, drop the empty new tables, migrate `0005` again, then token uniqueness, foreign-key rejection, check constraints, and restrict deletes

The DEV account cannot `CREATE DATABASE`. The fresh case is a second apply of `0005` after the new tables are empty and removed. Album, placement, media, and derived row counts stay the same across that apply.

Targeted result: migration unit tests PASS, MySQL integration PASS, `@family-album/db` typecheck PASS, migration-readiness unit tests PASS.

## Schema Impact

```text
Schema: YES
```

## Migration

```text
Migration: YES
```

Applied to `family_album_dev`.

## Findings

P0: none.

P1: none.

P2: the DEV user cannot create a second database. Fresh coverage reapplies `0005` on `family_album_dev` instead of building an empty server.

P3: `audit_logs` is still not created here. `idx_shares_expires` is for a later sweep; a public read still finds the row by `token_hash`.

```text
SHARING_MIGRATION_IMPLEMENTATION_PASS: YES
```
