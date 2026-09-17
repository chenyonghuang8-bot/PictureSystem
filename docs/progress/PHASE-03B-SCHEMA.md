# Phase 3B — Storage / Upload Schema

状态：`PHASE_3_MIGRATION_COMPLETE`  
Migration：`packages/db/drizzle/0002_phase_03_storage_uploads.sql`  
执行状态：**已在明确授权后执行于 `family_album_dev`，并通过 live verification。**

## Scope

本 migration 只新增：

- `storage_objects`
- `upload_sessions`

没有修改 Phase 1/2 表，也没有创建 `media_items`、album/media 关系、metadata、thumbnail、derived asset、processing job、comment、tag 或 AI 表。

## `storage_objects`

| Column        | Definition                                 | Meaning                                   |
| ------------- | ------------------------------------------ | ----------------------------------------- |
| `id`          | `BIGINT UNSIGNED` PK auto increment        | Internal precision-safe ID                |
| `family_id`   | `BIGINT UNSIGNED NOT NULL`                 | Physical object family scope              |
| `sha256`      | `BINARY(32) NOT NULL`                      | Server-computed full content digest       |
| `byte_size`   | `BIGINT UNSIGNED NOT NULL`                 | Verified positive byte size               |
| `key_version` | `SMALLINT UNSIGNED NOT NULL DEFAULT 1`     | Canonical path derivation version         |
| `state`       | `ENUM(AVAILABLE,MISSING,CORRUPT) NOT NULL` | Storage health state; no implicit default |
| `durable_at`  | `DATETIME(3) NOT NULL`                     | First verified durable publication time   |
| `verified_at` | `DATETIME(3) NOT NULL`                     | Latest complete verification time         |
| `created_at`  | `DATETIME(3) NOT NULL`                     | DB row creation time                      |
| `updated_at`  | `DATETIME(3) NOT NULL`                     | Application-managed update time           |

`AVAILABLE` means durable original bytes are present; it does not claim that media decoding is safe or complete.

### Storage indexes and integrity

- `uq_storage_objects_family_id(family_id,id)` supports same-family composite references.
- `uq_storage_objects_family_hash_size(family_id,sha256,byte_size)` is the exact same-family dedupe key. The family prefix deliberately permits identical bytes to have independent objects in different families.
- `idx_storage_objects_state_verified(state,verified_at,id)` supports health verification/reconciliation scans.
- FK `family_id → families.id`, `ON DELETE/UPDATE RESTRICT`.
- Checks: positive size, `key_version = 1`, and `verified_at >= durable_at`.

No absolute path or arbitrary `storage_key` is stored. The relative identity is a pure server-side function of `key_version`, `family_id`, `sha256`, and `byte_size`, matching the Phase 3A safe path builder. After durable publication, these physical identity fields are logically immutable; no generic update contract or repository API is introduced in Phase 3B.

## `upload_sessions`

| Column                 | Definition                           | Meaning                                                                               |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| `id`                   | `BIGINT UNSIGNED` PK auto increment  | Internal ID                                                                           |
| `public_id`            | `BINARY(16) NOT NULL UNIQUE`         | Server-generated 128-bit upload/staging identity; encoded as 32 lowercase hex in URLs |
| `family_id`            | `BIGINT UNSIGNED NOT NULL`           | Receipt family scope                                                                  |
| `created_by_member_id` | `BIGINT UNSIGNED NOT NULL`           | Original uploader membership                                                          |
| `original_filename`    | `VARCHAR(255) NOT NULL`              | Untrusted bounded display metadata only                                               |
| `reported_mime`        | `VARCHAR(127) NULL`                  | Untrusted bounded hint only                                                           |
| `declared_size`        | `BIGINT UNSIGNED NOT NULL`           | Server-validated declared upload length                                               |
| `committed_offset`     | `BIGINT UNSIGNED NOT NULL DEFAULT 0` | Only trusted durable contiguous offset                                                |
| `state`                | reviewed seven-state enum            | Upload state machine                                                                  |
| `computed_sha256`      | `BINARY(32) NULL`                    | Server hash, frozen with finalize intent                                              |
| `finalize_started_at`  | `DATETIME(3) NULL`                   | Finalize intent time                                                                  |
| `storage_object_id`    | `BIGINT UNSIGNED NULL`               | Same-family object, populated only for COMPLETE                                       |
| `completed_at`         | `DATETIME(3) NULL`                   | Durable completion time                                                               |
| `terminal_at`          | `DATETIME(3) NULL`                   | FAILED/ABORTED/EXPIRED terminal time                                                  |
| `failure_code`         | `VARCHAR(48) NULL`                   | Server-controlled sanitized short code; never a raw error                             |
| `expires_at`           | `DATETIME(3) NOT NULL`               | Normal upload expiry                                                                  |
| `staging_cleaned_at`   | `DATETIME(3) NULL`                   | Physical staging cleanup confirmation                                                 |
| `created_at`           | `DATETIME(3) NOT NULL`               | Receipt creation time                                                                 |
| `updated_at`           | `DATETIME(3) NOT NULL`               | Application-managed update time                                                       |

States are `CREATED`, `UPLOADING`, `FINALIZING`, `COMPLETE`, `FAILED`, `ABORTED`, and `EXPIRED`.

`public_id` is also the server-generated staging key used by Phase 3A (`uploads/<family-id>/<public-id-lowerhex>/payload`). There is deliberately no separate client-supplied `staging_key`, filename path, client hash, or absolute path column.

### Receipt, recovery and offset semantics

- Every upload session remains an independent receipt. Same-family dedupe may point multiple COMPLETE receipts to one storage object without merging uploader or filename metadata.
- `committed_offset` is DB-authoritative and supports a conditional `WHERE id/state/offset` update with affected-row verification.
- `(state,expires_at,id)` finds stale/expired active uploads.
- `(state,staging_cleaned_at,id)` finds terminal receipts requiring cleanup confirmation.
- FINALIZING retains frozen hash/start intent across crashes. COMPLETE requires same-family storage FK plus completion time. Terminal states retain sanitized reason/timestamp data.
- Phase 3B adds no cleanup/recovery worker and no delete cascade.

## Upload indexes, foreign keys and checks

Indexes:

- `uq_upload_sessions_public_id(public_id)`
- `idx_upload_sessions_family_creator_state(family_id,created_by_member_id,state,id)`
- `idx_upload_sessions_state_expiry(state,expires_at,id)`
- `idx_upload_sessions_family_object(family_id,storage_object_id)`
- `idx_upload_sessions_cleanup(state,staging_cleaned_at,id)`

Foreign keys, all `RESTRICT/RESTRICT`:

- `family_id → families.id`
- `(family_id,created_by_member_id) → family_members(family_id,id)`
- `(family_id,storage_object_id) → storage_objects(family_id,id)`

The composite creator/object FKs enforce family boundaries in the database. No FK cascades delete upload receipts or originals.

The ten named upload checks enforce positive declared size, offset bounds, expiry order, CREATED/UPLOADING offset prerequisites, finalize hash/time pairing, finalize-state prerequisites, COMPLETE object/time pairing, terminal-state timestamps, FAILED reason pairing, and timestamp ordering/cleanup-state eligibility. State transition authorization and cross-table hash/size verification remain transaction-layer responsibilities as approved by the Guardrails.

## Migration inventory

- Tables: 2
- Columns: 29 total (`storage_objects` 10, `upload_sessions` 19)
- Secondary/unique indexes declared by schema: 8 (`storage_objects` 3, `upload_sessions` 5), in addition to both primary keys
- Foreign keys: 4 total
- Checks: 13 total (`storage_objects` 3, `upload_sessions` 10)
- Engine/collation: explicit `InnoDB`, `utf8mb4`, `utf8mb4_0900_ai_ci`
- Drizzle journal entry: index 2, `0002_phase_03_storage_uploads`

## Preflight evidence

The read-only Phase 3 preflight passed against:

- Database: `family_album_dev`
- MySQL: `9.7.2`
- Application DB user: non-root
- Native FK: enabled
- Session `foreign_key_checks`: enabled
- Exact Phase 1/2 journal: PASS
- Exact current Phase 2 schema baseline: PASS using the shared migration-readiness implementation
- Existing `storage_objects` / `upload_sessions`: none

Preflight 完成后只执行了已审查的 `0002_phase_03_storage_uploads`；没有导入 `database/schema.sql`、修改旧表或创建其他业务表。

## Validation evidence

- Phase 3 schema/migration + migration-readiness + bootstrap regressions: PASS
- Drizzle snapshot check: PASS
- Post-migration exact journal/schema readiness: PASS (`0000/0001/0002`)
- Runtime same-family dedupe、cross-family isolation、creator/object composite FK、offset/state CHECK、public ID uniqueness、BIGINT 和 receipt probes: PASS
- mysql2 string 与 Drizzle bigint 均精确保留 `9007199254740993`
- Runtime probe transaction rollback 后 synthetic rows remaining: 0
- DB/storage/contracts typecheck: recorded in the final task result
- Scoped lint/format: recorded in the final task result

`failure_code` 的数据库短码 whitelist CHECK 仍是已知 deferred P2。本阶段 migration 不作修改；Phase 3 application layer 必须使用受控 enum/白名单且禁止保存 raw error。
