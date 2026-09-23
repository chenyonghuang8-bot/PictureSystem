# Phase 4D3c-2a — Media visibility schema design

Status: design only. No schema file, migration, API, or business code is changed by this document.

Approved choice: Option B, an `album_media` association. Visibility is computed from the existing album ACL. It is not stored on `media_items`, `derived_assets`, or `storage_objects`.

```text
albums
  ↓
album_media
  ↓
media_items
  ↓
derived_assets
```

## 1. Association table

`album_media` is a membership row. It records that one canonical media item is placed in one album. It does not grant permissions, store a caption, or point at a file.

| Column | Type | Why |
| --- | --- | --- |
| `id` | `BIGINT UNSIGNED` primary key | Stable row identity. Callers never use it as a storage key. |
| `family_id` | `BIGINT UNSIGNED NOT NULL` | Same composite-FK boundary already used by `album_members` and `media_items`. The client does not supply it. Both parent FKs use this one column, so a row cannot pair an album from one family with media from another. |
| `album_id` | `BIGINT UNSIGNED NOT NULL` | Album end of the association. |
| `media_id` | `BIGINT UNSIGNED NOT NULL` | Canonical media end of the association. |
| `created_at` | `DATETIME(3) NOT NULL` | Server time of the placement. Enough to order a later gallery without a separate position column. |

Not in this table:

- `deleted_at`. Album deletion already lives on `albums.deleted_at`. A second tombstone would make “removed from this album” ambiguous and would keep a hidden row that a bad query could treat as visible. Removing a photo from an album deletes the association row. Deleting an album does not.
- Ordering. Serving authorization does not need a position. `created_at, id` is a stable order if a later gallery needs one. A position column can be added only when reordering is an approved feature.
- Metadata, cover flags, captions, GPS, or permission bits. Those would copy authority that already has one owner.

No `created_by_member_id` in this version. The uploader remains on the upload session that produced the media. Putting a member FK here would block later member removal for a reason that is not required to authorize a read.

## 2. Cardinality

The relationship is many-to-many.

- One album contains many media items.
- One media item may be placed in many albums in the same family.
- The same pair cannot be inserted twice.

`UNIQUE (family_id, album_id, media_id)` enforces that.

Canonical media does not change. A family still has one `media_items` row per `storage_objects` row (`UNIQUE (family_id, storage_object_id)`). Placing that photo in a second album adds an association row. It does not create a second media item, a second original, or a second derived generation.

## 3. Permission inheritance

A derived read is allowed only through this chain:

```text
authenticated active family member
  → one album the member can view
  → album_media row for that album and this media
  → media_items in the same family
  → derived_assets for that media, current generation, recipe 1, requested kind, state READY
  → storage read of that derived identity
```

`canView` is the existing Phase 2 rule: active member, same family, album `deleted_at` is null, then owner, or `FAMILY` visibility, or an explicit `can_view` grant. `SUPER_ADMIN` and `ADMIN` still have no album bypass. Family role is not an input to this decision.

Media id by itself is not an authorization. The handler must not open a derived file from `media_id` until the association and `canView` checks have both succeeded. A client-supplied album id is not sufficient either: the association has to bind that album to that media. Otherwise a visible album id could be paired with someone else’s media id.

`can_upload` is the future right to create an association. `can_delete` is the future right to delete that association. Neither right deletes an original, a storage object, or a derived file. Those write APIs are not part of this design’s implementation.

## 4. Deleted album

Album delete stays the Phase 2 soft delete: set `albums.deleted_at`, bump `revision`, leave `album_members` in place.

Effects:

| Row | What delete does |
| --- | --- |
| `albums` | Soft delete only. |
| `album_media` | Rows stay. They stop granting visibility while `albums.deleted_at` is not null. |
| `media_items` | Unchanged. |
| `derived_assets` | Unchanged. |
| `storage_objects` | Unchanged. |

This is not an unlink. Unlink is a separate, explicit `DELETE` of one `album_media` row by someone who can view the album and has `can_delete` (or is the owner). That unlink removes only the placement. If the media remains in another visible album, viewers of that other album can still read its READY derived files. If it remains in no visible album, it becomes an orphan for serving purposes and is not readable.

Hard-deleting an album row is not a product operation. The foreign keys below use `RESTRICT`, so a direct `DELETE FROM albums` cannot succeed while associations exist, and it still cannot reach the original.

## 5. Orphan media

An orphan is a `media_items` row with no `album_media` row, or whose only associations belong to deleted albums.

Orphans are allowed. Current finalize creates canonical media before any album placement exists, and this migration does not invent placements. The worker may still probe, render, and mark derived assets `READY` for an orphan. Processing is not a read grant.

Orphans are not servable. Every derived read fails closed with the same not-found result used for a hidden album. They are not auto-deleted. Automatic deletion would risk the original, and nothing in the current schema identifies an orphan as trash.

## 6. Multiple albums

If the media is in Album A and Album B, and the caller can view A but not B, the caller can read that media’s READY derived files.

Access is the union of view rights over live associations. Lack of access to B does not veto A. The response and logs must not reveal B, its id, or the count of hidden associations. `can_delete` on A unlinks A only.

## 7. Derived visibility

`derived_assets` does not gain permission columns, album ids, or visibility flags. ACL stays on `albums` and `album_members`.

A later serving implementation may return bytes only when all of the following are true in the same authorization: a live viewable association, the derived row’s family, media, generation, and recipe match the media’s current identity, `kind` is `THUMBNAIL` or `PREVIEW`, `state` is `READY`, and the storage object is `AVAILABLE`. `RESERVED`, `PUBLISHING`, `FAILED`, `MISSING`, and media `BLOCKED` are not served. After the caller has already proven view access, a non-READY kind still returns the same not-found result, without naming the internal state.

The storage read uses the server-derived identity. The client cannot pass a path, filename, storage key, device, or inode.

## 8. Migration plan

Future implementation, after this design is approved, adds one migration:

`0004_phase_04_album_media.sql`

It only creates `album_media`, its indexes, check constraints, and foreign keys. It does not alter `albums`, `album_members`, `media_items`, `derived_assets`, `storage_objects`, or originals. It does not backfill. Existing media stays orphaned until a later reviewed placement flow. Auto-attaching every existing media item to every family album would publish photos into albums the uploader did not choose.

This is additive DDL on an empty table. It does not rewrite media or original bytes. It is not a zero-downtime mixed-version deploy: once `0004` is in the journal, an older build fails the existing readiness check because the schema and the code must match. Deployment order remains migrate, then run the build that understands the journal. Rollback is not “ignore the new journal entry.”

`MIGRATION_READY` stays no until a separate review accepts the generated SQL, snapshot, and DEV preflight. This document does not create that SQL.

## 9. Foreign keys

Both foreign keys are `ON DELETE RESTRICT` and `ON UPDATE RESTRICT`.

| Constraint | Columns | Target |
| --- | --- | --- |
| `fk_album_media_album` | `(family_id, album_id)` | `albums (family_id, id)` |
| `fk_album_media_media` | `(family_id, media_id)` | `media_items (family_id, id)` |

There is no foreign key to `derived_assets` or `storage_objects`. Deleting or soft-deleting an album cannot delete a media item, an original, or a derived file. Deleting a media row is also refused while any association remains, so the association cannot dangle. There is no `CASCADE`.

## 10. Indexes

| Index | Columns | Use |
| --- | --- | --- |
| Primary key | `id` | Row identity. |
| `uq_album_media_placement` | `(family_id, album_id, media_id)` | One placement, and album-to-media lookup. |
| `idx_album_media_media` | `(family_id, media_id, album_id)` | Media-to-album lookup for the serving authorization. |

The unique key’s leftmost columns serve “media in this album.” The second index serves “albums that contain this media” without scanning placements from other families.

## 11. IDOR prevention

The authorization lookup is one server-side decision:

```text
active member of family F
AND album.family_id = F
AND album.deleted_at IS NULL
AND album_media.family_id = F
AND album_media.album_id = album.id
AND album_media.media_id = requested media
AND media.family_id = F
AND canView(album) = true
AND derived row is READY for the current generation, recipe 1, and requested kind
AND storage object is AVAILABLE
```

Missing member, wrong family, deleted album, missing association, CUSTOM album without view, non-READY asset, and missing file are the same not-found response. The server does not answer a media-id-only derived read, and it does not answer a path read. Kind is only `thumbnail` or `preview`. Any other kind, recipe, generation, path segment, or storage key is a bad request or not-found, and it is never opened as a filesystem path.

Logs for a refusal stay on the Phase 2 allowlist: event, request id, result code, actor ids, family id. They do not include album name, filename, absolute path, original SHA-256, or the hidden album’s existence.

## 12. Compatibility

Phase 2 ACL is unchanged. `evaluateAlbumPermissions` remains the view decision. Album soft delete, owner rules, and the absence of a family-role bypass stay as they are. `can_delete` still does not mean “delete the original.”

Phase 3 originals stay immutable. This table does not reference `storage_objects` and has no cascade into the original namespace.

Phase 4 canonical media stays one row per family and storage object. Derived state, generation, recipe, and the READY transaction stay the source of whether bytes exist. The worker may process media that no album can see. Placement does not change job lease, epoch, or generation.

## Decision

`SCHEMA_DESIGN_PASS` for this document means the association and its constraints are specified. It does not mean the migration file exists or that API serving may start. Serving waits for design review, then a separate migration implementation, then a separate route that uses this lookup.
