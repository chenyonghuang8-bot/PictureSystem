# Phase 4D3a-1 — FD isolation and process lifecycle hardening

Scope: synthetic renderer startup and the shared exact-child lifecycle used by the existing D0 original-probe supervisor. This is not a real image renderer, binary output protocol, DerivedStore, image job, or Production isolation approval. No schema or migration changed.

## Fixed renderer descriptor map

The build-pinned renderer supervisor uses `posix_spawn` with `POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK`. File actions explicitly open FD0 as read-only `/dev/null` and map the bounded control pipe to FD1, bounded event/stderr pipe to FD2, and a verified read-only original duplicate to FD3. The source duplicate is closed by a file action after `dup2` and by the supervisor immediately after spawn. The supervisor closes child-side control/stderr pipe writers immediately after spawn. Supervisor FD4 remains owner-liveness only and is absent from the bootstrap/module. The future binary FD4 is **not** present in this slice. No caller controls the descriptor numbers, executable, profile, module, arguments or environment.

The test-only native parent deliberately passes non-CLOEXEC synthetic file FD1500, advisory-locked file FD1601 and socket FD1703 to the supervisor. A separate fixed supervisor binary confirms their existence before spawning the bootstrap. The sandboxed module then requires `fcntl(F_GETFD)`, `fstat` and `read` to return `EBADF` for all three, and checks the low unapproved range FD4–63. A second Node launcher passes sparse FD57/1500/1601. These are real inherited descriptors, not merely sandbox-denied opens. Highest tested FD: **1703**. This qualifies the observed macOS DEV close-default behavior for the fixed renderer child; it does not assert that arbitrary runtime-opened system descriptors are impossible.

## Exact-child lifecycle

`process_lifecycle.h` is shared by the renderer supervisor and D0 supervisor. Its states are `RUNNING → TERM_SENT → KILL_SENT → REAPED`, with `ANOMALY` as a fail-closed terminal branch. The owner tracks exact child PID and original PGID. `waitpid` always names that child, retries `EINTR`, and treats unexpected `ECHILD` as an anomaly. On `REAPED` or `ANOMALY`, it clears PID and PGID signal authority. A test-only trace records `WAITPID_REAPED`, `WAITPID_ANOMALY` and signal attempts. No signal follows a reap in normal, crash, timeout or ignore-TERM tests; the ECHILD harness proves signal authority is dropped.

On timeout/liveness failure the supervisor checks for a prior reap, sends `SIGTERM` to the still-owned group when the exact child still belongs to it, and to the exact still-unreaped PID as a fallback. It polls during a bounded **250 ms** grace period (below the approved 1 s maximum); if still running, it sends `SIGKILL` under the same ownership rule and performs a blocking exact-child reap. A fixed test seam suppresses group delivery to exercise the direct-PID fallback. Because the spawned child is its own group leader and the sandbox denies fork/exec, the test does not claim to have manufactured an actual hostile group escape. The group guard avoids signaling a known stale PGID; no post-reap group cleanup is used.

The owner-liveness pipe remains supervisor-only. Closing it causes a blocked bootstrap to be terminated and reaped. Normal success drains bounded control/stderr to EOF after child exit. Two concurrent synthetic supervisors demonstrate that one timeout does not kill the other's child. 100 consecutive synthetic startup runs show no growth beyond two transient `/dev/fd` entries in the test parent. Crash, timeout, owner-disconnect and exact-child tests show no observed zombie/process leak. Supervisor **itself** killed with uncatchable `SIGKILL` remains the previously documented Production limitation; this slice does not claim whole-tree recovery from that event.

## Compatibility and limits

D3a-0 one-time sandbox activation, READY-before-module and sandbox-before-first-FD3-read remain unchanged. Original bytes, SHA-256, inode, mode and mtime remain unchanged in synthetic tests. Fork, execve, self-exec, posix_spawn, path, secret, root, IPv4/IPv6/UDP and DNS denial are covered by the existing module regression. D0 now uses the exact-child lifecycle and no longer signals its group after waitpid/reap. D0's historical `fork` launcher and `close(4..1023)` FD policy were **not** converted to renderer close-default semantics here; renderer high-FD qualification must not be read as D0 high-FD qualification. D1 metadata parser and D2 persistence regressions remain required.

No ImageIO, CoreGraphics renderer, libwebp, production binary FD4, thumbnails, previews, derived filesystem publish, or DB writes were added. D3a-2 and later phases remain unstarted.

## Targeted validation

- Native build: PASS; final synthetic renderer startup/lifecycle suite: **24/24 PASS** (includes high-FD, ECHILD, post-reap trace, 100-run FD leak, parent-liveness and concurrent-supervisor cases).
- Combined D3a-1, D3a-0, D0/D1/D2, affected Phase 3 and Phase 4A/B/C, and migration-readiness regressions: **13 files, 161/161 PASS** against synthetic fixtures and DEV MySQL; no skipped tests reported.
- Typecheck: PASS; lint: PASS; changed-file Prettier check: PASS; `git diff --check`: PASS.
- Repository-wide `pnpm format:check` remains FAIL on unchanged `packages/db/drizzle/meta/_journal.json` and `packages/db/drizzle/meta/0003_snapshot.json`. Those migration artifacts were not modified in this slice. This is an existing non-D3a-1 formatting issue, not a claim of a full format gate pass.
