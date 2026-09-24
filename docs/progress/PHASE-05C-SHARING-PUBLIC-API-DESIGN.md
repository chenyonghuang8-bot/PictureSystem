# PHASE-05C-SHARING-PUBLIC-API-DESIGN

Status: DESIGN ONLY

Baseline:

-   Phase 5C migration complete
-   shares table exists
-   share_events exists
-   Share Service design complete

# PHASE_05C_SHARING_PUBLIC_API_DESIGN_RESULT

# 1. Public API Boundary

Public APIs provide read-only shared access.

They do not:

-   create accounts
-   modify albums
-   modify media
-   bypass internal permissions

Flow:

    Share Token

    ↓

    Share Service

    ↓

    Album Placement

    ↓

    Derived Asset

# 2. Create Share API

Internal authenticated API:

    POST /api/v1/albums/:albumId/share

Authorization:

    Session

    ↓

    Family Membership

    ↓

    Album ACL

    ↓

    Share Management Permission

Required:

-   owner or
-   canManageMembers

Request:

    {
      expiresAt
    }

Response:

    {
      shareId,
      token,
      expiresAt
    }

Raw token:

-   returned once
-   never returned again

# 3. List Shares API

Internal API:

    GET /api/v1/shares

Returns:

-   shareId
-   albumId
-   createdAt
-   expiresAt
-   revokedAt

Does not return:

-   token
-   token_hash

# 4. Revoke Share API

Internal API:

    DELETE /api/v1/shares/:shareId

Behavior:

-   set revoked_at
-   set revoked_by_member_id
-   create REVOKE event

Do not delete share row.

# 5. Public Share Info API

Anonymous:

    GET /api/v1/share/:token

Returns:

-   album display information
-   media page
-   thumbnail references

Does not return:

-   family information
-   member information
-   internal IDs unrelated to viewing
-   GPS
-   storage information

# 6. Public Derived API

Anonymous:

    GET /api/v1/share/:token/media/:mediaId/derived/:kind

Allowed:

-   thumbnail
-   preview

Not allowed:

-   original

Every request:

-   verify token
-   verify share
-   verify album placement
-   verify derived READY state

# 7. Pagination

Public album share may contain many media.

Use cursor pagination.

Do not use offset.

Cursor:

-   timelineKey
-   mediaId

Ordering:

    timeline_key DESC,
    media_id DESC

# 8. Error Boundary

Public failures:

all:

    404

Includes:

-   invalid token
-   expired token
-   revoked token
-   deleted album
-   removed media placement

No state disclosure.

# 9. Cache

Default:

    Cache-Control: private, no-store

Reason:

-   revocation
-   expiration
-   placement changes

Future public CDN caching requires separate security review.

# 10. Rate Limit Requirement

Before production:

required:

-   token verification limit
-   public page limit
-   derived access limit

Not implemented in this phase.

# 11. Security Invariants

1.  Share token is the only external capability.

2.  Internal ACL is unchanged.

3.  Share cannot access removed placements.

4.  Share cannot access original storage.

5.  Invalid and expired links reveal no state.

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

Public rate limiting required before production.

P3:

CDN caching and public download policies deferred.

# Final Decision

PUBLIC_API_DESIGN_PASS:

YES

READY_FOR_IMPLEMENTATION:

YES
