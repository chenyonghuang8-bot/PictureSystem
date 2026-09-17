import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import {
  getTableConfig,
  MySqlDialect,
  type MySqlTable,
} from "drizzle-orm/mysql-core";

import {
  albumMembers,
  albums,
  families,
  familyMembers,
  invitations,
  mediaItems,
  backgroundJobs,
  derivedAssets,
  sessions,
  storageObjects,
  uploadSessions,
  users,
} from "./schema.js";

const PROJECT_TABLES = [
  users,
  families,
  familyMembers,
  invitations,
  sessions,
  albums,
  albumMembers,
  storageObjects,
  uploadSessions,
  mediaItems,
  backgroundJobs,
  derivedAssets,
] as const;

const PHASE_4_PREDECESSOR_TABLES = PROJECT_TABLES.slice(0, 9);
const PHASE_4_ONLY_UPLOAD_INDEX = "uq_upload_sessions_family_id_object";
const TABLE_COLLATION = "utf8mb4_0900_ai_ci";
const MIGRATIONS_DIRECTORY = new URL("../drizzle/", import.meta.url);
const JOURNAL_URL = new URL("meta/_journal.json", MIGRATIONS_DIRECTORY);
const dialect = new MySqlDialect();

export type ExpectedMigration = {
  index: number;
  tag: string;
  createdAt: string;
  hash: string;
};

export type SchemaColumn = {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
  characterSet: string | null;
  collation: string | null;
};

export type SchemaIndex = {
  name: string;
  unique: boolean;
  columns: string[];
};

export type SchemaForeignKey = {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
};

export type SchemaCheck = { name: string; expression: string };

export type SchemaTable = {
  name: string;
  engine: string;
  collation: string;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
  checks: SchemaCheck[];
};

export type SchemaSnapshot = { tables: SchemaTable[] };

export class MigrationReadinessError extends Error {
  constructor(
    readonly reason:
      "MANIFEST_INVALID" | "JOURNAL_MISMATCH" | "SCHEMA_MISMATCH",
  ) {
    super("Database migration readiness check failed.");
    this.name = "MigrationReadinessError";
  }
}

export async function loadExpectedMigrationManifest(): Promise<
  ExpectedMigration[]
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(JOURNAL_URL, "utf8"));
  } catch {
    throw new MigrationReadinessError("MANIFEST_INVALID");
  }
  if (!isJournalDocument(parsed)) {
    throw new MigrationReadinessError("MANIFEST_INVALID");
  }

  const sqlByTag = new Map<string, Buffer>();
  try {
    for (const entry of parsed.entries) {
      sqlByTag.set(
        entry.tag,
        await readFile(new URL(`${entry.tag}.sql`, MIGRATIONS_DIRECTORY)),
      );
    }
  } catch {
    throw new MigrationReadinessError("MANIFEST_INVALID");
  }
  return validateExpectedMigrationManifest(parsed.entries, sqlByTag);
}

export function validateExpectedMigrationManifest(
  entries: readonly { idx: number; tag: string; when: number }[],
  sqlByTag: ReadonlyMap<string, Uint8Array>,
): ExpectedMigration[] {
  const tags = new Set<string>();
  let previousWhen = -1;
  const manifest: ExpectedMigration[] = [];
  for (const [position, entry] of entries.entries()) {
    const sql = sqlByTag.get(entry.tag);
    if (
      entry.idx !== position ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previousWhen ||
      !/^[a-z0-9_]+$/.test(entry.tag) ||
      tags.has(entry.tag) ||
      !sql
    ) {
      throw new MigrationReadinessError("MANIFEST_INVALID");
    }
    tags.add(entry.tag);
    previousWhen = entry.when;
    manifest.push({
      index: entry.idx,
      tag: entry.tag,
      createdAt: String(entry.when),
      hash: createHash("sha256").update(sql).digest("hex"),
    });
  }
  if (manifest.length === 0 || sqlByTag.size !== manifest.length) {
    throw new MigrationReadinessError("MANIFEST_INVALID");
  }
  return manifest;
}

export function assertExactMigrationHistory(
  expected: readonly ExpectedMigration[],
  actual: readonly { hash: unknown; createdAt: unknown }[],
) {
  if (
    actual.length !== expected.length ||
    expected.some(
      (migration, index) =>
        String(actual[index]?.hash ?? "") !== migration.hash ||
        String(actual[index]?.createdAt ?? "") !== migration.createdAt,
    )
  ) {
    throw new MigrationReadinessError("JOURNAL_MISMATCH");
  }
}

export function buildExpectedSchemaSnapshot(
  tables: readonly MySqlTable[] = PROJECT_TABLES,
): SchemaSnapshot {
  return canonicalizeSchema({
    tables: [journalTable(), ...tables.map(expectedTable)],
  });
}

// The Phase 4 migration adds exactly one index to an existing table. Derive
// the predecessor schema from the same Drizzle tables, removing only that
// reviewed delta; there is no second hand-written column/FK/check manifest.
export function buildPhase4PredecessorSchemaSnapshot(): SchemaSnapshot {
  const predecessor = buildExpectedSchemaSnapshot(PHASE_4_PREDECESSOR_TABLES);
  const uploads = predecessor.tables.find(
    (table) => table.name === "upload_sessions",
  );
  if (!uploads) throw new MigrationReadinessError("MANIFEST_INVALID");
  const before = uploads.indexes.length;
  uploads.indexes = uploads.indexes.filter(
    (item) => item.name !== PHASE_4_ONLY_UPLOAD_INDEX,
  );
  if (uploads.indexes.length !== before - 1) {
    throw new MigrationReadinessError("MANIFEST_INVALID");
  }
  return predecessor;
}

export function assertExactSchema(
  expected: SchemaSnapshot,
  actual: SchemaSnapshot,
) {
  if (
    JSON.stringify(canonicalizeSchema(actual)) !==
    JSON.stringify(canonicalizeSchema(expected))
  ) {
    throw new MigrationReadinessError("SCHEMA_MISMATCH");
  }
}

export async function assertMigrationReadiness(connection: PoolConnection) {
  try {
    const expectedMigrations = await loadExpectedMigrationManifest();
    const [journal] = await connection.query<RowDataPacket[]>(
      "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY id ASC",
    );
    assertExactMigrationHistory(
      expectedMigrations,
      journal.map((row) => ({ hash: row.hash, createdAt: row.createdAt })),
    );
    assertExactSchema(
      buildExpectedSchemaSnapshot(),
      await readActualSchemaSnapshot(connection),
    );
    return { migrationCount: expectedMigrations.length } as const;
  } catch (error) {
    if (error instanceof MigrationReadinessError) throw error;
    throw new MigrationReadinessError("SCHEMA_MISMATCH");
  }
}

export async function readActualSchemaSnapshot(
  connection: PoolConnection,
): Promise<SchemaSnapshot> {
  const [tableRows] = await connection.query<RowDataPacket[]>(
    `SELECT table_name AS tableName, engine AS tableEngine,
            table_collation AS tableCollation
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
      ORDER BY table_name`,
  );
  const [columnRows] = await connection.query<RowDataPacket[]>(
    `SELECT table_name AS tableName, column_name AS columnName,
            column_type AS columnType, is_nullable AS isNullable,
            column_default AS columnDefault, extra AS columnExtra,
            character_set_name AS characterSet,
            collation_name AS collationName
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
      ORDER BY table_name, ordinal_position`,
  );
  const [indexRows] = await connection.query<RowDataPacket[]>(
    `SELECT table_name AS tableName, index_name AS indexName,
            non_unique AS nonUnique, seq_in_index AS sequence,
            column_name AS columnName
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
      ORDER BY table_name, index_name, seq_in_index`,
  );
  const [foreignKeyRows] = await connection.query<RowDataPacket[]>(
    `SELECT k.table_name AS tableName,
            k.constraint_name AS constraintName,
            k.ordinal_position AS position, k.column_name AS columnName,
            k.referenced_table_name AS referencedTable,
            k.referenced_column_name AS referencedColumn,
            r.delete_rule AS deleteRule, r.update_rule AS updateRule
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.constraint_schema
        AND r.constraint_name = k.constraint_name
      WHERE k.constraint_schema = DATABASE()
        AND k.referenced_table_name IS NOT NULL
      ORDER BY k.table_name, k.constraint_name, k.ordinal_position`,
  );
  const [checkRows] = await connection.query<RowDataPacket[]>(
    `SELECT tc.table_name AS tableName,
            tc.constraint_name AS constraintName,
            cc.check_clause AS checkClause
       FROM information_schema.table_constraints tc
       JOIN information_schema.check_constraints cc
         ON cc.constraint_schema = tc.constraint_schema
        AND cc.constraint_name = tc.constraint_name
      WHERE tc.constraint_schema = DATABASE()
        AND tc.constraint_type = 'CHECK'
      ORDER BY tc.table_name, tc.constraint_name`,
  );

  return canonicalizeSchema({
    tables: tableRows.map((table) => ({
      name: String(table.tableName),
      engine: String(table.tableEngine),
      collation: String(table.tableCollation),
      columns: columnRows
        .filter((column) => column.tableName === table.tableName)
        .map((column) => ({
          name: String(column.columnName),
          type: normalizeType(String(column.columnType)),
          nullable: column.isNullable === "YES",
          defaultValue:
            column.columnDefault === null
              ? null
              : normalizeDefault(column.columnDefault),
          autoIncrement: String(column.columnExtra).includes("auto_increment"),
          characterSet:
            column.characterSet === null ? null : String(column.characterSet),
          collation:
            column.collationName === null ? null : String(column.collationName),
        })),
      indexes: groupIndexes(
        indexRows.filter((index) => index.tableName === table.tableName),
      ),
      foreignKeys: groupForeignKeys(
        foreignKeyRows.filter(
          (foreignKey) => foreignKey.tableName === table.tableName,
        ),
      ),
      checks: checkRows
        .filter((check) => check.tableName === table.tableName)
        .map((check) => ({
          name: String(check.constraintName),
          expression: normalizeCheck(String(check.checkClause)),
        })),
    })),
  });
}

function expectedTable(table: MySqlTable): SchemaTable {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => {
    const sqlType = column.getSQLType();
    const ascii = /^(.*?) CHARACTER SET ascii COLLATE ascii_bin$/i.exec(
      sqlType,
    );
    const type = normalizeType(ascii?.[1] ?? sqlType);
    const textual = /^(varchar|text|enum)\b/.test(type);
    return {
      name: column.name,
      type,
      nullable: !column.notNull,
      defaultValue:
        column.default === undefined ? null : normalizeDefault(column.default),
      autoIncrement: "autoIncrement" in column && column.autoIncrement === true,
      characterSet: ascii ? "ascii" : textual ? "utf8mb4" : null,
      collation: ascii ? "ascii_bin" : textual ? TABLE_COLLATION : null,
    };
  });
  const indexes: SchemaIndex[] = [
    {
      name: "PRIMARY",
      unique: true,
      columns: columnsForPrimaryKey(config.columns),
    },
    ...config.indexes.map((index) => ({
      name: index.config.name,
      unique: index.config.unique === true,
      columns: index.config.columns.map((column) => {
        if (!("name" in column) || typeof column.name !== "string") {
          throw new MigrationReadinessError("MANIFEST_INVALID");
        }
        return column.name;
      }),
    })),
  ];
  return {
    name: config.name,
    engine: "InnoDB",
    collation: TABLE_COLLATION,
    columns,
    indexes,
    foreignKeys: config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        name: foreignKey.getName(),
        columns: reference.columns.map((column) => column.name),
        referencedTable: getTableConfig(reference.foreignTable).name,
        referencedColumns: reference.foreignColumns.map(
          (column) => column.name,
        ),
        onDelete: (foreignKey.onDelete ?? "NO ACTION").toUpperCase(),
        onUpdate: (foreignKey.onUpdate ?? "NO ACTION").toUpperCase(),
      };
    }),
    checks: config.checks.map((check) => ({
      name: check.name,
      expression: normalizeCheck(dialect.sqlToQuery(check.value).sql),
    })),
  };
}

function journalTable(): SchemaTable {
  return {
    name: "__drizzle_migrations",
    engine: "InnoDB",
    collation: TABLE_COLLATION,
    columns: [
      column("id", "bigint unsigned", false, null, true, null, null),
      column("hash", "text", false, null, false, "utf8mb4", TABLE_COLLATION),
      column("created_at", "bigint", true, null, false, null, null),
    ],
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "id", unique: true, columns: ["id"] },
    ],
    foreignKeys: [],
    checks: [],
  };
}

function column(
  name: string,
  type: string,
  nullable: boolean,
  defaultValue: string | null,
  autoIncrement: boolean,
  characterSet: string | null,
  collation: string | null,
): SchemaColumn {
  return {
    name,
    type,
    nullable,
    defaultValue,
    autoIncrement,
    characterSet,
    collation,
  };
}

function groupIndexes(rows: RowDataPacket[]): SchemaIndex[] {
  const grouped = new Map<string, SchemaIndex>();
  for (const row of rows) {
    const name = String(row.indexName);
    const current = grouped.get(name) ?? {
      name,
      unique: String(row.nonUnique) === "0",
      columns: [],
    };
    current.columns.push(String(row.columnName));
    grouped.set(name, current);
  }
  return [...grouped.values()];
}

function groupForeignKeys(rows: RowDataPacket[]): SchemaForeignKey[] {
  const grouped = new Map<string, SchemaForeignKey>();
  for (const row of rows) {
    const name = String(row.constraintName);
    const current = grouped.get(name) ?? {
      name,
      columns: [],
      referencedTable: String(row.referencedTable),
      referencedColumns: [],
      onDelete: String(row.deleteRule).toUpperCase(),
      onUpdate: String(row.updateRule).toUpperCase(),
    };
    current.columns.push(String(row.columnName));
    current.referencedColumns.push(String(row.referencedColumn));
    grouped.set(name, current);
  }
  return [...grouped.values()];
}

function canonicalizeSchema(snapshot: SchemaSnapshot): SchemaSnapshot {
  return {
    tables: snapshot.tables
      .map((table) => ({
        ...table,
        engine: table.engine.toUpperCase(),
        collation: table.collation.toLowerCase(),
        columns: table.columns.map((item) => ({
          ...item,
          type: normalizeType(item.type),
          defaultValue:
            item.defaultValue === null
              ? null
              : normalizeDefault(item.defaultValue),
        })),
        indexes: [...table.indexes].sort(byName),
        foreignKeys: [...table.foreignKeys].sort(byName),
        checks: table.checks
          .map((check) => ({
            ...check,
            expression: normalizeCheck(check.expression),
          }))
          .sort(byName),
      }))
      .sort(byName),
  };
}

function normalizeType(value: string) {
  return value.toLowerCase() === "boolean" ? "tinyint(1)" : value.toLowerCase();
}

function normalizeDefault(value: unknown) {
  if (value === false) return "0";
  if (value === true) return "1";
  if (typeof value === "object" && value !== null && "queryChunks" in value) {
    return dialect
      .sqlToQuery(value as Parameters<MySqlDialect["sqlToQuery"]>[0])
      .sql.toUpperCase();
  }
  return String(value).toUpperCase();
}

function normalizeCheck(value: string) {
  let normalized = value
    .replaceAll("`", "")
    .replace(/\b[a-z_][a-z0-9_]*\./gi, "")
    .replace(/_utf8mb4\\?'/gi, "'")
    .replace(/\\'/g, "'")
    .replace(/\s+/g, "")
    .replaceAll("(", "")
    .replaceAll(")", "")
    .toLowerCase();
  if (normalized === "notused_atisnotnullandrevoked_atisnotnull") {
    normalized = "used_atisnullorrevoked_atisnull";
  }
  return normalized;
}

function columnsForPrimaryKey(
  columns: ReturnType<typeof getTableConfig>["columns"],
) {
  const primary = columns
    .filter((column) => column.primary)
    .map((column) => column.name);
  if (primary.length === 0)
    throw new MigrationReadinessError("MANIFEST_INVALID");
  return primary;
}

function byName(left: { name: string }, right: { name: string }) {
  return left.name.localeCompare(right.name);
}

function isJournalDocument(value: unknown): value is {
  version: string;
  dialect: string;
  entries: { idx: number; tag: string; when: number }[];
} {
  if (!value || typeof value !== "object") return false;
  const document = value as Record<string, unknown>;
  return (
    document.version === "7" &&
    document.dialect === "mysql" &&
    Array.isArray(document.entries) &&
    document.entries.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).idx === "number" &&
        typeof (entry as Record<string, unknown>).tag === "string" &&
        typeof (entry as Record<string, unknown>).when === "number",
    )
  );
}
