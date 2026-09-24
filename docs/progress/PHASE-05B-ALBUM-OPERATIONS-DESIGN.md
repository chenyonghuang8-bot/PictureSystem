# PHASE-05B-ALBUM-OPERATIONS-DESIGN

Status: DESIGN ONLY

Baseline:

-   phase-5A-complete
-   album_media exists
-   Phase 2 ACL exists
-   Gallery and Timeline completed

# PHASE_05B_ALBUM_OPERATIONS_DESIGN_RESULT

# 1. Model

Album operations are placement operations.

The source of truth:

    album_media

Relationship:

    album
     |
    album_media
     |
    media_item

Rules:

-   one media can belong to many albums
-   one album can contain many media
-   removing a placement does not delete media
-   removing a placement does not delete original storage
-   removing a placement does not delete derived assets

No new media ownership model is introduced.

# 2. Add Media API

Proposed:

    POST /api/v1/albums/:albumId/media

Request:

    {
      mediaId
    }

Authorization:

    Authentication

    ↓

    Album ACL

    ↓

    can_edit / can_upload policy

    ↓

    album_media insert

The API must verify:

-   actor belongs to family
-   album is active
-   media belongs to same family
-   actor has permission

Cross-family placement is rejected.

# 3. Remove Media API

Proposed:

    DELETE /api/v1/albums/:albumId/media/:mediaId

Operation:

Delete:

    album_media row

Never delete:

-   media_items
-   storage_objects
-   originals
-   derived_assets

Reason:

media is family-owned canonical data.

Album membership is only placement.

# 4. Multi Album Behavior

Example:

    media A

    album X
    album Y

Remove from X:

Result:

-   Y remains visible
-   timeline remains visible if another authorized placement exists
-   original remains unchanged

Remove last placement:

Result:

-   media remains stored
-   timeline visibility disappears
-   future cleanup belongs to later trash/lifecycle design

# 5. Permission Boundary

All mutations use existing Phase 2 permission model.

No new permission system.

Flow:

    Auth

    ↓

    Family membership

    ↓

    Album ACL

    ↓

    Placement mutation

Client visibility is not security.

# 6. Duplicate Handling

Existing unique constraint:

    (family_id, album_id, media_id)

Duplicate add:

Recommended:

idempotent success.

Reason:

Adding an existing placement should not create duplicate state.

No new schema required.

# 7. Transaction

Add:

Single transaction:

-   verify family boundary
-   verify album permission
-   verify media family
-   insert placement

Remove:

Single transaction:

-   verify permission
-   delete placement

No storage operation occurs.

# 8. UI Impact

Future UI:

Album detail:

-   Add to album

Media viewer:

-   Add/remove album placement

Phase 5B does not implement:

-   drag sorting
-   cover selection
-   bulk organization

# 9. Schema Impact

Schema change:

NO

Current:

album_media already represents required relationship.

# 10. Migration

Migration:

NO

No new columns or tables required.

# 11. Security

Must preserve:

## Invariant 1

Media id never grants album modification permission.

## Invariant 2

Album ACL controls placement mutation.

## Invariant 3

Cross-family association is impossible.

## Invariant 4

Placement deletion never deletes canonical media.

## Invariant 5

Original storage remains immutable.

# Findings

P0:

None

P1:

None

P2:

Bulk album operations deferred.

P3:

Ordering/position fields deferred until product requirement exists.

# Final Decision

ALBUM_OPERATIONS_DESIGN_PASS:

YES

SCHEMA_CHANGE_REQUIRED:

NO

MIGRATION_REQUIRED:

NO

READY_FOR_IMPLEMENTATION:

YES
