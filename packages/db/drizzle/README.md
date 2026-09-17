# Drizzle migrations

`0000_phase_01a_identity_foundation` is the Phase 1A Identity Foundation
migration. It creates only these application tables:

- `users`
- `families`
- `family_members`
- `invitations`
- `sessions`

Before executing this migration, run the Phase 1A preflight check. The target
database must be `family_album_dev`, and the database account must not be
`root`.

Do not import `database/schema.sql` as a substitute for this versioned
migration. Do not use this migration in Production unless it has completed a
separate Production review and received explicit approval.

`0001_phase_02_albums_permissions` is the reviewed Phase 2 schema migration.
It creates only `albums` and `album_members`; it does not create media or later
phase tables. Before execution, run `pnpm --filter @family-album/db
db:preflight:phase-02`. The preflight requires `family_album_dev`, a non-root
account, the reviewed Phase 1 migration journal, Native FK enforcement, and no
existing Phase 2 tables. Do not run this migration in Production without a
separate Production review and explicit approval.

`0002_phase_03_storage_uploads` is the reviewed Phase 3B storage/upload schema
migration. It creates only `storage_objects` and `upload_sessions`; it does not
create media, derived-asset, processing, comment, tag, or AI tables. Before
execution, run `pnpm --filter @family-album/db db:preflight:phase-03`. The
preflight requires `family_album_dev`, MySQL 9.7.2, a non-root account, Native
FK enforcement, exact Phase 1/2 journal and schema readiness, and no existing
Phase 3 tables. Do not import `database/schema.sql`, and do not run this
migration in Production without a separate Production review and explicit
approval.
