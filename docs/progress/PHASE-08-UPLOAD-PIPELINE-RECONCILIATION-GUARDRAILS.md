# Phase 8 upload pipeline reconciliation — approved bounded design

2026-10-04 UTC. GPT-6 Astra / Low delegated design review; HEAD `0c948451774efd10a293029e727b666758441436` with inherited uncommitted Phase 8 work preserved. **APPROVED_FOR_IMPLEMENTATION** for the single patch plan below. This resolves the upstream design blocker recorded in `PHASE-08-DERIVATIVE-RUNTIME-ATTACHMENT-GUARDRAILS.md`; that document's derivative attachment, ownership, shutdown, exception and storage constraints still apply. Neither implementation nor end-to-end validation has passed by this approval.

Only this document was added. Source review only: no implementation/other-document edits, tests, migration, native rebuild, service execution, media access, home ACL changes or Git writes. No new schema, durable marker, intent table, job type, service process or transaction replacement is needed.

## 1. Source findings and adopted correction

`apps/api/src/uploads/service.ts:376` and `:442` return an already COMPLETE receipt; `:538` calls `completeFinalize`, cleans staging and returns. Its L-S occupancy at `:434` ends in `finally` at `:564`; a later background task does not inherit that guard. `packages/db/src/upload-repository.ts:866` owns its transaction and its final mutation at `:968` writes COMPLETE plus storage identity, then returns without creating media/jobs.

`packages/db/src/media-repository.ts:105` owns a separate checked transaction: family SHARE → receipt SHARE → storage SHARE, then canonical lookup/insert. Existing canonical media is returned with its original `sourceUploadId`; a trashed item can be returned, while a purge intent is rejected. `job-repository.ts:122` owns another transaction: family SHARE → media UPDATE → exact job identity; `lockMedia` at `:510` rejects inactive media and enqueue checks current generation/recipe. Existing job identity is returned without resetting its state/attempts. These are independently committed operations, not one externally wrappable transaction.

`metadata-repository.ts:193`–245 already commits metadata, location projection, downstream job insertion and probe completion together. Do not split or reconstruct this boundary. `transaction.ts:77`–100 destroys a connection on unknown COMMIT, discards rollback failure and only retries known pre-COMMIT deadlocks. `purge-execution.ts:312`–340 deletes media/jobs and retires all matching COMPLETE receipts to RETIRED while detaching storage; reconciliation must respect that durable terminal transition.

The test helpers in `phase8-location-metadata.test.ts:174`–225 and `phase4d3c-worker.test.ts` explicitly create receipt/media/job fixtures. They remain useful targeted tests, but are not runtime API upload evidence.

Decision on the supplied web plan:

| Proposal | Decision |
| --- | --- |
| Compose existing repositories | Adopt; sequential independent transactions, no outer transaction claim. |
| Durable restart catch-up for A: COMPLETE/no media and B: media/no probe | Adopt using existing authoritative rows, including old COMPLETE receipts. |
| New attachment intent written after COMPLETE | Reject: crash between those commits loses discovery. No intent is needed. |
| Require a new marker / PIPELINE_ATTACHED column | Reject: redundant state creates another reconciliation problem. PIPELINE_ATTACHED is an observed result defined below. |
| Scan only missing-media receipts or NULL new markers | Correct: discovery covers every COMPLETE receipt and classifies its canonical media/current probe; no new-column predicate. |
| Retry the lowest IDs until successful | Correct: fixed-high-water keyset rounds advance past every result, including refusal. |
| Reuse finalize's L-S | Correct: catch-up must acquire its own L-S before authoritative reads and mutations. |
| Require canonical source = current dedup receipt | Reject: preserve the earlier legitimate canonical source. |
| Treat job existence/COMPLETE as processing success | Reject: validate binding, lifecycle, generation, recipe and job state; attachment is not READY. |

## 2. One runtime owner and bounded discovery

Add a serial `UploadPipelineReconciler` owned by the existing API process, borrowing the validated READ_WRITE root and DB pool. Run only under the same explicit DEV pipeline enablement and DEV identity/readiness checks approved for the derivative attachment. No new Original writer or purge process; metadata remains the existing read-only driver. Reconciler stop/drain participates in the same API shutdown before shared resources close. Its DB-only mutations need no renderer, R lock or CapacityGate.

Do **not** modify upload finalize or its COMPLETE retries to await processing, insert an intent, fire a promise or change the response contract. The persisted COMPLETE receipt itself is the discovery authority. Start reconciliation after successful API listen and immediately on each authorized restart; no client retry is needed for recovery.

New repository discovery API:

```ts
readUploadPipelineHighWater(): Promise<string | null>
listUploadPipelinePage(input: {
  afterId: string; throughId: string; limit: 20;
}): Promise<readonly UploadPipelineCandidate[]>
```

Use canonical unsigned-BIGINT strings, never JS Number. High water is the current maximum `upload_sessions.id` (including non-COMPLETE rows); empty database starts an idle round. Page query is nonlocking, checked-connection, ordered by receipt primary key: `u.state='COMPLETE' AND u.id>? AND u.id<=? ORDER BY u.id LIMIT 20`. Left-join canonical media by **family + storage_object_id**, and current MEDIA_PROBE by family/media/generation/recipe/type; cardinality must remain one row per receipt via existing unique keys. Return only internal IDs, state/fence/identity fields and classification data, not private filenames/GPS or raw errors. Include the fields needed to distinguish unavailable storage, inactive canonical media, metadata generation and current job state. These observations are hints, never mutation authority.

Advance `afterId` to **every returned receipt ID before processing it**, including rejected/deferred/already-attached rows. Stop the round when a page is empty; wait 30 seconds before starting the next round at zero with a fresh high water. Yield an interruptible 250 ms between nonempty pages; one page and at most one candidate operation are in flight. No immediate retry of a candidate in the same round. No per-receipt in-memory retry/suppression map, persistent cursor, or exponential collection of failures.

A receipt whose lower ID becomes COMPLETE after its page was passed is caught in the next round. New IDs above high water cannot extend the current round indefinitely. Restart resets the cursor to zero, so a crash after cursor advance cannot lose work. Under an available DB and finite lock waits, a bad low ID cannot starve later IDs. A steady run processes a finite high-water prefix before restarting; repeated external kills are not promised starvation-free progress. Full read-only scans are acceptable for this repository's roughly 10k-item scale; each query/action is bounded, and no success writes are repeated.

Old COMPLETE receipts are included regardless of age and without a marker condition. Existing schema requires COMPLETE storage/hash/size/time fields (`schema.ts:635`–640). If a returned legacy/corrupt row nevertheless lacks an identity field, classify `INVARIANT_REJECTED`; do not invent a hash, create a marker or silently call it attached. Old NULL **attachment-marker** values require no special branch because no such marker is introduced.

## 3. Authoritative observe-and-repair contract

Add one small DB repository for discovery and a **read-only, locking observation**:

```ts
observeUploadPipeline(input: {
  familyId: string; uploadId: string;
  expectedStorageObjectId: string;
  expectedSha256Hex: string; expectedByteSize: string;
}): Promise<UploadPipelineObservation>
```

The API reconciler first derives K = family/hash/size from discovery, acquires `new ContentCoordination(root,K).acquireLifecycle('S',30_000)` with **no SQL transaction held**, and keeps that L-S until the candidate is finished. Invalid/missing K is rejected before OS acquisition. A native acquisition timeout defers this candidate; namespace/root identity/integrity refusal stops this enabled reconciler rather than adopting or repairing a root.

Each observation uses `runCheckedTransaction` and locking/current reads in this exact order: **family SHARE → candidate receipt SHARE → storage SHARE → canonical media SHARE (unique family/storage key, including absence) → current MEDIA_PROBE SHARE (unique job identity, including absence)**. No SQL locks survive the method return. It checks receipt is COMPLETE with matching offsets/hash/size/completedAt, same family/storage identity as the caller's K, storage AVAILABLE/key version 1, and canonical identity if present. It returns lifecycle revision, active status, sourceUploadId, media ID/current generation/recipe/processing state/metadata generation, and exact current probe identity/state if present. Unknown reads, missing identity or contradictions produce no repair authority. Treat absent family/retired receipt/key changed as stale/not-applicable, not permission to follow a different K while holding the old guard.

The canonical source may be a **different** completed receipt. Preserve it and its uploadedAt/timelineKey; require the existing family/storage/source referential binding, not equality to the current candidate receipt. If an additional source-receipt consistency read is used, make it nonlocking while L-S is held; do not acquire a late source receipt row lock after media/job locks. L-S excludes the established retirement/purge transition, and the existing composite source FK binds that source to the same family/storage. Do not repair source identity or link a second family.

Then perform exactly these steps, without an outer SQL transaction:

1. **Observation** under L-S. If inactive, unavailable, retired, attached, terminal or contradictory, return the corresponding result below without mutation.
2. **A: no canonical media.** Call existing `MySqlMediaRepository.createOrGetCanonicalMedia({familyId,uploadId})` once. It independently commits T1. Do not assume `created=true`, or overwrite the winner's source. Re-observe under the same L-S using a new checked transaction. Validate K/identity again and use the observed current media, not stale discovery or return data. This also handles a concurrent legitimate dedup caller.
3. **B: canonical active media with no current probe.** Repair only an unstarted generation: `processing_state='PENDING'`, recipe 1, and metadata_generation NULL or less than generation. Call existing `MySqlJobRepository.enqueue({familyId,mediaId,generation,recipeId,jobType:'MEDIA_PROBE'})` once with the freshly observed generation/recipe; this independently commits T2. Current job absence for READY/PROCESSING/terminal media or current metadata is an invariant rejection, not authorization to rerun metadata and overwrite its downstream work.
4. **Final observation** under the same L-S in a fresh checked transaction. Return the observed result only; enqueue's return or absence of an exception alone is not PIPELINE_ATTACHED. Then release L-S. A current generation/recipe change means stale/deferred; no immediate second enqueue attempt. The next round observes current state and can repair only the unstarted-generation predicate above.

T1 and T2 are intentionally not atomic together. Durable A/B discovery closes their gap. Do not hold observation SQL locks while invoking either repository, call them with a connection already in a transaction, or change their existing lock order. Native sequence is API writer lifetime ownership → K L-S → one independent checked transaction at a time. There is no R/CapacityGate acquisition in this reconciliation. Existing T1: family S → receipt S → storage S → canonical lookup/insert; existing T2: family S → media X → current job. The observer's media/job locking reads also wait for an earlier committing insertion before accepting presence or absence.

No new lease/epoch belongs to attachment. New queued jobs get repository defaults; actual processors retain their existing worker identity, lease epoch, expiry and lifecycle fencing. Never bump generation/lifecycle, reopen a job, reset attempts, change availability or directly write media READY.

## 4. Result semantics and convergence

These are internal outcomes/counters, not a new API field or database column:

| Result | Required meaning / next action |
| --- | --- |
| `PIPELINE_ATTACHED` | Fresh final observation proves valid COMPLETE receipt/storage binding, active canonical media, current generation/recipe and exact current MEDIA_PROBE identity. Include observed `jobState` and progress; QUEUED/RETRY_WAIT/RUNNING mean durable scheduling only. Expired RUNNING remains attached but needs existing lease recovery. |
| `PIPELINE_ATTACHED` with probe SUCCEEDED | Additionally require metadata_generation=current and the existing same-generation/recipe downstream identity for detected IMAGE/VIDEO. Observe it after the probe row in the same read transaction. Absence/contradiction is invariant rejection; do not recreate downstream work. This still does not imply derivative READY or visibility. |
| `PIPELINE_TERMINAL_FAILED` | Exact current probe exists in FAILED. Preserve it; attachment attempted and ended, not a success. Never enqueue another identity or reset/retry it here. |
| `LIFECYCLE_INACTIVE` | Canonical trashed or purge intent exists: zero media/job writes. A later restore can make it eligible in another round; purge retirement removes it from COMPLETE discovery. No permanent in-memory tombstone that hides a restore. |
| `NOT_APPLICABLE` / `STALE` | Receipt retired/removed/no longer COMPLETE or K/current generation changed. Do not follow new identity under old L. Continue cursor; re-discover normally. |
| `INVARIANT_REJECTED` | Identity/source/storage mismatch, invalid COMPLETE fields, unsupported recipe or contradictory current processing/job state. No repair writes and no success claim; bounded aggregate safe diagnostics. |
| `DEFERRED` | Bounded L contention or confirmed rolled-back transient SQL contention. Advance cursor; next round is at least 30 seconds after the prior round ended. |

Fast discovery classifications may skip obviously attached/terminal/inactive rows without locking; they are not authoritative success reports. If reporting exact per-candidate success, take the locking observation. Never mutate from the discovery join alone. Concurrent changes missed by a skip are covered by the next round.

Permanent refusals converge to **no repeated mutation**: RETIRED leaves discovery, inactive/terminal/invalid rows are read-classified and skipped in later rounds. They can still incur one bounded read per round, with no hot retry, per-item log flood or unlimited memory. Log aggregate counts and fixed categories, no receipt filenames, GPS, tokens, raw DB errors or media paths. Do not create artificial FAILED jobs merely to remember attachment rejection.

The background task confers no new user permissions or album placement. Canonical creation does not grant sharing/visibility, and legal dedup must not switch attribution to a later uploader. Final gallery/map acceptance must use the existing authorized album-placement API, then existing READY/ACL/location predicates; do not insert `album_media` directly or add automatic public placement in this patch.

## 5. COMMIT unknown, crash and retry rules

- A crash before T1 leaves A; after T1/before T2 leaves B; after T2 leaves a current durable job. All are discovered without a newly committed marker. Crash after COMPLETE/before any wakeup is also A.
- Any `CommitOutcomeUnknownError`, rollback failure, connection-state uncertainty or unclassified DB error stops this reconciler's mutation loop, emits a fixed category and drains/releases its L guard. It performs no compensating delete, FAILED write, cursor persistence or immediate replay. Let the owner's established fatal/shutdown handling surface the stop; no hidden automatic catch-and-continue on uncertainty.
- On an explicit authorized process restart, begin with discovery and the **fresh locking observation**, not the saved old operation. Observation waits on the relevant unique media/job key; an unresolved lock/DB outcome is not absence. If current state proves T1 committed, skip T1 and consider B. If T2 committed, report its actual current state and do not enqueue. Only a conclusive new observation of A/B allows a new idempotent attempt. This is state reconciliation after observing facts, not replay of the uncertain transaction. A crash/restart before any local error flag is recorded follows exactly the same rule.
- Existing confirmed pre-COMMIT deadlocks remain subject to the transaction helper's bounded retries. After the helper has successfully rolled back, exhausted deadlock or lock-wait timeout may be categorized by the existing DB error predicates as DEFERRED and advance to the next candidate. Never classify an unknown/rollback-failed wrapper as transient by its underlying message. Typed repository NOT_FOUND/CONFLICT after concurrent state change defers; binding/storage violations reject or become inactive on a later observation, with no same-round write retry.
- Completed-upload HTTP retries still only verify/return COMPLETE. They do not reset job state or synchronously reconcile. Reconciliation success cannot retroactively change whether Original finalize committed.

## 6. Concrete patch boundaries

1. Add `packages/db/src/upload-pipeline-reconciliation.ts`: typed bounded discovery/high-water/current-locking observation and result types. Export from `packages/db/src/index.ts`. Reuse checked connection/transaction helpers, active-media predicate and ID conventions. No writes in this repository; no migration/index/schema addition.
2. Add `apps/api/src/uploads/pipeline-reconciler.ts`: the serial high-water loop, K L-S occupancy, T1/T2 composition and stop/drain contract above. Inject repository interfaces and a bounded wait/coordination seam for targeted tests. Production defaults use actual native coordination and DB; no test bypass enabled by runtime config.
3. Update `apps/api/src/index.ts` only for constructing/starting/draining this reconciler with the already-approved derivative runtime, sharing the API owner resources. The earlier derivative driver and its narrow processor exception fix remain approved in the previous document. Do not import purge worker entry-point side effects.
4. Add targeted DB/reconciler/native runtime acceptance tests. Package/build declarations may change only as necessary for those composition modules. Leave upload service/repository, canonical creation/enqueue internals, metadata atomic transaction, schema/migrations, native locks, map/ACL policy and existing documents untouched for this ingress patch.

This is one executable implementation plan; no further ingress architecture selection is left to Sol. Deviating to a marker, new transaction protocol, lifecycle semantics or reprocessing policy is outside this approval.

## 7. Required targeted validation after implementation

| Case | Required evidence |
| --- | --- |
| A and legacy discovery | Real API creates COMPLETE with no media; crash before any reconciler call; restart creates one canonical and one probe. Include pre-existing COMPLETE rows, no marker dependency, invalid identity/NULL rejection. |
| B crash window | Pause/kill after committed T1 before T2; restart finds media with no current probe and enqueues once. No hand-created media/job in the actual upload E2E. |
| Unknown T1/T2 | Inject lost COMMIT response for committed and rolled-back outcomes. No same-attempt compensation/replay; loop stops. Restart locking observation skips committed operations and safely repairs only proven absence. Unresolved observation causes no write. |
| Dedup/source | Two real COMPLETE receipts for one family/K race/restart: one canonical and one current probe; original canonical source/uploadedAt unchanged. Later uploader receives no new ACL/placement through reconciliation. Same bytes in different families stay separate. |
| Lifecycle barriers | Discovery → Trash before L acquisition; T1/T2 with Trash waiting for L-X; already trashed, restore next round, purge intent, purge retirement and missing storage. No resurrection or job enqueue for inactive canonical media; RETIRED never reconstructed. |
| Generation/recipe | Change between observation and enqueue; stale enqueue rejects, next round uses new observed generation only if unstarted predicate holds. Unsupported recipe/current-metadata-with-no-job rejects. Existing FAILED/SUCCEEDED/expired RUNNING jobs are never reset. |
| Fairness/backoff | More than two pages; poisoned low IDs, L timeout, typed transient rollback, attached/inactive records; later candidates progress. Lower ID completes after cursor passes; continuous higher-ID inserts; next round catches old gaps. Fixed limits/cooldowns, bounded memory, stop during idle/operation. |
| Real pipeline | Owned synthetic GPS image via actual authenticated upload/finalize API → runtime canonical/probe → existing native metadata/projection/downstream enqueue → approved native derivative runtime → READY; authorized existing album placement API → map/gallery result. Original bytes/hash/inode unchanged. No seeded COMPLETE/media/job/READY/placement shortcuts. |
| Shutdown/build | Both background loops stop claims/work selection and drain before reader/gate/store/root/pool closure; startup/listen failure cleans up. API/worker build uses actual fixed native binaries. |

Run affected package typechecks/build and changed-file lint/format plus targeted DEV MySQL/native tests with skip=0; no full gate as part of this design task. Full Phase 8 validation and independent implementation review remain parent-owned completion work. Video processing, production deployment and the next Phase are not approved by this document.
