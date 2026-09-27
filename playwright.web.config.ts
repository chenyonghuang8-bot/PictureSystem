import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

import { prepareWebAcceptanceStorage } from "./tests/e2e-web/storage-harness.js";

const rootDir = resolve(import.meta.dirname);
const envPath = resolve(rootDir, ".env");
const storage = prepareWebAcceptanceStorage();

export default defineConfig({
  testDir: "./tests/e2e-web",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  metadata: { phase5WebAcceptanceMediaRoot: storage.mediaRoot },
  globalTeardown: "./tests/e2e-web/global-teardown.ts",
  use: {
    baseURL: "https://localhost:3443",
    channel: "chrome",
    ignoreHTTPSErrors: true,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: [
    {
      command: `node --env-file="${envPath}" --import=tsx "${rootDir}/apps/api/src/index.ts"`,
      url: "http://127.0.0.1:4400/health",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        API_HOST: "127.0.0.1",
        API_PORT: "4400",
        API_PUBLIC_ORIGIN: "https://localhost:3443",
        TRUSTED_WEB_ORIGINS: "https://localhost:3443",
        DEV_MEDIA_ROOT: storage.mediaRoot,
        DEV_STORAGE_MARKER_ID: storage.markerId,
        LOG_LEVEL: "warn",
      },
    },
    {
      command: `node "${rootDir}/tests/e2e-web/start-web-https.mjs"`,
      url: "https://localhost:3443",
      reuseExistingServer: false,
      timeout: 90_000,
      ignoreHTTPSErrors: true,
    },
  ],
});
