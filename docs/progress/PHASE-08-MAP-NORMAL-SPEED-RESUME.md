# Phase 8 map normal-speed continuation — R3 attachment boundary

2026-10-03 UTC. HEAD remains `0c948451774efd10a293029e727b666758441436`. All inherited Phase 8 work is preserved; Web AGENTS/CLAUDE were not edited. No commit/push, DDL, Production access, original family media, Phase 7 re-review, Phase 9 work or global model/credit change. This record is **not Phase 8 completion**, independent security review or a full milestone gate.

## This turn's changes

- Added two actual DEV MySQL acceptance cases to `tests/integration/phase8-location.test.ts`: concurrent writers with different dataset versions preserve separate payloads and current-version reads; a same-version/current-generation payload conflict throws and preserves the conflicting row instead of overwriting it; country keyset pages return all options once and reject cursors after dataset/filter drift.
- Added `PHASE-08-LOCATION-DATA-OPERATIONS.md` with fixed v2 bundle hashes, dataset/policy semantics, attribution and bounded manual DEV update/backfill procedure. Synced the logical database reference with 0008. Copied the actual v2 manifest to `.cache/phase8-map/evidence/dataset-manifest.json`; obsolete v1 evidence must not be used.
- Formatted five inherited Phase 8 files reported by changed-file Prettier checks: map-provider test, contract location test, 0008 snapshot, journal and Phase 7 predecessor readiness artifact. Historical migration SQL 0000–0007 remain unchanged; this was formatting, not a schema redesign or Phase 7 audit.

## Fresh validation evidence

Files are under `.cache/phase8-map/evidence/`. These are this turn's executions, not the previous checkpoint's passes. Overlapping suites are not additive.

- `resume-typecheck.log`: API/Web/DB/Media/Worker typechecks all PASS.
- `resume-targeted.log`: 6 files / 23 tests PASS, including 7 location DEV MySQL tests, 5 metadata/native-driver DEV tests and projector/contracts/API/provider tests. Initial sandbox run failed to connect to local MySQL (EPERM); an approved escalation reran the command successfully. No skip is claimed as a pass.
- `resume-cas-cursor.log`: expanded location DEV MySQL suite 9/9 PASS, including the two new cases. First new-case run exposed fixture leakage from the intentionally conflicting row; cleanup was corrected and the suite rerun successfully. No production data was involved.
- `resume-browser.log`: 2 files / 21 browser tests PASS, including actual hosted OpenFreeMap and existing non-location search regressions. The single observed 404 diagnostic remains the pre-existing public favicon diagnostic. This does not add the still-missing explicit drag/zoom race case.
- `resume-web-build.log`: Web production build PASS, including both new location routes.
- `resume-changed-lint.log`: 38 changed/new TS/TSX/MJS files lint PASS.
- `resume-changed-format.log`: 47 changed/new code/config/CSS files format PASS after fixes; dataset JSON excluded to preserve pinned bytes.
- `git diff --check`: PASS. No new migration preflight or DDL was run; DEV integration suites each checked exact current migration readiness before test data writes.

## Concrete blocker: upload → automatic READY → visible map

`MetadataJobDriver` drives MEDIA_PROBE read-only and enqueues IMAGE_DERIVATIVES. The native acceptance test intentionally verifies that downstream job remains QUEUED, so it cannot prove new-upload map visibility. No non-test runtime instantiation of `ImageDerivativeProcessor` exists.

The existing processor constructor requires a READ_WRITE `StorageCapability`, CapacityGate, DerivedStore and renderer. The current `apps/worker/src/index.ts` opens exclusive Original/Derived writers for purge and explicitly refuses startup when an API writer is running. A new standalone derived driver cannot simply be started beside that API; mounting the processor into a writer owner requires an approved attachment and lifecycle plan. The read-only metadata driver has no writer to reuse. No new writer was opened this turn.

```text
R3_DESIGN_REVIEW_REQUIRED
Target: GPT-6 Astra Low
Reason: approve IMAGE_DERIVATIVES runtime attachment, exclusive writer ownership,
        startup/shutdown/recovery and unknown-outcome handling for DEV automatic READY
```

This is required by `PHASE-08-LOCATION-PROJECTION-GUARDRAILS.md` sections 1/4/6 and the checkpoint's Material remaining boundary, which forbid using the map slice to rebuild scheduling or alter writer ownership. The requested precise review should choose a minimal attachment using the existing processor, renderer, fences and storage coordination; it must not reopen old Phase 7 or approve a new distributed scheduler. Parent coordination must obtain this design decision before implementation continues on the blocked path.

## Remaining work (not claimed complete)

1. Approve and implement the runtime attachment, then prove actual synthetic upload API → native probe → derivative READY → authorized map. Do not replace this with hand-inserted COMPLETE uploads, GPS backfill or mocked READY.
2. Complete both-order barrier cases for backfill vs metadata/generation/GPS/trash-restore/purge/lease takeover, crash/commit-response-loss recovery, and explicit map drag/zoom stale response behavior. This turn added version isolation and cursor drift, not the complete race/crash matrix.
3. Parent's one independent scoped review, blocker fixes/re-review, then the full Phase 8 gate. Stop after Phase 8 for user evaluation; no phase-complete declaration or further phase without approval.
