# Phase 5C Sharing Migration Design

Status: DESIGN ONLY. This document does not add a migration file and does not change the Drizzle schema.

Baseline:

- `docs/progress/PHASE-05C-SHARING-SCHEMA-API-DESIGN.md`
- `project-spec/database/DATABASE_SCHEMA.md`
- Journal `packages/db/drizzle/meta/_journal.json` entries `0000` through `0004`
- Latest snapshot `0004` id `29b5833a-bb05-466f-b3d3-288112405627`

`PHASE_4_PRODUCTION_READY: NO`.

## 1. Migration Strategy

The future file is:

```text
packages/db/drizzle/0005_phase_05c_sharing.sql
```

Journal entry:

- `idx`: 5
- `tag`: `0005_phase_05c_sharing`
- `version`: `5`
- `breakpoints`: true

The `0005` snapshot `prevId` must be `29b5833a-bb05-466f-b3d3-288112405627`. Files `0000` through `0004`, including their SQL and snapshot ids, stay unchanged.

The migration only creates `shares` and `share_events`, their checks, foreign keys, and indexes. It does not `ALTER` an existing table. It does not backfill. Both tables start empty.

Engine and collation match the current tables: `InnoDB`, `utf8mb4`, `utf8mb4_0900_ai_ci`.

## 2. shares

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | `bigint unsigned` | no | auto-increment |
| `family_id` | `bigint unsigned` | no | none |
| `album_id` | `bigint unsigned` | no | none |
| `token_hash` | `binary(32)` | no | none |
| `created_by_member_id` | `bigint unsigned` | no | none |
| `created_at` | `datetime(3)` | no | `CURRENT_TIMESTAMP(3)` |
| `expires_at` | `datetime(3)` | no | none |
| `revoked_at` | `datetime(3)` | yes | null |
| `revoked_by_member_id` | `bigint unsigned` | yes | null |

Primary key: `id`.

Checks, matching the invitation revoke pair:

- `chk_shares_expiry`: `expires_at > created_at`
- `chk_shares_revoke_pair`: `revoked_at` and `revoked_by_member_id` are both null or both set
- `chk_shares_revoke_after_create`: `revoked_at` is null or `revoked_at >= created_at`

There is no permissions column and no `media_id`.

Also add `UNIQUE (family_id, id)` so child rows can use the same composite family key as `albums` and `family_members`.

## 3. Foreign Keys

All foreign keys are `ON DELETE RESTRICT` and `ON UPDATE RESTRICT`.

| Constraint | Columns | References |
| --- | --- | --- |
| `fk_shares_family` | `family_id` | `families(id)` |
| `fk_shares_album` | `family_id`, `album_id` | `albums(family_id, id)` |
| `fk_shares_creator` | `family_id`, `created_by_member_id` | `family_members(family_id, id)` |
| `fk_shares_revoker` | `family_id`, `revoked_by_member_id` | `family_members(family_id, id)` |

`RESTRICT` keeps a family, album, or member row from disappearing while a share still names it. Album removal in this product is `deleted_at`, not a hard delete, so the share row and its history stay. `CASCADE` would erase share history when a parent row is removed. `ON UPDATE RESTRICT` matches `album_media` and `albums`.

`albums(family_id, id)` already exists as `uq_albums_family_id`. `family_members(family_id, id)` already exists as `uq_family_members_family_id`.

## 4. Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `uq_shares_family_id` | `family_id`, `id` | yes |
| `uq_shares_token_hash` | `token_hash` | yes |
| `idx_shares_family_album_id` | `family_id`, `album_id`, `id` | no |
| `idx_shares_expires` | `expires_at`, `id` | no |

`uq_shares_token_hash` is required. The public lookup is by hash, and two shares must not share a hash.

Token lookup uses that unique index. It does not need a second non-unique index on `token_hash`.

Expiration checks on one row do not need an index. `idx_shares_expires` is for a later sweep of due rows. The public request still decides expiry by comparing `expires_at` with server time after the hash lookup.

Management listing is `family_id`, then album, then share id. `idx_shares_family_album_id` starts with `family_id`, so a separate index on `family_id` alone is not added.

## 5. share_events

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | `bigint unsigned` | no | auto-increment |
| `family_id` | `bigint unsigned` | no | none |
| `share_id` | `bigint unsigned` | no | none |
| `event_type` | `enum('CREATE','ACCESS','REVOKE')` | no | none |
| `actor_member_id` | `bigint unsigned` | yes | null |
| `created_at` | `datetime(3)` | no | `CURRENT_TIMESTAMP(3)` |

`event_type` is the audit action from the schema API design.

No `metadata` column. A JSON blob can take a token, a path, an IP address, or a user agent without a further review.

Actor:

- `CREATE` and `REVOKE` require `actor_member_id`
- `ACCESS` requires `actor_member_id` null

Check: `chk_share_events_actor`.

IP address and user agent are not columns. They are personal data and are not needed to record who created or revoked a share. Anonymous viewing has no member id.

Foreign keys, also `RESTRICT` / `RESTRICT`:

- `fk_share_events_share`: `(family_id, share_id)` to `shares(family_id, id)`
- `fk_share_events_actor`: `(family_id, actor_member_id)` to `family_members(family_id, id)`

Index: `idx_share_events_share` on `(family_id, share_id, id)`.

Rows are append-only at the application layer. This migration does not add a delete path.

## 6. Audit Boundary

`project-spec/database/DATABASE_SCHEMA.md` names `audit_logs` as the future log for important operations. That table is not in migrations `0000`–`0004`.

`share_events` is the V1 record for share create, access, and revoke. It does not claim to be the general audit log. A later `audit_logs` table can refer to a share id. It should not replace or drop `share_events` in this migration. The two stay separate until a reviewed audit design says otherwise.

## 7. Migration Safety

`0005` does not read or write:

- `albums`
- `album_members`
- `album_media`
- `media_items`
- `storage_objects`
- `derived_assets`

Existing rows stay where they are. New foreign keys point at `families`, `albums`, and `family_members` and do not change those tables' columns. Failed inserts fail the new statement. They do not rewrite album or media rows.

No data backfill runs. Deploying the migration does not create share links.

## 8. Schema Impact

```text
Schema change: YES
```

Drizzle schema and `0005` are added together at implementation time. This review does not add them.

## Migration Required

```text
Migration: YES
```

Not created in this review.

## Findings

P0: none.

P1: none. `0000`–`0004` stay intact, and the new chain starts at snapshot `29b5833a-bb05-466f-b3d3-288112405627`.

P2: `idx_shares_expires` supports a future sweep. V1 public reads still expire by the row found through `token_hash`.

P3: a general `audit_logs` table remains a later design. It is not part of `0005`.

```text
SHARING_MIGRATION_DESIGN_PASS: YES
READY_FOR_MIGRATION_IMPLEMENTATION: NO
```

Writing `0005` waits for review of this migration design.
