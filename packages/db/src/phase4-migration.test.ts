import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import {
  backgroundJobs,
  derivedAssets,
  mediaItems,
  uploadSessions,
} from "./schema.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../drizzle/0003_phase_04_media_processing.sql", import.meta.url),
  ),
  "utf8",
);
const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../drizzle/meta/0003_snapshot.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  id: string;
  prevId: string;
  tables: Record<
    string,
    {
      columns: Record<string, { type: string; notNull: boolean }>;
      indexes: Record<string, { columns: string[]; isUnique: boolean }>;
      foreignKeys: Record<
        string,
        {
          columnsFrom: string[];
          columnsTo: string[];
          tableTo: string;
        }
      >;
      checkConstraint: Record<string, { value: string }>;
    }
  >;
};
const previous = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../drizzle/meta/0002_snapshot.json", import.meta.url),
    ),
    "utf8",
  ),
) as { id: string; tables: Record<string, unknown> };
const journal = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  ),
) as { entries: Array<{ idx: number; tag: string; when: number }> };

describe("Phase 4A versioned migration", () => {
  it("creates only the three reviewed InnoDB utf8mb4 tables and one source index", () => {
    expect(
      [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["background_jobs", "derived_assets", "media_items"]);
    expect(migration.match(/ENGINE=InnoDB/g)).toHaveLength(3);
    expect(migration.match(/DEFAULT CHARACTER SET=utf8mb4/g)).toHaveLength(3);
    expect(migration.match(/COLLATE=utf8mb4_0900_ai_ci/g)).toHaveLength(3);
    expect(
      [
        ...migration.matchAll(
          /ALTER TABLE `([^`]+)` ADD CONSTRAINT `uq_[^`]+`/g,
        ),
      ].map((match) => match[1]),
    ).toEqual(["upload_sessions"]);
    expect(migration).toContain(
      "ALTER TABLE `upload_sessions` ADD CONSTRAINT `uq_upload_sessions_family_id_object` UNIQUE(`family_id`,`id`,`storage_object_id`)",
    );
    expect(migration).not.toMatch(
      /IF NOT EXISTS|DROP\s+(DATABASE|TABLE)|TRUNCATE|ALTER TABLE `(users|families|family_members|invitations|sessions|albums|album_members|storage_objects)`/iu,
    );
  });

  it("enforces same-family source/storage/media/job and unique generation identity", () => {
    expect(migration.match(/ FOREIGN KEY /g)).toHaveLength(5);
    expect(migration).toContain(
      "CONSTRAINT `fk_media_items_source_upload` FOREIGN KEY (`family_id`,`source_upload_id`,`storage_object_id`) REFERENCES `upload_sessions`(`family_id`,`id`,`storage_object_id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "CONSTRAINT `fk_media_items_storage_object` FOREIGN KEY (`family_id`,`storage_object_id`) REFERENCES `storage_objects`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "CONSTRAINT `fk_derived_assets_producer_job` FOREIGN KEY (`family_id`,`media_id`,`producer_job_id`) REFERENCES `background_jobs`(`family_id`,`media_id`,`id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "CONSTRAINT `uq_media_items_family_storage_object` UNIQUE(`family_id`,`storage_object_id`)",
    );
    expect(migration).toContain(
      "CONSTRAINT `uq_background_jobs_identity` UNIQUE(`family_id`,`media_id`,`generation`,`recipe_id`,`job_type`)",
    );
    expect(migration).toContain(
      "CONSTRAINT `uq_derived_assets_identity` UNIQUE(`family_id`,`media_id`,`generation`,`recipe_id`,`kind`)",
    );
  });

  it("encodes the approved GPS, captured-time, lease, retry and READY prerequisites", () => {
    expect(migration.match(/ CHECK\(/g)).toHaveLength(31);
    for (const required of [
      "chk_media_items_gps",
      "chk_media_items_capture",
      "chk_media_items_timeline",
      "chk_media_items_raw_dimensions",
      "chk_media_items_ready_metadata",
      "chk_media_items_warning_flags",
      "chk_derived_assets_reservation",
      "chk_derived_assets_bytes_digest",
      "chk_derived_assets_published_payload",
      "chk_derived_assets_ready",
      "chk_background_jobs_attempts",
      "chk_background_jobs_lease",
      "chk_background_jobs_terminal",
      "chk_background_jobs_failure",
    ]) {
      expect(migration).toContain(`CONSTRAINT \`${required}\` CHECK`);
    }
    expect(migration).toContain("`gps_latitude` decimal(9,6)");
    expect(migration).toContain("`gps_longitude` decimal(10,6)");
    expect(migration).toContain("`duration_ms` bigint unsigned");
    expect(migration).toContain("`worker_id` binary(16)");
    expect(migration).toContain("`sha256` binary(32)");
    expect(migration).toContain(
      "`attempts` tinyint unsigned NOT NULL DEFAULT 0",
    );
    expect(migration).toContain(
      "`lease_epoch` bigint unsigned NOT NULL DEFAULT 0",
    );
  });

  it("keeps schema, SQL, snapshot and ordered journal in exact agreement", () => {
    const tables = [backgroundJobs, derivedAssets, mediaItems] as const;
    for (const table of tables) {
      const config = getTableConfig(table);
      const snap = snapshot.tables[config.name]!;
      expect(Object.keys(snap.columns).sort()).toEqual(
        config.columns.map((column) => column.name).sort(),
      );
      expect(Object.keys(snap.indexes).sort()).toEqual(
        config.indexes.map((item) => item.config.name).sort(),
      );
      expect(Object.keys(snap.foreignKeys).sort()).toEqual(
        config.foreignKeys.map((key) => key.getName()).sort(),
      );
      expect(Object.keys(snap.checkConstraint).sort()).toEqual(
        config.checks.map((item) => item.name).sort(),
      );
      for (const [name, check] of Object.entries(snap.checkConstraint)) {
        expect(migration).toContain(
          `CONSTRAINT \`${name}\` CHECK(${check.value})`,
        );
      }
    }
    expect(
      snapshot.tables.upload_sessions!.indexes
        .uq_upload_sessions_family_id_object,
    ).toMatchObject({
      columns: ["family_id", "id", "storage_object_id"],
      isUnique: true,
    });
    expect(getTableConfig(uploadSessions).indexes).toHaveLength(6);
    expect(snapshot.prevId).toBe(previous.id);
    expect(journal.entries).toHaveLength(4);
    expect(journal.entries.map((entry) => entry.idx)).toEqual([0, 1, 2, 3]);
    expect(journal.entries[3]).toMatchObject({
      idx: 3,
      tag: "0003_phase_04_media_processing",
    });
    expect(journal.entries[3]!.when).toBeGreaterThan(journal.entries[2]!.when);
  });
});
