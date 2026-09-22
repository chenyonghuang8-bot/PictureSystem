import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OriginalReader, StorageRoot } from "@family-album/storage";

import { IsolatedProbeRunner } from "./index.js";

const FIXTURES = {
  JPEG: Buffer.from(
    "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z",
    "base64",
  ),
  PNG: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==",
    "base64",
  ),
  WEBP: Buffer.from(
    "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=",
    "base64",
  ),
  GIF: Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    "base64",
  ),
} as const;

describe("Phase 4D1 isolated metadata parser", () => {
  let fixtureBase: string;
  let mediaRoot: string;
  let writer: StorageRoot;
  let reader: OriginalReader;
  let runner: IsolatedProbeRunner;
  let heicFixtureGenerated = false;
  const originals = new Map<string, ReturnType<typeof publish>>();

  beforeAll(async () => {
    fixtureBase = mkdtempSync(
      join(realpathSync(tmpdir()), "phase4d1-metadata-"),
    );
    mediaRoot = join(fixtureBase, "media");
    writer = StorageRoot.open(mediaRoot, { initialize: true });
    let index = 1;
    for (const [name, bytes] of Object.entries(FIXTURES) as [
      keyof typeof FIXTURES,
      Buffer,
    ][]) {
      originals.set(name, publish(writer, mediaRoot, bytes, index));
      index += 1;
    }
    const jpeg = FIXTURES.JPEG;
    originals.set(
      "EXIF",
      publish(
        writer,
        mediaRoot,
        injectExif(jpeg, {
          orientation: 6,
          make: `Synthetic${String.fromCharCode(0x1b)} Camera`,
          model: "Model A",
          original: "2024:02:29 12:34:56",
          originalOffset: "+05:30",
          originalSubsecond: "1234",
          latitude: 12.5,
          longitude: -45.25,
        }),
        index++,
      ),
    );
    originals.set(
      "NO_OFFSET",
      publish(
        writer,
        mediaRoot,
        injectExif(jpeg, { original: "2024:01:02 03:04:05" }),
        index++,
      ),
    );
    originals.set(
      "INVALID_FIELDS",
      publish(
        writer,
        mediaRoot,
        injectExif(jpeg, {
          orientation: 9,
          original: "2023:02:29 25:00:00",
          originalOffset: "+15:00",
          create: "2024:03:01 04:05:06",
          latitude: 91,
        }),
        index++,
      ),
    );
    originals.set(
      "INVALID_OFFSET",
      publish(
        writer,
        mediaRoot,
        injectExif(jpeg, {
          original: "2024:03:01 04:05:06",
          originalOffset: "+15:00",
        }),
        index++,
      ),
    );
    originals.set(
      "MALFORMED_EXIF",
      publish(
        writer,
        mediaRoot,
        Buffer.concat([
          jpeg.subarray(0, 2),
          Buffer.from([0xff, 0xe1, 0x00, 0x0b]),
          Buffer.from("Exif\0\0bad", "binary"),
          jpeg.subarray(2),
        ]),
        index++,
      ),
    );
    originals.set(
      "HUGE_TEXT",
      publish(
        writer,
        mediaRoot,
        injectExif(jpeg, { make: "A".repeat(300), model: "B".repeat(300) }),
        index++,
      ),
    );
    originals.set(
      "XMP_ONLY",
      publish(writer, mediaRoot, injectXmp(jpeg), index++),
    );
    originals.set(
      "TRUNCATED",
      publish(writer, mediaRoot, jpeg.subarray(0, 30), index++),
    );
    originals.set(
      "UNKNOWN",
      publish(writer, mediaRoot, Buffer.from("not media"), index++),
    );
    const heicInput = join(fixtureBase, "synthetic.png");
    const heicOutput = join(fixtureBase, "synthetic.heic");
    writeFileSync(heicInput, FIXTURES.PNG, { mode: 0o600 });
    const heicGeneration = spawnSync(
      "/usr/bin/sips",
      ["-s", "format", "heic", heicInput, "--out", heicOutput],
      { env: { PATH: "/usr/bin:/bin", LANG: "C" }, encoding: "utf8" },
    );
    heicFixtureGenerated = heicGeneration.status === 0;
    originals.set(
      "HEIC",
      publish(
        writer,
        mediaRoot,
        heicFixtureGenerated ? readFileSync(heicOutput) : isoBrand("heic"),
        index++,
      ),
    );
    originals.set("MP4", publish(writer, mediaRoot, isoBrand("isom"), index++));
    originals.set("MOV", publish(writer, mediaRoot, isoBrand("qt  "), index++));
    originals.set(
      "DNG",
      publish(writer, mediaRoot, standaloneTiff(32, 24), index++),
    );
    originals.set(
      "HUGE",
      publish(writer, mediaRoot, standaloneTiff(20_000, 20_000), index),
    );
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: writer.markerId,
    });
    runner = new IsolatedProbeRunner({ allowDevBackend: true });
    await runner.verifyCapabilities(reader, originals.get("PNG")!.identity);
  });

  afterAll(() => {
    reader.close();
    writer.close();
    expect(relative(realpathSync(tmpdir()), fixtureBase)).toMatch(
      /^phase4d1-metadata-[^/]+$/u,
    );
    rmSync(fixtureBase, { recursive: true, force: true });
  });

  it.each([
    ["JPEG", "image/jpeg", "JPEG"],
    ["PNG", "image/png", "PNG"],
    ["WEBP", "image/webp", "WEBP"],
    ["GIF", "image/gif", "GIF"],
  ] as const)(
    "parses synthetic %s through FD 3 without modifying it",
    async (name, mime, container) => {
      const original = originals.get(name)!;
      const before = snapshot(original.path);
      const result = await runner.probeMetadata(reader, {
        ...original.identity,
        captureUpperBoundUtc: "2030-01-01T00:00:00.000Z",
      });
      expect(result).toMatchObject({
        parserStatus: "SUCCESS",
        detectedMediaType: "IMAGE",
        detectedMime: mime,
        container,
        rawWidth: 1,
        rawHeight: 1,
        displayWidth: 1,
        displayHeight: 1,
        captureTimeStatus: "ABSENT",
        gpsLatitude: null,
        gpsLongitude: null,
      });
      expect(snapshot(original.path)).toEqual(before);
    },
  );

  it("fails closed before parsing when the runner capability gate is disabled", async () => {
    const disabled = new IsolatedProbeRunner({ allowDevBackend: true });
    const original = originals.get("PNG")!;
    await expect(
      disabled.probeMetadata(reader, {
        ...original.identity,
        captureUpperBoundUtc: "2030-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/BACKEND_DISABLED/u);
  });

  it("normalizes EXIF orientation, offset time, GPS and bounded camera text", async () => {
    const result = await probe("EXIF");
    expect(result).toMatchObject({
      parserStatus: "SUCCESS",
      orientation: 6,
      capturedLocalAt: "2024-02-29 12:34:56.123",
      capturedAtUtc: "2024-02-29 07:04:56.123",
      captureOffsetMinutes: 330,
      captureTimezoneKnown: true,
      captureTimeSource: "EXIF_ORIGINAL",
      captureTimeStatus: "OFFSET_KNOWN",
      gpsLatitude: "12.500000",
      gpsLongitude: "-45.250000",
      cameraMake: "Synthetic Camera",
      cameraModel: "Model A",
    });
  });

  it("preserves timezone-unknown device wall time without using server timezone", async () => {
    const before = process.env.TZ;
    process.env.TZ = "Pacific/Honolulu";
    try {
      const result = await probe("NO_OFFSET");
      expect(result).toMatchObject({
        capturedLocalAt: "2024-01-02 03:04:05.000",
        capturedAtUtc: null,
        captureOffsetMinutes: null,
        captureTimezoneKnown: false,
        captureTimeStatus: "OFFSET_UNKNOWN",
      });
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("rejects invalid optional metadata without turning a valid image into corrupt storage", async () => {
    const result = await probe("INVALID_FIELDS");
    expect(result).toMatchObject({
      parserStatus: "SUCCESS",
      orientation: null,
      capturedLocalAt: "2024-03-01 04:05:06.000",
      captureTimeSource: "EXIF_CREATE",
      gpsLatitude: null,
      gpsLongitude: null,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "INVALID_CAPTURE_TIME",
        "INVALID_GPS",
        "INVALID_ORIENTATION",
      ]),
    );
  });

  it("retains a valid local time but rejects an invalid timezone offset", async () => {
    const result = await probe("INVALID_OFFSET");
    expect(result).toMatchObject({
      capturedLocalAt: "2024-03-01 04:05:06.000",
      capturedAtUtc: null,
      captureOffsetMinutes: null,
      captureTimeStatus: "OFFSET_UNKNOWN",
    });
    expect(result.warnings).toContain("INVALID_CAPTURE_OFFSET");
  });

  it("ignores malformed EXIF while preserving valid image metadata", async () => {
    expect(await probe("MALFORMED_EXIF")).toMatchObject({
      parserStatus: "SUCCESS",
      rawWidth: 1,
      rawHeight: 1,
      capturedLocalAt: null,
    });
  });

  it("bounds and sanitizes attacker-controlled camera strings", async () => {
    const result = await probe("HUGE_TEXT");
    expect(Buffer.byteLength(result.cameraMake!, "utf8")).toBe(128);
    expect(Buffer.byteLength(result.cameraModel!, "utf8")).toBe(128);
    expect([...result.cameraMake!].some(isControlCharacter)).toBe(false);
  });

  it("reports XMP-only metadata as partial instead of silently claiming full support", async () => {
    const result = await probe("XMP_ONLY");
    expect(result.parserStatus).toBe("PARTIAL");
    expect(result.warnings).toContain("PARTIAL_METADATA");
  });

  it.each([
    ["TRUNCATED", "INVALID_MEDIA"],
    ["UNKNOWN", "INVALID_MEDIA"],
    ["HUGE", "RESOURCE_LIMIT"],
  ] as const)("returns controlled %s failure status", async (name, status) => {
    const result = await probe(name);
    expect(result.parserStatus).toBe(status);
  });

  it("reports runtime capabilities without path-based fallback", async () => {
    const heic = await probe("HEIC");
    expect(heic.detectedMime).toBe("image/heic");
    if (heicFixtureGenerated) {
      expect(heic).toMatchObject({
        parserStatus: "PARTIAL",
        rawWidth: 1,
        rawHeight: 1,
      });
    } else {
      expect(["UNSUPPORTED", "INVALID_MEDIA"]).toContain(heic.parserStatus);
    }
    expect(await probe("DNG")).toMatchObject({
      detectedMime: "image/x-adobe-dng",
      parserStatus: "PARTIAL",
      rawWidth: 32,
      rawHeight: 24,
    });
    expect(await probe("MP4")).toMatchObject({
      detectedMediaType: "VIDEO",
      parserStatus: "UNSUPPORTED",
    });
    expect(await probe("MOV")).toMatchObject({
      detectedMediaType: "VIDEO",
      parserStatus: "UNSUPPORTED",
    });
  });

  async function probe(name: string) {
    const original = originals.get(name)!;
    const before = snapshot(original.path);
    const result = await runner.probeMetadata(reader, {
      ...original.identity,
      captureUpperBoundUtc: "2030-01-01T00:00:00.000Z",
    });
    expect(snapshot(original.path)).toEqual(before);
    return result;
  }
});

function publish(
  writer: StorageRoot,
  mediaRoot: string,
  bytes: Buffer,
  index: number,
) {
  const uploadId = index.toString(16).padStart(32, "0");
  const identity = {
    familyId: "1",
    sha256Hex: createHash("sha256").update(bytes).digest("hex"),
    byteSize: String(bytes.length),
  };
  writer.createUploadPayload("1", uploadId, bytes);
  const published = writer.publishOriginal({ ...identity, uploadId });
  return { identity, path: join(mediaRoot, published.relativePath) };
}

function snapshot(path: string) {
  const stats = lstatSync(path, { bigint: true });
  const bytes = readFileSync(path);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    path,
    ino: stats.ino,
    mode: stats.mode & 0o777n,
    mtimeNs: stats.mtimeNs,
  };
}

function isControlCharacter(character: string) {
  const scalar = character.codePointAt(0)!;
  return scalar <= 0x1f || (scalar >= 0x7f && scalar <= 0x9f);
}

type ExifOptions = Readonly<{
  orientation?: number;
  make?: string;
  model?: string;
  original?: string;
  originalOffset?: string;
  originalSubsecond?: string;
  create?: string;
  latitude?: number;
  longitude?: number;
}>;

function injectExif(jpeg: Buffer, options: ExifOptions) {
  const tiff = exifTiff(options);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

function injectXmp(jpeg: Buffer) {
  const payload = Buffer.from(
    "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:RDF/></x:xmpmeta>",
    "utf8",
  );
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

type TiffEntry = Readonly<{
  tag: number;
  type: 1 | 2 | 3 | 4 | 5;
  count: number;
  data?: Buffer;
  direct?: number;
}>;

function exifTiff(options: ExifOptions) {
  const exifEntries: TiffEntry[] = [];
  if (options.original !== undefined) {
    exifEntries.push(asciiEntry(0x9003, options.original));
  }
  if (options.originalOffset !== undefined) {
    exifEntries.push(asciiEntry(0x9011, options.originalOffset));
  }
  if (options.originalSubsecond !== undefined) {
    exifEntries.push(asciiEntry(0x9291, options.originalSubsecond));
  }
  if (options.create !== undefined) {
    exifEntries.push(asciiEntry(0x9004, options.create));
  }
  const gpsEntries: TiffEntry[] = [];
  if (options.latitude !== undefined) {
    gpsEntries.push(asciiEntry(1, options.latitude < 0 ? "S" : "N"));
    gpsEntries.push(rationalCoordinateEntry(2, Math.abs(options.latitude)));
  }
  if (options.longitude !== undefined) {
    gpsEntries.push(asciiEntry(3, options.longitude < 0 ? "W" : "E"));
    gpsEntries.push(rationalCoordinateEntry(4, Math.abs(options.longitude)));
  }
  const ifd0: TiffEntry[] = [];
  if (options.make !== undefined) ifd0.push(asciiEntry(0x010f, options.make));
  if (options.model !== undefined) ifd0.push(asciiEntry(0x0110, options.model));
  if (options.orientation !== undefined)
    ifd0.push(shortEntry(0x0112, options.orientation));
  const ifd0Offset = 8;
  const ifd0Size = ifdSize(
    ifd0.length +
      (exifEntries.length > 0 ? 1 : 0) +
      (gpsEntries.length > 0 ? 1 : 0),
  );
  const exifOffset = ifd0Offset + ifd0Size;
  const gpsOffset =
    exifOffset + (exifEntries.length > 0 ? ifdSize(exifEntries.length) : 0);
  if (exifEntries.length > 0)
    ifd0.push({ tag: 0x8769, type: 4, count: 1, direct: exifOffset });
  if (gpsEntries.length > 0)
    ifd0.push({ tag: 0x8825, type: 4, count: 1, direct: gpsOffset });
  const dataStart =
    gpsOffset + (gpsEntries.length > 0 ? ifdSize(gpsEntries.length) : 0);
  const dataSize = [...ifd0, ...exifEntries, ...gpsEntries]
    .filter((entry) => entry.data !== undefined && entry.data.length > 4)
    .reduce((total, entry) => total + entry.data!.length, 0);
  const output = Buffer.alloc(dataStart + dataSize);
  output.write("II", 0, "ascii");
  output.writeUInt16LE(42, 2);
  output.writeUInt32LE(ifd0Offset, 4);
  let cursor = dataStart;
  cursor = writeIfd(output, ifd0Offset, ifd0, cursor);
  if (exifEntries.length > 0)
    cursor = writeIfd(output, exifOffset, exifEntries, cursor);
  if (gpsEntries.length > 0) writeIfd(output, gpsOffset, gpsEntries, cursor);
  return output;
}

function standaloneTiff(width: number, height: number) {
  const dataOffset = 8 + ifdSize(10);
  const declaredBytes = width * height;
  const actualBytes = declaredBytes <= 1_000_000 ? declaredBytes : 1;
  const entries: TiffEntry[] = [
    { tag: 0x0100, type: 4, count: 1, direct: width },
    { tag: 0x0101, type: 4, count: 1, direct: height },
    { tag: 0x0102, type: 3, count: 1, direct: 8 },
    { tag: 0x0103, type: 3, count: 1, direct: 1 },
    { tag: 0x0106, type: 3, count: 1, direct: 1 },
    { tag: 0x0111, type: 4, count: 1, direct: dataOffset },
    { tag: 0x0115, type: 3, count: 1, direct: 1 },
    { tag: 0x0116, type: 4, count: 1, direct: height },
    { tag: 0x0117, type: 4, count: 1, direct: declaredBytes },
    { tag: 0xc612, type: 1, count: 4, data: Buffer.from([1, 4, 0, 0]) },
  ];
  const output = Buffer.alloc(dataOffset + actualBytes);
  output.write("II", 0, "ascii");
  output.writeUInt16LE(42, 2);
  output.writeUInt32LE(8, 4);
  writeIfd(output, 8, entries, dataOffset);
  return output;
}

function writeIfd(
  output: Buffer,
  offset: number,
  entries: readonly TiffEntry[],
  initialDataOffset: number,
) {
  output.writeUInt16LE(entries.length, offset);
  let dataOffset = initialDataOffset;
  entries.forEach((entry, index) => {
    const position = offset + 2 + index * 12;
    output.writeUInt16LE(entry.tag, position);
    output.writeUInt16LE(entry.type, position + 2);
    output.writeUInt32LE(entry.count, position + 4);
    if (entry.direct !== undefined) {
      if (entry.type === 3) output.writeUInt16LE(entry.direct, position + 8);
      else output.writeUInt32LE(entry.direct, position + 8);
    } else if (entry.data !== undefined && entry.data.length <= 4) {
      entry.data.copy(output, position + 8);
    } else if (entry.data !== undefined) {
      output.writeUInt32LE(dataOffset, position + 8);
      entry.data.copy(output, dataOffset);
      dataOffset += entry.data.length;
    }
  });
  output.writeUInt32LE(0, offset + 2 + entries.length * 12);
  return dataOffset;
}

function asciiEntry(tag: number, value: string): TiffEntry {
  const data = Buffer.from(`${value}\0`, "ascii");
  return { tag, type: 2, count: data.length, data };
}

function shortEntry(tag: number, value: number): TiffEntry {
  return { tag, type: 3, count: 1, direct: value };
}

function rationalCoordinateEntry(tag: number, value: number): TiffEntry {
  const degrees = Math.floor(value);
  const minutesFloat = (value - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = Math.round((minutesFloat - minutes) * 60 * 1_000_000);
  const data = Buffer.alloc(24);
  for (const [index, numerator, denominator] of [
    [0, degrees, 1],
    [1, minutes, 1],
    [2, seconds, 1_000_000],
  ] as const) {
    data.writeUInt32LE(numerator, index * 8);
    data.writeUInt32LE(denominator, index * 8 + 4);
  }
  return { tag, type: 5, count: 3, data };
}

function ifdSize(entries: number) {
  return 2 + entries * 12 + 4;
}

function isoBrand(brand: string) {
  const output = Buffer.alloc(24);
  output.writeUInt32BE(24, 0);
  output.write("ftyp", 4, "ascii");
  output.write(brand, 8, "ascii");
  output.writeUInt32BE(0, 12);
  output.write(brand, 16, "ascii");
  return output;
}
