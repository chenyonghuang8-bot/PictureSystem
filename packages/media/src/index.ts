import {
  type ApprovedOriginalProbeKind,
  type OriginalReader,
  type OriginalProbeResult,
  runApprovedOriginalProbe,
  runFixedMetadataParser,
  StorageSafetyError,
} from "@family-album/storage";

export const ISOLATED_PROBE_BACKEND = "macos-sandbox-exec" as const;
export const DEV_BACKEND_ONLY = true as const;

export type OriginalIdentity = Readonly<{
  familyId: string;
  sha256Hex: string;
  byteSize: string;
}>;

export type IsolationCapabilityResult = OriginalProbeResult &
  Readonly<{ forkDenied: true; execDenied: true }>;

export type MetadataParserStatus =
  "SUCCESS" | "PARTIAL" | "UNSUPPORTED" | "INVALID_MEDIA" | "RESOURCE_LIMIT";

export type MetadataWarning =
  | "INVALID_CAPTURE_TIME"
  | "INVALID_CAPTURE_OFFSET"
  | "INVALID_GPS"
  | "INVALID_ORIENTATION"
  | "PARTIAL_METADATA";

export type NormalizedMetadataResult = Readonly<{
  parserStatus: MetadataParserStatus;
  detectedMediaType: "IMAGE" | "VIDEO" | "UNKNOWN";
  detectedMime: string;
  container: string;
  rawWidth: number | null;
  rawHeight: number | null;
  displayWidth: number | null;
  displayHeight: number | null;
  orientation: number | null;
  isAnimated: boolean;
  capturedLocalAt: string | null;
  capturedAtUtc: string | null;
  captureOffsetMinutes: number | null;
  captureTimezoneKnown: boolean;
  captureTimeSource: "NONE" | "EXIF_ORIGINAL" | "EXIF_CREATE";
  captureTimeStatus: "ABSENT" | "OFFSET_KNOWN" | "OFFSET_UNKNOWN";
  gpsLatitude: string | null;
  gpsLongitude: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  durationMs: string | null;
  rotationDegrees: 0 | 90 | 180 | 270 | null;
  videoCodec: string | null;
  warnings: readonly MetadataWarning[];
}>;

export class IsolatedProbeRunner {
  #enabled = false;
  readonly backend = ISOLATED_PROBE_BACKEND;

  constructor(options: { allowDevBackend: boolean }) {
    if (!options.allowDevBackend || process.env.NODE_ENV === "production") {
      throw new StorageSafetyError("ISOLATED_PROBE_DEV_BACKEND_DISABLED");
    }
  }

  get enabled() {
    return this.#enabled;
  }

  async verifyCapabilities(
    reader: OriginalReader,
    identity: OriginalIdentity,
  ): Promise<IsolationCapabilityResult> {
    this.#enabled = false;
    try {
      const result = await runCapabilityStage(reader, identity, "capabilities");
      const fork = await runCapabilityStage(reader, identity, "fork-denied");
      const exec = await runCapabilityStage(reader, identity, "exec-denied");
      if (!("denied" in fork) || !("denied" in exec)) {
        throw new StorageSafetyError("ISOLATION_PROCESS_DENIAL_FAILED");
      }
      if (!("ok" in result)) {
        throw new StorageSafetyError("ISOLATION_CAPABILITY_PROTOCOL_INVALID");
      }
      this.#enabled = true;
      return { ...result, forkDenied: true, execDenied: true } as const;
    } catch (error) {
      this.#enabled = false;
      throw error;
    }
  }

  async runDiagnostic(
    reader: OriginalReader,
    identity: OriginalIdentity,
    kind: Exclude<ApprovedOriginalProbeKind, "capabilities">,
    options: { timeoutMs?: number } = {},
  ) {
    if (!this.#enabled) {
      throw new StorageSafetyError("ISOLATED_PROBE_BACKEND_DISABLED");
    }
    return reader.withVerifiedOriginal(identity, (handle) =>
      runApprovedOriginalProbe(handle, kind, options),
    );
  }

  async probeMetadata(
    reader: OriginalReader,
    input: OriginalIdentity & { captureUpperBoundUtc: string },
    options: { timeoutMs?: number } = {},
  ): Promise<NormalizedMetadataResult> {
    if (!this.#enabled) {
      throw new StorageSafetyError("ISOLATED_PROBE_BACKEND_DISABLED");
    }
    const upperBound = parseUpperBound(input.captureUpperBoundUtc);
    const raw = await reader.withVerifiedOriginal(input, (handle) =>
      runFixedMetadataParser(handle, options),
    );
    return normalizeMetadataResult(raw, upperBound);
  }
}

async function runCapabilityStage(
  reader: OriginalReader,
  identity: OriginalIdentity,
  kind: "capabilities" | "fork-denied" | "exec-denied",
) {
  try {
    return await reader.withVerifiedOriginal(identity, (handle) =>
      runApprovedOriginalProbe(handle, kind),
    );
  } catch (error) {
    throw new StorageSafetyError(
      `ISOLATION_${kind.replaceAll("-", "_").toUpperCase()}_FAILED:${
        error instanceof StorageSafetyError ? error.reason : "UNKNOWN"
      }`,
    );
  }
}

type RawCaptureCandidate = Readonly<{
  source: "EXIF_ORIGINAL" | "EXIF_CREATE";
  local: string;
  offset: string | null;
  subsecond: string | null;
}>;

type RawMetadataResult = Readonly<{
  schemaVersion: 1;
  parserStatus: MetadataParserStatus;
  detectedMediaType: "IMAGE" | "VIDEO" | "UNKNOWN";
  detectedMime: string;
  container: string;
  width: number | null;
  height: number | null;
  orientationRaw: number | null;
  isAnimated: boolean;
  captureCandidates: readonly RawCaptureCandidate[];
  gpsLatitudeRaw: number | null;
  gpsLongitudeRaw: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  durationMs: string | null;
  rotationDegrees: number | null;
  videoCodec: string | null;
  warnings: readonly MetadataWarning[];
}>;

const RAW_KEYS = [
  "schemaVersion",
  "parserStatus",
  "detectedMediaType",
  "detectedMime",
  "container",
  "width",
  "height",
  "orientationRaw",
  "isAnimated",
  "captureCandidates",
  "gpsLatitudeRaw",
  "gpsLongitudeRaw",
  "cameraMake",
  "cameraModel",
  "durationMs",
  "rotationDegrees",
  "videoCodec",
  "warnings",
] as const;

const PARSER_STATUSES = new Set<MetadataParserStatus>([
  "SUCCESS",
  "PARTIAL",
  "UNSUPPORTED",
  "INVALID_MEDIA",
  "RESOURCE_LIMIT",
]);
const MEDIA_TYPES = new Set(["IMAGE", "VIDEO", "UNKNOWN"] as const);
const CONTAINERS = new Set([
  "JPEG",
  "PNG",
  "WEBP",
  "GIF",
  "HEIC",
  "DNG_RAW",
  "MP4",
  "MOV",
  "UNKNOWN",
]);
const MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/x-adobe-dng",
  "video/mp4",
  "video/quicktime",
  "application/octet-stream",
]);
const CHILD_WARNINGS = new Set<MetadataWarning>([
  "INVALID_GPS",
  "PARTIAL_METADATA",
]);
const CAPTURE_SOURCES = new Set(["EXIF_ORIGINAL", "EXIF_CREATE"] as const);

function normalizeMetadataResult(
  value: unknown,
  upperBoundMs: number,
): NormalizedMetadataResult {
  const raw = validateRawMetadata(value);
  const warnings = [...raw.warnings];
  const addWarning = (warning: MetadataWarning) => {
    if (!warnings.includes(warning) && warnings.length < 8)
      warnings.push(warning);
  };
  let orientation: number | null = null;
  if (raw.orientationRaw !== null) {
    if (
      Number.isInteger(raw.orientationRaw) &&
      raw.orientationRaw >= 1 &&
      raw.orientationRaw <= 8
    ) {
      orientation = raw.orientationRaw;
    } else {
      addWarning("INVALID_ORIENTATION");
    }
  }
  const swap = orientation !== null && orientation >= 5;
  const capture = normalizeCapture(
    raw.captureCandidates,
    upperBoundMs,
    addWarning,
  );
  let gpsLatitude: string | null = null;
  let gpsLongitude: string | null = null;
  if (raw.gpsLatitudeRaw !== null || raw.gpsLongitudeRaw !== null) {
    if (
      raw.gpsLatitudeRaw !== null &&
      raw.gpsLongitudeRaw !== null &&
      Number.isFinite(raw.gpsLatitudeRaw) &&
      Number.isFinite(raw.gpsLongitudeRaw) &&
      raw.gpsLatitudeRaw >= -90 &&
      raw.gpsLatitudeRaw <= 90 &&
      raw.gpsLongitudeRaw >= -180 &&
      raw.gpsLongitudeRaw <= 180
    ) {
      gpsLatitude = normalizeSignedZero(raw.gpsLatitudeRaw).toFixed(6);
      gpsLongitude = normalizeSignedZero(raw.gpsLongitudeRaw).toFixed(6);
    } else {
      addWarning("INVALID_GPS");
    }
  }
  return {
    parserStatus: raw.parserStatus,
    detectedMediaType: raw.detectedMediaType,
    detectedMime: raw.detectedMime,
    container: raw.container,
    rawWidth: raw.width,
    rawHeight: raw.height,
    displayWidth: swap ? raw.height : raw.width,
    displayHeight: swap ? raw.width : raw.height,
    orientation,
    isAnimated: raw.isAnimated,
    ...capture,
    gpsLatitude,
    gpsLongitude,
    cameraMake: raw.cameraMake,
    cameraModel: raw.cameraModel,
    durationMs: raw.durationMs,
    rotationDegrees: isRotation(raw.rotationDegrees)
      ? raw.rotationDegrees
      : null,
    videoCodec: raw.videoCodec,
    warnings,
  };
}

function validateRawMetadata(value: unknown): RawMetadataResult {
  if (!isRecord(value) || !hasExactKeys(value, RAW_KEYS)) protocolError();
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.parserStatus !== "string" ||
    !PARSER_STATUSES.has(record.parserStatus as MetadataParserStatus) ||
    typeof record.detectedMediaType !== "string" ||
    !MEDIA_TYPES.has(
      record.detectedMediaType as "IMAGE" | "VIDEO" | "UNKNOWN",
    ) ||
    typeof record.detectedMime !== "string" ||
    !MIME_TYPES.has(record.detectedMime) ||
    typeof record.container !== "string" ||
    !CONTAINERS.has(record.container) ||
    !isDimension(record.width) ||
    !isDimension(record.height) ||
    (record.width === null) !== (record.height === null) ||
    !isNullableFiniteNumber(record.orientationRaw) ||
    typeof record.isAnimated !== "boolean" ||
    !Array.isArray(record.captureCandidates) ||
    record.captureCandidates.length > 4 ||
    !record.captureCandidates.every(isCaptureCandidate) ||
    !isNullableFiniteNumber(record.gpsLatitudeRaw) ||
    !isNullableFiniteNumber(record.gpsLongitudeRaw) ||
    !isBoundedText(record.cameraMake, 128) ||
    !isBoundedText(record.cameraModel, 128) ||
    !isDecimalOrNull(record.durationMs) ||
    !isNullableFiniteNumber(record.rotationDegrees) ||
    !isBoundedText(record.videoCodec, 32) ||
    !Array.isArray(record.warnings) ||
    record.warnings.length > 8 ||
    !record.warnings.every(
      (warning) =>
        typeof warning === "string" &&
        CHILD_WARNINGS.has(warning as MetadataWarning),
    )
  ) {
    protocolError();
  }
  if (
    record.width !== null &&
    record.height !== null &&
    record.width * record.height > 50_000_000
  ) {
    protocolError();
  }
  return value as RawMetadataResult;
}

function isCaptureCandidate(value: unknown): value is RawCaptureCandidate {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["source", "local", "offset", "subsecond"] as const)
  )
    return false;
  return (
    typeof value.source === "string" &&
    CAPTURE_SOURCES.has(value.source as RawCaptureCandidate["source"]) &&
    typeof value.local === "string" &&
    Buffer.byteLength(value.local, "utf8") <= 64 &&
    (value.offset === null ||
      (typeof value.offset === "string" &&
        Buffer.byteLength(value.offset, "utf8") <= 16)) &&
    (value.subsecond === null ||
      (typeof value.subsecond === "string" &&
        Buffer.byteLength(value.subsecond, "utf8") <= 16))
  );
}

function normalizeCapture(
  candidates: readonly RawCaptureCandidate[],
  upperBoundMs: number,
  addWarning: (warning: MetadataWarning) => void,
) {
  for (const candidate of candidates) {
    const local = parseExifLocal(candidate.local, candidate.subsecond);
    if (
      local === null ||
      local.calendarMs < Date.UTC(1900, 0, 1) ||
      local.calendarMs > upperBoundMs
    ) {
      addWarning("INVALID_CAPTURE_TIME");
      continue;
    }
    const offset = parseOffset(candidate.offset);
    if (candidate.offset !== null && offset === null)
      addWarning("INVALID_CAPTURE_OFFSET");
    if (offset === null) {
      return {
        capturedLocalAt: local.text,
        capturedAtUtc: null,
        captureOffsetMinutes: null,
        captureTimezoneKnown: false,
        captureTimeSource: candidate.source,
        captureTimeStatus: "OFFSET_UNKNOWN" as const,
      };
    }
    const utcMs = local.calendarMs - offset * 60_000;
    if (utcMs < Date.UTC(1900, 0, 1) || utcMs > upperBoundMs) {
      addWarning("INVALID_CAPTURE_TIME");
      continue;
    }
    return {
      capturedLocalAt: local.text,
      capturedAtUtc: formatUtc(utcMs),
      captureOffsetMinutes: offset,
      captureTimezoneKnown: true,
      captureTimeSource: candidate.source,
      captureTimeStatus: "OFFSET_KNOWN" as const,
    };
  }
  return {
    capturedLocalAt: null,
    capturedAtUtc: null,
    captureOffsetMinutes: null,
    captureTimezoneKnown: false,
    captureTimeSource: "NONE" as const,
    captureTimeStatus: "ABSENT" as const,
  };
}

function parseExifLocal(value: string, subsecond: string | null) {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(
    value,
  );
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number) as [number, number, number, number, number, number];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  const millisecond =
    subsecond !== null && /^\d{1,9}$/u.test(subsecond)
      ? Number(`${subsecond}000`.slice(0, 3))
      : 0;
  const calendarMs = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  const checked = new Date(calendarMs);
  if (
    checked.getUTCFullYear() !== year ||
    checked.getUTCMonth() !== month - 1 ||
    checked.getUTCDate() !== day ||
    checked.getUTCHours() !== hour ||
    checked.getUTCMinutes() !== minute ||
    checked.getUTCSeconds() !== second
  )
    return null;
  return { calendarMs, text: formatUtc(calendarMs) };
}

function parseOffset(value: string | null) {
  if (value === null) return null;
  if (value === "Z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0))
    return null;
  const amount = hours * 60 + minutes;
  return match[1] === "-" ? -amount : amount;
}

function parseUpperBound(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new StorageSafetyError("CAPTURE_UPPER_BOUND_INVALID");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new StorageSafetyError("CAPTURE_UPPER_BOUND_INVALID");
  }
  return parsed + 48 * 60 * 60 * 1_000;
}

function formatUtc(value: number) {
  return new Date(value).toISOString().replace("T", " ").replace("Z", "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys<const T extends readonly string[]>(
  value: Record<string, unknown>,
  keys: T,
) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isDimension(value: unknown): value is number | null {
  return (
    value === null ||
    (Number.isSafeInteger(value) &&
      (value as number) > 0 &&
      (value as number) <= 16_384)
  );
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      !Object.is(value, -0))
  );
}

function isBoundedText(
  value: unknown,
  maximumBytes: number,
): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      Buffer.byteLength(value, "utf8") <= maximumBytes &&
      !hasForbiddenTextCodePoint(value))
  );
}

function hasForbiddenTextCodePoint(value: string) {
  return [...value].some((character) => {
    const scalar = character.codePointAt(0)!;
    return (
      scalar <= 0x1f ||
      (scalar >= 0x7f && scalar <= 0x9f) ||
      (scalar >= 0x200b && scalar <= 0x200f) ||
      (scalar >= 0x202a && scalar <= 0x202e) ||
      (scalar >= 0x2066 && scalar <= 0x2069) ||
      scalar === 0xfeff
    );
  });
}

function isDecimalOrNull(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && /^(0|[1-9]\d{0,15})$/u.test(value))
  );
}

function isRotation(value: number | null): value is 0 | 90 | 180 | 270 {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

function normalizeSignedZero(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

function protocolError(): never {
  throw new StorageSafetyError("METADATA_PROTOCOL_INVALID");
}
