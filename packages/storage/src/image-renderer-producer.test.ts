import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  OriginalReader,
  renderUnverifiedCandidate,
  StorageRoot,
} from "./index.js";
import {
  inspectUnverifiedWebP,
  parseRendererControl,
} from "./image-renderer-producer.js";

const FIXTURES = {
  JPEG: Buffer.from(
    "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z",
    "base64",
  ),
  PNG: syntheticPng(),
  WEBP: Buffer.from(
    "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=",
    "base64",
  ).subarray(0, 42),
  GIF: Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    "base64",
  ),
} as const;

function syntheticPng(width = 2, height = 2): Buffer {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, contents: Buffer) => {
    const type = Buffer.from(name, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(contents.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, contents])));
    return Buffer.concat([length, type, contents, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rgba = Buffer.alloc((1 + width * 4) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 4) + 1 + x * 4;
      rgba[offset] = x % 2 === 0 ? 255 : 0;
      rgba[offset + 1] = y % 2 === 0 ? 255 : 0;
      rgba[offset + 2] = 30;
      rgba[offset + 3] = x === 1 && y === 0 ? 128 : 255;
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rgba)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

async function renderSynthetic(
  original: Buffer,
  kind: "THUMBNAIL" | "PREVIEW" = "THUMBNAIL",
) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "phase4d3a2a-input-"));
  const mediaRoot = join(root, "media");
  let writer: StorageRoot | undefined;
  let reader: OriginalReader | undefined;
  try {
    writer = StorageRoot.open(mediaRoot, { initialize: true });
    const identity = {
      familyId: "1",
      sha256Hex: createHash("sha256").update(original).digest("hex"),
      byteSize: String(original.length),
    };
    const uploadId = "c".repeat(32);
    writer.createUploadPayload("1", uploadId, original);
    const path = join(
      mediaRoot,
      writer.publishOriginal({ ...identity, uploadId }).relativePath,
    );
    const before = {
      bytes: readFileSync(path),
      stat: lstatSync(path, { bigint: true }),
    };
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: writer.markerId,
    });
    let output:
      Awaited<ReturnType<typeof renderUnverifiedCandidate>> | undefined;
    let rejected = false;
    try {
      output = await reader.withVerifiedOriginal(identity, (handle) =>
        renderUnverifiedCandidate(handle, kind),
      );
    } catch {
      rejected = true;
    }
    const after = lstatSync(path, { bigint: true });
    expect(readFileSync(path)).toEqual(before.bytes);
    expect(after.ino).toBe(before.stat.ino);
    expect(after.mode).toBe(before.stat.mode);
    expect(after.mtimeNs).toBe(before.stat.mtimeNs);
    return { output, rejected };
  } finally {
    reader?.close();
    writer?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function animatedGif(frameCount: number): Buffer {
  const image = FIXTURES.GIF;
  const descriptor = image.indexOf(0x2c, 19);
  const frame = image.subarray(descriptor, image.length - 1);
  return Buffer.concat([
    image.subarray(0, descriptor),
    ...Array.from({ length: frameCount }, () => frame),
    Buffer.from([0x3b]),
  ]);
}

function animatedWebP(frameCount: number): Buffer {
  const chunk = (name: string, payload: Buffer) => {
    const header = Buffer.alloc(8);
    header.write(name, 0, "ascii");
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload, Buffer.alloc(payload.length & 1)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02;
  const frameHeader = Buffer.alloc(16);
  frameHeader.writeUIntLE(100, 12, 3);
  const frame = chunk(
    "ANMF",
    Buffer.concat([frameHeader, FIXTURES.WEBP.subarray(12)]),
  );
  const body = Buffer.concat([
    Buffer.from("WEBP"),
    chunk("VP8X", vp8x),
    chunk("ANIM", Buffer.alloc(6)),
    ...Array.from({ length: frameCount }, () => frame),
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

describe("D3a-2a isolated image producer", () => {
  it.each([
    ["JPEG", "THUMBNAIL"],
    ["JPEG", "PREVIEW"],
    ["PNG", "THUMBNAIL"],
    ["PNG", "PREVIEW"],
    ["WEBP", "THUMBNAIL"],
    ["WEBP", "PREVIEW"],
    ["GIF", "THUMBNAIL"],
    ["GIF", "PREVIEW"],
  ] as const)(
    "renders synthetic %s as %s through a verified handle",
    async (format, kind) => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "phase4d3a2a-"));
      let original: Buffer = FIXTURES[format];
      if (format === "JPEG") {
        const pngPath = join(root, "generated.png");
        const jpegPath = join(root, "generated.jpg");
        writeFileSync(pngPath, FIXTURES.PNG, { mode: 0o600 });
        const converted = spawnSync(
          "/usr/bin/sips",
          ["-s", "format", "jpeg", pngPath, "--out", jpegPath],
          { env: { LANG: "C", LC_ALL: "C" } },
        );
        expect(converted.status).toBe(0);
        original = readFileSync(jpegPath);
      }
      const mediaRoot = join(root, "media");
      const writer = StorageRoot.open(mediaRoot, { initialize: true });
      let reader: OriginalReader | undefined;
      try {
        const identity = {
          familyId: "1",
          sha256Hex: createHash("sha256").update(original).digest("hex"),
          byteSize: String(original.length),
        };
        const uploadId = "a".repeat(32);
        writer.createUploadPayload("1", uploadId, original);
        const published = writer.publishOriginal({ ...identity, uploadId });
        const originalPath = join(mediaRoot, published.relativePath);
        const before = {
          bytes: readFileSync(originalPath),
          stat: lstatSync(originalPath, { bigint: true }),
        };
        reader = OriginalReader.open({
          mediaRoot,
          expectedMarkerId: writer.markerId,
        });
        const output = await reader.withVerifiedOriginal(identity, (handle) =>
          renderUnverifiedCandidate(handle, kind),
        );
        expect(output.kind).toBe(kind);
        expect(output.recipe).toBe(1);
        expect(output.mime).toBe("image/webp");
        expect(output.bytes.length).toBeGreaterThan(0);
        expect(output.bytes.length).toBeLessThanOrEqual(
          kind === "THUMBNAIL" ? 512 * 1024 : 4 * 1024 * 1024,
        );
        expect(output.sha256Hex).toBe(
          createHash("sha256").update(output.bytes).digest("hex"),
        );
        expect(readFileSync(originalPath)).toEqual(before.bytes);
        const after = lstatSync(originalPath, { bigint: true });
        expect(after.ino).toBe(before.stat.ino);
        expect(after.mode).toBe(before.stat.mode);
        expect(after.mtimeNs).toBe(before.stat.mtimeNs);
      } finally {
        reader?.close();
        writer.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["B", "C", "E", "X"])(
    "fails closed for fixed synthetic fault %s without modifying original",
    (mode) => {
      const result = runFault(mode);
      expect(result.status).not.toBe(0);
      expect(result.stdout.length).toBe(0);
      expect(result.before).toEqual(result.after);
    },
  );

  it("rejects invalid control and reported binary-length mismatch from fixed child", () => {
    const invalid = runFault("I");
    expect(invalid.status).toBe(0);
    expect(() =>
      parseRendererControl(
        invalid.stdout.toString("utf8"),
        "PREVIEW",
        invalid.binaryBytes ?? -1,
      ),
    ).toThrow();
    expect(invalid.before).toEqual(invalid.after);

    const short = runFault("S");
    expect(short.status).toBe(0);
    expect(() =>
      parseRendererControl(
        short.stdout.toString("utf8"),
        "PREVIEW",
        short.binaryBytes ?? -1,
      ),
    ).toThrow();
    expect(short.before).toEqual(short.after);
  });

  it.each([1, 5, 6, 7, 8])(
    "reports producer geometry for non-square EXIF orientation %i",
    async (orientation) => {
      const root = mkdtempSync(
        join(realpathSync(tmpdir()), "phase4d3a2a-orient-"),
      );
      const mediaRoot = join(root, "media");
      const png = join(root, "source.png");
      const jpeg = join(root, "source.jpg");
      let writer: StorageRoot | undefined;
      let reader: OriginalReader | undefined;
      try {
        writeFileSync(png, syntheticPng(2, 3), { mode: 0o600 });
        const converted = spawnSync(
          "/usr/bin/sips",
          ["-s", "format", "jpeg", png, "--out", jpeg],
          { env: { LANG: "C", LC_ALL: "C" } },
        );
        expect(converted.status).toBe(0);
        const bytes = withExifOrientation(readFileSync(jpeg), orientation);
        writer = StorageRoot.open(mediaRoot, { initialize: true });
        const identity = {
          familyId: "1",
          sha256Hex: createHash("sha256").update(bytes).digest("hex"),
          byteSize: String(bytes.length),
        };
        const uploadId = "b".repeat(32);
        writer.createUploadPayload("1", uploadId, bytes);
        const path = join(
          mediaRoot,
          writer.publishOriginal({ ...identity, uploadId }).relativePath,
        );
        const originalBefore = readFileSync(path);
        reader = OriginalReader.open({
          mediaRoot,
          expectedMarkerId: writer.markerId,
        });
        const output = await reader.withVerifiedOriginal(identity, (handle) =>
          renderUnverifiedCandidate(handle, "THUMBNAIL"),
        );
        expect([output.width, output.height]).toEqual(
          orientation >= 5 ? [3, 2] : [2, 3],
        );
        expect(readFileSync(path)).toEqual(originalBefore);
      } finally {
        reader?.close();
        writer?.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects oversized dimensions before expensive ImageIO decode", async () => {
    const oversized = Buffer.from(syntheticPng());
    oversized.writeUInt32BE(16_385, 16);
    expect((await renderSynthetic(oversized)).rejected).toBe(true);
    const pixels = Buffer.from(syntheticPng());
    pixels.writeUInt32BE(10_000, 16);
    pixels.writeUInt32BE(10_000, 20);
    expect((await renderSynthetic(pixels)).rejected).toBe(true);
  });

  it("rejects corrupt, truncated, HEIC, and RAW inputs without changing originals", async () => {
    for (const bytes of [
      FIXTURES.JPEG.subarray(0, 24),
      FIXTURES.PNG.subarray(0, 24),
      Buffer.from("00000018667479706865696300000000", "hex"),
      Buffer.from("49492a0008000000", "hex"),
    ])
      expect((await renderSynthetic(bytes)).rejected).toBe(true);
  });

  it("renders a bounded animated GIF as one static WebP and rejects over 256 frames", async () => {
    const animated = await renderSynthetic(animatedGif(2));
    expect(animated.rejected).toBe(false);
    expect(
      animated.output && inspectUnverifiedWebP(animated.output.bytes),
    ).toEqual({ width: 1, height: 1 });
    expect((await renderSynthetic(animatedGif(257))).rejected).toBe(true);
  });

  it("renders synthetic animated WebP as one static candidate and caps frame count", async () => {
    const animated = await renderSynthetic(animatedWebP(2));
    expect(animated.rejected).toBe(false);
    expect(
      animated.output && inspectUnverifiedWebP(animated.output.bytes),
    ).toEqual({ width: 1, height: 1 });
    expect((await renderSynthetic(animatedWebP(257))).rejected).toBe(true);
  });

  it("strips private JPEG metadata chunks from an unverified candidate", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "phase4d3a2a-meta-"));
    try {
      const source = join(root, "source.png");
      const jpeg = join(root, "source.jpg");
      writeFileSync(source, FIXTURES.PNG, { mode: 0o600 });
      expect(
        spawnSync(
          "/usr/bin/sips",
          ["-s", "format", "jpeg", source, "--out", jpeg],
          { env: { LANG: "C", LC_ALL: "C" } },
        ).status,
      ).toBe(0);
      const withExif = withExifOrientation(readFileSync(jpeg), 6);
      const output = await renderSynthetic(withExif);
      expect(output.rejected).toBe(false);
      expect(output.output?.bytes.includes(Buffer.from("EXIF"))).toBe(false);
      expect(output.output?.bytes.includes(Buffer.from("XMP "))).toBe(false);
      expect(output.output?.bytes.includes(Buffer.from("ANIM"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves PNG alpha in the producer container", async () => {
    const result = await renderSynthetic(FIXTURES.PNG);
    expect(result.rejected).toBe(false);
    expect(result.output?.bytes.includes(Buffer.from("ALPH"))).toBe(true);
  });

  it("drains a near-4-MiB binary pipe without deadlock", () => {
    const result = runFault("P");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.binaryBytes).toBe(4 * 1024 * 1024);
    expect(result.before).toEqual(result.after);
  });

  it("blocks inherited high descriptors while retaining only binary FD4", () => {
    const result = runFault("H", true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.binaryBytes).toBe(2);
    expect(result.before).toEqual(result.after);
  });

  it("terminates and reaps a timed-out child without output success", () => {
    const result = runFault("T");
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(result.before).toEqual(result.after);
  }, 40_000);

  it("terminates a waiting renderer when owner liveness is revoked", async () => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "phase4d3a2a-owner-"),
    );
    const original = join(root, "synthetic-original.bin");
    writeFileSync(original, "T", { mode: 0o400 });
    const fd = openSync(original, "r");
    try {
      const child = spawn(
        resolve(
          import.meta.dirname,
          "../build/image_renderer_fault_supervisor",
        ),
        [],
        {
          stdio: ["ignore", "pipe", "pipe", fd, "pipe", "pipe"],
          env: { LANG: "C", LC_ALL: "C" },
        },
      );
      const result = await new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolveResult, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("owner-liveness timeout"));
        }, 5_000);
        child.once("error", reject);
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolveResult({ code, signal });
        });
        child.stdio.at(5)?.destroy();
      });
      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(readFileSync(original).toString()).toBe("T");
    } finally {
      closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-canonical control, duplicate keys, length mismatch and extensions", () => {
    const valid =
      'PS_RENDER_READY_V1\n{"status":"ok","kind":"THUMBNAIL","recipe":1,"mime":"image/webp","width":1,"height":1,"byteCount":2,"producerCode":"ENCODED"}\n';
    expect(parseRendererControl(valid, "THUMBNAIL", 2)).toEqual({
      width: 1,
      height: 1,
    });
    for (const invalid of [
      valid.replace("PS_RENDER_READY_V1", "BAD_READY"),
      valid.replace('"byteCount":2', '"byteCount":3'),
      valid.replace('"kind":"THUMBNAIL"', '"kind":"PREVIEW"'),
      valid.replace('"width":1', '"width":0'),
      valid.replace('"width":1', '"width":481'),
      valid.replace(
        '"producerCode":"ENCODED"',
        '"producerCode":"ENCODED","path":"forbidden"',
      ),
      valid.replace('"height":1', '"height":1,"height":1'),
      `${valid}\n`,
      "PS_RENDER_READY_V1\nnot-json\n",
    ]) {
      expect(() => parseRendererControl(invalid, "THUMBNAIL", 2)).toThrow();
    }
  });

  it("bounds RIFF chunks and rejects metadata, animation and extra bytes", () => {
    const valid = FIXTURES.WEBP.subarray(0, FIXTURES.WEBP.readUInt32LE(4) + 8);
    expect(inspectUnverifiedWebP(valid)).toEqual({ width: 1, height: 1 });
    const addedChunk = (name: string) => {
      const chunk = Buffer.alloc(8);
      chunk.write(name, 0, "ascii");
      const result = Buffer.concat([valid, chunk]);
      result.writeUInt32LE(result.length - 8, 4);
      return result;
    };
    for (const invalid of [
      valid.subarray(0, valid.length - 1),
      Buffer.concat([valid, Buffer.from([0])]),
      addedChunk("EXIF"),
      addedChunk("XMP "),
      addedChunk("ANIM"),
      addedChunk("ANMF"),
      addedChunk("JUNK"),
      addedChunk("VP8 "),
    ])
      expect(() => inspectUnverifiedWebP(invalid)).toThrow();
  });
});

function runFault(mode: string, highDescriptors = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "phase4d3a2a-fault-"));
  const original = join(root, "synthetic-original.bin");
  writeFileSync(original, mode, { mode: 0o400 });
  const before = readFileSync(original);
  const fd = openSync(original, "r");
  try {
    const stdio: Array<"ignore" | "pipe" | number> = highDescriptors
      ? Array(1704).fill("ignore")
      : ["ignore", "pipe", "pipe", fd, "pipe", "pipe"];
    if (highDescriptors) {
      stdio[1] = "pipe";
      stdio[2] = "pipe";
      stdio[3] = fd;
      stdio[4] = "pipe";
      stdio[5] = "pipe";
      stdio[1500] = fd;
      stdio[1601] = fd;
      stdio[1703] = fd;
    }
    const run = spawnSync(
      resolve(import.meta.dirname, "../build/image_renderer_fault_supervisor"),
      [],
      {
        stdio,
        env: { LANG: "C", LC_ALL: "C" },
        timeout: 35_000,
        maxBuffer: 5 * 1024 * 1024,
      },
    );
    return {
      status: run.status,
      error: run.error,
      stdout: run.stdout,
      binaryBytes: run.output[4]?.length,
      before,
      after: readFileSync(original),
    };
  } finally {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
}
