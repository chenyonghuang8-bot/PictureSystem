import { describe, expect, it } from "vitest";

import { normalizeUsername, UsernameValidationError } from "./username.js";

describe("username-v1", () => {
  it.each([
    ["Dad", "dad"],
    ["dad", "dad"],
    ["Ｄａｄ", "dad"],
    ["e\u0301", "é"],
  ])("normalizes %s to %s", (input, expected) => {
    const result = normalizeUsername(input);
    expect(result.normalized).toBe(expected);
    expect(result.normalizedBytes).toEqual(Buffer.from(expected, "utf8"));
  });

  it("keeps the design's intentional distinctions", () => {
    expect(normalizeUsername("é").normalized).not.toBe(
      normalizeUsername("e").normalized,
    );
    expect(normalizeUsername("ß").normalized).not.toBe(
      normalizeUsername("ss").normalized,
    );
  });

  it("trims only boundary whitespace and preserves the trimmed display value", () => {
    expect(normalizeUsername("  Dad\t")).toMatchObject({
      display: "Dad",
      normalized: "dad",
    });
  });

  it.each([
    "dad smith",
    "dad\tsmith",
    "dad\nsmith",
    "dad\u200Bsmith",
    "dad\u2060smith",
  ])(
    "rejects internal whitespace and format/control characters: %j",
    (input) => {
      expect(() => normalizeUsername(input)).toThrow(UsernameValidationError);
    },
  );

  it.each(["\uD800", "dad\uDC00"])("rejects malformed Unicode: %j", (input) => {
    expect(() => normalizeUsername(input)).toThrow(UsernameValidationError);
  });

  it("checks code-point and UTF-8 byte bounds after normalization", () => {
    expect(() => normalizeUsername("a".repeat(65))).toThrow(
      UsernameValidationError,
    );
    expect(() => normalizeUsername("😀".repeat(64))).not.toThrow();
  });

  it("is idempotent", () => {
    const once = normalizeUsername(" ＤＡＤ ").normalized;
    expect(normalizeUsername(once).normalized).toBe(once);
  });

  it("rejects non-string values", () => {
    expect(() => normalizeUsername(42)).toThrow(UsernameValidationError);
  });
});
