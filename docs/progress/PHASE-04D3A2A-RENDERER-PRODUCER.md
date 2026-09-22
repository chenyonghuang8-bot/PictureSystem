# Phase 4D3a-2a — Renderer Producer / Bounded Binary Capability

Status: producer capability implemented and targeted-tested. This is **not** a verified, sealed, publishable or servable derivative. `IMAGE_RENDERER_CAPABILITY_GATE: PENDING` until D3b-0 sealed output and D3a-2b isolated full-decode verification.

## Fixed architecture and authority

`OriginalReader.withVerifiedOriginal` validates the canonical immutable original against its marker, size and SHA-256, then `renderUnverifiedCandidate` consumes that opaque handle exactly once. The fixed package-owned supervisor passes only the verified read-only original as child FD3. The tiny bootstrap activates the final macOS sandbox before loading the fixed renderer module; the module's first FD3 read follows `PS_RENDER_READY_V1`. The renderer uses `pread`-backed ImageIO/CoreGraphics and statically linked libwebp. It receives no original pathname, output pathname, storage root, caller-selected FD, argv, executable, profile or environment.

Child FD map: FD0 `/dev/null`; FD1 bounded control JSON; FD2 bounded diagnostics; FD3 verified read-only original; FD4 bounded encoded binary. FD5 is a supervisor-only owner-liveness pipe, not inherited by the renderer. `POSIX_SPAWN_CLOEXEC_DEFAULT` plus explicit `dup2` actions preserve the D3a-1 inherited-FD allowlist. Child environment is exactly `LANG=C`, `LC_ALL=C`; fixed artifacts are ownership/mode/SHA-256 checked before spawn. The final sandbox has no network, arbitrary file write/read, root browse, fork or exec capability. FD4 is a pipe capability, not a filesystem output path. The app never executes an unsandboxed fallback.

The supervisor concurrently drains control, diagnostics and binary while observing owner liveness, process exit, timeout and RSS. The relay queue is 64 KiB; output limits are enforced during drain, not after unbounded buffering. Any failure, owner loss, flood or timeout discards the candidate and terminates/reaps the exact child via the shared D3a-1 lifecycle. The TypeScript parent independently caps/counts bytes, calculates SHA-256, requires exact canonical control grammar, and runs a bounded structural RIFF/WebP chunk inspection. It does **not** perform a full WebP decode. The output is named `UnverifiedRenderedCandidate` and cannot authorize DB READY, publish, serving or job completion.

## Pinned libwebp

Version `1.6.0`, upstream tag `v1.6.0` (tag object `b7e29b9d75bd31422b00c2a446d49d7af06c328d`), approved commit `4fa21912338357f89e4fd51cf2368325b59e9bd9`. The official WebM release archive SHA-256 is `e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564` (4,296,070 bytes). The official GitHub tag archive SHA-256 is `93a852c2b3efafee3723efd4636de855b46f9fe1efddd607e1f42f60fc8f2136`; all 197 comparable codec/header/license files were byte-identical. Archive members were checked for traversal/symlinks/special files. The detached release signature was obtained but **not** claimed verified: no pretrusted signing key was available.

The unmodified upstream release tree is vendored at `packages/storage/vendor/libwebp/1.6.0/`. `SOURCE.lock.json`, the 367-file `SOURCE.sha256` manifest and `PROVENANCE.md` record provenance; `COPYING`, `PATENTS`, `AUTHORS` remain. `build-native.mjs` verifies the manifest and builds static `libwebp.a` / `libsharpyuv.a` using fixed Apple toolchain commands from a copied tree in ignored `packages/storage/build/`. Renderer modules link these archives statically. No Homebrew/pkg-config, runtime download, encoder PATH lookup or dynamic libwebp dylib is used. Build artifacts remain Git-ignored.

## Protocol and fixed recipes

Control is `PS_RENDER_READY_V1` followed by a single fixed-key JSON line: status, kind, recipe, MIME, width, height, byteCount, producerCode. Control ≤4 KiB and stderr ≤16 KiB. Binary is exclusively FD4. The parent requires actual byte count = reported byte count, nonzero output, valid static VP8/VP8X+ALPH RIFF structure, no extra bytes/chunks, matching dimensions and the recipe bound. It rejects EXIF, XMP, ICCP, ANIM, ANMF and unknown chunks. This is a bounded container check, **not** final structural full-decode, visual or private-metadata qualification.

| Recipe      | Dimensions                   | Encoding                          | Hard maximum |
| ----------- | ---------------------------- | --------------------------------- | ------------ |
| THUMBNAIL 1 | inside 480×480, no upscale   | static WebP, quality 75, method 4 | 512 KiB      |
| PREVIEW 1   | inside 2560×2560, no upscale | static WebP, quality 82, method 4 | 4 MiB        |

Both recipes preserve alpha and encode sRGB; no EXIF/XMP/GPS is intentionally passed through. Full decoded alpha/color/geometry/metadata qualification is deferred to D3a-2b's isolated verifier.

| Input   | Thumbnail producer | Preview producer | Policy                                                                                |
| ------- | ------------------ | ---------------- | ------------------------------------------------------------------------------------- |
| JPEG    | tested             | tested           | EXIF orientations 1/5/6/7/8 tested with non-square fixtures                           |
| PNG     | tested             | tested           | alpha kept in WebP ALPH container                                                     |
| WebP    | tested             | tested           | static and synthetic animated; animated input yields one static first-frame candidate |
| GIF     | tested             | tested           | static and synthetic animated; one static candidate                                   |
| HEIC    | disabled           | disabled         | no V1 dispatch                                                                        |
| RAW/DNG | disabled           | disabled         | no V1 dispatch or path-based converter                                                |

The fixed native pre-decode structural scan bounds inspection to 65,536 records and 4 MiB of header reads, validates allowed format, dimensions/pixels and at most 256 animation frames before ImageIO source/thumbnail work; ImageIO properties are cross-checked against scanned dimensions/frame count. Input ≤512 MiB, width/height ≤16,384, pixels ≤50,000,000, provider cumulative reads ≤2 GiB, render wall time ≤30 seconds, child CPU limit 30 seconds, RSS watchdog 2 GiB, FD limit 64, heavy render concurrency 1. The renderer decodes only index 0; it does not loop over frames. If a format cannot satisfy these bounds on this backend, the producer rejects it.

## Evidence and remaining boundary

Synthetic tests cover the four enabled formats, both recipes, orientation, PNG alpha, animated 2-frame and over-256-frame rejection, corrupt/truncated/large headers, metadata container absence, control/length/RIFF corruption, binary/control/stderr flood, near-4-MiB backpressure, timeout/crash/owner loss, high FD 1500/1601/1703 denial and original bytes/inode/mode/mtime preservation. Existing D0/D1/D2 and Phase 3/4B/4C tests were rerun. No real family media or DB schema/migration was changed.

Final targeted results: native/storage/media/worker combined 118/118 PASS across 7 files; Phase 3C/3E and Phase 4B/4C/D2 with Phase 4 schema/repository 62/62 PASS across 8 files, 0 skipped; migration-readiness/migration tests 36/36 PASS; workspace typecheck and lint PASS; changed-file format PASS; generated synthetic renderer temp roots remaining 0. Native `sandbox_init` and DEV MySQL loopback tests required the approved macOS host execution context because the Codex sandbox denies these capabilities; no system or DB configuration was changed.

This build's macOS OS-build gate: `26A428`. Example SHA-256 artifact fingerprint after native build: thumbnail bootstrap `b3124bac7d9cd97f27e1938b6826201c7a3fea794dd7343a2043b6f44e2d7c41`, thumbnail module `32f8bcf803f46d4ff0bb92d810a8cf54b56e7a7569b43d04f1e9b033c2d414d5`, thumbnail supervisor `16e355506aca7ca7b6786e38b3b39617af8e979f464225e0bac9c8da58b2b13e`. These are build artifacts, not public verification evidence for derived output.

Next authorized stages: D3b-0 implements capacity/reservation, owned temp, seal and isolated verifier; D3a-2b qualifies final decoded output from a `SealedDerivedOutput`; D3b-1 handles exclusive publish/accounting/recovery. No verifier, DerivedStore, filesystem derived temp, DB mutation or worker completion exists in D3a-2a.
