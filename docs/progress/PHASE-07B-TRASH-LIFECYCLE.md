# Phase 7B — Trash / Restore and lifecycle integration

Status: **PHASE 7B COMPLETE / CHECKPOINT: this commit** (2026-10-02). Implementation, fresh final gates and the one-pass independent review passed. The user authorized this checkpoint. Phase 7C is ready to begin but has not started; Phase 7 remains incomplete and is not production ready.

## Approved targeted R3 resolution

The user supplied the targeted handoff ownership resolution and authorized resuming the original complete Phase 7B scope. The reproduced settlement P1 below is historical, not an unresolved current finding. No schema or authorization model redesign was required.

Node/libuv is the sole reap owner for metadata/renderer supervisors. Each native supervisor registers, transfers to, and exact-reaps its own actual consumer. The existing verifier outer native launcher retains sole ownership of its supervisor. No Node settlement function waits for a Node-owned supervisor. Unexpected ECHILD remains PS_ANOMALY and cannot establish SETTLED.

## Implemented slice

- Strict authenticated Trash/list/Restore routes, decimal uint64 identities, canonical operation UUIDs, bounded keyset paging and minimal whitelisted DTOs. No Trash UI or permanent deletion route.
- Family-first current session/member and canonical album/grant/media locks. Trash discovery requires the selected visible live placement. Trash and Restore require effective delete access to every live placement, with no SUPER_ADMIN bypass. Deleted placements do not block. Permission filtering occurs before LIMIT.
- Short committed database preflight resolves trusted Original K before waiting for L-X. The transition repeats authorization after the OS wait, checks current storage identity and lifecycle revision, uses server time with exactly 30 days, and writes audit in the same transaction. Exact same-operation replay has no deadline/revision mutation; an operation from an earlier lifecycle state conflicts. Unknown COMMIT is never replayed automatically.
- Central ACTIVE predicate (trashed_at NULL and purge_intent_id NULL) in ordinary timeline/grid/detail, relation mutations, original/preview and generic/public derived reads, public share pages and worker admission. Relations, source upload, generation, recipe and existing derived identities stay dormant and unchanged.
- Original native read occupancy ends after native cleanup and before the final owned chunk/network lifetime ends. Original stays chunked at no more than 256 KiB, with one native read in flight and no prefetch or whole-file Buffer. Its limiter independently retains ownership until native/storage and transport settlement. Shared derived reader holds R-S before CapacityGate and releases it before the second current authorization and Buffer response. Current family/session/ACL/storage/asset/generation/recipe/lifecycle identities are rechecked. Public derived additionally repeats current share hash, expiry, revocation, album and placement checks.
- Finalize acquires L-S only after the trusted hash, retains it across bounded filesystem/DB finalization and uncertain outcome handling, and reuses TRASHED canonical media without Restore, new placement or source upload replacement. PURGING storage cannot acquire a new live reference. Synthetic RETIRED receipts have safe authenticated status and cannot resume/finalize/reconstruct media; retirement execution is deferred.
- Runtime worker fences carry lifecycle revision. Candidate lookup filters ACTIVE before its bounded window, then family/media/job locks and server time validate the actual claim. Old heartbeat/persist/publish/READY attempts are rejected across Trash/Restore ABA; administrative expired lease recovery remains available while trashed.
- Renderer input is R-S only; L-S then R-S precede write/admission/CapacityGate/seal/verifier/publish/READY. Recovery cleanup requires a trusted L-S adapter and repeats ACTIVE/current revision and Original K after acquiring it; without the adapter it only retains/reports. Recovery does not promote sealed candidates to READY.

## Registered handoff implementation and real evidence

Internal version-3 ledger stages are PREPARED, SUPERVISOR_REGISTERED, ARMED and SETTLED, with coordinator/supervisor/consumer boot, PID and process-start identities. Root/marker/K/input type and opaque sealed-derived binding are fixed in the exact record. Incompatible/corrupt/partial records fail R-X admission closed.

Production metadata and both real renderer binaries reject inherited-media launch. The old fork fixture is compiled only in the separately named metadata qualification binary, and synthetic renderer fixtures are test-only. Supervisors launch with a control socket only; no media/root/L/R descriptor. Consumer bootstrap is spawned with no media, registered durably before ARMED, then receives the same verified open file description through two SCM_RIGHTS transfers. Source release closes the coordinator's transferable copies before acknowledgement and downstream transfer. Bootstrap closes its transfer channel before sandbox/startup and media reads. A narrow exact-record FD is confined to the supervisor; the consumer cannot settle or spawn another holder.

Native supervisor settlement requires the saved PS_REAPED state, closed copies/channels and consumed source authority, then durable sync. Node verifies the durable record after libuv close. R-X recovery does not waitpid or signal; it conservatively checks every recorded role. Sealed verifier handoff and the parent's own sealed capability have separate protected lifetimes.

Real tests cover two-stage descriptor transfer, pre-ARMED transfer rejection, duplicate transfer rejection, wrong handoff/K/message role, extra/truncated descriptors, source-release acknowledgement withholding, exact reap with settlement sync held, one saved WAITPID_REAPED trace, supervisor crash with consumer live, Node crash and Node-plus-supervisor crash, and recovery only after exact identities disappear. Existing exact identity/reused PID and corrupt record checks remain. The test bootstrap checks its inherited descriptor set before sandbox-exec; parser startup closes sandbox-exec low descriptors and checks high descriptors before reading synthetic media. Real metadata, renderer and sealed verifier composition tests exercise production orchestration.

## Deterministic lifecycle evidence

The single new Phase 7B integration suite covers current discovery/all-placement ACL, no family role bypass, exact server deadline, revision/operation CAS and overflow, same-transaction audit rollback, dormant relation snapshots, hidden/deleted permission-filtered pagination, strict HTTP contracts, Original R versus independent Trash L, real finalize L and TRASHED/RESTORED/PURGING dedupe, RETIRED fail-closed handling, private/public read-first Trash races, Original/Preview ABA and active queue progress behind Trash.

Existing Phase 6D race harnesses add Trash-first and recheck-first HTTP competitors using explicit family-lock/connection dispatch barriers, not sleeps or pending-promise assertions. Existing public tests add Trash page/derived filtering, Restore and revoked-share retention. Existing metadata and derivative suites add actual persist and two-final READY ABA. Actual worker tests prove L-X is unavailable in markPublishing and available after CPU render; Trash winning before write produces no derived reservation/publication.

## Final validation and cleanup

All final gates were run after the last functional/test change (registered-only production native entrypoints and their negative test). Intermediate runs are not substituted for the following evidence. Test skips: **0**.

| Gate | Final result |
| --- | --- |
| `pnpm lint` | PASS |
| `pnpm format:check` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS: 130 files, 1,108 tests (100 unit/API files, 782 tests; 30 integration files, 326 tests) |
| `pnpm test:integration` | PASS: 30 files, 326 tests |
| `pnpm build` | PASS, including native storage and API/worker/Web builds |
| `pnpm test:e2e` | PASS: 5 tests |
| `pnpm test:e2e:web` | PASS: 15 tests, including the existing authenticated HTTPS 64 MiB Original, Preview, abort, pause/resume, privacy and canonical preservation suite |
| Phase 7A foundation/readiness | PASS: 20 live DEV tests, eight applied migrations |
| `git diff --check` | PASS |

The final native targeted set passed 4 files / 70 tests: handoff, metadata, image renderer producer and hardened renderer startup. The single new Phase 7B MySQL suite passed all 19 cases in the final full and integration gates. Native package resolution was additionally checked from the built API directory against the actual addon ABI, and the bundle retains fixed package resolution.

Every current-run fixture family/root is synthetic. The initial public-case cleanup failure left one owned fixture, which was recovered using its exact generated family identity, fixed synthetic digest, source receipt and members; its signature is now absent. Five roots from the descriptor-probe timeout were individually verified against their synthetic Original and creation identities, admitted through native L-X/R-X only after all recorded roles were absent, then removed. No unrelated/historical fixtures were deleted. Final Phase 7B family signature count and owned lifecycle/registered root count are zero. No native consumer/supervisor, test server or listener remains on 4000, 4400 or 3443. HTTPS teardown completed. Next's generated `next-env.d.ts` was restored to its baseline content and has no diff.

All 17 SQL/snapshot/journal files match the approved frozen hashes; Drizzle schema, migrations and database schema have no diff. 0007 remains `05a7a3a66c3902de5ddf99e5b77a13fdc5614a7b9a5a3508404c37b657fd4fdd`. No 0008 exists. Pre-checkpoint HEAD and origin/main were `18633539ed57a84151593df1b79d7826f46b2a2f`. Pre-existing untracked Web AGENTS/CLAUDE files were untouched.

New test files: one integration suite (`tests/integration/phase7b-trash-lifecycle.test.ts`) and one native synthetic transport fault harness (`packages/storage/native/registered_protocol_harness.c`). Other tests extend existing suites; no second download or HTTPS framework was added. The native bootstrap is production implementation, not a new test framework.

Current-scope unresolved findings after the independent review: P0 0, P1 0, blocking P2 0, non-blocking P2 0, P3 0. Existing Phase 4 production/deployment qualification deferrals are not reclassified or closed by this task.

## Final independent review and checkpoint

The one-pass independent High review passed with `NO_NEW_FINDINGS` and no remediation required. It inspected the exact 69-file scope, production ownership/registration/settlement, lifecycle authorization and ACTIVE coverage, Original/Preview/Derived reads, worker ABA, upload/dedupe/RETIRED handling, audit and scope preservation. Scope hashes were unchanged throughout review. The review reran handoff, metadata, renderer producer/startup and Phase 7B lifecycle tests: **5 files / 89 tests / 0 skips, PASS**.

The initial restricted-environment rerun could not perform the required native process/sandbox/socket operations and is not accepted as passing evidence. The rerun with local process and DEV access passed. Seven precisely owned synthetic roots from the failed attempt were cleaned after identity/content checks and native L-X/R-X admission. DEV fixture signatures, native/test directories, child processes and test ports were clear afterward.

Checkpoint inspection confirmed no functional/test change after the accepted gates, all frozen migration hashes, and read-only DEV readiness with eight migrations. Only checkpoint documentation changed. This commit uses the message `Complete Phase 7B trash lifecycle`; no new phase tag or broad PROJECT-HANDOFF rewrite is part of it. Phase 7C physical deletion and Phase 7D UI remain unimplemented.

```text
PHASE_07B_IMPLEMENTATION_PASS: YES
PHASE_07B_INDEPENDENT_REVIEW_PASS: YES
REMEDIATION_REQUIRED: NO
PHASE_07B_CHECKPOINT: this commit
PHASE_07B_COMPLETE: YES
READY_FOR_PHASE_07C: YES
PHASE_07C_IMPLEMENTATION_STARTED: NO
PHASE_7_COMPLETE: NO
READY_FOR_PHASE_8: NO
PRODUCTION_READY: NO
```

The following implementation flags record the accepted result before independent review and checkpoint; their Git/readiness statuses apply to that earlier point.

```text
HANDOFF_R3_IMPLEMENTED: YES
SINGLE_REAP_OWNER_ENFORCED: YES
NODE_OWNS_METADATA_RENDERER_SUPERVISOR_REAP: YES
SUPERVISOR_OWNS_CONSUMER_REAP: YES
SECOND_WAITPID_OWNER_FOUND: NO
SUPERVISOR_REGISTERED_BEFORE_FD: YES
CONSUMER_REGISTERED_BEFORE_FD: YES
FORK_INHERITANCE_WINDOW_FOUND: NO
SOURCE_RELEASED_PROTOCOL: YES
SUPERVISOR_SETTLEMENT: YES
RECOVERY_WAITPID_USED: NO
RECOVERY_SIGNAL_USED: NO
ECHILD_GLOBALLY_MEANS_SETTLED: NO
NODE_CRASH_RX_BLOCKED: YES
SUPERVISOR_CRASH_CHILD_LIVE_RX_BLOCKED: YES
NODE_SUPERVISOR_CRASH_CHILD_LIVE_RX_BLOCKED: YES
REAL_SCM_RIGHTS_PASS: YES
REAL_WAITPID_PASS: YES
REAL_CRASH_MATRIX_PASS: YES
METADATA_PRODUCTION_COMPOSITION_PASS: YES
RENDERER_PRODUCTION_COMPOSITION_PASS: YES
VERIFIER_PRODUCTION_COMPOSITION_PASS: YES
DATABASE_MIGRATION_REQUIRED: NO
DESIGN_CHANGE_REQUIRED: NO
SCHEMA_CHANGED: NO
0008_PRESENT: NO
LAST_FUNCTIONAL_OR_TEST_CHANGE_PRECEDES_FINAL_GATES: YES
FULL_GATE_EVIDENCE_STALE: NO
DB_CURRENT_RUN_RESIDUE_ZERO: YES
FILESYSTEM_CURRENT_RUN_RESIDUE_ZERO: YES
SOCKET_PROCESS_RESIDUE_ZERO: YES
PHASE_07B_IMPLEMENTATION_PASS: YES
READY_FOR_PHASE_07B_INDEPENDENT_REVIEW: YES
READY_FOR_PHASE_07B_CHECKPOINT: NO
READY_FOR_PHASE_07C: NO
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
STAGE_PERFORMED: NO
COMMIT_PERFORMED: NO
PUSH_PERFORMED: NO
```

No original or canonical derived physical deletion, purge runner, receipt retirement execution, Trash UI, Git checkpoint or phase advancement was implemented.

---

The following is the unchanged substance of the initial blocked attempt. Its status and pending-work statements describe that earlier attempt only.

# Historical blocked attempt — preserved evidence

Status: **NOT IMPLEMENTED / ARCHITECTURE BLOCKER**. Phase 7 remains incomplete; no checkpoint or Phase 7C work is authorized by this result.

## Baseline

HEAD and origin/main: `18633539ed57a84151593df1b79d7826f46b2a2f`.
Frozen 0007 SHA-256: `05a7a3a66c3902de5ddf99e5b77a13fdc5614a7b9a5a3508404c37b657fd4fdd`.
No source, test, schema, migration, snapshot or journal changes were made during this task. The pre-existing untracked `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` were left untouched.

## P1 — registered handoff settlement and production child ownership

The Phase 7A native `ps_settle_handoff` requires both the current process to be the recorded supervisor and `waitpid(receiver_pid, ..., WNOHANG)` to return that exact receiver PID (`packages/storage/native/phase7_handoff.h:321–348`).

The existing metadata composition consumes the verified Original FD and passes that same FD to a Node-spawned native supervisor (`packages/storage/src/index.ts:849–878`). That supervisor forks, sandboxes and reaps the actual parser (`packages/storage/native/original_probe_supervisor.c`). The renderer has the analogous native supervisor ownership (`packages/storage/src/image-renderer-producer.ts`, `packages/storage/native/image_renderer_supervisor.c`). These are approved same-FD and exact-child paths.

A Node-owned handoff cannot reap the supervisor's parser grandchild. Registering only the outer supervisor does not register its subsequent Original FD transfer to the actual isolated consumer. For a direct Node-spawned receiver, Node/libuv has already reaped it when the `close` event arrives, so calling the current native settlement API afterward cannot perform its required exact `waitpid` again. Moving the wait before Node's event introduces competing reapers; treating ECHILD or PID absence as successful settlement would weaken the existing evidence requirement.

This blocks a straightforward production composition of the existing 7A API. It does not establish a current media corruption or exposure: no 7B route, physical purge or new FD transfer was enabled.

## Deterministic reproduction

On 2026-10-02, a standalone synthetic probe used the current built storage addon and `StorageRoot` to:

1. Create its own temporary root and acquire R-S for a synthetic K.
2. Create a durable handoff record.
3. Spawn one direct Node child and wait for its READY output before registration.
4. Register its exact PID/start identity, then end its stdin.
5. Await that exact child's `close` event and invoke native `settleHandoff`.

Observed: `AFTER_NODE_EXACT_CHILD_CLOSE: HANDOFF_RECEIVER_UNSETTLED`.
No timing delay, pending-promise assertion or elapsed time was used as ordering evidence. This probe exercises registration/settlement, not a real Original transfer or parser execution. It accesses no DB data or real media.

The probe released its handoff/read handles, closed the root and removed its owned temporary root; its child had already closed. Probe source is `/tmp/picturesystem-phase7b-handoff-check.mjs` and may be removed independently. Existing Phase 7A transfer tests cover successful SCM_RIGHTS receipt but do not call `settleHandoff`, so their previous PASS does not cover this production settlement composition.

## Required targeted resolution

Resolve the registration, transfer and exact-child reaping owner for the actual metadata/renderer consumer before production wiring. The approved same-FD, no-path-reopen, sandbox FD allowlist, durable receiver identity, parent-death protection and native settlement guarantees must all remain intact. A single owner must provide authoritative settlement without racing Node/libuv reaping or bypassing actual-consumer registration. No replacement ownership design is selected in this implementation task.

The user task's sections 105–106 require stopping for architecture/P1 blockers. This is a targeted R3 design/ownership resolution, not permission to redesign other Phase 7 decisions. Database migration is not indicated by this finding.

## Remaining 7B scope

All requested implementation remains pending: strict Trash/list/Restore contracts and routes; selected-placement discovery plus all-live-placement delete authorization; same-transaction durable audit; SQL ACTIVE visibility; preserved dormant relations; lifecycle revision CAS/idempotency; Original/Preview/private/public derived read coordination and second authorization; upload L-S after trusted hash with dormant TRASHED dedupe and safe RETIRED handling; family/media/job lock order and runtime lifecycle revision fences; metadata/derived producer coordination and ABA prevention.

No Original or Derived deletion, receipt retirement, purge execution, Trash UI, generation changes or public capability changes were introduced. Phase 7C/7D remain deferred.

## Validation and decision

The synthetic ownership reproduction completed and cleaned up. Full Phase 7B targeted suites, races, HTTPS regressions and full gates were not run because no implementation was produced; previous Phase 7A gate evidence is not claimed as Phase 7B evidence.

Read-only live DEV `assertMigrationReadiness` passed with eight migration journal rows (0000–0007). All 17 frozen SQL/snapshot/journal files matched the previous approved SHA-256 baseline. `git diff --check` passed. No DB writes or API/Web processes were created. An initial plain Node readiness invocation failed at workspace TypeScript module resolution before connecting; rerunning through the existing `tsx` runtime completed successfully.

`PHASE_07B_IMPLEMENTATION_PASS: NO`

`READY_FOR_PHASE_07B_INDEPENDENT_REVIEW: NO`

`DESIGN_CHANGE_REQUIRED: YES` — targeted handoff ownership/settlement resolution.

`DATABASE_MIGRATION_REQUIRED: NO`

`READY_FOR_PHASE_07B_CHECKPOINT: NO`

`READY_FOR_PHASE_07C: NO`

`PHASE_7_COMPLETE: NO`

`PRODUCTION_READY: NO`

`STAGE_PERFORMED: NO`, `COMMIT_PERFORMED: NO`, `PUSH_PERFORMED: NO`.
