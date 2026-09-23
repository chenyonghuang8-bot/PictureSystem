# Phase 4D3b-1a derived publish primitive

Filesystem publish only. This slice does not write `PUBLISHING` or `READY`, finish a job, serve bytes, or sweep recovery.

## Final namespace

From the approved guardrails, not a new layout:

```text
MEDIA_ROOT/derived/<family>/<media>/r<recipe>/g<generation>/<kind>.webp
MEDIA_ROOT/derived/.tmp/<job>/e<epoch>/<kind>.part
```

`<kind>.webp` is `thumbnail.webp` or `preview.webp`. Recipe directory is `r1` only, matching the current registry recipe. Family, media, generation, job, epoch, and reservation are canonical unsigned decimals stored on the native writer when the temp is created. The caller does not supply a path.

`.derived-root` is still not provisioned. A well-formed final tree is a known inventory class and is not a temp observation, so a published file does not make the derived scan incomplete. Quota correlation of those files stays with later recovery and READY.

## Atomic no-clobber

`publish` accepts only a live `SealedDerivedOutput` plus the store capability and the identity binding. It does not accept a path, fd, or buffer.

Native `renameatx_np` uses `RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH` from the pinned epoch directory to the pinned final parent. The destination name is computed inside native. Phase 3 `publishOriginal` is not given a generic target and is not called.

Before the rename the sealed inode is rechecked: family, media, generation, recipe, kind, job, epoch, reservation, device, inode, mode `0400`, `nlink` 1, owner, and SHA-256. The handle must already have passed isolated verify-output. A second verify returns `DERIVED_ALREADY_VERIFIED` and does not consume the handle. A failed verify still consumes it.

If that recheck fails, nothing is renamed. A wrong caller binding fails in TypeScript and leaves the handle usable. A wrong SHA or inode fails in native, consumes the handle, and does not create the final name.

After a successful rename the still-open read fd and both directories are synced. Only then are empty temp parents removed, and only when their inodes still match the writer. The canonical inode is not unlinked.

## Existing final

The final name is classified before any rename:

- absent: exclusive rename
- identical: regular `0400`, one link, same device, owner, size, and SHA-256; outcome `IDENTICAL`; the existing inode is left in place; the temp file is also left in place
- different regular bytes, mode, or link count: `DERIVED_PUBLISH_CONFLICT`; bytes unchanged
- symlink or other non-regular name: `DERIVED_PUBLISH_UNSAFE`; the name is not replaced

An `EEXIST` that appears between that classification and the rename is not retried and is not overwritten. Sync failure after the rename throws `DERIVED_PUBLISH_DURABILITY_UNKNOWN` and does not unlink or rename again.

## Storage state

Publish runs only while the capability is `READ_WRITE`. `READ_ONLY` throws `DERIVED_READ_ONLY`. `UNAVAILABLE` throws `DERIVED_UNAVAILABLE`. Neither attempts a rename.

The primitive only opens directories under the pinned derived directory. It does not open `originals/`.

## Result

The in-memory result is `PUBLISHED` or `IDENTICAL`, with SHA-256, byte size, device, inode, generation, and kind. `IDENTICAL` reports the sealed candidate identity and does not mean the existing final inode was replaced. Nothing is written to `media_items`, `derived_assets`, or background jobs.

## Crash boundary

Recorded for a later recovery slice. No sweep is implemented.

| Window | This slice | Later recovery |
| --- | --- | --- |
| A, before rename | Temp remains. No new final. An existing final is untouched. DB stays `RESERVED` because this slice never writes `PUBLISHING`. | Exact temp cleanup only after a dead lease is proven. |
| B, after rename | Canonical inode may be durable. DB is still `RESERVED`. | Do not delete a complete canonical file. Match size, hash, and decode to the original intent before any READY write. |
| C, before DB completion | No READY transaction exists yet. | A future short transaction, with a new DB time and the current lease, is what may set READY. Unknown commit is not replayed here. |

Guardrails section 18 still requires a one-shot permit after a committed `PUBLISHING` row, then a second transaction for `READY`. This primitive is the exclusive rename those steps will call. It is not that protocol by itself.

## Deferred

Recovery sweep, worker completion, serving, and READY stay unimplemented. Uid-mismatch and cross-device negative fixtures remain unconstructable without extra privileges. An `IDENTICAL` result leaves the sealed temp beside the final file; accounting for that pair belongs to recovery, not to a delete in this slice.

Schema: no. Migration: no.
