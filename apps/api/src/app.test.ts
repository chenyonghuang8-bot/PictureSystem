import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GET /health", () => {
  it("returns a structured healthy response", async () => {
    const app = createApp();
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });
    const payload = response.json<{
      status: string;
      service: string;
      timestamp: string;
    }>();

    expect(response.statusCode).toBe(200);
    expect(payload.status).toBe("ok");
    expect(payload.service).toBe("api");
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
  });
});
