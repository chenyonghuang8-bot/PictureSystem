import { describe, expect, it } from "vitest";

import { isCanonicalMediaIdentityDuplicate } from "./media-repository.js";

describe("canonical media duplicate classification", () => {
  it("accepts only the family/storage canonical identity unique", () => {
    expect(
      isCanonicalMediaIdentityDuplicate({
        code: "ER_DUP_ENTRY",
        errno: 1062,
        sqlMessage:
          "Duplicate entry '1-2' for key 'media_items.uq_media_items_family_storage_object'",
      }),
    ).toBe(true);
  });

  it("does not swallow unrelated duplicate-key failures", () => {
    const unrelated = {
      code: "ER_DUP_ENTRY",
      errno: 1062,
      sqlMessage:
        "Duplicate entry '1-2' for key 'media_items.uq_media_items_family_id'",
    };
    expect(isCanonicalMediaIdentityDuplicate(unrelated)).toBe(false);
    expect(
      isCanonicalMediaIdentityDuplicate({ code: "ER_LOCK_DEADLOCK" }),
    ).toBe(false);
  });
});
