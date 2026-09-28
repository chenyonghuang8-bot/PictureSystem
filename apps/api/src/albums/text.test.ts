import { describe, expect, it } from "vitest";

import {
  MediaTextValidationError,
  normalizeMediaComment,
  normalizeMediaNote,
  normalizeTagName,
} from "./text.js";

describe("Phase 6C media text normalization", () => {
  it.each([
    [" Trip ", "Trip", "trip"],
    ["Ｔｒｉｐ", "Trip", "trip"],
    ["Cafe\u0301", "Café", "café"],
    ["one\t\n two", "one two", "one two"],
    ["\u0085Trip\u0085", "Trip", "trip"],
    ["\u00a0Trip\u00a0", "Trip", "trip"],
    ["\u2003Trip\u2003", "Trip", "trip"],
    ["Trip\u0085Family", "Trip Family", "trip family"],
    ["Trip\u00a0\u2003\tFamily", "Trip Family", "trip family"],
    ["é", "é", "é"],
    ["ß", "ß", "ß"],
  ])("normalizes tag-v1 %j", (input, name, normalized) => {
    const result = normalizeTagName(input);
    expect(result.name).toBe(name);
    expect(result.normalizedBytes.equals(Buffer.from(normalized))).toBe(true);
  });

  it.each([
    "",
    "   ",
    "\u0085",
    "bad\u200btag",
    "bad\u202etag",
    "bad\0tag",
    "\ud800",
  ])("rejects unsafe tag input %j", (input) =>
    expect(() => normalizeTagName(input)).toThrow(MediaTextValidationError),
  );

  it.each(["\u0085Trip\u0085", "\u00a0Trip\u2003Family\u0085", "Ｔｒｉｐ"])(
    "is idempotent for tag-v1 display and identity %j",
    (input) => {
      const first = normalizeTagName(input);
      const second = normalizeTagName(first.name);
      expect(second.name).toBe(first.name);
      expect(second.normalizedBytes.equals(first.normalizedBytes)).toBe(true);
    },
  );

  it("preserves the approved non-casefold distinctions", () => {
    expect(
      normalizeTagName("é").normalizedBytes.equals(
        normalizeTagName("e").normalizedBytes,
      ),
    ).toBe(false);
    expect(
      normalizeTagName("ß").normalizedBytes.equals(
        normalizeTagName("ss").normalizedBytes,
      ),
    ).toBe(false);
  });

  it("applies raw and canonical tag bounds", () => {
    expect(() => normalizeTagName("a".repeat(257))).toThrow();
    expect(() => normalizeTagName("a".repeat(65))).toThrow();
    expect(() => normalizeTagName("😀".repeat(64))).not.toThrow();
    expect(() => normalizeTagName("😀".repeat(65))).toThrow();
    expect(() => normalizeTagName("ﬃ".repeat(22))).toThrow();
  });

  it("normalizes note newlines, preserves content and maps blank to null", () => {
    expect(normalizeMediaNote("  hello\r\nworld\r ")).toBe("  hello\nworld\n ");
    expect(normalizeMediaNote(" \n\t ")).toBeNull();
    expect(normalizeMediaNote(null)).toBeNull();
    expect(normalizeMediaNote("😀")).toBe("😀");
    expect(normalizeMediaNote("😀".repeat(4_000))).toHaveLength(8_000);
    expect(() => normalizeMediaNote("😀".repeat(4_001))).toThrow();
  });

  it("keeps comments plain text while rejecting blank or unsafe content", () => {
    expect(normalizeMediaComment("<b>hello</b>\r\n")).toBe("<b>hello</b>\n");
    expect(() => normalizeMediaComment(" \n\t ")).toThrow();
    expect(() => normalizeMediaComment("x\0y")).toThrow();
    expect(() => normalizeMediaComment("\udfff")).toThrow();
    expect(() => normalizeMediaComment("😀".repeat(2_001))).toThrow();
    expect(normalizeMediaComment("😀".repeat(2_000))).toHaveLength(4_000);
  });
});
