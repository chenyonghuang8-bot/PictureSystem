import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, expect } from "vitest";
if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");
it("Phase11 real API TCP database outage persists deny through offline restart and online startup latch before authorized RECHECK", async () => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("tests/integration/fixtures/phase11-database-outage.ts"),
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const code = await new Promise<number | null>((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
  });
  writeFileSync(
    resolve(
      ".cache/phase11-current",
      `database-outage-suite-${randomUUID()}.log`,
    ),
    output,
    { mode: 0o600 },
  );
  expect(code).toBe(0);
  expect(output).toContain(
    "ACTUAL_TCP_OUTAGE_DURABLE_DENY_OFFLINE_RESTART_FRESH_RECHECK_PASS",
  );
  expect(output).toContain("EXACT_OUTAGE_FIXTURE_CLEANED_HISTORY_RETAINED");
}, 120000);
