# Phase 4D3a-2 / 4D3b Boundary Design Review

Status: **R3-DESIGN APPROVED; implementation and runtime qualification pending.**

This document is the authoritative staging amendment to [D3 Guardrails](PHASE-04D3-GUARDRAILS.md), especially §§3, 13–16 and 33, and the output-validation boundary of the D3a-2 implementation prompt. It preserves the [startup review](PHASE-04D3A-STARTUP-ISOLATION-REVIEW.md), D3a-0/1 isolation and Phase 1–4D2 contracts. It authorizes the next implementation scope, not its execution in this review. Only this document is created.

## 1. Evidence and real conflict

- `packages/storage/src/index.ts :: VerifiedOriginalHandleImpl`, `OriginalReader.withVerifiedOriginal`, and `runSyntheticRendererStartupProbe` implement a consumed original handle and fixed synthetic startup. They do not implement a sealed derived handle or real renderer.
- `packages/storage/native/image_renderer_bootstrap.c` activates the final sandbox before loading the fixed synthetic module. `image_renderer_supervisor.c` and `process_lifecycle.h` provide the reviewed startup/FD/lifecycle foundation.
- `packages/media/src/index.ts :: IsolatedProbeRunner` is the existing metadata capability. Its qualification is not renderer or output-verifier qualification.
- `packages/storage/scripts/build-native.mjs` builds the existing native artifacts; storage/media package manifests do not provide pinned libwebp. No package-controlled libwebp source or static archive is present. Prior read-only `pkg-config` inspection found none; that is a dependency acquisition gap, not justification for a system fallback.
- D3 Guardrails §15.4 permits trusted-side bounded RIFF/container inspection. §15.5 requires full native decode in a separate isolated `verify-output` child. §15.6 and the following paragraph require the same sealed identity, carried exclusively by `SealedDerivedOutput`.
- Therefore **not all structural checks must run in the child**. The conflict concerns full decode and the final trust decision, which cannot be fulfilled by an in-process parent decoder or producer-only memory result.

`PARENT_IN_PROCESS_FULL_DECODE_ALLOWED: NO`.

## 2. Option decisions

| Option                                                        | Approved | Decision                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — trusted parent full decode                                | NO       | Bounded encoded input does not remove native decoder risk from the long-lived trusted process. This violates the existing decoder isolation contract.                                                                                                                             |
| B — Buffer/pipe/anonymous-FD verifier input                   | NO       | Such mechanisms could be designed safely, but are not approved here. They add another input identity/sealing/lifetime contract and a second verification path. No arbitrary FD, Buffer-to-verifier adapter, fake original handle, or temporary-file workaround is authorized.     |
| C — split producer and final gates                            | YES      | Producer/transport can be qualified before DerivedStore. Its output remains an unverified candidate. Final image qualification waits for actual sealed output and isolated decode.                                                                                                |
| D — minimal seal substrate first without capacity/reservation | NO       | D3 §15.1 and Phase 4 capacity rules require a confirmed reservation before any owned temp is created. Omitting capacity and reservation creates another conflict. A reservation-backed seal implementation is approved later as D3b-0, not as the proposed prerequisite shortcut. |

The absence of libwebp is resolved by the source strategy in §11; it is not an additional unresolved architectural blocker.

## 3. Exact implementation sequence

1. **D3a-2a — Renderer Producer / Bounded Binary Capability.** Fixed ImageIO/CoreGraphics renderer module with pinned static libwebp, original FD3, binary FD4, supervisor-internal liveness, strict READY/terminal control, resource/format classification, bounded streaming, SHA-256 and safe container rejection checks. Synthetic memory sink only; no output filesystem, DB, full-decode verifier or serving. Complete producer and binary gates independently. Existing D3a-2 recipes/limits remain binding.
2. **D3b-0 — Reservation-backed Derived Temp / Seal / Isolated Verifier.** Implement the approved DerivedStore namespace/markers/writer ownership, shared capacity admission, existing-schema reservation transaction and narrow reservation capability **before** `createTemp`; bounded append, complete-candidate seal, exact-owned cleanup, and isolated verifier. Include the required API/upload participation in the same shared capacity lock before enabling any DEV derived writer. Use synthetic roots and DEV reservations; no canonical publish, recovery adoption or processing worker. Reservation failure/unknown commit creates no temp. Failed cleanup remains accounted for. This is a real subset of DerivedStore, not a test-only alternative sealing system.
3. **D3a-2b — Final Renderer Qualification.** Connect the same producer to D3b-0's actual reservation-backed sink and verifier, qualify every format/recipe through sealed bytes, run final pixel/geometry/metadata/identity/isolation tests, and assemble matching evidence. No worker/job completion or canonical publish is required for this gate. **D3a-2 is complete only when D3a-2a and D3a-2b pass.**
4. **D3b-1 — Publish / Capacity Accounting Completion / Recovery.** Finish the approved PUBLISHING permit, exclusive atomic publish, durable sync, reconciliation/recovery and retained-byte release semantics. Keep schema, locks and no-overwrite rules unchanged. D3b COMPLETE requires both D3b-0 and D3b-1.
5. **D3c — IMAGE_DERIVATIVES worker / DB integration.** May be separately authorized only after final renderer qualification and complete DerivedStore gates pass.

This explicitly replaces the circular rule that all D3b work must wait for the final renderer gate. D3b-0 may start after the **producer + binary** gates pass; serving/publishing and worker enablement still need their later gates. Immediate next implementation: **D3a-2a**. No stage starts automatically as a consequence of this review.

## 4. Gate definitions and dependency graph

Gate records are scoped to exact build/platform/recipe and, where relevant, input format and kind. A design approval is never a runtime PASS. Unimplemented gates are `NO (PENDING)`, not waived or vacuously true.

```text
D3a-0/1 isolation evidence + fixed dependency/build + producer tests
  -> RENDERER_PRODUCER_CAPABILITY_PASS
bounded channels + length/exit/EOF + failure/reap tests
  -> BINARY_OUTPUT_CAPABILITY_PASS

shared capacity/reservation + DerivedStore temp/seal/identity tests
  -> SEALED_DERIVED_OUTPUT_CAPABILITY_PASS
sealed handle + fixed verifier sandbox + full decode/rejection tests
  -> ISOLATED_OUTPUT_VERIFIER_CAPABILITY_PASS

all four above + per-format/per-kind recipe and same-byte integration tests
  + matching evidence fingerprints
  -> IMAGE_RENDERER_CAPABILITY_GATE_PASS

final image gate + D3b publish/recovery gate -> possible later D3c enablement
```

- Producer PASS proves constrained production of a candidate, not that the candidate is a valid publishable image.
- Binary PASS proves bounded transfer, protocol completion and cleanup, not decode validity or source fidelity.
- Sealed-output PASS proves storage ownership, reservation, closure of writers and identity-bound handoff; it does not imply successful image decode.
- Verifier PASS proves the fixed isolated validator works and fails closed on its qualification corpus; each output still needs its own successful validation.
- Final image PASS requires all gates and per-output policy checks, including exact target geometry, metadata absence and static semantics. HEIC/RAW/DNG remain disabled. Missing/stale evidence disables the affected capability.
- D3a-2a documentation uses `PRODUCER_QUALIFIED` per format/kind; it must not print a production `JPEG_ENABLED` or `IMAGE_RENDERER_CAPABILITY_GATE_PASS: YES` based on producer tests alone.

## 5. Producer and pre-seal responsibilities

Allowed trusted-parent operations: incremental byte counting and recipe caps (512 KiB / 4 MiB), bounded queue/backpressure, SHA-256 over received bytes, strict <=4 KiB control parsing, <=16 KiB stderr handling, READY/one terminal/exit/EOF consistency, and comparison of reported length to actual length. No native decoding in Node.

Allow a small pure TypeScript checked-arithmetic RIFF scanner: exact RIFF/WEBP identifiers and declared total length, bounded chunk traversal/padding/ordering, declared geometry and recipe caps, and rejection of forbidden/unknown chunks or animation flags. Input is already bounded; no decompression, EXIF parsing, generic image library or recursive metadata parsing. The same policy code is reused after seal against actual stored bytes; a pre-seal pass is provisional. Magic/header success is not full validity, and header dimensions are not decoded dimensions.

Renderer-side source classification, bounded properties/record inspection, pre-allocation dimension/pixel checks, first-display-canvas policy and resize checks remain mandatory. Original limits remain 512 MiB, 16,384 per axis, 50M pixels; animation <=256 declared frames, one decoded frame; original structural inspection <=65,536 records / 4 MiB; provider cumulative bytes <=2 GiB; render <=30 s, heavy concurrency 1. No caller-selectable dimensions, quality or encoder options. Existing CPU/RSS watchdog and FD limits remain qualification obligations.

The D3a-2a memory sink owns at most one recipe-sized candidate buffer plus the approved <=256 KiB relay queue. Failure releases its references and never returns partial success. No unbounded Buffer array. A frozen JS object does not make its Buffer immutable: the candidate is **not** `SealedDerivedOutput`, cannot mint final evidence, cannot be published/served and cannot be passed to `verify-output`. Pre-seal digest is a transfer measurement, later recomputed from sealed bytes.

## 6. SealedDerivedOutput contract

Only `packages/storage` DerivedStore mints the opaque native-backed handle after a successful producer outcome and its owned sink transition. Public APIs expose neither path nor FD. Native handle type/magic and private ownership validation are required in addition to TypeScript types.

Required transition: confirmed reservation -> exclusive owned temp -> bounded append -> child normal exit + all EOF + valid complete control/length -> flush -> close **all** writable aliases and mappings -> read-only 0400 file -> verify same regular/single-link inode, root marker/device, owner/mode/ACL and size -> sealed handle. Failed/truncated output cannot be sealed as a successful candidate; it remains an exact-owned cleanup obligation and continues to count until cleanup is confirmed. There is no public `seal(Buffer)`, `seal(path)` or `seal(fd)`.

Identity binds root/derived marker and pinned namespace, device/inode, size/mode/mtime snapshot, family/media/job/generation/recipe/kind/epoch, producer outcome and reservation scope. The renderer has no temp FD or pathname. The storage writer cannot append/reopen for writing after seal. `chmod(0400)` alone neither revokes existing writable FDs nor defeats a hostile same-UID/root process; the guarantee relies on closed aliases, exclusive service ownership, confinement and identity/hash checks within the existing threat model.

Handoff duplicates only the pinned read-only sealed descriptor into fixed verifier FD3. Native pre-handoff and post-verification checks require the same snapshot and bytes. Validator results are wrapped by the trusted owner with that handle's identity, length and recomputed SHA-256; a child-supplied identity/hash cannot authorize another file. Failed validation revokes the candidate's eligibility, not the original's storage availability.

## 7. Isolated verify-output child

Choose **the same pinned libwebp decoder source**, statically linked into a separate fixed validator module. The tiny bootstrap links no codec; it activates the reviewed final sandbox and emits READY before loading this module or reading sealed bytes. No ImageIO fallback or second decoder is required.

Verifier map: FD0 read-only `/dev/null`; FD1 small control; FD2 bounded stderr; FD3 readonly sealed output; no binary FD4, original FD, directory FD or owner-liveness inheritance. Keep supervisor liveness private. Input accepts only `SealedDerivedOutput` plus internally selected approved recipe context; no arbitrary FD/path/Buffer/pipe. Child reads bounded bytes from FD3 internally, which does not create a new public memory-input capability.

Before pixel allocation, verify maximum encoded bytes, strict RIFF/chunk policy and raw feature geometry. Reject animation, unknown/extra payload and dimensions above the recipe bound; no cropped/scaled decoding that could conceal actual output geometry. Fully decode into checked, bounded caller-owned RGBA space within the child (maximum 2560 x 2560 x 4 bytes), using fixed single-thread configuration and the approved native limits. Successful header parsing alone is insufficient. The decoder API supports caller-supplied bounded output buffers; use full decode success and decoded dimensions, not renderer control values. [Pinned decoder API](https://raw.githubusercontent.com/webmproject/libwebp/v1.6.0/src/webp/decode.h).

Output: <=4 KiB exact-key versioned validation JSON, fixed mode/status/code and actual width/height/static result; no pixels, source metadata, paths or raw decoder errors. Parent checks successful exit, EOF and protocol, then matches results to its sealed handle and trusted target geometry. Deadline <=10 s, hard CPU <=10 s, no core dump, bounded RSS/watchdog, high-FD allowlist and exact lifecycle as approved. Renderer and verifier run serially under the same heavy-work gate.

Sandbox: deny-default; only reviewed fixed module/system-runtime reads and inherited sealed read. No original/second-object/root browsing, filesystem output, network/DNS, fork/exec/self-exec/posix_spawn, arbitrary environment or plugin resolution. The verifier cannot be handed a `VerifiedOriginalHandle`; the renderer cannot receive a sealed handle.

## 8. Structural, metadata and static validation

Final acceptance is the conjunction of strict trusted-side container policy on sealed bytes and isolated full decode. The child must also reject incompatible features before allocating. Neither decoder permissiveness nor encoder configuration substitutes for policy checks.

Recipe 1 accepts only the qualified `VP8 ` or `VP8X` + optional `ALPH` + `VP8 ` structure, exact lengths/order/padding, one static image and allowed alpha flags. Reject EXIF, XMP, ICCP, ANIM, ANMF, unknown chunks, duplicate payloads, inconsistent flags and trailing data. This independently verifies absence of standard metadata containers carrying GPS/camera/MakerNotes and animation payload, rather than trusting “stripped” in JSON. It cannot prove absence of information hidden in pixel content. [Official container specification](https://developers.google.com/speed/webp/docs/riff_container).

The verifier checks feature animation status and full static decode as well as the strict container result. Do not use a decoder that silently renders the first frame as proof that output is non-animated. Goldens verify orientation 1/5/6/7/8, mirroring, non-square geometry, alpha and first display canvas; no professional HDR/color-managed pipeline claim is added.

## 9. Source dimensions and no-upscale authority

The coordinator's authoritative expected geometry comes from the existing validated D2 metadata result for the same family/media/canonical object, with `metadata_generation == generation`, matching current recipe and positive raw/display dimensions and approved orientation semantics. Its provenance is an isolated original probe followed by fenced persistence, not a client value. Renderer control JSON cannot replace that expectation.

Before full decode, renderer rechecks actual source properties/declared canvas and orientation under the existing bounds; any mismatch with the trusted expectation rejects the attempt instead of overwriting metadata or selecting new dimensions. The trusted coordinator computes exact checked-integer inside-fit targets: orientation first; scale <=1; per-side floor with minimum 1; max box 480 or 2560. It compares the verifier's **decoded** output geometry to these exact targets. Width/height <= the source is necessary but not sufficient.

D3a-2a synthetic tests may use known generated-fixture dimensions as expectations; they confer no production metadata authority. Missing/stale/inconsistent production metadata blocks later processing and uses the approved metadata-probe workflow; this review adds no re-probe API, DB write or original access for the verifier. Renderer-side rechecking and goldens establish implementation behavior, not a cryptographic proof of faithful pixels after arbitrary renderer compromise.

## 10. TOCTOU, publish and failure semantics

After seal, hash and inspect the same pinned bytes used by the verifier; before and after verification recheck identity/snapshot and digest. Before publish recheck this verified identity and the approved PUBLISHING permit. Publish exclusively renames that same owned sealed inode under the existing durability protocol; it must not copy a different buffer, regenerate the image, reopen a caller path or substitute another candidate. Verification of buffer A never authorizes file B. Uncertain mutation, identity mismatch or stale evidence invalidates the result.

Producer timeout/crash/overflow/broken pipe/control mismatch yields no successful candidate. Seal/full verification failure yields no READY, publish or serving. In later DB integration, retain reservation/accounting until exact cleanup is confirmed; use existing failure/state/commit-unknown handling, not a new state or retry engine. Parser failure does not mark the immutable original corrupt. No DB behavior is implemented in this review or D3a-2a.

## 11. Package-controlled libwebp decision

Select **vendored, unmodified upstream release source**, with a narrow static build. Do not select ImageIO encoding, Homebrew, pkg-config discovery, an opaque prebuilt archive or any CLI encoder. Local development and CI build from the same checked-in source with no build/runtime network requirement.

Initial exact source candidate approved for acquisition: **libwebp 1.6.0**, upstream tag `v1.6.0`, commit `4fa21912338357f89e4fd51cf2368325b59e9bd9`. The official tag and release index establish this version's source provenance; this is not a claim that a tag alone proves absence of vulnerabilities. [Upstream release tag](https://chromium.googlesource.com/webm/libwebp/+/refs/tags/v1.6.0), [official release index](https://downloads.webmproject.org/releases/webp/index.html).

Proposed repository layout, to be implemented only in D3a-2a:

- `packages/storage/vendor/libwebp/1.6.0/`: full upstream release source, including `COPYING`, `PATENTS`, `AUTHORS`, version/build files and notices. Retain source rather than maintaining a manually pruned encoder fork; compile only required encoder/decoder targets and dependencies. Do not compile/install CLI tools, examples, optional external image libraries or runtime plugin lookup.
- `packages/storage/vendor/libwebp/SOURCE.lock.json`: exact version, tag/commit, canonical release URL, archive SHA-256, normalized source-tree/per-file integrity manifest, upstream verification provenance and any reviewed patch hashes. This review deliberately does **not** invent an archive checksum or download source. Acquisition must verify upstream signature with independently checked signing identity or authenticate the pinned commit, compute/review the archive/tree hashes, and commit the non-placeholder lock before any capability PASS. Computing a checksum from an unauthenticated download alone is insufficient.
- Package build script and build manifest: explicit macOS arm64 target, pinned compiler/SDK/build options, deployment target, source/object list and hashes, static archive hashes, encoder settings and final Mach-O dependency inspection. Fixed toolchain discovery may use the configured Apple developer tools; it never locates an encoder through PATH. Clean rebuilds verify the manifest; bit-identical builds across different Xcode/OS versions are not assumed.

Statically link the required libwebp objects into the renderer module and verifier module, from the same vendored source/configuration. Never link codecs into the pre-sandbox bootstrap. No libwebp dylib/rpath search, Homebrew/pkg-config fallback or automatic acquisition during normal build/startup. Generated archives/objects/modules remain in ignored package build directories.

Retain and distribute the BSD-style notices and patent grant as required by upstream [COPYING](https://raw.githubusercontent.com/webmproject/libwebp/v1.6.0/COPYING) and [PATENTS](https://raw.githubusercontent.com/webmproject/libwebp/v1.6.0/PATENTS). A future update is an explicit source/lock/license/build diff plus advisory review and full affected capability requalification. Check known upstream security advisories at acquisition; a known affected pin fails qualification and requires an explicit reviewed dependency update, never floating to latest. Existing recipe/build identity rules still apply to codec/OS changes, including new recipe/generation when required; do not silently rewrite historical artifacts.

## 12. Renderer/verifier independence and evidence composition

Separate process, capability, parser policy and full decode are required; different codec implementations are not required. Shared pinned libwebp encoder/decoder has correlated-bug risk. A small independent TypeScript container policy, malformed/truncated corpus and goldens provide complementary evidence without claiming N-version independence. The verifier is a validation boundary for bounded output structure/decodability, not proof of pixel authenticity or absence of all codec bugs. No ImageIO fallback is introduced for validation.

Each evidence record binds protocol versions; renderer, verifier and both bootstrap hashes; supervisor/lifecycle build; exact embedded sandbox policies and module/dependency closure; libwebp version/source/build hashes; recipe registry/geometry/color settings; OS/ImageIO build; storage seal implementation and root qualification where applicable; tested input format/kind; and test-suite revision. Final qualification references the actual component records and verifies all shared fingerprints agree. It may not combine producer evidence from build A with verifier evidence from build B or reuse D0's enabled flag. Startup checks current fingerprints and required live synthetic denials; drift fails closed. A future final PASS is per supported format/kind, not global permission for all `image/*`.

## 13. Required tests by stage

### D3a-2a producer

- Delayed real module/framework loading, READY-before-read, FD3 read-only, FD4-only output, liveness exclusion, non-CLOEXEC high descriptors, path/secret/network/fork/exec/spawn denials; dependency fingerprint failure.
- Both recipes; format-specific positive/corrupt/truncated inputs, bounded header checks, huge dimensions/pixels/frames, orientation and alpha declared output, HEIC/RAW disabled; producer-only results remain unverified.
- Streaming byte caps independently in supervisor/parent, near-4-MiB backpressure, <=256-KiB relay queue, control/stderr/binary floods, all protocol/length/exit/EOF failures, reversed callback scheduling, timeout/crash stages/owner loss, heavy concurrency 1, cleanup and original snapshots.
- D3a-0/1, D0/D1/D2 and affected existing regression/readiness/typecheck/lint/changed-file-format checks. No new derived writes or DB mutation for producer qualification.

### D3b-0 sealed output and verifier

- Real approved reservation precedes temp; no reservation/unknown commit/low capacity rejects; shared upload/derived admission race, exact-owned cleanup and retained accounting. Synthetic DEV fixtures only; no canonical publish.
- Wrong handle class/family/generation/recipe/epoch, original-as-sealed forgery, raw path/FD/Buffer/pipe rejection; writer aliases closed; post-seal append/truncate rejected; symlink/hardlink/inode swaps fail; root/device/ACL/mode and same-byte binding checked.
- Valid static WebP full decode; corruption/truncation even when headers pass; extra/duplicate/unknown chunks, metadata/animation flags and payloads rejected; dimensions bounded before allocation and matched after decode.
- Verifier sandbox denies original/second object/path/network/writes/process creation; output bounds, timeout/crash/ECHILD/high-FD/reap; no partial candidate accepted; no fixture residue.

### D3a-2b final qualification

- Every enabled JPEG/PNG/WebP/GIF kind passes the actual producer -> reserved temp -> seal -> isolated verifier chain. Decode failure prevents final success even if producer/control/header pass.
- Decoded exact geometry/no-upscale, golden pixels for orientation 1/5/6/7/8, alpha, animated first display canvas and metadata-rich source preservation. Metadata absence verified on actual sealed output, not only encoder flags.
- Buffer/file substitution, post-check mutation attempt, digest/identity mismatch and stale component evidence fail. All four prerequisite gates, recipe tests and matching build evidence required. Final synthetic cleanup remains 0.

## 14. Database and current decision

Schema change: NO. Migration required: NO. Existing `derived_assets` reservation/state fields support D3b-0; this staging clarification neither alters 0003 nor adds 0004. D3b-0 will require the already-designed repository/capacity implementation and synthetic DEV transactions, not new schema. D3a-2a has no DB effects.

P0_DESIGN_BLOCKERS: 0

P1_DESIGN_BLOCKERS: 0 after this amendment; runtime gates remain unimplemented.

DESIGN_CHANGE_REQUIRED: YES — explicit staging/gate amendment; isolation/sealed-input contract preserved.

DATABASE_MIGRATION_REQUIRED: NO

PARENT_IN_PROCESS_FULL_DECODE_ALLOWED: NO

MEMORY_OR_PIPE_VERIFIER_INPUT_ALLOWED: NO

SEALED_DERIVED_OUTPUT_REQUIRED_FOR_FULL_VERIFY: YES

D3A2_CAN_COMPLETE_BEFORE_DERIVED_STORE: NO — completion needs the real D3b-0 seal subset, not all publish/recovery work.

RENDERER_PRODUCER_CAN_COMPLETE_BEFORE_DERIVED_STORE: YES

IMAGE_RENDERER_FINAL_GATE_REQUIRES_DERIVED_STORE: YES — reservation-backed sealing subset.

PINNED_LIBWEBP_STRATEGY_APPROVED: YES — actual authenticated source/hash lock and runtime qualification still required.

NEXT_IMPLEMENTATION_STAGE: Phase 4D3a-2a — Renderer Producer / Bounded Binary Capability

READY_FOR_NEXT_IMPLEMENTATION_STAGE: YES

READY_FOR_PHASE_4D3A2A: YES

No renderer, DerivedStore, dependency download/install, database operation, migration or runtime qualification was performed by this design review. Existing D0 high-FD P2 and D3a-1 test/platform limitations remain open as previously recorded.
