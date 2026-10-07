import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { createSessionToken } from "@family-album/auth";
import {
  readSessionCredential,
  requireSessionJsonMutation,
  requireNativeJson,
} from "./http.js";
const token = createSessionToken();
function request(headers: Record<string, unknown>, rawHeaders: string[] = []) {
  return { headers, raw: { rawHeaders } } as unknown as FastifyRequest;
}
describe("Phase10 strict credential dispatch", () => {
  it("selects explicit transports", () => {
    expect(
      readSessionCredential(request({ authorization: `Bearer ${token}` }))
        ?.expectedClientType,
    ).toBe("ANDROID");
    expect(
      readSessionCredential(
        request({ cookie: `__Host-family_session=${token}` }),
      )?.expectedClientType,
    ).toBe("WEB");
  });
  it.each([
    { authorization: `Bearer ${token}`, cookie: "other=value" },
    { authorization: `Bearer ${token}`, origin: "https://localhost:3000" },
    {
      authorization: "Bearer broken",
      cookie: `__Host-family_session=${token}`,
    },
    { authorization: `bearer ${token}` },
    { authorization: `Bearer ${token}, Bearer ${token}` },
    { authorization: `Bearer ${"_".repeat(43)}` },
    { authorization: [`Bearer ${token}`, `Bearer ${token}`] },
  ])(
    "rejects mixed/noncanonical credentials without fallback (%#)",
    (headers) =>
      expect(() => readSessionCredential(request(headers))).toThrow(),
  );
  it("rejects duplicate raw Authorization even if a server retained one", () =>
    expect(() =>
      readSessionCredential(
        request({ authorization: `Bearer ${token}` }, [
          "Authorization",
          `Bearer ${token}`,
          "authorization",
          `Bearer ${token}`,
        ]),
      ),
    ).toThrow());
  it("keeps Web mutation Origin and native JSON guards", () => {
    expect(() =>
      requireSessionJsonMutation(
        request({
          cookie: `__Host-family_session=${token}`,
          "content-type": "application/json",
        }),
        new Set(),
      ),
    ).toThrow();
    expect(() =>
      requireSessionJsonMutation(
        request({
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        }),
        new Set(),
      ),
    ).not.toThrow();
    expect(() =>
      requireSessionJsonMutation(
        request({
          authorization: `Bearer ${token}`,
          "content-type": "text/plain",
        }),
        new Set(),
      ),
    ).toThrow();
    expect(() =>
      requireNativeJson(
        request({
          "content-type": "application/json",
          cookie: "unrelated=value",
        }),
      ),
    ).toThrow();
  });
});
