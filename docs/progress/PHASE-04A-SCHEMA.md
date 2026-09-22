# Phase 4A — Media Processing Schema

- Status: `PHASE_4_MIGRATION_READY`
- Migration: `packages/db/drizzle/0003_phase_04_media_processing.sql`
- Execution status: **not executed**

This slice implements only the approved database foundation for media
processing. It does not implement metadata probing, Sharp, ffprobe/FFmpeg,
worker claiming, derivative publication, media APIs, or album/media links.

## Tables and columns

### `media_items` (38 columns)

- Identity/source: `id`, `family_id`, `storage_object_id`,
  `source_upload_id`, `uploaded_at`.
- Processing version/state: `media_type`, `detected_mime`,
  `processing_state`, `generation`, `recipe_id`, `metadata_generation`,
  `last_failure_code`, `warning_flags`.
- Geometry/media facts: raw/display dimensions, bounded duration,
  orientation, video rotation, animation and motion hints.
- Capture/timeline: local and UTC capture times, explicit offset and source,
  certainty status, stable timeline key/basis.
- Bounded metadata: paired decimal GPS, camera make/model, and mapped
  codec/container/transfer values.
- Timestamps: `created_at`, `updated_at`.

`UNIQUE(family_id, storage_object_id)` makes the canonical media identity
one-to-one with a family-scoped canonical original. The source receipt FK also
binds family, upload receipt, and storage object. Repeated upload receipts can
therefore point to the same storage object without creating another media
item or overwriting canonical metadata.

### `background_jobs` (19 columns)

Stores only the approved `MEDIA_PROBE`, `IMAGE_DERIVATIVES`, and
`VIDEO_POSTER` jobs. The record includes generation/recipe fences, bounded
attempts, DB-time availability, lease timestamps, a random binary worker
identity, monotonic lease epoch, controlled failure code, and terminal time.

The claim index is `(state, available_at, id)` for later
`FOR UPDATE SKIP LOCKED` use. The lease index locates expired RUNNING jobs.
Lease and terminal CHECK constraints ensure a RUNNING job has a complete,
ordered lease tuple and terminal jobs have a completion time. No executable,
path, URL, stderr, or arbitrary payload is stored.

The identity unique key includes media, generation, recipe, and job type.
This deduplicates enqueue within one immutable processing generation while a
new generation permits controlled reprocessing and preserves bounded history.

### `derived_assets` (20 columns)

Stores rebuildable `THUMBNAIL`, `PREVIEW`, and `VIDEO_POSTER` records with
generation/recipe identity, state, quota reservation, verified payload
size/digest/dimensions/MIME, producing job and lease epoch, controlled failure
code, and publish/cleanup timestamps.

`UNIQUE(family_id, media_id, generation, recipe_id, kind)` prevents duplicate
canonical records for one derived recipe result. No client filename, absolute
path, original namespace path, or video-transcode kind is stored. Physical
keys are derived later from server-controlled identifiers.

## Integrity summary

- New-table indexes: 11; source-receipt unique key on `upload_sessions`: 1.
- Foreign keys: 5, all `RESTRICT/RESTRICT` and family-scoped.
- CHECK constraints: 31 (media 16, jobs 6, derived 9).
- All identifiers, generations, lease epochs, sizes, and duration use
  precision-safe unsigned BIGINT mappings where applicable.
- GPS uses paired DECIMAL coordinates with latitude/longitude bounds.
- All metadata strings are bounded; no raw EXIF/XMP/ffprobe blob is stored.
- Processing failure never changes `storage_objects` health. Derived assets
  are rebuildable; original media remains immutable and outside worker cleanup.
- `upload_sessions` receives only the reviewed composite unique key required
  by the source receipt FK; earlier tables and migrations are otherwise
  unchanged.

## Migration and readiness

The journal manifest now contains `0000`, `0001`, `0002`, and the unapplied
`0003_phase_04_media_processing`. Before execution, the Phase 4 preflight
requires the live DEV database to match the exact Phase 3 predecessor journal
and schema, use MySQL 9.7.2 with Native FK and session FK checks enabled, use a
non-root account, and have none of the three Phase 4 tables.

Adding 0003 intentionally makes full current-manifest bootstrap readiness fail
closed until the migration is reviewed and applied. No migration was executed
as part of Phase 4A preparation.

## Validation

- Phase 4 read-only preflight: PASS against `family_album_dev`, MySQL 9.7.2,
  non-root DEV account, Native FK enabled, `foreign_key_checks=1`, exact
  `0000/0001/0002` predecessor journal/schema, and zero Phase 4 tables.
- DB schema/migration/readiness regression: 12 files, 82 tests PASS.
- Drizzle snapshot/journal check: PASS.
- DB, contracts, and worker typechecks: PASS.
- Scoped lint and format: PASS.

The A–P migration constraint scenarios are represented by schema/SQL/snapshot
assertions at this review stage. Their live MySQL reject/round-trip probes must
run only after separate approval to execute 0003.

## Deferred implementation

Job claim/heartbeat/retry transactions, media registration, parser isolation,
derivative filesystem publication, quota/recovery, public APIs, and runtime
FK/CHECK probes remain for later approved Phase 4 slices. Migration execution
and live runtime constraint verification require a separate user instruction.
