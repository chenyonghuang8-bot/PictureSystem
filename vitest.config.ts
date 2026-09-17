import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Load the repository DEV environment before Vitest collects integration suites.
process.loadEnvFile(resolve(import.meta.dirname, ".env"));

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    exclude: ["tests/e2e/**", "**/dist/**", "**/node_modules/**"],
    testTimeout: 10_000,
  },
});
