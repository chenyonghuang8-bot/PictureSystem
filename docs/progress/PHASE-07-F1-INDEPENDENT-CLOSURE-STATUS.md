# Phase 7 F1 independent closure — interrupted review

> 历史 finding / 审查状态保留。原 F1 P1 与初始化 P2 已由 `PHASE-07-F1-INIT1-INDEPENDENT-CLOSURE.md` 正式 CLOSED / PASS；后续 gate / 阶段状态见最新 milestone 和 final summary。本历史结论不再表示当前 open blocker。

Date: 2026-10-02 UTC. Base HEAD: `a0f4ef7393ab51b0795d7126f1110e243e1cb640` plus uncommitted implementation.

**Disposition: closure not granted.** The delegated Astra reviewer reported a reproducible initialization issue and a provisional `NEEDS_FIX` disposition, but its final report step failed with a tool safety-filter error. This document preserves received findings and saved evidence; it is not a completed Astra sign-off.

## Received review results

- Reviewer reported matching hashes for 41 source files, 3 outputs and 11 logs.
- Independently rerun namespace/coordination/handoff/purge-derived matrix: 4 files, 69 tests passed, skip 0 (reviewer report).
- Independently rerun DEV phase7c-purge: 79 tests passed, skip 0, including four namespace DB counterexamples and crash/unknown-COMMIT recovery (reviewer report).
- Reviewer reported the original rename/split-lock path fixed. This does not close the whole approved implementation contract.

## Saved initialization finding

Evidence: `.cache/phase7-f1-design/closure-init-probe/probe.cjs` and `result.json`. The probe used an ignored native source copy to pause fresh initialization immediately after a complete marker write and before fsync; runtime checks used the unchanged production addon. Only owned synthetic temporary fixtures were used; `ownedFixturesCleaned` is true.

`packages/storage/native/storage_root_v2.h:58` writes the complete marker before the sync operations at line 59. The saved result records:

| Probe                                  | Concurrent runtime open | Concurrent R-exclusive | Runtime open / coordination afterward          |
| -------------------------------------- | ----------------------- | ---------------------- | ---------------------------------------------- |
| Kill initializer at pre-fsync boundary | true                    | true                   | true / true                                    |
| Resume initializer with injected error | true                    | true                   | false / false; initializer reports INIT_FAILED |

The reviewer provisionally classified this as **P2 initialization protocol/durability regression**, blocking full acceptance of the approved initialization boundary. It did not establish renewed purge under an active reader or actual media loss. The error path invalidates the marker after an initialization failure, but the observed concurrent admission occurred before that failure.

## Minimal follow-up received from reviewer

Provide initialization publication/admission synchronization and true interruption/concurrent-open regression coverage so runtime capability is not granted before the required initialization completion boundary. Keep K, database schema, lock ordering and existing-root upgrade scope unchanged. The concrete repair design still needs Astra review; this status document does not authorize an invented implementation.

After repair and completed independent closure, run the complete milestone gate: format, lint, typecheck, unit/API, live DEV integration and MySQL races without skips, required native/fault/crash checks, builds and browser/E2E. Prior milestone results cannot be inherited across this fix. Existing V1 roots remain unsupported by the V2 runtime until separately authorized compatibility/activation work is designed and validated; do not auto-upgrade roots or restart existing services.

No implementation edits, commit or push were performed by the parent closure task. Phase 7 completion and production readiness are not asserted. Final Astra closure remains blocked by the interrupted report and the recorded initialization finding.
