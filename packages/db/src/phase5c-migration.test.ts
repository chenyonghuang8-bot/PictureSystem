import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import {
  albumMedia,
  albums,
  derivedAssets,
  mediaItems,
  shareEvents,
  shares,
} from "./schema.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../drizzle/0005_phase_05c_sharing.sql", import.meta.url),
  ),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  ),
) as { entries: Array<{ idx: number; tag: string; when: number }> };
const snapshot0004 = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../drizzle/meta/0004_snapshot.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  id: string;
  tables: Record<string, { columns: Record<string, unknown> }>;
};
const snapshot0005 = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../drizzle/meta/0005_snapshot.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  prevId: string;
  tables: Record<
    string,
    {
      columns: Record<string, unknown>;
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

describe("0005 sharing migration", () => {
  it("appends one additive journal entry after the unchanged 0004 migration", () => {
    expect(journal.entries.map((entry) => entry.tag)).toEqual([
      "0000_phase_01a_identity_foundation",
      "0001_phase_02_albums_permissions",
      "0002_phase_03_storage_uploads",
      "0003_phase_04_media_processing",
      "0004_phase_04_album_media",
      "0005_phase_05c_sharing",
    ]);
    expect(journal.entries[5]!.when).toBeGreaterThan(journal.entries[4]!.when);
    expect(snapshot0004.id).toBe("29b5833a-bb05-466f-b3d3-288112405627");
    expect(snapshot0005.prevId).toBe(snapshot0004.id);
    expect(migration).not.toMatch(/ALTER TABLE `(?!shares`|share_events`)/);
    expect(migration).not.toMatch(/CASCADE/i);
    expect(migration).not.toMatch(/DROP\s+(DATABASE|TABLE)/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements.map((statement) => statement.split(/\s+/u)[0])).toEqual([
      "CREATE",
      "CREATE",
      "ALTER",
      "ALTER",
      "ALTER",
      "ALTER",
      "ALTER",
      "ALTER",
      "CREATE",
      "CREATE",
      "CREATE",
    ]);
    expect(migration.match(/ENGINE=InnoDB/g)).toHaveLength(2);
    expect(migration.match(/COLLATE=utf8mb4_0900_ai_ci/g)).toHaveLength(2);
    expect(migration.match(/ FOREIGN KEY /g)).toHaveLength(6);
    expect(migration.match(/ CHECK\(/g)).toHaveLength(4);
    expect(migration).toContain("UNIQUE(`token_hash`)");
    expect(migration).toContain(
      "CHECK(`shares`.`expires_at` > `shares`.`created_at`)",
    );
    expect(migration).toContain(
      "(`shares`.`revoked_at` IS NULL AND `shares`.`revoked_by_member_id` IS NULL) OR (`shares`.`revoked_at` IS NOT NULL AND `shares`.`revoked_by_member_id` IS NOT NULL)",
    );
    expect(migration).toContain(
      "(`share_events`.`event_type` IN ('CREATE','REVOKE') AND `share_events`.`actor_member_id` IS NOT NULL) OR (`share_events`.`event_type` = 'ACCESS' AND `share_events`.`actor_member_id` IS NULL)",
    );
    expect(migration).toContain(
      "FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "FOREIGN KEY (`family_id`,`album_id`) REFERENCES `albums`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "FOREIGN KEY (`family_id`,`created_by_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "FOREIGN KEY (`family_id`,`revoked_by_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "FOREIGN KEY (`family_id`,`share_id`) REFERENCES `shares`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "FOREIGN KEY (`family_id`,`actor_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "CREATE INDEX `idx_shares_family_album_id` ON `shares` (`family_id`,`album_id`,`id`)",
    );
    expect(migration).toContain(
      "CREATE INDEX `idx_shares_expires` ON `shares` (`expires_at`,`id`)",
    );
    expect(migration).toContain(
      "CREATE INDEX `idx_share_events_share` ON `share_events` (`family_id`,`share_id`,`id`)",
    );
  });

  it("adds sharing tables without changing album or media columns", () => {
    for (const name of [
      "albums",
      "album_media",
      "media_items",
      "derived_assets",
    ]) {
      expect(Object.keys(snapshot0005.tables[name]!.columns)).toEqual(
        Object.keys(snapshot0004.tables[name]!.columns),
      );
    }
    expect(snapshot0004.tables.shares).toBeUndefined();
    expect(snapshot0004.tables.share_events).toBeUndefined();
    expect(columnNames(shares)).toEqual([
      "album_id",
      "created_at",
      "created_by_member_id",
      "expires_at",
      "family_id",
      "id",
      "revoked_at",
      "revoked_by_member_id",
      "token_hash",
    ]);
    expect(columnNames(shareEvents)).toEqual([
      "actor_member_id",
      "created_at",
      "event_type",
      "family_id",
      "id",
      "share_id",
    ]);
    expect(columnNames(albums)).toEqual(
      Object.keys(snapshot0004.tables.albums!.columns).sort(),
    );
    expect(columnNames(albumMedia)).toEqual(
      Object.keys(snapshot0004.tables.album_media!.columns).sort(),
    );
    expect(columnNames(mediaItems)).toEqual(
      Object.keys(snapshot0004.tables.media_items!.columns).sort(),
    );
    expect(columnNames(derivedAssets)).toEqual(
      Object.keys(snapshot0004.tables.derived_assets!.columns).sort(),
    );
    for (const table of ["shares", "share_events"] as const) {
      for (const key of Object.values(
        snapshot0005.tables[table]!.foreignKeys,
      )) {
        expect(key.onDelete).toBe("restrict");
        expect(key.onUpdate).toBe("restrict");
      }
    }
  });
});
