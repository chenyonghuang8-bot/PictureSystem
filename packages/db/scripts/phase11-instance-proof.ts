import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { basename, sep } from "node:path";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
const exec = promisify(execFile);

/** Conservative read-only preflight. Raw argv/cwd/process-list data is never
 * returned or logged. Unknown observations fail closed before additive DDL. */
export async function assertNoPhase11DevInstances(
  c: PoolConnection,
  workspace: string,
) {
  const root = realpathSync(workspace),
    uid = process.getuid?.();
  if (uid === undefined) throw Error("PHASE11_INSTANCE_PROOF_UNAVAILABLE");
  let processes: { pid: number; ppid: number; uid: number; command: string }[];
  try {
    const result = await exec(
      "/bin/ps",
      ["-axww", "-o", "pid=,ppid=,uid=,command="],
      { maxBuffer: 4 * 1024 * 1024, timeout: 2000 },
    );
    processes = result.stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (!m) throw Error("UNKNOWN_PROCESS");
        return {
          pid: Number(m[1]),
          ppid: Number(m[2]),
          uid: Number(m[3]),
          command: m[4]!,
        };
      });
  } catch {
    throw Error("PHASE11_INSTANCE_PROOF_UNAVAILABLE");
  }
  const ancestors = new Set<number>();
  let pid = process.pid;
  for (let n = 0; pid > 0 && n < 64; n++) {
    if (ancestors.has(pid)) throw Error("PHASE11_INSTANCE_PROOF_UNAVAILABLE");
    ancestors.add(pid);
    const row = processes.find((r) => r.pid === pid);
    if (!row) {
      if (n === 0) throw Error("PHASE11_INSTANCE_PROOF_UNAVAILABLE");
      break;
    }
    pid = row.ppid;
  }
  let inspected = 0;
  const ownedCompiler = (candidate: number) => {
    for (let n = 0; candidate > 0 && n < 64; n++) {
      const row = processes.find((r) => r.pid === candidate);
      if (!row) return false;
      if (ancestors.has(row.ppid)) return true;
      candidate = row.ppid;
    }
    return false;
  };
  for (const p of processes) {
    if (p.uid !== uid || ancestors.has(p.pid)) continue;
    const executable = basename(p.command.trim().split(/\s/)[0] ?? "");
    // tsx/Vitest's exact repository esbuild service belongs to this invocation
    // or an ancestor loader. No Node worker, app, codec or other descendant is
    // exempt, including compilers belonging to unrelated workspace processes.
    if (
      executable === "esbuild" &&
      p.command.includes(root + "/node_modules/") &&
      /\s--service=[0-9]+\.[0-9]+\.[0-9]+(?:\s|$)/.test(p.command) &&
      ownedCompiler(p.pid)
    )
      continue;
    const node = /^(?:node(?:\d+)?|nodejs|bun|deno)$/.test(executable);
    if (!node && !p.command.includes(root + sep)) continue;
    let cwd: string;
    try {
      const result = await exec(
        "/usr/sbin/lsof",
        ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"],
        { maxBuffer: 64 * 1024, timeout: 2000 },
      );
      const paths = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("n"));
      if (paths.length !== 1) throw Error("UNKNOWN_CWD");
      cwd = realpathSync(paths[0]!.slice(1));
    } catch {
      throw Error("PHASE11_INSTANCE_PROOF_UNAVAILABLE");
    }
    inspected++;
    if (
      cwd === root ||
      cwd.startsWith(root + sep) ||
      p.command.includes(root + sep)
    )
      throw Error("PHASE11_OTHER_WORKSPACE_PROCESS_PRESENT");
  }
  const [connections] = await c.query<RowDataPacket[]>(
    `SELECT ID FROM information_schema.PROCESSLIST WHERE DB='family_album_dev' AND ID<>CONNECTION_ID()`,
  );
  if (connections.length) throw Error("PHASE11_OTHER_DEV_CONNECTION_PRESENT");
  const [jobs] = await c.query<RowDataPacket[]>(
    "SELECT COUNT(*) running FROM background_jobs WHERE state='RUNNING'",
  );
  if (String(jobs[0]?.running) !== "0")
    throw Error("PHASE11_RUNNING_JOB_PRESENT");
  return {
    ownUidWorkspaceProcesses: 0,
    otherVisibleDevConnections: 0,
    runningJobs: "0",
    inspectedProcesses: inspected,
    observedAt: new Date().toISOString(),
  };
}
