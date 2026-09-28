import { countCodePoints, hasMalformedUnicode } from "@family-album/auth";

export class MediaTextValidationError extends Error {
  constructor() {
    super("INVALID_MEDIA_TEXT");
    this.name = "MediaTextValidationError";
  }
}

export type NormalizedTagName = {
  name: string;
  normalizedBytes: Buffer;
};

export function normalizeTagName(input: unknown): NormalizedTagName {
  if (
    typeof input !== "string" ||
    hasMalformedUnicode(input) ||
    countCodePoints(input) > 256 ||
    Buffer.byteLength(input, "utf8") > 1_024
  ) {
    invalid();
  }
  const name = input
    .normalize("NFKC")
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
    .replace(/\p{White_Space}+/gu, " ");
  if (/[\p{Cc}\p{Cf}]/u.test(name) || !within(name, 1, 64, 256)) {
    invalid();
  }
  const normalized = name.toLowerCase();
  if (!within(normalized, 1, 64, 256)) invalid();
  return { name, normalizedBytes: Buffer.from(normalized, "utf8") };
}

export function normalizeMediaNote(input: unknown): string | null {
  if (input === null) return null;
  const value = normalizePlainText(input, 4_000, 16_000);
  return value.trim().length === 0 ? null : value;
}

export function normalizeMediaComment(input: unknown): string {
  const value = normalizePlainText(input, 2_000, 8_000);
  if (value.trim().length === 0) invalid();
  return value;
}

function normalizePlainText(
  input: unknown,
  maximumCodePoints: number,
  maximumBytes: number,
) {
  if (typeof input !== "string" || hasMalformedUnicode(input)) invalid();
  const value = input.replace(/\r\n?/gu, "\n");
  if (
    value.includes("\0") ||
    !within(value, 0, maximumCodePoints, maximumBytes)
  ) {
    invalid();
  }
  return value;
}

function within(
  value: string,
  minimumCodePoints: number,
  maximumCodePoints: number,
  maximumBytes: number,
) {
  const codePoints = countCodePoints(value);
  return (
    codePoints >= minimumCodePoints &&
    codePoints <= maximumCodePoints &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function invalid(): never {
  throw new MediaTextValidationError();
}
