import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "./route.js";
import { GET as GETOptions } from "./options/route.js";

let server: Server;
let originalOrigin: string | undefined;
const seen: { url: string; cookie?: string; authorization?: string }[] = [];
beforeAll(async () => {
  originalOrigin = process.env.FAMILY_ALBUM_API_ORIGIN;
  server = createServer((request, response) => {
    seen.push({
      url: request.url!,
      ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
      ...(request.headers.authorization
        ? { authorization: request.headers.authorization }
        : {}),
    });
    response.setHeader("content-type", "application/json");
    response.statusCode =
      request.headers.cookie && request.headers.authorization
        ? 400
        : request.headers.cookie || request.headers.authorization
          ? 200
          : 401;
    response.end(
      JSON.stringify(
        response.statusCode === 200
          ? { media: [], nextCursor: null }
          : { code: "INVALID_REQUEST" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("OWNED_UPSTREAM_REQUIRED");
  process.env.FAMILY_ALBUM_API_ORIGIN = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (originalOrigin === undefined) delete process.env.FAMILY_ALBUM_API_ORIGIN;
  else process.env.FAMILY_ALBUM_API_ORIGIN = originalOrigin;
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});
describe("exact search forwarding boundary", () => {
  it("forwards options to the fixed upstream path with raw strict query and both credentials", async () => {
    const query = "?kind=tag&limit=1&limit=2&cursor=synthetic_options_cursor";
    const response = await GETOptions(
      new Request(`http://web.local/api/v1/families/4/search/options${query}`, {
        headers: {
          cookie: "synthetic-cookie",
          authorization: "Bearer synthetic-bearer",
        },
      }),
      { params: Promise.resolve({ familyId: "4" }) },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(seen.at(-1)).toEqual({
      url: `/api/v1/families/4/search/options${query}`,
      cookie: "synthetic-cookie",
      authorization: "Bearer synthetic-bearer",
    });
  });
  it.each([
    {
      headers: {
        cookie: "synthetic-cookie",
        authorization: "Bearer synthetic-bearer",
      },
      status: 400,
    },
    { headers: { authorization: "Bearer synthetic-bearer" }, status: 200 },
    { headers: {}, status: 401 },
  ])(
    "preserves credentials and the upstream status %j",
    async ({ headers, status }) => {
      const query = "?limit=1&limit=2&cursor=synthetic_cursor";
      const result = await GET(
        new Request(`http://web.local/api/v1/families/4/search${query}`, {
          headers,
        }),
        { params: Promise.resolve({ familyId: "4" }) },
      );
      expect(result.status).toBe(status);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.get("content-type")).toBe("application/json");
      const observed = seen.at(-1)!;
      expect(observed.url).toBe(`/api/v1/families/4/search${query}`);
      expect(observed.cookie).toBe(headers.cookie);
      expect(observed.authorization).toBe(headers.authorization);
      expect(await result.json()).toEqual(
        status === 200
          ? { media: [], nextCursor: null }
          : { code: "INVALID_REQUEST" },
      );
    },
  );
});
