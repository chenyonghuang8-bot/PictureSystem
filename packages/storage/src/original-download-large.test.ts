import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { StorageRoot } from "./index.js";

const child = fileURLToPath(
  new URL("./original-download-child.ts", import.meta.url),
);
const addon = fileURLToPath(
  new URL("../build/storage_native_test.node", import.meta.url),
);
const require = createRequire(import.meta.url);
const native = require(addon) as {
  originalDownloadTestBarrier(action: string): void;
  originalDownloadTestDiagnostics(): Diagnostics;
};

type Diagnostics = {
  openCount: string;
  closeCount: string;
  activeWork: string;
  liveContexts: string;
  ownedFds: string;
  barrierReached: boolean;
  maxActiveWork: string;
  maxReadBuffer: string;
};

describe("Phase 6D1 isolated download lifecycle", () => {
  it("streams 64 MiB with bounded memory while timers and forced GC run", () => {
    const output = execFileSync(
      process.execPath,
      ["--expose-gc", "--import", "tsx", child, "large"],
      { encoding: "utf8", timeout: 30_000 },
    );
    const result = JSON.parse(output.trim()) as {
      total: number;
      maxChunk: number;
      heartbeats: number;
      rssGrowth: number;
      maxActiveWork: number;
      maxReadBuffer: number;
      wallMs: number;
    };
    expect(result.total).toBe(64 * 1024 * 1024);
    expect(result.maxChunk).toBeLessThanOrEqual(256 * 1024);
    expect(result.maxReadBuffer).toBeLessThanOrEqual(256 * 1024);
    expect(result.maxActiveWork).toBe(1);
    expect(result.heartbeats).toBeGreaterThan(5);
    expect(result.rssGrowth).toBeLessThan(48 * 1024 * 1024);
    expect(result.wallMs).toBeGreaterThan(0);
  }, 35_000);

  it("bounds completion polling while verification is held", () => {
    const output = execFileSync(
      process.execPath,
      ["--expose-gc", "--import", "tsx", child, "polling"],
      { encoding: "utf8", timeout: 10_000 },
    );
    const result = JSON.parse(output.trim()) as {
      holdMs: number;
      pollsDuringHold: number;
      cpuMs: number;
      elu: number;
      heartbeats: number;
      pollsAfterSettlement: number;
    };
    expect(result.holdMs).toBeGreaterThanOrEqual(1_450);
    expect(result.pollsDuringHold).toBeLessThanOrEqual(250);
    expect(result.cpuMs).toBeLessThan(150);
    expect(result.elu).toBeLessThan(0.75);
    expect(result.heartbeats).toBeGreaterThan(100);
    expect(result.pollsAfterSettlement).toBe(0);
  }, 15_000);

  it.each(["VERIFY", "READ"] as const)(
    "repeatedly terminates a Worker while %s work is paused without parent barrier release",
    async (stage) => {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const fixture = createWorkerFixture();
        native.originalDownloadTestBarrier(`ARM_${stage}`);
        const before = native.originalDownloadTestDiagnostics();
        const worker = startLifecycleWorker(fixture, stage);
        let termination: Promise<number> | undefined;
        try {
          await vi.waitFor(
            () => {
              expect(
                native.originalDownloadTestDiagnostics().barrierReached,
              ).toBe(true);
            },
            { timeout: 5_000, interval: 5 },
          );
          termination = worker.terminate();
          await expect(withWatchdog(termination, 5_000)).resolves.toBe(1);
          const after = native.originalDownloadTestDiagnostics();
          expect(after.activeWork).toBe("0");
          expect(after.liveContexts).toBe(before.liveContexts);
          expect(after.ownedFds).toBe(before.ownedFds);
          expect(BigInt(after.openCount) - BigInt(before.openCount)).toBe(1n);
          expect(BigInt(after.closeCount) - BigInt(before.closeCount)).toBe(1n);
        } finally {
          native.originalDownloadTestBarrier("RESET");
          if (termination) await termination.catch(() => undefined);
          else await worker.terminate();
          fixture.close();
        }
      }
    },
    15_000,
  );

  it("finalizes an abandoned verified native capability after active work", () => {
    const output = execFileSync(
      process.execPath,
      ["--expose-gc", "--import", "tsx", child, "abandoned"],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(output.trim()).toBe("abandoned-cleanup-ok");
  }, 20_000);
});

function createWorkerFixture() {
  const fixtureBase = mkdtempSync(
    join(realpathSync(tmpdir()), "phase6d1-worker-"),
  );
  const mediaRoot = join(fixtureBase, "media");
  const root = StorageRoot.open(mediaRoot, { initialize: true });
  const bytes = Buffer.alloc(600 * 1024 + 17, 42);
  const sha256Hex = createHash("sha256").update(bytes).digest("hex");
  const identity = {
    familyId: "1",
    sha256Hex,
    byteSize: String(bytes.length),
  };
  root.createUploadPayload("1", "f".repeat(32), bytes);
  root.publishOriginal({ ...identity, uploadId: "f".repeat(32) });
  return {
    mediaRoot,
    markerId: root.markerId,
    identity,
    close() {
      root.close();
      expect(relative(realpathSync(tmpdir()), fixtureBase)).toMatch(
        /^phase6d1-worker-[^/]+$/u,
      );
      rmSync(fixtureBase, { recursive: true, force: true });
    },
  };
}

function startLifecycleWorker(
  fixture: ReturnType<typeof createWorkerFixture>,
  stage: "VERIFY" | "READ",
) {
  return new Worker(
    `
      const { workerData } = require("node:worker_threads");
      const native = require(workerData.addon);
      const reader = native.openOriginalReader(workerData.mediaRoot, workerData.markerId);
      const handle = native.startVerifiedOriginalDownload(
        reader.handle,
        workerData.identity.familyId,
        workerData.identity.sha256Hex,
        workerData.identity.byteSize,
      );
      function pollOpen() {
        const result = native.pollOriginalDownload(handle);
        if (result === null) return setImmediate(pollOpen);
        if (workerData.stage === "READ") {
          native.startOriginalDownloadRead(handle);
          setImmediate(pollRead);
        }
      }
      function pollRead() {
        const result = native.pollOriginalDownload(handle);
        if (result === null) setImmediate(pollRead);
      }
      setImmediate(pollOpen);
    `,
    {
      eval: true,
      workerData: {
        addon,
        stage,
        mediaRoot: fixture.mediaRoot,
        markerId: fixture.markerId,
        identity: fixture.identity,
      },
    },
  );
}

function withWatchdog<T>(operation: Promise<T>, milliseconds: number) {
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Worker teardown watchdog expired")),
        milliseconds,
      );
      timer.unref();
    }),
  ]);
}
