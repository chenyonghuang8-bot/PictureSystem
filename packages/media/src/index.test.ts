import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OriginalReader, StorageRoot } from "@family-album/storage";

import { DEV_BACKEND_ONLY, IsolatedProbeRunner } from "./index.js";

const UPLOAD_ID = "e".repeat(32);

describe("Phase 4D0 isolated original probe", () => {
  let fixtureBase: string;
  let mediaRoot: string;
  let writer: StorageRoot;
  let reader: OriginalReader;
  let runner: IsolatedProbeRunner;
  let identity: { familyId: string; sha256Hex: string; byteSize: string };
  let originalPath: string;
  let baseline: ReturnType<typeof snapshot>;

  beforeEach(() => {
    expect(process.platform).toBe("darwin");
    fixtureBase = mkdtempSync(
      join(realpathSync(tmpdir()), "phase4d0-isolation-"),
    );
    mediaRoot = join(fixtureBase, "media");
    writer = StorageRoot.open(mediaRoot, { initialize: true });
    const bytes = Buffer.from("phase 4d0 isolation synthetic original");
    identity = {
      familyId: "1",
      sha256Hex: createHash("sha256").update(bytes).digest("hex"),
      byteSize: String(bytes.length),
    };
    writer.createUploadPayload("1", UPLOAD_ID, bytes);
    originalPath = join(
      mediaRoot,
      writer.publishOriginal({ ...identity, uploadId: UPLOAD_ID }).relativePath,
    );
    writeFileSync(join(mediaRoot, ".probe-secret"), "synthetic secret", {
      mode: 0o400,
    });
    writeFileSync(join(dirname(originalPath), "second-object"), "other", {
      mode: 0o400,
    });
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: writer.markerId,
    });
    runner = new IsolatedProbeRunner({ allowDevBackend: true });
    baseline = snapshot(originalPath);
  });

  afterEach(() => {
    expect(snapshot(originalPath)).toEqual(baseline);
    reader.close();
    writer.close();
    expect(relative(realpathSync(tmpdir()), fixtureBase)).toMatch(
      /^phase4d0-isolation-[^/]+$/u,
    );
    rmSync(fixtureBase, { recursive: true, force: true });
  });

  it("enables the DEV backend only after all real sandbox capability probes pass", async () => {
    expect(DEV_BACKEND_ONLY).toBe(true);
    expect(runner.enabled).toBe(false);
    const evidence = await runner.verifyCapabilities(reader, identity);
    expect(evidence).toEqual({
      ok: true,
      read: true,
      seek: true,
      writeDenied: true,
      reopenDenied: true,
      secondDenied: true,
      secretDenied: true,
      browseDenied: true,
      mutationDenied: true,
      networkDenied: true,
      dnsDenied: true,
      forkDenied: true,
      execDenied: true,
      envClean: true,
      fdAllowlist: true,
    });
    expect(runner.enabled).toBe(true);
  });

  it("keeps the backend disabled when the capability probe fails", async () => {
    await expect(
      runner.verifyCapabilities(reader, { ...identity, byteSize: "999" }),
    ).rejects.toThrow();
    expect(runner.enabled).toBe(false);
    await expect(
      runner.runDiagnostic(reader, identity, "crash"),
    ).rejects.toThrow(/BACKEND_DISABLED/u);
  });

  it("kills and reaps timeout, crash, flood and malformed protocol children", async () => {
    await runner.verifyCapabilities(reader, identity);
    await expect(
      runner.runDiagnostic(reader, identity, "timeout-ignore-term", {
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/PROBE_TIMEOUT/u);
    expect(snapshot(originalPath)).toEqual(baseline);
    for (const [kind, timeoutMs] of [
      ["crash", 2_000],
      ["stdout-flood", 2_000],
      ["stderr-flood", 2_000],
      ["invalid-json", 2_000],
      ["deep-json", 2_000],
    ] as const) {
      await expect(
        runner.runDiagnostic(reader, identity, kind, { timeoutMs }),
      ).rejects.toThrow();
      expect(snapshot(originalPath)).toEqual(baseline);
    }
  });

  it("never enables the macOS DEV backend in production mode", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new IsolatedProbeRunner({ allowDevBackend: true })).toThrow(
        /DEV_BACKEND_DISABLED/u,
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("treats parent liveness loss as fatal and reaps the supervised child", async () => {
    const packageRoot = resolve(import.meta.dirname, "../../storage");
    const fd = openSync(originalPath, "r");
    const supervised = spawn(
      join(packageRoot, "build/original_probe_supervisor"),
      [
        join(packageRoot, "native/original-probe.sb"),
        join(packageRoot, "build/original_probe_child"),
        mediaRoot,
        homedir(),
        "timeout-ignore-term",
        "10000",
      ],
      { stdio: ["ignore", "pipe", "pipe", fd, "pipe"], env: {} },
    );
    closeSync(fd);
    await new Promise((resolveReady) => setTimeout(resolveReady, 50));
    supervised.stdio[4]?.destroy();
    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit, reject) => {
      supervised.once("error", reject);
      supervised.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    expect(exit).toEqual({ code: 75, signal: null });
    expect(() => process.kill(supervised.pid!, 0)).toThrow();
  });
});

function snapshot(path: string) {
  const stats = lstatSync(path, { bigint: true });
  const bytes = readFileSync(path);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    path,
    ino: stats.ino,
    mode: stats.mode & 0o777n,
    mtimeNs: stats.mtimeNs,
  };
}
