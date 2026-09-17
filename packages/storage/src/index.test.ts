import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildOriginalPath,
  buildUploadPayloadPath,
  probeStorageCapability,
  StorageRoot,
  StorageSafetyError,
} from "./index.js";

const FIRST_UPLOAD = "1".repeat(32);
const SECOND_UPLOAD = "2".repeat(32);

describe("Phase 3A native storage capability", () => {
  let fixtureBase: string;
  let mediaRoot: string;
  let root: StorageRoot | undefined;

  beforeEach(() => {
    expect(process.platform).toBe("darwin");
    fixtureBase = mkdtempSync(
      join(realpathSync(tmpdir()), "family-album-phase3a-"),
    );
    mediaRoot = join(fixtureBase, "media-root");
  });

  afterEach(() => {
    root?.close();
    root = undefined;
    const canonicalTemp = realpathSync(tmpdir());
    expect(relative(canonicalTemp, fixtureBase)).toMatch(
      /^family-album-phase3a-[^/]+$/u,
    );
    rmSync(fixtureBase, { recursive: true, force: true });
  });

  it("safely initializes a canonical root and reports READ_WRITE", () => {
    const capability = probeStorageCapability({
      mediaRoot,
      initialize: true,
    });
    expect(capability.state).toBe("READ_WRITE");
    if (capability.state !== "READ_WRITE") return;
    root = capability.root;
    expect(root.canonicalPath).toBe(mediaRoot);
    expect(root.markerId).toMatch(/^[0-9a-f]{32}$/u);
    expect(root.verifySameFilesystem()).toBe(true);
    for (const name of ["originals", "uploads", "temp"]) {
      expect(lstatSync(join(mediaRoot, name)).isDirectory()).toBe(true);
    }
  });

  it("fails closed for missing, non-canonical, symlinked and marker-mismatched roots", () => {
    expect(probeStorageCapability({ mediaRoot, initialize: false }).state).toBe(
      "UNAVAILABLE",
    );

    root = StorageRoot.open(mediaRoot, { initialize: true });
    const marker = root.markerId;
    root.close();
    root = undefined;

    expect(
      probeStorageCapability({
        mediaRoot,
        initialize: false,
        expectedMarkerId: "f".repeat(32),
      }).state,
    ).toBe("UNAVAILABLE");
    root = StorageRoot.open(mediaRoot, {
      initialize: false,
      expectedMarkerId: marker,
    });
    root.close();
    root = undefined;

    const target = join(fixtureBase, "target");
    mkdirSync(target, { mode: 0o700 });
    const link = join(fixtureBase, "media-link");
    symlinkSync(target, link, "dir");
    expect(
      probeStorageCapability({ mediaRoot: link, initialize: false }).state,
    ).toBe("UNAVAILABLE");
  });

  it("holds a process-level writer lock", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    expect(() => StorageRoot.open(mediaRoot, { initialize: false })).toThrow(
      StorageSafetyError,
    );
  });

  it("reports a known valid root as READ_ONLY under explicit maintenance policy", () => {
    const capability = probeStorageCapability({
      mediaRoot,
      initialize: true,
      readOnlyReason: "MAINTENANCE",
    });
    expect(capability.state).toBe("READ_ONLY");
    if (capability.state !== "READ_ONLY") return;
    root = capability.root;
    expect(capability.reason).toBe("MAINTENANCE");
    expect(root.assertIdentity()).toBeUndefined();
  });

  it("scans only fixed dirfds without following a symlink and rejects root replacement", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    root.createUploadPayload("1", FIRST_UPLOAD, Buffer.from("synthetic"));
    const uploadDirectory = join(mediaRoot, "uploads", "1", FIRST_UPLOAD);
    symlinkSync(fixtureBase, join(uploadDirectory, "unexpected"), "dir");
    expect(root.listControlledDirectory(`uploads/1/${FIRST_UPLOAD}`)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "payload",
          kind: "file",
          mode: 0o600,
          nlink: 1n,
        }),
        expect.objectContaining({ name: "unexpected", kind: "symlink" }),
      ]),
    );
    expect(() => root!.listControlledDirectory("../outside")).toThrow(
      /SCAN_PATH_INVALID/u,
    );
    const moved = join(fixtureBase, "detached-root");
    renameSync(mediaRoot, moved);
    mkdirSync(mediaRoot, { mode: 0o700 });
    expect(() => root!.assertIdentity()).toThrow(/MEDIA_ROOT_REPLACED/u);
    expect(() => root!.createUploadPayload("1", SECOND_UPLOAD)).toThrow(
      /MEDIA_ROOT_REPLACED/u,
    );
    expect(existsSync(join(mediaRoot, "uploads"))).toBe(false);
  });

  it("pages 1,250 real controlled directories with bounded memory and detects a changed generation", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    root.createUploadPayload("1", FIRST_UPLOAD);
    const parent = join(mediaRoot, "uploads", "1");
    const expected = Array.from({ length: 1_250 }, (_, index) =>
      (index + 1).toString(16).padStart(32, "0"),
    );
    for (const name of expected) mkdirSync(join(parent, name), { mode: 0o700 });
    const seen: string[] = [];
    let cursor = "";
    let generation = "";
    let more = true;
    while (more) {
      const page = root.listControlledDirectoryPage(
        `uploads/1`,
        cursor,
        128,
        generation,
      );
      expect(page.entries.length).toBeLessThanOrEqual(128);
      seen.push(...page.entries.map((entry) => entry.name));
      generation = page.generation;
      cursor = page.nextCursor;
      more = page.hasMore;
    }
    expect(seen).toEqual([...expected, FIRST_UPLOAD].sort());
    expect(new Set(seen).size).toBe(1_251);
    mkdirSync(join(parent, "f".repeat(32)), { mode: 0o700 });
    expect(() =>
      root!.listControlledDirectoryPage(`uploads/1`, cursor, 128, generation),
    ).toThrow(/SCAN_FAILED/u);
  });

  it("rejects a second writer in a separate process", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    const bindingPath = resolve(
      import.meta.dirname,
      "../build/storage_native.node",
    );
    const child = execFileSync(
      process.execPath,
      [
        "-e",
        `const native = require(process.argv[1]);
try {
  native.openRoot(process.argv[2], false);
  process.exit(2);
} catch (error) {
  process.exit(error instanceof Error && error.message.includes("acquire storage writer lock") ? 0 : 3);
}`,
        bindingPath,
        mediaRoot,
      ],
      { encoding: "utf8" },
    );
    expect(child).toBe("");
  });

  it("fails closed when the root has an extended ACL", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    root.close();
    root = undefined;
    execFileSync("chmod", ["+a", "everyone allow write", mediaRoot]);
    expect(probeStorageCapability({ mediaRoot, initialize: false }).state).toBe(
      "UNAVAILABLE",
    );
  });

  it("creates files exclusively and never truncates an existing file", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    const first = Buffer.from("first synthetic bytes");
    const second = Buffer.from("different synthetic bytes");
    const relativePath = root.createUploadPayload("1", FIRST_UPLOAD, first);
    const absolutePath = join(mediaRoot, relativePath);
    const before = digest(readFileSync(absolutePath));
    expect(() => root?.createUploadPayload("1", FIRST_UPLOAD, second)).toThrow(
      /EXCLUSIVE_CREATE_FAILED:STORAGE_ALREADY_EXISTS/u,
    );
    expect(digest(readFileSync(absolutePath))).toBe(before);
    expect(readFileSync(absolutePath)).toEqual(first);
  });

  it("removes an exact prepared 0400 staging file but never a changed-mode scratch", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    const staging = join(
      mediaRoot,
      root.createUploadPayload("1", FIRST_UPLOAD, Buffer.from("synthetic")),
    );
    chmodSync(staging, 0o400);
    root.removeUploadPayload("1", FIRST_UPLOAD);
    expect(existsSync(staging)).toBe(false);
    root.createChunkScratch(
      FIRST_UPLOAD,
      SECOND_UPLOAD,
      Buffer.from("scratch"),
    );
    const scratch = join(
      mediaRoot,
      "temp",
      "chunks",
      FIRST_UPLOAD,
      SECOND_UPLOAD,
    );
    chmodSync(scratch, 0o400);
    expect(() => root!.removeChunkScratch(FIRST_UPLOAD, SECOND_UPLOAD)).toThrow(
      /SCRATCH_REMOVE_FAILED/u,
    );
    expect(existsSync(scratch)).toBe(true);
  });

  it("durably commits a positioned scratch chunk and supports exact cleanup", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    const activeRoot = root;
    activeRoot.createUploadPayload("1", FIRST_UPLOAD);
    const firstRequest = "a".repeat(32);
    const secondRequest = "b".repeat(32);
    activeRoot.createChunkScratch(
      FIRST_UPLOAD,
      firstRequest,
      Buffer.from("first"),
    );
    expect(
      activeRoot.commitChunk({
        familyId: "1",
        uploadId: FIRST_UPLOAD,
        requestId: firstRequest,
        expectedOffset: 0n,
        declaredSize: 10n,
      }),
    ).toBe(5n);
    expect(activeRoot.inspectUploadPayload("1", FIRST_UPLOAD)).toBe(5n);
    activeRoot.removeChunkScratch(FIRST_UPLOAD, firstRequest);

    activeRoot.createChunkScratch(
      FIRST_UPLOAD,
      secondRequest,
      Buffer.from("tail"),
    );
    expect(() =>
      activeRoot.commitChunk({
        familyId: "1",
        uploadId: FIRST_UPLOAD,
        requestId: secondRequest,
        expectedOffset: 4n,
        declaredSize: 10n,
      }),
    ).toThrow(StorageSafetyError);
    expect(activeRoot.inspectUploadPayload("1", FIRST_UPLOAD)).toBe(5n);
    activeRoot.removeChunkScratch(FIRST_UPLOAD, secondRequest);

    activeRoot.truncateUploadPayload("1", FIRST_UPLOAD, 3n);
    expect(activeRoot.inspectUploadPayload("1", FIRST_UPLOAD)).toBe(3n);
    activeRoot.removeUploadPayload("1", FIRST_UPLOAD);
    expect(() => activeRoot.inspectUploadPayload("1", FIRST_UPLOAD)).toThrow(
      /STORAGE_NOT_FOUND/u,
    );
  });

  it("hashes a stable staging fd and fully verifies an immutable published original", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    const bytes = Buffer.from("phase3d synthetic original bytes");
    const digest = createHash("sha256").update(bytes).digest();
    root.createUploadPayload("1", FIRST_UPLOAD, bytes);
    expect(root.hashUploadPayload("1", FIRST_UPLOAD)).toEqual({
      sha256: digest,
      byteSize: BigInt(bytes.length),
    });
    const published = root.publishOriginal({
      familyId: "1",
      uploadId: FIRST_UPLOAD,
      sha256Hex: digest.toString("hex"),
      byteSize: String(bytes.length),
    });
    expect(published.fullSynced).toBe(true);
    expect(
      root.verifyOriginal("1", digest.toString("hex"), String(bytes.length)),
    ).toEqual({ sha256: digest, byteSize: BigInt(bytes.length) });
    expect(() =>
      root?.verifyOriginal("1", "0".repeat(64), String(bytes.length)),
    ).toThrow(StorageSafetyError);
  });

  it("keeps canonical keys distinct by family and byte size even for the same digest", () => {
    const sha = "a".repeat(64);
    const first = buildOriginalPath("1", sha, "100");
    expect(buildOriginalPath("1", sha, "101")).not.toBe(first);
    expect(buildOriginalPath("2", sha, "100")).not.toBe(first);
    expect(first).not.toContain(FIRST_UPLOAD);
  });

  it("allows exactly one real native winner in a concurrent O_EXCL create", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    const first = Buffer.from("winner one");
    const second = Buffer.from("winner two");
    const result = root.probeConcurrentExclusiveCreate({
      familyId: "1",
      uploadId: FIRST_UPLOAD,
      firstContents: first,
      secondContents: second,
    });
    expect(result).toEqual({ successes: 1, alreadyExists: 1 });
    const stored = readFileSync(
      join(mediaRoot, buildUploadPayloadPath("1", FIRST_UPLOAD)),
    );
    expect([first.toString(), second.toString()]).toContain(stored.toString());
  });

  it("rejects staging and destination symlink escapes", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    const outside = join(fixtureBase, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(mediaRoot, "uploads", "1"), "dir");
    expect(() =>
      root?.createUploadPayload("1", FIRST_UPLOAD, Buffer.from("blocked")),
    ).toThrow(StorageSafetyError);
    expect(existsSync(join(outside, FIRST_UPLOAD))).toBe(false);

    rmSync(join(mediaRoot, "uploads", "1"));
    root.createUploadPayload("1", FIRST_UPLOAD, Buffer.from("source"));
    symlinkSync(outside, join(mediaRoot, "originals", "1"), "dir");
    const hash = digest(Buffer.from("source"));
    expect(() =>
      root?.publishOriginal({
        familyId: "1",
        uploadId: FIRST_UPLOAD,
        sha256Hex: hash,
        byteSize: "6",
      }),
    ).toThrow(StorageSafetyError);
    expect(existsSync(join(outside, hash.slice(0, 2)))).toBe(false);
  });

  it("rejects a payload replaced with a symlink without touching its target", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    root.createUploadPayload("1", FIRST_UPLOAD, Buffer.from("replace me"));
    const payload = join(mediaRoot, buildUploadPayloadPath("1", FIRST_UPLOAD));
    const outside = join(fixtureBase, "outside-file");
    writeFileSync(outside, "outside unchanged", { mode: 0o600 });
    rmSync(payload);
    symlinkSync(outside, payload);
    const before = digest(readFileSync(outside));
    expect(() =>
      root?.publishOriginal({
        familyId: "1",
        uploadId: FIRST_UPLOAD,
        sha256Hex: "a".repeat(64),
        byteSize: "10",
      }),
    ).toThrow(StorageSafetyError);
    expect(digest(readFileSync(outside))).toBe(before);
  });

  it("rejects unexpected hard links and pre-existing FIFO destinations", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    const firstBytes = Buffer.from("hard-link source");
    root.createUploadPayload("1", FIRST_UPLOAD, firstBytes);
    const firstPayload = join(
      mediaRoot,
      buildUploadPayloadPath("1", FIRST_UPLOAD),
    );
    linkSync(firstPayload, join(fixtureBase, "unexpected-hard-link"));
    expect(() =>
      root?.publishOriginal({
        familyId: "1",
        uploadId: FIRST_UPLOAD,
        sha256Hex: digest(firstBytes),
        byteSize: String(firstBytes.length),
      }),
    ).toThrow(StorageSafetyError);

    const secondBytes = Buffer.from("fifo destination source");
    const secondHash = digest(secondBytes);
    root.createUploadPayload("1", SECOND_UPLOAD, secondBytes);
    const fifoRelative = buildOriginalPath(
      "1",
      secondHash,
      String(secondBytes.length),
    );
    const fifoPath = join(mediaRoot, fifoRelative);
    mkdirSync(join(fifoPath, ".."), { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", [fifoPath]);
    expect(() =>
      root?.publishOriginal({
        familyId: "1",
        uploadId: SECOND_UPLOAD,
        sha256Hex: secondHash,
        byteSize: String(secondBytes.length),
      }),
    ).toThrow(/ORIGINAL_PUBLISH_FAILED:STORAGE_ALREADY_EXISTS/u);
    expect(lstatSync(fifoPath).isFIFO()).toBe(true);
  });

  it("publishes once with sync evidence and preserves immutable bytes", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    const original = Buffer.from("immutable synthetic original");
    const replacement = Buffer.from("different replacement bytes!!");
    const hash = digest(original);
    root.createUploadPayload("1", FIRST_UPLOAD, original);
    const result = root.publishOriginal({
      familyId: "1",
      uploadId: FIRST_UPLOAD,
      sha256Hex: hash,
      byteSize: String(original.length),
    });
    expect(result).toMatchObject({
      byteSize: original.length,
      fileSynced: true,
      sourceDirectorySynced: true,
      destinationDirectorySynced: true,
      fullSynced: true,
    });
    const finalPath = join(mediaRoot, result.relativePath);
    const before = digest(readFileSync(finalPath));
    root.createUploadPayload("1", SECOND_UPLOAD, replacement);
    expect(() =>
      root?.publishOriginal({
        familyId: "1",
        uploadId: SECOND_UPLOAD,
        sha256Hex: hash,
        byteSize: String(original.length),
      }),
    ).toThrow(/ORIGINAL_PUBLISH_FAILED:STORAGE_ALREADY_EXISTS/u);
    expect(digest(readFileSync(finalPath))).toBe(before);
    expect(readFileSync(finalPath)).toEqual(original);
    expect(lstatSync(finalPath).mode & 0o222).toBe(0);
  });

  it("allows exactly one real native winner in concurrent no-clobber publish", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    const bytes = Buffer.from("identical synthetic bytes");
    const hash = digest(bytes);
    root.createUploadPayload("1", FIRST_UPLOAD, bytes);
    root.createUploadPayload("1", SECOND_UPLOAD, bytes);
    const result = root.probeConcurrentExclusivePublish({
      familyId: "1",
      firstUploadId: FIRST_UPLOAD,
      secondUploadId: SECOND_UPLOAD,
      sha256Hex: hash,
      byteSize: String(bytes.length),
    });
    expect(result).toMatchObject({ successes: 1, alreadyExists: 1 });
    expect(readFileSync(join(mediaRoot, result.relativePath))).toEqual(bytes);
  });

  it("rejects an unexpected cross-device layout from the capability contract", () => {
    const native = fakeNative({
      directoryDevice: (_handle: object, path: string) =>
        path === "temp" ? "2" : "1",
    });
    const synthetic = StorageRoot.open(
      "/synthetic/root",
      {
        initialize: false,
      },
      native,
    );
    expect(() => synthetic.verifySameFilesystem()).toThrow(
      /CROSS_DEVICE_LAYOUT/u,
    );
    synthetic.close();
  });

  it("propagates native sync and close failures and never confirms durability", () => {
    const syncFailure = StorageRoot.open(
      "/synthetic/root",
      { initialize: false },
      fakeNative({
        publishOriginal: () => {
          throw Object.assign(new Error("synthetic sync failure"), {
            code: "EIO",
          });
        },
      }),
    );
    expect(() =>
      syncFailure.publishOriginal({
        familyId: "1",
        uploadId: FIRST_UPLOAD,
        sha256Hex: "a".repeat(64),
        byteSize: "1",
      }),
    ).toThrow(/ORIGINAL_PUBLISH_FAILED:EIO/u);

    const missingEvidence = StorageRoot.open(
      "/synthetic/root",
      { initialize: false },
      fakeNative({
        publishOriginal: () => ({
          byteSize: 1,
          fileSynced: true,
          sourceDirectorySynced: false,
          destinationDirectorySynced: true,
          fullSynced: true,
        }),
      }),
    );
    expect(() =>
      missingEvidence.publishOriginal({
        familyId: "1",
        uploadId: FIRST_UPLOAD,
        sha256Hex: "a".repeat(64),
        byteSize: "1",
      }),
    ).toThrow(/DURABILITY_NOT_CONFIRMED/u);

    const closeFailure = StorageRoot.open(
      "/synthetic/root",
      { initialize: false },
      fakeNative({
        closeRoot: () => {
          throw Object.assign(new Error("synthetic close failure"), {
            code: "EIO",
          });
        },
      }),
    );
    expect(() => closeFailure.close()).toThrow(/STORAGE_CLOSE_FAILED:EIO/u);
  });

  it("reports an unavailable and non-writable root without publishing", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    root.close();
    root = undefined;
    chmodSync(mediaRoot, 0o500);
    const capability = probeStorageCapability({
      mediaRoot,
      initialize: false,
    });
    expect(capability.state).toBe("UNAVAILABLE");
    expect(existsSync(join(mediaRoot, "originals", "1"))).toBe(false);
    chmodSync(mediaRoot, 0o700);
  });

  it("keeps a fixed directory handle when a validated parent name is swapped", () => {
    root = StorageRoot.open(mediaRoot, { initialize: true });
    root.createUploadPayload("1", FIRST_UPLOAD, Buffer.from("fixed handle"));
    const familyDirectory = join(mediaRoot, "uploads", "1");
    const movedDirectory = join(mediaRoot, "uploads", "1-moved");
    renameSync(familyDirectory, movedDirectory);
    const outside = join(fixtureBase, "outside-swap");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, familyDirectory, "dir");
    expect(() =>
      root?.createUploadPayload("1", SECOND_UPLOAD, Buffer.from("blocked")),
    ).toThrow(StorageSafetyError);
    expect(existsSync(join(outside, SECOND_UPLOAD))).toBe(false);
    expect(existsSync(join(movedDirectory, FIRST_UPLOAD, "payload"))).toBe(
      true,
    );
  });
});

function digest(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function fakeNative(overrides: Record<string, unknown>) {
  const handle = {};
  return {
    openRoot: () => ({
      handle,
      canonicalPath: "/synthetic/root",
      markerId: "a".repeat(32),
      device: "1",
    }),
    closeRoot: () => undefined,
    ensureDirectory: () => undefined,
    createExclusive: () => undefined,
    raceExclusiveCreate: () => ({ successes: 1, alreadyExists: 1 }),
    publishOriginal: () => ({
      byteSize: 1,
      fileSynced: true,
      sourceDirectorySynced: true,
      destinationDirectorySynced: true,
      fullSynced: true,
    }),
    raceExclusivePublish: () => ({ successes: 1, alreadyExists: 1 }),
    directoryDevice: () => "1",
    verifyRootIdentity: () => "a".repeat(32),
    listDirectory: () => [],
    ...overrides,
  } as never;
}
