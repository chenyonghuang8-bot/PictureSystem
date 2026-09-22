# Phase 4D3a — macOS Renderer Startup Isolation Review

Status: **R3-DESIGN APPROVED for the capability harness; runtime validation NOT performed.**

Date: 2026-09-22. Reviewed baseline: `f07b35232129dc83e99eabac23463b14f9533bb1` on `main`. Observed platform: macOS 27.0, build `26A428`, arm64, Command Line Tools SDK 27.0.

This is the authoritative startup-only amendment to [Phase 4D3 Guardrails](PHASE-04D3-GUARDRAILS.md), specifically its nested-policy requirement in §5, launcher wording in §29, and control framing in §3. The original document remains the authority for recipes, format/resource limits, binary transport, original preservation and the 4D3a/b/c split. This review creates only this document. It does not implement, enable or certify a renderer, modify D0/D1 processing semantics, or change a database/migration.

## Root Cause

- **Nested sandbox supported:** NO as a supported/reliable `sandbox_init()` tightening strategy. This conclusion concerns that API and the proposed startup sequence; it is not a claim about every private kernel sandbox facility.
- **Previous design valid:** NO for `sandbox-exec -> already-sandboxed child -> second sandbox_init -> stricter policy`.
- **Exact blocker:** the installed SDK `sandbox.h:24–49` documents that applying `sandbox_init()` to an already sandboxed process fails and ignores the new profile. Treating that failure as success leaves the launch profile, including its fixed-child exec permission, in effect.

Actual code evidence:

| File / symbol                                                                                             | Evidence and implication                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/storage/native/original_probe_supervisor.c :: main`                                             | Forks, maps original FD3, then execs `/usr/bin/sandbox-exec` with profile/child parameters. Closes only FD4–1023.                                                                                              |
| `packages/storage/native/original-probe.sb`                                                               | Allows `process-exec` for `CHILD`; denies fork, network and filesystem writes. There is no one-use qualification on the exec rule.                                                                             |
| `packages/storage/native/original_probe_child.c :: main`                                                  | Checks fork and exec of `/usr/bin/true`, not self-exec or independent `posix_spawn`; these tests cannot establish strict no-exec for the allowed child.                                                        |
| `original_probe_supervisor.c :: terminate_group/main`                                                     | Normal exit still reaches an unconditional `kill(-pid, SIGKILL)` after `waitpid` may have reaped the child.                                                                                                    |
| `packages/storage/src/index.ts :: runFixedOriginalChild`                                                  | Fixed public orchestration, single-use handle; currently metadata stdout only and FD4 owner liveness. Renderer requires a distinct protocol/map.                                                               |
| `packages/storage/native/metadata_parser_child.m :: main` and `packages/storage/scripts/build-native.mjs` | Objective-C/Foundation, CoreGraphics and ImageIO are linked into the existing metadata executable. Moving sandbox activation into this executable's `main` would not move its pre-main framework initializers. |
| `packages/media/src/index.ts :: IsolatedProbeRunner`                                                      | D0 capability gate belongs to the existing metadata backend. It is not renderer capability evidence.                                                                                                           |

The D1/D2 documents and actual tests were checked. No separately named D0 design/targeted-review document was found among relevant progress documents; D0 evidence is the implementation and targeted tests, not an assumed missing report. Existing phase-completion statements supplied by the user are preserved.

## Options

### Option A — self-sandbox fixed renderer

- **SECURITY_VALID: YES, conditional on a minimal pre-sandbox TCB.** A trusted child may apply its first and final sandbox before any untrusted media access.
- Directly placing `sandbox_init()` at the beginning of an Objective-C renderer `main()` is **not approved**. dyld, constructors, Objective-C `+load` and dependent framework initialization precede `main()`.
- If A is reduced to a tiny C entry point with no decoder/framework initialization before activation, it becomes the selected Option C.
- Activation failure, missing API, pre-existing sandbox or failed verification terminates the attempt before decoder load, READY or original-byte read. Never continue after an activation error.

### Option B — existing sandbox-exec single profile

- **Viable as the existing launch mechanism:** YES. **OPTION_B_ACCEPTABLE for this renderer: NO.**
- The fixed-child exec permission remains; it does not independently establish that self-exec is possible on every OS combination, but it cannot prove strict post-start no-exec. No runtime self-exec test was run in this design review.
- A compromised process can construct new argv and env; the trusted parent's original constants do not constrain later in-process exec arguments. Re-entry into debug/test modes or bootstrap, and resetting child-local counters, create an avoidable capability.
- Self-exec does **not inherently remove an inherited sandbox, escape the external PGID, or reset the supervisor's monotonic deadline**. This review does not claim an unproven sandbox escape. B is rejected because it fails the approved zero-exec boundary, not because every self-exec is automatically a privilege escalation.
- Do not compensate with broader allowances or blind post-reap group killing.

### Option C — tiny trusted bootstrap + in-process renderer

- **Viable: YES as the selected design, subject to live qualification. TINY_BOOTSTRAP_REQUIRED: YES.**
- Fixed supervisor directly `posix_spawn`s a tiny native C bootstrap. It applies one final sandbox, verifies activation, emits READY, loads one fixed renderer module **within the same process**, and calls its fixed entry point. There is no exec after activation.
- Bootstrap links only the minimum Apple system/sandbox runtime. Renderer module and all ImageIO/CoreGraphics/Foundation/Objective-C dependencies are loaded after activation. Pinned libwebp is statically linked into that fixed module, never discovered at runtime.
- The fixed module arrangement is deliberate: statically linking a renderer object while also linking its Apple frameworks into the bootstrap would still admit pre-main framework initializers. A future all-C/function-table implementation is not needed for this slice.
- This is still one fixed native renderer child using the approved ImageIO/CoreGraphics plus libwebp technology. The module is an implementation component, not a caller-selectable plugin.

## Recommended Architecture

```text
OriginalReader / single-use VerifiedOriginalHandle
  -> trusted fixed supervisor (clean env, resource/deadline owner)
  -> posix_spawn fixed tiny C bootstrap (only FD0–4)
  -> validate constant invocation, FD types/rights, fixed resource limits
  -> apply embedded final sandbox ONCE; verify active and restricted
  -> emit fixed READY on FD1
  -> load fixed renderer module and Apple dependencies under sandbox
  -> renderer_main(fixed kind/recipe, internal FD3 provider, FD4 writer)
  -> bounded binary + one terminal JSON; exit; supervisor drains and reaps
```

- **Process model:** one child per kind; output-validation child uses the same bootstrap rules with its separately approved bounded input capability. No reusable renderer, request loop, shared decoder process or sandbox reset.
- **Fixed executable/module:** package-owned build artifacts selected internally. Exact paths and policy literals are generated from the trusted build configuration, embedded and fingerprinted. Relocation/rebuild invalidates qualification. API callers cannot supply paths, handles to executables, module names, profile text or argv.
- **Invocation:** fixed protocol/version token and one approved `THUMBNAIL/1` or `PREVIEW/1` selector. Bootstrap performs only bounded exact comparisons; detailed dispatch happens after activation. Production render entry has no fault/debug/test selector. Test harness entry points are separately built and inaccessible through the production runner.
- **Environment:** fresh allowlist exactly `LANG=C`, `LC_ALL=C` for both parent-to-supervisor and supervisor-to-bootstrap. No environment merge. No PATH, HOME, TMPDIR, DYLD variables, Objective-C/runtime diagnostics, CF preference variables, plugin/config variables or application secrets. A missing variable is not replaced from the parent.
- **cwd:** `/`, established by fixed spawn file actions, with no user/current-project cwd inheritance. This does not grant post-sandbox root listing.
- **Security scope:** trusted parent, package build/configuration, fixed binaries and sealed Apple OS runtime. Uploaded bytes are adversarial and may fully compromise the decoder after activation. Arbitrary same-UID local code replacement, root/kernel compromise and a compromised trusted parent are not solved by this DEV design.

### Pre-sandbox TCB and loading

Allowed before activation: dyld and the minimal trusted system/sandbox dependency closure; tiny C bootstrap with no application constructors; exact invocation checks; `fstat`/`fcntl` access-mode validation; fixed resource/signal setup; sandbox application/checks. No data-dependent allocation from file size, no source-byte read/mmap, no `F_GETPATH`, no locale/config discovery or network calls. `fstat` may inspect descriptor metadata but never triggers parsing or allocation proportional to attacker values.

Build/qualification must inspect the bootstrap's `LC_LOAD_*`, `LC_RPATH`, initializer sections and dependency closure. ImageIO, CoreGraphics, Foundation, libobjc, renderer module and libwebp must not initialize through bootstrap load dependencies. Do not assume a source-file boundary proves a binary initialization boundary. Sanitizer/test preloads are not production qualification.

The supervisor validates the approved bootstrap/module/policy/build fingerprints and trusted path ownership/mode/ancestors before launching. No user-writable search directories, environment-expanded paths, broad package-root read permission, arbitrary `@rpath` or loader fallback. DEV build directories must be stable while the worker is active; hash-then-launch is not protection against a hostile same-UID actor rewriting the installation.

**Post-activation loading:** allow readonly/mapping access to the exact fixed renderer module and its reviewed Apple system dependency/resource closure. The module may use Objective-C only now. `dlopen` uses one trusted exact path and a fixed entry symbol; no symbol/path from a request. Executable mapping of an approved dylib is distinct from permission to call execve. No unsandboxed framework warmup to avoid denied resources.

Chromium's primary [Mac Sandbox V2 design](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/sandbox/mac/seatbelt_sandbox_design.md) uses a small executable, applies sandboxing before framework loading, and explains the risk of pre-main initializers. This is architectural precedent, not proof that PictureSystem's profile or current ImageIO build passes.

### Sandbox profile source and API

**Select profile source A: immutable profile text compiled into the bootstrap.** A reviewed source file can generate the string at build time; it is never read as a caller-selected resource at launch. Fixed module/system paths are build constants. The profile contains no MEDIA_ROOT, original filename, derived directory, user HOME or request-derived substitution.

| Alternative                             | Decision                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| Fixed resource file read before sandbox | Rejected for V1: unnecessary pre-sandbox I/O, path/TOCTOU surface.                          |
| Parent-supplied profile text            | Rejected: no need for dynamic policy authority or a pre-sandbox input parser.               |
| Built-in named profile                  | Rejected: generic named profiles do not express the required narrow FD/runtime permissions. |

Approved DEV activation candidate: one `sandbox_init(embedded_profile, 0, ...)` through a narrow compatibility wrapper, followed by an independently checked sandbox-active query. **This custom-profile usage is not a current supported public SDK contract:** `sandbox.h` documents `SANDBOX_NAMED`, marks the API unsupported/deprecated, and reserves other flags. The raw SBPL/flags=0 behavior and the `sandbox_check` query therefore require an explicit OS/build-pinned runtime gate. Never describe them as guaranteed merely because symbols link.

The installed SDK's `libsystem_sandbox.tbd` still exports `sandbox_init`, `sandbox_init_with_parameters` and `sandbox_check`; `libsandbox.1.tbd` exports compiler/apply symbols. Chromium's [Seatbelt wrapper](https://chromium.googlesource.com/chromium/src/+/133.0.6943.141/sandbox/mac/seatbelt.cc) shows these platform interfaces in real use. This supports testing the candidate; it does not establish their success on macOS 27.0. No production promise or private-API ABI stability is inferred.

There is **one selected activation path**, not a runtime chain trying different APIs/profiles until one works. If this candidate cannot apply the exact profile, the harness fails closed and implementation returns for R3 review. Deprecated does not mean automatically unavailable; presence does not mean proven usable. A pre-existing inherited sandbox, including a development tool's outer sandbox, is an explicit unsupported launch condition: reject before parsing, do not bypass it or count its unrelated policy as this renderer's policy. Real harness testing must occur in the intended DEV launch context.

### Final sandbox policy envelope

- Deny default, process exec (including same bootstrap and helper), process fork, network/DNS, filesystem writes, user preferences, arbitrary Mach/IPC discovery, debug/task access and unrelated device access.
- Allow only inherited input/output operations plus narrowly enumerated system runtime reads/mapping and exact renderer module reads/mapping. No filesystem output/temp namespace.
- Application secrets, user directories, MEDIA_ROOT, second originals, `/dev/fd` path reopen and directory traversal remain denied. The runtime may need selected immutable system files; do not claim it can read literally no path.
- Do not copy/import `system.sb` wholesale and call it minimal. On the observed OS, that profile includes `/dev/fd` access, broad system reads and preference/logging-related IPC. Its own header labels it a changeable private interface. D3 needs a reviewed effective permission set; it does not inherit D0's allowances automatically.
- Add only proven necessary readonly sealed-OS resources within this envelope. Broad user-controlled filesystem paths, plugin lookup, permissive IPC brokers or pre-sandbox decoder initialization require another R3 decision, not an implementation workaround. Where ImageIO cannot operate within the envelope, disable that capability.
- System framework code, transitive initialization and permitted OS resources remain part of the post-sandbox TCB. Profile/build/OS changes invalidate qualification. Do not claim protection from native kernel bugs or hard instantaneous RSS containment.

### READY and first original-byte read

The fixed FD map has no parent-to-renderer command channel. **Approve a one-way READY notification, not a two-way GO handshake.** FD0 remains `/dev/null`; do not silently add an FD or reuse binary/liveness as a command path.

Control framing is explicitly amended to: exactly the fixed ASCII line `PS_RENDER_READY_V1\n`, followed by exactly one bounded terminal JSON object after processing. Total FD1 bytes, including READY, remain <=4 KiB. A second READY, extra JSON, bad ordering, unknown fields or oversized prelude fails closed. This is a protocol definition in a design document, not implemented code.

Each launch: apply sandbox successfully, verify active status and fixed no-exec/no-fork policy queries, validate FD modes/types and limits, emit READY, then load renderer/enter its FD provider. **First original-byte read occurs only in the renderer after READY emission and successful activation.** Parent recognizes READY before accepting a result, but child need not wait for parent receipt/ACK. Parent acknowledgement is not the security barrier; the trusted bootstrap's control flow and delayed module loading are.

READY is not cryptographic attestation. It is meaningful only with the verified bootstrap, qualified profile and trusted pre-parser control flow. FD3 is already inherited, so there is no claim that the kernel independently prevents malicious bootstrap code reading early. A malicious/replaced bootstrap is outside the upload threat model and must be prevented by the trusted-build boundary.

Control and binary pipes have no shared receiver-event ordering. A binary callback observed before the READY callback is not by itself proof of an early child write. The supervisor must parse READY before relaying/accepting binary output, processing available control promptly and retaining any pending binary only within the existing <=256 KiB queue and unchanged deadline. Missing/invalid READY rejects and discards pending bytes. Test true early-write/control-flow violations with instrumentation; also test legitimate reversed receiver scheduling to avoid false failures or backpressure deadlock. No additional GO channel is introduced.

No production startup probe may read FD3 bytes before READY or append sentinel bytes to FD4. Actual read/write and destructive denial probes use separate synthetic qualification processes. On each real launch, `F_GETFL`/`fstat` validate access/type without attempting to truncate/chmod/write an original. Diagnostics which could damage a file if isolation is broken must never operate on real media.

## Post-Sandbox Capabilities

| Capability                             | Required result                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| FD3 read/pread/seek/fstat              | Allowed for the one verified original, with existing bounds and identity handoff.                           |
| FD4 binary write                       | Allowed only into the dedicated bounded pipe; no path sink.                                                 |
| FD1/FD2                                | Fixed bounded control / bounded discarded stderr.                                                           |
| Original write/pwrite/truncate/chmod   | Denied; readonly access alone is insufficient proof for chmod, so synthetic sandbox probe required.         |
| Original reopen/unlink/rename/hardlink | Denied. No input pathname exposed by the API; kernel path discoverability does not imply reopen permission. |
| Other object, secret, root browse      | Denied.                                                                                                     |
| Arbitrary filesystem read/write        | Denied; only documented immutable runtime/module reads allowed.                                             |
| IPv4/IPv6/UDP/DNS/network IPC          | Denied.                                                                                                     |
| fork, execve, self-exec, posix_spawn   | Denied after activation, independently tested.                                                              |

A compromised decoder still can corrupt its own memory, emit malicious output and consume its bounded resources. The trusted supervisor/parent validates all outputs and limits; sandbox success is not an input-validity or result-authenticity guarantee. Renderer cannot obtain DB handles or mutate media/jobs.

## FD Hardening

- Use **`posix_spawn`, not `posix_spawnp`**, with fixed executable and file actions, `POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK`.
- Set the new child's process group to its own PID using the documented pgroup=0 behavior; use a known signal mask/default set so inherited ignored/blocked termination signals do not defeat supervision. Validate every attribute/action/launch return code.
- Explicit map: 0 readonly `/dev/null`; 1 control-pipe write; 2 stderr-pipe write; 3 verified regular readonly original; 4 binary-pipe write. No root/parent directory, DB socket, lock FD or liveness endpoint in renderer.
- Supervisor owns FD5 parent-liveness; its private polling endpoints remain internal. Child has FD5 and every other unlisted inherited descriptor closed. No input API accepts FD numbers.
- Intermediate pipes/duplicates are CLOEXEC. Build collision-safe actions using temporary source duplicates distinct from 0–4, explicitly close those source duplicates after mapping. Same-number inheritance must be explicit; do not assume a no-op dup2 clears CLOEXEC. Close parent duplicates and unused pipe ends on all success/error paths.
- The SDK documents that close-default covers all inherited descriptors, not a numeric scan bound. Therefore it covers non-CLOEXEC FD1500+; implementation must verify this with real descriptors. Lowering `RLIMIT_NOFILE` is not proof that already-open high descriptors were closed.
- Qualification distinguishes **inherited** descriptors from readonly runtime descriptors opened after activation. No unnoticed source duplicate is allowed. Limit open FD budget to the approved 64 after mapping; CPU/core limits use fixed constants. Constructor-created non-FD resources are why delayed framework loading also matters.

## Process Lifecycle

- One supervisor event loop owns wait/reap and signaling. States: RUNNING -> TERM_SENT -> KILL_SENT -> REAPED, with normal RUNNING -> REAPED. Keep pipe-drained status separate from reaped status.
- Monotonic wall deadline starts at spawn, includes bootstrap/load/render/drain and cannot be reset by READY or child output. Render <=30s; validator <=10s. Add a startup READY deadline <=5s within the total deadline; this is fail-closed startup qualification, not extra render time.
- Failure, parent-liveness EOF, broken binary sink, protocol/byte/resource overflow: signal owned group SIGTERM, wait <=1s grace, SIGKILL if still unreaped, then `waitpid` exact child. Also retain direct-PID termination while ownership is unreaped so a changed process group cannot leave the only child alive; do not rely solely on group membership after compromise.
- Once `waitpid` confirms reap, no PID/PGID signal ever again. ECHILD relinquishes signal authority and is reported as a lifecycle failure, not success. Timer/cancellation callbacks cannot bypass the state owner. Retry EINTR appropriately.
- Concurrently drain bounded control/stderr/binary while checking liveness/deadline. Child exit is not channel EOF. Success requires reap, successful status, all EOF and complete valid output; failure Promise settles only after cleanup/reap. No partial result escapes.
- Child cannot retain the liveness writer. Parent death must leave the supervisor alive long enough to terminate/reap the renderer. Supervisor SIGKILL is not a guaranteed whole-tree cleanup mechanism on macOS; retain the original documented Production limitation and test owner-parent death separately.
- Full high-FD closure and no post-reap signals remain mandatory D3a deliverables, not deferred P2s.

## Capability Gate

**RUNTIME_CAPABILITY_VALIDATED: NO in this review.** All positive enablement below is a future implementation test obligation.

1. Build qualification binds bootstrap, renderer module, embedded policy, loader/dependency closure, libwebp/build configuration, protocol/recipes and OS build fingerprints. It runs the full isolation/failure matrix. No forged/manually set `enabled=true` evidence.
2. Each worker/backend startup validates matching fingerprints and runs live synthetic denial/FD probes in its actual launch context. Missing/stale evidence or any denial drift disables renderer. Heavy timeout/flood qualification may be reused only for the exact tested build, while live activation/denial checks still run at startup.
3. Every production render applies the final sandbox anew and performs non-destructive startup checks/READY. It does not fork/exec or destructively probe the actual original as a self-test. Potentially process-killing denial probes run in separate one-shot synthetic processes, never inside the production render attempt.

Required qualification probes:

- First sandbox activation succeeds; simulated/real activation failure and pre-existing sandbox reject before READY/media access. Active-status query plus real denials, not success return alone.
- Actual FD3 read/pread/seek and FD4 write; pipe type/access map; readonly original before/after identity and content unchanged.
- Original write/pwrite/ftruncate/fchmod, pathname reopen/unlink/rename/link and output path creation rejected using sacrificial synthetic originals and known existing paths.
- Existing readable second object and synthetic secret cannot be read; root cannot be enumerated; `/dev/fd` reopen and library/plugin path substitution fail.
- IPv4/IPv6 TCP, UDP and DNS attempts denied. Use controlled available endpoints/baselines and sandbox permission evidence; ECONNREFUSED, ENOENT or DNS infrastructure failure alone do not prove isolation.
- fork, execve of an existing executable, execve of the fixed bootstrap itself, and independent posix_spawn attempts denied. Compare `posix_spawn`'s returned error value, not stale errno. Test processes use fixed diagnostics unavailable in production dispatch.
- Do not reproduce D0's general `attempt marker + any nonzero exit => denied` rule. Require a permission error or independently verified platform sandbox-kill evidence for the intended operation, with executable/operation preconditions proven. Arbitrary abort, bad image, missing path or loader failure fails qualification.
- Parent deliberately holds non-CLOEXEC file/secret/lock/socket descriptors at 1500+; none survive into bootstrap, including intermediate mapping sources. Test through the real native launcher, not only Node/libuv's own FD filtering.
- Missing/duplicate/malformed READY, confirmed pre-READY protocol violations, invalid terminal JSON, length mismatch, control/stderr/binary flood, partial output, child nonzero exit and slow receiver all fail closed. Cross-pipe callback order alone is not such a violation. Parent simultaneously drains channels and does not return partial bytes.
- Successful exit, timeout, ignore-TERM, crash, owner death, broken sink and cancellation cleanly reap/close; event trace proves no signaling after reap and no residual renderer PID/FD.

After a renderer is enabled by these gates, the separate format gate still qualifies JPEG/PNG/WebP/GIF per recipe. This startup review enables no image format. HEIC and RAW/DNG remain disabled.

## D0/D1 Compatibility

- **Metadata parser changed: NO. D0 startup architecture changed: NO.** D0/D1 continue their current sandbox-exec startup and metadata contract.
- Use a distinct renderer bootstrap/policy/protocol and capability result. Do not reuse metadata's enabled flag, profile, test-mode registry or claim that the new strict no-exec property retrospectively applies to D0.
- The already-approved close-default and PGID lifecycle hardening may be applied to the old supervisor (or a small common launcher implementation) without migrating metadata to self-sandbox. Its FD4 remains liveness; only the renderer supervisor uses FD4 binary/FD5 liveness. Make the maps explicit and test both.
- D0/D1 full targeted regressions and D2 persistence regressions remain required for shared-launcher edits. D2 and earlier DB/transaction semantics remain untouched.

## Security Analysis

| Question                                         | Decision                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted unsandboxed bootstrap window acceptable? | YES within this DEV threat model: fixed tiny trusted code/loader only, no untrusted-byte access, no configurable policy/module/argv, bounded startup, fail closed. It is not a guarantee against malicious local binary replacement.           |
| Decoder exploit before activation?               | No authorized path reaches decoder code or original-byte provider before activation/READY. Establish through dependency/constructor audit, delayed loading and instrumented control-flow tests; do not claim a READY string alone proves this. |
| Loader/Objective-C risk acceptable?              | YES only with minimal bootstrap dependency closure, clean env, fixed trusted installation and framework/module loading after sandbox. Direct eager framework linkage in bootstrap is rejected.                                                 |
| Same-child self-reexec acceptable?               | NO under the strict contract; final profile contains no renderer exec exception.                                                                                                                                                               |
| API deprecation blocks all work?                 | NO. It makes runtime/OS fingerprint qualification and DEV-only scope mandatory. API availability/success still unproven until the harness runs.                                                                                                |
| Tiny C bootstrap needed?                         | YES for an auditable pre-parser TCB and to keep framework initialization under policy.                                                                                                                                                         |
| Malicious renderer can request fallback?         | NO; any missing capability/error disables the attempt/backend as appropriate. No alternate unconfined loader/profile.                                                                                                                          |

P0/P1 **unresolved design** blockers are zero after adopting this amendment. Runtime qualification is still an implementation gate: activation/denial failures would block D3a, not be reclassified as non-blocking warnings. Production isolation/resource containment remains unapproved.

## Tests

| Case                             | Required assertion/evidence                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Activation failure            | No READY, no module load, zero FD3 bytes read, no result; sanitized failure, reap/close.                                                                                                                                                                                                                                     |
| B. Missing READY                 | Bounded startup timeout, discard all output, terminate/reap.                                                                                                                                                                                                                                                                 |
| C. Early read                    | Test-only wrapper/instrumentation on original provider read/pread/mmap fails before activation+READY; forced activation failure never reaches provider. Include an early-read fault to show the test detects it. Dependency/initializer inspection is required too; wrappers cannot prove absence of all arbitrary syscalls. |
| D–F. execve / posix_spawn / fork | Independent live permission-denial evidence, including self-exec; no new descendant/image. Separate probe processes permit sandbox-kill behavior.                                                                                                                                                                            |
| G. High FD                       | Real FD1500+ non-CLOEXEC descriptors absent after spawn and mapping; no source alias leaked.                                                                                                                                                                                                                                 |
| H. Original writes               | Synthetic destructive attempts denied; bytes/SHA/inode/mode/mtime preserved even on failure.                                                                                                                                                                                                                                 |
| I. Binary output                 | FD4 writable with precise bounded receipt; no control/data mixing or probe prefix in render bytes.                                                                                                                                                                                                                           |
| J–K. Path/network                | Existing baseline-accessible targets denied, including read/reopen/create, second object/secret, IPv4/IPv6/UDP/DNS.                                                                                                                                                                                                          |
| L–N. Timeout/crash/parent death  | Exact owned child reaped; ignore-TERM escalates; no lingering FD/process; nonzero exit never accepted.                                                                                                                                                                                                                       |
| O. Post-reap signal              | Test lifecycle instrumentation records signal and wait events; no signal event after REAPED/ECHILD on success, timeout or cancellation.                                                                                                                                                                                      |
| P. Bad handshake                 | Invalid/duplicate READY, terminal-before-READY, unknown keys and oversized framing rejected; no binary accepted without valid READY. Legitimate cross-pipe callback reordering is handled within the bounded queue.                                                                                                          |
| Loader boundary                  | Bootstrap dependency/initializer closure excludes renderer/frameworks; poisoned parent env and cwd cannot load a sentinel dylib/config. Renderer module/OS mismatch disables capability.                                                                                                                                     |
| Runtime resources                | Apple dependency reads work inside the final policy; user plugin/CF preference/secret paths remain inaccessible. No unsandboxed pre-initialization rescue.                                                                                                                                                                   |
| Regression                       | OriginalReader preservation, D0 isolation and D1 metadata, D2 persistence; no new schema/DB effects.                                                                                                                                                                                                                         |

No renderer/harness code, tests, synthetic media, database operation, parser installation or runtime activation experiment was performed in this design-only turn. Read-only SDK/source inspection and documentation format validation are not runtime capability results.

## Implementation Plan

1. **D3a-0: startup capability harness first.** Tiny C bootstrap, embedded final profile, fixed delayed module entry (initially a fixed synthetic harness), clean launch env, READY, activation/fork/exec/self-exec/posix_spawn/path/network tests. Capture actual custom-profile API and loader viability before building the encoder. Failure stops here for R3 review.
2. **D3a-1: FD and process lifecycle gate.** Close-default fixed maps, high-FD tests, owner liveness, PGID/direct-PID lifecycle, timeout/crash, no post-reap signaling. Apply only the approved mechanical launcher hardening to D0 and run D0/D1/D2 regressions.
3. **D3a-2: renderer/binary capability.** Add the fixed ImageIO/CoreGraphics module with pinned static libwebp, bounded FD4/control receiver, resource preflight, isolated output validation, per-format/recipe/orientation/private-metadata-stripping probes and original-preservation snapshots. Use bounded synthetic sinks only. Complete the originally requested D3a tests/report, then stop.

Expected files/components during implementation, **not changed by this review**:

- `packages/storage/native/image_renderer_bootstrap.c`: tiny pre-parser entry and one-time activation; no media decoder dependencies at startup.
- `packages/storage/native/image-renderer.sb` plus a generated build-time embedding: reviewed fixed effective policy, not runtime profile input.
- `packages/storage/native/image_renderer_supervisor.c`: renderer FD0–5 map, bounded relay/READY parser and lifecycle ownership.
- `packages/media/native/image_renderer_module.m`: fixed same-process renderer entry, frameworks initialized only after activation; private static libwebp.
- `packages/storage/native/original_probe_supervisor.c`: limited shared FD/PGID hardening, preserving metadata launch/profile semantics.
- `packages/storage/scripts/build-native.mjs` and local dependency/build manifest: fixed build outputs, no runtime download or arbitrary module lookup; loader/fingerprint evidence.
- `packages/storage/src/index.ts` or a narrow internal adapter: consume opaque verified handle into fixed renderer launch; no public FD/path/env options.
- `packages/media/src`: capability-gated renderer orchestration, fixed recipes and validated bounded results, separate from metadata capability.
- Targeted native/media/storage tests and the D3a capability report: actual gate evidence, failure cleanup and unchanged-original proof.

No DerivedStore, capacity reservation, DB worker completion, filesystem derivative publish, video or schema/migration work is authorized by this amendment.

## Decision

```text
P0_DESIGN_BLOCKERS: 0
P1_DESIGN_BLOCKERS: 0
DESIGN_CHANGE_REQUIRED: YES
DATABASE_MIGRATION_REQUIRED: NO
NESTED_SANDBOX_STRATEGY_REJECTED: YES
SELF_SANDBOX_RENDERER_APPROVED: YES
TINY_BOOTSTRAP_REQUIRED: YES
SINGLE_SANDBOX_EXEC_PROFILE_ACCEPTABLE: NO
STRICT_POST_START_EXEC_DENIAL_VERIFIABLE: YES
HIGH_FD_HARDENING_REQUIRED: YES
PGID_HARDENING_REQUIRED: YES
RUNTIME_CAPABILITY_VALIDATED: NO
READY_FOR_PHASE_4D3A_IMPLEMENTATION: YES
```

`VERIFIABLE: YES` means the selected mechanism has a concrete, independent qualification procedure; it does not mean current runtime denial has passed. `READY: YES` authorizes implementation beginning with D3a-0, not enabling renderer, starting 4D3b/c, or claiming Phase 4 complete.
