# Phase 3E — Storage Recovery / Reconciliation / Cleanup

Status: Phase 3E implementation and targeted verification **PASS**; ready for independent implementation review, not a full Phase 3 final gate. This document covers only the Phase 3 `upload_sessions` / `storage_objects` and controlled local storage namespaces; it does not authorize original GC or Phase 4 media work.

## Reconciliation model and authority

`StorageReconciler` runs under the same native root fd, marker/device check and lifetime OS writer lock as uploads. The API's startup pass runs before routes listen, and the explicit DEV maintenance CLI can run only when the API writer is stopped because it must obtain that same lock. At runtime the route protocol and reconciler share one `UploadMutex` per public upload ID; no DB row lock is held while waiting for it. The checked Phase 1B.1 transaction helper provides bounded deadlock retry, rollback-failure disposal, and no replay after an unknown COMMIT.

System recovery authority is narrow: inspect controlled state, conditionally expire CREATED/UPLOADING, mark confirmed short/missing staging FAILED with the whitelisted `STAGING_INTEGRITY_MISMATCH`, mark completed physical staging cleanup, and mark definitively missing/corrupt `storage_objects`. It never impersonates an uploader's session or converts `FINALIZING` to `COMPLETE`. Only the existing authenticated finalize retry may reverify a frozen intent and create its DB linkage.

Every run checks DEV `family_album_dev`, MySQL 9.7.2, non-root current user, Native FK/FK checks, durable commit setting, exact current migration history/schema, and root identity before any possible mutation. DB or root ambiguity fails closed. Tests use an internal family scope to keep the synthetic temp root from being treated as the root for other DEV families; the maintenance CLI does not expose this narrowing option.

## Modes and cleanup boundary

The CLI defaults to `dry-run`; it performs no DB state transition, truncation, publish or unlink. `--recover` explicitly enables known active-state recovery and expiry/terminal staging cleanup. `--cleanup-staging` explicitly enables proven terminal/orphan staging and scratch cleanup; neither mode has an original-delete operation. Runtime cleanup addresses only server-built `uploads/<family>/<public-id>/payload` or `temp/chunks/<public-id>/<request-id>` entries through native no-follow dirfds, regular-file/owner/mode/device/single-link checks and an inode recheck immediately before unlink. A known FINALIZING/COMPLETE prepared payload may be `0400`; an orphan stage without a receipt and every scratch remain `0600`-only. The empty controlled upload directory left after exact file cleanup is not misclassified as an orphan file. A missing file is a stable cleanup no-op; `staging_cleaned_at` is conditionally written after physical cleanup, and a later pass can resolve an unknown timestamp COMMIT by rereading the receipt.

CREATED/UPLOADING use `committed_offset` as the sole trusted durable prefix. A healthy short file or missing committed prefix is FAILED; a long staging tail is truncated and synced only after fresh DB revalidation under the upload mutex. CREATED offset zero may create an exclusive empty staging file. Expiry is determined using fresh DB server time after family/upload row locks, conditionally transitions only active states to EXPIRED, then exact stage cleanup occurs outside the transaction. FINALIZING is never expired or cleaned by this protocol.

An unlinked staging/scratch candidate is reported by default. Explicit orphan-stage cleanup requires an approved namespace, 24-hour mtime grace, a second no-follow directory scan with the same metadata, two healthy DB proofs of no receipt, and writer/upload coordination. Unknown file names, directories, symlinks, FIFO/devices, non-single-link files, wrong owner/mode/device, or path-layout anomalies are reported and never followed or deleted. A namespace scan failure is not interpreted as an empty directory; it aborts the run.

COMPLETE staging is cleaned only after the family-scoped storage row is AVAILABLE and the canonical original is fully reverified. A frozen FAILED finalize stage remains for diagnosis. No canonical original is unlinked, overwritten, renamed, or fabricated here.

## Final candidates and integrity

FINALIZING stage-only, final-only and dedupe-object candidates are read/rehashed against the frozen family/hash/size. Valid candidates are retained for an authenticated finalize retry; an incomplete/corrupt candidate is reported rather than silently repaired or linked by a system actor. Unknown orphan finals are detected within the canonical `originals/<family>/<hash-prefix>/<hash>-<size>` layout and preserved. Without a matching frozen FINALIZING intent they are not read for adoption, imported as visible media, used cross-family, or deleted.

A database AVAILABLE storage row whose canonical final is definitively absent on the verified volume is conditionally marked MISSING; a verified byte-size/digest mismatch is marked CORRUPT. Read/dedupe paths already reject non-AVAILABLE state. Permission, device, path, native verifier or DB uncertainty does not authorize either classification, nor does it trigger global empty-file replacement or DB hash rewrite. A scanner cannot claim the original is healthy merely because a DB row exists.

## Capabilities and root replacement

READ_WRITE is required for create/PATCH/finalize/abort, expiry physical cleanup and recovery mutations. A known valid root may be READ_ONLY under explicit maintenance policy or a closed capacity/write safety margin; it allows safe controlled inspection but refuses writes/cleanup and avoids hidden expiry state updates from HEAD/status. UNAVAILABLE means no valid root/marker/volume/lock or an incomplete startup recovery; there is no fallback directory and no automatic new MEDIA_ROOT creation. A root path, marker, writer-lock inode or volume replacement is rechecked at operation boundaries and latches the service unavailable. Existing requests recheck root identity before filesystem publication and before the final DB completion stage. Reappearance alone never resumes READ_WRITE without a controlled preflight/restart.

## Resource bounds, reporting and concurrent work

DB scans use keyset ID pages of at most 32 uploads or 16 storage rows, not a whole-table materialization. Native directory scans are capped at 1,000 entries per approved directory, with fixed layout depth and no symlink traversal. Each invocation permits at most 20,000 candidates; cursors allow subsequent explicit passes. Full-file hashing is serial, at most 16 files / 64 GiB per invocation. Bounds exhausted are reported as truncated, not silently treated as a completed startup recovery. The structured report contains counts, short reason codes and controlled logical cursors only; ordinary API logs contain only an event/short-field whitelist, not absolute paths, filenames, digests, tokens, credentials, request bodies, native errors or private bytes.

Scanner/PATCH, scanner/abort, scanner/authenticated finalize and two-scanner cases share the per-upload mutex and lock-after-snapshot revalidation. The CLI cannot coexist with an API writer because of the native OS lock. Neither an mtime nor an expired receipt lease can grant a second filesystem writer.

## Maintenance command

After the scoped API build, run from the API package with the repository root `.env` loaded explicitly at process start:

```text
pnpm --filter @family-album/api storage:reconcile:dev
pnpm --filter @family-album/api storage:reconcile:dev -- --recover
pnpm --filter @family-album/api storage:reconcile:dev -- --cleanup-staging
```

Use `--max-candidates=<1..20000>` and report-provided `--after-upload`, `--after-object`, `--after-staging`, `--after-scratch`, or `--after-original` cursors to resume a truncated global pass. No `--force`, root-marker bypass, trust-DB/filesystem override, or original-delete flag exists. A second writer, wrong DEV database, root account, journal drift or unavailable root rejects the command before cleanup.

## Verification and deferred production validation

Targeted evidence includes native no-follow scan/root-replacement and prepared-stage/scratch cleanup tests; dry-run, orphan-stage grace, symlink, READ_ONLY, empty-terminal-directory, residue and cursor unit tests; real DEV MySQL/fixed-dirfd expiry, prefix, prepared FINALIZING, missing/corrupt final, cleanup and mutex/lock-wait race tests. The scoped native/schema/API unit suite passed **78/78** across 11 files; the sequential real MySQL Phase 3C/3D/3E suite passed **33/33** across two files (**24** regressions, **9** Phase 3E tests). Storage, DB and API typecheck, scoped lint/format, native build and scoped API build passed. Synthetic families, users, uploads and storage objects remaining: **0**; synthetic upload/original/temp roots remaining: **0**. The complete Phase 3 quality gate and independent implementation/security review have not yet run.

Real power removal and real external SSD disappearance/replacement have not been tested. Phase 3D's synchronous native hash may affect API responsiveness for long files or actual browser disconnects. Persistent production audit storage and persistent production rate limiting remain deferred. This phase does not add media items, original lifecycle/Trash purge, backup, storage migration, EXIF, thumbnails, derived assets, album-media links or Phase 4 processing.
