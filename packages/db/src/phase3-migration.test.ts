import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../drizzle/0002_phase_03_storage_uploads.sql", import.meta.url),
  ),
  "utf8",
);
const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../drizzle/meta/0002_snapshot.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  tables: Record<
    string,
    {
      columns: Record<string, { type: string; notNull: boolean }>;
      indexes: Record<string, { columns: string[]; isUnique: boolean }>;
      foreignKeys: Record<
        string,
        { columnsFrom: string[]; columnsTo: string[]; tableTo: string }
      >;
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

describe("Phase 3B versioned migration", () => {
  it("creates only storage_objects then upload_sessions with explicit engine and collation", () => {
    expect(
      [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["storage_objects", "upload_sessions"]);
    expect(migration.match(/ENGINE=InnoDB/g)).toHaveLength(2);
    expect(migration.match(/DEFAULT CHARACTER SET=utf8mb4/g)).toHaveLength(2);
    expect(migration.match(/COLLATE=utf8mb4_0900_ai_ci/g)).toHaveLength(2);
    expect(migration).not.toMatch(
      /CREATE TABLE `(media_items|album_media|media_metadata|thumbnails|derived_assets|processing_jobs|comments|tags|ai_[^`]*)`/u,
    );
  });

  it("contains the exact reviewed indexes, foreign keys and checks", () => {
    expect(migration.match(/ FOREIGN KEY /g)).toHaveLength(4);
    expect(migration.match(/ CHECK\(/g)).toHaveLength(13);
    for (const name of [
      "uq_storage_objects_family_id",
      "uq_storage_objects_family_hash_size",
      "idx_storage_objects_state_verified",
      "uq_upload_sessions_public_id",
      "idx_upload_sessions_family_creator_state",
      "idx_upload_sessions_state_expiry",
      "idx_upload_sessions_family_object",
      "idx_upload_sessions_cleanup",
    ]) {
      expect(migration).toContain(`\`${name}\``);
    }
    expect(migration).toContain(
      "CONSTRAINT `fk_upload_sessions_creator_member` FOREIGN KEY (`family_id`,`created_by_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict",
    );
    expect(migration).toContain(
      "CONSTRAINT `fk_upload_sessions_storage_object` FOREIGN KEY (`family_id`,`storage_object_id`) REFERENCES `storage_objects`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict",
    );
  });

  it("encodes dedupe, offsets, terminal states and immutable receipt prerequisites", () => {
    expect(migration).toContain("UNIQUE(`family_id`,`sha256`,`byte_size`)");
    expect(migration).toContain(
      "`declared_size` > 0 AND `upload_sessions`.`committed_offset` <= `upload_sessions`.`declared_size`",
    );
    expect(migration).toContain(
      "`state` = 'COMPLETE' AND `upload_sessions`.`storage_object_id` IS NOT NULL",
    );
    expect(migration).toContain(
      "`state` IN ('FINALIZING','COMPLETE') AND `upload_sessions`.`computed_sha256` IS NOT NULL",
    );
    expect(migration).toContain(
      "`state` enum('AVAILABLE','MISSING','CORRUPT') NOT NULL",
    );
    expect(migration).toContain(
      "`state` enum('CREATED','UPLOADING','FINALIZING','COMPLETE','FAILED','ABORTED','EXPIRED') NOT NULL DEFAULT 'CREATED'",
    );
    expect(migration).toContain("`committed_offset` bigint unsigned");
    expect(migration).toContain(
      "CONSTRAINT `chk_storage_objects_size` CHECK(`storage_objects`.`byte_size` > 0)",
    );
    for (const check of [
      "chk_upload_sessions_created",
      "chk_upload_sessions_uploading",
      "chk_upload_sessions_finalize_pair",
      "chk_upload_sessions_finalize_state",
      "chk_upload_sessions_complete",
      "chk_upload_sessions_terminal",
      "chk_upload_sessions_failure",
      "chk_upload_sessions_times",
    ]) {
      expect(migration).toContain(`CONSTRAINT \`${check}\` CHECK`);
    }
    expect(migration).not.toMatch(
      /IF NOT EXISTS|DROP\s+(DATABASE|TABLE)|TRUNCATE/iu,
    );
    expect(migration).not.toMatch(
      /ALTER TABLE `(users|families|family_members|invitations|sessions|albums|album_members)`/u,
    );
  });

  it("keeps migration SQL, snapshot and journal boundaries aligned", () => {
    const storage = snapshot.tables.storage_objects!;
    const uploads = snapshot.tables.upload_sessions!;
    expect(Object.keys(storage.indexes)).toHaveLength(3);
    expect(Object.keys(uploads.indexes)).toHaveLength(5);
    expect(Object.keys(storage.foreignKeys)).toHaveLength(1);
    expect(Object.keys(uploads.foreignKeys)).toHaveLength(3);
    expect(Object.keys(storage.checkConstraint)).toHaveLength(3);
    expect(Object.keys(uploads.checkConstraint)).toHaveLength(10);
    expect(storage.indexes.uq_storage_objects_family_hash_size).toMatchObject({
      columns: ["family_id", "sha256", "byte_size"],
      isUnique: true,
    });
    expect(uploads.indexes.uq_upload_sessions_public_id).toMatchObject({
      columns: ["public_id"],
      isUnique: true,
    });
    expect(storage.columns.sha256?.type).toBe("binary(32)");
    expect(uploads.columns.public_id?.type).toBe("binary(16)");
    expect(uploads.columns.declared_size?.type).toBe("bigint unsigned");
    expect(uploads.foreignKeys.fk_upload_sessions_storage_object).toMatchObject(
      {
        columnsFrom: ["family_id", "storage_object_id"],
        tableTo: "storage_objects",
        columnsTo: ["family_id", "id"],
      },
    );
    expect(journal.entries.at(-1)).toEqual({
      idx: 2,
      version: "5",
      when: expect.any(Number),
      tag: "0002_phase_03_storage_uploads",
      breakpoints: true,
    });
  });
});
