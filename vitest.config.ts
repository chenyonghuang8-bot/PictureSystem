import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Load the repository DEV environment before Vitest collects integration suites.
process.loadEnvFile(resolve(import.meta.dirname, ".env"));

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["tests/e2e/**", "**/dist/**", "**/node_modules/**"],
    testTimeout: 10_000,
    // Integration files share one DEV database. Unfiltered job claim and the
    // named capacity lock are process-global, so these files must not overlap.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
