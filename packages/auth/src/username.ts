import { countCodePoints, hasMalformedUnicode } from "./unicode.js";

const FORBIDDEN_USERNAME_CHARACTER = /[\p{White_Space}\p{Cc}\p{Cf}]/u;

export type NormalizedUsername = Readonly<{
  display: string;
  normalized: string;
  normalizedBytes: Buffer;
  version: "username-v1";
}>;

export class UsernameValidationError extends Error {
  readonly code = "INVALID_USERNAME";

  constructor() {
    super("Username is invalid.");
    this.name = "UsernameValidationError";
  }
}

export function normalizeUsername(input: unknown): NormalizedUsername {
  if (typeof input !== "string" || hasMalformedUnicode(input)) {
    throw new UsernameValidationError();
  }

  const display = input.trim();
  if (
    countCodePoints(display) < 1 ||
    countCodePoints(display) > 64 ||
    FORBIDDEN_USERNAME_CHARACTER.test(display)
  ) {
    throw new UsernameValidationError();
  }

  const normalized = display.normalize("NFKC").toLowerCase();
  const normalizedBytes = Buffer.from(normalized, "utf8");
  if (
    hasMalformedUnicode(normalized) ||
    countCodePoints(normalized) < 1 ||
    countCodePoints(normalized) > 128 ||
    normalizedBytes.byteLength > 512 ||
    FORBIDDEN_USERNAME_CHARACTER.test(normalized)
  ) {
    throw new UsernameValidationError();
  }

  return { display, normalized, normalizedBytes, version: "username-v1" };
}
