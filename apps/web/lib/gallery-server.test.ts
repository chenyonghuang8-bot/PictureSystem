import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "__Host-family_session" ? { value: "a".repeat(43) } : undefined,
  })),
}));

import { loadFamily } from "./gallery-server.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("server gallery family loading", () => {
  it("uses the authenticated me endpoint and validates the first membership", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        calls.push(String(input));
        return Response.json({
          user: {
            id: "7",
            username: "synthetic-user",
            displayName: "Family Member",
          },
          memberships: [
            {
              id: "11",
              familyId: "13",
              familyName: "Synthetic Family",
              role: "MEMBER",
            },
          ],
        });
      }),
    );

    await expect(loadFamily()).resolves.toEqual({
      familyId: "13",
      familyName: "Synthetic Family",
      displayName: "Family Member",
    });
    expect(calls).toEqual(["http://127.0.0.1:4000/api/v1/auth/me"]);
  });

  it("keeps strict meResponseSchema validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          user: {
            id: "7",
            username: "synthetic-user",
            displayName: null,
            sessionToken: "must-not-be-accepted",
          },
          memberships: [],
        }),
      ),
    );

    await expect(loadFamily()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
