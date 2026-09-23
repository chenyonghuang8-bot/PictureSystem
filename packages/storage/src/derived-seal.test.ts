import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  linkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CapacityGate,
  DerivedStore,
  StorageRoot,
  isSealedDerivedOutput,
  issueDerivedTempPermitForDev,
  type DerivedTempPermitIdentity,
  type SealedDerivedOutput,
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

function identity(): DerivedTempPermitIdentity {
  return {
    familyId: "7",
    mediaId: "8",
    generation: 3n,
    recipeId: 1,
    kind: "THUMBNAIL",
    jobId: "42",
    leaseEpoch: 5n,
    workerId: randomBytes(16),
  };
}

function rendered(bytes: Buffer) {
  return {
    kind: "THUMBNAIL" as const,
    recipe: 1 as const,
    mime: "image/webp" as const,
    width: 1,
    height: 1,
    sha256Hex: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

function partPath(root: string) {
  return join(root, "derived", ".tmp", "42", "e5", "thumbnail.part");
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
    const capability = { state: "READ_WRITE" as const, root };
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

async function openWriter(
  store: DerivedStore,
  capability: StorageCapability & { state: "READ_WRITE" },
  bytes: Buffer,
) {
  return store.createOwnedTemp(
    capability,
    issueDerivedTempPermitForDev(
      identity(),
      "11",
      524288n,
      Date.now() + 60_000,
    ),
    rendered(bytes),
    async () => true,
  );
}

describe("sealed derived output", () => {
  it("seals one closed writer into a single-use opaque capability", async () => {
    await withStore(async ({ rootPath, root, capability, store }) => {
      const bytes = Buffer.from("sealed-candidate");
      const writer = await openWriter(store, capability, bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      await expect(
        store.createOwnedTemp(
          capability,
          issueDerivedTempPermitForDev(
            { ...identity(), workerId: randomBytes(16) },
            "12",
            524288n,
            Date.now() + 60_000,
          ),
          rendered(Buffer.from("other")),
          async () => true,
        ),
      ).rejects.toThrow(/DERIVED_TEMP_DUPLICATE/u);
      const sealed = writer.seal(capability, store);
      const snapshot = sealed.identity();
      const path = partPath(rootPath);
      const status = lstatSync(path, { bigint: true });
      expect(snapshot.sealed).toBe(true);
      expect(snapshot.sha256Hex).toBe(digest);
      expect(snapshot.byteSize).toBe(BigInt(bytes.length));
      expect(snapshot.mode).toBe(0o400);
      expect(snapshot.inode).toBe(status.ino.toString());
      expect(snapshot.epoch).toBe(5n);
      expect(snapshot.kind).toBe("THUMBNAIL");
      expect(status.mode & 0o777n).toBe(0o400n);
      expect(readFileSync(path)).toEqual(bytes);
      expect("path" in sealed).toBe(false);
      expect("fd" in sealed).toBe(false);
      expect(JSON.parse(JSON.stringify(sealed))).toEqual({});
      expect(isSealedDerivedOutput(sealed)).toBe(true);
      expect(isSealedDerivedOutput({ ...sealed })).toBe(false);
      expect(isSealedDerivedOutput(JSON.parse(JSON.stringify(sealed)))).toBe(
        false,
      );
      expect(() => writer.seal(capability, store)).toThrow(
        /DERIVED_ALREADY_SEALED/u,
      );
      expect(() => sealed.assertBinding(6n, "THUMBNAIL")).toThrow(
        /DERIVED_PERMIT_IDENTITY/u,
      );
      expect(() => sealed.assertBinding(5n, "PREVIEW")).toThrow(
        /DERIVED_PERMIT_IDENTITY/u,
      );
      sealed.assertBinding(5n, "THUMBNAIL");
      expect(() => writer.cleanupOwnedFailure(capability)).toThrow(
        /DERIVED_CLEANUP/u,
      );
      expect(readFileSync(path)).toEqual(bytes);
      root.provisionSharedCapacityLockForDev();
      const gate = CapacityGate.open({
        mediaRoot: rootPath,
        expectedMarkerId: root.markerId,
      });
      try {
        await gate.withLock(async () => {
          const observed = gate.snapshotLocked();
          expect(observed.derivedInventoryComplete).toBe(true);
          expect(observed.derivedObservations).toEqual([
            expect.objectContaining({
              jobId: "42",
              epoch: 5n,
              kind: "THUMBNAIL",
              byteSize: BigInt(bytes.length),
            }),
          ]);
        });
      } finally {
        gate.close();
      }
      const readOnly = {
        state: "READ_ONLY" as const,
        reason: "MAINTENANCE",
        root,
      };
      expect(() => writer.seal(readOnly, store)).toThrow(/DERIVED_READ_ONLY/u);
      sealed.consume(store);
      expect(() => sealed.consume(store)).toThrow(/DERIVED_SEALED_CLOSED/u);
      expect(() => sealed.identity()).toThrow(/DERIVED_SEALED_CLOSED/u);
      expect(lstatSync(path).isFile()).toBe(true);
    });
  });

  it("refuses seal when identity or bytes change and keeps unknown residue", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const bytes = Buffer.from("identity-check");
      const path = partPath(rootPath);
      const swapped = await openWriter(store, capability, bytes);
      rmSync(path);
      writeFileSync(path, "replacement-inode");
      chmodSync(path, 0o600);
      expect(() => swapped.seal(capability, store)).toThrow(
        /DERIVED_TEMP_RECOVERY_REQUIRED/u,
      );
      expect(readFileSync(path).toString()).toBe("replacement-inode");
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(() => swapped.cleanupOwnedFailure(capability)).toThrow(
        /DERIVED_CLEANUP/u,
      );
      expect(readFileSync(path).toString()).toBe("replacement-inode");
      rmSync(path, { force: true });

      const modeWriter = await openWriter(store, capability, bytes);
      chmodSync(path, 0o644);
      expect(() => modeWriter.seal(capability, store)).toThrow(
        /DERIVED_TEMP_RECOVERY_REQUIRED/u,
      );
      expect(lstatSync(path).mode & 0o777).toBe(0o644);
      expect(() => modeWriter.cleanupOwnedFailure(capability)).toThrow(
        /DERIVED_CLEANUP/u,
      );
      rmSync(path);

      const linked = await openWriter(store, capability, bytes);
      const extra = join(path, "..", "preview.part");
      linkSync(path, extra);
      expect(() => linked.seal(capability, store)).toThrow(
        /DERIVED_TEMP_RECOVERY_REQUIRED/u,
      );
      expect(lstatSync(path).nlink).toBe(2);
      expect(() => linked.cleanupOwnedFailure(capability)).toThrow(
        /DERIVED_CLEANUP/u,
      );
      rmSync(extra);
      rmSync(path);

      const changed = await openWriter(store, capability, bytes);
      const mutated = Buffer.from("identity-checX");
      writeFileSync(path, mutated);
      chmodSync(path, 0o600);
      expect(() => changed.seal(capability, store)).toThrow(
        /DERIVED_HASH_MISMATCH/u,
      );
      expect(readFileSync(path)).toEqual(mutated);
      changed.cleanupOwnedFailure(capability);
      expect(() => lstatSync(path)).toThrow(/ENOENT/u);

      const truncated = await openWriter(store, capability, bytes);
      truncateSync(path, 4);
      expect(() => truncated.seal(capability, store)).toThrow(
        /DERIVED_TEMP_RECOVERY_REQUIRED/u,
      );
      expect(lstatSync(path).size).toBe(4);
      truncated.cleanupOwnedFailure(capability);

      const parent = await openWriter(store, capability, bytes);
      const epoch = join(rootPath, "derived", ".tmp", "42", "e5");
      const moved = join(rootPath, "derived", ".tmp", "42", "e5-kept");
      rmSync(epoch, { recursive: true, force: true });
      symlinkSync("elsewhere", epoch);
      expect(() => parent.seal(capability, store)).toThrow(
        /DERIVED_PARENT_REPLACED|DERIVED_TEMP_RECOVERY_REQUIRED/u,
      );
      expect(lstatSync(epoch).isSymbolicLink()).toBe(true);
      expect(() => lstatSync(moved)).toThrow(/ENOENT/u);
      expect(() => parent.cleanupOwnedFailure(capability)).toThrow(
        /DERIVED_CLEANUP/u,
      );
    });
  });

  it("does not issue a seal when durability or close fails, and rejects the wrong store", async () => {
    const bytes = Buffer.from("durability");
    await withStore(async ({ rootPath, capability, store }) => {
      const path = partPath(rootPath);
      const syncWriter = await openWriter(store, capability, bytes);
      store.failNextSealFaultForDev("fsync");
      expect(() => syncWriter.seal(capability, store)).toThrow(
        /DERIVED_FSYNC_FAILED/u,
      );
      expect(isSealedDerivedOutput(syncWriter)).toBe(false);
      expect(lstatSync(path).isFile()).toBe(true);
      syncWriter.cleanupOwnedFailure(capability);

      const closeWriter = await openWriter(store, capability, bytes);
      store.failNextSealFaultForDev("close");
      expect(() => closeWriter.seal(capability, store)).toThrow(
        /DERIVED_CLOSE_FAILED/u,
      );
      expect((lstatSync(path).mode & 0o777) === 0o400).toBe(true);
      closeWriter.cleanupOwnedFailure(capability);
    });

    const firstRoot = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
    const secondRoot = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
    privateDirectory(firstRoot);
    privateDirectory(secondRoot);
    privateDirectory(join(firstRoot, "derived"));
    privateDirectory(join(secondRoot, "derived"));
    const first = StorageRoot.open(firstRoot, { initialize: true });
    const second = StorageRoot.open(secondRoot, { initialize: true });
    let firstStore: DerivedStore | undefined;
    let secondStore: DerivedStore | undefined;
    let sealed: SealedDerivedOutput | undefined;
    try {
      first.provisionDerivedWriterLockForDev();
      second.provisionDerivedWriterLockForDev();
      const firstCapability = { state: "READ_WRITE" as const, root: first };
      const secondCapability = { state: "READ_WRITE" as const, root: second };
      const openedFirst = DerivedStore.open(firstCapability);
      const openedSecond = DerivedStore.open(secondCapability);
      firstStore = openedFirst;
      secondStore = openedSecond;
      const writer = await openWriter(openedFirst, firstCapability, bytes);
      const sealedOutput = writer.seal(firstCapability, openedFirst);
      sealed = sealedOutput;
      expect(() => sealedOutput.consume(openedSecond)).toThrow(
        /DERIVED_STORE_MISMATCH/u,
      );
      expect(sealed.identity().sha256Hex).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      sealed.consume(openedFirst);
      sealed = undefined;
    } finally {
      if (sealed !== undefined && firstStore !== undefined) {
        try {
          sealed.consume(firstStore);
        } catch {
          // Already consumed, or the store is closing.
        }
      }
      firstStore?.close();
      secondStore?.close();
      first.close();
      second.close();
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});
