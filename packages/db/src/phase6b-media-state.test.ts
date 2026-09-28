import { describe, expect, it } from "vitest";

import { isApprovedIdentityDuplicate } from "./album-repository.js";

describe("Phase 6B duplicate classification", () => {
  const duplicate = (key: string) => ({
    code: "ER_DUP_ENTRY",
    errno: 1062,
    sqlState: "23000",
    sqlMessage: `Duplicate entry '1-2-3' for key '${key}'`,
  });

  it("accepts exact observed mysql2 key qualification", () => {
    expect(
      isApprovedIdentityDuplicate(
        duplicate("user_favorites.uq_user_favorites_identity"),
        "uq_user_favorites_identity",
      ),
    ).toBe(true);
    expect(
      isApprovedIdentityDuplicate(
        duplicate(
          "family_album_dev.family_featured.uq_family_featured_identity",
        ),
        "uq_family_featured_identity",
      ),
    ).toBe(true);
  });

  it.each([
    "uq_user_favorites_identity_other",
    "x_uq_user_favorites_identity",
    "uq_family_featured_identity_backup",
    "some_other_unique",
  ])("rejects the non-exact key %s", (key) => {
    expect(
      isApprovedIdentityDuplicate(duplicate(key), "uq_user_favorites_identity"),
    ).toBe(false);
  });

  it("rejects malformed and non-1062 errors", () => {
    expect(
      isApprovedIdentityDuplicate(
        {
          ...duplicate("uq_user_favorites_identity"),
          sqlMessage: "duplicate uq_user_favorites_identity",
        },
        "uq_user_favorites_identity",
      ),
    ).toBe(false);
    expect(
      isApprovedIdentityDuplicate(
        { ...duplicate("uq_user_favorites_identity"), errno: 1452 },
        "uq_user_favorites_identity",
      ),
    ).toBe(false);
    expect(
      isApprovedIdentityDuplicate(
        {
          code: "ER_DUP_ENTRY",
          sqlMessage:
            "Duplicate entry '1' for key 'uq_user_favorites_identity'",
        },
        "uq_user_favorites_identity",
      ),
    ).toBe(false);
  });
});
