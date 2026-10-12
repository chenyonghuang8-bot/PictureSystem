import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PoolConnection } from "mysql2/promise";
import { it, expect, vi } from "vitest";
import { assertNoPhase11DevInstances } from "./phase11-instance-proof.js";

it("the precise loader compiler exception never exempts an actual workspace Node descendant", async () => {
  // Isolate the workspace boundary from Vitest's unrelated idle Node workers.
  // The real repository + checked DEV SQL proof runs in outage acceptance.
  const workspace = mkdtempSync(
    join(realpathSync(tmpdir()), "phase11-instance-unit-"),
  );
  const query = vi.fn(async (sql: string) =>
    sql.includes("PROCESSLIST") ? [[]] : [[{ running: "0" }]],
  );
  let child: ChildProcess | undefined;
  try {
    await assertNoPhase11DevInstances(
      { query } as unknown as PoolConnection,
      workspace,
    );
    query.mockClear();
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: workspace,
      stdio: "ignore",
    });
    await once(child, "spawn");
    await expect(
      assertNoPhase11DevInstances(
        { query } as unknown as PoolConnection,
        workspace,
      ),
    ).rejects.toThrow("PHASE11_OTHER_WORKSPACE_PROCESS_PRESENT");
    expect(query).not.toHaveBeenCalled();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}, 10000);
