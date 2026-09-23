# Phase 4D3c-2b — album_media migration

Status: migration implemented on `family_album_dev`. No API, permission route, worker, or READY transaction change.

This slice follows the approved association in `PHASE-04D3C2-MEDIA-VISIBILITY-DESIGN.md`.

```text
albums
  ↓
album_media
  ↓
media_items
  ↓
derived_assets
```

## Schema

`album_media` is an empty association table.

| Column | Definition |
| --- | --- |
| `id` | `BIGINT UNSIGNED` auto-increment primary key |
| `family_id` | `BIGINT UNSIGNED NOT NULL` |
| `album_id` | `BIGINT UNSIGNED NOT NULL` |
| `media_id` | `BIGINT UNSIGNED NOT NULL` |
| `created_at` | `DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` |

There is no `deleted_at`, ordering column, permission bit, caption, or member id. Album soft delete stays on `albums.deleted_at`. Removing a photo from an album is a later `DELETE` of one association row.

## Foreign keys

Both keys are `ON DELETE RESTRICT` and `ON UPDATE RESTRICT`. There is no `CASCADE` and no foreign key to `derived_assets` or `storage_objects`.

| Name | Columns | Target |
| --- | --- | --- |
| `fk_album_media_album` | `(family_id, album_id)` | `albums (family_id, id)` |
| `fk_album_media_media` | `(family_id, media_id)` | `media_items (family_id, id)` |

Family isolation is the shared `family_id` in both composite keys. A row cannot pair an album from one family with media from another. Deleting an album row or a media row fails while a placement exists, so an album delete cannot remove media, derived files, or originals.

## Indexes

| Name | Columns | Role |
| --- | --- | --- |
| `album_media_id` | `id` | Primary key |
| `uq_album_media_placement` | `(family_id, album_id, media_id)` unique | One placement, and album → media lookup |
| `idx_album_media_media` | `(family_id, media_id, album_id)` | Media → album lookup |

No extra `CHECK` was added. The composite foreign keys and the unique placement are the constraints from the approved design.

## Migration

File: `packages/db/drizzle/0004_phase_04_album_media.sql`.

Journal index 4, tag `0004_phase_04_album_media`, ordered after `0003_phase_04_media_processing`. Snapshot `0004_snapshot.json` records `prevId` equal to the `0003` snapshot id. `0000`–`0003` SQL and snapshots were not edited.

The file is additive DDL only:

1. `CREATE TABLE album_media`
2. `ALTER TABLE album_media` add `fk_album_media_album`
3. `ALTER TABLE album_media` add `fk_album_media_media`
4. `CREATE INDEX idx_album_media_media`

No `INSERT`, no backfill, and no rewrite of existing tables. Existing media stays unplaced. The table uses `ENGINE=InnoDB` and `utf8mb4_0900_ai_ci`, matching the earlier migrations and the readiness collation check.

`drizzle-kit migrate` applied this entry to `family_album_dev`. A second MySQL instance was not created. Fresh-database coverage is the next journal entry on the reviewed `0000`–`0003` history, plus the SQL containing only `CREATE` / `ALTER` of `album_media`.

Readiness now expects `album_media` as the last project table. The Phase 4 predecessor snapshot remains `PROJECT_TABLES` through `upload_sessions`, so the historical Phase 3 shape does not include this table.

Once this journal entry is present, an older build fails readiness. Deployment order is migrate, then run the build that understands the journal.

## Tests

Static (`packages/db/src/album-media-migration.test.ts`):

- journal tags `0000`–`0004`, with `0004` after `0003`
- snapshot chain `0004.prevId` = `0003.id`
- SQL statements are only the create, two foreign keys, and the reverse index
- `albums`, `album_members`, `media_items`, and `derived_assets` column names still match the `0003` snapshot

MySQL (`tests/integration/phase4d3c2-album-media.test.ts`), on `family_album_dev` after readiness:

- one same-family placement succeeds
- album → media and media → album both return that placement
- duplicate `(family_id, album_id, media_id)` is errno 1062
- cross-family album and cross-family media are errno 1452
- `DELETE` of the album and `DELETE` of the media are errno 1451 while the placement remains

Regression in the same run: Phase 2 migration, Phase 3 migration, Phase 4 migration journal, schema, and migration-readiness unit tests.

## Compatibility

Phase 2 ACL columns and grants are unchanged. `album_members` still matches the `0003` snapshot.

Phase 3 storage and originals are unchanged. `album_media` does not reference `storage_objects`.

Phase 4 `media_items` and `derived_assets` columns match the `0003` snapshot. Worker, READY transaction, and serving code were not part of this change.

`packages/db/scripts/preflight-phase-04.ts` still requires a four-entry journal. That script is the historical gate from before Phase 4 tables existed. Current readiness is `assertMigrationReadiness`, which now includes `0004`.

## Not in this slice

No serving endpoint, permission API, UI, mobile client, worker change, or READY change. `API_SERVING_READY` stays no.
