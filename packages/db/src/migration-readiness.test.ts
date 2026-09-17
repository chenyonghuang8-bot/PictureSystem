import { describe, expect, it } from "vitest";

import {
  assertExactMigrationHistory,
  assertExactSchema,
  buildExpectedSchemaSnapshot,
  buildPhase4PredecessorSchemaSnapshot,
  MigrationReadinessError,
  validateExpectedMigrationManifest,
  type SchemaSnapshot,
} from "./migration-readiness.js";
import {
  albumMembers,
  albums,
  families,
  familyMembers,
  invitations,
  sessions,
  users,
} from "./schema.js";

const entries = [
  { idx: 0, tag: "0000_phase_01a_identity_foundation", when: 100 },
  { idx: 1, tag: "0001_phase_02_albums_permissions", when: 200 },
  { idx: 2, tag: "0002_phase_03_storage_uploads", when: 300 },
  { idx: 3, tag: "0003_phase_04_media_processing", when: 400 },
] as const;
const sqlByTag = new Map([
  [entries[0].tag, Buffer.from("phase one")],
  [entries[1].tag, Buffer.from("phase two")],
  [entries[2].tag, Buffer.from("phase three")],
  [entries[3].tag, Buffer.from("phase four")],
]);

describe("bootstrap migration readiness", () => {
  it("builds ordered exact current and historical migration manifests", () => {
    const currentManifest = validateExpectedMigrationManifest(
      entries,
      sqlByTag,
    );
    expect(currentManifest.map((entry) => entry.tag)).toEqual(
      entries.map((entry) => entry.tag),
    );

    const phase1Entries = [entries[0]];
    const phase1Manifest = validateExpectedMigrationManifest(
      phase1Entries,
      new Map([[entries[0].tag, sqlByTag.get(entries[0].tag)!]]),
    );
    expect(() =>
      assertExactMigrationHistory(
        phase1Manifest,
        phase1Manifest.map((entry) => ({
          hash: entry.hash,
          createdAt: entry.createdAt,
        })),
      ),
    ).not.toThrow();

    const phase1 = buildExpectedSchemaSnapshot([
      users,
      families,
      familyMembers,
      invitations,
      sessions,
    ]);
    expect(() =>
      assertExactSchema(phase1, structuredClone(phase1)),
    ).not.toThrow();
    expect(phase1.tables.map((table) => table.name)).not.toContain("albums");

    const phase2Entries = entries.slice(0, 2);
    const phase2Manifest = validateExpectedMigrationManifest(
      phase2Entries,
      new Map(
        phase2Entries.map((entry) => [entry.tag, sqlByTag.get(entry.tag)!]),
      ),
    );
    expect(() =>
      assertExactMigrationHistory(
        phase2Manifest,
        phase2Manifest.map((entry) => ({
          hash: entry.hash,
          createdAt: entry.createdAt,
        })),
      ),
    ).not.toThrow();
    const phase2 = buildExpectedSchemaSnapshot([
      users,
      families,
      familyMembers,
      invitations,
      sessions,
      albums,
      albumMembers,
    ]);
    expect(phase2.tables.map((table) => table.name)).toContain("albums");
    expect(phase2.tables.map((table) => table.name)).not.toContain(
      "storage_objects",
    );
  });

  it.each([
    ["missing SQL", entries, new Map([[entries[0].tag, Buffer.from("one")]])],
    [
      "duplicate tag",
      [entries[0], { ...entries[1], tag: entries[0].tag }],
      sqlByTag,
    ],
    ["reordered index", [{ ...entries[0], idx: 1 }, entries[1]], sqlByTag],
    [
      "non-increasing time",
      [entries[0], { ...entries[1], when: 100 }],
      sqlByTag,
    ],
  ])("rejects an invalid expected manifest: %s", (_name, input, sql) => {
    expect(() => validateExpectedMigrationManifest(input, sql)).toThrow(
      MigrationReadinessError,
    );
  });

  it("requires the complete journal in exact order", () => {
    const expected = validateExpectedMigrationManifest(entries, sqlByTag);
    const correct = expected.map((entry) => ({
      hash: entry.hash,
      createdAt: entry.createdAt,
    }));
    expect(() => assertExactMigrationHistory(expected, correct)).not.toThrow();
    for (const invalid of [
      correct.slice(0, 2),
      [...correct, correct[2]!],
      [correct[1]!, correct[0]!, correct[2]!],
      [{ ...correct[0]!, hash: "wrong" }, correct[1]!],
      [correct[0]!, { ...correct[1]!, createdAt: "201" }, correct[2]!],
      [...correct, { hash: "ahead", createdAt: "300" }],
    ]) {
      expect(() => assertExactMigrationHistory(expected, invalid)).toThrow(
        MigrationReadinessError,
      );
    }
  });

  it("rejects historical schemas for the current Phase 4 manifest", () => {
    const current = buildExpectedSchemaSnapshot();
    const phase1 = buildExpectedSchemaSnapshot([
      users,
      families,
      familyMembers,
      invitations,
      sessions,
    ]);
    expect(() => assertExactSchema(current, phase1)).toThrow(
      MigrationReadinessError,
    );
    const phase2 = buildExpectedSchemaSnapshot([
      users,
      families,
      familyMembers,
      invitations,
      sessions,
      albums,
      albumMembers,
    ]);
    expect(() => assertExactSchema(current, phase2)).toThrow(
      MigrationReadinessError,
    );
    expect(current.tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "storage_objects",
        "upload_sessions",
        "media_items",
        "background_jobs",
        "derived_assets",
      ]),
    );
  });

  it("accepts exact Phase 3 predecessor and rejects it as fully Phase 4 migrated", () => {
    const current = buildExpectedSchemaSnapshot();
    const predecessor = buildPhase4PredecessorSchemaSnapshot();
    const oldUpload = predecessor.tables.find(
      (table) => table.name === "upload_sessions",
    )!;
    expect(oldUpload.indexes.map((index) => index.name)).not.toContain(
      "uq_upload_sessions_family_id_object",
    );
    expect(predecessor.tables.map((table) => table.name)).not.toContain(
      "media_items",
    );
    expect(() =>
      assertExactSchema(predecessor, structuredClone(predecessor)),
    ).not.toThrow();
    expect(() => assertExactSchema(current, predecessor)).toThrow(
      MigrationReadinessError,
    );
    const manifest = validateExpectedMigrationManifest(entries, sqlByTag);
    const phase3Journal = manifest.slice(0, 3).map((entry) => ({
      hash: entry.hash,
      createdAt: entry.createdAt,
    }));
    expect(() => assertExactMigrationHistory(manifest, phase3Journal)).toThrow(
      MigrationReadinessError,
    );
    expect(() =>
      assertExactMigrationHistory(manifest.slice(0, 3), phase3Journal),
    ).not.toThrow();
  });

  it("accepts MySQL 9.7 charset introducers without hiding CHECK drift", () => {
    const expected = buildExpectedSchemaSnapshot();
    const actual = structuredClone(expected);
    const stateCheck = actual.tables
      .find((table) => table.name === "upload_sessions")!
      .checks.find((check) => check.name === "chk_upload_sessions_created")!;
    stateCheck.expression = stateCheck.expression.replace(
      /'created'/gu,
      "_utf8mb4\\'created\\'",
    );
    expect(() => assertExactSchema(expected, actual)).not.toThrow();
    stateCheck.expression = stateCheck.expression.replace(
      /created/gu,
      "complete",
    );
    expect(() => assertExactSchema(expected, actual)).toThrow(
      MigrationReadinessError,
    );
  });

  it.each([
    ["missing table", (schema: SchemaSnapshot) => schema.tables.pop()],
    [
      "missing column",
      (schema: SchemaSnapshot) => schema.tables[0]!.columns.pop(),
    ],
    [
      "wrong column type",
      (schema: SchemaSnapshot) => (schema.tables[0]!.columns[0]!.type = "int"),
    ],
    [
      "wrong nullability",
      (schema: SchemaSnapshot) =>
        (schema.tables[0]!.columns[0]!.nullable = true),
    ],
    [
      "wrong default",
      (schema: SchemaSnapshot) =>
        (schema.tables
          .find((table) => table.name === "albums")!
          .columns.find((column) => column.name === "revision")!.defaultValue =
          "2"),
    ],
    [
      "missing index",
      (schema: SchemaSnapshot) => schema.tables[0]!.indexes.pop(),
    ],
    [
      "missing foreign key",
      (schema: SchemaSnapshot) =>
        schema.tables
          .find((table) => table.foreignKeys.length > 0)!
          .foreignKeys.pop(),
    ],
    [
      "wrong foreign key ordering",
      (schema: SchemaSnapshot) =>
        schema.tables
          .find((table) => table.name === "albums")!
          .foreignKeys.find((foreignKey) => foreignKey.columns.length === 2)!
          .columns.reverse(),
    ],
    [
      "missing check",
      (schema: SchemaSnapshot) =>
        schema.tables.find((table) => table.checks.length > 0)!.checks.pop(),
    ],
    [
      "wrong check",
      (schema: SchemaSnapshot) =>
        (schema.tables.find(
          (table) => table.checks.length > 0,
        )!.checks[0]!.expression = "1=1"),
    ],
  ])("rejects schema drift: %s", (_name, mutate) => {
    const expected = buildExpectedSchemaSnapshot();
    const actual = structuredClone(expected);
    mutate(actual);
    expect(() => assertExactSchema(expected, actual)).toThrow(
      MigrationReadinessError,
    );
  });
});
