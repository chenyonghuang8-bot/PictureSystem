# PHASE-05C-PUBLIC-SHARE-UI-DESIGN

Status: DESIGN ONLY

Baseline:

-   Phase 5A Gallery complete
-   Phase 5B Album Operations complete
-   Phase 5C Sharing backend complete
-   Public Share API available

# PHASE_05C_PUBLIC_SHARE_UI_DESIGN_RESULT

# 1. Product Alignment

Sharing UI provides controlled external viewing.

It is not:

-   social sharing
-   public gallery
-   content publishing

The user shares a family album intentionally.

# 2. Internal Share Management UI

Location:

Album detail page

Entry:

Share action

Flow:

    Album

    ↓

    Create Share

    ↓

    Set expiration

    ↓

    Generate link

    ↓

    Copy link

Display:

-   album name
-   expiration time
-   active/revoked state

Never display:

-   token hash
-   internal share id

# 3. Create Share Dialog

Fields:

Expiration only.

Do not add:

-   permission options
-   upload permission
-   edit permission

Reason:

V1 sharing is read-only.

After creation:

Show:

-   share link
-   copy action

Raw token appears only in creation response.

# 4. Share List UI

Purpose:

Manage existing shares.

Display:

-   album name
-   created time
-   expiration
-   status

Actions:

-   copy link if available from creation flow
-   revoke

Do not display:

-   token value after leaving creation flow

# 5. Revoke Flow

Action:

Remove external access.

Confirmation:

Explain:

"The shared link will stop working."

Do not say:

"Delete share"

Reason:

The record remains for audit.

# 6. Public Share Viewer UI

Route:

    /share/:token

Content:

-   album title
-   photo grid
-   thumbnail loading

Viewer:

-   preview image

Do not show:

-   family name
-   member list
-   internal navigation
-   management controls

# 7. Image Boundary

List:

thumbnail

Viewer:

preview

Never:

original

The UI does not construct storage URLs.

# 8. Error States

All public failures:

single not-found experience.

Examples:

-   invalid link
-   expired link
-   revoked link
-   removed media

Do not explain the reason.

# 9. API Mapping

Internal:

POST /api/v1/albums/:albumId/share

GET /api/v1/shares

DELETE /api/v1/shares/:shareId

Public:

GET /api/v1/share/:token

GET /api/v1/share/:token/media/:mediaId/derived/:kind

# 10. Security

Maintain:

-   token is capability
-   server authorization
-   derived only
-   no original
-   no GPS
-   no storage information

# 11. Deferred

Not Phase 5C:

-   public comments
-   download
-   upload
-   social sharing
-   QR design
-   analytics dashboard

# Schema Impact

NO

# Migration

NO

# Findings

P0:

None

P1:

None

P2:

Public rate limiting required before production exposure.

P3:

Advanced share customization deferred.

# Final Decision

PUBLIC_SHARE_UI_DESIGN_PASS:

YES

READY_FOR_UI_IMPLEMENTATION:

YES
