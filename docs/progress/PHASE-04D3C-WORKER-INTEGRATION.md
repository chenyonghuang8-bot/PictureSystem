# Phase 4D3c-0 worker integration

The image worker orchestrates one claimed `IMAGE_DERIVATIVES` lease. It calls the existing admission, renderer, temp, seal, verifier, and publish capabilities. It does not implement a second job system, renderer, verifier, or filesystem primitive.

This slice stops at `derived_assets.state = PUBLISHING`. It does not set `READY`, `published_at`, job `SUCCEEDED`, or media `processing_state`. Serving stays closed.

## Worker flow

1. `MySqlJobRepository.claimNext(workerId, { jobType: "IMAGE_DERIVATIVES" })` claims with `FOR UPDATE SKIP LOCKED`, increments `lease_epoch`, and sets the existing 90-second lease.
2. The same repository `heartbeat` runs before either kind. `affectedRows !== 1` returns `STALE` and performs no filesystem work.
3. For `THUMBNAIL`, then `PREVIEW`, the worker re-reads the fence: worker id, lease epoch, unexpired `locked_until`, job `RUNNING`, media generation, job generation, and recipe `1`.
4. A `RESERVED` row from an older epoch of the same job may be adopted by the current lease before admission. A `PUBLISHING` row is confirmed and is not rendered or published again.
5. Admission mints the existing permit. The injected renderer produces an unverified candidate. The worker then calls the existing temp, seal, and verify path.
6. `markPublishing` writes `PUBLISHING` plus byte size, SHA-256, width, height, and `image/webp` under the current lease. Publish runs only after that commit and a second describe that still matches the source object.
7. `confirmPublishing` re-checks the lease, generation, reservation, state, and SHA-256. It does not change state.
8. Both kinds must return the internal published token. The job remains `RUNNING`.

## Lease fence

Every database step locks family, storage object, media, job, and the derived row in that order. The lease holds only when the worker id and epoch match, the job is `RUNNING`, and `locked_until` is still in the future.

A stale or expired worker gets zero committed effects:

- it does not publish a final
- it does not set `READY`
- it does not mark the job `SUCCEEDED`

If the lease dies after admission and before `markPublishing`, the row stays `RESERVED`. Recovery uses the existing `recoverExpiredLease`. The next worker can adopt that reservation and continue. If the row is already `PUBLISHING` for the old epoch, the next worker confirms only and does not render or publish a second file.

## Generation fence

`describe`, adopt, `markPublishing`, and confirm all require `media.generation = job.generation = fence.generation`. A generation change after claim makes the fence null. The worker returns `STALE` without rendering, without inserting a derived row, and without changing the job.

## Thumbnail and preview

Both kinds are required. The loop returns on the first step that is not published, so a preview failure cannot look like success.

| Result | Thumbnail | Preview | Job |
| --- | --- | --- | --- |
| Both verified and published | `PUBLISHING` | `PUBLISHING` | stays `RUNNING` |
| Thumbnail permanent failure | `RESERVED` or unchanged | not started | `FAILED` |
| Preview retryable failure | `PUBLISHING` | not `READY` | `RETRY_WAIT` |

No path in this slice writes `READY` or job `SUCCEEDED`.

## Failure mapping

Renderer and storage errors are classified and then passed to the existing job repository. They are not swallowed.

| Class | Codes | Job effect |
| --- | --- | --- |
| Permanent | `UNSUPPORTED_FORMAT`, `CAPABILITY_UNAVAILABLE`, `MALFORMED_MEDIA`, `INPUT_LIMIT`, `OUTPUT_LIMIT`, `ORIGINAL_MISSING`, `ORIGINAL_CORRUPT`, `DERIVED_INTEGRITY`, `STORAGE_UNAVAILABLE` | `jobs.fail` → `FAILED` |
| Retryable | `PROCESS_TIMEOUT`, `RESOURCE_LIMIT`, `TEMPORARY_IO`, `DB_UNAVAILABLE` | `jobs.retry` → `RETRY_WAIT`, existing 30–45s / 120–150s delay, max 3 attempts |
| Stop | `COMMIT_OUTCOME_UNKNOWN`, `WORKER_LOST` | no job write |

`fail` and `retry` also require the current worker, epoch, and unexpired lease. A lost lease returns `STALE` instead of failing the other worker's job.

## Duplicate prevention

Publish runs only after a committed `PUBLISHING` row for the current epoch. `COMMIT_OUTCOME_UNKNOWN` returns before publish and does not insert another derived row. Admission unknown also stops before temp or render.

A second lease that finds `PUBLISHING` confirms the existing SHA-256. An epoch mismatch is `STALE`. It does not call the renderer and does not publish again. The unique derived identity remains one row per family, media, generation, recipe, and kind.

If publish succeeds and the following confirm is stale or unknown, the final file is left in place. The worker does not unlink it and does not retry publish.

## Deferred serving

`READY`, `published_at`, job `SUCCEEDED`, media `READY` / `PARTIAL` / `BLOCKED`, and API serving are a later fenced transition. Until that transition, a published file is evidence for recovery, not a served asset.
