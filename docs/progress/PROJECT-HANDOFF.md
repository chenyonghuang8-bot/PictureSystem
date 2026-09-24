# PictureSystem — Cross-Window Project Handoff

Generated from the repository, Git history, `docs/progress/`, and the latest
recorded targeted test evidence on 2026-09-23. Documentation alignment on
2026-09-24 first recorded API serving at `559c61e`. This finalization records
validation stabilization at `38b401d`. The 2026-09-23 snapshot and the earlier
checkpoint lists are kept below and are not deleted. This handoff deliberately
contains no `.env` values, credentials, raw tokens, real-family data, real
media, or database dumps.

## Current alignment (2026-09-24, validation stabilization)

This section is the current status. Where an older section still describes the
2026-09-23 snapshot at `789a5ef`, or the API-serving checkpoint `559c61e`, that
older text is historical.

```text
branch: main
HEAD: 38b401d267013748166e5e24437152ae0b99253d
HEAD subject: Stabilize Phase 4 final validation gate
origin/main: same HEAD
migration journal: 0000, 0001, 0002, 0003, 0004
Phase 1: COMPLETE
Phase 2: COMPLETE
Phase 3: COMPLETE
Phase 4: COMPLETE through API Serving
PHASE_4_PRODUCTION_READY: NO
PHASE_4_READY_FOR_COMPLETION: NO
FINAL_VALIDATION_STABILIZED: YES
```

Completed Phase 4 capabilities:

- Media processing pipeline
- Renderer
- Verifier
- Publish
- Recovery
- Worker
- READY transaction
- album_media visibility
- Derived API serving

Final validation recorded for `38b401d`:

- lint PASS
- format PASS
- typecheck PASS
- tests PASS
- 81 files
- 620 tests

There is no `docs/progress/PHASE-04-FINAL-SUMMARY.md`.

Remaining deferred work:

- production deployment validation
- real power-loss validation
- SSD disconnect validation
- production rate limiting
- persistent audit storage
- open P2/P3: uid-mismatch and cross-device fixtures, the verifier production
  deadline versus the DEV lifecycle fixture, identical sealed temp not being
  adopted into READY, and derived serving returning `503` when storage is
  `READ_ONLY`

The Phase 4C/D2 parallel claim collision is closed for default `pnpm test` by
the integration-file isolation in `38b401d`. It is no longer an open defect.

Do not describe Phase 4 as fully production ready. Do not start Phase 5, write
the Phase 4 final summary, or add a `phase-4-complete` tag from this
finalization.

## 1. Project identity

PictureSystem is a private family-album system. Its first principles are
family-scoped authorization and immutable original media: originals are stored
once, are never rewritten, and all processing output is derivative data that
may be discarded and rebuilt.

| Item                      | Current value                                                         |
| ------------------------- | --------------------------------------------------------------------- |
| Local repository          | `/Users/toby/PictureSystem`                                           |
| Remote                    | `git@github.com:chenyonghuang8-bot/PictureSystem.git`                 |
| Branch / HEAD             | `main` / `38b401d267013748166e5e24437152ae0b99253d`                   |
| HEAD subject              | `Stabilize Phase 4 final validation gate`                             |
| Previous handoff snapshot | `559c61e8f9a3c7a7c823177a2a03da390a36fbbf`, then `789a5efa2e435e6099204fb753104c45143b7523` on 2026-09-23 |
| Package manager           | pnpm 10.34.5                                                          |
| Runtime baseline          | Node.js >= 22.13; current development used Node 22.x                  |
| API / web / mobile        | Fastify + Zod / Next.js App Router / Expo + Expo Router skeleton      |
| Persistence               | MySQL 9.7.2 LTS, Drizzle ORM, mysql2                                  |
| DEV DB                    | `family_album_dev`, non-root application user                         |
| Platform                  | macOS Apple Silicon; native storage/renderer work is macOS DEV scoped |
| Current migration journal | `0000`, `0001`, `0002`, `0003`, `0004`                                |

The root workspace has `apps/{api,web,worker,mobile}` and
`packages/{auth,config,contracts,db,i18n,media,permissions,storage,ui-tokens}`.
The authoritative project specifications are under `project-spec/`; execution
records and phase decisions are under `docs/progress/`.

## 2. Working model and review workflow

`AGENTS.md` is a primary constraint. Treat it as authoritative for routing,
DEV/PROD separation, secrets, media privacy, database rules, and allowed work.

| Participant     | Expected responsibility                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT         | Architecture planning, implementation prompts, review/result interpretation, and explicit user decisions.                                               |
| Codex           | Local source implementation, targeted tests, migrations when explicitly approved, and evidence collection.                                              |
| Cursor + Grok   | May temporarily replace Codex for implementation, review, targeted testing, and explicit Git checkpoints. They must preserve this handoff's boundaries. |
| GPT-6 Astra Low | R3 design, storage/transaction/security decisions, P0/P1 review, and final security re-review.                                                          |

Use Sol Medium for approved R3 implementation only. If implementation requires a
new schema, permission, transaction/locking, or storage-security decision, stop
and request Astra design review. Do not use automatic Bridge or browser handoff.

Before any implementation task: inspect `git status --short`, recent Git log,
the relevant current `docs/progress` documents, and only the source packages
needed for that task. Do not re-run a broad repository audit when a targeted
review is already available.

## 3. Non-negotiable security invariants

- **Originals are immutable.** No overwrite, EXIF rewrite, in-place rotation,
  rename-as-replacement, compression replacement, or derivative generation may
  alter an original.
- **Family isolation is enforced server-side.** Never use client-side UI hiding
  as authorization. Never cross-family dedupe, media lookup, job mutation, or
  capability reuse.
- **Storage uses capabilities, not paths.** Media/worker code must not invent
  a canonical path, read arbitrary paths, or pass an original pathname to a
  parser or renderer.
- **Fail closed.** Unsafe roots/markers, unknown files, broken validation,
  missing capabilities, expired leases, ambiguous commits, incomplete inventory,
  or unavailable DB coordination yield no write/permit.
- **Least authority / sandboxing.** OriginalReader validates the canonical
  object then exposes a single-use read-only capability. Fixed native children
  receive only approved inherited FDs and a constrained environment; no shell,
  arbitrary executable, output path, root browse, network, fork, or exec.
- **Epoch and generation fencing.** Worker write/complete/fail operations must
  be family/media/generation/recipe/job/worker/lease-epoch fenced. A stale
  worker must affect zero rows and must not overwrite newer work.
- **Capacity accounting is conservative.** Retained upload staging, live and
  uncleaned derived reservations, and possible late/unknown commits remain
  charged. Possible over-accounting is preferable to over-reservation.
- **Commit ambiguity is not retryable.** After COMMIT dispatch without a
  trustworthy ACK, destroy the suspect connection, obtain the global DB
  barrier on a fresh connection, perform exact-identity readback, and issue no
  permit from the old invocation.
- **Synthetic fixtures only.** Never read, copy, log, upload, or use real
  family photos/video as fixtures. DEV and production databases/media roots are
  separate. Do not expose secrets, paths, cookies, tokens, hashes, or raw EXIF.

## 4. Phase status

| Phase                  | Status                      | Main delivered capability                                                                    | Latest recorded validation                                        | Deferred / boundary                                                                                    |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Phase 1                | COMPLETE                    | Identity, Argon2id auth, opaque sessions, invitation/role boundaries, bootstrap              | Phase final gate passed; security P1 closed                       | Production HTTPS cookie proof, persistent rate limiting/audit, SUPER_ADMIN recovery are deferred       |
| Phase 2                | COMPLETE                    | Albums, ACL/permission engine, non-disclosure and revision semantics                         | Final gate and permission E2E passed                              | Selected race/test hardening deferred                                                                  |
| Phase 3                | COMPLETE                    | Safe storage roots, resumable upload, durable originals, finalize/dedupe, recovery           | Final gate: test/integration/native/crash/build/E2E recorded PASS | Production power-loss/SSD, persistent audit/rate limiting, extra native hardening remain deferred      |
| Phase 4A               | COMPLETE                    | Media, derived asset, and background-job schema/migration `0003`                             | Migration and final gate passed                                   | Do not rerun/alter `0003`                                                                              |
| Phase 4B               | COMPLETE                    | Canonical `media_item` creation from completed receipts, provenance-preserving dedupe        | Targeted MySQL sequential/concurrent tests passed                 | No worker/derived effects                                                                              |
| Phase 4C               | COMPLETE                    | Background-job repository: enqueue, claim, lease, heartbeat, reclaim, epoch fencing          | Targeted real MySQL concurrency evidence passed                   | No processing pipeline by itself                                                                       |
| Phase 4D0              | COMPLETE                    | OriginalReader and isolated probe capability design/implementation foundation                | D0 targeted isolation basis carried into later regressions        | Legacy D0 high-FD launcher P2 remains open                                                             |
| Phase 4D1              | COMPLETE                    | Isolated metadata parser on verified original FD                                             | D1/D2 and storage regressions recorded passing                    | MacOS DEV-only backend; video/complete RAW/XMP capability not enabled                                  |
| Phase 4D2              | COMPLETE                    | Fenced metadata persistence and probe-job completion                                         | Real DEV MySQL fencing/generation/cross-family coverage recorded  | No image/video derivative execution or publish                                                         |
| Phase 4D3a-0           | COMPLETE                    | Renderer startup sandbox capability                                                          | 20/20 startup/OriginalReader and combined regression recorded     | Startup capability only, no renderer qualification                                                     |
| Phase 4D3a-1           | COMPLETE                    | Renderer FD allowlist and exact-child lifecycle hardening                                    | 24/24 focused; 161/161 combined recorded                          | D0's legacy high-FD launcher P2 and process-test hardening remain                                      |
| Phase 4D3a-2a          | COMPLETE                    | Isolated bounded image-renderer **producer**                                                 | 118/118 native/storage/media/worker; related 62/62 recorded       | Candidate is unverified/unsealed/non-publishable; final renderer gate is pending                       |
| Phase 4D3b-0 admission | COMPLETE as a contract gate | Shared OS/DB capacity admission, reservation outcome classification, no-temp permit boundary | 18/18 new suite; affected serial regression 135/135               | At the 2026-09-23 snapshot, inventory, temp, seal, verifier, and publish were still ahead. Those later slices are recorded in the rows below. |
| Phase 4D3b-0 inventory through seal | COMPLETE | Known-file inventory, deterministic temp, seal | Checkpoints `21f5169`, `fcbeefe` | Verifier and publish were still separate slices |
| Phase 4D3b-0 verifier | COMPLETE | Isolated verify-output of a sealed temp | Checkpoint `c432ed8` | Production verifier deadline is 10s; the DEV lifecycle fixture uses 1s |
| Phase 4D3a-2b | COMPLETE | Renderer qualification on synthetic fixtures | Checkpoint `905c1eb` | Seatbelt is not a production isolation claim. Uid-mismatch and cross-device fixtures remain open. |
| Phase 4D3b-1 | COMPLETE | Derived publish primitive and recovery | Checkpoint `3d5324b` | An identical sealed temp beside a matching final is reported, not adopted into READY |
| Phase 4D3c-0 | COMPLETE | Worker integration through `PUBLISHING` | Checkpoint `e6c1910` | That document still says serving is closed; the API row below is later |
| Phase 4D3c-1 | COMPLETE | Fenced READY transaction for derived, media, and job state | Checkpoint `5db5b9c` | Filesystem inspection stays outside the SQL transaction |
| Phase 4D3c-2 | COMPLETE through API serving | `album_media` migration `0004` and authenticated thumbnail/preview serving | Checkpoints `b00d1d4`, `559c61e` | No gallery, placement API, or original download. `READ_ONLY` storage returns `503` instead of bytes. |

Phase 1–3 are COMPLETE. Phase 4 is COMPLETE through API serving.
`PHASE_4_PRODUCTION_READY` remains NO. Final validation at `38b401d` recorded
lint, format, typecheck, and `pnpm test` PASS: 81 files, 620 tests.
`docs/progress/PHASE-04-FINAL-SUMMARY.md` does not exist.

`AGENTS.md` section 30 was aligned again on 2026-09-24 for `38b401d`. Do not
restart or redesign the completed slices above.

## 5. Current Git checkpoint and worktree

The 2026-09-24 validation finalization records this checkpoint. This handoff
and the `AGENTS.md` status update are documentation-only until reviewed. The
earlier API-serving checkpoint remains in the list below.

```text
branch: main
HEAD: 38b401d267013748166e5e24437152ae0b99253d
origin/main: same HEAD
previous checkpoint: 559c61e8f9a3c7a7c823177a2a03da390a36fbbf
earlier handoff snapshot: 789a5efa2e435e6099204fb753104c45143b7523
```

Checkpoints after the 2026-09-23 snapshot, newest first:

```text
38b401d Stabilize Phase 4 final validation gate
559c61e Implement Phase 4D3c2 derived asset API serving
b00d1d4 Add album_media visibility migration
5db5b9c Implement Phase 4D3c1 READY transaction
905c1eb Document Phase 4D3a-2b renderer qualification
e6c1910 Implement Phase 4D3c worker integration
3d5324b Implement Phase 4D3b-1 derived publish and recovery
c432ed8 Implement Phase 4D3b-0 isolated verify-output capability
fcbeefe Implement Phase 4D3b-0 deterministic temp sealing
21f5169 Implement Phase 4D3b-0 derived known-file inventory
789a5ef Implement Phase 4D3b-0 capacity admission contract
```

The 2026-09-23 checkpoint list is preserved here:

```text
789a5ef Implement Phase 4D3b-0 capacity admission contract
67dece0 Design Phase 4D3b-0 capacity admission commit protocol
09c4f4f Clarify Phase 4D3b-0 deterministic temp identity
02c7566 Implement Phase 4D3a-2a isolated image renderer producer
55983fe Design Phase 4D3a-2 and D3b verification boundary
ee5ca07 Harden Phase 4D3a-1 renderer FD and process lifecycle
84c111f Implement Phase 4D3a-0 renderer startup sandbox
28f8c21 Design Phase 4D3a renderer startup isolation
f07b352 Design Phase 4D3 image derivative pipeline
8be3c25 Complete Phase 4 metadata pipeline through D2
```

Do not use `git reset`, `git clean`, force-push, or a `phase-4-complete` tag.
Create later checkpoints only after a targeted review explicitly approves the
implemented slice.

## 6. Current capability gates

| Gate                                        | State   | Meaning                                                                                                                |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `RENDERER_PRODUCER_CAPABILITY_PASS`         | YES     | Fixed isolated renderer can produce bounded unverified candidate bytes for qualified synthetic format/recipe evidence. |
| `BINARY_OUTPUT_CAPABILITY_PASS`             | YES     | Dedicated bounded FD4 binary plane, separate bounded control channel, and cleanup behavior passed producer tests.      |
| `ADMISSION_TRANSACTION_CONTRACT_PASS`       | YES     | Two-second admission / bounded five-second outcome-resolution contract is implemented and tested.                      |
| `CROSS_PROCESS_CAPACITY_SERIALIZATION_PASS` | YES     | Real independent processes observed OS lock contention and use the shared DB capacity barrier.                         |
| `COMMIT_UNKNOWN_HANDLING_PASS`              | YES     | ACK-loss test seam uses real committed MySQL work plus fresh serialized exact readback; no replay.                     |
| `NO_TEMP_ON_TIMEOUT_OR_UNKNOWN`             | YES     | Current coordinator issues no temp authority after deadline/unknown. No temp implementation exists.                    |
| `DERIVED_KNOWN_FILE_INVENTORY_PASS`         | PENDING | Current native derived inventory is intentionally empty-only; a present entry fails closed.                            |
| `DETERMINISTIC_TEMP_NAMESPACE_PASS`         | PENDING | Naming decision is approved, but no owned temp creation/recovery code exists.                                          |
| `SEALED_DERIVED_OUTPUT_CAPABILITY_PASS`     | PENDING | No temp sealing or immutable sealed-output handle exists.                                                              |
| `ISOLATED_OUTPUT_VERIFIER_CAPABILITY_PASS`  | PENDING | Parent full decode is forbidden; verifier must consume only sealed output.                                             |
| `IMAGE_RENDERER_CAPABILITY_GATE_PASS`       | YES     | Qualification is recorded at `905c1eb`. This is a DEV capability gate, not a production isolation claim.              |
| `PUBLISH_PRIMITIVE_PASS`                    | YES     | Exclusive derived publish is recorded at `3d5324b`.                                                                    |
| `RECOVERY_IMPLEMENTED`                      | YES     | Derived publish recovery is recorded at `3d5324b`.                                                                     |
| `WORKER_INTEGRATION_PASS`                   | YES     | Image derivative worker is recorded at `e6c1910`.                                                                      |
| `READY_TRANSACTION_PASS`                    | YES     | Fenced READY transaction is recorded at `5db5b9c`.                                                                     |
| `SCHEMA_MIGRATION_PASS`                     | YES     | Additive `0004` `album_media` migration is recorded at `b00d1d4`. `0000`–`0003` were not rewritten.                    |
| `API_SERVING_PASS`                          | YES     | Authenticated thumbnail/preview serving is recorded at `559c61e`.                                                      |

The rows above that still say `PENDING` described the 2026-09-23 snapshot at
`789a5ef`. The later YES rows are the current capability record. HEIC and
RAW/DNG image derivatives remain disabled in V1. JPEG, PNG, WebP, and GIF
producer evidence was later qualified, published, and served only as READY
thumbnail or preview through album ACL. That is not a production-ready claim.

## 7. Important implementation map

### Immutable original / parsing / metadata

- `packages/storage/src/index.ts :: OriginalReader` validates marker, canonical
  identity, size and SHA-256, then offers a single-use verified read-only
  original handle. It is the only normal input route to parser/renderer code.
- `packages/storage/native/storage_native.c` provides root confinement,
  no-follow operations, original verification, capacity-gate primitives and
  native capability enforcement.
- `packages/media/src/metadata-parser*` and
  `apps/worker/src/metadata-processor.ts :: MetadataProcessingService` perform
  isolated probing and fenced persistence flow.
- `packages/db/src/metadata-repository.ts :: MySqlMetadataRepository` rechecks
  family/storage/media/job/generation/recipe/worker/epoch/lease after parsing;
  stale work must produce zero changes.

### Renderer producer and sandbox

- `packages/storage/native/image_renderer_bootstrap.c` is the tiny fixed
  bootstrap. It activates the final sandbox before module load and before the
  first untrusted original byte read.
- `packages/storage/native/image_renderer_supervisor.c` owns spawn, FD mapping,
  bounded concurrent drains, limits, liveness and exact-child teardown.
- `packages/storage/native/process_lifecycle.h` is the shared lifecycle state
  machine: `RUNNING -> TERM_SENT -> KILL_SENT -> REAPED`, with fail-closed
  `ANOMALY`. Post-reap PID/PGID signal authority is cleared.
- `packages/storage/src/image-renderer-producer.ts ::
renderUnverifiedCandidate` and `UnverifiedRenderedCandidate` expose only a
  bounded candidate. It must not authorize DB READY, publish, serving, or job
  success.
- Pinned vendored encoder source is `packages/storage/vendor/libwebp/1.6.0/`.
  It is static-linked, manifest-checked and package-controlled; do not replace
  it with Homebrew, PATH lookup, dynamic plugin loading or runtime download.

### Jobs, canonical media, and capacity admission

- `packages/db/src/job-repository.ts :: MySqlJobRepository` implements logical
  job identity, `FOR UPDATE SKIP LOCKED` claim, heartbeat, reclaim, retries and
  lease-epoch fencing.
- Phase 4B canonical media repository uses unique
  `(family_id, storage_object_id)` convergence. Only an exact canonical
  duplicate may converge; the first `source_upload_id` provenance is immutable.
- `packages/storage/src/index.ts :: CapacityGate` owns process-local queue,
  marker/inode-validated `.capacity.lock`, and final read-only statfs/inventory
  observation. The lock is mode `0600`.
- `packages/db/src/capacity-transaction.ts :: runCapacityTransaction` owns a
  checked physical MySQL connection, named session lock
  `family_album_dev.capacity.v1`, transaction, pre-COMMIT deadline and bounded
  outcome classification.
- `packages/db/src/derived-admission-repository.ts ::
MySqlDerivedAdmissionRepository` validates current job/lease/generation,
  computes conservative inventory, creates/reuses exact `RESERVED` rows, and
  does exact serialized readback for ambiguity.
- `apps/worker/src/derived-admission.ts` combines storage and DB results into
  a runtime-branded, one-use, expiring `DerivedTempAdmissionPermit`. No current
  code consumes it to create a file.
- `packages/db/src/upload-repository.ts` and
  `apps/api/src/uploads/service.ts` contain the shared-barrier upload-admission
  integration. It preserves existing Phase 3 receipt/tus/finalize semantics.

## 8. Historical task at 789a5ef: Phase 4D3b-0 Derived Known-File Inventory Gate

This section records the next task at the 2026-09-23 snapshot. Inventory,
temp, seal, verifier, publish, recovery, worker, READY, `album_media`, and
derived serving were implemented in later checkpoints. It is not an
instruction to implement them again.

The task at that snapshot was R3 implementation under the approved D3
guardrails. It was not, at that time, a request to implement temp files.

The current native derived inventory is **empty-only**: an absent or verified
empty private `derived` directory is complete; any entry makes inventory
incomplete and admission fails closed. This is safe for the current no-temp
slice, but deliberately cannot account for real sealed/temp/retained derived
files. Therefore it blocks all derived filesystem writes.

The next slice must add a bounded, no-follow, dirfd-confined, paged known-file
inventory that binds each recognized file to the expected reservation/operation
identity and reports unknown, duplicate, malformed, stale, or mismatched files
as recovery-required/incomplete. It must run inside the already-established
OS `.capacity.lock` plus global DB capacity session barrier admission window.
Do not create a temp file while doing this inventory gate.

## 9. Historical roadmap after the 789a5ef inventory gate

The steps below were the order after the 2026-09-23 snapshot. They have since
been checkpointed through API serving. Keep them as the record of that order.
They are not a list of remaining implementation work.

1. **Derived Known-File Inventory:** exact known-file scanner and conservative
   accounting/recovery identity; no temp creation.
2. **Deterministic owned temp:** only after review PASS; exact
   `derived/.tmp/<job>/e<epoch>/<kind>.part`, `O_EXCL`, `O_NOFOLLOW`, dirfd
   confinement, identity checks and no random fallback.
3. **DerivedStore:** reservation-backed controlled ownership, capacity and
   recovery primitives. No arbitrary paths or cleanup globs.
4. **Seal:** close writer, verify identity/inode/size/digest and issue an
   opaque sealed-output capability.
5. **SealedDerivedOutput:** handoff must bind the exact sealed bytes; no
   buffer/memory/arbitrary-pipe verifier bypass.
6. **Isolated verify-output:** fixed child full-decodes sealed WebP, enforces
   geometry/static/private-metadata policy, and fails closed.
7. **D3a-2b final qualification:** compose renderer producer plus sealed-output
   verifier evidence per OS/build/format/kind/recipe; only then evaluate final
   image renderer capability.
8. **D3b-1 publish/recovery:** exclusive durable publish, accounting/state
   transitions, crash reconciliation, no overwrite and recovery semantics.
9. **D3c worker integration:** fenced image-derivative job handling. Job
   completion/media state changes must be atomic with final asset readiness.

Each of those steps received its own review before the next checkpoint. UI,
video poster, HEIC, RAW/DNG, and Phase 5 are still not started. Do not treat
the completed serving checkpoint as permission to start them.

## 10. Known issues and deferred work

These are not silently closed. They must remain visible in future reviews.

| Severity | Item                                | Current disposition                                                                                                                                                                                 |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2       | D0 legacy high-FD inheritance path  | Renderer high-FD inheritance is qualified to FD1703; D0's older fork/`close(4..1023)` launcher is not converted and remains open.                                                                   |
| P2       | Renderer/process evidence hardening | Live dual-PGID cross-kill, parent-death grandchild trace, longer FD-leak profiling and PID-reuse edge cases remain partially test-hardened/platform-limited.                                        |
| P2       | libwebp provenance                  | Source/version/commit/archive/tree manifest is pinned; detached release signature was obtained but not claimed verified because no pretrusted signing key was available.                            |
| P2       | Producer-to-final-renderer gap      | At `789a5ef`, D3a-2a had only bounded producer checks. Later qualification, verifier, publish, and serving checkpoints closed that implementation gap. Production isolation is still not claimed. |
| P2       | Derived inventory                   | At `789a5ef` the inventory was empty-only. Later checkpoints added known-file inventory. Unknown residue still fails closed.                                                                         |
| P2       | Admission concurrency evidence      | The contract has real lock/session evidence, but broader process-death/COMMIT-in-flight coverage and parallel test-fixture hardening remain desirable.                                              |
| P2       | Existing fixture collision          | Closed for default `pnpm test` at `38b401d`. Integration files no longer overlap on the shared DEV claim queue or named capacity lock. Unit tests stay parallel. |
| P2       | Uid mismatch and cross-device       | Negative fixtures remain unconstructable without extra privileges. They are not closed.                                                                                                              |
| P2/P3    | Phase 3 production validation       | Persistent production rate limits/audit, full E2E upload lifecycle, power-loss/external-SSD tests, native destructive primitive defense-in-depth and more deterministic race signals remain open.   |
| P3       | Verifier deadline fixture           | Production verifier deadline is 10 seconds. The DEV lifecycle fixture uses 1 second.                                                                                                                 |
| P3       | Identical sealed temp               | A sealed temp that matches an existing final is reported. It is not adopted into READY.                                                                                                              |
| P3       | READ_ONLY derived serving           | The API attaches the capacity gate only while storage is `READ_WRITE`. A read-only root returns `503` instead of bytes.                                                                              |
| —        | Production and deployment validation | Real power-loss, external SSD disconnect, production rate limiting, persistent audit storage, and deployment validation are not done. Phase 4 is not fully production ready.                        |

No currently recorded P0/P1 is open from the Phase 1–3 final reviews or the
Phase 4 serving review. The 2026-09-23 sentence that images were not
publishable or servable described `789a5ef` only. Derived thumbnail and
preview serving exists at `559c61e`. Validation stabilization at `38b401d`
recorded lint, format, typecheck, and test PASS (81 files, 620 tests).
Production validation is still open, so that result is not a production-ready
claim.

## 11. Lessons learned — do not regress

- Do not attempt nested sandbox tightening; macOS sandbox behavior made that
  design unworkable. Use the approved one-time final sandbox bootstrap.
- Do not decode/render output fully in the trusted parent. Final decode belongs
  in a fixed isolated verifier over a sealed output capability.
- Do not use random or hybrid random temp filenames. The approved protocol is
  deterministic `<kind>.part`; authorization comes from root/dirfd identity,
  `O_EXCL`, `O_NOFOLLOW`, fencing and DB reservation—not guess resistance.
- Do not create a temp, writer, seal or verifier work before a timely confirmed
  reservation and permit. An expired or ambiguous call never regains authority.
- Do not blindly retry a COMMIT_UNKNOWN, release speculative capacity, or claim
  absence after a post-COMMIT error. Use fresh-connection, same-barrier exact
  readback.
- Do not release the OS capacity lock before COMMIT outcome is classified.
- Do not treat pathname strings as ownership, use `/dev/fd` path reopen, or
  give parser/renderer an output/root/derived path.
- Do not cleanup with broad globs. Cleanup must bind complete business identity,
  epoch and observed filesystem identity; READ_ONLY never performs destructive
  cleanup.
- Do not add a migration, edit Drizzle snapshots/metadata, or change old
  schema just for convenience. A genuine schema need is an R3 design stop.
- Do not use real media, production data, secrets, `.env` values or database
  dumps in code, fixtures, logs, commits, prompts, or external review packets.

## 12. Cursor/Grok takeover checklist

1. Begin read-only: `git status --short`, `git branch --show-current`,
   `git log -12 --oneline`, then read this handoff plus the exact Phase 4D3
   guardrails and D3b-0 design/contract documents.
2. Confirm `main` is at the recorded checkpoint or explain every difference;
   preserve unrelated/user changes. Never reset/clean them.
3. Read only the relevant storage-native, storage TypeScript, DB admission,
   worker admission, and associated test files. Do not scan/rewrite unrelated
   auth, UI or Phase 1–3 code.
4. The 2026-09-23 authorized slice was Phase 4D3b-0 derived known-file
   inventory. That slice, and the later temp, seal, verifier, publish,
   recovery, worker, READY, `0004`, and serving slices, are already
   checkpointed. Validation stabilization is checkpointed at `38b401d`. Do not
   reimplement them. Do not start Phase 5, a final completion tag, the Phase 4
   final summary, or a new feature from this documentation finalization.
5. Use synthetic roots and DEV-only synthetic DB fixtures. Validate native
   no-follow/root confinement, ownership, pagination/bounds, unknown residue
   fail-closed behavior, family/epoch fencing and zero residue.
6. If the work needs a schema, transaction/lock-order, security-invariant or
   storage-authority change, stop with `R3_DESIGN_REVIEW_REQUIRED` rather than
   inventing a workaround.
7. Run targeted tests, relevant Phase 3/4 regressions, readiness, scoped
   typecheck/lint/format and `git diff --check`. Record exact pass/fail/skip
   counts; do not claim a full phase gate from targeted evidence.
8. Only after an explicit successful review: stage exact reviewed files, run
   cached diff checks, create a narrowly scoped checkpoint and push `main`.
   Never stage `.env`, build products, vendored changes not under review,
   synthetic residue, real media or DB dumps.

## 13. Useful commands and safety reminders

Use repository scripts from the root. The full gate commands are
`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
and `pnpm test:e2e`. Targeted work should use the narrow matching Vitest files
and package commands instead of repeatedly running the whole suite.

MySQL integration requires the root `.env` to be loaded at the process boundary
but its value must never be printed. The intended DB is only
`family_album_dev`; validate database name, non-root account, MySQL version,
native FK and session foreign-key checks before any migration or DB-writing
test. No production database or media root is in scope.

## 14. Source documents to read next

1. [Phase 4 guardrails](PHASE-04-GUARDRAILS.md)
2. [D3 renderer/DerivedStore guardrails](PHASE-04D3-GUARDRAILS.md)
3. [D3a-2/D3b boundary decision](PHASE-04D3A2-D3B-BOUNDARY-REVIEW.md)
4. [Renderer producer record](PHASE-04D3A2A-RENDERER-PRODUCER.md)
5. [Deterministic temp identity decision](PHASE-04D3B0-TEMP-NAMING-REVIEW.md)
6. [Admission/commit design decision](PHASE-04D3B0-ADMISSION-COMMIT-REVIEW.md)
7. [Implemented admission contract](PHASE-04D3B0-ADMISSION-CONTRACT.md)
8. [Phase 3 final summary](PHASE-03-FINAL-SUMMARY.md)

The three D3b-0 documents remain the historical design record: the guardrails
control the overall security model; the naming review controls deterministic
temp identity; the admission review controls deadline/commit semantics; the
admission contract records what was implemented at that snapshot. Later
progress documents through `PHASE-04D3C2-API-SERVING.md` record the completed
slices. There is no `PHASE-04-FINAL-SUMMARY.md`.
