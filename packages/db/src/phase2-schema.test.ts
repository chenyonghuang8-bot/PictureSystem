import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import { albumMembers, albums } from "./schema.js";

describe("Phase 2 Drizzle schema", () => {
  it("defines only the two Phase 2 tables with precision-safe identifiers", () => {
    expect(
      [albums, albumMembers].map((table) => getTableConfig(table).name),
    ).toEqual(["albums", "album_members"]);
    for (const table of [albums, albumMembers]) {
      const config = getTableConfig(table);
      for (const columnName of ["id", "family_id"]) {
        const column = config.columns.find((item) => item.name === columnName);
        expect(column?.getSQLType()).toBe("bigint unsigned");
        expect(column?.dataType).toBe("bigint");
      }
    }
    expect(albums.revision.getSQLType()).toBe("bigint unsigned");
    expect(albums.revision.dataType).toBe("bigint");
    expect(albums.visibility.enumValues).toEqual(["FAMILY", "CUSTOM"]);
  });

  it("defines the reviewed album indexes and same-family foreign keys", () => {
    const config = getTableConfig(albums);
    expect(config.indexes.map((item) => item.config.name)).toEqual([
      "uq_albums_family_id",
      "idx_albums_family_deleted_id",
      "idx_albums_family_owner",
    ]);
    expect(config.foreignKeys.map((item) => item.getName())).toEqual([
      "fk_albums_family",
      "fk_albums_owner_member",
    ]);
    expect(config.checks.map((item) => item.name)).toEqual([
      "chk_albums_revision",
      "chk_albums_deleted_at",
    ]);
  });

  it("defines explicit ACL bits, indexes, same-family foreign keys, and checks", () => {
    const config = getTableConfig(albumMembers);
    expect(config.indexes.map((item) => item.config.name)).toEqual([
      "uq_album_members_album_member",
      "idx_album_members_family_album",
      "idx_album_members_family_member",
    ]);
    expect(config.foreignKeys.map((item) => item.getName())).toEqual([
      "fk_album_members_album",
      "fk_album_members_member",
    ]);
    expect(config.checks.map((item) => item.name)).toEqual([
      "chk_album_members_view_boolean",
      "chk_album_members_upload_boolean",
      "chk_album_members_edit_boolean",
      "chk_album_members_delete_boolean",
      "chk_album_members_manage_members_boolean",
      "chk_album_members_view_required",
    ]);
    for (const column of [
      albumMembers.canView,
      albumMembers.canUpload,
      albumMembers.canEdit,
      albumMembers.canDelete,
      albumMembers.canManageMembers,
    ]) {
      expect(column.getSQLType()).toBe("boolean");
      expect(column.notNull).toBe(true);
    }
  });

  it("contains no media lifecycle columns or owner ACL duplicate", () => {
    const columns = [albums, albumMembers].flatMap((table) =>
      getTableConfig(table).columns.map((column) => column.name),
    );
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "media_id",
        "storage_object_id",
        "original_path",
        "owner_role",
      ]),
    );
  });
});
