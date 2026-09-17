import { describe, expect, it } from "vitest";

import { UploadServiceError } from "./service.js";
import { validateMetadataHeader } from "./routes.js";

describe("Phase 3C tus protocol input", () => {
  it("accepts only bounded canonical filename/filetype metadata", () => {
    const header = `filename ${Buffer.from("synthetic.jpg").toString("base64")},filetype ${Buffer.from("image/jpeg").toString("base64")}`;
    expect(validateMetadataHeader(header)).toEqual(
      new Map([
        ["filename", "synthetic.jpg"],
        ["filetype", "image/jpeg"],
      ]),
    );
    expect(() => validateMetadataHeader(`${header},filename WA==`)).toThrow(
      UploadServiceError,
    );
    expect(() => validateMetadataHeader("path Li4veA==")).toThrow(
      UploadServiceError,
    );
    expect(() =>
      validateMetadataHeader(`filename ${"A".repeat(4096)}`),
    ).toThrow(UploadServiceError);
  });

  it("rejects malformed UTF-8 instead of replacement decoding", () => {
    expect(() =>
      validateMetadataHeader(
        `filename ${Buffer.from([0xff]).toString("base64")}`,
      ),
    ).toThrow(UploadServiceError);
  });
});
