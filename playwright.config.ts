import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const rootDir = resolve(process.cwd());
const envPath = resolve(rootDir, ".env");
const apiServerCommand = `node --env-file="${envPath}" --import=tsx "${rootDir}/apps/api/src/index.ts"`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4000",
  },
  webServer: {
    command: apiServerCommand,
    url: "http://127.0.0.1:4000/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
