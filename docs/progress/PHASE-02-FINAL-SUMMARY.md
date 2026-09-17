# PHASE-02 FINAL SUMMARY

日期：2026-09-15。状态：COMPLETE。

## Completed work

- Phase 2A album core implementation is complete.
- Phase 2B album ACL management is complete.
- The recent-auth existence oracle P1 is closed. Locked mutation checks apply album non-disclosure before recent-auth.
- `listAlbums` passes SQL ACL fields into the shared permission evaluator. Explicit CUSTOM viewers are listed, FAMILY explicit capabilities are preserved, and hidden rows do not consume keyset pages.
- Phase 2 permission E2E exercises the real HTTP → authentication → route → service → repository → MySQL path with synthetic Owner, explicit viewer, unauthorized member, and SUPER_ADMIN-without-ACL identities.
- The implemented Phase 2 database constraints are documented correctly: 4 foreign keys and 8 CHECK constraints.

## Bootstrap migration readiness

The obsolete assumptions that the latest migration must be Phase 1A and that bootstrap only needs a fixed Phase 1 table set were removed.

Bootstrap now fails closed unless all three views of migration state agree exactly:

1. The trusted repository manifest is valid: journal indices are contiguous, tags and timestamps are unique and ordered, every referenced SQL file exists, and migration hashes are derived from the SQL bytes.
2. The complete database journal exactly matches the current repository manifest in count, order, hash, and timestamp. Missing, partial, reordered, unknown, ahead, or altered entries are rejected.
3. The actual database schema semantically matches the expected current schema derived from the Drizzle table definitions, including the exact table set, engine/collation, columns, defaults, indexes, foreign keys, and CHECK constraints.

The Drizzle journal table is validated as infrastructure schema. Business-table expectations are derived from the existing Drizzle schema rather than maintained as a second handwritten schema manifest.

Migration readiness and identity-table emptiness are revalidated inside every retried bootstrap transaction attempt. A readiness failure occurs before any bootstrap insert. Rollback failure, deadlock retry, and unknown commit outcome behavior continue to use the existing transaction safety helper.

Bootstrap semantics are unchanged: it remains DEV-only, rejects root, requires an empty identity database, uses a named lock and TTY password entry, creates the family/user/SUPER_ADMIN atomically, rejects repeated or partial initialization, and cannot be used as a recovery path. Bootstrap was not executed during this change.

Operationally, bootstrap still requires a maintenance window without concurrent DDL; the named bootstrap lock does not coordinate with an independent migration process.

## Validation completed

- Migration-readiness/bootstrap/transaction/input targeted suite: 36 tests passed.
- Real MySQL Phase 1C and Phase 2A/2B targeted integration suite: 36 tests passed, 0 skipped.
- Full unit/API/integration suite: 36 files, 256 tests passed, 0 skipped.
- Full format, lint, and typecheck: passed.
- Workspace build: passed.
- Playwright health and Phase 2 permission E2E: 5 tests passed using synthetic fixtures.
- Database schema and migration files were not modified.

## Deferred items

- P2: replace timing-only race barriers with deterministic query-arrival or lock-wait evidence; the current real-MySQL race suite remains in place.
- P3/test hardening: expand exhaustive ACL combinations and related cleanup coverage.
- Persistent audit storage remains a production-readiness gap.

Phase 2 final gate is complete. `READY_FOR_PHASE_3: YES`; Phase 3 has not been started.
