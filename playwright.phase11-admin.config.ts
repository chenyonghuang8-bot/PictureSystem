import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e-web",
  testMatch: "phase11-admin.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120000,
  reporter: "list",
  use: {
    baseURL: "https://localhost:3443",
    channel: "chrome",
    ignoreHTTPSErrors: false,
    launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] },
    screenshot: "off",
    video: "off",
    trace: "off",
  },
});
