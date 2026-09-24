# Phase 5 Roadmap

This document is a design outline only. It does not authorize implementation, schema changes, migrations, or a production-ready claim.

```text
PHASE_4_PRODUCTION_READY: NO
PHASE_5_IMPLEMENTATION: NOT STARTED
```

## Current baseline

Annotated tag `phase-4-complete` points at `63cfee6` (`Add Phase 4 final summary`).

Phase 4 implementation is complete through authenticated derived-asset serving. Migration journal `0000`–`0004` is in place. `0004` adds `album_media` only. Original media remains immutable.

Phase 4 validation recorded at `38b401d`: lint PASS, format PASS, typecheck PASS, `pnpm test` PASS, 81 files, 620 tests.

Production deployment validation, real power-loss validation, SSD disconnect validation, production rate limiting, and persistent audit storage remain deferred.

## Goals

Move from the media backend into the product layer.

Phase 5 uses the completed album ACL, `album_media` visibility, and derived thumbnail/preview API. It does not reopen renderer, verifier, publish, recovery, worker, or READY behavior.

## Phase 5A Gallery

Scope:

- album listing
- photo browsing
- timeline
- detail view

Dependencies:

- `album_media`
- ACL
- derived API

Gallery reads are authorized on the server. A member sees a photo only when album ACL and an `album_media` placement both allow it. Listing and detail views use READY thumbnail or preview bytes from the derived API. The client does not receive original paths, storage keys, or filenames.

## Phase 5B Album Operations

Scope:

- add media
- remove media
- ordering

These operations change `album_media` membership and display order. They require a later design review before any schema or API work. Removing a photo from an album removes the placement. It does not delete the original.

## Phase 5C Sharing

Scope:

- share model
- token
- expiration
- audit

Sharing is a new trust boundary. Token format, expiration, revocation, and audit storage need an R3 design review before implementation. This roadmap does not define that model.

## Out of Scope

- video
- AI
- face recognition

Also out of scope for this roadmap: original download redesign, public or anonymous media URLs, CDN delivery, and Phase 4 production-validation work.

## Security Principles

- no original exposure
- ACL first
- derived only
- audit future

Every gallery, album, and share action is authorized on the server. Family boundaries stay intact. Derived serving continues to hide missing, non-READY, cross-family, and unauthorized media with the same not-found result. Persistent audit storage is still deferred, so a share design cannot treat audit as already available.

## Schema Impact

unknown until design review

No Phase 5 table, column, index, or migration is approved by this document.
