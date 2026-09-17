import { describe, expect, it } from "vitest";

import { PasswordValidationError, validatePassword } from "./password.js";

describe("password validation", () => {
  it("enforces the 8–256 code-point range", () => {
    expect(() => validatePassword("a".repeat(7))).toThrow(
      PasswordValidationError,
    );
    expect(validatePassword("a".repeat(8))).toBe("a".repeat(8));
    expect(validatePassword("a".repeat(256))).toBe("a".repeat(256));
    expect(() => validatePassword("a".repeat(257))).toThrow(
      PasswordValidationError,
    );
  });

  it("does not trim or normalize", () => {
    expect(validatePassword("  secret  ")).toBe("  secret  ");
    expect(validatePassword("Cafe\u0301pass")).toBe("Cafe\u0301pass");
  });

  it("accepts exactly 1024 UTF-8 bytes and rejects input over the limits", () => {
    const boundary = "😀".repeat(256);
    expect(Buffer.byteLength(validatePassword(boundary), "utf8")).toBe(1024);
    expect(() => validatePassword(`${boundary}a`)).toThrow(
      PasswordValidationError,
    );
  });

  it("rejects malformed Unicode and non-strings", () => {
    expect(() => validatePassword("password\uD800")).toThrow(
      PasswordValidationError,
    );
    expect(() => validatePassword(null)).toThrow(PasswordValidationError);
  });
});
