import { hasMalformedUnicode } from "@family-album/auth";

const MIME_TABLE = {
  "image/jpeg": { contentType: "image/jpeg", extension: "jpg" },
  "image/png": { contentType: "image/png", extension: "png" },
  "image/webp": { contentType: "image/webp", extension: "webp" },
  "image/gif": { contentType: "image/gif", extension: "gif" },
  "image/heic": { contentType: "image/heic", extension: "heic" },
  "image/heif": { contentType: "image/heif", extension: "heif" },
  "video/mp4": { contentType: "video/mp4", extension: "mp4" },
  "video/quicktime": { contentType: "video/quicktime", extension: "mov" },
} as const;

export type OriginalMimeDecision = {
  contentType: string;
  extension: string;
};

export function decideOriginalMime(
  detectedMime: string | null,
): OriginalMimeDecision {
  if (detectedMime && Object.hasOwn(MIME_TABLE, detectedMime)) {
    return MIME_TABLE[detectedMime as keyof typeof MIME_TABLE];
  }
  return { contentType: "application/octet-stream", extension: "bin" };
}

export function originalContentDisposition(input: {
  originalFilename: string;
  mediaId: string;
  extension: string;
}) {
  const fallback = `media-${input.mediaId}.${input.extension}`;
  const stem = safeDisplayStem(input.originalFilename);
  const display = stem ? `${stem}.${input.extension}` : fallback;
  const value = `attachment; filename="${fallback}"; filename*=UTF-8''${encode5987(display)}`;
  if (Buffer.byteLength(value, "utf8") <= 512) return value;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encode5987(fallback)}`;
}

function safeDisplayStem(originalFilename: string) {
  if (hasMalformedUnicode(originalFilename)) return null;
  const component = originalFilename.split(/[\\/]/u).at(-1) ?? "";
  const dot = component.lastIndexOf(".");
  const withoutExtension = dot > 0 ? component.slice(0, dot) : component;
  const cleaned = withoutExtension
    .replace(/[\p{Cc}\p{Cf}"\\/]/gu, " ")
    .replace(/^[\p{White_Space}.]+|[\p{White_Space}.]+$/gu, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return truncateUtf8(cleaned, 120);
}

function truncateUtf8(value: string, maximumBytes: number) {
  let output = "";
  let bytes = 0;
  for (const codePoint of value) {
    const width = Buffer.byteLength(codePoint, "utf8");
    if (bytes + width > maximumBytes) break;
    output += codePoint;
    bytes += width;
  }
  return output || null;
}

function encode5987(value: string) {
  let output = "";
  for (const byte of Buffer.from(value, "utf8")) {
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      [
        0x21, 0x23, 0x24, 0x26, 0x2b, 0x2d, 0x2e, 0x5e, 0x5f, 0x60, 0x7c, 0x7e,
      ].includes(byte)
    ) {
      output += String.fromCharCode(byte);
    } else {
      output += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return output;
}
