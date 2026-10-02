import { describe, expect, it } from "vitest";
import { canonicalCheck } from "./check-expression.js";
import {
  assertExactSchema,
  buildExpectedSchemaSnapshot,
  MigrationReadinessError,
} from "./migration-readiness.js";

describe("CHECK grouping and narrow aliases", () => {
  it("rejects the confirmed comment grouping attack in a cloned schema", () => {
    const expected = buildExpectedSchemaSnapshot();
    const actual = structuredClone(expected);
    const check = actual.tables
      .find((t) => t.name === "comments")!
      .checks.find((c) => c.name === "chk_comments_body")!;
    check.expression =
      "((char_length(`body`) between 1 and 2000) and (length(`body`) <= 8000))";
    expect(() => assertExactSchema(expected, actual)).not.toThrow();
    check.expression =
      "(CHAR_LENGTH(body) BETWEEN 1 AND 2000 AND LENGTH(body)) <= 8000";
    expect(() => assertExactSchema(expected, actual)).toThrow(
      MigrationReadinessError,
    );
  });
  it.each([
    ["a AND (b OR c)", "(a AND b) OR c"],
    ["a * (b + c)", "a * b + c"],
    ["NOT (a AND b)", "NOT a AND b"],
    ["CHAR_LENGTH(body)", "LENGTH(body)"],
    ["MOD(column,60)", "MOD(column,30)"],
    ["MOD(column,60)", "MOD(other_column,60)"],
    ["OCTET_LENGTH(other_column)", "LENGTH(body)"],
    ["MOD(a+b,60)", "a+b%60"],
    ["MOD(a,b)", "a%b"],
    ["a BETWEEN -(90) AND 90", "a BETWEEN -(89) AND 90"],
    ["-(a+b)", "-a+b"],
    ["a='A B'", "a='AB'"],
    ["a='UPPER'", "a='upper'"],
    ["a='x.y'", "a='y'"],
    ["a='OCTET_LENGTH(body)'", "a='LENGTH(body)'"],
    ["a=_binary'abc'", "a='abc'"],
    [
      "NOT (other IS NOT NULL AND revoked_at IS NOT NULL)",
      "other IS NULL OR revoked_at IS NULL",
    ],
  ])("rejects drift: %s vs %s", (a, b) => {
    expect(canonicalCheck(a)).not.toBe(canonicalCheck(b));
  });
  it.each([
    ["MOD(column,60)", "column%60"],
    [
      "(( MOD(`captured_offset_minutes`,60) )) = 0",
      "(captured_offset_minutes%60)=0",
    ],
    ["OCTET_LENGTH(body)", "LENGTH(body)"],
    ["a='CREATED'", "a=_utf8mb4'CREATED'"],
    ["a='CREATED'", "a=_utf8mb4\\'CREATED\\'"],
    ["((a = 1))", "a=1"],
    ["a BETWEEN -840 AND 840", "a BETWEEN -((840)) AND 840"],
    ["a=1 AND b=2", "((a=1) AND (b=2))"],
    [
      "NOT (used_at IS NOT NULL AND revoked_at IS NOT NULL)",
      "used_at IS NULL OR revoked_at IS NULL",
    ],
  ])("accepts known equivalence: %s", (a, b) => {
    const canonical = canonicalCheck(a);
    expect(canonical).toBe(canonicalCheck(b));
    expect(canonicalCheck(canonical)).toBe(canonical);
  });
  it("retains unknown syntax literally rather than broad normalization", () => {
    for (const text of [
      "a * (b + c)",
      "custom_fn(a)",
      "MOD(a+b,60)",
      "a='escaped\\'text'",
    ])
      expect(canonicalCheck(text)).toBe(text);
  });
  it.each([
    [
      "extra table",
      (s: ReturnType<typeof buildExpectedSchemaSnapshot>) =>
        s.tables.push({ ...s.tables[0]!, name: "unexpected" }),
    ],
    [
      "extra column",
      (s: ReturnType<typeof buildExpectedSchemaSnapshot>) =>
        s.tables[0]!.columns.push({
          ...s.tables[0]!.columns[0]!,
          name: "unexpected",
        }),
    ],
    [
      "unsigned",
      (s: ReturnType<typeof buildExpectedSchemaSnapshot>) =>
        (s.tables
          .find((table) => table.name === "media_items")!
          .columns.find((column) => column.name === "id")!.type = "bigint"),
    ],
    [
      "index order",
      (s: ReturnType<typeof buildExpectedSchemaSnapshot>) =>
        s.tables
          .find((t) => t.name === "comments")!
          .indexes.find((i) => i.columns.length > 1)!
          .columns.reverse(),
    ],
    [
      "unique",
      (s: ReturnType<typeof buildExpectedSchemaSnapshot>) =>
        (s.tables
          .find((t) => t.name === "tags")!
          .indexes.find((i) => i.name === "uq_tags_identity")!.unique = false),
    ],
    [
      "FK target",
      (s: ReturnType<typeof buildExpectedSchemaSnapshot>) =>
        (s.tables.find(
          (t) => t.name === "comments",
        )!.foreignKeys[0]!.referencedTable = "users"),
    ],
    [
      "FK columns",
      (s: ReturnType<typeof buildExpectedSchemaSnapshot>) =>
        (s.tables.find(
          (t) => t.name === "comments",
        )!.foreignKeys[0]!.columns[0] = "id"),
    ],
    [
      "ON DELETE",
      (s: ReturnType<typeof buildExpectedSchemaSnapshot>) =>
        (s.tables.find((t) => t.name === "comments")!.foreignKeys[0]!.onDelete =
          "CASCADE"),
    ],
    [
      "ON UPDATE",
      (s: ReturnType<typeof buildExpectedSchemaSnapshot>) =>
        (s.tables.find((t) => t.name === "comments")!.foreignKeys[0]!.onUpdate =
          "CASCADE"),
    ],
  ])("retains fail-closed drift detection: %s", (_name, mutate) => {
    const expected = buildExpectedSchemaSnapshot(),
      actual = structuredClone(expected);
    mutate(actual);
    expect(() => assertExactSchema(expected, actual)).toThrow(
      MigrationReadinessError,
    );
  });
});
