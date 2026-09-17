import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildOriginalPath,
  buildUploadPayloadPath,
  canonicalizeMediaRoot,
  StorageSafetyError,
  validateDisplayFilename,
} from "./index.js";

const UPLOAD_ID = "1".repeat(32);

describe("Phase 3A path contracts", () => {
  it.each([
    "relative/path",
    "../escape",
    "/tmp/../escape",
    "/tmp//escape",
    "/tmp/./escape",
    "/tmp/trailing/",
    "/tmp/null\0byte",
    "/",
  ])("rejects non-canonical MEDIA_ROOT %j", (value) => {
    expect(() => canonicalizeMediaRoot(value)).toThrow(StorageSafetyError);
  });

  it.each([
    ["../1", UPLOAD_ID],
    ["/1", UPLOAD_ID],
    ["１", UPLOAD_ID],
    ["1", "../" + UPLOAD_ID.slice(3)],
    ["1", "/" + UPLOAD_ID.slice(1)],
  ])("rejects injected internal path identifiers", (familyId, uploadId) => {
    expect(() => buildUploadPayloadPath(familyId, uploadId)).toThrow(
      StorageSafetyError,
    );
  });

  it("keeps weird display filenames out of server paths", () => {
    const filename = validateDisplayFilename(
      "../家庭照片／backslash\\name.HEIC",
    );
    expect(filename).toContain("家庭照片");
    expect(buildUploadPayloadPath("7", UPLOAD_ID)).toBe(
      `uploads/7/${UPLOAD_ID}/payload`,
    );
    expect(buildUploadPayloadPath("7", UPLOAD_ID)).not.toContain(filename);
    expect(() => validateDisplayFilename("bad\0name")).toThrow(
      StorageSafetyError,
    );
    expect(() => validateDisplayFilename("bad\u202ename")).toThrow(
      StorageSafetyError,
    );
  });

  it("builds a family-scoped content path from strict identifiers", () => {
    const hash = "ab".repeat(32);
    const path = buildOriginalPath("9", hash, "9007199254740993");
    expect(path).toBe(`originals/9/ab/ab/${hash}-9007199254740993`);
    expect(isAbsolute(path)).toBe(false);
    expect(() => buildOriginalPath("9", hash, "0")).toThrow(StorageSafetyError);
  });
});
