import { z } from "zod";

export const uploadErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "OFFSET_MISMATCH",
  "UPLOAD_STATE_CONFLICT",
  "UPLOAD_EXPIRED",
  "UPLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "STORAGE_UNAVAILABLE",
  "INSUFFICIENT_STORAGE",
  "OUTCOME_UNKNOWN",
]);

export type UploadErrorCode = z.infer<typeof uploadErrorCodeSchema>;

const messages: Readonly<Record<UploadErrorCode, string>> = {
  INVALID_REQUEST: "The upload request is invalid.",
  UNAUTHENTICATED: "Authentication is required.",
  FORBIDDEN: "The request origin is not allowed.",
  NOT_FOUND: "The upload was not found.",
  OFFSET_MISMATCH: "The upload offset does not match.",
  UPLOAD_STATE_CONFLICT: "The upload cannot be changed in its current state.",
  UPLOAD_EXPIRED: "The upload has expired.",
  UPLOAD_TOO_LARGE: "The upload exceeds the allowed size.",
  RATE_LIMITED: "Too many upload requests. Please try again later.",
  STORAGE_UNAVAILABLE: "Storage is temporarily unavailable.",
  INSUFFICIENT_STORAGE: "Storage capacity is insufficient.",
  OUTCOME_UNKNOWN: "The upload outcome is not yet known.",
};

export function createUploadErrorResponse(
  code: UploadErrorCode,
  requestId: string,
) {
  return { code, message: messages[code], requestId };
}

export const uploadStatusResponseSchema = z
  .object({
    uploadId: z.string().regex(/^[0-9a-f]{32}$/u),
    state: z.enum([
      "CREATED",
      "UPLOADING",
      "FINALIZING",
      "COMPLETE",
      "FAILED",
      "ABORTED",
      "EXPIRED",
    ]),
    declaredSize: z.string().regex(/^[1-9][0-9]*$/u),
    committedOffset: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    expiresAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    failureCode: z
      .enum([
        "STAGING_CREATE_FAILED",
        "STAGING_INTEGRITY_MISMATCH",
        "STORAGE_WRITE_FAILED",
        "FINALIZE_SIZE_MISMATCH",
        "FINALIZE_HASH_MISMATCH",
        "ORIGINAL_INTEGRITY_MISMATCH",
      ])
      .nullable(),
  })
  .strict();

export const uploadFinalizeResponseSchema = z
  .object({
    uploadId: z.string().regex(/^[0-9a-f]{32}$/u),
    state: z.literal("COMPLETE"),
    committedOffset: z.string().regex(/^[1-9][0-9]*$/u),
    completedAt: z.iso.datetime(),
  })
  .strict();
