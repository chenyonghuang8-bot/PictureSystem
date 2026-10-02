import { readdirSync } from "node:fs";
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
      "playwright.web.config.ts",
      `tests/e2e-web/${suite}`,
      ...process.argv.slice(2),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error || result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
