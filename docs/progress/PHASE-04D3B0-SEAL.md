# Phase 4D3b-0 — Seal and SealedDerivedOutput

Status: sealed temp capability. No verifier, full decode, publish, final derived namespace, READY, serving, or job completion.

## Lifecycle

```text
OPEN writer
→ durable write (bytes, SHA-256, fsync, F_FULLFSYNC, writable fd closed)
→ SEALED
→ CONSUMED
```

Only a `DerivedTempWriter` that already finished its durable write can seal. Seal does not accept a path, a filename, or an arbitrary descriptor. The writer must already have closed its writable fd. Seal opens the same inode read-only, rechecks it, then changes the mode. A leftover writable handle is not chmod'd into a sealed result.

`0400` is the sealed mode. It is not the immutability proof. The proof is: no writable capability remains, the read fd stays inside the opaque object, and the device, inode, owner, link count, size, and SHA-256 still match.

## Durability and hash chain

Seal repeats the checks after the write:

1. Root marker, derived inode, and epoch parent inode.
2. Regular file, owner, group, device, inode, link count 1, and the recorded size.
3. SHA-256 of the file bytes, compared with the SHA-256 stored when the candidate was written.
4. `fchmod(0400)` only after those checks.
5. `fsync` and `F_FULLFSYNC`.
6. Identity recheck, including mode `0400`.
7. The read-only fd stays inside `SealedDerivedOutput` until consume. It is not returned to JavaScript.

Candidate SHA, temp SHA, and sealed SHA are the same digest computed by the storage process. Renderer JSON is not consulted.

If durability or close fails, no sealed object is returned. A later exact cleanup may remove that inode when device, inode, owner, and mode `0600` or `0400` still match. Inode, device, owner, link, or parent changes leave the entry in place and report recovery required. There is no glob and no recursive delete.

## Capability

`SealedDerivedOutput` is a runtime-branded object bound to one store, one reservation tuple, the root marker, parent identity, device, inode, size, SHA-256, mode, and mtime. A plain object, spread copy, or JSON revival is not live. Consume is single-use and must be the same store. A second consume, a stale handle, the wrong epoch, or the wrong kind fails closed.

The file remains at `derived/.tmp/<job>/e<epoch>/<kind>.part`. Inventory accepts that leaf as mode `0600` while open and mode `0400` after seal. Lock files stay exact `0600`. This is not a final derived path and not a publish.

`READ_ONLY` and `UNAVAILABLE` reject seal and cleanup.

## Deferred

```text
ISOLATED_OUTPUT_VERIFIER_CAPABILITY_PASS: PENDING
IMAGE_RENDERER_CAPABILITY_GATE_PASS: PENDING
```

The sealed object is the only future input for an isolated verifier. This slice does not decode WebP, map a verifier fd, publish, or mark READY.

Schema: NO. Migration: NO.
