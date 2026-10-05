# Phase 8 map / upload runtime implementation handoff

2026-10-04 UTC. HEAD remains `0c948451774efd10a293029e727b666758441436`. This is the implementation candidate for the existing map batch, not a new phase, independent safety approval, Phase 8 completion or Production readiness. No commit/push, migration, native rebuild, Production access, real family media, home ACL changes or Phase 9 work occurred. No credit reset/purchase was performed.

## Implemented approved boundaries

Implementation follows the location projection, derivative runtime attachment and upload pipeline reconciliation guardrails. Start-of-work file hashes and HEAD are in `.cache/phase8-map/evidence/pipeline-start-baseline.json`. Existing Web AGENTS/CLAUDE hashes match that baseline. Finalize service/repository, canonical creation, enqueue internals and historical migration SQL were preserved.

- `packages/db/src/upload-pipeline-reconciliation.ts`: bounded checked-connection high-water/page discovery of every COMPLETE receipt, one row per receipt via existing unique keys. Current locking observation uses family S → candidate receipt S → storage S → canonical media S → exact current probe S → downstream S when required. Validates receipt/K/storage/active/generation/recipe/metadata/job binding, preserves canonical source, and reports missing vs attached/inactive/terminal/invariant outcomes. No writes, marker or new schema.
- `apps/api/src/uploads/pipeline-reconciler.ts`: fixed-high-water serial rounds, page size 20, advance every result, 250ms page yield and 30s round cooldown. Acquires its own K L-S before observation, composes existing independent T1/T2 transactions, then observes final current facts. No outer transaction, finalize replay, job reset, generation bump, automatic placement or permanent per-item suppression. Unknown/unclassified DB/rollback/guard errors latch stop; confirmed rollback contention defers. Authorized restart observes facts before repair.
- `apps/worker/src/image-derivative-driver.ts`: explicit image-only serial claim/recovery using existing identities, attempts, epochs and fences. Borrows the API's writer/store/gate/reader and the existing registered native render path. Unknown or thrown DB errors stop until restart.
- `image-derivative-processor.ts` / `derived-admission.ts`: narrowed storage-only catches. DB errors from publishing/describe/confirmation/failure transitions propagate; DB errors from the currentLease callback are explicitly distinguished across createOwnedTemp. No error-message guessing or compensating FAILED write after DB failure. Existing L/R/capacity/fence semantics are unchanged.
- `apps/api/src/index.ts`: opt-in `DEV_MEDIA_PIPELINE_ENABLED=1`, validated DEV/non-root/current schema/READ_WRITE/namespace/resources before any claim. Starts both loops after listen. Signal/fatal/startup/listen failure stops selection, drains work and requests, then closes DerivedStore → reader → shared gate → root → pool. Cleanup errors remain fatal with fixed safe categories.
- Built API and metadata start commands use the existing workspace `tsx` loader: package exports include TypeScript parameter properties, so Node strip-only execution refused before startup. Built/native acceptance verifies actual package resolution and fixed renderer paths, not merely tsup output.
- `location-map.tsx`: an initial basemap load that never settles now falls back after 15 seconds, releases the map, retains local region browsing and offers explicit retry. Local camera stale-response testing uses a deterministic empty style; it does not stand in for the separately retained real hosted-provider test or real upload acceptance.

## DEV running contract

The default switch is 0 in `.env.example`; no real `.env` was edited or persistent service started. With the explicitly configured DEV database, synthetic-only media root/marker and pinned `LOCATION_DATA_DIR`, build DB/API/worker, then run from repository root:

```sh
DEV_MEDIA_PIPELINE_ENABLED=1 node --env-file=.env --import tsx apps/api/dist/index.js
node --env-file=.env --import tsx apps/worker/dist/metadata-main.js
```

API owns the sole writer; metadata is a separate read-only Original driver. Do not start the purge entry point beside that writer. Finalize still returns a durable COMPLETE receipt, not a promise of READY. Canonical/probe attachment and derivative completion are asynchronous. A fatal/unknown operation shuts down the owner; explicitly restart to reconcile current facts. READY media appears only after existing authorized album placement, with unchanged ACLs. No new automatic sharing is introduced.

## Fresh evidence

Evidence is under `.cache/phase8-map/evidence/`; overlapping runs are not additive.

- `pipeline-final-targeted.log`: **12 files / 60 tests PASS, skip=0**, final combined selection of reconciliation/loop/driver/failure/unit/API/projector/contracts/provider and live DEV upload/worker/metadata/location suites.
- `pipeline-real-upload.log`: five live DEV/native cases PASS before the final combined run. The complete chain uses real authenticated TUS POST/PATCH/finalize, persists COMPLETE with no media, SIGKILL before attachment, committed T1 interruption, authorized fresh built API restart, runtime probe scheduling, actual native metadata process, both derivative READY assets, then existing POST album/placement and authorized map/gallery. Original bytes/SHA-256/inode unchanged. A second uploader deduplicates into the same canonical source and receives zero CUSTOM-map visibility.
- Physical-connection commit seams cover T1 and T2 committed and rolled-back response-loss outcomes. Same worker makes no replay; a new worker's locking observation skips committed operations or repairs proven absence. No media/job/READY/placement was hand-inserted in the actual upload E2E. Other targeted lifecycle/fault fixtures legitimately use controlled DB mutations.
- Native L-X contention returns DEFERRED before media creation; another test proves L-X waits across T1/T2 until reconciliation L-S releases. Already inactive yields zero enqueue, restored unstarted generation repairs, unsupported recipe rejects, existing FAILED remains terminal. Separate writer/missing namespace refuse before claims; listen failure releases writer handles; normal SIGTERM exits 0.
- `pipeline-projection-races.log`: seven metadata/native cases PASS, including both real media-lock acquisition orders between backfill and same-generation metadata replacement; newest projection wins or stale token writes zero. Committed/rolled-back projection response loss recovers by fresh scans, with no replay of committed writes.
- Existing `phase4d3c-worker` targeted suite plus one new thrown-publishing-DB case PASS in combined run: L/R behavior, stale leases/generation/lifecycle, publication and READY unknowns, final integrity, and no compensating media failure on thrown DB error. This is regression reuse, not an old Phase 7 re-review.
- `pipeline-typecheck.log`: API/Worker/DB/Media/Web PASS. `pipeline-build.log`: DB was rebuilt, API/Worker build PASS. Web final typecheck/build evidence is recorded separately after the basemap deadline change.
- `pipeline-changed-lint.log` / `pipeline-changed-format.log`: 49 changed/new code files lint and 58 code/config files format PASS before the last two fault tests and basemap timeout; `pipeline-last-lint.log` / `pipeline-last-format.log` cover those subsequent edits. Pinned dataset bytes are excluded from formatting. `git diff --check` PASS.

## Browser provider limitation — not silently passed

Earlier this turn `pipeline-map-movement.log` had all six map tests PASS using the actual hosted style, and previous browser logs retained successful real external loading/privacy checks. Later final/retry attempts repeatedly stalled on hosted OpenFreeMap load, before any timeout patch; the Mac exec transport also briefly disconnected and recovered. These failures are preserved in `pipeline-browser.log` and `pipeline-browser-retry.log`.

After adding bounded fallback, `pipeline-browser-final.log` reports **22 PASS / 1 FAIL (23 tests)**. Deterministic drag→zoom stale response, stalled-provider fallback, disabled/failed provider, auth/actor/close/URL behavior and existing search regressions passed. The remaining failure is specifically the real hosted successful-load assertion: it received the intended “底图暂不可用” fallback rather than a loaded map. This is not counted as a success or skipped. External requests canceled on the deadline are expected diagnostics in that failed hosted-load attempt. No provider was substituted, no OSM fallback/account was created and no batch tile downloads were performed.

## Parent handoff / remaining completion work

There is no newly identified R3 design blocker. The new upload runtime gap is implemented and actual native upload-to-READY-to-map has passed. Parent should perform the one independent scoped implementation review, fix/re-review blockers, then run the unified Phase 8 final gate. Phase 8 is not declared complete here.

Current hosted-provider successful-load validation needs a working external service/network window for a fresh final-gate result; retain the failure evidence rather than treating deterministic camera/fallback tests as that proof. The targeted matrix above does not claim exhaustive real power-loss/SSD-disconnect, production, every purge-retirement/backfill barrier, or stop at every native renderer/publication instruction boundary. Those must be assessed explicitly in review/final acceptance rather than inferred from fixture/helper tests. No automatic next phase, tag, commit or deployment is authorized.
