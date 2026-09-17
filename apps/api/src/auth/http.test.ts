import { describe, expect, it } from "vitest";

import { clearSessionCookie, sessionCookie } from "./http.js";

describe("WEB session cookie", () => {
  it("always uses the __Host security attributes and no Domain", () => {
    const value = sessionCookie(
      "token",
      new Date("2026-02-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(value).toContain("__Host-family_session=token");
    expect(value).toContain("Secure");
    expect(value).toContain("HttpOnly");
    expect(value).toContain("SameSite=Lax");
    expect(value).toContain("Path=/");
    expect(value).not.toContain("Domain=");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});
