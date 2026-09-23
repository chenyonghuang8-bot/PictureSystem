import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DerivedStore,
  StorageRoot,
  issueDerivedTempPermitForDev,
  type DerivedTempPermitIdentity,
  type SealedDerivedOutput,
  type StorageCapability,
} from "./index.js";

const fixtureTool = resolve(
  import.meta.dirname,
  "../build/image_verifier_fixtures",
);

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true });
  const segments = path.split("/");
  const rootIndex = segments.findIndex((segment) =>
    segment.startsWith("ps4d3b1-"),
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
    width: 8,
    height: 4,
    sha256Hex: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

function binding(value = identity()) {
  return {
    familyId: value.familyId,
    mediaId: value.mediaId,
    generation: value.generation,
    recipeId: 1 as const,
    kind: value.kind,
    jobId: value.jobId,
    epoch: value.leaseEpoch,
    reservationId: "11",
  };
}

function partPath(root: string) {
  return join(root, "derived", ".tmp", "42", "e5", "thumbnail.part");
}

function finalPath(root: string) {
  return join(root, "derived", "7", "8", "r1", "g3", "thumbnail.webp");
}

let opaque: Buffer;

beforeAll(() => {
  const fixtureDir = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b1-"));
  const generated = spawnSync(fixtureTool, [fixtureDir], { encoding: "utf8" });
  if (generated.status !== 0) {
    throw new Error(
      `fixture encoder failed (${generated.status ?? "signal"}): ${generated.stderr}`,
    );
  }
  opaque = readFileSync(join(fixtureDir, "opaque.webp"));
  rmSync(fixtureDir, { recursive: true, force: true });
});

afterAll(() => {
  opaque = Buffer.alloc(0);
});

async function withStore(
  operation: (input: {
    rootPath: string;
    root: StorageRoot;
    capability: StorageCapability & { state: "READ_WRITE" };
    store: DerivedStore;
  }) => Promise<void>,
) {
  const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b1-"));
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

async function verifiedSeal(
  store: DerivedStore,
  capability: StorageCapability & { state: "READ_WRITE" },
  bytes: Buffer,
) {
  const writer = await store.createOwnedTemp(
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
  const sealed = writer.seal(capability, store);
  sealed.verify(store, { epoch: 5n, kind: "THUMBNAIL" });
  return sealed;
}

function plantFinal(root: string, bytes: Buffer) {
  const path = finalPath(root);
  privateDirectory(join(root, "derived", "7", "8", "r1", "g3"));
  writeFileSync(path, bytes);
  chmodSync(path, 0o400);
  return path;
}

describe("derived publish primitive", () => {
  it("publishes one verified seal with an exclusive rename", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const originalPath = join(rootPath, "originals", "7", "sample.bin");
      privateDirectory(join(rootPath, "originals", "7"));
      writeFileSync(originalPath, Buffer.from("original-bytes"));
      const originalBefore = lstatSync(originalPath, { bigint: true });
      const sealed = await verifiedSeal(store, capability, opaque);
      const before = lstatSync(partPath(rootPath), { bigint: true });
      expect(sealed.publish.length).toBe(3);
      const published = sealed.publish(store, capability, binding());
      const finalStatus = lstatSync(finalPath(rootPath), { bigint: true });
      const originalAfter = lstatSync(originalPath, { bigint: true });
      expect(published.outcome).toBe("PUBLISHED");
      expect(published.sha256Hex).toBe(
        createHash("sha256").update(opaque).digest("hex"),
      );
      expect(published.inode).toBe(before.ino.toString());
      expect(finalStatus.ino).toBe(before.ino);
      expect(finalStatus.mode & 0o777n).toBe(0o400n);
      expect(finalStatus.nlink).toBe(1n);
      expect(readFileSync(finalPath(rootPath))).toEqual(opaque);
      expect(() => lstatSync(partPath(rootPath))).toThrow();
      expect(readFileSync(originalPath)).toEqual(Buffer.from("original-bytes"));
      expect(originalAfter.ino).toBe(originalBefore.ino);
      expect(originalAfter.mtimeNs).toBe(originalBefore.mtimeNs);
      expect(originalAfter.mode).toBe(originalBefore.mode);
      expect(() => sealed.publish(store, capability, binding())).toThrow(
        /DERIVED_SEALED_CLOSED/u,
      );
    });
  });

  it("classifies an existing identical final without replacing it", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const path = plantFinal(rootPath, opaque);
      const before = lstatSync(path, { bigint: true });
      const sealed = await verifiedSeal(store, capability, opaque);
      const published = sealed.publish(store, capability, binding());
      const after = lstatSync(path, { bigint: true });
      expect(published.outcome).toBe("IDENTICAL");
      expect(after.ino).toBe(before.ino);
      expect(after.nlink).toBe(1n);
      expect(readFileSync(path)).toEqual(opaque);
      expect(readFileSync(partPath(rootPath))).toEqual(opaque);
      expect(lstatSync(partPath(rootPath), { bigint: true }).nlink).toBe(1n);
    });
  });

  it("refuses a conflicting final and a symlink without overwriting", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const conflict = Buffer.from(opaque);
      conflict[conflict.length - 1] =
        (conflict[conflict.length - 1] ?? 0) ^ 0xff;
      const path = plantFinal(rootPath, conflict);
      const before = readFileSync(path);
      const beforeStatus = lstatSync(path, { bigint: true });
      const sealed = await verifiedSeal(store, capability, opaque);
      expect(() => sealed.publish(store, capability, binding())).toThrow(
        /DERIVED_PUBLISH_CONFLICT/u,
      );
      expect(readFileSync(path)).toEqual(before);
      expect(lstatSync(path, { bigint: true }).ino).toBe(beforeStatus.ino);
    });

    await withStore(async ({ rootPath, capability, store }) => {
      const path = finalPath(rootPath);
      privateDirectory(join(rootPath, "derived", "7", "8", "r1", "g3"));
      symlinkSync("/dev/null", path);
      const sealed = await verifiedSeal(store, capability, opaque);
      expect(() => sealed.publish(store, capability, binding())).toThrow(
        /DERIVED_PUBLISH_UNSAFE/u,
      );
      expect(readlinkSync(path)).toBe("/dev/null");
      expect(readFileSync(partPath(rootPath))).toEqual(opaque);
    });
  });

  it("rejects a wrong binding and a changed SHA before rename", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const sealed = await verifiedSeal(store, capability, opaque);
      expect(() =>
        sealed.publish(store, capability, { ...binding(), familyId: "9" }),
      ).toThrow(/DERIVED_PUBLISH_IDENTITY/u);
      const published = sealed.publish(store, capability, binding());
      expect(published.outcome).toBe("PUBLISHED");
      expect(readFileSync(finalPath(rootPath))).toEqual(opaque);
    });

    await withStore(async ({ rootPath, capability, store }) => {
      const sealed = await verifiedSeal(store, capability, opaque);
      const path = partPath(rootPath);
      chmodSync(path, 0o600);
      const mutated = Buffer.from(readFileSync(path));
      mutated[mutated.length - 1] = (mutated[mutated.length - 1] ?? 0) ^ 0xff;
      writeFileSync(path, mutated);
      chmodSync(path, 0o400);
      expect(() => sealed.publish(store, capability, binding())).toThrow(
        /DERIVED_HASH_MISMATCH/u,
      );
      expect(() => lstatSync(finalPath(rootPath))).toThrow();
    });
  });

  it("rejects READ_ONLY and UNAVAILABLE without publishing", async () => {
    await withStore(async ({ rootPath, root, capability, store }) => {
      const sealed = await verifiedSeal(store, capability, opaque);
      expect(() =>
        sealed.publish(
          store,
          { state: "READ_ONLY", reason: "maintenance", root },
          binding(),
        ),
      ).toThrow(/DERIVED_READ_ONLY/u);
      expect(() =>
        sealed.publish(
          store,
          { state: "UNAVAILABLE", reason: "down" },
          binding(),
        ),
      ).toThrow(/DERIVED_UNAVAILABLE/u);
      expect(() => lstatSync(finalPath(rootPath))).toThrow();
      const published = sealed.publish(store, capability, binding());
      expect(published.outcome).toBe("PUBLISHED");
    });
  });

  it("refuses an unverified seal", async () => {
    await withStore(async ({ capability, store }) => {
      const writer = await store.createOwnedTemp(
        capability,
        issueDerivedTempPermitForDev(
          identity(),
          "11",
          524288n,
          Date.now() + 60_000,
        ),
        rendered(opaque),
        async () => true,
      );
      const sealed: SealedDerivedOutput = writer.seal(capability, store);
      expect(() => sealed.publish(store, capability, binding())).toThrow(
        /DERIVED_PUBLISH_UNVERIFIED/u,
      );
      sealed.verify(store, { epoch: 5n, kind: "THUMBNAIL" });
      sealed.consume(store);
    });
  });
});
