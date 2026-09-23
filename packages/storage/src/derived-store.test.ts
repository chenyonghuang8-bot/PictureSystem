import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  linkSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CapacityGate,
  DerivedStore,
  StorageRoot,
  issueDerivedTempPermitForDev,
  type DerivedTempPermitIdentity,
  type StorageCapability,
} from "./index.js";

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true });
  const segments = path.split("/");
  const rootIndex = segments.findIndex((segment) =>
    segment.startsWith("ps4d3b0-"),
  );
  const start = rootIndex >= 0 ? rootIndex : segments.length - 1;
  for (let index = start; index < segments.length; index += 1) {
    chmodSync(segments.slice(0, index + 1).join("/"), 0o700);
  }
}

function identity(
  kind: "THUMBNAIL" | "PREVIEW" = "THUMBNAIL",
): DerivedTempPermitIdentity {
  return {
    familyId: "7",
    mediaId: "8",
    generation: 3n,
    recipeId: 1,
    kind,
    jobId: "42",
    leaseEpoch: 5n,
    workerId: randomBytes(16),
  };
}

function candidate(
  kind: "THUMBNAIL" | "PREVIEW",
  bytes: Buffer,
  sha256Hex?: string,
) {
  return {
    kind,
    recipe: 1 as const,
    mime: "image/webp" as const,
    width: 1,
    height: 1,
    sha256Hex: sha256Hex ?? createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

function permitFor(
  value: DerivedTempPermitIdentity,
  reservedBytes = 524288n,
  deadline = Date.now() + 60_000,
) {
  return issueDerivedTempPermitForDev(value, "11", reservedBytes, deadline);
}

function leaf(root: string, value: DerivedTempPermitIdentity) {
  const filename =
    value.kind === "THUMBNAIL" ? "thumbnail.part" : "preview.part";
  return join(
    root,
    "derived",
    ".tmp",
    value.jobId,
    `e${value.leaseEpoch.toString()}`,
    filename,
  );
}

async function withStore(
  operation: (input: {
    rootPath: string;
    root: StorageRoot;
    capability: StorageCapability & { state: "READ_WRITE" };
    store: DerivedStore;
  }) => Promise<void>,
) {
  const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
  privateDirectory(rootPath);
  privateDirectory(join(rootPath, "derived"));
  const root = StorageRoot.open(rootPath, { initialize: true });
  let store: DerivedStore | undefined;
  let failure: unknown;
  try {
    root.provisionDerivedWriterLockForDev();
    const capability = {
      state: "READ_WRITE" as const,
      root,
    };
    store = DerivedStore.open(capability);
    await operation({ rootPath, root, capability, store });
  } catch (error) {
    failure = error;
  } finally {
    try {
      store?.close();
    } catch (error) {
      failure ??= error;
    }
    root.close();
    rmSync(rootPath, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}

describe("deterministic derived temp", () => {
  it("rejects fake, cast, expired, consumed, and mismatched permits", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const value = identity();
      const bytes = Buffer.from("synthetic-thumbnail");
      const rendered = candidate("THUMBNAIL", bytes);
      const allow = async () => true;
      await expect(
        store.createOwnedTemp(
          capability,
          {
            consume() {
              return {};
            },
          } as never,
          rendered,
          allow,
        ),
      ).rejects.toThrow(/DERIVED_PERMIT_INVALID/u);
      expect(() =>
        issueDerivedTempPermitForDev(
          { ...value, jobId: "01" },
          "11",
          524288n,
          Date.now() + 1000,
        ),
      ).toThrow(/DERIVED_TEMP_IDENTITY/u);
      const expired = permitFor(value, 524288n, 0);
      await expect(
        store.createOwnedTemp(capability, expired, rendered, allow),
      ).rejects.toThrow(/DERIVED_PERMIT_INVALID/u);
      const mismatched = permitFor(value);
      await expect(
        store.createOwnedTemp(
          capability,
          mismatched,
          candidate("PREVIEW", bytes),
          allow,
        ),
      ).rejects.toThrow(/DERIVED_PERMIT_IDENTITY/u);
      expect(lstatSync(join(rootPath, "derived")).isDirectory()).toBe(true);
      expect(readdirSync(join(rootPath, "derived"))).toEqual([
        ".derived-writer.lock",
      ]);
      const live = permitFor(value);
      const writer = await store.createOwnedTemp(
        capability,
        live,
        rendered,
        allow,
      );
      await expect(
        store.createOwnedTemp(capability, live, rendered, allow),
      ).rejects.toThrow(/DERIVED_PERMIT_INVALID/u);
      expect(writer.identity().byteSize).toBe(BigInt(bytes.length));
      writer.cleanupOwnedFailure(capability);
    });
  });

  it("creates only the deterministic leaf and binds the durable identity", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const value = identity();
      const bytes = Buffer.from("owned-temp-bytes");
      const before = readdirSync(join(rootPath, "originals"));
      const writer = await store.createOwnedTemp(
        capability,
        permitFor(value),
        candidate("THUMBNAIL", bytes),
        async () => true,
      );
      const snapshot = writer.identity();
      const path = leaf(rootPath, value);
      const status = lstatSync(path, { bigint: true });
      expect(readdirSync(join(path, ".."))).toEqual(["thumbnail.part"]);
      expect(readFileSync(path)).toEqual(bytes);
      expect(status.isFile()).toBe(true);
      expect(status.nlink).toBe(1n);
      expect(status.mode & 0o777n).toBe(0o600n);
      expect(status.uid).toBe(BigInt(userInfo().uid));
      expect(snapshot.jobId).toBe("42");
      expect(snapshot.epoch).toBe(5n);
      expect(snapshot.kind).toBe("THUMBNAIL");
      expect(snapshot.byteSize).toBe(BigInt(bytes.length));
      expect(snapshot.sha256Hex).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(snapshot.mode).toBe(0o600);
      expect(snapshot.linkCount).toBe(1n);
      expect(snapshot.inode).toBe(status.ino.toString());
      expect(snapshot.durable).toBe(true);
      expect("path" in writer).toBe(false);
      expect(readdirSync(join(rootPath, "originals"))).toEqual(before);
      expect(() =>
        writer.writeCandidate(capability, candidate("THUMBNAIL", bytes)),
      ).toThrow(/DERIVED_WRITER_CLOSED/u);
      writer.cleanupOwnedFailure(capability);
      expect(() => lstatSync(path)).toThrow(/ENOENT/u);
    });
  });

  it("fail-closes collisions, symlinks, hardlinks, and bad modes without deleting them", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const value = identity();
      const path = leaf(rootPath, value);
      privateDirectory(join(path, ".."));
      writeFileSync(path, "residue");
      chmodSync(path, 0o600);
      const residue = permitFor(value);
      await expect(
        store.createOwnedTemp(
          capability,
          residue,
          candidate("THUMBNAIL", Buffer.from("new")),
          async () => true,
        ),
      ).rejects.toThrow(/DERIVED_TEMP_RECOVERY_REQUIRED/u);
      expect(readFileSync(path).toString()).toBe("residue");

      chmodSync(path, 0o644);
      await expect(
        store.createOwnedTemp(
          capability,
          permitFor(value),
          candidate("THUMBNAIL", Buffer.from("new")),
          async () => true,
        ),
      ).rejects.toThrow(/DERIVED_TEMP_UNSAFE/u);
      expect(lstatSync(path).mode & 0o777).toBe(0o644);
      rmSync(path);

      symlinkSync("elsewhere", path);
      await expect(
        store.createOwnedTemp(
          capability,
          permitFor(value),
          candidate("THUMBNAIL", Buffer.from("new")),
          async () => true,
        ),
      ).rejects.toThrow(/DERIVED_TEMP_UNSAFE/u);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      rmSync(path);

      writeFileSync(path, "linked");
      chmodSync(path, 0o600);
      const extra = join(path, "..", "preview.part");
      linkSync(path, extra);
      await expect(
        store.createOwnedTemp(
          capability,
          permitFor(value),
          candidate("THUMBNAIL", Buffer.from("new")),
          async () => true,
        ),
      ).rejects.toThrow(/DERIVED_TEMP_UNSAFE/u);
      expect(lstatSync(path).nlink).toBe(2);
      rmSync(path);
      rmSync(extra);
      rmSync(join(rootPath, "derived", ".tmp"), {
        recursive: true,
        force: true,
      });

      const tempLink = join(rootPath, "derived", ".tmp");
      symlinkSync("elsewhere", tempLink);
      await expect(
        store.createOwnedTemp(
          capability,
          permitFor(identity("PREVIEW")),
          candidate("PREVIEW", Buffer.from("preview")),
          async () => true,
        ),
      ).rejects.toThrow(/DERIVED_PARENT_REPLACED/u);
      expect(lstatSync(tempLink).isSymbolicLink()).toBe(true);
    });
  });

  it("serializes the same slot and removes an owned temp only at its exact identity", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const value = identity();
      const bytes = Buffer.from("first-writer");
      const first = await store.createOwnedTemp(
        capability,
        permitFor(value),
        candidate("THUMBNAIL", bytes),
        async () => true,
      );
      const secondIdentity = { ...value, workerId: randomBytes(16) };
      await expect(
        store.createOwnedTemp(
          capability,
          permitFor(secondIdentity),
          candidate("THUMBNAIL", Buffer.from("second-writer")),
          async () => true,
        ),
      ).rejects.toThrow(/DERIVED_TEMP_DUPLICATE/u);
      const path = leaf(rootPath, value);
      const replacement = Buffer.from("replaced-residue");
      rmSync(path);
      writeFileSync(path, replacement);
      chmodSync(path, 0o600);
      expect(() => first.cleanupOwnedFailure(capability)).toThrow(
        /DERIVED_CLEANUP_REFUSED|DERIVED_CLEANUP_FAILED/u,
      );
      expect(readFileSync(path)).toEqual(replacement);
      rmSync(path);

      const readOnly = {
        state: "READ_ONLY" as const,
        reason: "MAINTENANCE",
        root: capability.root,
      };
      expect(() => DerivedStore.open(readOnly)).toThrow(/DERIVED_READ_ONLY/u);
      const again = await store.createOwnedTemp(
        capability,
        permitFor(value),
        candidate("THUMBNAIL", bytes),
        async () => true,
      );
      expect(() => again.cleanupOwnedFailure(readOnly)).toThrow(
        /DERIVED_READ_ONLY/u,
      );
      expect(readFileSync(path)).toEqual(bytes);
      again.cleanupOwnedFailure(capability);

      await expect(
        store.createOwnedTemp(
          capability,
          permitFor(value),
          candidate("THUMBNAIL", bytes),
          async () => false,
        ),
      ).rejects.toThrow(/DERIVED_LEASE_LOST/u);
      expect(() => lstatSync(path)).toThrow(/ENOENT/u);
      expect(() =>
        DerivedStore.open({ state: "UNAVAILABLE", reason: "OFFLINE" }),
      ).toThrow(/DERIVED_UNAVAILABLE/u);
    });
  });

  it("drops the owned temp when durability fails and keeps the writer lock visible to inventory", async () => {
    await withStore(async ({ rootPath, root, capability, store }) => {
      const value = identity();
      const bytes = Buffer.from("sync-fail");
      store.failNextFsyncForDev();
      await expect(
        store.createOwnedTemp(
          capability,
          permitFor(value),
          candidate("THUMBNAIL", bytes),
          async () => true,
        ),
      ).rejects.toThrow(/DERIVED_FSYNC_FAILED/u);
      expect(() => lstatSync(leaf(rootPath, value))).toThrow(/ENOENT/u);
      await expect(
        store.createOwnedTemp(
          capability,
          permitFor(value),
          candidate("THUMBNAIL", bytes, "ab".repeat(32)),
          async () => true,
        ),
      ).rejects.toThrow(/DERIVED_HASH_MISMATCH/u);
      expect(readdirSync(join(rootPath, "derived"))).toEqual([
        ".derived-writer.lock",
      ]);
      root.provisionSharedCapacityLockForDev();
      const gate = CapacityGate.open({
        mediaRoot: rootPath,
        expectedMarkerId: root.markerId,
      });
      try {
        await gate.withLock(async () => {
          const snapshot = gate.snapshotLocked();
          expect(snapshot.derivedInventoryComplete).toBe(true);
          expect(snapshot.derivedObservations).toEqual([]);
        });
      } finally {
        gate.close();
      }
    });
  });

  it("lets one of two concurrent creates win the same slot", async () => {
    await withStore(async ({ capability, store }) => {
      const value = identity();
      const bytes = Buffer.from("concurrent");
      const rendered = candidate("THUMBNAIL", bytes);
      const results = await Promise.allSettled([
        store.createOwnedTemp(
          capability,
          permitFor(value),
          rendered,
          async () => true,
        ),
        store.createOwnedTemp(
          capability,
          permitFor({ ...value, workerId: randomBytes(16) }),
          rendered,
          async () => true,
        ),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
        /DERIVED_TEMP_DUPLICATE/u,
      );
      (
        fulfilled[0] as PromiseFulfilledResult<{
          cleanupOwnedFailure: (capability: StorageCapability) => void;
        }>
      ).value.cleanupOwnedFailure(capability);
    });
  });
});
