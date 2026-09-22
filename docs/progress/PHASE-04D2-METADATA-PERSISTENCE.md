# Phase 4D2 — Metadata Persistence and Probe Completion

Status: implementation complete; pending independent review. No schema or
migration changed. This slice does not generate or publish thumbnails,
previews, posters, or video transcodes.

## Processing Boundary

`MetadataProcessingService` performs three explicit stages:

1. `MySqlMetadataRepository.prepare` runs a short checked transaction and
   validates the current `MEDIA_PROBE` lease plus the canonical family,
   storage, media, generation, recipe, SHA-256, size, key version, and
   `AVAILABLE` state.
2. `IsolatedProbeRunner.probeMetadata` reads the verified immutable original
   outside every database transaction.
3. `persistResult` or `persistOperationalFailure` opens a new short checked
   transaction, locks `family -> storage_object -> media_item ->
background_job`, reads DB server time after those locks, and authoritatively
   revalidates every fence before changing any row.

Only D1's capability-gated runner is used. There is no direct low-level parser
call, unsandboxed fallback, arbitrary path, or public metadata mutation API.

## Atomic Persistence and Fencing

The post-parse transaction requires the exact family/media/job/generation,
`MEDIA_PROBE` type, media/job recipe match, RUNNING state, 16-byte worker
identity, current `lease_epoch`, and unexpired `locked_until`. It also requires
the same family-scoped storage object, key version 1, and current `AVAILABLE`
state.

The transaction replaces the canonical bounded metadata snapshot and then
conditionally completes/fails the probe job. A zero/invalid fence returns zero
effects before the media update. Any unexpected conditional update rolls back
the whole transaction. Therefore a stale epoch or generation cannot leave
metadata committed while job completion fails.

`runCheckedTransaction` remains the sole transaction mechanism, retaining its
bounded deadlock retry, rollback-failure connection discard, and COMMIT outcome
unknown behavior. The worker service does not catch/replay commit ambiguity;
recovery must reread authoritative state.

## Snapshot and Field Semantics

One accepted result replaces all parser-owned canonical fields. Nulls clear an
older generation's GPS, camera, capture-time, dimensions, codec/container, and
other parser fields rather than merging with stale values. `source_upload_id`,
`uploaded_at`, storage identity/state, receipts, and originals are never
updated.

- Capture local calendar values are written as normalized MySQL calendar
  strings. UTC is written only for `OFFSET_KNOWN`; no server timezone is
  inferred.
- `timeline_key` is the valid captured local value, otherwise immutable
  `uploaded_at`; capture fallback is never written as fake captured time.
- GPS remains an all-or-none six-decimal pair.
- Raw/display dimensions and orientation remain distinct.
- Only bounded D1 strings and approved warning bits are stored. Warnings arrays,
  raw EXIF/XMP, stderr, errors, paths, hashes, and parser commands are not
  persisted or logged.

## Outcome Mapping

| Probe outcome       | Media state                                | Probe job                                   | Retry                                                |
| ------------------- | ------------------------------------------ | ------------------------------------------- | ---------------------------------------------------- |
| SUCCESS             | PENDING; current metadata snapshot         | SUCCEEDED                                   | no; atomically enqueue approved image/video next job |
| PARTIAL             | PARTIAL; safe snapshot                     | SUCCEEDED                                   | no                                                   |
| UNSUPPORTED         | PARTIAL when bounded base identity exists  | FAILED / `UNSUPPORTED_FORMAT`               | no                                                   |
| INVALID_MEDIA       | FAILED; parser-owned fields cleared        | FAILED / `MALFORMED_MEDIA`                  | no                                                   |
| RESOURCE_LIMIT      | PARTIAL with bounded base result           | FAILED / `RESOURCE_LIMIT`                   | no                                                   |
| TIMEOUT             | PENDING, or FAILED when attempts exhausted | RETRY_WAIT / `PROCESS_TIMEOUT`, then FAILED | existing 30–45s / 120–150s policy                    |
| PARSER_FAILED       | PENDING, or FAILED when attempts exhausted | RETRY_WAIT / `TEMPORARY_IO`, then FAILED    | existing bounded policy                              |
| CAPABILITY_DISABLED | FAILED; parser-owned fields cleared        | FAILED / `CAPABILITY_UNAVAILABLE`           | no automatic loop                                    |

SUCCESS does not mark the whole media READY. As required by the Guardrails,
the same transaction idempotently creates the current generation/recipe
`IMAGE_DERIVATIVES` or `VIDEO_POSTER` job using the existing logical unique
identity. No derivative handler or file action is implemented here.

## Failure and Recovery

- A parser may start from a valid snapshot and still lose its lease, generation,
  or storage health. All three races produce zero metadata/job effects.
- Replaying an already terminal probe produces zero effects and cannot create a
  second downstream job.
- Unsupported/malformed/resource-limit/capability outcomes never mark the
  storage object MISSING or CORRUPT.
- Transient timeout/parser failures reuse the Phase 4C attempts/backoff model;
  no second scheduler exists.
- Worker authority is confined to the job's family-scoped media and storage
  identity. It does not synthesize a user session or album permission.

## Verification Evidence

Real `family_album_dev` tests cover successful atomic persistence, exact
capture-time/offset and GPS round trips, orientation/display dimensions,
first-source provenance preservation, snapshot null clearing across a new
generation, terminal and retry mappings, cross-family rejection, stale epoch
after reclaim, old generation, storage MISSING, replay, and zero synthetic
residue. Service tests prove parse ordering and that COMMIT outcome unknown is
propagated after one persistence attempt without replay.

D0/D1 isolation/parser regressions and Phase 4A/4B/4C repository/schema/
readiness regressions remain green. Phase 3 immutable storage is touched only
through `OriginalReader`; no receipt, original bytes, SHA-256, storage path, or
storage lifecycle mutation is introduced.

## Deferred

Existing D0/D1 P2 items remain deferred: extended inherited-FD probing,
post-wait PGID-reuse hardening, privileged wrong-UID/cross-device fixtures,
internal adapter FD/root-path defense in depth, independent `posix_spawn`
denial, low-level probe export reduction, and parser resource/test hardening.
Image derivative execution/publishing, video probing/posters, reprocess APIs,
and public media APIs remain outside Phase 4D2.
