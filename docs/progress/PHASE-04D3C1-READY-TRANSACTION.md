# Phase 4D3c-1 READY transaction

READY is not the presence of a final file. The worker inspects the canonical file first, then one database transaction rechecks the lease and writes `derived_assets`, `media_items`, and `background_jobs` together. API serving stays closed.

## Boundary

Filesystem inspection uses the existing final inspection under the capacity lock. It accepts one regular file, mode `0400`, one link, a nonzero device and inode, and a SHA-256 and byte size that match the `PUBLISHING` row.

The database transaction then locks family, storage object, media, job, and derived rows. It requires the current worker, epoch, unexpired lease, recipe `1`, matching generation, and storage `AVAILABLE`. Media `READY` also requires `metadata_generation` to already equal the current generation. A failed check rolls back. The worker does not call `jobs.complete` on its own.

`published_at` is the database time taken after those locks. `cleaned_at` stays null.

## State transition

| Evidence                                                       | Derived                                | Media                    | Job          |
| -------------------------------------------------------------- | -------------------------------------- | ------------------------ | ------------ |
| Thumbnail and preview both match                               | both `READY`                           | `READY`, failure cleared | `SUCCEEDED`  |
| Thumbnail matches, preview is retryable                        | thumbnail `READY`                      | `PENDING`                | `RETRY_WAIT` |
| Required kind permanently fails, metadata is already valid     | matching finals stay or become `READY` | `PARTIAL`                | `FAILED`     |
| Original or storage is unavailable                             | no new `READY` from a missing final    | `BLOCKED`                | `FAILED`     |
| Final missing, SHA mismatch, stale lease, or generation change | unchanged                              | unchanged                | unchanged    |

Attempts still follow Phase 4C. The third attempt of a retryable failure becomes `FAILED` and media `PARTIAL`. No new job or media state is introduced.

A later lease may adopt a `PUBLISHING` row whose file matches the stored SHA-256 and byte size. Adoption changes only `producer_lease_epoch` inside the READY transaction. It does not render or publish again. A lease that is already expired cannot adopt, mark `READY`, or mark the job `SUCCEEDED`.

## Commit unknown

If the READY commit outcome is unknown, the worker reads the job, media, and both derived rows once. A committed success is reported as `READY`. Anything else stays `COMMIT_UNKNOWN`. The worker does not run the READY transaction again.
