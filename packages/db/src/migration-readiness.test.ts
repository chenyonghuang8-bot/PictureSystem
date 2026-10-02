import { describe, expect, it } from "vitest";
import { canonicalCheck } from "./check-expression.js";

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
  it("normalizes only identifier plus positive integer DAY intervals", () => {
    const expected = buildExpectedSchemaSnapshot();
    const actual = structuredClone(expected);
    const retention = (snapshot: SchemaSnapshot) =>
      snapshot.tables
        .find((table) => table.name === "purge_intents")!
        .checks.find((check) => check.name === "chk_purge_intents_retention")!;
    retention(actual).expression =
      "(((`trashed_at` + interval 30 day) is not null) and (`purge_after` = (`trashed_at` + interval 30 day)))";
    expect(() => assertExactSchema(expected, actual)).not.toThrow();
    retention(actual).expression = retention(actual).expression.replaceAll(
      "30 day",
      "29 day",
    );
    expect(() => assertExactSchema(expected, actual)).toThrow(
      MigrationReadinessError,
    );
    expect(
      canonicalCheck("(`media_items`.`trashed_at`) + INTERVAL 30 DAY"),
    ).toBe(canonicalCheck("(`trashed_at` + interval 30 day)"));
  });

  it.each([
    "trashed_at + INTERVAL 1 MONTH",
    "trashed_at + INTERVAL 1 HOUR",
    "trashed_at + INTERVAL 0 DAY",
    "trashed_at + INTERVAL -1 DAY",
    "trashed_at + INTERVAL lifecycle_revision DAY",
    "trashed_at + 1",
    "trashed_at - INTERVAL 30 DAY",
    "date_add(trashed_at, INTERVAL 30 DAY)",
    "(trashed_at + INTERVAL 30 DAY) + INTERVAL 1 DAY",
  ])("preserves unsupported arithmetic literally: %s", (expression) => {
    expect(canonicalCheck(expression)).toBe(expression);
    const expected = buildExpectedSchemaSnapshot();
    const actual = structuredClone(expected);
    actual.tables
      .find((table) => table.name === "purge_intents")!
      .checks.find(
        (check) => check.name === "chk_purge_intents_retention",
      )!.expression = expression;
    expect(() => assertExactSchema(expected, actual)).toThrow(
      MigrationReadinessError,
    );
  });

  it("matches only ordered identifier addition at scalar precedence", () => {
    expect(canonicalCheck("original_bytes + derived_bytes")).toBe(
      canonicalCheck("(`original_bytes` + `derived_bytes`)"),
    );
    const expected = buildExpectedSchemaSnapshot();
    const actual = structuredClone(expected);
    const bytes = (snapshot: SchemaSnapshot) =>
      snapshot.tables
        .find((table) => table.name === "purge_intents")!
        .checks.find((check) => check.name === "chk_purge_intents_bytes")!;
    bytes(actual).expression =
      "((`original_bytes` > 0) and (`released_bytes` <= (`original_bytes` + `derived_bytes`)))";
    expect(() => assertExactSchema(expected, actual)).not.toThrow();
    for (const expression of [
      "original_bytes > 0 AND released_bytes <= original_bytes + other_bytes",
      "original_bytes > 0 AND released_bytes <= derived_bytes + original_bytes",
      "original_bytes > 0 AND released_bytes < original_bytes + derived_bytes",
    ]) {
      bytes(actual).expression = expression;
      expect(() => assertExactSchema(expected, actual)).toThrow(
        MigrationReadinessError,
      );
    }
  });

  it.each([
    "original_bytes + 1",
    "1 + original_bytes",
    "original_bytes - derived_bytes",
    "original_bytes * derived_bytes",
    "original_bytes / derived_bytes",
    "original_bytes + derived_bytes + released_bytes",
    "(original_bytes + derived_bytes) + released_bytes",
    "abs(original_bytes) + derived_bytes",
    "INTERVAL 30 DAY + original_bytes",
  ])("keeps unapproved byte arithmetic literal: %s", (expression) => {
    expect(canonicalCheck(expression)).toBe(expression);
    const expected = buildExpectedSchemaSnapshot();
    const actual = structuredClone(expected);
    actual.tables
      .find((table) => table.name === "purge_intents")!
      .checks.find(
        (check) => check.name === "chk_purge_intents_bytes",
      )!.expression = expression;
    expect(() => assertExactSchema(expected, actual)).toThrow(
      MigrationReadinessError,
    );
  });

  it("ignores ordinary column order while retaining composite index and FK order", () => {
    const expected = buildExpectedSchemaSnapshot();
    const reordered = structuredClone(expected);
    for (const table of reordered.tables) table.columns.reverse();
    expect(() => assertExactSchema(expected, reordered)).not.toThrow();
    for (const kind of ["index", "primary", "foreign", "reference"] as const) {
      const contract = structuredClone(expected);
      if (kind === "primary") {
        // Current tables have single-column PKs; exercise composite order synthetically.
        contract.tables
          .find((table) => table.name === "upload_sessions")!
          .indexes.find((index) => index.name === "PRIMARY")!.columns = [
          "id",
          "family_id",
        ];
      }
      const actual = structuredClone(contract);
      if (kind === "index" || kind === "primary") {
        actual.tables
          .flatMap((table) => table.indexes)
          .find(
            (index) =>
              index.columns.length > 1 &&
              (kind === "primary"
                ? index.name === "PRIMARY"
                : index.name !== "PRIMARY"),
          )!
          .columns.reverse();
      } else {
        const fk = actual.tables
          .flatMap((table) => table.foreignKeys)
          .find((key) => key.columns.length > 1)!;
        (kind === "foreign" ? fk.columns : fk.referencedColumns).reverse();
      }
      expect(() => assertExactSchema(contract, actual)).toThrow(
        MigrationReadinessError,
      );
    }
  });

  it.each(["extra", "charset", "collation", "autoIncrement"] as const)(
    "retains exact column properties: %s",
    (kind) => {
      const expected = buildExpectedSchemaSnapshot();
      const actual = structuredClone(expected);
      const table = actual.tables.find(
        (item) => item.name === "upload_sessions",
      )!;
      const column = table.columns.find(
        (item) => item.name === "original_filename",
      )!;
      if (kind === "extra")
        table.columns.push({ ...column, name: "unexpected_column" });
      if (kind === "charset") column.characterSet = "latin1";
      if (kind === "collation") column.collation = "utf8mb4_bin";
      if (kind === "autoIncrement")
        column.autoIncrement = !column.autoIncrement;
      expect(() => assertExactSchema(expected, actual)).toThrow(
        MigrationReadinessError,
      );
    },
  );
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
      /'CREATED'/gu,
      "_utf8mb4\\'CREATED\\'",
    );
    expect(() => assertExactSchema(expected, actual)).not.toThrow();
    stateCheck.expression = stateCheck.expression.replace(
      /CREATED/gu,
      "COMPLETE",
    );
    expect(() => assertExactSchema(expected, actual)).toThrow(
      MigrationReadinessError,
    );
  });

  it("accepts only an exact redundant non-unique FK-supporting index", () => {
    const expected = buildExpectedSchemaSnapshot();
    const actual = structuredClone(expected);
    const media = actual.tables.find((table) => table.name === "media_items")!;
    const sourceForeignKey = media.foreignKeys.find(
      (foreignKey) => foreignKey.name === "fk_media_items_source_upload",
    )!;
    media.indexes.push({
      name: sourceForeignKey.name,
      unique: false,
      columns: [...sourceForeignKey.columns],
      hasPartialOrExpression: false,
    });
    expect(() => assertExactSchema(expected, actual)).not.toThrow();
  });

  it.each([
    [
      "arbitrary columns",
      {
        name: "unexpected_index",
        unique: false,
        columns: ["processing_state"],
        hasPartialOrExpression: false,
      },
    ],
    [
      "unexpected unique",
      {
        name: "unexpected_unique",
        unique: true,
        columns: ["family_id", "source_upload_id", "storage_object_id"],
        hasPartialOrExpression: false,
      },
    ],
    [
      "missing FK column",
      {
        name: "fk_media_items_source_upload",
        unique: false,
        columns: ["family_id", "source_upload_id"],
        hasPartialOrExpression: false,
      },
    ],
    [
      "reordered FK columns",
      {
        name: "fk_media_items_source_upload",
        unique: false,
        columns: ["source_upload_id", "family_id", "storage_object_id"],
        hasPartialOrExpression: false,
      },
    ],
    [
      "extra FK column",
      {
        name: "fk_media_items_source_upload",
        unique: false,
        columns: [
          "family_id",
          "source_upload_id",
          "storage_object_id",
          "uploaded_at",
        ],
        hasPartialOrExpression: false,
      },
    ],
    [
      "prefix or expression index",
      {
        name: "fk_media_items_source_upload",
        unique: false,
        columns: ["family_id", "source_upload_id", "storage_object_id"],
        hasPartialOrExpression: true,
      },
    ],
  ])("rejects a non-equivalent extra index: %s", (_name, index) => {
    const expected = buildExpectedSchemaSnapshot();
    const actual = structuredClone(expected);
    actual.tables
      .find((table) => table.name === "media_items")!
      .indexes.push(index);
    expect(() => assertExactSchema(expected, actual)).toThrow(
      MigrationReadinessError,
    );
  });

  it("does not let an implicit index hide missing explicit index contracts or FK drift", () => {
    const expected = buildExpectedSchemaSnapshot();
    for (const mutate of [
      (actual: SchemaSnapshot) => {
        const media = actual.tables.find(
          (table) => table.name === "media_items",
        )!;
        media.indexes = media.indexes.filter(
          (index) => index.name !== "idx_media_items_processing",
        );
      },
      (actual: SchemaSnapshot) => {
        const media = actual.tables.find(
          (table) => table.name === "media_items",
        )!;
        media.indexes = media.indexes.filter(
          (index) => index.name !== "uq_media_items_family_storage_object",
        );
      },
      (actual: SchemaSnapshot) => {
        const source = actual.tables
          .find((table) => table.name === "media_items")!
          .foreignKeys.find(
            (foreignKey) => foreignKey.name === "fk_media_items_source_upload",
          )!;
        source.referencedColumns = ["family_id", "id", "family_id"];
      },
      (actual: SchemaSnapshot) => {
        const source = actual.tables
          .find((table) => table.name === "media_items")!
          .foreignKeys.find(
            (foreignKey) => foreignKey.name === "fk_media_items_source_upload",
          )!;
        source.columns = ["source_upload_id", "family_id", "storage_object_id"];
      },
    ]) {
      const actual = structuredClone(expected);
      mutate(actual);
      expect(() => assertExactSchema(expected, actual)).toThrow(
        MigrationReadinessError,
      );
    }
  });

  it("normalizes only simple equivalent MOD and percent CHECK expressions", () => {
    const expected = buildExpectedSchemaSnapshot();
    const capture = (snapshot: SchemaSnapshot) =>
      snapshot.tables
        .find((table) => table.name === "media_items")!
        .checks.find((check) => check.name === "chk_media_items_capture")!;
    const equivalent = structuredClone(expected);
    capture(equivalent).expression = capture(equivalent).expression.replace(
      "captured_offset_minutes%60",
      "(( MOD( `captured_offset_minutes` , 60 ) ))",
    );
    expect(() => assertExactSchema(expected, equivalent)).not.toThrow();

    for (const expression of [
      capture(expected).expression.replace(
        "captured_offset_minutes%60",
        "MOD(captured_offset_minutes,30)",
      ),
      capture(expected).expression.replace(
        "captured_offset_minutes%60",
        "MOD(generation,60)",
      ),
      capture(expected).expression.replace(
        "captured_time_status='ABSENT'",
        "captured_time_status='OFFSET_KNOWN'",
      ),
    ]) {
      const drift = structuredClone(expected);
      capture(drift).expression = expression;
      expect(() => assertExactSchema(expected, drift)).toThrow(
        MigrationReadinessError,
      );
    }
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
        (schema.tables[0]!.columns[0]!.nullable =
          !schema.tables[0]!.columns[0]!.nullable),
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
