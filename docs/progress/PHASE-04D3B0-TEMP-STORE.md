# Phase 4D3b-0 — Deterministic Temp + DerivedStore Writer

Status: owned-temp implementation. No seal, isolated verifier, publish, READY, serving, or job completion.

## Deterministic namespace

The only temp leaf is:

```text
MEDIA_ROOT/derived/.tmp/<job>/e<epoch>/<kind>.part
```

`<job>` and `<epoch>` are canonical positive decimals. The kind registry is fixed: `THUMBNAIL → thumbnail.part`, `PREVIEW → preview.part`. Callers cannot supply a filename, UUID, random suffix, or fallback name. `EEXIST` never retries under another name.

`derived/.derived-writer.lock` is the lifetime writer lock (exact mode `0600`). The known-file inventory now recognizes that lock beside `.capacity.lock`. It is not a temp observation and it is not a final asset. Unknown names still fail closed.

## Permit

`DerivedTempAdmissionPermit` remains a runtime-branded, frozen, single-use object. A plain object, spread copy, or `new` with the wrong secret is rejected. `consume()` rejects an expired or already-consumed permit. The path is taken only from the permit's job, epoch, and kind.

`createOwnedTemp` also requires a current-lease confirmation callback. The worker helper `createOwnedDerivedTemp` passes `repository.currentLease`. A false or failed lease check creates no file and does not consume the permit. Storage still does not open a database connection.

## Writer capability

`DerivedStore` pins the media root marker and the `derived` directory, then holds `.derived-writer.lock` for the store lifetime. A second opener gets `DERIVED_WRITER_BUSY`.

`DerivedTempWriter` accepts only an `UnverifiedRenderedCandidate` whose kind and recipe match the permit. It does not expose a path, a file descriptor, or `writeArbitraryFile`. Bytes are copied, hashed, written, fully synced, read back, and hashed again. The declared SHA-256 must match the bytes, and the durable file SHA-256 and size must match that same digest. Producer JSON is not an authority.

After a durable write the only file descriptor is closed. A second write is rejected. Mode `0600` is the creation mode; this slice does not `chmod 0400` and does not issue a sealed capability.

## Temp lifecycle

Directories `.tmp`, `<job>`, and `e<epoch>` are created with `mkdirat` mode `0700` relative to the pinned derived directory. Existing components are accepted only after directory type, owner, group, exact mode, device, and no-follow checks. They are not chmod'd into acceptance.

The leaf is `openat(O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC, 0600)`. Post-create checks require a regular file, the creating uid/gid, exact mode, the derived device, link count 1, and no extended ACL. The parent chain is pinned and checked again.

Classification when the leaf already exists:

| Case                                                                  | Result                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A. This process already has a live writer for the slot                | `DERIVED_TEMP_DUPLICATE`                                                     |
| B. This process still holds the writer and the recorded inode matches | exact `cleanupOwnedFailure`                                                  |
| C. Pathname residue, or any unsafe type/mode/link/owner               | `DERIVED_TEMP_RECOVERY_REQUIRED` or `DERIVED_TEMP_UNSAFE`; the entry is kept |

There is no automatic delete of a file this process did not create, and no overwrite.

## Identity, hash, and cleanup

A durable writer returns a snapshot: business tuple, device, inode, size, mode, link count, epoch and derived directory identity, and the recomputed SHA-256. The snapshot is the pre-seal binding. It is not a `SealedDerivedOutput`.

`fsync` plus `F_FULLFSYNC` failure deletes the owned inode when it still matches, then fails. No seal follows. Empty parent directories created for that owned leaf may be removed only when a readdir shows they are empty and the inode still matches. This is not a glob or `rm -rf`. A non-empty parent, or a replaced inode, is left in place.

`READ_ONLY` and `UNAVAILABLE` reject open, create, write, and cleanup. Accounting and inventory reads stay available through the existing capacity gate.

## Deferred

```text
SEALED_DERIVED_OUTPUT_CAPABILITY_PASS: PENDING
ISOLATED_OUTPUT_VERIFIER_CAPABILITY_PASS: PENDING
IMAGE_RENDERER_CAPABILITY_GATE_PASS: PENDING
```

Not implemented: final derived namespace, publish, READY, serving, job completion, D3b-1 recovery, D3c, video, verify-output, or full WebP decode. Crash residue without a live writer stays `RECOVERY_REQUIRED`.

Schema: NO. Migration: NO.
