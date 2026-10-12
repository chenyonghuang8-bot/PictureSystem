import { defineConfig } from "@playwright/test";

import { prepareWebAcceptanceStorage } from "./tests/e2e-web/storage-harness.js";

const storage = prepareWebAcceptanceStorage();

export default defineConfig({
  testDir: "./tests/e2e-web",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  metadata: {
    phase5WebAcceptanceMediaRoot: storage.mediaRoot,
    phase6d5ApiObservationLog: storage.apiObservationLog,
    phase6d5WebAcceptanceStorage: storage,
  },
  globalSetup: "./tests/e2e-web/global-setup.ts",
  use: {
    baseURL: "https://localhost:3443",
    channel: "chrome",
    ignoreHTTPSErrors: true,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
});
