import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const buildRoot = resolve(import.meta.dirname, "../build");
const ready = 'PS_RENDER_READY_V1\n{"status":"ok"}\n';

describe("D3a-0 fixed synthetic renderer startup", () => {
  let root: string;
  let original: string;
  let baseline: ReturnType<typeof snapshot>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "phase4d3a0-startup-"));
    original = join(root, "synthetic-original.bin");
    writeFileSync(
      original,
      Buffer.from("synthetic original; never family media"),
      {
        mode: 0o400,
      },
    );
    baseline = snapshot(original);
  });

  afterEach(() => {
    try {
      expect(snapshot(original)).toEqual(baseline);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function run(suffix = "") {
    const fd = openSync(original, "r");
    try {
      return spawnSync(
        join(buildRoot, `image_renderer_supervisor${suffix}`),
        [],
        {
          stdio: ["ignore", "pipe", "pipe", fd, "pipe"],
          env: { LANG: "C", LC_ALL: "C" },
          timeout: 8_000,
        },
      );
    } finally {
      closeSync(fd);
    }
  }

  it("activates exactly once, then loads module and first reads FD3", () => {
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe(ready);
    expect(result.stderr.length).toBe(0);
  });

  it("does not inherit poisoned parent environment", () => {
    const keys = [
      "HOME",
      "PATH",
      "TMPDIR",
      "DYLD_INSERT_LIBRARIES",
      "PS_PLUGIN_PATH",
    ];
    const previous = keys.map((key) => process.env[key]);
    try {
      for (const key of keys) process.env[key] = root;
      const result = run();
      expect(result.status).toBe(0);
      expect(result.stdout.toString()).toBe(ready);
    } finally {
      keys.forEach((key, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  it("rejects an already-sandboxed launch without READY or original mutation", () => {
    const fd = openSync(original, "r");
    try {
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          "(version 1) (allow default)",
          join(buildRoot, "image_renderer_supervisor"),
        ],
        {
          stdio: ["ignore", "pipe", "pipe", fd, "pipe"],
          env: { LANG: "C", LC_ALL: "C" },
          timeout: 8_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout.length).toBe(0);
    } finally {
      closeSync(fd);
    }
  });

  it.each([
    ["activation_failure", 84],
    ["no_ready", 84],
    ["bad_ready", 84],
    ["duplicate_ready", 84],
    ["crash_before_ready", 84],
    ["timeout_before_ready", 78],
    ["early_read", 86],
    ["bad_fingerprint", 65],
  ])("fails closed for %s", (scenario, code) => {
    const result = run(`_${scenario}`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(code);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
  });

  it("terminates the blocked bootstrap when owner liveness is lost", async () => {
    const fd = openSync(original, "r");
    const child = spawn(
      join(buildRoot, "image_renderer_supervisor_timeout_before_ready"),
      [],
      {
        stdio: ["ignore", "pipe", "pipe", fd, "pipe"],
        env: { LANG: "C", LC_ALL: "C" },
      },
    );
    closeSync(fd);
    const output: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    const closed = new Promise<number | null>((resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", resolveResult);
    });
    child.stdio[4]?.destroy();
    expect(await closed).toBe(80);
    expect(Buffer.concat(output).length).toBe(0);
  });

  it("does not leave a supervisor running after its owner process exits", async () => {
    const fd = openSync(original, "r");
    let owner;
    try {
      const fixedSupervisor = join(
        buildRoot,
        "image_renderer_supervisor_timeout_before_ready",
      );
      const script = `const {spawn}=require("node:child_process");
        const child=spawn(${JSON.stringify(fixedSupervisor)},[],{
          stdio:["ignore","ignore","ignore",3,"pipe"],
          env:{LANG:"C",LC_ALL:"C"}
        });
        process.stdout.write(String(child.pid));
        process.exit(0);`;
      owner = spawnSync(process.execPath, ["-e", script], {
        stdio: ["ignore", "pipe", "pipe", fd],
        env: { LANG: "C", LC_ALL: "C" },
        timeout: 4_000,
      });
    } finally {
      closeSync(fd);
    }
    expect(owner.error).toBeUndefined();
    expect(owner.status).toBe(0);
    const supervisorPid = Number(owner.stdout.toString());
    expect(Number.isSafeInteger(supervisorPid)).toBe(true);
    let gone = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        process.kill(supervisorPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          gone = true;
          break;
        }
        throw error;
      }
      await new Promise((resolveResult) => setTimeout(resolveResult, 50));
    }
    expect(gone).toBe(true);
  });
});

function snapshot(path: string) {
  const bytes = readFileSync(path);
  const stats = statSync(path, { bigint: true });
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    inode: stats.ino,
    mode: stats.mode & 0o777n,
    mtimeNs: stats.mtimeNs,
  };
}
