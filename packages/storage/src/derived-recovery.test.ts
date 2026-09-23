import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CapacityGate, DerivedStore, StorageRoot } from "./index.js";

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true });
  const segments = path.split("/");
  const rootIndex = segments.findIndex((segment) =>
    segment.startsWith("ps4d3b1r-"),
  );
  const start = rootIndex >= 0 ? rootIndex : segments.length - 1;
  for (let index = start; index < segments.length; index += 1) {
    chmodSync(segments.slice(0, index + 1).join("/"), 0o700);
  }
}

function rootPath() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b1r-"));
  privateDirectory(path);
  privateDirectory(join(path, "derived"));
  return path;
}

describe("derived publish recovery filesystem", () => {
  it("cleans one exact open temp and refuses a changed inode, mode, symlink, or final", async () => {
    const media = rootPath();
    const part = join(media, "derived", ".tmp", "42", "e5", "thumbnail.part");
    privateDirectory(join(media, "derived", ".tmp", "42", "e5"));
    const bytes = Buffer.from("open-temp");
    writeFileSync(part, bytes);
    chmodSync(part, 0o600);
    const before = lstatSync(part, { bigint: true });
    const sha = createHash("sha256").update(bytes).digest("hex");
    const root = StorageRoot.open(media, { initialize: true });
    root.provisionDerivedWriterLockForDev();
    root.provisionSharedCapacityLockForDev();
    const gate = CapacityGate.open({
      mediaRoot: media,
      expectedMarkerId: root.markerId,
    });
    const store = DerivedStore.open({ state: "READ_WRITE", root });
    try {
      const described = await gate.withLock(async () =>
        gate.describeDerivedTemp("42", 5n, "THUMBNAIL"),
      );
      expect(described).toMatchObject({
        fileClass: "REGULAR",
        mode: 0o600,
        inode: before.ino.toString(),
        sha256Hex: sha,
      });
      expect(() =>
        store.cleanupExactTemp(
          { state: "READ_WRITE", root },
          {
            jobId: "42",
            epoch: 5n,
            kind: "THUMBNAIL",
            byteSize: BigInt(bytes.length),
            device: described.device,
            inode: "1",
            sha256Hex: sha,
            familyId: "7",
            mediaId: "8",
            generation: 3n,
            recipeId: 1,
          },
        ),
      ).toThrow(/DERIVED_RECOVERY_IDENTITY/u);
      expect(readFileSync(part)).toEqual(bytes);
      chmodSync(part, 0o644);
      expect(() =>
        store.cleanupExactTemp(
          { state: "READ_WRITE", root },
          {
            jobId: "42",
            epoch: 5n,
            kind: "THUMBNAIL",
            byteSize: BigInt(bytes.length),
            device: described.device,
            inode: described.inode,
            sha256Hex: sha,
            familyId: "7",
            mediaId: "8",
            generation: 3n,
            recipeId: 1,
          },
        ),
      ).toThrow(/DERIVED_RECOVERY_IDENTITY/u);
      chmodSync(part, 0o600);
      const finalPath = join(
        media,
        "derived",
        "7",
        "8",
        "r1",
        "g3",
        "thumbnail.webp",
      );
      privateDirectory(join(media, "derived", "7", "8", "r1", "g3"));
      writeFileSync(finalPath, bytes);
      chmodSync(finalPath, 0o400);
      expect(() =>
        store.cleanupExactTemp(
          { state: "READ_WRITE", root },
          {
            jobId: "42",
            epoch: 5n,
            kind: "THUMBNAIL",
            byteSize: BigInt(bytes.length),
            device: described.device,
            inode: described.inode,
            sha256Hex: sha,
            familyId: "7",
            mediaId: "8",
            generation: 3n,
            recipeId: 1,
          },
        ),
      ).toThrow(/DERIVED_RECOVERY_FINAL_PRESENT/u);
      expect(readFileSync(finalPath)).toEqual(bytes);
      rmSync(finalPath);
      store.cleanupExactTemp(
        { state: "READ_WRITE", root },
        {
          jobId: "42",
          epoch: 5n,
          kind: "THUMBNAIL",
          byteSize: BigInt(bytes.length),
          device: described.device,
          inode: described.inode,
          sha256Hex: sha,
          familyId: "7",
          mediaId: "8",
          generation: 3n,
          recipeId: 1,
        },
      );
      expect(() => lstatSync(part)).toThrow();
    } finally {
      store.close();
      gate.close();
      root.close();
      rmSync(media, { recursive: true, force: true });
    }
  });

  it("reports a symlink and keeps unknown residue", async () => {
    const media = rootPath();
    const epoch = join(media, "derived", ".tmp", "42", "e5");
    privateDirectory(epoch);
    symlinkSync("/dev/null", join(epoch, "thumbnail.part"));
    writeFileSync(join(epoch, "note.txt"), Buffer.from("unknown"));
    chmodSync(join(epoch, "note.txt"), 0o600);
    const root = StorageRoot.open(media, { initialize: true });
    root.provisionSharedCapacityLockForDev();
    const gate = CapacityGate.open({
      mediaRoot: media,
      expectedMarkerId: root.markerId,
    });
    try {
      const described = await gate.withLock(async () =>
        gate.describeDerivedTemp("42", 5n, "THUMBNAIL"),
      );
      expect(described.fileClass).toBe("SYMLINK");
      await expect(gate.recoveryInventory()).rejects.toThrow(
        /DERIVED_RECOVERY_INCOMPLETE/u,
      );
      expect(readFileSync(join(epoch, "note.txt"))).toEqual(
        Buffer.from("unknown"),
      );
    } finally {
      gate.close();
      root.close();
      rmSync(media, { recursive: true, force: true });
    }
  });
});
