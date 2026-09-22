# Phase 4D3b-0 — Owned Temp Naming / Recovery Identity Design Review

Status: **R3-DESIGN APPROVED — retain deterministic naming.** This review resolves only the owned-temp naming conflict. It does not qualify the provisional CapacityGate, implement DerivedStore, or pass the sealed-output/verifier gates.

## 1. Decision and authority

```text
TEMP_NAMING_STRATEGY: DETERMINISTIC_KIND_PART
Exact path: MEDIA_ROOT/derived/.tmp/<job>/e<epoch>/<kind>.part
DETERMINISTIC_KIND_PART_SECURITY_VALID: YES, subject to the requirements below
RANDOM_TEMP_NAME_SECURITY_REQUIRED: NO
DESIGN_CHANGE_REQUIRED: NO
GUARDRAILS_CLARIFICATION_REQUIRED: YES — supplied by this document
DATABASE_MIGRATION_REQUIRED: NO
READY_TO_RESUME_PHASE_4D3B0: YES
```

The later implementation prompt's requirement for a “random/unpredictable internal name” is withdrawn for this namespace. Neither a random leaf nor `<kind>.<random>.part` is authorized. [Phase 4 Guardrails](PHASE-04-GUARDRAILS.md) §§10–13 and [D3 Guardrails](PHASE-04D3-GUARDRAILS.md) §§14–17 already specify exact job/epoch/kind creation, recovery before retry, and no random-name fallback. The path is part of the protocol, not an illustrative filename. No edit to those approved documents is necessary; this clarification is authoritative for the naming conflict.

The [D3a-2/D3b boundary review](PHASE-04D3A2-D3B-BOUNDARY-REVIEW.md) still controls staging, capacity-before-temp and sealed-only verification. The [producer summary](PHASE-04D3A2A-RENDERER-PRODUCER.md) still describes an unverified memory candidate, not a sealed file or publishable asset.

## 2. Evidence inspected

- `packages/db/src/schema.ts :: backgroundJobs`: globally identified job, family/media composite identity, generation/recipe/job-type UNIQUE, worker identity and monotonic lease epoch.
- `packages/db/src/schema.ts :: derivedAssets`: UNIQUE `(family_id, media_id, generation, recipe_id, kind)`; `producer_job_id`, `producer_lease_epoch`, reservation bytes, payload evidence, state and `cleaned_at`; composite producer FK. There is no random-temp-name or persistent filesystem inode field. The producer FK alone does not validate generation, recipe, job type or current lease.
- `packages/db/src/job-repository.ts :: isCurrentUnexpiredLease`, `recoverExpiredLease`: current RUNNING/worker/epoch/generation/DB-time checks and conditional mutations. A directory name does not replace these checks.
- `packages/storage/native/storage_native.c :: secure_open_child_directory`, exclusive-create/publish primitives and `remove_file`: existing dirfd, NOFOLLOW, exclusive-create, no-clobber and identity recheck patterns. Derived deletion must remain a new purpose-specific path-class capability; the generic Phase 3 deletion primitive is not authority for derived cleanup.
- `packages/storage/src/index.test.ts`: native concurrent O_EXCL winner test and staging/destination symlink rejection. These are existing Phase 3 evidence, not tests of the unimplemented DerivedStore.
- `apps/api/src/uploads/recovery.ts :: StorageReconciler` and `tests/integration/phase3e.test.ts`: existing DB-backed recovery and refusal to release cleanup accounting after a symlink substitution. Their authority remains confined to Phase 3.
- The current uncommitted CapacityGate diff and both tests in `packages/storage/src/capacity-gate.test.ts` were inspected read-only. No runtime tests, DB connections, provisioning or cleanup were performed in this review.

## 3. What the deterministic identity means

| Component     | Meaning                                                                                                                  | What it does not prove                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `<job>`       | Canonical positive decimal background-job ID; trusted DB lookup supplies family, media, generation, recipe and job type. | A caller who guesses an ID has no filesystem authority.                         |
| `e<epoch>`    | Canonical positive decimal lease epoch for that producer attempt.                                                        | Naming an epoch does not prove it is current, unexpired or owned by the caller. |
| `<kind>.part` | Fixed code mapping: `THUMBNAIL → thumbnail.part`, `PREVIEW → preview.part`.                                              | File existence does not establish completeness, successful decode or ownership. |

Within the verified root, the tuple identifies one candidate slot for one attempt and kind. Different jobs or epochs have different slots; thumbnail and preview are separate kinds. Family/media/generation/recipe need not be repeated in the pathname because the job and confirmed reservation bind them, but the capability must carry and revalidate that full tuple. Never infer those values from untrusted path text alone.

This is not a shared `/tmp/output.part`: its parents are a private, marker-bound namespace controlled by the lifetime derived writer lock, native directory capabilities and DB-backed reservations. Filename secrecy is not an authorization boundary.

## 4. Threat model and protections

Untrusted clients, malicious image bytes and compromised parser children do not receive storage-directory write capability, temp paths, directory FDs or a generic filesystem interface. Other unprivileged local users are excluded by owner-only directories and ACL checks. A hostile process with the service UID's full unsandboxed authority, or privileged root, is outside the existing isolation guarantee; random names would not protect against such an actor discovering and mutating the namespace.

Tests must still inject hostile entries and replacement races to verify rejection. Detection must fail closed, not silently repair the directory or delete the injected object.

| Threat                                            | Required protection                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-created leaf, crash residue, duplicate create | Atomic `O_CREAT                                                                                                                                                     | O_EXCL | O_NOFOLLOW | O_CLOEXEC`; EEXIST is a conflict requiring classification, never overwrite or random fallback. |
| Symlink or directory substitution                 | Component-by-component dirfd opens with NOFOLLOW, directory-type checks, pinned identities and validation that each named child still refers to its pinned inode.   |
| Hardlink or wrong file type                       | Regular leaf, link count exactly 1, expected owner/mode/ACL, same device and identity checks. Reject FIFO/device/socket before any potentially blocking read.       |
| Wrong inode/device or namespace detach            | Compare open descriptor and parent entry with the recorded identity; reject root/parent replacement and mount/device drift.                                         |
| Job/epoch/kind injection or traversal             | Native and TypeScript canonical typed validation; unsigned BIGINT range, positive IDs/epoch, no sign/leading-zero aliases/NUL/separators; kind from fixed registry. |
| Old worker or new-epoch collision                 | Full DB fence, capability bound to one epoch, exclusive coordinator, cancellation/reaping and exact-scope cleanup. The old capability cannot select a new epoch.    |
| Check/create race                                 | O_EXCL is the creation decision; a prior existence check is never used as overwrite permission.                                                                     |
| Cleanup of another file                           | Fresh exact DB/namespace/file identity and lifecycle checks under approved serialization; no glob or recursive deletion.                                            |

Deterministic naming is safe under these requirements. Randomness adds reduced guessability and can reduce accidental collisions in a shared namespace, neither of which is required here. It does not provide symlink safety, atomic no-overwrite, current-lease proof or cleanup authority.

## 5. Directory and leaf contract

Explicit DEV provisioning establishes root/derived markers and stable locks. Normal open must not recreate missing markers, repair a wrong mount or replace a lock inode. D3b-0 creates only the approved derived temp namespace after confirmed reservation and with READ_WRITE capability.

- `derived/.tmp`, `<job>` and `e<epoch>` are code-generated directory components. Open relative to the pinned derived tree; no caller pathname and no generic concatenated-path open. If absent and creation is authorized, use restrictive `mkdirat`, securely open and verify the created component, and sync the affected parent. EEXIST on a directory is acceptable only after full existing-directory validation.
- Use owner-only `0700` for these owned directories, expected service UID, controlled group ownership with no group/other access, and no extended ACL. Existing components must satisfy the same policy; do not chmod an untrusted existing directory into acceptance.
- Pin and bind root/derived marker identity plus device/inode for derived, `.tmp`, job and epoch parents. Native opaque handles may retain these descriptors/snapshots; no new DB inode columns are needed. Revalidate named parent-child links before create, seal/handoff and cleanup so an open-but-detached directory is not accepted as the canonical namespace.
- All components remain on the approved derived device. Directories have normal topology-dependent link counts; do not apply the regular-file `nlink == 1` rule to directories. Their safety depends on type, ownership, link-to-parent identity, no symlinks and trusted mutation authority.
- Create the fixed leaf exclusively as `0600`, regular, expected UID/group policy, no ACL, same device and exactly one hard link. Record the successful creation's inode/device and bind it to the opaque attempt capability. A successful open alone is insufficient without the post-open checks.
- Mutable temp size/mtime evolve during owned writes. After writers quiesce, capture and validate the appropriate snapshot; after sealing, size/mode/mtime/hash become fixed evidence. Do not compare a completed write to a deliberately obsolete pre-write mtime, and do not relax sealed identity checks.
- Root confinement is enforced inside native DerivedStore as well as TypeScript. Children never receive these namespace handles. Existing Phase 3 original paths and destructive APIs remain untouched.

Pinned dirfds prevent a substituted path from redirecting an operation to a different object; namespace-chain revalidation additionally detects detachment/replacement. Validation followed by `unlinkat` is not claimed to be an atomic inode-conditional deletion against a hostile privileged writer. The no-concurrent-namespace-mutation guarantee comes from the approved writer/operation/capacity locks and protected namespace; identity checks detect violations.

## 6. EEXIST and retry

An existing leaf never grants permission to append, truncate, replace or adopt it. Read-only inspection is permitted only through bounded, no-follow, type-safe native operations. Classification requires the authoritative reservation/job tuple, current state and filesystem evidence:

| Existing entry                                                                                       | D3b-0 action                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Known live sink owned by this operation                                                              | Serialize/reject the duplicate request; an internal registry may identify the existing capability, but never mint a second writer or reopen by name.       |
| Known failed, inactive attempt with retained exact ownership evidence                                | Use approved exact cleanup only after child/FD/lease and DB checks; retain accounting until durable absence and DB cleanup confirmation.                   |
| Crash residue without a live owned capability                                                        | Return recovery-required/fail closed in D3b-0. Do not introduce crash adoption or a recovery sweep here.                                                   |
| Foreign tuple, missing/ambiguous DB record, unsafe type/link/owner/mode/device, changed parent/inode | Fail closed, retain the entry and conservative accounting, report a bounded reason.                                                                        |
| Known absence after prior cleanup                                                                    | Treat cleanup idempotently only when authoritative state and the verified namespace establish that this exact entry and related retained files are absent. |

Same job/epoch/kind always resolves the same slot. Transport/request retry while it is live cannot create another candidate. A failed processing retry follows the existing job policy: cleanup must be confirmed before a replacement attempt; a subsequent legitimate claim advances epoch. Do not increment epoch locally, reset attempts, loop on create failure, or reuse a consumed capability. No transparent unlink-and-recreate cycle is authorized by EEXIST.

With two concurrent creates for the same slot and no intervening authorized cleanup, O_EXCL permits at most one successful creation. The lifetime writer lock should already exclude a second writer coordinator, and local operation serialization excludes duplicate writes; the filesystem exclusivity check is still mandatory and independently tested. Random leaves would allow both creates unless a separate durable candidate-selection protocol were added.

## 7. Epoch fencing and cleanup authority

Worker A at epoch 5 has only its bound e5 capability; it cannot open, replace, seal, verify or delete e6 by changing an argument. On lease loss it cancels/reaps its child and closes its handles. It must not use its stale capability to perform cleanup or alter the reservation now associated with another epoch. Epoch directories are an isolation aid, not a filesystem enforcement substitute for capabilities and SQL fences.

Worker B's epoch 6 does not authorize it to ignore e5 residue. D3 Guardrails §17 requires the previous attempt's exact cleanup/recovery before changing the asset producer epoch or creating another temp. A newly claimed job may therefore wait/fail closed on retained old output. Only the trusted, authorized coordinator/recovery path can clean an inactive old attempt using a capability explicitly bound to that old tuple; a generic caller-selected epoch delete API is forbidden.

Exact cleanup authority includes:

- business/reservation identity: family, media, generation, recipe, kind, asset/reservation identity, producer job and producer epoch;
- storage identity: configured root and markers, derived device/inode, pinned parent chain, exact leaf and recorded or recovery-validated inode/device/type/owner/link/mode;
- lifecycle/state: authoritative asset/job state, no active producer child or writable aliases, and no active lease for the target attempt under the approved cleanup rules;
- payload/snapshot evidence appropriate to its state, including sealed size/mtime/hash when present.

Require READ_WRITE, healthy DB/readiness, lifetime writer ownership, operation serialization and the short shared capacity gate for namespace mutation. Use only the exact native derived-temp deletion primitive. No `glob *.part`, recursive job-directory removal, unlink of unknown residue or mutation of originals/canonical derived output. READ_ONLY and UNAVAILABLE prohibit destructive cleanup. Empty parent directories are not recursively removed as a shortcut.

After exact deletion and required directory sync, a short fenced DB mutation may mark cleanup confirmed. It must still match the target producer tuple/state; an old cleanup cannot mark a newer reservation cleaned. DB failure/unknown commit leaves conservative accounting, even if deletion succeeded. No filesystem effects belong inside a replayable SQL callback.

## 8. Capacity and commit ambiguity

Reservation identity remains `(family, media, generation, recipe, kind)`, bound to the producer job/epoch and current media/lease checks. File naming does not change `reserved_bytes`, state or `cleaned_at`. Use the fixed recipe cap; never release by setting reserved bytes to zero or by observing a job failure alone.

`MULTIPLE_TEMP_CANDIDATES_ALLOWED: NO` for one kind/reservation, including across old/new epochs while an old attempt is retained. Thumbnail and preview have separate asset reservations and are not duplicate candidates. Unknown/extra files remain counted and block new admission; deterministic naming does not excuse incomplete inventory.

Capacity check and confirmed reservation commit precede every new temp. COMMIT unknown creates no temp and must not retry under a different name. Once DB health returns, read and validate authoritative reservation, current lease and inventory before deciding whether any continuation is authorized. A found row alone is not a permit to replay a filesystem effect.

Keep the approved lock order and short capacity critical sections. Namespace changes participate in the shared gate; render, hash, seal and full decode do not hold it. API upload and derived admission must both participate before derived writes are enabled.

## 9. Crash recognition and future recovery

From `.tmp/123/e7/thumbnail.part`, recovery obtains candidate job=123, epoch=7, kind=THUMBNAIL. These are lookup keys, not authenticated claims. Query the job and asset to establish family/media/generation/recipe and reservation ownership; inspect the protected filesystem identity before any action. An illustrative `J123` would not pass the canonical numeric job validator.

The existing schema stores no historical inode value. After restart, do not claim an inode has been compared to a persisted pre-crash inode, or that an incomplete RESERVED file has a trusted payload digest. Recovery must reconstruct permitted ownership from the protected namespace and authoritative DB tuple, take fresh physical evidence and apply the already-approved recovery protocol. Where that cannot establish ownership, leave the file and fail closed. D3b-0 does not implement this recovery adoption.

- Known DB attempt → direct deterministic lookup, no random-leaf search needed.
- Global inventory/orphan detection → **bounded paginated directory scan still required**, with completeness and generation/identity validation. Naming does not remove this capacity/readiness requirement.
- Temp-only → no success adoption based on the name; inactive exact cleanup/recovery precedes rerender.
- Intent-only → consult authoritative intent and exact expected paths; absence is not permission to erase intent or mark success.
- Publish-before-DB or unknown commit → future D3b-1 uses stored PUBLISHING payload/identity and canonical path verification; no overwrite, blind replay or deletion of potentially published output.

The existing deterministic protocol supports all these cases. This review adds neither recovery implementation nor final publish authority.

## 10. Random and hybrid alternatives

A random leaf would introduce an additional candidate identity not stored in `derived_assets`. To safely select and recover it, an alternative design would need a durable DB mapping, a sidecar with its own atomicity protocol, or a bounded enumeration/selection protocol with duplicate handling. The current schema has no filename field; a DB-persisted random-name choice would require schema/migration review. It is not logically true that every conceivable random design requires a migration, but sidecar/scan alternatives would still change the approved identity, accounting and recovery protocol and are not authorized here.

Sidecars add a second file, write/fsync ordering, corruption and cleanup ambiguity. Scanning random candidates adds authoritative-selection rules, cardinality bounds and accounting for multiple files. `<kind>.<random>.part` preserves a kind label but retains all those issues. No demonstrated requirement justifies them in the protected single-writer namespace, so both alternatives are rejected. No sidecar or new DB field is introduced.

## 11. Provisional CapacityGate changes

`PROVISIONAL_CAPACITY_CHANGES_SAFE_TO_KEEP: YES` means **preserve as unfinished, unapproved implementation work**, not safe to enable derived writes or claim CapacityGate PASS.

The new `capacity_gate_t`, `provision_capacity_gate`, `open_capacity_gate`, `try_acquire_capacity_gate`, snapshot/release/close methods and TypeScript `CapacityGate` use the fixed `.capacity.lock`, root marker and lock inode. Neither test depends on a derived temp leaf. They can remain while deterministic naming is implemented; nothing needs to be discarded for this decision.

Read-only observations to carry into implementation review:

1. The diff also changes shared `read_marker` from a group/other-permission check to exact mode `0600`. This affects an existing Phase 3 reader as well as capacity code. Preserve it now, but explicitly reconcile it with the existing marker contract and run affected regression before acceptance; do not describe the whole diff as additions isolated to CapacityGate.
2. Conversely, `validate_capacity_lock` currently checks `(mode & 077) == 0`, which does not enforce the approved exact `0600` lock mode. Complete that existing requirement before qualification.
3. `CapacityGate.withLock` starts its two-second timeout after awaiting the local queue. Total queued wait is not currently bounded by that timeout. Bounded acquisition/cancellation and short critical-section evidence remain implementation obligations.
4. The two tests cover same-process independent handles and lock inode/symlink substitution. They do not establish two-process near-capacity admission, reservation/COMMIT ambiguity, full inventory or API/worker participation. Source search found no API/worker consumer of this draft gate.

These observations neither require random naming nor change the chosen design. They prevent treating retention of the draft as a runtime security approval. No implementation file was changed or discarded during this review.

## 12. Required implementation and regression rules

1. Resume **Phase 4D3b-0** directly; no extra D3b-0a milestone is necessary. Use this clarification plus the existing boundary review.
2. Implement the native derived-only opaque root/sink/sealed capabilities, fixed typed component registry and complete parent-chain checks. No generic path, arbitrary FD or caller filename surface.
3. Confirm current full DB identity/lease and reservation before temp creation, with shared capacity participation and READ_WRITE health. Preserve the approved SQL lock/retry/unknown-commit policy.
4. Exclusively create the exact deterministic leaf; never use O_TRUNC, overwrite, random fallback or multiple unresolved candidates. Reject stale/forged/cross-family capabilities before effects.
5. Retain/reclassify existing entries safely. D3b-0 EEXIST without a known live capability is fail closed/recovery-required; known inactive failure cleanup follows exact ownership rules. Do not implement a crash sweep here.
6. Bind handles to the whole business and physical identity; close every writer before seal. Seal and verifier still obey the approved same-byte/digest/snapshot and isolated-only decode contract.
7. Cleanup only exact inactive, verified owned temp; retain reservation on cleanup or DB ambiguity. Do not release a newer epoch's reservation, delete unknown entries or recursively remove directories.
8. Test same-slot concurrent exclusive creation (one winner), repeated create without truncation, closed-capability rejection, different kind/job separation, stale e5 against e6, and refusal to start a new attempt while old temp is retained.
9. Test pre-created regular/symlink/FIFO/hardlink leaves, job/epoch directory symlink or inode substitution, root/device/owner/mode/ACL mismatch and canonical-ID/kind injection. Confirm external/unknown files and originals remain unchanged.
10. Test missing/failed/ambiguous reservation → no temp, failed cleanup → retained charge, delete followed by DB failure → conservative charge, fenced cleanup versus new epoch, and READ_ONLY cleanup rejection. Real API/worker shared-gate admission and bounded inventory tests remain mandatory.
11. Crash-residue classification tests may prove fail-closed behavior in D3b-0; they must not claim D3b-1 recovery is implemented. Historical/incomplete files cannot be treated as verified output from their filenames.
12. Complete the requested D3b-0 seal/verifier and regression gates before claiming that stage complete. Final image qualification remains D3a-2b; publish/recovery is D3b-1; worker completion is D3c.

## 13. Final status and review limits

```text
P0_DESIGN_BLOCKERS: 0
P1_DESIGN_BLOCKERS: 0
DESIGN_CHANGE_REQUIRED: NO
GUARDRAILS_CLARIFICATION_REQUIRED: YES — this document
DATABASE_MIGRATION_REQUIRED: NO
NEXT_IMPLEMENTATION_STAGE: Phase 4D3b-0
READY_TO_RESUME_PHASE_4D3B0: YES
SEALED_DERIVED_OUTPUT_CAPABILITY_PASS: PENDING
ISOLATED_OUTPUT_VERIFIER_CAPABILITY_PASS: PENDING
IMAGE_RENDERER_CAPABILITY_GATE_PASS: PENDING
```

Only this design document was created. Existing dirty implementation files remain unchanged. No staging/commit, database operation, migration, runtime fixture or implementation was performed. The zero design-blocker counts apply to this naming decision, not to an unperformed review of the unfinished D3b-0 implementation.
