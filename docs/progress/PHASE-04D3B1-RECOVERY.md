# Phase 4D3b-1b derived publish recovery

Recovery reconciles the derived filesystem with `derived_assets` and the producer job lease. It does not mark an asset READY, finish a job, serve bytes, or start the worker.

An uncertain read, an incomplete scan, or an unknown commit keeps the reservation. Success is never inferred from a pathname.

## Evidence

A decision uses two authoritative sources:

- the paged derived inventory, re-read under the capacity lock for device, inode, size, mode, link count, and SHA-256
- the `derived_assets` row and the `background_jobs` lease

The final namespace remains:

```text
derived/<family>/<media>/r<recipe>/g<generation>/<kind>.webp
derived/.tmp/<job>/e<epoch>/<kind>.part
```

Startup recovery reuses the existing temp inventory pages and a bounded final page of at most 32 files. It stops after eight pages. A directory generation change, or a described inode that no longer matches the page, fails closed. An unknown name makes the scan incomplete and blocks cleanup.

## Scenarios

| Case | Filesystem | Database | Decision |
| --- | --- | --- | --- |
| Temp only, live lease | open temp, no final | `RESERVED` | `TEMP_ONLY_RETAIN`. No delete and no READY. |
| Temp only, dead lease | regular `0600` temp, no final | `RESERVED`, no payload | Exact cleanup, then `cleaned_at`. State stays `RESERVED`. |
| Sealed residue | `0400` temp, no final | not yet publishing | `SEALED_CANDIDATE`. Kept, not served, not deleted. |
| Publish before DB | regular final | `RESERVED` or `PUBLISHING` | `PUBLISH_BEFORE_DB`. Final is not deleted and is not READY. |
| Commit unknown | — | readback required | No second write. `ACCOUNTING_RETAINED` if `cleaned_at` is still null. |
| Conflict | temp SHA differs from final, or DB SHA differs from final | any | `FINAL_CONFLICT`. Neither name is replaced. |
| Unbound or unknown | no matching row, symlink, or foreign file | — | `UNBOUND_FINAL`, `SYMLINK`, or `UNKNOWN_RESIDUE`. No delete. |

## Identity

Every cleanup checks family, media, generation, recipe `1`, kind, job, epoch, device, inode, size, SHA-256, mode `0600`, one link, and owner. A sealed `0400` temp is not an exact-cleanup target. A symlink is reported and left in place.

## Cleanup

The only delete is `unlinkat` of one protocol temp name after the inode still matches. Empty temp parents are removed only when their inodes still match. There is no glob and no recursive delete. A final name at that identity blocks the unlink.

`READ_ONLY` and `UNAVAILABLE` only report. They do not delete, rename, or set `cleaned_at`.

## Accounting

Order is filesystem unlink, directory sync, then one capacity transaction that sets `cleaned_at` on the still-`RESERVED` row. `reserved_bytes` stays unchanged. No job or media row is updated.

If that transaction rolls back, or its commit is unknown and a later read still shows `cleaned_at` null, the reservation stays charged. A missing file on a later scan is not treated as proof that this process cleaned it, so it does not release the row by itself.

## Crash boundary

- Before rename: the temp remains and the row stays `RESERVED` until a dead lease and an exact cleanup both succeed.
- After rename, before any database completion: the final may be durable while the row is still `RESERVED`. Recovery records `PUBLISH_BEFORE_DB` and does not delete it.
- Before READY: this slice never starts the READY transaction.
- Commit unknown: authoritative readback only. No blind retry.

## Deferred

Worker integration, job completion, serving, and READY remain unimplemented. Adopting a verified final into `PUBLISHING` still belongs to the later fenced transaction. Uid-mismatch and cross-device fixtures remain unconstructable without extra privileges.

Schema: no. Migration: no.
