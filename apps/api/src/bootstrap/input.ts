import { countCodePoints, hasMalformedUnicode } from "@family-album/auth";

export function validateFamilyName(input: unknown) {
  if (typeof input !== "string" || hasMalformedUnicode(input)) {
    throw new Error("INVALID_FAMILY_NAME");
  }
  const value = input.trim();
  if (countCodePoints(value) < 1 || countCodePoints(value) > 128) {
    throw new Error("INVALID_FAMILY_NAME");
  }
  return value;
}

export function validateBootstrapDisplayName(input: unknown) {
  if (input === "") return null;
  if (typeof input !== "string" || hasMalformedUnicode(input)) {
    throw new Error("INVALID_DISPLAY_NAME");
  }
  const value = input.trim();
  if (countCodePoints(value) < 1 || countCodePoints(value) > 128) {
    throw new Error("INVALID_DISPLAY_NAME");
  }
  return value;
}

export function assertInteractiveDevRuntime(input: {
  argvLength: number;
  appEnv: string | undefined;
  nodeEnv: string | undefined;
  stdinIsTty: boolean | undefined;
  stdoutIsTty: boolean | undefined;
}) {
  if (
    input.argvLength !== 2 ||
    input.appEnv !== "dev" ||
    input.nodeEnv === "production" ||
    input.stdinIsTty !== true ||
    input.stdoutIsTty !== true
  ) {
    throw new Error("LOCAL_INTERACTIVE_DEV_ONLY");
  }
}
