import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../drizzle/0001_phase_02_albums_permissions.sql", import.meta.url),
  ),
  "utf8",
);
const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../drizzle/meta/0001_snapshot.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  tables: Record<
    string,
    {
      indexes: Record<string, unknown>;
      foreignKeys: Record<string, unknown>;
      checkConstraint: Record<string, { name: string; value: string }>;
    }
  >;
};
const journal = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  ),
) as { entries: Array<{ idx: number; tag: string }> };

describe("Phase 2 versioned migration", () => {
  it("creates exactly the reviewed InnoDB utf8mb4 tables", () => {
    expect(
      [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["album_members", "albums"]);
    expect(migration.match(/ENGINE=InnoDB/g)).toHaveLength(2);
    expect(migration.match(/DEFAULT CHARACTER SET=utf8mb4/g)).toHaveLength(2);
    expect(migration).not.toMatch(
      /CREATE TABLE `(media_items|storage_objects|album_media|comments|tags|ai_[^`]*)`/,
    );
  });

  it("contains the reviewed index, FK, CHECK, and revision boundaries", () => {
    for (const name of [
      "uq_albums_family_id",
      "idx_albums_family_deleted_id",
      "idx_albums_family_owner",
      "uq_album_members_album_member",
      "idx_album_members_family_album",
      "idx_album_members_family_member",
    ]) {
      expect(migration).toContain(`\`${name}\``);
    }
    expect(migration.match(/ FOREIGN KEY /g)).toHaveLength(4);
    expect(migration.match(/ CHECK\(/g)).toHaveLength(8);
    expect(migration).toContain(
      "`revision` bigint unsigned NOT NULL DEFAULT 1",
    );
    expect(migration).toContain(
      "CONSTRAINT `chk_albums_revision` CHECK(`albums`.`revision` >= 1)",
    );
    expect(migration).toContain(
      "CONSTRAINT `fk_albums_owner_member` FOREIGN KEY (`family_id`,`owner_member_id`) REFERENCES `family_members`(`family_id`,`id`)",
    );
    expect(migration).toContain(
      "CONSTRAINT `fk_album_members_album` FOREIGN KEY (`family_id`,`album_id`) REFERENCES `albums`(`family_id`,`id`)",
    );
    expect(migration).toContain(
      "CONSTRAINT `fk_album_members_member` FOREIGN KEY (`family_id`,`member_id`) REFERENCES `family_members`(`family_id`,`id`)",
    );
  });

  it("keeps migration SQL and Drizzle snapshot boundaries aligned", () => {
    expect(Object.keys(snapshot.tables)).toEqual(
      expect.arrayContaining(["albums", "album_members"]),
    );
    expect(Object.keys(snapshot.tables.albums!.indexes)).toHaveLength(3);
    expect(Object.keys(snapshot.tables.album_members!.indexes)).toHaveLength(3);
    expect(Object.keys(snapshot.tables.albums!.foreignKeys)).toHaveLength(2);
    expect(
      Object.keys(snapshot.tables.album_members!.foreignKeys),
    ).toHaveLength(2);
    expect(Object.keys(snapshot.tables.albums!.checkConstraint)).toHaveLength(
      2,
    );
    expect(
      Object.keys(snapshot.tables.album_members!.checkConstraint),
    ).toHaveLength(6);
    expect(
      snapshot.tables.album_members!.checkConstraint
        .chk_album_members_view_required?.value,
    ).toContain("`album_members`.`can_view` = 1 OR");
  });

  it("records 0001 without hiding drift or destructive operations", () => {
    expect(journal.entries.find((entry) => entry.idx === 1)).toEqual({
      idx: 1,
      version: "5",
      when: expect.any(Number),
      tag: "0001_phase_02_albums_permissions",
      breakpoints: true,
    });
    expect(migration).not.toMatch(/IF NOT EXISTS/i);
    expect(migration).not.toMatch(/DROP\s+(DATABASE|TABLE)/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
    expect(migration).not.toMatch(
      /ALTER TABLE `(families|family_members|users|invitations|sessions)`/,
    );
  });
});
