# PHASE-05B-ALBUM-OPERATIONS-UI-DESIGN

Status: DESIGN ONLY

Baseline:

-   Phase 5A Gallery complete
-   Phase 5B Album Operations backend design complete
-   album_media is the placement relationship
-   UI follows project-spec UI_REFERENCE

# PHASE_05B_ALBUM_OPERATIONS_UI_DESIGN_RESULT

# 1. Product Alignment

Album Operations is not media management.

It manages:

    media
     |
    album_media
     |
    album

The UI changes placement only.

The UI must not imply:

-   moving ownership
-   copying files
-   deleting media

# 2. User Flows

## Add Media To Album

Entry points:

-   Photo Viewer
-   Album detail

Flow:

    Select media

    ↓

    Choose album

    ↓

    Create album_media placement

    ↓

    Refresh album view

Rules:

-   only albums user can modify are selectable
-   existing placement is shown as selected
-   no duplicate placement UI

## Remove Media From Album

Entry:

Album detail or media viewer.

Flow:

    Remove from album

    ↓

    Confirm

    ↓

    Delete album_media placement

    ↓

    Keep media available elsewhere

Confirmation text must clarify:

"Remove from this album"

not:

"Delete photo"

# 3. Components

## Album Selector

Purpose:

Choose destination albums.

Display:

-   album name
-   current selected state

Do not display:

-   fake cover
-   media count

## Placement Action Menu

Actions:

-   Add to album
-   Remove from album

Visibility depends on:

Phase 2 permission.

## Confirmation Dialog

For remove:

Explain:

-   photo remains in family library
-   other albums are unaffected

# 4. Integration With Existing UI

Follow:

project-spec/UI_REFERENCE.md

Maintain:

-   warm background
-   rounded cards
-   minimal shadows
-   photo-first

Avoid:

-   enterprise admin style
-   complex management panels

# 5. API Mapping

Add:

    POST /api/v1/albums/:albumId/media

Remove:

    DELETE /api/v1/albums/:albumId/media/:mediaId

UI does not directly access:

-   database
-   storage
-   filesystem

# 6. Permission Handling

Frontend behavior:

Show available actions only when API permits.

Security:

Frontend visibility is not authorization.

Server remains source of truth:

    Auth

    ↓

    Album ACL

    ↓

    album_media mutation

# 7. Multi Album Behavior

Example:

    photo A

    Album X
    Album Y

Removing from X:

UI should indicate:

-   removed from X
-   still exists elsewhere

Do not show:

"photo deleted"

# 8. Bulk Operations

Deferred.

Not Phase 5B:

-   multi-select add
-   multi-select remove
-   drag sorting
-   album ordering

# 9. Security

Must preserve:

-   no original access
-   no storage key exposure
-   no GPS exposure
-   ACL controlled mutations

# 10. Schema Impact

Schema:

NO

Migration:

NO

# Findings

P0:

None

P1:

None

P2:

Bulk album management deferred.

P3:

Album ordering and cover selection deferred.

# Final Decision

ALBUM_OPERATIONS_UI_DESIGN_PASS:

YES

READY_FOR_UI_IMPLEMENTATION:

YES
