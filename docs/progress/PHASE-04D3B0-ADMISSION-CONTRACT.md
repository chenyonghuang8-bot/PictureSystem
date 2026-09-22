# Phase 4D3b-0 — Admission Transaction Contract

Status: targeted contract implementation; no derived temp, seal, verifier, publish or worker job completion.

## Boundaries and deadline

- The root-local `.capacity.lock` starts a monotonic 2,000 ms admission budget **before** its local queue. Queue, OS lock, checked DB connection, session lock, SQL locks/inventory, final statfs sample and pre-COMMIT decision all consume the same budget.
- `CapacityGate.withAdmissionLock` preserves a structured callback result after a late COMMIT. The older `withLock` timeout behavior is unchanged for existing callers.
- The DB-owned outcome-resolution budget is a fixed, non-caller-configurable **5,000 ms after the admission deadline**. This follows the repository's existing five-second bootstrap session-lock wait and is intentionally a short availability bound, not extra filesystem authority. Invalid/unbounded deadlines are rejected. Exhaustion destroys the uncertain connection, returns UNKNOWN/UNRESOLVED and grants no permit.
- A pre-COMMIT expiration triggers rollback. A confirmed rollback distinguishes a new absent row from a pre-existing matching reservation. A late confirmed COMMIT remains charged and does not grant this invocation a permit.

## Coordination and transaction ownership

`packages/storage` owns local serialization, root-marker/inode-validated `.capacity.lock` (exact 0600), native statfs and read-only derived inventory observation. `packages/db` owns a checked physical MySQL connection, the fixed parameterized `family_album_dev.capacity.v1` session lock, BEGIN, business locks, inventory, reservation mutation, COMMIT/ROLLBACK, lock release and authoritative readback. Storage never receives a raw MySQL connection.

The order is root writer ownership → local queue → OS capacity lock → checked DB connection/session barrier → BEGIN → family/media/job or family/actor locks → current DB inventory → final storage snapshot → decision/write → pre-COMMIT deadline/lease check → COMMIT outcome classification → session lock release → OS lock release. Filesystem actions are not inside SQL retry callbacks.

The native derived inventory is deliberately **empty-only in this no-temp slice**: an absent or verified empty private `derived` namespace is complete; any entry returns incomplete and blocks admission. This must be upgraded to exact, bounded, paged known-file inventory before real derived temp files can coexist with admissions. It is never interpreted as zero when entries are present.

## Repository result and conservative outcomes

`MySqlDerivedAdmissionRepository.reserve` returns a structured transaction state (NOT_STARTED / ROLLED_BACK / COMMITTED / UNKNOWN), reservation state (CONFIRMED_MATCHING / CONFIRMED_ABSENT / CONFLICTING / UNRESOLVED), deadline state, evidence and full identity/row/cap. It validates the current family/media/job generation, recipe, worker ID, lease epoch and DB server-time lease. Existing same-epoch RESERVED rows are reused only on a full match; older/newer epoch, cleaned or other-producer rows conflict. The unique identity is family/media/generation/recipe/kind. Only that index's 1062 is eligible for exact winner re-read; unrelated 1062 is rethrown.

The locked current inventory charges READY assets at actual bytes and uncleaned non-READY assets at their reserved caps. It includes all families and old generations. The physical check adds upload future bytes, unsettled derived caps, new-request delta, 64 MiB scratch and max(10 GiB, 10% of total); family/global derived caps remain 32/64 GiB. Existing exact-reservation reuse adds zero new cap. Unknown filesystem entries or incomplete SQL/DB state fail closed.

COMMIT_UNKNOWN never replays INSERT. The suspect connection is destroyed, and a new checked connection must acquire the same global session barrier before a fresh exact-identity locking readback. A matching row remains charged; an absent row is confirmed only after that barrier. Unavailable readback stays UNRESOLVED. A successful later ROLLBACK after COMMIT dispatch is not evidence that COMMIT failed.

`apps/worker/src/derived-admission.ts` composes the gates and can mint a runtime-branded, expiring, one-use permit only for a timely confirmed matching COMMIT, READ_WRITE root and current lease. It does not consume the permit or create any filesystem entry. Fake plain-object/cast permits fail the runtime brand. Every future temp consumer must repeat the deadline, lease/epoch, root and exact reservation fences at its native creation boundary.

The API upload create path has an opt-in shared-gate implementation using the same OS gate and DB session lock. At API startup, a READ_WRITE root without the explicitly provisioned capacity lock is demoted to READ_ONLY; it is not silently run through legacy local-only admission. No DEV root is automatically provisioned. Existing upload receipt, tus, original-publish and quota semantics remain unchanged.

## Qualification and remaining activation boundaries

Synthetic DEV MySQL tests cover same physical CONNECTION_ID/IS_USED_LOCK, normal release, connection-death release, pre-COMMIT rollback, late real COMMIT, committed-but-ACK-lost serialized readback, readback unavailable, rollback failure, finite unknown budget, confirmed-deadlock retry, same-epoch reuse, newer-epoch conflict, unrelated duplicate error, cross-family rejection, two-process cross-family near-capacity competition with an actual busy OS-lock probe, empty-only filesystem inventory rejection and API upload shared barrier. The D3b-0 suite is **18/18 PASS**. The latest affected Phase 3 and Phase 4B/C/D2/readiness selection is **135/135 PASS when run serially by file**. A parallel combined run of existing Phase 4C and D2 suites had two global job-claim fixture collisions; neither involved the new admission suite. Those legacy fixtures require separate parallel-test hardening before a parallel milestone gate can be claimed. DEV MySQL 9.7.2 readiness/Native FK checks pass; exact D3b-0 synthetic DB rows and synthetic roots are zero after tests. No actual derived temp is created.

This contract does **not** activate derived writes. Real temp admission additionally requires complete known-file derived inventory, exact owned-temp identity, current-fence revalidation at native create, cleanup/recovery and rollout confirmation that every live API and worker process uses the same barrier.

TEMP IMPLEMENTATION: NOT STARTED  
SEALED_DERIVED_OUTPUT_CAPABILITY_PASS: PENDING  
ISOLATED_OUTPUT_VERIFIER_CAPABILITY_PASS: PENDING  
SCHEMA MODIFIED: NO  
MIGRATION MODIFIED: NO
