# Phase 4D3b-0 Isolated verify-output

Capability only. A sealed temp candidate can be full-decoded by one fixed child. This slice does not publish, mark `derived_assets` READY, serve bytes, or complete a background job.

## Architecture

`SealedDerivedOutput.verify` accepts the sealed capability, the same `DerivedStore`, and the bound epoch/kind. It does not accept a path, a raw fd, a `Buffer`, or a pipe.

The native launcher rechecks root, parent, device, inode, size, mode `0400`, `nlink` 1, owner, and SHA-256. It then `dup`s the sealed read descriptor onto verifier FD3. After the child exits it repeats that check. Any mismatch discards the result. The SHA-256 returned to TypeScript is the sealed digest, and it must still match the candidate digest.

The child chain is the existing fixed supervisor, the tiny bootstrap, then one sandbox. The bootstrap emits `PS_RENDER_READY_V1` before `dlopen` of the verifier module and before the module's first `pread` of FD3. There is no nested sandbox and no decoder in the parent.

## Sandbox and FD map

FD0 is `/dev/null`. FD1 is the bounded control pipe. FD2 is bounded stderr. FD3 is the sealed object, read-only. There is no original FD, no `MEDIA_ROOT`, no directory FD, and no binary writer FD.

The profile is deny-default. It allows reading the fixed module path and `/dev/null`. It denies filesystem write, network, fork, and exec. The module probes path read, path write, root open, connect, DNS lookup, `fork`, `execve`, self-`execve`, and `posix_spawn` before it allocates pixels. A passing decode means those probes were denied.

The supervisor is spawned with `POSIX_SPAWN_CLOEXEC_DEFAULT` toward the bootstrap. The dev `high-fd` supervisor additionally requires the native parent to hold a file, a lock, and a socket above FD 1023. The child must observe `EBADF` on those descriptors.

## Codec and full decode

The module is a dylib statically linked to vendored libwebp 1.6.0. The bootstrap does not link the codec. There is no Homebrew library, pkg-config lookup, `dwebp`, or `PATH` search.

Before allocation the module accepts only one static `VP8 ` image, or `VP8X` with the alpha flag, optional `ALPH`, and `VP8 `. `EXIF`, `XMP `, `ICCP`, `ANIM`, `ANMF`, `VP8L`, unknown chunks, and trailing bytes are rejected from the sealed bytes. Dimensions above 2560 on a side, or more than 4 MiB of encoded bytes, are rejected before the pixel buffer exists.

`WebPDecode` then decodes into a caller-owned RGBA buffer with scaling, cropping, and threads disabled. Header parse alone is not success. Returned width and height are the decoded buffer dimensions. `alpha` follows the container alpha flag only when features agree. `transparent` is true only when a decoded alpha sample is not 255.

## Lifecycle and identity

Production deadline is 10 seconds, with `RLIMIT_CPU` 10 and no core dump. Dev lifecycle binaries use the same stop/reap path with a 1 second deadline so timeout and ignore-`SIGTERM` tests stay targeted. Crash, owner-death, exact `waitpid`, and no post-reap signal reuse `process_lifecycle.h`.

The sealed handle is single-use once verification starts, including rejection and identity failure. Consume does not delete the temp file and does not write a database result.

## Deferred

Final renderer qualification, publish, READY, serving, and job completion stay pending. Decoded geometry is not yet compared with D2 metadata. macOS Seatbelt in DEV is not a production isolation claim.

Schema: no. Migration: no.
