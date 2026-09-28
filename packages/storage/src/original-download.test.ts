import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OriginalReader, StorageRoot, StorageSafetyError } from "./index.js";
import { pollWithBoundedBackoff } from "./original-download-polling.js";

type TestBinding = {
  originalDownloadTestBarrier(action: string): void;
  originalDownloadTestFault(action: string): void;
  originalDownloadTestDiagnostics(): {
    openCount: string;
    closeCount: string;
    activeWork: string;
    maxActiveWork: string;
    maxReadBuffer: string;
    liveContexts: string;
    ownedFds: string;
    hashMismatchCount: string;
    sizeMismatchCount: string;
    shortEofCount: string;
    extraByteCount: string;
    finalWithheldCount: string;
    barrierReached: boolean;
  };
};

const require = createRequire(import.meta.url);
const native = require("../build/storage_native_test.node") as TestBinding;
const productionNative = require("../build/storage_native.node") as Record<
  string,
  unknown
>;
const UPLOAD_ID = "e".repeat(32);

describe("Phase 6D1 verified original download", () => {
  let fixtureBase: string;
  let mediaRoot: string;
  let writer: StorageRoot | undefined;
  let reader: OriginalReader | undefined;
  let originalPath: string;
  let bytes: Buffer;
  let identity: { familyId: string; sha256Hex: string; byteSize: string };

  beforeEach(() => {
    native.originalDownloadTestBarrier("RESET");
    native.originalDownloadTestFault("RESET");
    fixtureBase = mkdtempSync(join(realpathSync(tmpdir()), "phase6d1-read-"));
    mediaRoot = join(fixtureBase, "media");
    writer = StorageRoot.open(mediaRoot, { initialize: true });
    bytes = Buffer.alloc(600 * 1024 + 17);
    for (let offset = 0; offset < bytes.length; offset += 1) {
      bytes[offset] = offset % 251;
    }
    identity = {
      familyId: "1",
      sha256Hex: createHash("sha256").update(bytes).digest("hex"),
      byteSize: String(bytes.length),
    };
    writer.createUploadPayload("1", UPLOAD_ID, bytes);
    const published = writer.publishOriginal({
      ...identity,
      uploadId: UPLOAD_ID,
    });
    originalPath = join(mediaRoot, published.relativePath);
    reader = OriginalReader.open(
      {
        mediaRoot,
        expectedMarkerId: writer.markerId,
      },
      native as never,
    );
  });

  afterEach(() => {
    native.originalDownloadTestBarrier("RESET");
    native.originalDownloadTestFault("RESET");
    reader?.close();
    writer?.close();
    expect(relative(realpathSync(tmpdir()), fixtureBase)).toMatch(
      /^phase6d1-read-[^/]+$/u,
    );
    rmSync(fixtureBase, { recursive: true, force: true });
  });

  it("does not compile test controls into the production addon", () => {
    expect(productionNative.originalDownloadTestBarrier).toBeUndefined();
    expect(productionNative.originalDownloadTestFault).toBeUndefined();
    expect(productionNative.originalDownloadTestDiagnostics).toBeUndefined();
  });

  it("uses one bounded poll chain with fresh backoff for every operation", async () => {
    const immediateDelays: Array<"immediate" | number> = [];
    await expect(
      pollWithBoundedBackoff(
        () => "complete",
        async (delay) => {
          immediateDelays.push(delay);
        },
      ),
    ).resolves.toBe("complete");
    expect(immediateDelays).toEqual([]);

    const fastDelays: Array<"immediate" | number> = [];
    let fastChecks = 0;
    await expect(
      pollWithBoundedBackoff(
        () => (++fastChecks > 1 ? "complete" : null),
        async (delay) => {
          fastDelays.push(delay);
        },
      ),
    ).resolves.toBe("complete");
    expect(fastDelays).toEqual(["immediate"]);

    const runs: Array<Array<"immediate" | number>> = [];
    for (let run = 0; run < 2; run += 1) {
      const delays: Array<"immediate" | number> = [];
      let checks = 0;
      let scheduled = 0;
      let maximumScheduled = 0;
      const result = await pollWithBoundedBackoff(
        () => (++checks > 8 ? "complete" : null),
        async (delay) => {
          scheduled += 1;
          maximumScheduled = Math.max(maximumScheduled, scheduled);
          delays.push(delay);
          await Promise.resolve();
          scheduled -= 1;
        },
      );
      expect(result).toBe("complete");
      expect(maximumScheduled).toBe(1);
      runs.push(delays);
    }
    expect(runs).toEqual([
      ["immediate", 1, 2, 4, 8, 16, 16, 16],
      ["immediate", 1, 2, 4, 8, 16, 16, 16],
    ]);
  });

  it("verifies before callback and returns one bounded sequential chunk at a time", async () => {
    const diagnosticsBefore = native.originalDownloadTestDiagnostics();
    const before = snapshot(originalPath);
    const received: Buffer[] = [];
    const controller = new AbortController();
    await reader!.withVerifiedDownload(
      identity,
      { signal: controller.signal },
      async (download) => {
        for (;;) {
          const next = await download.readNext();
          if (next.done) break;
          expect(next.bytes.length).toBeLessThanOrEqual(256 * 1024);
          received.push(next.bytes);
          if (next.final) {
            expect((await download.readNext()).done).toBe(true);
          }
        }
      },
    );
    expect(Buffer.concat(received)).toEqual(bytes);
    expect(snapshot(originalPath)).toEqual(before);
    const diagnosticsAfter = native.originalDownloadTestDiagnostics();
    expect(
      BigInt(diagnosticsAfter.openCount) - BigInt(diagnosticsBefore.openCount),
    ).toBe(1n);
    expect(
      BigInt(diagnosticsAfter.closeCount) -
        BigInt(diagnosticsBefore.closeCount),
    ).toBe(1n);
    expect(BigInt(diagnosticsAfter.maxReadBuffer)).toBeLessThanOrEqual(
      256n * 1024n,
    );
  });

  it("opens and rejects a real same-size SHA mismatch", async () => {
    chmodSync(originalPath, 0o600);
    writeFileSync(originalPath, Buffer.alloc(bytes.length, 7));
    chmodSync(originalPath, 0o400);
    const callback = vi.fn();
    const before = native.originalDownloadTestDiagnostics();
    await expect(
      reader!.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        callback,
      ),
    ).rejects.toThrow(StorageSafetyError);
    const after = native.originalDownloadTestDiagnostics();
    expect(callback).not.toHaveBeenCalled();
    expect(BigInt(after.openCount) - BigInt(before.openCount)).toBe(1n);
    expect(BigInt(after.closeCount) - BigInt(before.closeCount)).toBe(1n);
    expect(
      BigInt(after.hashMismatchCount) - BigInt(before.hashMismatchCount),
    ).toBe(1n);
  });

  it("opens and rejects a real size mismatch at the expected CAS name", async () => {
    chmodSync(originalPath, 0o600);
    writeFileSync(originalPath, Buffer.concat([bytes, Buffer.from("x")]));
    chmodSync(originalPath, 0o400);
    const callback = vi.fn();
    const before = native.originalDownloadTestDiagnostics();
    await expect(
      reader!.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        callback,
      ),
    ).rejects.toThrow(StorageSafetyError);
    const after = native.originalDownloadTestDiagnostics();
    expect(callback).not.toHaveBeenCalled();
    expect(BigInt(after.openCount) - BigInt(before.openCount)).toBe(1n);
    expect(BigInt(after.closeCount) - BigInt(before.closeCount)).toBe(1n);
    expect(
      BigInt(after.sizeMismatchCount) - BigInt(before.sizeMismatchCount),
    ).toBe(1n);
  });

  it("rejects a concurrent read without scheduling a second native operation", async () => {
    native.originalDownloadTestBarrier("ARM_READ");
    await reader!.withVerifiedDownload(
      identity,
      { signal: new AbortController().signal },
      async (download) => {
        const first = download.readNext();
        await waitForBarrier();
        await expect(download.readNext()).rejects.toThrow(
          /ORIGINAL_DOWNLOAD_BUSY/u,
        );
        expect(native.originalDownloadTestDiagnostics().activeWork).toBe("1");
        native.originalDownloadTestBarrier("RELEASE");
        await first;
      },
    );
  });

  it("cancels verification and closes only after the active work settles", async () => {
    native.originalDownloadTestBarrier("ARM_VERIFY");
    const before = native.originalDownloadTestDiagnostics();
    const controller = new AbortController();
    const operation = reader!.withVerifiedDownload(
      identity,
      { signal: controller.signal },
      async () => {
        throw new Error("callback must not run");
      },
    );
    void operation.catch(() => undefined);
    await waitForBarrier();
    controller.abort();
    await expect(operation).rejects.toThrow(StorageSafetyError);
    const after = native.originalDownloadTestDiagnostics();
    expect(after.activeWork).toBe("0");
    expect(BigInt(after.openCount) - BigInt(before.openCount)).toBe(1n);
    expect(BigInt(after.closeCount) - BigInt(before.closeCount)).toBe(1n);
  });

  it("owns independent directory resources after OriginalReader closes", async () => {
    native.originalDownloadTestBarrier("ARM_VERIFY");
    const operation = reader!.withVerifiedDownload(
      identity,
      { signal: new AbortController().signal },
      async (download) => {
        const first = await download.readNext();
        expect(first.done).toBe(false);
      },
    );
    void operation.catch(() => undefined);
    await waitForBarrier();
    reader!.close();
    reader = undefined;
    native.originalDownloadTestBarrier("RELEASE");
    await expect(operation).resolves.toBeUndefined();
  });

  it("cleans up on early return, callback failure, and repeated cancellation", async () => {
    const before = native.originalDownloadTestDiagnostics();
    await reader!.withVerifiedDownload(
      identity,
      { signal: new AbortController().signal },
      async (download) => {
        await download.cancel();
        await download.cancel();
        await expect(download.readNext()).rejects.toThrow(
          /ORIGINAL_DOWNLOAD_CLOSED/u,
        );
      },
    );
    await reader!.withVerifiedDownload(
      identity,
      { signal: new AbortController().signal },
      async () => undefined,
    );
    await expect(
      reader!.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        async () => {
          throw new Error("synthetic callback failure");
        },
      ),
    ).rejects.toThrow(/synthetic callback failure/u);
    const after = native.originalDownloadTestDiagnostics();
    expect(after.activeWork).toBe("0");
    expect(BigInt(after.openCount) - BigInt(before.openCount)).toBe(3n);
    expect(BigInt(after.closeCount) - BigInt(before.closeCount)).toBe(3n);
  });

  it("detects mutation before a later chunk and never reports final success", async () => {
    await expect(
      reader!.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        async (download) => {
          const first = await download.readNext();
          expect(first).toMatchObject({ done: false, final: false });
          chmodSync(originalPath, 0o600);
          writeFileSync(originalPath, Buffer.concat([bytes, Buffer.from("x")]));
          await download.readNext();
        },
      ),
    ).rejects.toThrow(StorageSafetyError);
  });

  it("hits the exact short-EOF branch after successful verification", async () => {
    const before = native.originalDownloadTestDiagnostics();
    await expect(
      reader!.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        async (download) => {
          const first = await download.readNext();
          expect(first).toMatchObject({ done: false, final: false });
          native.originalDownloadTestFault("SHORT_EOF_ONCE");
          await download.readNext();
        },
      ),
    ).rejects.toThrow(StorageSafetyError);
    const after = native.originalDownloadTestDiagnostics();
    expect(BigInt(after.shortEofCount) - BigInt(before.shortEofCount)).toBe(1n);
    expect(BigInt(after.openCount) - BigInt(before.openCount)).toBe(1n);
    expect(BigInt(after.closeCount) - BigInt(before.closeCount)).toBe(1n);
  });

  it("withholds the final bytes and rejects the exact extra-byte branch", async () => {
    const before = native.originalDownloadTestDiagnostics();
    let finalDelivered = false;
    await expect(
      reader!.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        async (download) => {
          expect(await download.readNext()).toMatchObject({
            done: false,
            final: false,
          });
          expect(await download.readNext()).toMatchObject({
            done: false,
            final: false,
          });
          native.originalDownloadTestBarrier("ARM_FINAL");
          const final = download.readNext().then((result) => {
            finalDelivered = true;
            return result;
          });
          void final.catch(() => undefined);
          await waitForBarrier();
          expect(finalDelivered).toBe(false);
          native.originalDownloadTestFault("EXTRA_BYTE_ONCE");
          native.originalDownloadTestBarrier("RELEASE");
          await final;
        },
      ),
    ).rejects.toThrow(StorageSafetyError);
    const after = native.originalDownloadTestDiagnostics();
    expect(finalDelivered).toBe(false);
    expect(BigInt(after.extraByteCount) - BigInt(before.extraByteCount)).toBe(
      1n,
    );
    expect(
      BigInt(after.finalWithheldCount) - BigInt(before.finalWithheldCount),
    ).toBe(1n);
    expect(BigInt(after.openCount) - BigInt(before.openCount)).toBe(1n);
    expect(BigInt(after.closeCount) - BigInt(before.closeCount)).toBe(1n);
  });

  it("rejects asynchronous originals-directory replacement before final delivery", async () => {
    const before = native.originalDownloadTestDiagnostics();
    const originals = join(mediaRoot, "originals");
    const savedOriginals = join(fixtureBase, "saved-originals");
    let finalDelivered = false;
    await expect(
      reader!.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        async (download) => {
          expect(await download.readNext()).toMatchObject({
            done: false,
            final: false,
          });
          expect(await download.readNext()).toMatchObject({
            done: false,
            final: false,
          });
          native.originalDownloadTestBarrier("ARM_FINAL");
          const final = download.readNext().then((result) => {
            finalDelivered = true;
            return result;
          });
          void final.catch(() => undefined);
          await waitForBarrier();
          expect(finalDelivered).toBe(false);
          renameSync(originals, savedOriginals);
          mkdirSync(originals, { mode: 0o700 });
          native.originalDownloadTestBarrier("RELEASE");
          await final;
        },
      ),
    ).rejects.toThrow(StorageSafetyError);
    const after = native.originalDownloadTestDiagnostics();
    expect(finalDelivered).toBe(false);
    expect(
      BigInt(after.finalWithheldCount) - BigInt(before.finalWithheldCount),
    ).toBe(1n);
    expect(BigInt(after.openCount) - BigInt(before.openCount)).toBe(1n);
    expect(BigInt(after.closeCount) - BigInt(before.closeCount)).toBe(1n);
  });

  it("detects mutation while full verification is paused", async () => {
    native.originalDownloadTestBarrier("ARM_VERIFY");
    const callback = vi.fn();
    const operation = reader!.withVerifiedDownload(
      identity,
      { signal: new AbortController().signal },
      callback,
    );
    void operation.catch(() => undefined);
    await waitForBarrier();
    chmodSync(originalPath, 0o600);
    writeFileSync(originalPath, Buffer.concat([bytes, Buffer.from("x")]));
    native.originalDownloadTestBarrier("RELEASE");
    await expect(operation).rejects.toThrow(StorageSafetyError);
    expect(callback).not.toHaveBeenCalled();
  });

  it("detects marker, root, and intermediate-directory replacement", async () => {
    const marker = join(mediaRoot, ".storage-root");
    const savedMarker = join(fixtureBase, "saved-marker");
    renameSync(marker, savedMarker);
    writeFileSync(marker, readFileSync(savedMarker), { mode: 0o600 });
    await expect(
      reader!.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        async () => undefined,
      ),
    ).rejects.toThrow(StorageSafetyError);

    rmSync(marker);
    renameSync(savedMarker, marker);
    reader!.close();
    reader = OriginalReader.open(
      {
        mediaRoot,
        expectedMarkerId: writer!.markerId,
      },
      native as never,
    );
    const familyDirectory = join(mediaRoot, "originals", "1");
    const savedFamily = join(fixtureBase, "saved-family");
    native.originalDownloadTestBarrier("ARM_VERIFY");
    const operation = reader!.withVerifiedDownload(
      identity,
      { signal: new AbortController().signal },
      async () => undefined,
    );
    void operation.catch(() => undefined);
    await waitForBarrier();
    renameSync(familyDirectory, savedFamily);
    mkdirSync(familyDirectory, { mode: 0o700 });
    native.originalDownloadTestBarrier("RELEASE");
    await expect(operation).rejects.toThrow(StorageSafetyError);

    reader!.close();
    reader = undefined;
    const detachedRoot = join(fixtureBase, "detached-root");
    renameSync(mediaRoot, detachedRoot);
    mkdirSync(mediaRoot, { mode: 0o700 });
    const detachedReader = OriginalReader.open(
      {
        mediaRoot: detachedRoot,
        expectedMarkerId: writer!.markerId,
      },
      native as never,
    );
    renameSync(detachedRoot, join(fixtureBase, "moved-again"));
    mkdirSync(detachedRoot, { mode: 0o700 });
    await expect(
      detachedReader.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        async () => undefined,
      ),
    ).rejects.toThrow(StorageSafetyError);
    detachedReader.close();
  });

  it("rejects symlink, hardlink, FIFO, directory, wrong mode, and ACL originals", async () => {
    async function rejectsCurrentOriginal() {
      const attempt = OriginalReader.open(
        {
          mediaRoot,
          expectedMarkerId: writer!.markerId,
        },
        native as never,
      );
      try {
        await expect(
          attempt.withVerifiedDownload(
            identity,
            { signal: new AbortController().signal },
            async () => undefined,
          ),
        ).rejects.toThrow(StorageSafetyError);
      } finally {
        attempt.close();
      }
    }

    reader!.close();
    reader = undefined;
    const saved = `${originalPath}.saved`;
    renameSync(originalPath, saved);
    symlinkSync(saved, originalPath);
    await rejectsCurrentOriginal();
    rmSync(originalPath);
    renameSync(saved, originalPath);

    const unexpectedLink = join(fixtureBase, "unexpected-link");
    linkSync(originalPath, unexpectedLink);
    await rejectsCurrentOriginal();
    rmSync(unexpectedLink);

    chmodSync(originalPath, 0o600);
    await rejectsCurrentOriginal();
    chmodSync(originalPath, 0o400);

    execFileSync("chmod", ["+a", "everyone allow read", originalPath]);
    await rejectsCurrentOriginal();
    execFileSync("chmod", ["-N", originalPath]);

    renameSync(originalPath, saved);
    execFileSync("mkfifo", [originalPath]);
    await rejectsCurrentOriginal();
    rmSync(originalPath);
    mkdirSync(originalPath, { mode: 0o400 });
    await rejectsCurrentOriginal();
  });

  it("aborts an active read, closes once, and rejects future reads", async () => {
    native.originalDownloadTestBarrier("ARM_READ");
    const before = native.originalDownloadTestDiagnostics();
    const controller = new AbortController();
    await reader!.withVerifiedDownload(
      identity,
      { signal: controller.signal },
      async (download) => {
        const read = download.readNext();
        await waitForBarrier();
        controller.abort();
        await expect(read).rejects.toThrow(StorageSafetyError);
        await expect(download.readNext()).rejects.toThrow(
          /ORIGINAL_DOWNLOAD_CLOSED/u,
        );
      },
    );
    const after = native.originalDownloadTestDiagnostics();
    expect(BigInt(after.openCount) - BigInt(before.openCount)).toBe(1n);
    expect(BigInt(after.closeCount) - BigInt(before.closeCount)).toBe(1n);
  });

  it("does not leak native original handles across success and early-return loops", async () => {
    const descriptorCountBefore = readdirSync("/dev/fd").length;
    const before = native.originalDownloadTestDiagnostics();
    for (let index = 0; index < 100; index += 1) {
      await reader!.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        async (download) => {
          for (;;) {
            const next = await download.readNext();
            if (next.done || next.final) break;
          }
        },
      );
    }
    for (let index = 0; index < 100; index += 1) {
      await reader!.withVerifiedDownload(
        identity,
        { signal: new AbortController().signal },
        async () => undefined,
      );
    }
    const after = native.originalDownloadTestDiagnostics();
    expect(BigInt(after.openCount) - BigInt(before.openCount)).toBe(200n);
    expect(BigInt(after.closeCount) - BigInt(before.closeCount)).toBe(200n);
    expect(after.activeWork).toBe("0");
    expect(readdirSync("/dev/fd").length).toBeLessThanOrEqual(
      descriptorCountBefore + 2,
    );
  }, 30_000);

  async function waitForBarrier() {
    await vi.waitFor(
      () => {
        expect(native.originalDownloadTestDiagnostics().barrierReached).toBe(
          true,
        );
      },
      { timeout: 5_000, interval: 5 },
    );
  }
});

function snapshot(path: string) {
  const stats = lstatSync(path, { bigint: true });
  const contents = readFileSync(path);
  return {
    contents,
    sha256: createHash("sha256").update(contents).digest("hex"),
    inode: stats.ino,
    device: stats.dev,
    mode: stats.mode & 0o777n,
    links: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
  };
}
