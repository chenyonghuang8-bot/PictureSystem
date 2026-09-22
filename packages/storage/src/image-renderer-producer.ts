import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { resolve } from "node:path";

import { StorageSafetyError } from "./index.js";

export type ImageProducerKind = "THUMBNAIL" | "PREVIEW";
declare const unverifiedCandidate: unique symbol;

/** A bounded producer result, expressly not a verified or publishable asset. */
export type UnverifiedRenderedCandidate = {
  readonly [unverifiedCandidate]: true;
  readonly kind: ImageProducerKind;
  readonly recipe: 1;
  readonly mime: "image/webp";
  readonly width: number;
  readonly height: number;
  readonly sha256Hex: string;
  readonly bytes: Buffer;
};

const READY = "PS_RENDER_READY_V1\n";
const CONTROL_MAX = 4096;
const STDERR_MAX = 16384;
const MAX_BY_KIND = {
  THUMBNAIL: 512 * 1024,
  PREVIEW: 4 * 1024 * 1024,
} as const;
const BOX_BY_KIND = { THUMBNAIL: 480, PREVIEW: 2560 } as const;
let heavyRenderBusy = false;

function rejectProducer(reason: string): never {
  throw new StorageSafetyError(reason);
}

export function inspectUnverifiedWebP(candidate: Buffer): {
  width: number;
  height: number;
} {
  if (
    candidate.length < 30 ||
    candidate.toString("ascii", 0, 4) !== "RIFF" ||
    candidate.toString("ascii", 8, 12) !== "WEBP" ||
    candidate.readUInt32LE(4) !== candidate.length - 8
  ) {
    return rejectProducer("RENDERER_RIFF_INVALID");
  }
  let cursor = 12;
  let chunks = 0;
  let extended: { width: number; height: number; alpha: boolean } | null = null;
  let alphaSeen = false;
  let payload: { width: number; height: number } | null = null;
  while (cursor < candidate.length) {
    if (++chunks > 3 || cursor > candidate.length - 8)
      return rejectProducer("RENDERER_RIFF_INVALID");
    const name = candidate.toString("ascii", cursor, cursor + 4);
    const length = candidate.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    const end = start + length;
    if (end > candidate.length || end + (length & 1) > candidate.length)
      return rejectProducer("RENDERER_RIFF_INVALID");
    if (length & 1 && candidate[end] !== 0)
      return rejectProducer("RENDERER_RIFF_INVALID");
    if (name === "VP8X" && chunks === 1 && length === 10) {
      const flags = candidate[start]!;
      if (
        (flags & ~0x10) !== 0 ||
        candidate[start + 1] !== 0 ||
        candidate[start + 2] !== 0 ||
        candidate[start + 3] !== 0
      )
        return rejectProducer("RENDERER_RIFF_INVALID");
      extended = {
        width: 1 + candidate.readUIntLE(start + 4, 3),
        height: 1 + candidate.readUIntLE(start + 7, 3),
        alpha: (flags & 0x10) !== 0,
      };
    } else if (
      name === "ALPH" &&
      extended !== null &&
      extended.alpha &&
      !alphaSeen &&
      payload === null &&
      length > 0
    ) {
      alphaSeen = true;
    } else if (
      name === "VP8 " &&
      payload === null &&
      length >= 10 &&
      (!extended || extended.alpha === alphaSeen)
    ) {
      if (
        candidate[start + 3] !== 0x9d ||
        candidate[start + 4] !== 0x01 ||
        candidate[start + 5] !== 0x2a
      )
        return rejectProducer("RENDERER_RIFF_INVALID");
      payload = {
        width: candidate.readUInt16LE(start + 6) & 0x3fff,
        height: candidate.readUInt16LE(start + 8) & 0x3fff,
      };
    } else {
      return rejectProducer("RENDERER_RIFF_FORBIDDEN_CHUNK");
    }
    cursor = end + (length & 1);
  }
  if (
    cursor !== candidate.length ||
    payload === null ||
    payload.width === 0 ||
    payload.height === 0 ||
    (extended &&
      (extended.width !== payload.width || extended.height !== payload.height))
  ) {
    return rejectProducer("RENDERER_RIFF_INVALID");
  }
  return payload;
}

export function parseRendererControl(
  text: string,
  kind: ImageProducerKind,
  count: number,
) {
  if (
    !text.startsWith(READY) ||
    !text.endsWith("\n") ||
    text.length > CONTROL_MAX ||
    text.slice(READY.length, -1).includes("\n")
  )
    return rejectProducer("RENDERER_CONTROL_INVALID");
  // Canonical grammar prevents duplicate JSON keys and hidden extensions.
  const match =
    /^\{"status":"ok","kind":"(THUMBNAIL|PREVIEW)","recipe":1,"mime":"image\/webp","width":([1-9][0-9]*),"height":([1-9][0-9]*),"byteCount":([1-9][0-9]*),"producerCode":"ENCODED"\}$/u.exec(
      text.slice(READY.length, -1),
    );
  if (!match) return rejectProducer("RENDERER_CONTROL_INVALID");
  const width = Number(match[2]);
  const height = Number(match[3]);
  const byteCount = Number(match[4]);
  if (
    match[1] !== kind ||
    byteCount !== count ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(byteCount) ||
    width < 1 ||
    height < 1 ||
    width > BOX_BY_KIND[kind] ||
    height > BOX_BY_KIND[kind]
  ) {
    return rejectProducer("RENDERER_CONTROL_INVALID");
  }
  return { width, height };
}

/** Fixed binary only. No path, argv, FD number, profile or encoder options. */
export async function runImageRendererProducerFd(
  fd: number,
  kind: ImageProducerKind,
): Promise<UnverifiedRenderedCandidate> {
  if (kind !== "THUMBNAIL" && kind !== "PREVIEW") {
    closeSync(fd);
    return rejectProducer("RENDERER_KIND_INVALID");
  }
  if (heavyRenderBusy) {
    closeSync(fd);
    return rejectProducer("RENDERER_BUSY");
  }
  heavyRenderBusy = true;
  try {
    const binary = resolve(
      import.meta.dirname,
      `../build/image_renderer_${kind.toLowerCase()}_supervisor`,
    );
    const maximum = MAX_BY_KIND[kind];
    const candidate = Buffer.alloc(maximum);
    const hash = createHash("sha256");
    let count = 0;
    let control = "";
    let stderrBytes = 0;
    let failed = false;
    let succeeded = false;
    try {
      return await new Promise<UnverifiedRenderedCandidate>(
        (resolveResult, reject) => {
          let child;
          try {
            child = spawn(binary, [], {
              stdio: ["ignore", "pipe", "pipe", fd, "pipe", "pipe"],
              env: { LANG: "C", LC_ALL: "C" },
            });
          } catch {
            reject(new StorageSafetyError("RENDERER_LAUNCH_FAILED"));
            return;
          }
          const abort = () => {
            if (!failed) {
              failed = true;
              child.stdio.at(5)?.destroy(); // revoke supervisor owner liveness
            }
          };
          child.stdout?.on("data", (chunk: Buffer) => {
            if (control.length + chunk.length > CONTROL_MAX) {
              abort();
              return;
            }
            control += chunk.toString("utf8");
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > STDERR_MAX) abort();
          });
          child.stdio[4]?.on("data", (chunk: Buffer) => {
            if (failed) return;
            if (chunk.length > maximum - count) {
              abort();
              return;
            }
            chunk.copy(candidate, count);
            hash.update(chunk);
            count += chunk.length;
          });
          child.once("error", () => {
            abort();
            reject(new StorageSafetyError("RENDERER_LAUNCH_FAILED"));
          });
          child.once("close", (exitCode, signal) => {
            child.stdio.at(5)?.destroy();
            if (
              failed ||
              exitCode !== 0 ||
              signal !== null ||
              count === 0 ||
              stderrBytes > STDERR_MAX
            ) {
              reject(new StorageSafetyError("RENDERER_PRODUCER_FAILED"));
              return;
            }
            try {
              const dimensions = parseRendererControl(control, kind, count);
              const actual = inspectUnverifiedWebP(
                candidate.subarray(0, count),
              );
              if (
                actual.width !== dimensions.width ||
                actual.height !== dimensions.height
              )
                rejectProducer("RENDERER_GEOMETRY_MISMATCH");
              resolveResult({
                kind,
                recipe: 1,
                mime: "image/webp",
                ...dimensions,
                sha256Hex: hash.digest("hex"),
                bytes: candidate.subarray(0, count),
              } as UnverifiedRenderedCandidate);
              succeeded = true;
            } catch {
              reject(new StorageSafetyError("RENDERER_CANDIDATE_INVALID"));
            }
          });
        },
      );
    } finally {
      closeSync(fd);
      if (!succeeded) candidate.fill(0);
    }
  } finally {
    heavyRenderBusy = false;
  }
}
