import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OriginalReader,
  runApprovedOriginalProbe,
  runSyntheticRendererStartupProbe,
  StorageRoot,
  StorageSafetyError,
} from "./index.js";

const UPLOAD_ID = "d".repeat(32);

describe("Phase 4D0 OriginalReader", () => {
  let fixtureBase: string;
  let mediaRoot: string;
  let writer: StorageRoot | undefined;
  let reader: OriginalReader | undefined;
  let identity: { familyId: string; sha256Hex: string; byteSize: string };
  let originalPath: string;

  beforeEach(() => {
    fixtureBase = mkdtempSync(join(realpathSync(tmpdir()), "phase4d0-reader-"));
    mediaRoot = join(fixtureBase, "media");
    writer = StorageRoot.open(mediaRoot, { initialize: true });
    const bytes = Buffer.from("phase 4d0 immutable synthetic original");
    const sha256Hex = createHash("sha256").update(bytes).digest("hex");
    identity = { familyId: "1", sha256Hex, byteSize: String(bytes.length) };
    writer.createUploadPayload("1", UPLOAD_ID, bytes);
    originalPath = join(
      mediaRoot,
      writer.publishOriginal({ ...identity, uploadId: UPLOAD_ID }).relativePath,
    );
  });

  afterEach(() => {
    reader?.close();
    writer?.close();
    expect(relative(realpathSync(tmpdir()), fixtureBase)).toMatch(
      /^phase4d0-reader-[^/]+$/u,
    );
    rmSync(fixtureBase, { recursive: true, force: true });
  });

  it("coexists with the writer lock and does not create or modify layout", async () => {
    const lockBefore = lstatSync(join(mediaRoot, ".writer.lock"));
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: writer!.markerId,
    });
    const before = snapshot(originalPath);
    await reader.withVerifiedOriginal(identity, async (handle) => {
      expect(handle.consumed).toBe(false);
    });
    expect(snapshot(originalPath)).toEqual(before);
    expect(lstatSync(join(mediaRoot, ".writer.lock")).ino).toBe(lockBefore.ino);
    expect(existsSync(join(mediaRoot, "staging"))).toBe(false);
  });

  it("passes a verified synthetic original into the fixed D3a-0 startup harness", async () => {
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: writer!.markerId,
    });
    const before = snapshot(originalPath);
    await reader.withVerifiedOriginal(identity, async (handle) => {
      await runSyntheticRendererStartupProbe(handle);
      expect(handle.consumed).toBe(true);
    });
    expect(snapshot(originalPath)).toEqual(before);
  });

  it("fails closed for missing roots and wrong markers without initializing anything", () => {
    const missing = join(fixtureBase, "missing");
    expect(() =>
      OriginalReader.open({
        mediaRoot: missing,
        expectedMarkerId: writer!.markerId,
      }),
    ).toThrow(StorageSafetyError);
    expect(existsSync(missing)).toBe(false);
    expect(() =>
      OriginalReader.open({
        mediaRoot,
        expectedMarkerId: "f".repeat(32),
      }),
    ).toThrow(StorageSafetyError);
  });

  it("rejects wrong family, hash, size, traversal and root replacement", async () => {
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: writer!.markerId,
    });
    for (const wrong of [
      { ...identity, familyId: "2" },
      { ...identity, sha256Hex: "a".repeat(64) },
      { ...identity, byteSize: String(Number(identity.byteSize) + 1) },
    ]) {
      await expect(
        reader.withVerifiedOriginal(wrong, async () => true),
      ).rejects.toThrow(StorageSafetyError);
    }
    await expect(
      reader.withVerifiedOriginal(
        { ...identity, familyId: "../1" },
        async () => true,
      ),
    ).rejects.toThrow(/FAMILY_ID_INVALID/u);
    const detached = join(fixtureBase, "detached");
    renameSync(mediaRoot, detached);
    mkdirSync(mediaRoot, { mode: 0o700 });
    await expect(
      reader.withVerifiedOriginal(identity, async () => true),
    ).rejects.toThrow(StorageSafetyError);
  });

  it("rejects symlink components, hard links, FIFO files, wrong mode and extended ACL", async () => {
    const marker = writer!.markerId;
    writer!.close();
    writer = undefined;
    const familyDirectory = join(mediaRoot, "originals", "1");
    const savedFamily = join(fixtureBase, "saved-family");
    renameSync(familyDirectory, savedFamily);
    symlinkSync(savedFamily, familyDirectory, "dir");
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: marker,
    });
    await expect(
      reader.withVerifiedOriginal(identity, async () => true),
    ).rejects.toThrow(StorageSafetyError);
    reader.close();
    reader = undefined;
    rmSync(familyDirectory);
    renameSync(savedFamily, familyDirectory);

    linkSync(originalPath, join(fixtureBase, "unexpected-link"));
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: marker,
    });
    await expect(
      reader.withVerifiedOriginal(identity, async () => true),
    ).rejects.toThrow(StorageSafetyError);
    reader.close();
    reader = undefined;
    rmSync(join(fixtureBase, "unexpected-link"));

    chmodSync(originalPath, 0o600);
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: marker,
    });
    await expect(
      reader.withVerifiedOriginal(identity, async () => true),
    ).rejects.toThrow(StorageSafetyError);
    reader.close();
    reader = undefined;
    chmodSync(originalPath, 0o400);

    execFileSync("chmod", ["+a", "everyone allow read", originalPath]);
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: marker,
    });
    await expect(
      reader.withVerifiedOriginal(identity, async () => true),
    ).rejects.toThrow(StorageSafetyError);
    reader.close();
    reader = undefined;
    execFileSync("chmod", ["-N", originalPath]);

    rmSync(originalPath);
    execFileSync("mkfifo", [originalPath]);
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: marker,
    });
    await expect(
      reader.withVerifiedOriginal(identity, async () => true),
    ).rejects.toThrow(StorageSafetyError);
  });

  it("makes an opaque handle single-use and rejects concurrent handoff", async () => {
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: writer!.markerId,
    });
    await reader.withVerifiedOriginal(identity, async (handle) => {
      handle.close();
      expect(handle.consumed).toBe(true);
      await expect(
        runApprovedOriginalProbe(handle, "capabilities"),
      ).rejects.toThrow(/ORIGINAL_HANDLE/u);
    });
    await reader.withVerifiedOriginal(identity, async (handle) => {
      const first = runApprovedOriginalProbe(handle, "invalid-json");
      const second = runApprovedOriginalProbe(handle, "invalid-json");
      await expect(second).rejects.toThrow(/ORIGINAL_HANDLE/u);
      await expect(first).rejects.toThrow(/PROBE_/u);
    });
  });

  it("rejects a forged handle and a named-original replacement before handoff", async () => {
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: writer!.markerId,
    });
    await expect(
      runApprovedOriginalProbe({ consumed: false, close() {} }, "capabilities"),
    ).rejects.toThrow(/ORIGINAL_HANDLE_INVALID/u);

    const detached = `${originalPath}.detached`;
    await reader.withVerifiedOriginal(identity, async (handle) => {
      const bytes = readFileSync(originalPath);
      renameSync(originalPath, detached);
      try {
        writeFileSync(originalPath, bytes, { mode: 0o400 });
        await expect(
          runApprovedOriginalProbe(handle, "capabilities"),
        ).rejects.toThrow(/ORIGINAL_HANDOFF_FAILED/u);
      } finally {
        rmSync(originalPath, { force: true });
        renameSync(detached, originalPath);
      }
    });
  });
});

function snapshot(path: string) {
  const stats = lstatSync(path, { bigint: true });
  return {
    bytes: readFileSync(path),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    ino: stats.ino,
    mode: stats.mode & 0o777n,
    mtimeNs: stats.mtimeNs,
  };
}
