import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CapacityGate, StorageRoot } from "./index.js";

const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3c2-read-"));
const bytes = Buffer.from("synthetic-derived-webp");
const digest = createHash("sha256").update(bytes).digest("hex");

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true });
  const segments = path.split("/");
  const rootIndex = segments.findIndex((segment) =>
    segment.startsWith("ps4d3c2-read-"),
  );
  const start = rootIndex >= 0 ? rootIndex : segments.length - 1;
  for (let index = start; index < segments.length; index += 1) {
    chmodSync(segments.slice(0, index + 1).join("/"), 0o700);
  }
}

function place(kind: "thumbnail.webp" | "preview.webp") {
  const directory = join(rootPath, "derived", "7", "8", "r1", "g1");
  privateDirectory(directory);
  const file = join(directory, kind);
  writeFileSync(file, bytes, { mode: 0o600 });
  chmodSync(file, 0o400);
}

describe("derived final read", () => {
  const root = StorageRoot.open(rootPath, { initialize: true });
  root.provisionSharedCapacityLockForDev();
  const gate = CapacityGate.open({
    mediaRoot: root.canonicalPath,
    expectedMarkerId: root.markerId,
  });
  place("thumbnail.webp");
  privateDirectory(join(rootPath, "originals", "7"));
  writeFileSync(
    join(rootPath, "originals", "7", "decoy"),
    Buffer.from("original"),
    {
      mode: 0o600,
    },
  );

  afterAll(() => {
    root.close();
    rmSync(rootPath, { recursive: true, force: true });
  });

  it("returns the sealed final that matches the authoritative digest", async () => {
    const read = await gate.withLock(() =>
      Promise.resolve(
        gate.readDerivedFinal({
          familyId: "7",
          mediaId: "8",
          generation: 1n,
          recipeId: 1,
          kind: "THUMBNAIL",
          sha256Hex: digest,
          byteSize: BigInt(bytes.length),
        }),
      ),
    );
    expect(read.equals(bytes)).toBe(true);
  });

  it("rejects a missing final and a digest mismatch without reading an original", async () => {
    await expect(
      gate.withLock(() =>
        Promise.resolve(
          gate.readDerivedFinal({
            familyId: "7",
            mediaId: "9",
            generation: 1n,
            recipeId: 1,
            kind: "PREVIEW",
            sha256Hex: digest,
            byteSize: BigInt(bytes.length),
          }),
        ),
      ),
    ).rejects.toMatchObject({ reason: "DERIVED_SERVE_ABSENT" });
    await expect(
      gate.withLock(() =>
        Promise.resolve(
          gate.readDerivedFinal({
            familyId: "7",
            mediaId: "8",
            generation: 1n,
            recipeId: 1,
            kind: "THUMBNAIL",
            sha256Hex: "a".repeat(64),
            byteSize: BigInt(bytes.length),
          }),
        ),
      ),
    ).rejects.toMatchObject({ reason: "DERIVED_SERVE_MISMATCH" });
  });
});
