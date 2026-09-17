# Phase 3C — tus Upload Session & Resumable Chunk Write

Status: COMPLETE

Scope is limited to authenticated upload-session creation, resumable staging writes, status, abort, expiry, and their safety boundaries. Final hash, dedupe, `storage_objects`, original publication, reconciliation, and media records remain Phase 3D+ work.

## Protocol surface

- Pinned protocol implementation: `@tus/server` 2.4.5.
- `POST /api/v1/families/:familyId/uploads/tus` creates an upload receipt.
- `HEAD /api/v1/uploads/tus/:uploadId` returns the trusted DB offset and declared length.
- `PATCH /api/v1/uploads/tus/:uploadId` uses a thin tus-compatible Fastify adapter around the same upload service so a 409 can include the project-required current trusted `Upload-Offset`; it accepts a maximum 16 MiB chunk at that exact offset.
- `GET /api/v1/uploads/:uploadId` returns the minimal upload status contract.
- `POST /api/v1/uploads/:uploadId/abort` aborts and cleans an unfinished staging payload.
- Supported tus extensions are creation and expiration only. Concatenation, deferred length, checksum, and tus termination are disabled.
- `Upload-Length` and offsets use canonical decimal parsing and `bigint` internally. Any library boundary using `number` is guarded by a safe-integer check; the Phase 3 maximum is 32 GiB.

## Ownership and request security

- Every create, HEAD, PATCH, status, and abort revalidates the current user, WEB session token hash, absolute/idle session expiry, active family membership, and upload ownership under database locks.
- Only `created_by_member_id` may access an active upload. ADMIN and SUPER_ADMIN receive no bypass. Missing, same-family non-owner, and cross-family resources use the same non-disclosing `NOT_FOUND` result.
- Mutating protocol requests require an exact trusted HTTPS Origin. Credentialed CORS is allowlist-only; forwarded headers are not trusted by the tus server, and Fastify proxy trust remains explicitly configured.
- Public upload IDs are 16 random bytes encoded as 32 lowercase hexadecimal characters. Client metadata never selects IDs, ownership, state, offsets, or paths.
- `Upload-Metadata` accepts only one canonical Base64 `filename` and optional `filetype`, with strict UTF-8 and total-size limits. Filename and MIME are untrusted display metadata and are redacted from logs.

## Trusted offset and write ordering

`upload_sessions.committed_offset` is the sole trusted offset. File stat and client headers never overwrite it.

PATCH uses one per-upload mutex and three database validation points:

1. T1 locks and revalidates family → user → session → member → upload, state, ownership, expiry, and expected offset.
2. The bounded request body is read into an exclusive, server-generated scratch file. Global body-stream concurrency is two.
3. T2 repeats the locked validation and checks that staging size equals the DB offset.
4. The native storage primitive copies the exact scratch length with positioned writes at that offset, refuses holes/overrun, handles interrupted/short writes, and `fsync`s the payload.
5. T3 repeats locked validation and conditionally advances the DB offset only by the durable byte count.

This guarantees the DB never leads the durable staging prefix. If the file advances but T3 has a known failure, it is durably truncated back to the latest DB offset. If COMMIT outcome is unknown, the upload is frozen in-process and is neither replayed nor truncated; Phase 3D reconciliation must resolve it. A payload shorter than a committed DB offset is marked `FAILED` with `STAGING_INTEGRITY_MISMATCH`.

Old-offset retry returns conflict; the client performs HEAD and resumes from the reported trusted offset. A full-size upload remains `UPLOADING`; Phase 3C does not finalize it.

## Admission and resource bounds

- File limit: 32 GiB; chunk limit: 16 MiB.
- Active uploads: 4 per member and 16 per family.
- Global outstanding declared bytes: 128 GiB.
- Family logical storage reservation: 256 GiB.
- Disk admission requires the larger of 10 GiB or 10% free reserve, plus a 64 MiB scratch reserve and all outstanding commitments.
- Create admission is serialized for the current single-process writer model.
- Upload and rate-limit wait queues/maps are bounded and fail closed.

## State, abort, and expiry

- Creation starts as `CREATED`; the first committed non-empty chunk changes it to `UPLOADING`.
- Reaching declared size stays `UPLOADING`, with no hash, object, original, or media record created.
- Abort conditionally changes CREATED/UPLOADING to `ABORTED`, records terminal time, removes only the exact controlled staging payload, then records `staging_cleaned_at`. Authorized repeated abort is idempotent.
- The fixed upload lifetime is seven days. Access after expiry atomically changes an active receipt to `EXPIRED`; HEAD/PATCH reject it and exact staging cleanup is attempted. Status may report the authenticated terminal record. No request performs a bulk scan.
- Failure codes are restricted in the repository to `STAGING_CREATE_FAILED`, `STAGING_INTEGRITY_MISMATCH`, or `STORAGE_WRITE_FAILED`. Arbitrary error messages, errno text, SQL errors, paths, hashes, and stacks cannot be persisted through the application API.

## Validation evidence

- Real native storage tests cover exclusive staging creation, exact positioned append, offset mismatch refusal, truncate, exact cleanup, symlink/path protections, and concurrent exclusive primitives.
- Protocol/unit tests cover creation, HEAD, PATCH, old-offset conflict, HEAD/resume, full-size boundary, strict metadata, BigInt parsing, capacity failure, storage capability failure, limiter bounds, mutex serialization, and DB-prefix restoration.
- Real `family_album_dev` tests use synthetic users/families/sessions and staging roots. They cover durable create/resume, two same-offset PATCH requests, abort-before-waiting-PATCH, member disable and session revoke after the body barrier, expired session, same/cross-family IDOR, access-time upload expiry, and failure-code whitelist/persistence.
- Synthetic upload/session/member/user/family rows and the synthetic staging namespace are removed by teardown.

## Known limitations

- No SHA-256 finalize, dedupe, `storage_objects` mutation, original publication, or `media_items` work exists in Phase 3C.
- No crash-recovery/reconciliation worker or bulk expiry cleanup exists yet. Frozen COMMIT-unknown receipts and rare cleanup failures require Phase 3D reconciliation.
- Rate limiting is bounded and in-memory for the current single API process; persistent multi-process/production enforcement is deferred.
- Storage writes remain disabled unless startup validates the configured existing DEV storage marker and receives `READ_WRITE` capability.
- Stable ENOSPC/EIO injection beyond the tested failure seams depends on a future dedicated fault-injection harness.
