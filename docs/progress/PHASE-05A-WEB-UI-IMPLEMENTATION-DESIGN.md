# PHASE-05A-WEB-UI-IMPLEMENTATION-DESIGN

Status: DESIGN ONLY

Baseline:

-   phase-4-complete
-   Phase 5A Gallery backend complete
-   Home Timeline API complete
-   UI aligned with project-spec UI reference

# 1. Existing Frontend Audit

## Reference Design

Authoritative UI references:

-   project-spec/UI_REFERENCE.md
-   project-spec/ui/app-preview.png
-   project-spec/ui/web-preview.png

Design language:

-   family
-   warm
-   calm
-   premium
-   photo-first
-   minimal

Web layout:

-   left navigation
-   central photo content
-   right auxiliary information

Mobile web:

-   single column
-   app-like information structure

## Implementation Principle

Do not create a separate visual system.

Reuse:

-   existing UI tokens
-   existing components
-   existing layout conventions

# 2. Page Structure

## Home Timeline

Purpose:

Family photo home page.

Content:

-   family header
-   member avatars
-   timeline months
-   photo grid
-   upload entry

Data source:

GET /api/v1/families/:familyId/timeline

## Album List

Purpose:

Browse family albums.

Content:

-   album name
-   album navigation

Do not display:

-   fake cover
-   fake media count

Data source:

GET /api/v1/albums

## Album Detail

Purpose:

Browse photos in one album.

Content:

-   photo grid
-   cursor pagination

Data source:

GET /api/v1/albums/:albumId/media

## Photo Viewer

Purpose:

Display one photo.

Content:

-   preview image
-   approved metadata

Data source:

GET /api/v1/albums/:albumId/media/:mediaId

# 3. Component Design

## Navigation

Web:

-   left sidebar
-   family navigation

Mobile:

-   app-style bottom navigation

## Timeline Component

Responsibilities:

-   month grouping
-   infinite loading
-   thumbnail rendering

## Photo Grid

Responsibilities:

-   responsive layout
-   lazy loading
-   thumbnail only

## Album Card

Phase 5A:

Only display existing data.

Do not require:

-   cover image
-   media count

## Viewer

Uses:

-   preview asset
-   metadata panel

# 4. API Integration

Required APIs:

## Timeline

GET /api/v1/families/:familyId/timeline

## Albums

GET /api/v1/albums

## Album Media

GET /api/v1/albums/:albumId/media

## Detail

GET /api/v1/albums/:albumId/media/:mediaId

## Image Bytes

Existing derived serving:

-   thumbnail
-   preview

No new storage API.

# 5. State Management

Required state:

-   current page cursor
-   loading state
-   error state
-   selected media
-   viewer open/close state

Rules:

-   cursor state belongs to page component
-   viewer state does not control authorization
-   authorization remains server-side

# 6. Responsive Design

Desktop:

Three column layout:

-   navigation
-   photos
-   auxiliary area

Tablet:

-   collapsible navigation
-   optional auxiliary area

Mobile:

-   single column
-   app-like flow

# 7. Performance

## Timeline

Use:

-   cursor pagination
-   incremental loading

## Images

List:

-   thumbnail

Viewer:

-   preview

Do not:

-   preload originals
-   load all pages at once

## Rendering

Use:

-   lazy image loading
-   viewport based loading

# 8. Security

Maintain:

-   ACL first
-   derived only
-   no original exposure

Frontend must never receive:

-   storage path
-   storage key
-   filesystem location

GPS:

Not displayed in Phase 5A.

# 9. File Planning

Expected areas:

apps/web:

-   routes/pages
-   gallery components
-   viewer components

packages:

-   reuse existing UI components
-   reuse contracts

Before implementation:

inspect actual frontend structure.

Do not create duplicate component systems.

# 10. Deferred

Not implemented in Phase 5A:

-   memories
-   search
-   map
-   favorites
-   comments
-   AI features
-   advanced album cover selection

# Findings

P0:

None

P1:

None

P2:

Existing UI reference contains future features that do not yet have
backend contracts.

P3:

Advanced optimization can be revisited after real usage data.

# Final Decision

WEB_UI_DESIGN_PASS:

YES

SCHEMA_CHANGE_REQUIRED:

NO

MIGRATION_REQUIRED:

NO

READY_FOR_UI_IMPLEMENTATION:

YES
