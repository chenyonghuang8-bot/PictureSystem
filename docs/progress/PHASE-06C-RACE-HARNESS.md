# Phase 6C — Deterministic race harness

Scope: test infrastructure only, on the local uncommitted Phase 6C implementation based on `d25014e52e7686069077c572b128aea3d42100ea`. This slice does not close P2-1/P2-2/P2-3 or authorize a checkpoint/Phase 6D.

## Why the harness was needed

The prior Phase 6B/6C helpers used `setImmediate` (and older tests used elapsed-time checks). These do not establish that a mutation issued its lock query. The DEV app account cannot SELECT `performance_schema.data_lock_waits` (`ER_TABLEACCESS_DENIED_ERROR`). No privilege or server configuration change is needed by this harness.

## Internal synchronization seam

`MySqlAlbumRepository(pool, { testHook })` optionally observes only the six closed operation IDs: `TAG_CREATE_APPLY`, `TAG_APPLY_EXISTING`, `TAG_REMOVE`, `NOTE_UPDATE`, `COMMENT_CREATE`, `COMMENT_DELETE`. Hook types live in `packages/db/src/album-repository-test-hooks.ts`, with no package-entrypoint re-export. There is no global hook, environment flag, HTTP/config/worker/Web integration, or change to production construction `new MySqlAlbumRepository(pool)`.

- `FAMILY_LOCK_QUERY_DISPATCHED`: the unchanged family `SELECT ... FOR UPDATE` query has been invoked and returned its promise; the repository has not awaited its result. Inspection of installed mysql2 3.24.4 `lib/promise/connection.js` confirms the promise executor calls the underlying connection query synchronously. This event proves client query dispatch, not server telemetry showing a lock wait. Holding the same family row lock in another transaction establishes the ordering.
- `MUTATION_APPLIED_BEFORE_COMMIT`: authorization and the mutation callback have succeeded; the outer transaction callback has not returned, COMMIT has not been called, and the family lock is still held. The test hook may await an explicit release latch.

Hook exceptions propagate through existing rollback handling. The dispatched SQL promise has an immediate rejection observer while a hook may pause; its original result/error is still awaited on the successful-hook path. Rollback, retry, COMMIT-unknown handling, authorization predicates, SQL identity/parameters, and public error mapping are unchanged. Hooks are not emitted for Phase 6B operations or reads.

The unexported internal `packages/db/src/album-race-barrier-test-helper.ts` uses per-test deferred observed/released promises. Keeping it within the DB package preserves that package's build `rootDir`; it is absent from the package entrypoint exports. Its timeout is exclusively a failure watchdog for missing events/releases; elapsed time or a still-pending promise is never used to establish ordering. Tests release barriers and settle operations during cleanup.

## Representative real MySQL proofs

The new `deterministic race harness` block in the Phase 6C integration suite uses separate real connections and fresh synthetic media with initial NULL note/revision 1.

1. State-first: a test transaction locks the family row and writes `can_edit=0`; the repository starts NOTE_UPDATE and signals dispatched family-lock query; only then the test commits the revocation. The mutation rejects FORBIDDEN, never reaches the mutation-applied event, and the note/revision remain NULL/1. Final detail still permits view but reports no edit capability; the grant row confirms view=1/edit=0.
2. Mutation-first: NOTE_UPDATE pauses at mutation-applied-before-commit. The test connection invokes its family-lock query and retains its promise, then releases the repository latch. After obtaining the lock, that state transaction reads the committed note/revision (`harness note`/2) before writing edit revocation and committing. A subsequent ordinary repository update rejects FORBIDDEN and leaves note/revision unchanged. View remains permitted; edit is denied.
3. A rejecting-hook instance does not affect ordinary repository construction. Ordinary note mutation succeeds. Rejection at either hook stage rolls back with unchanged note/revision and releases the lock; a subsequent ordinary update succeeds using revision 1.
4. All six designated mutation operations emit the expected pair of stage events; detail/tag/comment reads emit none.

The original timing-based Phase 6B/6C tests remain untouched for the later remediation task. Their presence is not claimed as deterministic evidence. The full P2-2 authorization matrix remains open.

## Validation and boundaries

- PASS: helper tests 5; affected duplicate-classifier/transaction unit regressions 14.
- PASS: Phase 6B/6C MySQL suites 32 tests, including 6 new harness integration cases. Combined targeted run: 5 files / 51 tests, skip 0. Post-run Phase 6C synthetic family residue: 0.
- PASS: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `git diff --check`.
- An additional diagnostic `tsc --noEmit -p tsconfig.vitest.json` is not a passing project gate: that broad configuration reports existing cross-workspace/test type errors (including unresolved root `mysql2/promise` and DOM/Node timer conflicts). The required workspace `pnpm typecheck` passes. No unrelated type/config repair was performed.
- No schema/migration modification; 0000–0006 unchanged and 0007 absent. Frozen 0006 SHA-256: `533b8f57d98dd10251d770326cd7df1d22481b087eb23c46edd7ec2a493017e4`. Live DEV migration readiness: PASS, exact 7 migrations.
- No original media/filesystem processing, production data, new database privileges, checkpoint, commit, push, or Phase 6D work.

Stop after harness validation. Resume Phase 6C remediation only as a separate authorized task; do not describe this slice as closing the three Phase 6C P2 findings.
