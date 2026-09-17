import { countCodePoints, hasMalformedUnicode } from "./unicode.js";

export class PasswordValidationError extends Error {
  readonly code = "INVALID_PASSWORD";

  constructor() {
    super("Password does not meet the length requirements.");
    this.name = "PasswordValidationError";
  }
}

export function validatePassword(input: unknown): string {
  if (typeof input !== "string" || hasMalformedUnicode(input)) {
    throw new PasswordValidationError();
  }

  const codePoints = countCodePoints(input);
  if (
    codePoints < 8 ||
    codePoints > 256 ||
    Buffer.byteLength(input, "utf8") > 1024
  ) {
    throw new PasswordValidationError();
  }

  return input;
}
