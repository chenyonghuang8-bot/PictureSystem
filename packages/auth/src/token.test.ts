import { describe, expect, it } from "vitest";

import {
  createInvitationToken,
  createSessionToken,
  createShareToken,
  decodeInvitationToken,
  decodeSessionToken,
  hashInvitationToken,
  hashSessionToken,
  hashShareToken,
  TokenValidationError,
} from "./token.js";

describe("opaque token helpers", () => {
  it.each([
    ["session", createSessionToken, decodeSessionToken, hashSessionToken],
    [
      "invitation",
      createInvitationToken,
      decodeInvitationToken,
      hashInvitationToken,
    ],
    ["share", createShareToken, hashShareToken, hashShareToken],
  ] as const)(
    "creates canonical 32-byte %s tokens",
    (_kind, create, decode, hash) => {
      const token = create();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decode(token)).toHaveLength(32);
      expect(hash(token)).toHaveLength(32);
      expect(hash(token)).toEqual(hash(token));
    },
  );

  it.each([
    "",
    "a".repeat(42),
    "a".repeat(44),
    "=".repeat(43),
    "a".repeat(42) + "+",
  ])(
    "rejects malformed, short, long, or non-base64url session tokens: %j",
    (token) => {
      expect(() => decodeSessionToken(token)).toThrow(TokenValidationError);
    },
  );

  it("round-trips the digest as binary bytes", () => {
    const digest = hashInvitationToken(createInvitationToken());
    expect(Buffer.from(digest.toString("hex"), "hex")).toEqual(digest);
  });

  it("generates independent values for session and invitation domains", () => {
    expect(createSessionToken()).not.toBe(createInvitationToken());
  });

  it("rejects a malformed share token before hashing", () => {
    expect(() => hashShareToken("not-a-share-token")).toThrow(
      TokenValidationError,
    );
  });
});
