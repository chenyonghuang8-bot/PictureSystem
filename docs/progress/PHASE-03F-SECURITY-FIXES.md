# Phase 3F — Final Security Blocker Fixes

Scope: the three Phase 3 P1 findings only. No schema or migration change, no real `MEDIA_ROOT` cleanup, no original deletion, no Phase 4 work.

## P1-1: trusted FINALIZING final during startup

The original scanner now distinguishes a DB-unlinked canonical final backed by a same-family `FINALIZING` intent and verified original bytes from an unknown orphan. Only the former increments `knownRecoverableFinalizingCandidates`; it does not increment startup-blocking `orphanFinalCandidates`. The scanner never auto-completes a receipt. An unknown original, verification failure, or incomplete scan continues to fail closed.

The same startup assessment is used by the API entry point and by the synthetic integration test. The test SIGKILLs a child after durable publish but before DB completion, opens the marker-bound root, executes the real startup gate, authenticates a synthetic user, retries finalize through HTTP → route → service → repository → MySQL/native storage, and verifies `COMPLETE`, no original overwrite, and staging cleanup. A separate synthetic test places known and unknown finals together and confirms the unknown still blocks startup.

## P1-2: family quota accounting

The repository centralizes two separate SQL accounting expressions:

- `reservedFutureBytes`: uncommitted declared bytes for `CREATED`/`UPLOADING`.
- `retainedStagingBytes`: committed bytes for those active states; full declared size for `FINALIZING` and terminal/`COMPLETE` receipts until `staging_cleaned_at` confirms cleanup.

Family admission adds those expressions once per upload plus canonical `storage_objects.byte_size`; active uploads contribute their declared size exactly once. Global outstanding accounting includes retained staging. Filesystem free-space admission counts only future writes because written staging already reduces available space. Failed/aborted/expired/complete receipts do not release staging budget merely on a state transition. There is no new quota table or state-machine change.

Synthetic DEV MySQL/filesystem tests cover active no-double-count, `FINALIZING`, failed frozen staging, aborted retained staging, publish followed by ambiguous completion, `COMPLETE` dedupe loser cleanup failure, and release only after confirmed cleanup. An isolated synthetic family uses an arithmetic-only DB storage-object fixture near 256 GiB to verify admission rejects while terminal staging is retained and succeeds after cleanup; that fixture is never passed to media reads or recovery and is removed in the test `finally` block.

## P1-3: large controlled directories

Native storage now exposes bounded lexical directory pages (at most 256 entries requested; recovery requests 128). Each page holds only `limit + 1` names, reads through a fixed dirfd, reports a cursor and directory generation, obtains metadata with `AT_SYMLINK_NOFOLLOW`, and rejects unsafe names or a generation change before returning a result. The storage abstraction confines page paths and cursors to controlled namespaces. Recovery consumes all pages before reporting a complete startup scan; incomplete, unsafe, truncated, or changed scans still fail closed. The maintenance report replaces an internal original pathname/digest cursor with an opaque continuation token and preserves an already-opaque cursor unchanged on subsequent reports.

Synthetic tests create 1,250 known terminal upload directories, verify full multi-page startup scanning without omission or duplicate treatment, then add a late symlink entry and verify startup becomes unavailable. A native test separately checks page size, ordering, completeness, and generation rejection after a directory mutation. No fixed entry-cap increase or partial-scan success shortcut was used.

## Targeted validation

- Storage native/package build: PASS.
- DB package build: PASS.
- API and workspace TypeScript typecheck: PASS.
- Storage/recovery/upload service and upload HTTP unit tests: 50/50 PASS.
- Phase 3C/3D/3E synthetic DEV MySQL integration and race tests: 36/36 PASS, no skip.
- Scoped lint and scoped Prettier format check: PASS.
- Read-only DEV fixture check: `family_album_dev`; matching synthetic Phase 3C/3E/3F families and users remaining: 0.

Remaining work: Phase 3 blocker re-review and final quality gate are separate steps. Deferred P2/P3 are unchanged; this patch does not claim they are closed.
