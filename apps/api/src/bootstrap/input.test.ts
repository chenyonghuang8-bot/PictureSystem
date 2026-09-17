import { describe, expect, it } from "vitest";

import {
  assertInteractiveDevRuntime,
  validateBootstrapDisplayName,
  validateFamilyName,
} from "./input.js";

describe("bootstrap input", () => {
  it("validates family and optional display names without credentials", () => {
    expect(validateFamilyName(" Family ")).toBe("Family");
    expect(validateBootstrapDisplayName("")).toBeNull();
    expect(validateBootstrapDisplayName(" Admin ")).toBe("Admin");
    expect(() => validateFamilyName(" ")).toThrow("INVALID_FAMILY_NAME");
    expect(() => validateFamilyName("x".repeat(129))).toThrow(
      "INVALID_FAMILY_NAME",
    );
  });

  it("requires an argument-free interactive DEV process", () => {
    const valid = {
      argvLength: 2,
      appEnv: "dev",
      nodeEnv: "development",
      stdinIsTty: true,
      stdoutIsTty: true,
    } as const;
    expect(() => assertInteractiveDevRuntime(valid)).not.toThrow();
    expect(() =>
      assertInteractiveDevRuntime({ ...valid, stdinIsTty: false }),
    ).toThrow("LOCAL_INTERACTIVE_DEV_ONLY");
    expect(() =>
      assertInteractiveDevRuntime({ ...valid, argvLength: 3 }),
    ).toThrow("LOCAL_INTERACTIVE_DEV_ONLY");
    expect(() =>
      assertInteractiveDevRuntime({ ...valid, appEnv: "prod" }),
    ).toThrow("LOCAL_INTERACTIVE_DEV_ONLY");
  });
});
