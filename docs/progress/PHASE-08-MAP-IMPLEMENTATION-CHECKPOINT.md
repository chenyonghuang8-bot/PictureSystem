# Phase 8 map implementation checkpoint — paused for normal-speed continuation

2026-10-03 UTC. User requested stopping at the next safe boundary to continue without Fast mode. Implementation paused; no rollback, commit, push, Production operation, model-setting change, credit redemption or Phase 9 work. HEAD remains `0c948451774efd10a293029e727b666758441436`. Existing Phase 8 changes and untracked `apps/web/AGENTS.md` / `CLAUDE.md` were preserved. This is NOT Phase 8 completion or independent security closure.

## Implemented working-tree slices

- Existing approved 0008 projection schema/journal/snapshot, metadata invalidation/insertion and purge child cleanup were retained. Added a restricted CHECK parser equivalence for MySQL's `REGEXP` → `regexp_like` rendering. Existing DEV had all nine journal entries and physical 0008; this turn performed no DDL replay. Preflight result: `PHASE8_ALREADY_CURRENT_NO_DDL`.
- `packages/media/src/location-projection.ts`, `location-map.ts`: fixed H3 res6 cell, cell-center country/city, logical-parent aggregation, dateline bbox, bounded zoom, complete adaptive <=500 clusters, coverage and polar counts.
- Full real normalized dataset in `resources/location/2026-10-03/`: countries.json, cities.json, manifest.json; 258 country features and 171102 GeoNames cities. Sources/licenses/checksums are in the manifest. The draft importer initially retained DBF trailing NUL padding, mapping every country to unknown. Corrected importer and regenerated normalized files under `naturalearth-iso-a2-eh-geonames-cities1000-v2-dbf-null-padding`; dataset version changes accordingly. Earlier cached v1 manifest evidence is obsolete. Runtime performs no downloads.
- `packages/db/src/location-projection-repository.ts` and `scripts/backfill-location-projections.ts`: bounded DEV-only dry-run/apply CAS backfill with existing family→storage→media→projection order.
- `packages/db/src/album-repository.ts`: `locationFamilyMedia` / exported `buildFamilyLocationQuery` reuse existing full ACL/filter SQL without a media LIMIT before aggregation, distinct media, exact current generation/policy/dataset join, no exact GPS DTO. Service uses location rows for filtered search keysets and map/region aggregation.
- Contracts/API: strict location filters (`located`, `unknown`, `no-city`, country, city, logical cell); bounded bbox/zoom; `/search/map`, `/search/locations`; paginated region options; location and fixed dataset/policy bound search cursor scope. API startup uses optional `LOCATION_DATA_DIR`; invalid/unconfigured location fails closed without disabling ordinary non-location search.
- Web: location filter/URL roundtrip, MapLibre panel, country/nearby-city lists and drilldown, polar/coverage notices, local count markers, stale-request cancellation, close/actor/auth loss handling, provider-disable/failure fallback. Basemap requests restricted to configured HTTPS origin with same-origin credential mode and no-referrer. No geocoder, remote private GeoJSON, or OSM fallback. Official MapLibre 6.11.2 module worker + shared module are copied locally by `apps/web/scripts/prepare-map-worker.mjs` during dev/build; generated public files are ignored, license copied. Dependency/lock changes retained and extended for API media + worker mysql2.
- `apps/worker/src/metadata-driver.ts` / `metadata-main.ts`: real non-test, read-only Original DEV MEDIA_PROBE driver using existing typed claims/epochs/recovery and native capability checks, injected current projector. Any DB failure, including unknown commit, terminates without compensation/replay. Does not modify the purge entry point or add writer ownership.

## Verified evidence (targeted; overlapping suites are not additive)

All evidence below lives in `.cache/phase8-map/evidence/`.

- `migration-preflight.log`: current nine-entry schema/history readiness PASS, no DDL.
- `projector.log`: six tests PASS, including actual five-country dataset labels, same-cell invariance, <=50km/tie, ambiguous/unknown, checksum mismatch, dateline/polar and complete 10k global aggregation.
- `location-mysql.log`: seven DEV tests PASS: CAS/concurrent NOOP, ACL/filter/map/region consistency, no admin bypass, stale generations/GPS/lifecycle, current-version masking, FK/CHECK, trash/restore, 10k SQL EXPLAIN and count dedup. Later test-source import/lint cleanup has not been rerun on MySQL.
- `location-10k.json`: 10000 synthetic media / five members, 5001 authorized located media, identical total cluster count, 84.88ms observed query+aggregate, actual EXPLAIN and EXPLAIN ANALYZE retained. This is one DEV observation, not a production SLA.
- `location-metadata.log`: five DEV tests PASS: atomic metadata/projection/job, clearing empty snapshot, old lease/generation, rollback on projection-write validation, deferred compute failure, actual queued native MEDIA_PROBE extracting synthetic JPEG GPS with immutable Original bytes. It leaves IMAGE_DERIVATIVES QUEUED; does not prove automatic READY.
- `location-api.log`: three map/region route tests PASS, strict inputs, coarse whitelist/no-store, full filter forwarding, region response and invalid cursor. Latest mock typing correction has not been rerun through API typecheck.
- `browser-regression.log`: latest running command completed naturally, exit 0; two files / 21 tests PASS (five map tests plus 16 existing non-location search tests). Includes styled actual hosted OpenFreeMap loading, local worker, privacy request capture, provider failure and disable, country/city drilldown/URL back, close/actor stale response and auth loss. Earlier `location-browser.log` is superseded by this latest pass. `basemap-requests.json` and `basemap.png` were captured by the hosted-map test; a public favicon 404 was the sole captured console diagnostic, not a basemap failure.
- `web-build.log`: Next production build PASS, new routes included. This build precedes final provider-error cleanup; rerun the relevant build when resuming.
- API/Web/DB/Media/Worker package typechecks were run. Web/DB/Media/Worker passed; API's last run failed on the new test mock typing and was corrected afterward, pending rerun. Do not label the aggregate typecheck PASS yet.
- An unnecessary all-source `tsconfig.vitest` check exposed existing mixed DOM/Node/test typing errors; not treated as the project gate. New importer geometry narrowing was corrected afterward. Partial targeted eslint/format runs passed after fixes, but no final all-changed-files check yet.

## Material remaining boundary

The approved guardrails explicitly state the repository lacks a non-test metadata driver and forbid rebuilding all media scheduling or changing writer ownership in this location slice. The MEDIA_PROBE driver is now real and tested, but visible album placement depends on IMAGE_DERIVATIVES reaching READY. No existing non-test derived scheduling entry point was found. Therefore **new upload → automatic visible map has NOT been demonstrated**. A test or backfill must not be used to claim that contract complete.

Before integrating the missing automatic READY path, obtain Astra guardrails for the actual runtime attachment / writer ownership if it requires changing the approved storage or scheduling model. Do not start/repurpose purge worker and call that a complete media pipeline. Preserve the existing lock/fence/storage invariants.

## Resume checklist

1. Read this checkpoint + location projection guardrails, confirm HEAD/diff, keep local Web AGENTS/CLAUDE intact. Continue ordinary speed; no global model/usage setting changes.
2. Recheck only final changed-file format/lint, API mock typing, affected package typechecks/build. Refresh the copied evidence manifest from the actual v2 resource manifest before packaging records.
3. Extend missing targeted acceptance: explicit drag/zoom stale responses, region pagination/cursor version drift, full backfill-vs-metadata/version/purge barrier matrix and compute/write/commit crash/unknown outcome recovery. Current tests are useful but do not cover the entire requested matrix. Add operator-facing fixed dataset checksum/license/manual update instructions and schema reference updates.
4. Resolve the real automatic READY runtime gap within approved guardrails (or request the precise R3 review). Then run actual upload→probe→READY→map acceptance with owned system-tmp synthetic fixtures; no true media/home ACL changes.
5. One scoped independent review, fix/re-review blockers, then and only then the full Phase 8 milestone gate. Stop after Phase 8; no tag/commit/push/Production/Phase 9 without authorization.

Final known command: `pnpm exec vitest run apps/web/components/gallery/location-browser.test.ts apps/web/components/gallery/search-browser.test.ts --reporter=dot`, completed exit 0. No new tests were started after the user's stop message. A temporary schema-inspection script created this turn was removed; saved read-only evidence remains. No implementation was rolled back.
