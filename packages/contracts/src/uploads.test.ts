import { describe, expect, it } from "vitest";

import {
  createUploadErrorResponse,
  uploadStatusResponseSchema,
} from "./uploads.js";

describe("Phase 3C upload contracts", () => {
  it("keeps BIGINT fields as canonical decimal strings", () => {
    const result = uploadStatusResponseSchema.parse({
      uploadId: "a".repeat(32),
      state: "UPLOADING",
      declaredSize: "9007199254740993",
      committedOffset: "9007199254740992",
      expiresAt: "2026-09-15T00:00:00.000Z",
      completedAt: null,
      failureCode: null,
    });
    expect(result.declaredSize).toBe("9007199254740993");
    expect(() =>
      uploadStatusResponseSchema.parse({ ...result, committedOffset: "01" }),
    ).toThrow();
  });

  it("returns only the stable public error contract", () => {
    expect(
      createUploadErrorResponse("STORAGE_UNAVAILABLE", "request-1"),
    ).toEqual({
      code: "STORAGE_UNAVAILABLE",
      message: "Storage is temporarily unavailable.",
      requestId: "request-1",
    });
  });
});
