import { expect, test } from "@playwright/test";

test("API health smoke", async ({ request }) => {
  const response = await request.get("/health");
  const payload = (await response.json()) as {
    service: string;
    status: string;
  };

  expect(response.ok()).toBe(true);
  expect(payload).toMatchObject({ service: "api", status: "ok" });
});
