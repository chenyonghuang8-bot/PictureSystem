# PHASE-05-WEB-UI-POLISH-DESIGN

Status: DESIGN ONLY

Baseline:

-   Phase 5A Gallery complete
-   Phase 5B Album Operations complete
-   Phase 5C Sharing complete
-   Current UI is functional foundation
-   Goal: align Web UI with project-spec UI reference

# PHASE_05_WEB_UI_POLISH_DESIGN_RESULT

# 1. Objective

Current state:

-   routing exists
-   API integration exists
-   gallery flow exists

But visual completion is below reference design.

This phase improves:

-   visual hierarchy
-   photo-first experience
-   family feeling
-   reference image alignment

This is UI refinement only.

No schema change.

# 2. Design Reference

Authoritative sources:

-   project-spec/UI_REFERENCE.md
-   project-spec/ui/web-preview.png
-   project-spec/ui/app-preview.png

Maintain:

-   warm background
-   minimal style
-   family atmosphere
-   photo priority
-   soft cards
-   green accent

Avoid:

-   enterprise dashboard style
-   excessive statistics
-   fake data

# 3. Home Timeline Improvement

Current:

basic timeline grid

Target:

Family photo home.

Add:

## Header

-   family title
-   member avatars
-   search placeholder area (disabled until backend exists)

## Timeline

-   month grouping
-   photo-first layout
-   larger hero photos
-   mixed photo sizes

Do not:

invent unsupported metadata.

# 4. Photo Grid

Current:

uniform square grid.

Target:

photo-first masonry layout.

Rules:

-   thumbnail only
-   lazy loading
-   preserve aspect ratio
-   responsive columns

No original loading.

# 5. Album UI

Improve:

Album cards.

Display:

Allowed:

-   album name
-   existing permission state

Future placeholders:

-   cover
-   count

Do not display fake values.

# 6. Viewer

Improve:

-   larger preview
-   metadata hierarchy
-   close/navigation interaction

Keep:

-   preview only
-   no original exposure
-   no GPS

# 7. Right Sidebar

Reference contains auxiliary area.

Phase 5 polish:

Create visual structure only.

Allowed:

-   recent activity placeholder
-   family information placeholder

Do not create fake business data.

Future data:

-   memories
-   storage
-   activity

# 8. Navigation

Improve:

Desktop:

-   left navigation hierarchy

Mobile:

-   bottom navigation

Keep unavailable features disabled:

-   memories
-   map
-   favorites
-   admin

# 9. Empty / Loading States

Design:

-   warm empty state
-   skeleton loading
-   friendly errors

Avoid:

technical error screens.

# 10. API Impact

Expected:

Mostly frontend only.

Potential future review:

-   album cover API
-   media count API
-   family summary API

Do not add API without design review.

# 11. Security

Maintain:

-   ACL controlled by server
-   derived only
-   no storage path
-   no original
-   no GPS

# 12. Implementation Order

## Step 1

Home timeline visual polish

## Step 2

Photo grid masonry

## Step 3

Viewer polish

## Step 4

Album cards

## Step 5

Sidebar and navigation polish

# 13. Schema Impact

NO

# 14. Migration

NO

# Findings

P0:

None

P1:

None

P2:

Reference UI contains future features without backend contracts.

P3:

Advanced animations and personalization deferred.

# Final Decision

WEB_UI_POLISH_DESIGN_PASS:

YES

READY_FOR_IMPLEMENTATION:

YES
