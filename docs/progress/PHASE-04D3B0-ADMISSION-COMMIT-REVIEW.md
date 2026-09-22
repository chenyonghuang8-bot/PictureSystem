# Phase 4D3b-0 — Capacity Admission Deadline / Reservation Commit Boundary Review

Status: **R3-DESIGN APPROVED; implementation and runtime qualification pending.**

This decision resolves admission deadlines, reservation outcomes and cross-process coordination only. It amends the capacity protocol in [Phase 4 Guardrails](PHASE-04-GUARDRAILS.md) §§12–13 and [D3 Guardrails](PHASE-04D3-GUARDRAILS.md) §§16–17. The [boundary review](PHASE-04D3A2-D3B-BOUNDARY-REVIEW.md) and [deterministic naming decision](PHASE-04D3B0-TEMP-NAMING-REVIEW.md) otherwise remain authoritative. It authorizes an implementation sequence, not writes, provisioning or tests in this review.

## 1. Decision

```text
STRICT_TIMEOUT_IMPLIES_NO_RESERVATION: NO
DEADLINE_EXCEEDED_IMPLIES_NO_TEMP_FOR_THAT_ADMISSION: YES
CAPACITY_LOCK_MUST_COVER_COMMIT_OUTCOME: YES
DB_SESSION_CAPACITY_BARRIER_REQUIRED: YES
PROVISIONAL_CAPACITY_CHANGES_SAFE_TO_KEEP: YES — unfinished foundation only
DESIGN_CHANGE_REQUIRED: YES — approved bounded-outcome/cross-process lock extension
GUARDRAILS_CLARIFICATION_REQUIRED: YES — timeout is not proof of rollback
SCHEMA_CHANGE_REQUIRED: NO
DATABASE_MIGRATION_REQUIRED: NO
NEXT_IMPLEMENTATION_STAGE: Phase 4D3b-0, admission transaction contract first
READY_TO_RESUME_PHASE_4D3B0: YES
P0_DESIGN_BLOCKERS: 0
P1_DESIGN_BLOCKERS: 0
```

The two-second interpretation alone clarifies the existing conservative COMMIT-unknown rule. The complete decision also adds a database-session capacity barrier to make bounded OS-lock release and process death safe. That is a real, narrowly approved lock-protocol extension, so the overall `DESIGN_CHANGE_REQUIRED` is YES. No identity, state enum, schema, original lifecycle or SQL retry policy is changed.

## 2. Local evidence and exact conflict

- `packages/storage/src/index.ts :: CapacityGate.withLock`: starts `performance.now() + 2_000` before the local queue, obtains the native nonblocking lock, awaits the whole callback, checks the deadline after it returns, then unlocks in `finally`. It does not currently cancel a stuck callback, distinguish committed/absent/unknown, or provide an outcome-resolution budget.
- `packages/db/src/transaction.ts :: runTransaction`: awaits the SQL callback, then sends COMMIT, then releases the connection. Exceptions in the COMMIT phase destroy the connection and become `CommitOutcomeUnknownError`; rollback failure becomes `TransactionRollbackFailedError`. Three total deadlock attempts and existing bounded jitter remain the only SQL retry engine.
- `packages/db/src/connection.ts :: runCheckedTransaction` and `acquireCheckedConnection`: own DB health, UTC and strict-mode checks. No deadline/commit result protocol is currently exposed to storage.
- `packages/db/src/bootstrap.ts :: acquireBootstrapConnection/releaseBootstrapLock`: already use a session-owned `GET_LOCK` through the existing transaction runner's acquire/release/destroy hooks. This is a reusable layering pattern, not permission to run bootstrap or reuse its lock name.
- `packages/db/src/media-repository.ts`, `job-repository.ts`, `metadata-repository.ts`: preserve exact identity, family scope, lock order, generation/epoch and server-time-after-lock checks. These checks remain prerequisites, not substitutes for a global capacity barrier.
- `packages/db/src/schema.ts :: derivedAssets`: existing identity UNIQUE, producer job/epoch, RESERVED, fixed-cap `reserved_bytes` and `cleaned_at` can represent retained reservations. A new late/unknown DB state is unnecessary.
- `apps/api/src/uploads/service.ts :: create`, `packages/db/src/upload-repository.ts :: admissionUsage`: upload admission currently uses local serialization and DB/statfs accounting. All upload admission must join the approved shared protocol before derived writes are enabled.

The original nesting was not inherently wrong: if the entire repository promise is awaited inside `withLock`, the OS lock does cover COMMIT. The missing pieces are outcome classification, bounded cancellation and cross-process safety when the process/OS lock disappears while MySQL is still resolving the transaction. Checking the elapsed time after the callback cannot undo a successful COMMIT.

Strict timeout => absent is impossible once COMMIT can have reached the server. A lost ACK, client timeout, successful later ROLLBACK or socket destruction is not proof that the earlier COMMIT failed.

## 3. Final two-second rule

Use one monotonic admission deadline, starting before local serialization and never reset by retries. Its two seconds include local queueing, OS-lock acquisition, DB connection/barrier acquisition, current accounting, reservation work and confirmed commit delivery.

**An admission whose deadline has expired cannot authorize a new derived temp or start its writer/seal/verifier chain. Expiry does not imply absence of a reservation whose COMMIT was sent. Confirmed late reservations remain charged; unresolved transactions remain fenced from competing admission until an authoritative DB barrier and fresh accounting establish their outcome.**

Success requires a confirmed matching reservation and an unexpired admission when a one-use continuation permit is issued. Check its monotonic expiry again immediately at the native temp-creation boundary, after any required namespace-gate wait. No asynchronous gap or queued work may turn an expired permit into an `openat` attempt. If that later wait exhausts the budget, retain the reservation and perform a new explicit admission; never reset the old permit's deadline.

This is an admission deadline, not a two-second render/seal duration. Once the temp stage was validly begun under a successful admission, existing processing/lease deadlines govern subsequent work. A failed or late admission cannot later upgrade itself when an ACK or promise resolves. The deadline is not a claim of hard real-time response delivery under an OS/event-loop stall; every resumed continuation checks monotonic time before authority is granted.

## 4. Why DB availability alone is insufficient

Counterexample: process A sends COMMIT and loses its connection or dies; its filesystem lock is released. The server may still be processing A. Process B connects successfully and performs a normal consistent read; it can observe the old committed inventory, especially for another family. B's successful query does not establish that A can no longer commit. A process-local unavailable flag disappears with A and is invisible to B.

Holding the OS lock forever would avoid some live-process cases but violates bounded waiting and does not survive process death. An uncoordinated exact-row SELECT, an empty result, a global SUM or a family lock cannot resolve the global race.

### Approved minimal extension

Every cooperating capacity-changing admission uses one **database-scoped MySQL session advisory lock**, on the same physical connection as its reservation transaction. For current DEV the fixed code-owned name is `family_album_dev.capacity.v1`. It is not selected by the caller, family, job, epoch or root pathname. All processes operating this database use the same name; existing root/marker/device checks still bind the filesystem domain.

MySQL documents that these locks are exclusive, session-owned, survive COMMIT/ROLLBACK and end on explicit release or session termination. They apply to one MySQL server; this design assumes the existing single authoritative DEV instance, ordinary InnoDB transactions, no XA, no replica reads and no transparent connection replacement mid-operation. See [MySQL 9.7 locking functions](https://dev.mysql.com/doc/refman/9.7/en/locking-functions.html).

The upstream ordinary-session cleanup path performs transaction rollback before user-lock cleanup; this supports the proposed disconnect fence, but is not a runtime certification of the installed build. Actual MySQL 9.7.2 disconnect/slow-commit tests below are mandatory. See [MySQL upstream `THD::cleanup`](https://github.com/mysql/mysql-server/blob/trunk/sql/sql_class.cc).

Acquire exactly once, release exactly once on the same connection. `GET_LOCK` result must be 1; 0/NULL/error is not admission. Do not use negative/infinite waits, reentrant acquisition, `IS_FREE_LOCK` as authority, `RELEASE_ALL_LOCKS`, or a different connection for release. `ER_USER_LOCK_DEADLOCK` is not the approved InnoDB deadlock/replay signal. No new privilege, DB object or server-wide setting is needed.

All upload/derived reservation creation and accounting release/reclassification paths must participate before enablement. Root-local OS locking continues to serialize filesystem namespace changes. Per-byte writes within an already approved cap do not acquire the DB barrier or reset reservations.

## 5. Exact transaction ordering

```text
namespace lifetime writer ownership
-> local operation serialization (initial admission timer already running)
-> validated .capacity.lock
-> checked DB connection + fixed session capacity barrier
-> BEGIN a fresh transaction
-> existing family -> actor/upload (if applicable) -> storage -> media -> job -> asset locks
-> fresh DB server time and full identity/current lease revalidation
-> current complete reservation accounting + inventory generation validation
-> final statfs sample and quota decision
-> exact reservation INSERT or validated reuse
-> deadline/cancellation check immediately before returning SQL callback
-> COMMIT via the existing transaction runner
-> explicit commit/outcome classification
-> release DB session barrier after confirmed terminal SQL outcome, or destroy uncertain connection
-> release .capacity.lock under the bounded failure rules below
-> only a still-valid successful admission can authorize temp creation
```

No SQL row lock may precede acquisition of the OS/session capacity locks. No session may hold the DB capacity barrier while waiting for the OS lock. A resolver already inside the OS gate follows the same order on a fresh connection. Existing job-only heartbeat/claim exceptions do not acquire these capacity locks and do not create capacity reservations.

The authoritative usage read must be fresh after acquiring the DB barrier, not a reused REPEATABLE READ snapshot from before it. Use a new transaction and current business locking reads. The decisive statfs sample follows the usage read: Phase 3 writes durable chunk bytes before decreasing `reservedFuture` in DB, so reading old free bytes followed by a newer reduced future count could undercount. A preliminary statfs sample is allowed but cannot be the final admission evidence. Incomplete/changed filesystem inventory requires release/rescan and a fresh admission, not guessed accounting.

The OS lock must span COMMIT dispatch and outcome classification. `release OS lock -> then send COMMIT` is forbidden. It may extend past the admission deadline solely for bounded outcome/rollback handling, never render, copying, hashing, fsync, seal or full decode.

`CAPACITY_LOCK_MUST_COVER_COMMIT_OUTCOME: YES` covers terminal classification, which can be UNKNOWN. It does not require an infinite wait to turn UNKNOWN into certainty. The following handoff preserves exclusion when bounded resolution fails.

## 6. Bounded resolution and cross-process handoff

Two budgets are necessary:

- `ADMISSION_DEADLINE`: fixed initial 2,000 ms; controls whether this invocation can obtain filesystem authority.
- `OUTCOME_RESOLUTION_BUDGET`: finite, non-resettable safety window for settling rollback/commit or performing serialized readback after admission has expired or an earlier transport ambiguity occurred. It never extends filesystem authority.

No authoritative numerical resolution budget exists in the inspected Guardrails. Do not invent a purported approved default. Implementation must choose and record a finite package/deployment policy value, exercise its exhaustion paths, and reject missing/invalid/unbounded policy before enabling admission. Its value affects availability only; safety must hold even when it is exhausted immediately. Existing lease checks remain independent and cannot be extended by this budget.

At resolution-budget exhaustion:

1. Irreversibly cancel this repository invocation and all late continuations. Disable any future BEGIN/INSERT/COMMIT/retry or capability issuance from it; queued pool acquisition that later succeeds is disposed without starting work.
2. Destroy, never pool-release, the uncertain physical connection. Do not enqueue `RELEASE_LOCK` behind an unresolved COMMIT. Socket destruction requests termination; it does not prove rollback.
3. Classify UNRESOLVED/COMMIT_UNKNOWN as appropriate and issue no temp permit. Then the OS lock may be released. The previous session's named lock remains server-owned until that session finishes/terminates; if already released, the terminal transaction has been ordered before the next holder.
4. Every subsequent process must successfully obtain that same DB barrier and create a fresh authoritative accounting view before admitting anything. If A is still running, B cannot cross the barrier. If A committed, B counts its row; if A rolled back, B observes absence only after the barrier. A dead owner cannot bypass this rule.

Thus the failure mode is admission unavailable, not unaccounted capacity. When DB cannot be reached, no process can pass this mandatory check. When only A's connection failed, B may recover safely through the barrier and fresh complete accounting; a permanent global outage flag is neither necessary nor appropriate. A local circuit breaker may reduce retries but is not safety authority.

Do not implement this with an unowned `Promise.race` that unlocks while its SQL callback continues, acquires a new connection or issues a later COMMIT. Bounded return requires the DB adapter to revoke local command authority first. Server-side work can outlive the return, but remains serialized by its session lock. A stuck server can keep other admissions failing; that is conservative unavailability, not permission to force-unlock or use a different lock name.

## 7. Outcome classification

| Situation                                                                | Authoritative classification                                    | Caller outcome                                                                      | Filesystem authority    | Accounting                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------- |
| No COMMIT sent; newly inserted row rolled back successfully              | CONFIRMED_ABSENT                                                | ADMISSION_TIMEOUT_NO_RESERVATION or ordinary rejection                              | None                    | No new charge                                      |
| Matching reservation committed and all gates finish before deadline      | CONFIRMED_COMMITTED                                             | ADMITTED, subject to permit expiry at temp boundary                                 | One-use permit          | Fixed cap retained                                 |
| COMMIT ACK confirms success after deadline                               | CONFIRMED_COMMITTED, deadline EXCEEDED                          | ADMISSION_DEADLINE_EXCEEDED_RESERVATION_RETAINED                                    | None                    | Full reservation retained                          |
| COMMIT sent, ACK/error does not establish outcome                        | COMMIT_UNKNOWN                                                  | ADMISSION_OUTCOME_UNRESOLVED, or resolved-retained result after serialized readback | None in this invocation | No release; barrier + fresh DB accounting required |
| COMMIT provably not applied / rollback confirmed                         | CONFIRMED_ABSENT only if this operation had no pre-existing row | Rejected                                                                            | None                    | No new charge                                      |
| Exact existing reservation was reused, then this transaction rolled back | CONFIRMED_EXISTING or unresolved current state                  | Not admitted                                                                        | None                    | Existing charge remains                            |
| Rollback failed / connection state uncertain                             | UNRESOLVED; do not claim confirmed absence                      | ADMISSION_OUTCOME_UNRESOLVED                                                        | None                    | Resolve through the same barrier                   |

The proposed A/D categories need these qualifications. Before COMMIT, absence is confirmed only after successful complete rollback (or proof no transaction/write began), not when cancellation is requested. After COMMIT was attempted, a subsequent successful ROLLBACK may merely roll back an empty transaction and proves nothing about the prior COMMIT. The existing helper conservatively maps COMMIT-phase errors to unknown; do not weaken it with an error-message/errno shortcut. An exact readback after serialization may later establish absence.

Also separate transaction rollback from reservation absence: a rolled-back transaction that found an older identical row does not erase that row. No failure path resets `reserved_bytes`, deletes the row or reports released space just because the current invocation did not succeed.

## 8. Repository and coordinator contract

`packages/db` owns connection acquisition, SQL, COMMIT/ROLLBACK, typed outcomes, session barrier and authoritative readback. `packages/storage` owns root/capacity/namespace capabilities; it receives no raw SQL connection or COMMIT control. A trusted coordinator composes the two and issues the eventual opaque, expiring, one-use permit only after all gates succeed.

Use a narrow reservation repository wrapper around the existing `runTransaction`/checked-connection primitives. Its acquire/release/destroy hooks can follow the bootstrap pattern while using the distinct capacity lock. Keep the single existing deadlock retry engine. A pre-COMMIT check at the end of the SQL callback reduces late commits but cannot prevent COMMIT itself crossing the deadline. Any minimal cancellation/deadline hook added to the shared helper must be opt-in, preserve existing callers, and have the original transaction regression suite rerun.

Minimum internal structured result, expressed as a contract rather than implementation:

```text
transaction: NOT_STARTED | ROLLED_BACK | COMMITTED | UNKNOWN
reservation: CONFIRMED_MATCHING | CONFIRMED_ABSENT | CONFLICTING | UNRESOLVED
effect: CREATED | REUSED | NONE | UNKNOWN
deadline: WITHIN_BUDGET | EXCEEDED
evidence: COMMIT_ACK | SERIALIZED_READBACK | CONFIRMED_ROLLBACK | NONE
identity: family/media/generation/recipe/kind/producerJob/producerEpoch
row: verified asset id, cap, state, cleaned_at, producer tuple; absent for unresolved
reason: fixed non-secret reason code
```

`worker_id`, current lease, AVAILABLE object and current media generation/recipe remain required validation predicates; IDs/caps/epochs remain exact string/BigInt values. A result object is not a filesystem capability. The repository cannot set `tempAllowed=true` merely because a matching DB row exists.

The coordinator maps these fields to ADMITTED, TIMEOUT_NO_RESERVATION, DEADLINE_EXCEEDED_RESERVATION_RETAINED, RESERVATION_CONFIRMED_RETAINED, OUTCOME_UNRESOLVED or CONFLICT. Do not parse exception strings. Preserve the distinction between a confirmed commit and coordination-release failure; on ambiguous cleanup return no permit and destroy the connection. `CapacityGate.withLock` must not replace a typed committed-late result with a generic timeout that loses reservation evidence.

## 9. Authoritative outcome query

After ambiguity, revoke/destroy the old connection, retain the OS lock for the bounded resolution attempt, acquire the same DB barrier on a new checked connection, then use a fresh transaction/current reads on the authoritative database. If reacquisition times out, return unresolved. No replica, cached row, previous snapshot, pathname or “latest row” lookup is authority.

Locate using the exact UNIQUE `(family_id, media_id, generation, recipe_id, kind)`, then compare `producer_job_id` and `producer_lease_epoch` and all reservation semantics. Do not filter out a different producer/epoch and misclassify that missing match as an absent unique identity. Such a row is a conflict/retained previous attempt and remains accounted for.

For a reusable RESERVED row, require the exact full tuple, code-defined cap (thumbnail 524,288 / preview 4,194,304), `cleaned_at IS NULL`, consistent empty payload/publish fields and no incompatible state. Join/lock the job/media/storage in approved order and revalidate job type, RUNNING, worker, current epoch, unexpired lease using fresh DB time, current generation/recipe and object AVAILABLE. A committed row whose lease is now stale is still committed/charged; it is simply ineligible for continuation.

Confirmed absence requires the unique identity to be absent after the old session's transaction is ordered before the resolver by the shared DB barrier. A plain SELECT returning zero before this barrier is not sufficient. Lost process memory does not matter for other admissions: after crossing the barrier they count the complete committed inventory, including the formerly unknown row.

Readback is read-only with respect to reservations. Unknown never automatically replays INSERT, even if readback later finds absence. Return the classification; a new explicit admission may try again with a fresh deadline, complete accounting and lease validation. Matching existing identity can be reused under the resume rules; unrelated 1062 is a conflict/error, not success.

## 10. Late reservation lifecycle, resume and epochs

Choose **retention (option A)**. A confirmed late reservation remains RESERVED, at its fixed cap, with the original producer tuple and `cleaned_at=NULL`. Do not immediately attempt a compensating UPDATE/DELETE merely to make the timeout look like absence. That would add another possibly ambiguous commit and erase useful accounting authority.

A later explicit same-operation admission can reuse it without inserting a second row or charging the cap twice, provided all of the following hold:

- New admission deadline; both capacity locks; current complete DB/filesystem accounting and healthy READ_WRITE capability.
- Exact family/media/generation/recipe/kind/job/epoch and cap; current worker/lease, metadata prerequisite and AVAILABLE original; no newer epoch/generation.
- Lifetime writer ownership and operation serialization; no live sink/child, no outstanding usable old permit, and no conflicting files. Any prior permit is expired or irrevocably revoked before reuse.
- Exact deterministic temp and relevant inventory prove absence. Existing pathname-only residue remains RECOVERY_REQUIRED; this decision does not authorize adoption or a crash sweep.

Resume may authorize a new one-use temp permit only after its own successful fresh validation transaction and budget checks. Resolution of the old invocation never does so automatically. For a previously unknown row, current absence evidence plus serialization is required; memory saying “I did not create a file” is insufficient after restart.

If the producer advanced from epoch 5 to 6, epoch 6 cannot overwrite the row's producer tuple, ignore the charge, or create another temp. Exact approved cleanup/accounting resolution precedes a new attempt. The deterministic naming/recovery decision remains unchanged.

Eventual DB-only release is possible only through a separate approved cleanup path that proves no file, child, live permit or conflicting attempt remains, then performs a fenced cleanup-confirmed mutation under both capacity locks. It must respect existing state/CHECK semantics and not set the nonzero cap to zero. Failure/unknown cleanup retains the charge. No automatic compensation or recovery implementation is added by this review.

## 11. Accounting and retries

Late RESERVED rows count exactly as other uncleaned reservations. Unknown is not a synthetic zero-byte entry: before the next successful admission the server barrier orders the uncertain transaction, and the authoritative row is counted if it committed. Failed/old-generation/old-epoch/PUBLISHING/MISSING retained bytes and unsafe inventory retain their existing conservative treatment.

Family/global derived quota uses READY actual bytes and uncleaned non-READY caps with the required inventory floor. Physical free-space admission adds upload future bytes, unsettled derived caps, requested new delta, the existing 64 MiB scratch reserve and `max(10 GiB,total/10)`. Do not add READY bytes again to statfs or add the requested cap twice on reuse. Unknown/unsafe files block admission; no counter is decremented on mere timeout.

Only approved InnoDB deadlocks with confirmed rollback may retry, at most the existing three attempts and jitter ranges, inside the original deadline. Reacquire the checked connection/barrier and re-read all state. Stop before another attempt when the deadline/cancellation is set. No automatic replay after COMMIT unknown, failed rollback or unresolved cleanup; no second retry engine. Temp creation, unlink, seal, fsync and codec operations stay outside every SQL retry callback.

## 12. Provisional implementation audit

`PROVISIONAL_CAPACITY_CHANGES_SAFE_TO_KEEP: YES` means retain this unfinished foundation; it is not authorization to activate derived writes or claim capacity qualification.

- Local queue time is now included in the initial monotonic deadline. Independent handles use a per-root local queue; the native lock uses `flock(LOCK_EX | LOCK_NB)` across processes.
- The fixed `.capacity.lock` validates exact `0600`, UID/GID, regular/single-link, device/inode and no extended ACL. Provisioning remains explicit/exclusive and normal open does not recreate it.
- The shared `read_marker` function matches the committed Phase 3 permission behavior; the current diff no longer broadens/changes it.
- Acquisition rechecks the pinned root/lock identity. Scope review does not certify all future namespace/accounting behavior.
- The callback currently has no finite cancellation/resolution protocol; the elapsed-time check after callback completion can discard useful commit status. There is also a required deadline check immediately after successful OS-lock acquisition and before invoking DB work, since successful acquisition can occur after a poll delay.
- The four CapacityGate tests cover local serialization, lock replacement/symlink, mode and queue timeout. They do not prove two-process admission, commit classification, DB barrier or complete inventory. Previous reported 27/27 includes storage regression; this review did not rerun runtime tests.

These are implementation obligations under this approved decision. Preserve the three files; do not reset them or infer that their current generic callback is an enabled reservation API.

## 13. Required tests before any deterministic temp implementation

Use real DEV MySQL synthetic identities and actual independent OS-lock owners for concurrency evidence. Controlled driver/protocol seams may delay or discard outcomes, but must label the injected fault precisely and retain real server transactions. No production data or global MySQL configuration changes.

1. Queue/OS-lock/connection wait consumes the same two seconds. Deadline before BEGIN sends no INSERT; deadline before COMMIT rolls back a newly created reservation and returns confirmed absence. Existing-row reuse followed by rollback retains the older row.
2. Real COMMIT succeeds, then a controlled ACK-delivery barrier crosses the deadline: exact late-retained result, one row, full cap and zero temp-stage invocations. A callback-tail check alone must not falsely claim absence.
3. COMMIT is in flight while a second independent process requests the final available capacity. Verify actual OS/DB lock acquisition events; B cannot use pre-A inventory and both cannot be admitted. Repeat with different families.
4. Server COMMIT succeeds and its result is fault-injected as lost: destroy old connection, serialized exact readback identifies the row, no replay INSERT and no temp in that invocation. A wrapper that commits then throws is valid repository fault injection but must not be labeled an actual wire-level ACK-loss test.
5. Retain A's real server transaction/session under a controlled fault harness while A loses its OS-lock ownership: B can obtain the OS lock but cannot pass the DB barrier until A resolves. After commit B counts A; after rollback B can use the freed budget. Include owner SIGKILL/server-disconnect ordering; no short-sleep-only inference.
6. COMMIT error plus a successful later ROLLBACK must still be classified unknown until serialized readback. Pre-COMMIT confirmed rollback and post-barrier confirmed absence remain distinct. Rollback failure destroys the connection and does not release speculative space.
7. Unknown plus DB/query unavailable exhausts the finite safety budget: no permit, no late callback command/commit, no pool reuse of an uncertain connection. B also fails if the DB barrier/accounting cannot be obtained. When DB recovers, new admission sees the full current inventory.
8. Query exact unique identity with mismatched producer job/epoch/cap/state/cleaned fields returns conflict/retained state, never “absent”; cross-family queries reject. Matching row with expired lease is charged but cannot resume.
9. Deadlock then success, deadline during jitter, retry exhausted, user-lock deadlock, failed RELEASE_LOCK, delayed pool acquisition and late promise resolution preserve existing retry counts and no-replay rules. Named locks do not leak into a pooled session.
10. Slow/failed COMMIT, expired permit after successful ACK, unknown readback success and new-epoch calls all produce zero temp/writer/seal/verifier effects. A later explicit same-epoch reuse with exact absence may succeed once; no duplicated row/cap/permit.
11. Complete retained accounting, both API upload and derived paths sharing the same barrier, process-death release, fresh snapshot after barrier, and DB-usage-before-statfs ordering. No partial inventory or stale snapshot may qualify.
12. Run original transaction/bootstrap regressions if helper hooks change. Prove current provisional files/Phase 3 invariants preserved and clean all exact synthetic rows/roots after runtime implementation tests.

The temporal tests need controlled commit/lock barriers and assertions about SQL dispatch and filesystem-call count. A fake timer or an exception before sending COMMIT alone cannot prove a real committed/unknown outcome.

## 14. Implementation sequence and stop point

Resume **Phase 4D3b-0** directly, with a mandatory first internal acceptance slice: structured reservation results, finite deadline/cancellation handling, shared DB capacity barrier and the fault/concurrency tests above. Keep it separately reviewable before adding temp effects; a new formal D3b-0a milestone is unnecessary. No provisional DerivedStore can bypass this acceptance slice.

Then follow the already approved reservation-backed deterministic temp -> seal -> isolated verifier sequence. API/upload must participate before any DEV derived writer enablement, even though full IMAGE_DERIVATIVES worker processing remains later. This review does not implement or qualify any of those components and does not start D3a-2b, D3b-1 or D3c.

The only new file in this review is this document. No DB connection, bootstrap, migration, provisioning, media access, test fixture or implementation mutation occurred. No runtime PASS is asserted for the new DB barrier. P0/P1 design blocker counts are zero because the protocol is specified; its unimplemented prerequisites still block temp capability activation.

## 15. Provisional file preservation evidence

SHA-256 recorded before review and rechecked after writing/formatting this document; all three values matched exactly:

```text
ef5c3cb4a04d4740abb326460685e1faf5f3c608b965161026135d58e9c9e1b8  packages/storage/native/storage_native.c
ffcb2506650d5c32893ad53b698cceff292ab0d54ce83fe862372d93baa4a7cb  packages/storage/src/index.ts
fd4ca8a0266c2c179b4bb797b48051d186f3c0839dca615e38049f8bbcabd076  packages/storage/src/capacity-gate.test.ts
```
