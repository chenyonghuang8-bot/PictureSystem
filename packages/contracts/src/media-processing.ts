export const phase4MediaTypes = ["UNKNOWN", "IMAGE", "VIDEO", "OTHER"] as const;
export type Phase4MediaType = (typeof phase4MediaTypes)[number];

export const phase4ProcessingStates = [
  "PENDING",
  "PROCESSING",
  "READY",
  "PARTIAL",
  "FAILED",
  "BLOCKED",
] as const;
export type Phase4ProcessingState = (typeof phase4ProcessingStates)[number];

export const phase4CapturedSources = [
  "NONE",
  "EXIF_ORIGINAL",
  "EXIF_CREATE",
  "XMP_ORIGINAL",
  "XMP_CREATE",
  "QUICKTIME_CREATION",
  "CONTAINER_CREATION",
] as const;
export const phase4CapturedTimeStatuses = [
  "ABSENT",
  "OFFSET_KNOWN",
  "OFFSET_UNKNOWN",
] as const;
export const phase4TimelineBases = ["CAPTURE_LOCAL", "UPLOAD_UTC"] as const;

export const phase4JobTypes = [
  "MEDIA_PROBE",
  "IMAGE_DERIVATIVES",
  "VIDEO_POSTER",
] as const;
export type Phase4JobType = (typeof phase4JobTypes)[number];

export const phase4JobStates = [
  "QUEUED",
  "RUNNING",
  "RETRY_WAIT",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type Phase4JobState = (typeof phase4JobStates)[number];

export const phase4DerivedKinds = [
  "THUMBNAIL",
  "PREVIEW",
  "VIDEO_POSTER",
] as const;
export type Phase4DerivedKind = (typeof phase4DerivedKinds)[number];

export const phase4DerivedStates = [
  "RESERVED",
  "PUBLISHING",
  "READY",
  "MISSING",
  "FAILED",
] as const;
export type Phase4DerivedState = (typeof phase4DerivedStates)[number];

export const phase4FailureCodes = [
  "UNSUPPORTED_FORMAT",
  "CAPABILITY_UNAVAILABLE",
  "MALFORMED_MEDIA",
  "INPUT_LIMIT",
  "OUTPUT_LIMIT",
  "PROCESS_TIMEOUT",
  "RESOURCE_LIMIT",
  "TEMPORARY_IO",
  "STORAGE_UNAVAILABLE",
  "ORIGINAL_MISSING",
  "ORIGINAL_CORRUPT",
  "DERIVED_INTEGRITY",
  "WORKER_LOST",
  "DB_UNAVAILABLE",
  "COMMIT_OUTCOME_UNKNOWN",
] as const;
export type Phase4FailureCode = (typeof phase4FailureCodes)[number];

export const phase4WarningFlags = {
  INVALID_CAPTURE_TIME: 1n,
  INVALID_CAPTURE_OFFSET: 2n,
  INVALID_GPS: 4n,
  INVALID_ORIENTATION: 8n,
  PARTIAL_METADATA: 16n,
  UNSUPPORTED_DECODER: 32n,
  UNSUPPORTED_TRANSFORM: 64n,
  MOTION_UNPAIRED: 128n,
} as const;
