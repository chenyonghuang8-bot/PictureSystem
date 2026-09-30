import { describe, expect, it } from "vitest";

import { decideOriginalMime, originalContentDisposition } from "./headers.js";

describe("original download headers", () => {
  it.each([
    ["image/jpeg", "image/jpeg", "jpg"],
    ["image/png", "image/png", "png"],
    ["video/quicktime", "video/quicktime", "mov"],
    ["text/html", "application/octet-stream", "bin"],
    ["__proto__", "application/octet-stream", "bin"],
    ["constructor", "application/octet-stream", "bin"],
    ["toString", "application/octet-stream", "bin"],
    [null, "application/octet-stream", "bin"],
  ])("maps only allowlisted MIME %s", (input, contentType, extension) => {
    expect(decideOriginalMime(input)).toEqual({ contentType, extension });
  });

  it.each([
    "family.jpg",
    "bad\r\nX-Evil: yes.jpg",
    'quote"name.jpg',
    "../escape.jpg",
    "/absolute/path.jpg",
    "C:\\windows\\path.jpg",
    "nul\0name.jpg",
    "control\u0001name.jpg",
    "bidi\u202ename.jpg",
    "emoji-😀.jpg",
    "non-bmp-𐐷.jpg",
    ".hidden",
    `${"相册".repeat(100)}.jpg`,
    "many.parts.name.jpg",
    "percent%name.jpg",
    "apostrophe'name.jpg",
    "asterisk*name.jpg",
    "bad\ud800name.jpg",
  ])("encodes an untrusted filename safely: %j", (originalFilename) => {
    const header = originalContentDisposition({
      originalFilename,
      mediaId: "42",
      extension: "jpg",
    });
    expect(header).toMatch(
      /^attachment; filename="media-42\.jpg"; filename\*=UTF-8''/u,
    );
    expect(header.match(/filename="/gu)).toHaveLength(1);
    expect(header.match(/filename\*=/gu)).toHaveLength(1);
    expect(header).not.toMatch(/[\r\n\0]/u);
    expect(Buffer.byteLength(header, "utf8")).toBeLessThanOrEqual(512);
  });

  it("uses a deterministic fallback for malformed Unicode", () => {
    expect(
      originalContentDisposition({
        originalFilename: "bad\ud800.jpg",
        mediaId: "9",
        extension: "bin",
      }),
    ).toBe(
      "attachment; filename=\"media-9.bin\"; filename*=UTF-8''media-9.bin",
    );
  });
});
