import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const suites = readdirSync(new URL("./", import.meta.url))
  .filter((name) => name.endsWith(".spec.ts"))
  .sort();

// Each suite gets a fresh API/Web process and owned storage fixture. Shared
// loopback login/reauth attempts must not consume another suite's rate bucket.
// Production authentication limits and Playwright retries remain unchanged.
if (suites.length === 0) throw new Error("WEB_ACCEPTANCE_SUITES_REQUIRED");
for (const suite of suites) {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      suite === "phase10-mobile-client.spec.ts" ||
      Boolean(process.env.PHASE10_CLIENT_TLS_CERT_FILE)
        ? "playwright.phase10-client.config.ts"
        : "playwright.web.config.ts",
      `tests/e2e-web/${suite}`,
      ...process.argv.slice(2),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        ...([
          "memories-validation.spec.ts",
          "phase10-mobile-client.spec.ts",
        ].includes(suite)
          ? {
              DEV_MEDIA_PIPELINE_ENABLED: "1",
              LOCATION_DATA_DIR: resolve(root, "resources/location/2026-10-03"),
            }
          : {}),
      },
    },
  );
  if (result.error || result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
