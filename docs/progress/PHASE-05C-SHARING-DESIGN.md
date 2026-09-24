# PHASE-05C-SHARING-DESIGN

Status: DESIGN ONLY

Baseline:

-   Phase 5A Gallery complete
-   Phase 5B Album Operations complete
-   album_media placement model exists
-   Phase 2 ACL remains the internal authorization model

# PHASE_05C_SHARING_DESIGN_RESULT

# 1. Scope

Sharing introduces controlled external access.

Goal:

Allow a user to share selected family content without exposing internal
permissions.

Phase 5C includes:

-   share creation
-   share token
-   expiration
-   revoke
-   audit

Out of scope:

-   public search
-   account creation through share
-   editing shared content
-   upload through share
-   original unrestricted exposure

# 2. Share Object Model

Sharing should reference existing resources.

Possible targets:

-   album
-   media item

Recommended V1:

Album sharing first.

Reason:

-   album already has permission boundary
-   multiple media are naturally grouped
-   simpler lifecycle

No new ownership model.

# 3. Token Design

Rules:

Never store raw share token.

Flow:

    generate random token

    ↓

    store token hash

    ↓

    return raw token once

Database stores:

-   token_hash
-   created_at
-   expires_at
-   revoked_at

Token acts as capability.

Possession grants only the defined share permission.

# 4. Authorization Boundary

Internal access:

    Session

    ↓

    Family membership

    ↓

    Album ACL

External share:

    Share token

    ↓

    Share record

    ↓

    Target resource

    ↓

    Expiration check

Share token does not modify internal ACL.

# 5. Expiration

Required fields:

-   created_at
-   expires_at

Expired share:

-   returns not found
-   does not reveal expiration details

# 6. Revoke

Owner/admin can revoke.

Revoke:

sets:

    revoked_at

Never delete audit history.

# 7. Content Exposure

Default:

derived assets only.

Allowed:

-   thumbnail
-   preview

Not allowed by default:

-   original download

Original download requires separate future design.

# 8. Audit

Important events:

-   share created
-   share viewed
-   share revoked

Audit should record:

-   actor
-   target
-   time
-   action

Do not record:

-   raw token

# 9. Security Invariants

## Invariant 1

Internal album ACL is never weakened by sharing.

## Invariant 2

Share token only grants explicitly configured access.

## Invariant 3

Expired or revoked tokens cannot read content.

## Invariant 4

Raw tokens are never stored.

## Invariant 5

Share access does not expose original storage.

# 10. Schema Impact

Current:

UNKNOWN UNTIL IMPLEMENTATION REVIEW

Likely future additions:

-   shares table
-   share audit table

No migration approved in design stage.

# 11. Migration

NO MIGRATION AT DESIGN STAGE.

# 12. Findings

P0:

None

P1:

None

P2:

Need final decision:

-   album only or media sharing
-   download policy
-   anonymous viewer UX

P3:

Analytics and advanced sharing management deferred.

# Final Decision

SHARING_DESIGN_PASS:

YES

SCHEMA_CHANGE_REQUIRED:

UNKNOWN

MIGRATION_REQUIRED:

UNKNOWN

READY_FOR_IMPLEMENTATION:

NO

Next:

R3 schema and API design review before implementation.
