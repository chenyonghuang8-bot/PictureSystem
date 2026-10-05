import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import {
  mediaItems,
  purgeFiles,
  purgeIntents,
  storageObjects,
  uploadSessions,
} from "./schema.js";
import {
  assertExactSchema,
  buildExpectedSchemaSnapshot,
  buildPhase7PredecessorSchemaSnapshot,
  buildPhase8PredecessorSchemaSnapshot,
  loadExpectedMigrationManifest,
} from "./migration-readiness.js";

const read = (name: string) => readFileSync(new URL(name, import.meta.url));
const sql = read("../drizzle/0007_phase_07_trash.sql").toString();
const prior = JSON.parse(
  read("../drizzle/meta/0006_snapshot.json").toString(),
) as { id: string };
const next = JSON.parse(
  read("../drizzle/meta/0007_snapshot.json").toString(),
) as {
  prevId: string;
  tables: Record<
    string,
    {
      columns: Record<string, { type: string; notNull: boolean }>;
      indexes: Record<string, { columns: string[]; isUnique: boolean }>;
      foreignKeys: Record<string, unknown>;
      checkConstraint: Record<string, { value: string }>;
    }
  >;
};
const dialect = new MySqlDialect();

describe("Phase 7A migration static safety", () => {
  it("keeps the frozen 0006 hash and appends exactly one reviewed migration", async () => {
    expect(
      createHash("sha256")
        .update(read("../drizzle/0006_phase_06_album_features.sql"))
        .digest("hex"),
    ).toBe("533b8f57d98dd10251d770326cd7df1d22481b087eb23c46edd7ec2a493017e4");
    const manifest = await loadExpectedMigrationManifest();
    expect(manifest.slice(0, 8)).toHaveLength(8);
    expect(manifest[7]?.tag).toBe("0007_phase_07_trash");
    expect(next.prevId).toBe(prior.id);
  });

  it("contains the three durable tables and only the approved old-table changes", () => {
    expect(
      [...sql.matchAll(/CREATE TABLE `([^`]+)`/g)].map((match) => match[1]),
    ).toEqual(["audit_logs", "purge_files", "purge_intents"]);
    expect(sql.match(/ENGINE=InnoDB/g)).toHaveLength(3);
    expect(sql).not.toMatch(
      /IF NOT EXISTS|TRUNCATE|DROP TABLE|DROP COLUMN|ON DELETE cascade|foreign_key_checks\s*=/i,
    );
    expect(
      [...sql.matchAll(/ALTER TABLE `([^`]+)`/g)].map((match) => match[1]),
    ).toEqual(
      expect.arrayContaining([
        "media_items",
        "upload_sessions",
        "storage_objects",
      ]),
    );
    expect(Object.keys(next.tables)).toEqual(
      expect.arrayContaining(["purge_intents", "purge_files", "audit_logs"]),
    );
    expect(sql).toContain(
      "`purge_after` = `media_items`.`trashed_at` + INTERVAL 30 DAY",
    );
    expect(sql).toContain("'RETIRED'");
    expect(sql).toContain("'PURGING'");
    expect(sql).toContain(
      "`storage_object_id` IS NULL AND `upload_sessions`.`completed_at` IS NOT NULL",
    );
    expect(sql).toContain("`retired_purge_id` bigint unsigned");
    expect(sql).toContain("`quarantine_slot` binary(16)");
    expect(sql).not.toMatch(
      /`(?:absolute_path|relative_path|filename|file_path)`/i,
    );
    expect(sql).not.toContain("FOREIGN KEY (`retired_storage_object_id`)");
    expect(sql).not.toContain("REFERENCES `media_items`");
    expect(sql).not.toContain("REFERENCES `storage_objects`(`id`)");
  });

  it("uses strict readiness for the post-0007 schema", () => {
    const before = buildPhase7PredecessorSchemaSnapshot();
    const after = buildPhase8PredecessorSchemaSnapshot();
    expect(before.tables).toHaveLength(21);
    expect(after.tables).toHaveLength(24);
    expect(() => assertExactSchema(after, before)).toThrow();
    for (const table of ["purge_intents", "purge_files", "audit_logs"]) {
      const partial = structuredClone(after);
      partial.tables = partial.tables.filter((row) => row.name !== table);
      expect(() => assertExactSchema(after, partial)).toThrow();
    }
  });

  it("enforces one canonical Original slot per intent without replacing file identity uniqueness", () => {
    const config = getTableConfig(purgeFiles);
    expect(purgeFiles.originalSingletonSlot.getSQLType()).toBe(
      "tinyint unsigned",
    );
    expect(purgeFiles.originalSingletonSlot.notNull).toBe(false);
    for (const [name, columns] of [
      [
        "uq_purge_files_original_singleton",
        ["family_id", "purge_intent_id", "original_singleton_slot"],
      ],
      [
        "uq_purge_files_identity",
        ["family_id", "purge_intent_id", "identity_key"],
      ],
    ] as const) {
      const index = config.indexes.find((item) => item.config.name === name)!;
      expect(index.config.unique).toBe(true);
      expect(
        index.config.columns.map((column) =>
          "name" in column ? column.name : dialect.sqlToQuery(column).sql,
        ),
      ).toEqual(columns);
      expect(sql).toContain(
        `CONSTRAINT \`${name}\` UNIQUE(${columns.map((column) => `\`${column}\``).join(",")})`,
      );
    }
    const guard = dialect.sqlToQuery(
      config.checks.find(
        (item) => item.name === "chk_purge_files_original_singleton",
      )!.value,
    ).sql;
    expect(guard).toBe(
      "(`purge_files`.`file_kind` = 'ORIGINAL' AND `purge_files`.`original_singleton_slot` IS NOT NULL AND `purge_files`.`original_singleton_slot` = 1) OR (`purge_files`.`file_kind` = 'DERIVED' AND `purge_files`.`original_singleton_slot` IS NULL)",
    );
    expect(sql).toContain(`CHECK(${guard})`);
    expect(
      next.tables.purge_files!.checkConstraint
        .chk_purge_files_original_singleton!.value,
    ).toBe(guard);
    const expected = buildExpectedSchemaSnapshot();
    for (const field of ["columns", "indexes", "checks"] as const) {
      const partial = structuredClone(expected);
      const table = partial.tables.find((item) => item.name === "purge_files")!;
      if (field === "columns")
        table.columns = table.columns.filter(
          (item) => item.name !== "original_singleton_slot",
        );
      if (field === "indexes")
        table.indexes = table.indexes.filter(
          (item) => item.name !== "uq_purge_files_original_singleton",
        );
      if (field === "checks")
        table.checks = table.checks.filter(
          (item) => item.name !== "chk_purge_files_original_singleton",
        );
      expect(() => assertExactSchema(expected, partial)).toThrow();
    }
  });

  it("makes both 30-day predicates false on an unrepresentable deadline rather than UNKNOWN", () => {
    for (const [table, name] of [
      [mediaItems, "chk_media_items_trash_state"],
      [purgeIntents, "chk_purge_intents_retention"],
    ] as const) {
      const config = getTableConfig(table);
      const expression = dialect.sqlToQuery(
        config.checks.find((item) => item.name === name)!.value,
      ).sql;
      const guard = `(\`${config.name}\`.\`trashed_at\` + INTERVAL 30 DAY) IS NOT NULL AND \`${config.name}\`.\`purge_after\` = \`${config.name}\`.\`trashed_at\` + INTERVAL 30 DAY`;
      expect(expression).toContain(guard);
      expect(sql).toContain(expression);
      expect(next.tables[config.name]!.checkConstraint[name]!.value).toBe(
        expression,
      );
    }
  });

  it("keeps the affected Drizzle tables, SQL constraints and 0007 snapshot aligned", () => {
    for (const table of [
      purgeFiles,
      purgeIntents,
      mediaItems,
      storageObjects,
      uploadSessions,
    ]) {
      const config = getTableConfig(table),
        snapshot = next.tables[config.name]!;
      expect(config.columns.map((column) => column.name).sort()).toEqual(
        Object.keys(snapshot.columns).sort(),
      );
      for (const column of config.columns) {
        expect(snapshot.columns[column.name]).toMatchObject({
          type: column.getSQLType(),
          notNull: column.notNull,
        });
      }
      expect(config.indexes.map((index) => index.config.name).sort()).toEqual(
        Object.keys(snapshot.indexes).sort(),
      );
      for (const index of config.indexes) {
        expect(snapshot.indexes[index.config.name]).toMatchObject({
          columns: index.config.columns.map((column) =>
            "name" in column ? column.name : dialect.sqlToQuery(column).sql,
          ),
          isUnique: index.config.unique,
        });
      }
      expect(config.foreignKeys.map((key) => key.getName()).sort()).toEqual(
        Object.keys(snapshot.foreignKeys).sort(),
      );
      expect(config.checks.map((check) => check.name).sort()).toEqual(
        Object.keys(snapshot.checkConstraint).sort(),
      );
      for (const check of config.checks) {
        expect(snapshot.checkConstraint[check.name]!.value).toBe(
          dialect.sqlToQuery(check.value).sql,
        );
      }
    }
  });
});
