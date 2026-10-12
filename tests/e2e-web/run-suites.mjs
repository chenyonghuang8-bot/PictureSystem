import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const availableSuites = readdirSync(new URL("./", import.meta.url))
  .filter((name) => name.endsWith(".spec.ts"))
  .sort();
const selectedSuite = process.env.PHASE11_WEB_E2E_SUITE;
if (selectedSuite && !availableSuites.includes(selectedSuite))
  throw new Error("WEB_ACCEPTANCE_SUITE_UNKNOWN");
const suites = selectedSuite ? [selectedSuite] : availableSuites;

// Each suite gets a fresh API/Web process and owned storage fixture. Shared
// loopback login/reauth attempts must not consume another suite's rate bucket.
// Production authentication limits and Playwright retries remain unchanged.
if (suites.length === 0) throw new Error("WEB_ACCEPTANCE_SUITES_REQUIRED");
for (const suite of suites) {
  const receipt = resolve(
    root,
    `.cache/phase11-current/web-closure-${randomUUID()}.json`,
  );
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      suite === "phase11-admin.spec.ts"
        ? "playwright.phase11-admin.config.ts"
        : suite === "phase10-mobile-client.spec.ts" ||
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
        PHASE11_WEB_CLOSURE_RECEIPT: receipt,
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
  // The CLI and every loader/worker must be gone before the original strict
  // no-instance proof. Finalization never changes a failed test result.
  if (suite !== "phase11-admin.spec.ts") {
    if (!existsSync(receipt)) {
      process.exitCode = result.status || 1;
      break;
    }
    const finalized = spawnSync(
      process.execPath,
      [
        "--env-file=.env",
        "--import=tsx",
        "tests/e2e-web/finalize-controlled-web.ts",
        receipt,
      ],
      { cwd: root, stdio: "inherit", env: process.env },
    );
    if (finalized.error || finalized.status !== 0) {
      process.exitCode = finalized.status || 1;
      break;
    }
  }
  if (result.error || result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
