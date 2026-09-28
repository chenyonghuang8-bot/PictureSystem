import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import {
  setImmediate as setImmediatePromise,
  setTimeout as delay,
} from "node:timers/promises";

import { OriginalReader, StorageRoot } from "./index.js";

type NativeBinding = {
  openOriginalReader(
    path: string,
    expectedMarkerId: string,
  ): { handle: object };
  closeOriginalReader(handle: object): void;
  startVerifiedOriginalDownload(
    handle: object,
    familyId: string,
    sha256Hex: string,
    byteSize: string,
  ): object;
  pollOriginalDownload(handle: object): null | { kind: string };
  originalDownloadTestBarrier(action: string): void;
  originalDownloadTestDiagnostics(): {
    openCount: string;
    closeCount: string;
    activeWork: string;
    maxActiveWork: string;
    maxReadBuffer: string;
    barrierReached: boolean;
  };
};

const require = createRequire(import.meta.url);
const native = require("../build/storage_native_test.node") as NativeBinding;
const FILE_SIZE = 64 * 1024 * 1024;

async function main() {
  if (typeof global.gc !== "function") throw new Error("--expose-gc required");
  const mode = process.argv[2];
  const fixtureBase = mkdtempSync(
    join(realpathSync(tmpdir()), "phase6d1-large-"),
  );
  if (
    !relative(realpathSync(tmpdir()), fixtureBase).startsWith("phase6d1-large-")
  )
    throw new Error("unsafe fixture cleanup target");
  const mediaRoot = join(fixtureBase, "media");
  const writer = StorageRoot.open(mediaRoot, { initialize: true });
  let reader: OriginalReader | undefined;
  try {
    if (mode !== "large" && mode !== "abandoned" && mode !== "polling") {
      throw new Error(`unknown child mode: ${mode}`);
    }
    const identity = createSyntheticOriginal(
      mediaRoot,
      mode === "polling" ? 1024 * 1024 : FILE_SIZE,
    );
    let pollCount = 0;
    const measuredNative = Object.create(native) as NativeBinding;
    Object.defineProperty(measuredNative, "pollOriginalDownload", {
      value(handle: object) {
        pollCount += 1;
        return native.pollOriginalDownload(handle);
      },
    });
    reader = OriginalReader.open(
      {
        mediaRoot,
        expectedMarkerId: writer.markerId,
      },
      measuredNative as never,
    );
    if (mode === "abandoned") {
      const rawReader = native.openOriginalReader(mediaRoot, writer.markerId);
      const before = native.originalDownloadTestDiagnostics();
      let started: object | null = native.startVerifiedOriginalDownload(
        rawReader.handle,
        identity.familyId,
        identity.sha256Hex,
        identity.byteSize,
      );
      for (;;) {
        const result = native.pollOriginalDownload(started);
        if (result !== null) break;
        await setImmediatePromise();
      }
      started = null;
      native.closeOriginalReader(rawReader.handle);
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        global.gc();
        await setImmediatePromise();
        const after = native.originalDownloadTestDiagnostics();
        if (
          BigInt(after.closeCount) - BigInt(before.closeCount) === 1n &&
          after.activeWork === "0"
        ) {
          process.stdout.write("abandoned-cleanup-ok\n");
          return;
        }
      }
      throw new Error("abandoned native capability was not finalized");
    }
    if (mode === "polling") {
      native.originalDownloadTestBarrier("ARM_VERIFY");
      const operation = reader.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        async () => undefined,
      );
      void operation.catch(() => undefined);
      await waitForBarrierWithGc();

      let heartbeats = 0;
      const heartbeat = setInterval(() => {
        heartbeats += 1;
      }, 10);
      const pollsBefore = pollCount;
      const cpuBefore = process.cpuUsage();
      const eluBefore = performance.eventLoopUtilization();
      const holdStarted = performance.now();
      await delay(1_500);
      const holdMs = performance.now() - holdStarted;
      const cpu = process.cpuUsage(cpuBefore);
      const elu = performance.eventLoopUtilization(eluBefore).utilization;
      const pollsDuringHold = pollCount - pollsBefore;
      clearInterval(heartbeat);

      native.originalDownloadTestBarrier("RELEASE");
      await operation;
      const pollsAtSettlement = pollCount;
      await delay(50);
      process.stdout.write(
        `${JSON.stringify({
          holdMs,
          pollsDuringHold,
          cpuMs: (cpu.user + cpu.system) / 1_000,
          elu,
          heartbeats,
          pollsAfterSettlement: pollCount - pollsAtSettlement,
        })}\n`,
      );
      return;
    }

    global.gc();
    const rssBefore = process.memoryUsage().rss;
    let rssPeak = rssBefore;
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
      heartbeats += 1;
      if (heartbeats % 8 === 0) global.gc?.();
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }, 1);
    const receivedHash = createHash("sha256");
    let total = 0;
    let maxChunk = 0;
    native.originalDownloadTestBarrier("ARM_VERIFY");
    const operationStarted = performance.now();
    const operation = reader.withVerifiedDownload(
      identity,
      { signal: new AbortController().signal },
      async (download) => {
        native.originalDownloadTestBarrier("ARM_READ");
        const first = download.readNext();
        await waitForBarrierWithGc();
        native.originalDownloadTestBarrier("RELEASE");
        let next = await first;
        for (;;) {
          if (next.done) break;
          total += next.bytes.length;
          maxChunk = Math.max(maxChunk, next.bytes.length);
          receivedHash.update(next.bytes);
          if (next.final) break;
          next = await download.readNext();
        }
      },
    );
    await waitForBarrierWithGc();
    native.originalDownloadTestBarrier("RELEASE");
    await operation;
    clearInterval(heartbeat);
    const diagnostics = native.originalDownloadTestDiagnostics();
    if (
      total !== FILE_SIZE ||
      receivedHash.digest("hex") !== identity.sha256Hex
    )
      throw new Error("streamed bytes did not match synthetic original");
    process.stdout.write(
      `${JSON.stringify({
        total,
        maxChunk,
        heartbeats,
        rssGrowth: rssPeak - rssBefore,
        maxActiveWork: Number(diagnostics.maxActiveWork),
        maxReadBuffer: Number(diagnostics.maxReadBuffer),
        wallMs: performance.now() - operationStarted,
      })}\n`,
    );
  } finally {
    native.originalDownloadTestBarrier("RESET");
    reader?.close();
    writer.close();
    rmSync(fixtureBase, { recursive: true, force: true });
  }
}

function createSyntheticOriginal(mediaRoot: string, fileSize: number) {
  const chunk = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < chunk.length; index += 1)
    chunk[index] = index % 251;
  const digest = createHash("sha256");
  const temporary = join(mediaRoot, "synthetic-large.tmp");
  const fd = openSync(temporary, "wx", 0o600);
  try {
    for (let offset = 0; offset < fileSize; offset += chunk.length) {
      const length = Math.min(chunk.length, fileSize - offset);
      digest.update(chunk.subarray(0, length));
      let written = 0;
      while (written < length)
        written += writeSync(fd, chunk, written, length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const sha256Hex = digest.digest("hex");
  const parent = join(
    mediaRoot,
    "originals",
    "1",
    sha256Hex.slice(0, 2),
    sha256Hex.slice(2, 4),
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(temporary, 0o400);
  renameSync(temporary, join(parent, `${sha256Hex}-${fileSize}`));
  return { familyId: "1", sha256Hex, byteSize: String(fileSize) };
}

async function waitForBarrierWithGc() {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    global.gc?.();
    if (native.originalDownloadTestDiagnostics().barrierReached) return;
    await setImmediatePromise();
  }
  throw new Error("native test barrier timeout");
}

await main();
