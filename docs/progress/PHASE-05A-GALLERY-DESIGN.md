# PHASE-05A-GALLERY-DESIGN

Status: DESIGN ONLY

Baseline: - phase-4-complete - HEAD: 63cfee6 - Phase 4 implementation
complete through authenticated derived asset serving -
PHASE_4_PRODUCTION_READY: NO

# Scope

Phase 5A introduces the Gallery product layer.

Goals: - album list - album media browsing - pagination - timeline
ordering - media detail view

Out of scope: - sharing - video - AI search - face recognition - public
links - original download redesign

# PHASE_05A_GALLERY_DESIGN_RESULT

# Model

Current relationship:

User \| Family membership \| Album ACL \| album_media \| media_items \|
derived_assets

Gallery visibility starts from album authorization.

A media item does not independently grant visibility.

# Album List

Authorization:

authenticated user -\> family membership -\> album permission

Deleted albums are not returned.

Proposed API:

GET /api/v1/albums

No filesystem information is returned.

# Album Media Browsing

Authorization:

album_id -\> album permission -\> album_media -\> media_items -\>
derived_assets

A media_id alone is not sufficient.

Proposed API:

GET /api/v1/albums/:albumId/media

# Pagination

Use cursor pagination.

Do not use offset pagination.

Initial cursor: created_at + media_id

Recommended order: created_at DESC, media_id DESC

# Timeline

Priority:

capture_time then upload_time fallback

Do not use filesystem mtime.

Recommended:

effective_timeline_time DESC, media_id DESC

# Detail View

Media detail must not bypass album authorization.

Possible designs:

GET /api/v1/albums/:albumId/media/:mediaId

or server resolves accessible placements.

GPS must not be exposed by default.

# Thumbnail and Preview

Gallery list: thumbnail

Detail: preview

Never use original storage.

# Security Invariants

-   Media id alone never grants access.
-   Album ACL remains the permission source.
-   Derived visibility follows authorized media placement.
-   Original storage remains isolated.
-   Gallery never bypasses Phase 4 derived serving.

# Schema Impact

UNKNOWN UNTIL QUERY REVIEW.

No schema change approved at design stage.

# Migration Requirement

NO MIGRATION REQUIRED FOR DESIGN.

# Deferred Decisions

-   media detail API shape
-   GPS visibility
-   timeline indexing
-   album cover selection
-   ordering/custom sorting
-   infinite scroll API contract

# Final Decision

GALLERY_DESIGN_PASS: YES

SCHEMA_CHANGE_REQUIRED: NO (current design stage)

MIGRATION_REQUIRED: NO (current design stage)

API_IMPLEMENTATION_READY: NO

READY_FOR_PHASE_5A_IMPLEMENTATION: YES
