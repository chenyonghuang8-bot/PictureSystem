import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import {
  albumMedia,
  albumMembers,
  albums,
  derivedAssets,
  mediaItems,
} from "./schema.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../drizzle/0004_phase_04_album_media.sql", import.meta.url),
  ),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  ),
) as { entries: Array<{ idx: number; tag: string; when: number }> };
const snapshot0003 = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../drizzle/meta/0003_snapshot.json", import.meta.url),
    ),
    "utf8",
  ),
) as { id: string; tables: Record<string, { columns: Record<string, unknown> }> };
const snapshot0004 = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../drizzle/meta/0004_snapshot.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  prevId: string;
  tables: Record<
    string,
    {
      foreignKeys: Record<
        string,
        { onDelete: string; onUpdate: string; tableTo: string }
      >;
    }
  >;
};

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table)
    .columns.map((column) => column.name)
    .sort();
}

describe("0004 album_media migration", () => {
  it("appends one additive journal entry after the unchanged 0003 migration", () => {
    expect(journal.entries.map((entry) => entry.tag)).toEqual([
      "0000_phase_01a_identity_foundation",
      "0001_phase_02_albums_permissions",
      "0002_phase_03_storage_uploads",
      "0003_phase_04_media_processing",
      "0004_phase_04_album_media",
    ]);
    expect(journal.entries[4]!.when).toBeGreaterThan(journal.entries[3]!.when);
    expect(snapshot0004.prevId).toBe(snapshot0003.id);
    expect(migration).toMatch(/CREATE TABLE `album_media`/);
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements.map((statement) => statement.split(/\s+/u)[0])).toEqual([
      "CREATE",
      "ALTER",
      "ALTER",
      "CREATE",
    ]);
    expect(migration).not.toMatch(/ALTER TABLE `(?!album_media`)/);
    expect(migration).not.toMatch(/CASCADE/i);
    expect(migration).toContain(
      "FOREIGN KEY (`family_id`,`album_id`) REFERENCES `albums`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "FOREIGN KEY (`family_id`,`media_id`) REFERENCES `media_items`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "UNIQUE(`family_id`,`album_id`,`media_id`)",
    );
    expect(migration).toContain(
      "CREATE INDEX `idx_album_media_media` ON `album_media` (`family_id`,`media_id`,`album_id`)",
    );
  });

  it("keeps Phase 2 ACL and Phase 3/4 tables at their 0003 columns", () => {
    for (const table of [albums, albumMembers, mediaItems, derivedAssets]) {
      const config = getTableConfig(table);
      expect(columnNames(table)).toEqual(
        Object.keys(snapshot0003.tables[config.name]!.columns).sort(),
      );
    }
    expect(snapshot0003.tables.album_media).toBeUndefined();
    const config = getTableConfig(albumMedia);
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "family_id",
      "album_id",
      "media_id",
      "created_at",
    ]);
    expect(config.foreignKeys).toHaveLength(2);
    for (const key of Object.values(
      snapshot0004.tables.album_media!.foreignKeys,
    )) {
      expect(key.onDelete).toBe("restrict");
      expect(key.onUpdate).toBe("restrict");
    }
  });
});
