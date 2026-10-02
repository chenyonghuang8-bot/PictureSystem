import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import {
  comments,
  familyFeatured,
  mediaItems,
  mediaTags,
  tags,
  userFavorites,
} from "./schema.js";
import {
  assertExactSchema,
  buildExpectedSchemaSnapshot,
  buildPhase6PredecessorSchemaSnapshot,
  buildPhase7PredecessorSchemaSnapshot,
  loadExpectedMigrationManifest,
} from "./migration-readiness.js";

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<
    string,
    {
      columns: Record<
        string,
        { type: string; notNull: boolean; default?: unknown }
      >;
      indexes: Record<string, { columns: string[]; isUnique: boolean }>;
      foreignKeys: Record<
        string,
        {
          columnsFrom: string[];
          columnsTo: string[];
          tableTo: string;
          onDelete: string;
          onUpdate: string;
        }
      >;
      checkConstraint: Record<string, { value: string }>;
    }
  >;
};
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const current = JSON.parse(
  read("../drizzle/meta/0006_snapshot.json"),
) as Snapshot;
const prior = JSON.parse(
  read("../drizzle/meta/0005_snapshot.json"),
) as Snapshot;
const migration = read("../drizzle/0006_phase_06_album_features.sql");
const historical = [
  {
    idx: 0,
    version: "5",
    when: 1789377513979,
    tag: "0000_phase_01a_identity_foundation",
    breakpoints: true,
    hash: "9b26c9865fd2478372a02652d2e69d5c38b8332b5f1ce7d8be4e1f75c569c4e6",
  },
  {
    idx: 1,
    version: "5",
    when: 1789404988381,
    tag: "0001_phase_02_albums_permissions",
    breakpoints: true,
    hash: "cb2b43d221405e6f9a5d80c799fe8d1b841eaf7fcf892e128bc32335dba5607a",
  },
  {
    idx: 2,
    version: "5",
    when: 1789439724515,
    tag: "0002_phase_03_storage_uploads",
    breakpoints: true,
    hash: "9d5575b4f5020d6a12809ace1a8a5d11f487230d57f204292cbd85d2da78c9b9",
  },
  {
    idx: 3,
    version: "5",
    when: 1789485599325,
    tag: "0003_phase_04_media_processing",
    breakpoints: true,
    hash: "4b93b35335335fbb385923477acee83432dec2f1bbb52c4231e0a09e465e7851",
  },
  {
    idx: 4,
    version: "5",
    when: 1790154052472,
    tag: "0004_phase_04_album_media",
    breakpoints: true,
    hash: "59a2ed68873c62dd8ea14f0a437eaeb4bb59ce36c0737befbcf60bc7b56cf178",
  },
  {
    idx: 5,
    version: "5",
    when: 1790220218434,
    tag: "0005_phase_05c_sharing",
    breakpoints: true,
    hash: "3d76cf68017ccd818b208234b4ecc64c3715e4fd8c7a12a152e038bb55d562a8",
  },
] as const;
const newTables = [comments, familyFeatured, mediaTags, tags, userFavorites];
const dialect = new MySqlDialect();

describe("Phase 6A additive migration and schema", () => {
  it("accepts MySQL byte-length alias but still rejects a character-length CHECK drift", () => {
    const expected = buildExpectedSchemaSnapshot();
    const actual = structuredClone(expected);
    const check = actual.tables
      .find((t) => t.name === "tags")!
      .checks.find((c) => c.name === "chk_tags_normalized")!;
    check.expression = "OCTET_LENGTH(`name_normalized`) BETWEEN 1 AND 256";
    expect(() => assertExactSchema(expected, actual)).not.toThrow();
    check.expression = "CHAR_LENGTH(`name_normalized`) BETWEEN 1 AND 256";
    expect(() => assertExactSchema(expected, actual)).toThrow();
  });
  it("retains the exact historical journal and SQL prefix, then appends 0006", async () => {
    const manifest = await loadExpectedMigrationManifest();
    const journal = JSON.parse(read("../drizzle/meta/_journal.json")) as {
      entries: {
        idx: number;
        tag: string;
        when: number;
        version: string;
        breakpoints: boolean;
      }[];
    };
    for (const { hash, ...entry } of historical) {
      expect(journal.entries[entry.idx]).toEqual(entry);
      expect(
        createHash("sha256")
          .update(read(`../drizzle/${entry.tag}.sql`))
          .digest("hex"),
      ).toBe(hash);
    }
    expect(manifest.slice(0, 7).map((m) => m.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(manifest[6]?.tag).toBe("0006_phase_06_album_features");
    expect(Number(manifest[6]?.createdAt)).toBeGreaterThan(
      Number(manifest[5]?.createdAt),
    );
    expect(current.prevId).toBe(prior.id);
  });
  it("creates only five InnoDB utf8mb4 tables with no destructive SQL", () => {
    expect(
      [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map((m) => m[1]),
    ).toEqual(newTables.map((t) => getTableConfig(t).name));
    expect(migration.match(/ENGINE=InnoDB/g)).toHaveLength(5);
    expect(migration.match(/COLLATE=utf8mb4_0900_ai_ci/g)).toHaveLength(5);
    expect(migration).not.toMatch(
      /\b(DROP|TRUNCATE|DELETE|UPDATE|CASCADE|TRIGGER|PROCEDURE|MODIFY|CHANGE|RENAME)\b(?! restrict)/i,
    );
    expect(migration).not.toContain("IF NOT EXISTS");
    const alters = [...migration.matchAll(/ALTER TABLE `([^`]+)` ([^;]+);/g)];
    for (const [, name, operation] of alters) {
      expect([
        ...newTables.map((t) => getTableConfig(t).name),
        "media_items",
      ]).toContain(name);
      expect(operation).toMatch(/^ADD /);
    }
    expect(migration.match(/FOREIGN KEY/g)).toHaveLength(9);
    expect(migration.match(/CHECK\s*\(/g)).toHaveLength(5);
    expect(
      migration.match(/ON DELETE restrict ON UPDATE restrict/g),
    ).toHaveLength(9);
  });
  it("preserves every historical table except the exact additive media note delta", () => {
    const media = structuredClone(current.tables.media_items!);
    expect(media.columns.description).toMatchObject({
      type: "varchar(4000)",
      notNull: false,
    });
    expect(media.columns.note_revision).toMatchObject({
      type: "bigint unsigned",
      notNull: true,
      default: "1",
    });
    delete media.columns.description;
    delete media.columns.note_revision;
    delete media.checkConstraint.chk_media_items_description;
    delete media.checkConstraint.chk_media_items_note_revision;
    expect(media).toEqual(prior.tables.media_items);
    for (const [name, table] of Object.entries(prior.tables)) {
      if (name !== "media_items") expect(current.tables[name]).toEqual(table);
    }
    expect(
      Object.keys(current.tables)
        .filter((n) => !prior.tables[n])
        .sort(),
    ).toEqual(newTables.map((t) => getTableConfig(t).name).sort());
  });
  it("keeps actual Drizzle types, indexes, FK targets and CHECK expressions aligned with SQL/snapshot", () => {
    // media_items evolves again in 0007; its frozen 0006 shape is checked by
    // the Phase 7 predecessor manifest and Phase 7 migration test.
    for (const table of newTables) {
      const config = getTableConfig(table),
        snap = current.tables[config.name]!;
      expect(config.columns.map((c) => c.name).sort()).toEqual(
        Object.keys(snap.columns).sort(),
      );
      for (const column of config.columns) {
        expect(column.getSQLType()).toBe(snap.columns[column.name]!.type);
        expect(column.notNull).toBe(snap.columns[column.name]!.notNull);
      }
      expect(config.indexes.map((i) => i.config.name).sort()).toEqual(
        Object.keys(snap.indexes).sort(),
      );
      for (const idx of config.indexes) {
        expect(snap.indexes[idx.config.name]).toMatchObject({
          isUnique: idx.config.unique,
          columns: idx.config.columns.map((c) => ("name" in c ? c.name : "")),
        });
      }
      for (const fk of config.foreignKeys) {
        const ref = fk.reference();
        expect(snap.foreignKeys[fk.getName()]).toMatchObject({
          columnsFrom: ref.columns.map((c) => c.name),
          columnsTo: ref.foreignColumns.map((c) => c.name),
          tableTo: getTableConfig(ref.foreignTable).name,
          onDelete: "restrict",
          onUpdate: "restrict",
        });
        expect(migration).toContain(
          `CONSTRAINT \`${fk.getName()}\` FOREIGN KEY`,
        );
      }
      for (const c of config.checks) {
        expect(snap.checkConstraint[c.name]?.value).toBe(
          dialect.sqlToQuery(c.value).sql,
        );
        expect(migration).toContain(`CONSTRAINT \`${c.name}\` CHECK`);
        expect(migration).toContain(snap.checkConstraint[c.name]!.value);
      }
    }
  });
  it("enforces binary normalized tags and exact bigint note mapping", () => {
    expect(tags.nameNormalized.getSQLType()).toBe("varbinary(256)");
    const bytes = Buffer.from("é");
    expect(tags.nameNormalized.mapToDriverValue(bytes)).toEqual(bytes);
    expect(tags.nameNormalized.mapFromDriverValue(bytes)).toEqual(bytes);
    expect(() =>
      tags.nameNormalized.mapToDriverValue(Buffer.alloc(0)),
    ).toThrow();
    expect(() =>
      tags.nameNormalized.mapToDriverValue(Buffer.alloc(257)),
    ).toThrow();
    expect(mediaItems.noteRevision.mapFromDriverValue("9007199254740993")).toBe(
      9007199254740993n,
    );
    expect(mediaItems.description.getSQLType()).toBe("varchar(4000)");
    expect(comments.body.getSQLType()).toBe("varchar(2000)");
  });
  it("includes all Phase 6 tables in readiness and rejects predecessor/partial schema", () => {
    const full = buildPhase7PredecessorSchemaSnapshot();
    const before = buildPhase6PredecessorSchemaSnapshot();
    expect(before.tables).toHaveLength(16);
    expect(full.tables).toHaveLength(21);
    expect(() => assertExactSchema(full, before)).toThrow();
    for (const name of newTables.map((t) => getTableConfig(t).name)) {
      const partial = structuredClone(full);
      partial.tables = partial.tables.filter((t) => t.name !== name);
      expect(() => assertExactSchema(full, partial)).toThrow();
    }
    expect(
      before.tables
        .find((t) => t.name === "media_items")
        ?.columns.map((c) => c.name),
    ).not.toContain("note_revision");
  });
});
