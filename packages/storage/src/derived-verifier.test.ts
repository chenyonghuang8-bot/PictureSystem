import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DerivedStore,
  StorageRoot,
  isSealedDerivedOutput,
  issueDerivedTempPermitForDev,
  type DerivedTempPermitIdentity,
  type DerivedVerifyScenario,
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
    width: 8,
    height: 4,
    sha256Hex: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

function chunk(tag: string, payload: Buffer) {
  const padded =
    payload.length % 2 === 0
      ? payload
      : Buffer.concat([payload, Buffer.alloc(1)]);
  const header = Buffer.alloc(8);
  header.write(tag, 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, padded]);
}

function container(parts: Buffer[]) {
  const body = Buffer.concat([Buffer.from("WEBP"), ...parts]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function appendChunk(webp: Buffer, tag: string, payload: Buffer) {
  const next = Buffer.concat([webp, chunk(tag, payload)]);
  next.writeUInt32LE(next.length - 8, 4);
  return next;
}

function corruptPayload(webp: Buffer) {
  const copy = Buffer.from(webp);
  const tag = copy.toString("ascii", 12, 16);
  const start = tag === "VP8 " ? 12 + 8 + 10 : 30;
  const index = Math.min(start, copy.length - 1);
  const value = copy[index] ?? 0;
  copy[index] = value ^ 0xff;
  return copy;
}

let opaque: Buffer;
let alpha: Buffer;
let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-verify-"));
  const generated = spawnSync(fixtureTool, [fixtureDir], { encoding: "utf8" });
  if (generated.status !== 0) {
    throw new Error(
      `fixture encoder failed (${generated.status ?? "signal"}): ${generated.stderr}`,
    );
  }
  opaque = readFileSync(join(fixtureDir, "opaque.webp"));
  alpha = readFileSync(join(fixtureDir, "alpha.webp"));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

async function withStore(
  operation: (input: {
    rootPath: string;
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
    await operation({ rootPath, capability, store });
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

async function sealBytes(
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
  return writer.seal(capability, store);
}

const binding = { epoch: 5n, kind: "THUMBNAIL" as const };

function partPath(rootPath: string) {
  return join(rootPath, "derived", ".tmp", "42", "e5", "thumbnail.part");
}

describe("isolated verify-output", () => {
  it("full-decodes a sealed static WebP and reports decoded geometry", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const sealed = await sealBytes(store, capability, opaque);
      const before = lstatSync(partPath(rootPath), { bigint: true });
      const result = sealed.verify(store, binding);
      const after = lstatSync(partPath(rootPath), { bigint: true });
      expect(result).toMatchObject({
        width: 8,
        height: 4,
        staticImage: true,
        alpha: false,
        transparent: false,
        sha256Hex: createHash("sha256").update(opaque).digest("hex"),
      });
      expect(after.ino).toBe(before.ino);
      expect(after.dev).toBe(before.dev);
      expect(readFileSync(partPath(rootPath))).toEqual(opaque);
      expect(isSealedDerivedOutput(sealed)).toBe(true);
      expect(() => sealed.verify(store, binding)).toThrow(
        /DERIVED_ALREADY_VERIFIED/u,
      );
      sealed.consume(store);
    });
  });

  it("reports decoded alpha instead of trusting a chunk flag alone", async () => {
    await withStore(async ({ capability, store }) => {
      const sealed = await sealBytes(store, capability, alpha);
      const result = sealed.verify(store, binding);
      expect(result.width).toBe(8);
      expect(result.height).toBe(4);
      expect(result.alpha).toBe(true);
      expect(result.transparent).toBe(true);
      expect(result.staticImage).toBe(true);
      sealed.consume(store);
    });
  });

  it("rejects corrupt, truncated, invalid VP8, and invalid VP8L", async () => {
    const samples = [
      corruptPayload(opaque),
      opaque.subarray(0, opaque.length - 8),
      container([chunk("VP8 ", Buffer.alloc(16))]),
      container([chunk("VP8L", Buffer.alloc(16))]),
    ];
    for (const bytes of samples) {
      await withStore(async ({ capability, store }) => {
        const sealed = await sealBytes(store, capability, Buffer.from(bytes));
        expect(() => sealed.verify(store, binding)).toThrow(
          /DERIVED_VERIFY_REJECTED/u,
        );
        expect(() => sealed.verify(store, binding)).toThrow(
          /DERIVED_SEALED_CLOSED/u,
        );
      });
    }
  });

  it("rejects injected EXIF, XMP, and animation chunks", async () => {
    const samples = [
      appendChunk(opaque, "EXIF", Buffer.from("gps")),
      appendChunk(opaque, "XMP ", Buffer.from("<xmp/>")),
      container([
        chunk("VP8X", Buffer.from([0x02, 0, 0, 0, 7, 0, 0, 3, 0, 0])),
        chunk("ANIM", Buffer.from([0, 0, 0, 0, 0, 0])),
        chunk("ANMF", Buffer.from("frame")),
        chunk("VP8 ", Buffer.alloc(16)),
      ]),
    ];
    for (const bytes of samples) {
      await withStore(async ({ capability, store }) => {
        const sealed = await sealBytes(store, capability, bytes);
        expect(() => sealed.verify(store, binding)).toThrow(
          /DERIVED_VERIFY_REJECTED/u,
        );
      });
    }
  });

  it("rejects forged, mismatched, closed, and double-consumed handles", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const sealed = await sealBytes(store, capability, opaque);
      expect(() =>
        (sealed as SealedDerivedOutput).verify(store, {
          epoch: 9n,
          kind: "THUMBNAIL",
        }),
      ).toThrow(/DERIVED_PERMIT_IDENTITY/u);
      expect(() =>
        sealed.verify(store, { epoch: 5n, kind: "PREVIEW" }),
      ).toThrow(/DERIVED_PERMIT_IDENTITY/u);
      const otherPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
      privateDirectory(otherPath);
      privateDirectory(join(otherPath, "derived"));
      const otherRoot = StorageRoot.open(otherPath, { initialize: true });
      otherRoot.provisionDerivedWriterLockForDev();
      const other = DerivedStore.open({
        state: "READ_WRITE",
        root: otherRoot,
      });
      expect(() => sealed.verify(other, binding)).toThrow(
        /DERIVED_STORE_MISMATCH/u,
      );
      other.close();
      otherRoot.close();
      rmSync(otherPath, { recursive: true, force: true });
      expect(isSealedDerivedOutput({ ...sealed })).toBe(false);
      expect(isSealedDerivedOutput(JSON.parse(JSON.stringify(sealed)))).toBe(
        false,
      );
      sealed.consume(store);
      expect(() => sealed.verify(store, binding)).toThrow(
        /DERIVED_SEALED_CLOSED/u,
      );
      expect(readFileSync(partPath(rootPath))).toEqual(opaque);
    });
  });

  it("invalidates verification when inode, mode, parent, or bytes change", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const path = partPath(rootPath);
      const inode = await sealBytes(store, capability, opaque);
      const replacement = `${path}.swapped`;
      renameSync(path, replacement);
      writeFileSync(path, opaque, { mode: 0o400 });
      expect(() => inode.verify(store, binding)).toThrow(
        /DERIVED_VERIFY_IDENTITY/u,
      );
      rmSync(path);
      renameSync(replacement, path);
    });
    await withStore(async ({ rootPath, capability, store }) => {
      const sealed = await sealBytes(store, capability, opaque);
      chmodSync(partPath(rootPath), 0o644);
      expect(() => sealed.verify(store, binding)).toThrow(
        /DERIVED_VERIFY_IDENTITY/u,
      );
    });
    await withStore(async ({ rootPath, capability, store }) => {
      const sealed = await sealBytes(store, capability, opaque);
      const epoch = join(rootPath, "derived", ".tmp", "42", "e5");
      renameSync(epoch, `${epoch}-old`);
      mkdirSync(epoch, { mode: 0o700 });
      expect(() => sealed.verify(store, binding)).toThrow(
        /DERIVED_VERIFY_IDENTITY/u,
      );
    });
    await withStore(async ({ rootPath, capability, store }) => {
      const sealed = await sealBytes(store, capability, opaque);
      const path = partPath(rootPath);
      const mutated = Buffer.from(opaque);
      const last = mutated.length - 1;
      mutated[last] = (mutated[last] ?? 0) ^ 0xff;
      chmodSync(path, 0o600);
      writeFileSync(path, mutated);
      chmodSync(path, 0o400);
      expect(() => sealed.verify(store, binding)).toThrow(
        /DERIVED_HASH_MISMATCH/u,
      );
    });
  });

  it("discards a decode when the post-verification identity check fails", async () => {
    await withStore(async ({ rootPath, capability, store }) => {
      const sealed = await sealBytes(store, capability, opaque);
      store.failNextVerifyPostForDev();
      expect(() => sealed.verify(store, binding)).toThrow(
        /DERIVED_VERIFY_IDENTITY/u,
      );
      expect(readFileSync(partPath(rootPath))).toEqual(opaque);
      expect(isSealedDerivedOutput(sealed)).toBe(false);
    });
  });

  it("proves high descriptors are held by the native parent and absent in the child", async () => {
    await withStore(async ({ capability, store }) => {
      const sealed = await sealBytes(store, capability, opaque);
      const result = sealed.verify(store, binding, "high-fd");
      expect(result).toMatchObject({ width: 8, height: 4, staticImage: true });
      sealed.consume(store);
    });
  });

  it("reaps timeout, crash, ignore-term, and owner-death without a geometry result", async () => {
    const scenarios: Array<[DerivedVerifyScenario, RegExp]> = [
      ["timeout", /DERIVED_VERIFY_TIMEOUT/u],
      ["crash", /DERIVED_VERIFY_CRASH/u],
      ["ignore-term", /DERIVED_VERIFY_TIMEOUT/u],
      ["owner-death", /DERIVED_VERIFY_OWNER_LOST/u],
    ];
    for (const [scenario, pattern] of scenarios) {
      await withStore(async ({ capability, store }) => {
        const sealed = await sealBytes(store, capability, opaque);
        expect(() => sealed.verify(store, binding, scenario)).toThrow(pattern);
        expect(isSealedDerivedOutput(sealed)).toBe(false);
      });
    }
  });
});
