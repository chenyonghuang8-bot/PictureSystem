# Phase 7C — Purge implementation progress

Current status: PHASE 7C COMPLETE / LOCAL CHECKPOINT: this commit (`Complete Phase 7C purge`). The user explicitly authorized the scoped local checkpoint after the external targeted closure PASS recorded below. Phase 7D has not started, Phase 7 remains incomplete, and Production Ready remains NO. Earlier pending-review and checkpoint-NO statements below are historical and superseded by this checkpoint.

## Authorized local checkpoint — 2026-10-02

This commit checkpoints only the 7C implementation, tests and this progress document. The pre-checkpoint HEAD is `1a3fe200ed5f18ba2d7f056a764eb5ce16b27d4b`. The 30-file scope excludes the pre-existing untracked `apps/web/AGENTS.md` and `apps/web/CLAUDE.md`; no migration, schema, lockfile or unrelated source change is included. The user authorized local stage/commit only, with no push and no Phase 7D implementation.

Before checkpoint preparation, all 31 other modified/untracked file content hashes matched the preceding documentation-preparation snapshot. Thus no functional/test changes occurred between that snapshot and this checkpoint task; the closure-time hash limitation below still applies. Only this document changed during checkpoint preparation. Validation/review evidence remains the externally reported result, not a new test execution. Local checks comprise document Prettier validation, staged diff whitespace validation and exact staged-scope inspection.

```text
PHASE_07C_COMPLETE: YES
PHASE_07C_CHECKPOINT: this commit
PHASE_07C_TARGETED_CLOSURE_PASS: YES (external report)
PHASE_7_COMPLETE: NO
READY_FOR_PHASE_07D: NO (separate scope and authorization required)
PRODUCTION_READY: NO
PUSH_PERFORMED: NO
```

## External targeted closure result and checkpoint preparation — 2026-10-02

Evidence source: the user supplied the latest Codex `PHASE_07C_TARGETED_CLOSURE_RESULT` through the coordinating task. This section records that externally executed review and validation report; it does not represent tests, a fresh independent review, database readiness, port inspection or fixture cleanup performed during this documentation-only preparation.

The external report records baseline HEAD/origin main `1a3fe200ed5f18ba2d7f056a764eb5ce16b27d4b`, frozen 0007 SHA-256 `05a7a3a66c3902de5ddf99e5b77a13fdc5614a7b9a5a3508404c37b657fd4fdd`, and no 0008. It reports:

- 7C-R1 closed: current named Derived directory and held FD/namespace are revalidated; moved, replaced and symlink namespaces are rejected without directory mutation, DB progress or capacity release.
- 7C-R2 closed: only known reader-busy acquisition is retryable as RETRY_WAIT/TRANSIENT_DB. A held reader prevents physical changes; unsafe ledgers are not classified as busy.
- 7C-R3 closed: recovery releases Derived capacity before choosing Original work, with DB guards requiring terminal Derived files and released capacity. The interruption/restart case first performs DERIVED_CAPACITY_RELEASE for 34 bytes; direct Original transitions without that release are rejected.
- Targeted closure verification: 2 files / 100 tests PASS. The earlier remediation regression was a separate 8-file / 163-test run.
- Final gates after the last functional/test change: lint, format, typecheck, unit/API 132 files / 1208 tests, DEV MySQL integration/race 31 files / 401 tests, build, API E2E 5 tests, Web E2E 15 tests including authenticated HTTPS, readiness and diff check PASS; skip 0. Current-run cleanup reports no residue.
- NO_NEW_FINDINGS. The review changed no source, tests or migrations and performed no stage, commit or push.

```text
PHASE_07C_TARGETED_CLOSURE_PASS: YES (external report)
READY_FOR_PHASE_07C_CHECKPOINT: YES (external report; checkpoint not performed)
READY_FOR_PHASE_07D: NO
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
```

Local preparation observations: HEAD and the local origin/main tracking ref match the reported baseline; no fetch was performed. The local 0007 SQL hash matches the report, the repository journal ends at 0007, and no 0008 migration file is present. Git status still lists 16 modified tracked files and 16 untracked files, including this progress document and the pre-existing Web AGENTS/CLAUDE files. The tracked diff remains 519 insertions / 41 deletions in 16 files, matching the preceding read-only observations. Existing uncommitted implementation/remediation changes are distinct from the report's statement that the review itself made no changes.

Freshness limit: no closure-time exact source manifest was supplied to this preparation task, and earlier read-only observations did not capture content hashes. Matching HEAD, paths and diff statistics cannot mechanically prove that every working-tree byte is unchanged since closure. No invalidating functional/test change is identified by these observations; the external report is the basis for gate freshness since closure. This preparation changes only this document and does not rerun historical gates. A content snapshot of all other current changed/untracked files is compared before and after the documentation edit to verify that this preparation leaves them unchanged.

Checkpoint remains a separate action requiring explicit Git authorization and an exact reviewed scope; this preparation is authorized only for documentation and checks. Preserve unrelated Web AGENTS/CLAUDE files outside that scope. Before staging, resolve any intervening functional/test changes against the reviewed scope; if such changes exist, run only the necessary affected validation/review. Checkpoint readiness does not authorize Phase 7D or production use.

## Blocker-only remediation — 2026-10-02

7C-R1: one purge-only native helper reopens the currently named root/derived directory through the trusted root descriptor, validates owner/group, strict mode, device and ACL, compares the held and named directory identity, and binds the held writer lock to that current namespace. Owner admission, inventory, inspection, absence proofs and physical operations share it. Destructive operations recheck authority immediately before mutation; observations recheck before returning. Ordinary Phase 4 recovery and Original root protections are unchanged.

7C-R2: only the exact COORD_ACQUIRE_TIMEOUT busy result receives the existing generic transient-execution category TRANSIENT_DB and bounded RETRY_WAIT. Identity and unsafe handoff-ledger errors retain fail-closed handling. A real queue test holds R-S, verifies no filesystem action and a safe failure audit, releases the reader, makes the retry eligible by DB update and completes purge. A corrupt native ledger remains BLOCKED.

7C-R3: every recovery loop verifies terminal Derived files and settles outstanding Derived capacity before selecting an Original physical step. It then rereads current lease/accounting authority. The repository independently rejects every Original stage transition while released_bytes is below derived_bytes. Recovery also covers previously quarantined/armed Original states without moving them back. Tests interrupt after the last Derived REMOVED commit (including SIGKILL), cover unknown release COMMIT outcomes, reject direct Original transitions at all three stages, and verify the charge is released even when subsequent Original integrity blocks execution.

Targeted regression: 8 files / 163 tests PASS, skip 0. New tests include real directory/symlink/mode/ACL replacement, no progress/charge change on binding failure, actual runNext reader retry and unsafe ledger classification, and Derived release before Original. Native artifacts were rebuilt before these tests.

Refreshed final gates after the last functional/test/native edit: lint, format, typecheck, unit/API (132 files / 1208 tests), separate DEV MySQL integration/race (31 files / 401 tests), full build, API E2E (5 tests), and Web E2E including authenticated real HTTPS/download validation (15 tests) all PASS; skip 0. Web development's generated next-env paths were restored to their unchanged build baseline after E2E. No functional/test edit followed these gates.

Fresh native production addon SHA-256: `a5f0b471a134394ab0b61b295df89e499e8043e6eff530e61d9735df528381ed`. Test addon SHA-256: `3ffd08d955385577b3d7f572caaaeead7eeb9cbbfdc583c259acc7de9560501d`. Explicit native rebuild preceded targeted/final tests, and the full build reproduced the same fingerprints. DEV readiness remains eight migrations (0000–0007), MySQL 9.7.2, non-root, family_album_dev; frozen 0007 SHA remains `05a7a3a66c3902de5ddf99e5b77a13fdc5614a7b9a5a3508404c37b657fd4fdd`. Schema, migration SQL, snapshots and journal are unchanged; no 0008 exists.

Successful exact-ID teardown proves current-run purge DB families/history and all registered roots/quarantine absent; every SIGKILL child exited. HTTPS fixture teardown checks exact owned DB records and removes its nonce-bound synthetic root. Local ports 4000, 4400 and 3443 are closed after validation. No historical unrelated artifacts were removed.

```text
PHASE_07C_REMEDIATION_PASS: YES
READY_FOR_PHASE_07C_TARGETED_CLOSURE_REVIEW: YES
READY_FOR_PHASE_07C_CHECKPOINT: NO
READY_FOR_PHASE_07D: NO
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
DESIGN_CHANGE_REQUIRED: NO
DATABASE_MIGRATION_REQUIRED: NO
SCHEMA_CHANGED: NO
0008_PRESENT: NO
LAST_FUNCTIONAL_OR_TEST_CHANGE_PRECEDES_FINAL_GATES: YES
FULL_GATE_EVIDENCE_STALE: NO
STAGE_PERFORMED: NO
COMMIT_PERFORMED: NO
PUSH_PERFORMED: NO
```

The implementation result below is the earlier baseline, superseded by this remediation's refreshed validation and targeted closure review requirement.

## Current continuation — 2026-10-02

The exact manifest uses separate Original/Derived SHA-256 identity domains, authoritative decimal identifiers, full content SHA/size and root marker/device. Original is a singleton. Only READY, uncleaned Derived finals enter the manifest; every other attempt must have durable physical absence and cleaned_at before detach. Native inventory and row comparison cover all generations and producer identities. Same-content FINALIZING blocks detach. One checked capacity transaction persists the manifest and its exact READY charge, removes target relations/assets/jobs/media, retires every COMPLETE receipt, proves zero live references, changes storage to PURGING and appends PURGE_STARTED. SQL lease time is rechecked after all row locks.

Capacity inventory counts detached purge ownership and retained RETIRED staging. Partial Derived removal retains the entire Derived charge. The charge is released together after all Derived manifest files are terminal; Original follows. FILES_REMOVED requires exact total released bytes. The final transaction deletes the PURGING storage row and atomically records COMPLETED/DONE and PURGE_COMPLETED. Failures and exhausted/reclaimed epochs record a safe, epoch-specific PURGE_FAILED audit in the same transaction as the queue transition.

The internal native capability accepts typed manifest identity, opaque writer/L-X/R-X handles and a one-shot SQL lease permit. It never accepts a caller pathname. Its fixed private .purge/v1 namespace has deterministic, injective big-endian intent/file slots. Canonical and slot files require current root/marker/device, same owner, strict mode, single link, no unexpected ACL, full SHA/size and stable named/open identity. No-replace rename synchronizes both directories before QUARANTINED. Durable UNLINK_ARMED precedes exact-slot unlink. Only an armed historical slot can converge true absence; missing unarmed Original/quarantine, dual presence, ambiguous traversal and mismatches fail closed. Native settlement closes descriptors on success or failure. Production exposes no fault setter; test-only native injection verifies post-rename/post-unlink directory-sync failures.

The DEV worker validates migration readiness and acquires both existing writers before any claim. It refuses an unavailable writer, replaced root or wrong marker. It never steals ownership from a running API process and introduces no IPC write relay or deployment topology. It scans bounded requests, claims the dedicated purge queue, renews epoch-fenced leases, executes short checked transactions outside filesystem operations and drains before releasing owned handles. Physical purge remains restricted to a controlled exclusive owner; simultaneous deployed API/worker operation and Production deployment have not been validated.

Live tests exercise two Derived generations, all relation deletion, two COMPLETE receipts, conservation of capacity, reader and stale-worker exclusion, FINALIZING conflict, failure-audit idempotency, exact native mismatch rejection, unknown COMMIT before/after detach/arm/removal/finalization, and same-byte upload through the real upload service followed by canonical media creation. Old RETIRED finalize and media replay are rejected; the new storage/media/source IDs inherit no favorites, featured entry, tag relation, note or comment. The tag dictionary remains.

Seven SIGKILL subprocess cases stop an actual writer process at durable rename, arm, unlink, FILES_REMOVED and finalization boundaries, including Original boundaries. A fresh process reacquires writer and L/R authority and recovers from database/native identity. No sleep serves as an ordering proof. Exact-ID teardown asserts this run's DB families and historical purge rows are gone, all registered roots including quarantine are absent, and every crash child has exited.

Targeted continuation gate: 6 files / 132 tests PASS, skip 0. Final gate counts and fingerprints are recorded below. No schema/migration change, stage/commit/push, real-family media access, Production operation, Phase 7D work or secure-erasure claim was performed.

# PHASE_07C_RESULT

## Baseline

```text
HEAD: 1a3fe200ed5f18ba2d7f056a764eb5ce16b27d4b
origin/main: 1a3fe200ed5f18ba2d7f056a764eb5ce16b27d4b
0007_SHA: 05a7a3a66c3902de5ddf99e5b77a13fdc5614a7b9a5a3508404c37b657fd4fdd
LIVE_MIGRATIONS: 0000–0007
READINESS: PASS; MySQL 9.7.2, family_album_dev, non-root, 8 migrations
SCHEMA_CHANGED: NO
0008_PRESENT: NO
```

## Permanent Delete API

```text
PERMANENT_DELETE_ROUTE: POST /api/v1/families/:familyId/trash/:mediaId/permanent-delete
PURGE_STATUS_ROUTE: GET /api/v1/families/:familyId/purge-requests/:operationId
WEB_SESSION_ONLY: YES
ADMIN_OR_SUPER_ADMIN_REQUIRED: YES
RECENT_AUTH_REQUIRED: YES
TRASH_VISIBLE_REQUIRED: YES
ALL_LIVE_PLACEMENTS_DELETE_REQUIRED: YES
RETENTION_BYPASS_ALLOWED: NO
```

## Scheduled Purge

```text
SCHEDULED_SCANNER_IMPLEMENTED: YES
DB_SERVER_TIME_USED: YES
BOUNDED_SCAN: YES
DUPLICATE_SCHEDULED_INTENT_POSSIBLE: NO
PHYSICAL_DELETE_DONE_IN_SCANNER: NO
```

## Irreversible Request

```text
PURGE_INTENT_SAME_TX: YES
MEDIA_PURGE_INTENT_LINK_SAME_TX: YES
LIFECYCLE_REVISION_INCREMENTED: YES
REQUEST_AUDIT_SAME_TX: YES
RESTORE_AFTER_REQUEST_ALLOWED: NO
```

## Purge Worker

```text
DEDICATED_PURGE_QUEUE_USED: YES
BACKGROUND_JOBS_REUSED: NO
LEASE_EPOCH_FENCED: YES
STALE_WORKER_CAN_START_NEW_DELETE_STEP: NO
```

## Pre-Detach Normalization

```text
FINALIZING_CONTENT_BLOCKS_DETACH: YES
UNRESOLVED_DERIVED_TEMP_BLOCKS_DETACH: YES
NONREADY_DERIVED_USES_EXISTING_EXACT_CLEANUP: NO; approved purge-specific exact normalization is used
ARBITRARY_TEMP_MANIFESTED: NO
```

## Manifest

```text
ORIGINAL_SINGLETON: YES
DERIVED_FINALS_CATALOGUED: YES
ARBITRARY_PATH_STORED: NO
IDENTITY_KEY_DOMAIN_SEPARATED: YES
ROOT_MARKER_BOUND: YES
ROOT_DEVICE_BOUND: YES
```

## Capacity Transfer

```text
CAPACITY_GATE_USED_FOR_DETACH: YES
DERIVED_CHARGE_BEFORE_DETACH: READY byte_size; non-READY must already be cleaned
DERIVED_CHARGE_AFTER_DETACH: purge derived_bytes minus the conservative released Derived portion
ZERO_ACCOUNTING_WINDOW_FOUND: NO
DOUBLE_ACCOUNTING_WINDOW_FOUND: NO
PARTIAL_DERIVED_DELETE_RELEASES_CHARGE: NO
ALL_DERIVED_TERMINAL_RELEASES_CHARGE: YES
```

## Reference Retirement

```text
PLACEMENTS_DELETED: YES
FAVORITES_DELETED: YES
FEATURED_DELETED: YES
MEDIA_TAGS_DELETED: YES
COMMENTS_DELETED: YES
DERIVED_ROWS_DELETED: YES
BACKGROUND_JOBS_DELETED: YES
MEDIA_ROW_DELETED: YES
ALL_COMPLETE_RECEIPTS_RETIRED: YES
SOURCE_RECEIPT_ONLY: NO
STORAGE_STATE_AFTER_DETACH: PURGING
PURGE_STARTED_AUDIT_SAME_TX: YES
```

## RETIRED Execution

```text
LIVE_STORAGE_FK_CLEARED: YES
HISTORICAL_STORAGE_ID_PRESERVED: YES
PURGE_ID_PRESERVED: YES
COMPLETED_AT_PRESERVED: YES
SOURCE_PROVENANCE_PRESERVED: YES
RETIRED_MARKED_FAILED: NO
OLD_FINALIZE_REPLAY_ALLOWED: NO
```

## Quarantine Capability

```text
NARROW_PURGE_CAPABILITY: YES
GENERIC_UNLINK_EXPOSED: NO
GENERIC_PATH_ACCEPTED: NO
QUARANTINE_ROOT_MARKER_BOUND: YES
QUARANTINE_NOFOLLOW: YES
QUARANTINE_NOREPLACE: YES
QUARANTINE_DIRECTORY_DURABLE: YES
DETERMINISTIC_SLOT: YES
```

## Original Purge

```text
FULL_IDENTITY_VERIFIED_BEFORE_RENAME: YES
ORIGINAL_GENERIC_ENOENT_SUCCESS: NO
CATALOGUED_MISSING_ORIGINAL_BLOCKED: YES
CATALOGUED_QUARANTINE_RECOVERY: YES
QUARANTINED_PREARM_ABSENCE_BLOCKED: YES
UNLINK_ARMED_BEFORE_UNLINK: YES
DIRECT_UNLINK_BEFORE_ARM: NO
```

## Derived Purge

```text
PRESENT_DERIVED_QUARANTINED: YES
CATALOGUED_ABSENT_DERIVED_ACCEPTED: YES
POST_QUARANTINE_PREARM_ABSENCE_FAILS_CLOSED: YES
DERIVED_REMOVED_BEFORE_ORIGINAL: YES
```

## Authorized Absence Recovery

```text
UNLINK_ARMED_DURABLE_REQUIRED: YES
EXACT_OPERATION_FILE_REQUIRED: YES
CANONICAL_ABSENT_REQUIRED: YES
EXACT_QUARANTINE_ABSENT_REQUIRED: YES
AMBIGUOUS_IO_COUNTS_AS_ABSENT: NO
ABSENT_AFTER_AUTHORIZED_UNLINK_PASS: YES
```

## L/R / Writer Composition

```text
EXISTING_WRITER_AUTHORITY_PRESERVED: YES
PURGE_L_EXCLUSIVE: YES
PURGE_R_EXCLUSIVE: YES
DB_LOCK_HELD_WHILE_WAITING_LR: NO
CAPACITY_GATE_TO_LR_REVERSE_FOUND: NO
UNRESOLVED_HANDOFF_BLOCKS_PURGE: YES
LONG_READER_BLOCKS_PHYSICAL_PURGE: YES
```

## Finalization

```text
ALL_FILES_TERMINAL_BEFORE_FILES_REMOVED: YES
RELEASED_BYTES_EXACT_TOTAL: YES
STORAGE_ROW_DELETED_AFTER_PHYSICAL_REMOVE: YES
PURGE_COMPLETED_AUDIT_SAME_TX: YES
INTENT_DONE: YES
```

## Race Evidence

```text
SLEEP_USED_AS_ORDERING_PROOF: NO
NEW_LIVE_REFERENCE_SURVIVED_DETACH: NO
DOUBLE_UNLINK_FOUND: NO
```

Evidence: held real R-S/L-S guards exclude physical purge/normalization; native live writer/sealed handles block cleanup; unresolved same-content FINALIZING blocks detach; live MySQL row-lock barriers prove SKIP LOCKED single claim; stale epoch cannot mutate; unknown COMMIT and actual SIGKILL recovery converge without replay.

## Crash Recovery

```text
AFTER_RENAME_BEFORE_DB_RECOVERED: YES
AFTER_ARM_BEFORE_UNLINK_RECOVERED: YES
AFTER_UNLINK_BEFORE_DB_RECOVERED: YES
AFTER_FILES_REMOVED_BEFORE_FINAL_DB_RECOVERED: YES
LEASE_EXPIRY_ALONE_ASSUMED_STEP_COMPLETE: NO
```

Seven actual SIGKILL subprocess cases; four test-only native directory-sync failures. Original and Derived rename/unlink boundaries are covered. These are process-crash tests, not power-loss or SSD-disconnect certification.

## Re-Upload After Purge

```text
NEW_STORAGE_ID: YES
NEW_MEDIA_ID: YES
NEW_SOURCE_UPLOAD_ID: YES
OLD_FAVORITES_INHERITED: NO
OLD_FEATURED_INHERITED: NO
OLD_MEDIA_TAG_RELATIONS_INHERITED: NO
OLD_NOTE_INHERITED: NO
OLD_COMMENTS_INHERITED: NO
RETIRED_RECEIPT_REUSED: NO
```

## Audit Privacy

```text
RAW_PATH_AUDITED: NO
SHA_AUDITED: NO
FILENAME_AUDITED: NO
TOKEN_AUDITED: NO
RAW_ERROR_AUDITED: NO
```

## Product Scope

```text
TRASH_UI_IMPLEMENTED: NO
SECURE_ERASE_CLAIMED: NO
PHASE8_IMPLEMENTED: NO
```

The controlled DEV worker must own both existing writer locks. A running API writer causes startup refusal; no writer bypass or deployed ownership topology was introduced.

## Tests

```text
NEW_TEST_FILES_CREATED: 2 (one integration file, one focused native/matrix file)
TARGETED_FILES: 6
TARGETED_TESTS: 132
TARGETED_SKIPS: 0
INTEGRATION_FILES: 31
INTEGRATION_TESTS: 390
INTEGRATION_SKIPS: 0
NATIVE_REAL_FILESYSTEM_PASS: YES
REAL_MYSQL_PASS: YES
REAL_CRASH_RECOVERY_PASS: YES
```

## Full Gates

```text
lint: PASS
format: PASS
typecheck: PASS
unit: PASS; pnpm test: 132 files / 1193 tests / 0 skips
integration: PASS; 31 files / 390 tests / 0 skips
build: PASS
e2e: PASS; 5 API + 15 Web/HTTPS tests
authenticated_https: PASS; Secure-cookie authorization, Original/Preview exact bytes, abort, privacy
readiness: PASS; final live checked connection
diff_check: PASS
LAST_FUNCTIONAL_OR_TEST_CHANGE_PRECEDES_FINAL_GATES: YES
FULL_GATE_EVIDENCE_STALE: NO
```

## Cleanup

```text
DB_CURRENT_RUN_RESIDUE_ZERO: YES
FILESYSTEM_CURRENT_RUN_RESIDUE_ZERO: YES
QUARANTINE_CURRENT_RUN_RESIDUE_ZERO: YES
SOCKET_PROCESS_RESIDUE_ZERO: YES
```

## Migration Preservation

```text
0007_SHA_PRESERVED: YES
SCHEMA_CHANGED: NO
0008_PRESENT: NO
```

## Findings

```text
P0: 0 known; independent review pending
P1: 0 known; independent review pending
BLOCKING_P2: 0 known
NON_BLOCKING_P2: 0 new; Production deployment validation remains deferred
P3: No newly identified blocker
```

## Design / Migration

```text
DESIGN_CHANGE_REQUIRED: NO
DATABASE_MIGRATION_REQUIRED: NO
```

## Decision

```text
PHASE_07C_IMPLEMENTATION_PASS: YES
READY_FOR_PHASE_07C_INDEPENDENT_REVIEW: YES
READY_FOR_PHASE_07C_CHECKPOINT: NO
READY_FOR_PHASE_07D: NO
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
STAGE_PERFORMED: NO
COMMIT_PERFORMED: NO
PUSH_PERFORMED: NO
```

## Continuation completion

```text
MANIFEST_IMPLEMENTED: YES
REFERENCE_RETIREMENT_IMPLEMENTED: YES
CAPACITY_TRANSFER_IMPLEMENTED: YES
ORIGINAL_QUARANTINE_IMPLEMENTED: YES
DERIVED_QUARANTINE_IMPLEMENTED: YES
UNLINK_ARMED_IMPLEMENTED: YES
AUTHORIZED_ABSENCE_RECOVERY_IMPLEMENTED: YES
FILES_REMOVED_IMPLEMENTED: YES
FINAL_STORAGE_DELETE_IMPLEMENTED: YES
PURGE_WORKER_IMPLEMENTED: YES
SCHEDULER_WORKER_WIRED: YES
FULL_CRASH_RECOVERY_PASS: YES
REUPLOAD_AFTER_PURGE_PASS: YES
PRE_DETACH_NORMALIZATION_IMPLEMENTED: YES
PURGE_SPECIFIC_NORMALIZATION_IMPLEMENTED: YES
```

Native addon SHA-256: `c294f612cae07c08f3ae3c4d78cea3d064708afcfc15b638280b7216b52e9bde`.

Final local test ports 4000, 4400 and 3443 are closed. Current-run exact-ID teardown, root/quarantine absence, and crash-child exit assertions passed. Existing untracked Web instruction files were preserved.

## Earlier accepted partial implementation (superseded status)

## Resume implementation evidence — 2026-10-02

The user explicitly approved the separate purge normalization protocol. Ordinary Phase 4 recovery was not broadened. The internal worker adapter borrows the existing Original and Derived writer capabilities, acquires L-X then R-X then CapacityGate, and revalidates the exact RUNNING/REQUESTED purge lease and TRASHED linked lifecycle in short checked capacity transactions. It binds the operation, source, storage, revision, all generations, reservations and producer identities. A producer's future DB lease does not authorize physical occupancy or prevent purge once actual exclusive admission and native live-handle checks succeed.

New native exact Derived inspection/removal validates root/marker, named/open inode, owner/group, mode, device, link count, ACL, full SHA/size and kind limits. Removal consumes a one-shot internal permit. SQL-derived lease deadlines use the same native monotonic clock as removal; Node hrtime has a different epoch on macOS and must not be passed directly as a native deadline. Matching dual sealed residues remove temp before final, with fresh SQL authority between them; conflicting residues are retained. The opposite name is checked under native serialization immediately before removal.

The purge-only bounded inventory permits empty protocol directories left by an unlink and rejects unknown target leaves, recipe/generation/producer identity and unsafe traversal. This does not alter ordinary recovery's conservative inventory or cleanup behavior. Both-name true absence is synchronized and can converge non-READY cleaned_at under current authority. Until the cleaned_at transaction commits, the original reservation remains fully charged. No reservation, state, payload, dimensions, failure metadata or job state is rewritten by normalization. READY is preserved and READY temp/cleaned residue is rejected.

Manual request/status routes and strict contracts have been added. Requests require current Web authorization, ADMIN/SUPER_ADMIN, authentication age below 15 minutes, due retention, visible placement and delete permission across every live placement. A short preflight precedes L-X; reauthorization, post-request lifecycle revision, intent linkage and PERMANENT_DELETE_REQUEST audit commit together. Exact replay does not increment revision or duplicate audit. Unknown request COMMIT only permits a fresh readback while L-X remains held. Status is requester-only, current ADMIN/SUPER_ADMIN, excludes scheduled intents and returns only safe progress with no-store. These routes are not a complete physical purge implementation.

A bounded scheduled-request repository and scanner class were added. They create SYSTEM requests under L-X and current family/storage/media SQL locks, and never perform physical deletion. Worker startup integration, full scanner races and the broader end-to-end purge path remain pending.

Latest targeted test command covers phase7c-purge, phase7b-trash-lifecycle, purge-derived, native ordinary derived recovery and DB ordinary derived recovery: **5 files / 64 tests PASS, skip 0**. This includes 16 live DEV Phase 7C cases, 21 purge native/matrix cases and 7B/ordinary recovery regressions. Evidence includes RESERVED 0600/0400, PUBLISHING temp/final, RESERVED final without payload, FAILED/MISSING, dual sealed, absence/repeat convergence, live writer/sealed occupancy, inode/SHA/size/mode/device mismatch, symlink/hardlink/ACL/root replacement, opposite final appearance, expired native permit, real L-S/R-S exclusion, old lifecycle describe denial, deletion before cleaned_at charge retention, native post-unlink directory-sync failure, SQL COMMIT unknown before/after commit and purge lease loss before accounting. MySQL tests require the DEV environment and did not silently skip. Only synthetic fixtures were used.

Current source targeted ESLint PASS, changed TypeScript/test formatting PASS, repository typecheck PASS, DB build PASS, explicit native rebuild PASS and git diff --check PASS. Full unit/API/integration/build/E2E gates have not been run as a Phase 7C completion gate. Native addon fingerprint: `66fe80a7f2cb17e3044222dd12323d6ba1675267c810670513841914aaa16a67`.

Current ordinary `assertMigrationReadiness` against DEV passes with migrationCount 8 (0000–0007). The legacy Phase 7 preflight script without --apply checks the 0006 predecessor and reports JOURNAL_MISMATCH after 0007 has already been applied; that result is not current-schema drift. No migration was attempted. HEAD/origin remain `1a3fe200ed5f18ba2d7f056a764eb5ce16b27d4b`, and the frozen 0007 hash still matches the baseline.

Successful tests perform exact-ID DB cleanup and owned-root filesystem cleanup. Eleven owned roots left by initial failing native test setup were identified by this run's new prefix, creation interval, owner and exact synthetic contents; writer-lock availability was checked before removal. No historical unrelated roots or data were removed. The two pre-existing untracked Web instruction files remain untouched. No stage/commit/push/checkpoint, Production operation, real-media fixture or migration was performed.

```text
PHASE_07C_IMPLEMENTATION_PASS: NO
READY_FOR_PHASE_07C_INDEPENDENT_REVIEW: NO
READY_FOR_PHASE_07C_CHECKPOINT: NO
READY_FOR_PHASE_07D: NO
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
SCHEMA_CHANGED: NO
0008_PRESENT: NO
```

## Historical preflight record

The following sections describe the earlier stopped attempt before R3 resolution. At that time no production/test source had changed. That historical STOP does not apply to the resumed implementation above.

## Baseline — 2026-10-02

Branch `main`; HEAD and origin/main both `1a3fe200ed5f18ba2d7f056a764eb5ce16b27d4b` (`Complete Phase 7B trash lifecycle`). The existing `phase-6-complete` tag is unchanged. The two local Web instruction files remain untouched. Read-only checked-connection verification against `family_album_dev`, MySQL `9.7.2`, non-root application account passed ordinary `assertMigrationReadiness`: eight migrations, 0000–0007, no schema drift. No DDL, migration application, or database fixture writes were performed.

Frozen 0007 SHA-256: `05a7a3a66c3902de5ddf99e5b77a13fdc5614a7b9a5a3508404c37b657fd4fdd`. All SQL, snapshots, journal, and Drizzle schema remain unchanged; no 0008 exists.

## Concrete blocker: non-READY sealed Derived attempt

The Phase 7C task requires every uncleaned non-READY Derived attempt to be resolved through the existing Phase 4 exact recovery/cleanup protocol before reference retirement. Its section 132 explicitly requires STOP if an unresolved Derived temp cannot be safely normalized before detach. This is a missing supported recovery case, rather than authorization to detach while retaining an unknown temp or to put a temp into the final-only purge manifest.

The normal seal-before-publish crash can leave an authoritative RESERVED attempt, no final, an expired producer lease, and a regular single-link `0400` temp. Existing `classifyDerivedRecoveryCase` returns `SEALED_CANDIDATE` for this state (`packages/db/src/derived-recovery.ts:179`). The reconciler selects cleanup only for `TEMP_ONLY_RETAIN` with a `0600` temp and no final (`:378`). Native `cleanup_exact_derived_temp` deliberately rejects any mode other than `600` (`packages/storage/native/derived_recovery.h:594`). There is no existing sealed-temp cleanup/adoption action in that protocol. `PUBLISH_BEFORE_DB` likewise remains a classification rather than automatic READY adoption or exact final deletion.

There is an additional integration boundary to address in the same targeted resolution: existing open-temp recovery discovers only ACTIVE media with no purge intent (`packages/db/src/derived-recovery.ts:404`). A purge-requested lifecycle is already TRASHED and linked to its intent; its worker holds L-X/R-X. Calling the existing recovery wrapper unchanged therefore cannot authorize the required pre-detach cleanup. This observation is from source inspection, not a new live MySQL race test.

Extending this protocol needs explicit guardrails for exact attempt ownership, stale producer quiescence, sealed versus published outcomes, purge lifecycle/lease fencing, native durability, and accounting release. No replacement design or permission exception was chosen here. Generic cleanup, chmod of a real sealed artifact, fabricated READY state, or an arbitrary temp purge manifest would bypass the stated boundary and was not implemented. The task's section 33 remains the runtime fail-closed rule: an unresolved attempt must stay REQUESTED and retry/BLOCK; it must never be detached by assumption.

## Synthetic reproduction

Rebuilt native artifacts before probing with `pnpm --filter @family-album/storage build:native`; PASS. Rebuilt `packages/storage/build/storage_native.node` SHA-256: `a3592d142ec92428fe12620c2fad53bbf268e63fcf173bf6797b4f04eea5196c`. Production source was unchanged by this build; outputs are ignored artifacts.

An isolated temporary diagnostic used a current-run synthetic private root, the existing root/Derived writer capabilities, an exact temp identity, and a synthetic expired RESERVED row supplied to the pure classifier. It proved:

- `0400` temp + no final + stale lease → `SEALED_CANDIDATE`.
- Exact device/inode/size/SHA arguments to native cleanup → `DERIVED_RECOVERY_IDENTITY`; file bytes and mode remain present.
- As a synthetic test control only, changing that fixture's mode to `0600` permits the existing exact cleanup and removes the file durably. This is not a proposed production normalization step.
- All current-run synthetic directories/handles were cleaned after assertions; no real media was opened.

Diagnostic script: `/tmp/picturesystem-7c-derived-normalization.mts`; result log: `/tmp/picturesystem-7c-derived-normalization.log`. An initial `tsx` CLI invocation was rejected by the sandbox's IPC socket restriction before fixture creation. The same diagnostic passed through `node --import tsx`, without that CLI socket. This diagnostic is not a live-DB integration test or a complete purge crash matrix.

## Writer ownership prerequisite

A separate real parent/child diagnostic confirmed that an API-like owner retaining `.writer.lock` denies a second process's Original writer acquisition. After that owner releases the lock, a single child can acquire both Original and Derived writer authority; while it holds them, another Original writer is denied. Exact IPC acknowledgements and child exit events were the ordering barriers; no sleep was used as proof. Both synthetic roots and child processes were cleaned.

This demonstrates that the existing native locks compose in one exclusive owner. It does not establish a deployed online API/worker ownership topology. Physical purge must remain disabled whenever its required writer authority is unavailable; L/R cannot replace these locks. No topology change, IPC write relay, API lock release, or writer bypass was introduced. Diagnostic script/log: `/tmp/picturesystem-7c-writer-probe.mjs` and `/tmp/picturesystem-7c-writer-probe.log`.

## Remaining scope / validation limits

Permanent-delete/status API, scheduler, irreversible request transaction, manifest, reference retirement, receipt retirement, capacity transfer, quarantine, armed unlink, purge worker/recovery, final storage deletion, and purge audits are not implemented. Existing 7B behavior is unchanged. No Trash UI, Phase 8, secure-erasure claim, physical media deletion, stage, commit, or push was introduced.

Full/targeted purge gates and races were not run because the explicit implementation STOP condition was reached before source changes. Prior 7B gate evidence is not claimed as 7C validation. Native build, the two focused diagnostic probes, read-only DEV readiness, migration preservation, and diff-check are the evidence produced in this task. Database current-run fixture residue is zero because no fixture was written; filesystem/process residue is zero for these owned diagnostics, not a claim about all system temporary files.

```text
PHASE_07C_IMPLEMENTATION_PASS: NO
READY_FOR_PHASE_07C_INDEPENDENT_REVIEW: NO
READY_FOR_PHASE_07C_CHECKPOINT: NO
READY_FOR_PHASE_07D: NO
DESIGN_CHANGE_REQUIRED: YES
DATABASE_MIGRATION_REQUIRED: NO
STOP_CONDITION: PRE_DETACH_DERIVED_NORMALIZATION_UNSUPPORTED
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
STAGE_PERFORMED: NO
COMMIT_PERFORMED: NO
PUSH_PERFORMED: NO
```
