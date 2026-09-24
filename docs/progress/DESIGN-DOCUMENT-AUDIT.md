# DESIGN DOCUMENT AUDIT

Status: AUDIT ONLY. This document does not change code, schema, migrations, or Git history.

Baseline: `main` at `0f36681` (`Add Phase 5 roadmap`). Phase 4 tag `phase-4-complete` points at `63cfee6`. `PHASE_4_PRODUCTION_READY: NO`.

## 1. Document Inventory

These locations do not exist:

- `docs/design/`
- `docs/spec/`
- an ADR directory
- a root `README`

Design and specification material lives in `project-spec/` and `docs/progress/`. `packages/storage/vendor/libwebp/` contains upstream library documentation and is not a PictureSystem design source.

| Path | Type | Purpose | Status |
| --- | --- | --- | --- |
| `project-spec/PROJECT.md` | Product spec | Family scope, immutable originals, clients, V1 rules | Current product baseline; some V1 items are later phases |
| `project-spec/ARCHITECTURE.md` | Architecture spec | Monorepo, MySQL, storage, auth shape | Starter architecture; later phase docs supersede implementation detail |
| `project-spec/ROADMAP.md` | Roadmap | Original Phase 0–later product phases | Superseded in part by `docs/progress/` and `PHASE-05-ROADMAP.md` |
| `project-spec/database/DATABASE_SCHEMA.md` | Data model spec | Early logical tables | Superseded by Drizzle migrations `0000`–`0004` and phase schema docs |
| `project-spec/database/schema.sql` | Draft SQL | Early MySQL draft | Not the migration history |
| `project-spec/UI_REFERENCE.md` | UI spec | Visual language and App/Web layout | Current visual baseline for a future UI |
| `project-spec/ui/app-preview.png` | UI design | Android preview | Authoritative visual reference |
| `project-spec/ui/web-preview.png` | UI design | Web preview | Authoritative visual reference |
| `project-spec/MODEL_ROUTING.md` | Process | Model selection | Process, not product design |
| `project-spec/CONTEXT_BUDGET.md` | Process | Context budget | Process |
| `project-spec/BRIDGE_POLICY.md` | Process | Bridge policy | Superseded by the project rule that Bridge is not used |
| `project-spec/CODEX_START_PROMPT.md` | Process | First Codex prompt | Historical starter |
| `project-spec/CHANGELOG.md` | Process | Starter-pack changelog | Historical |
| `AGENTS.md` | Engineering rules | Security invariants, phase status, DEV limits | Current operating rules |
| `docs/progress/PROJECT-HANDOFF.md` | Handoff | Checkpoint, gates, open issues | Current through validation stabilization |
| `docs/progress/PHASE-01-DESIGN.md` | Security and data design | Identity, session, invitation | Design basis for Phase 1 |
| `docs/progress/PHASE-01A-SUMMARY.md` | Implementation record | Phase 1A | Record |
| `docs/progress/PHASE-01B-SUMMARY.md` | Implementation record | Phase 1B | Record |
| `docs/progress/PHASE-01B1-SUMMARY.md` | Implementation record | Phase 1B1 | Record |
| `docs/progress/PHASE-01B-GUARDRAILS.md` | Security guardrails | Auth implementation bounds | Design constraint |
| `docs/progress/PHASE-01C-GUARDRAILS.md` | Security guardrails | Invitation and role bounds | Design constraint |
| `docs/progress/PHASE-01C-SUMMARY.md` | Implementation record | Phase 1C | Record |
| `docs/progress/PHASE-01-LOCAL-SECURITY-REVIEW.md` | Security review | Phase 1 review | Review |
| `docs/progress/PHASE-01-FINAL-SUMMARY.md` | Phase summary | Phase 1 completion | Record |
| `docs/progress/PHASE-02-GUARDRAILS.md` | Security guardrails | Album ACL | Design basis for Phase 2 |
| `docs/progress/PHASE-02A-SUMMARY.md` | Implementation record | Album schema and API | Record |
| `docs/progress/PHASE-02B-SUMMARY.md` | Implementation record | Permission behavior | Record |
| `docs/progress/PHASE-02-FINAL-SUMMARY.md` | Phase summary | Phase 2 completion | Record |
| `docs/progress/PHASE-03-GUARDRAILS.md` | Security guardrails | Storage and upload | Design basis for Phase 3 |
| `docs/progress/PHASE-03A-STORAGE-CAPABILITY.md` | Implementation record | Storage capability | Record |
| `docs/progress/PHASE-03B-SCHEMA.md` | Schema record | Upload schema | Record |
| `docs/progress/PHASE-03C-UPLOAD.md` | Implementation record | Resumable upload | Record |
| `docs/progress/PHASE-03D-FINALIZE.md` | Implementation record | Durable original finalize | Record |
| `docs/progress/PHASE-03E-RECOVERY.md` | Implementation record | Recovery | Record |
| `docs/progress/PHASE-03F-SECURITY-FIXES.md` | Security record | Phase 3 fixes | Record |
| `docs/progress/PHASE-03-FINAL-SUMMARY.md` | Phase summary | Phase 3 completion | Record |
| `docs/progress/PHASE-04-GUARDRAILS.md` | Security and pipeline design | Phase 4 media pipeline bounds | Design basis for Phase 4 |
| `docs/progress/PHASE-04A-SCHEMA.md` | Schema record | `0003` media, derived, jobs | Record; status text is historical |
| `docs/progress/PHASE-04D1-METADATA-PARSER.md` | Implementation record | Isolated parser | Record |
| `docs/progress/PHASE-04D2-METADATA-PERSISTENCE.md` | Implementation record | Probe persistence | Record |
| `docs/progress/PHASE-04D3-GUARDRAILS.md` | Security guardrails | Renderer and derived store | Design basis for 4D3 |
| `docs/progress/PHASE-04D3A-STARTUP-ISOLATION-REVIEW.md` | Design review | Renderer startup isolation | Design |
| `docs/progress/PHASE-04D3A0-STARTUP-CAPABILITY.md` | Implementation record | Startup sandbox | Record |
| `docs/progress/PHASE-04D3A1-FD-PROCESS-HARDENING.md` | Implementation record | FD and process lifecycle | Record |
| `docs/progress/PHASE-04D3A2-D3B-BOUNDARY-REVIEW.md` | Design review | Producer versus verifier boundary | Design |
| `docs/progress/PHASE-04D3A2A-RENDERER-PRODUCER.md` | Implementation record | Renderer producer | Record |
| `docs/progress/PHASE-04D3A2B-RENDERER-QUALIFICATION.md` | Implementation record | Qualification | Record |
| `docs/progress/PHASE-04D3B0-TEMP-NAMING-REVIEW.md` | Design review | Temp identity | Design |
| `docs/progress/PHASE-04D3B0-ADMISSION-COMMIT-REVIEW.md` | Design review | Admission commit | Design |
| `docs/progress/PHASE-04D3B0-ADMISSION-CONTRACT.md` | Design contract | Admission behavior | Design |
| `docs/progress/PHASE-04D3B0-TEMP-STORE.md` | Implementation record | Temp and derived store | Record |
| `docs/progress/PHASE-04D3B0-SEAL.md` | Implementation record | Seal | Record |
| `docs/progress/PHASE-04D3B0-VERIFY-OUTPUT.md` | Implementation record | Verifier | Record |
| `docs/progress/PHASE-04D3B1-PUBLISH-PRIMITIVE.md` | Implementation record | Publish | Record |
| `docs/progress/PHASE-04D3B1-RECOVERY.md` | Implementation record | Recovery | Record |
| `docs/progress/PHASE-04D3C-WORKER-INTEGRATION.md` | Implementation record | Worker | Record |
| `docs/progress/PHASE-04D3C1-READY-TRANSACTION.md` | Implementation record | READY transaction | Record |
| `docs/progress/PHASE-04D3C2-MEDIA-VISIBILITY-DESIGN.md` | Design | `album_media` visibility | Design basis for 4D3c-2 |
| `docs/progress/PHASE-04D3C2-ALBUM-MEDIA-MIGRATION.md` | Migration record | `0004` | Record |
| `docs/progress/PHASE-04D3C2-API-SERVING.md` | Implementation record | Derived serving | Record |
| `docs/progress/PHASE-04-FINAL-SUMMARY.md` | Phase summary | Phase 4 through API serving | Record; production remains NO |
| `docs/progress/PHASE-05-ROADMAP.md` | Roadmap | Phase 5 product direction | Current Phase 5 outline |
| `docs/progress/PHASE-05A-GALLERY-DESIGN.md` | Design | Gallery model | Design for 5A |
| `docs/progress/PHASE-05A-QUERY-API-DESIGN.md` | Design | Gallery query API | Design for 5A |
| `docs/progress/PHASE-05A-SERVING-BOUNDARY-DESIGN.md` | Design | Derived URL boundary | Design for 5A |
| `packages/db/drizzle/README.md` | Migration note | Drizzle journal | Operational |
| `packages/storage/vendor/libwebp/PROVENANCE.md` | Provenance | Vendored encoder | Supply-chain record |
| `CURSOR_PHASE_0_5_REPORT.md` | Review | Early Cursor report | Historical |
| `CURSOR_PHASE_1B_SECURITY_REVIEW.md` | Review | Phase 1B review | Historical |

There is no separate API specification document. HTTP contracts live in `packages/contracts/` and in the phase records above.

## 2. Phase Mapping

| Phase | Design reference | Implementation reference | Match |
| --- | --- | --- | --- |
| Phase 1 | `PHASE-01-DESIGN.md`, Phase 1 guardrails, `PROJECT.md` auth rules | `PHASE-01-FINAL-SUMMARY.md`, migrations `0000` | YES |
| Phase 2 | `PHASE-02-GUARDRAILS.md`, `PROJECT.md` albums | `PHASE-02-FINAL-SUMMARY.md`, migration `0001` | YES |
| Phase 3 | `PHASE-03-GUARDRAILS.md`, `ARCHITECTURE.md` storage section | `PHASE-03-FINAL-SUMMARY.md`, migration `0002` | YES |
| Phase 4A | `PHASE-04-GUARDRAILS.md` | `PHASE-04A-SCHEMA.md`, migration `0003` | YES |
| Phase 4B | `PHASE-04-GUARDRAILS.md`, `PHASE-04A-SCHEMA.md` canonical media identity | Commit `8be3c25` metadata pipeline; no `PHASE-04B` file | PARTIAL |
| Phase 4C | `PHASE-04-GUARDRAILS.md` jobs, lease, and epoch | Same pipeline commit; no `PHASE-04C` file | PARTIAL |
| Phase 4D0 | `PHASE-04-GUARDRAILS.md` original read capability | Original reader used by D1; no `PHASE-04D0` file | PARTIAL |
| Phase 4D1 | `PHASE-04-GUARDRAILS.md` | `PHASE-04D1-METADATA-PARSER.md` | YES |
| Phase 4D2 | `PHASE-04-GUARDRAILS.md` | `PHASE-04D2-METADATA-PERSISTENCE.md` | YES |
| Phase 4D3 | `PHASE-04D3-GUARDRAILS.md` and the D3a/D3b design reviews | D3a through D3c records, including visibility design, `0004`, and derived serving | YES |

`PARTIAL` means the behavior has a parent design, and the implementation record is folded into a broader document or commit. It does not mean the slice was built without a design.

## 3. Missing Reference Analysis

Phases with a design and a later implementation record: Phase 1, Phase 2, Phase 3, Phase 4A, Phase 4D1, Phase 4D2, and Phase 4D3. The implementation records cite the guardrails or the approved slice. No completed security slice was found that lacks both a guardrail and a phase record.

Phases without a dedicated design file:

- Phase 4B canonical media
- Phase 4C job claim, lease, and epoch
- Phase 4D0 original reader

Their rules are in `PHASE-04-GUARDRAILS.md` and `PHASE-04A-SCHEMA.md`. A reader cannot open one file named for that slice.

Designs later superseded:

- `project-spec/ROADMAP.md` Phase 4 names Sharp, ffprobe, and video posters. `PHASE-04-GUARDRAILS.md` replaced that with the isolated image pipeline and left video out of Phase 4.
- `project-spec/database/schema.sql` and `DATABASE_SCHEMA.md` are early models. Applied history is `packages/db/drizzle/0000`–`0004`.
- `project-spec/ARCHITECTURE.md` names MySQL 8.4. The running DEV baseline is MySQL 9.7.2.
- `project-spec/ROADMAP.md` Phase 5 is Core Web UI. `docs/progress/PHASE-05-ROADMAP.md` starts Phase 5 at the gallery product layer and keeps UI out of the 5A backend.
- `BRIDGE_POLICY.md` is not the current workflow. `AGENTS.md` forbids automatic Bridge.

Phase 5A gallery backend (`642734b`) follows `PHASE-05A-GALLERY-DESIGN.md`, `PHASE-05A-QUERY-API-DESIGN.md`, and `PHASE-05A-SERVING-BOUNDARY-DESIGN.md`.

## 4. UI Design Audit

`project-spec/ui/` contains two confirmed previews:

- `app-preview.png`
- `web-preview.png`

`UI_REFERENCE.md` defines the warm, photo-first language, the App tabs 照片 / 相册 / 回忆 / 我的, and the Web layout of left navigation, photo area, and side information.

Phase 4 has no UI delivery and no UI design of its own. The Phase 4 roadmap slice is media processing and derived serving, not screens. That is not a missing Phase 4 UI spec.

Phase 5 should use these references when a screen is built. The current Phase 5A backend does not. `PHASE-05-ROADMAP.md` does not yet point at `UI_REFERENCE.md` or the two previews. Gallery, timeline, and detail in the previews are the visual target for a later UI slice, not for the API work already committed.

The original roadmap also places album operations, sharing, search, and map in later phases. Those screens are described only at the reference-image level.

## 5. Architecture Audit

Phase 4 has all three specification kinds, but not as one architecture book:

- Architecture and security bounds: `PHASE-04-GUARDRAILS.md` and `PHASE-04D3-GUARDRAILS.md`, read with `project-spec/ARCHITECTURE.md`.
- Security reviews: the D3a startup review, the D3a-2/D3b boundary review, the temp naming review, and the admission commit review.
- Data model: `PHASE-04A-SCHEMA.md` for `0003`, and `PHASE-04D3C2-MEDIA-VISIBILITY-DESIGN.md` for `album_media` / `0004`.

There is no standalone Phase 4 API specification. Derived serving is specified in `PHASE-04D3C2-API-SERVING.md` and the visibility design. Gallery HTTP shape is in the Phase 5A query design and `packages/contracts/src/gallery.ts`.

## 6. Risk Assessment

P0: none. No completed Phase 1–4 security slice was found without a guardrail or an approved phase design.

P1: none.

P2: `project-spec/ROADMAP.md`, `ARCHITECTURE.md`, and `database/schema.sql` are still easy to treat as current. They disagree with the implemented pipeline on MySQL version, Sharp, video posters, and the Phase 5 starting point. Following them would reopen closed decisions.

P2: design decisions are stored as phase reviews under `docs/progress/`, not as ADRs. A later change can miss the review that fixed the decision.

P3: Phase 4B, Phase 4C, and Phase 4D0 have no standalone document. Their parent guardrail is the reference.

P3: the UI previews are not linked from `PHASE-05-ROADMAP.md`. A later UI slice can miss the confirmed screens.

P3: `PHASE-04A-SCHEMA.md` still says migration `0003` was not executed. That status line is historical.

If an implementer uses the starter pack instead of the phase guardrail, the affected paths are:

| Document | Phase | Risk |
| --- | --- | --- |
| `project-spec/ROADMAP.md` Phase 4 | Phase 4 | Rebuilds video posters and a Sharp pipeline that the guardrails replaced |
| `project-spec/database/schema.sql` | Phase 1–4 | Treats a draft as the applied schema |
| `project-spec/ROADMAP.md` Phase 5 | Phase 5 | Starts UI before the gallery API contract already recorded in `docs/progress/` |
| `project-spec/ui/app-preview.png`, `web-preview.png` | Phase 5 UI | Unused so far; required when screens start |

## 7. Recommendation

Do not reopen Phase 1–4 implementation from this audit.

Supplement, without rewriting history:

- Point `PHASE-05-ROADMAP.md` at `UI_REFERENCE.md` and the two previews before any UI work.
- Add a short note to `PROJECT-HANDOFF.md` that `docs/progress/PHASE-04-GUARDRAILS.md` and the phase reviews override `project-spec/ROADMAP.md` Phase 4 and `database/schema.sql`.
- Leave Phase 4B, 4C, and 4D0 as parent-guardrail coverage unless a later reader needs a standalone index. That is not a reason to re-review the implementation.

No phase needs a new security review because a design file is missing. The open production gaps in `PHASE-04-FINAL-SUMMARY.md` are unchanged.

```text
DESIGN_AUDIT_PASS: YES
```
