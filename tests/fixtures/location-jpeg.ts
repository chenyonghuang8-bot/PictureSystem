// Synthetic one-pixel JPEG and EXIF generator derived from the existing parser fixture.
const JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z",
  "base64",
);
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

export function syntheticGpsJpeg(latitude = 37.78, longitude = -122.42) {
  return injectExif(JPEG, { latitude, longitude });
}
