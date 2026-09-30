export type ParsedSessionCookie = {
  cookieHeader: string;
  safe: {
    nameIsExpected: boolean;
    valueIsNonEmpty: boolean;
    secure: boolean;
    httpOnly: boolean;
    sameSiteLax: boolean;
    pathIsRoot: boolean;
    domainAbsent: boolean;
  };
};

export function parseSessionCookie(serialized: string): ParsedSessionCookie {
  const parts = serialized.split(";").map((part) => part.trim());
  const first = parts.shift() ?? "";
  const separator = first.indexOf("=");
  const name = separator < 0 ? "" : first.slice(0, separator);
  const value = separator < 0 ? "" : first.slice(separator + 1);
  const attributes = new Map<string, string | true>();
  for (const part of parts) {
    const attributeSeparator = part.indexOf("=");
    if (attributeSeparator < 0) {
      attributes.set(part.toLowerCase(), true);
    } else {
      attributes.set(
        part.slice(0, attributeSeparator).toLowerCase(),
        part.slice(attributeSeparator + 1),
      );
    }
  }
  return {
    cookieHeader: first,
    safe: {
      nameIsExpected: name === "__Host-family_session",
      valueIsNonEmpty: value.length > 0,
      secure: attributes.get("secure") === true,
      httpOnly: attributes.get("httponly") === true,
      sameSiteLax:
        String(attributes.get("samesite") ?? "").toLowerCase() === "lax",
      pathIsRoot: attributes.get("path") === "/",
      domainAbsent: !attributes.has("domain"),
    },
  };
}

export function assertSensitiveCategoryAbsent(
  text: string,
  input: { category: string; secret: string | RegExp },
): void {
  assertSafeCategory(input.category);
  const present =
    typeof input.secret === "string"
      ? input.secret.length > 0 && text.includes(input.secret)
      : input.secret.test(text);
  if (present) {
    throw new Error(
      `Sensitive category unexpectedly present: ${input.category}`,
    );
  }
}

export function assertSensitiveValuesEqual(
  category: string,
  actual: string,
  expected: string,
): void {
  assertSafeCategory(category);
  if (actual !== expected) {
    throw new Error(`Sensitive category did not match: ${category}`);
  }
}

export function assertSensitiveProjectionEqual<TActual, TProjection>(
  category: string,
  actual: TActual,
  expected: TProjection,
  project: (value: TActual) => TProjection,
): void {
  assertSafeCategory(category);
  if (!isDeepStrictEqual(project(actual), expected)) {
    throw new Error(`Sensitive projection did not match: ${category}`);
  }
}

function assertSafeCategory(category: string) {
  if (!/^[a-z0-9-]+$/u.test(category)) {
    throw new Error("Sensitive category label is invalid");
  }
}
import { isDeepStrictEqual } from "node:util";
