import { describe, expect, it } from "vitest";

import { createInvitationToken } from "./token.js";
import {
  createInvitationQrPayload,
  createInvitationUrl,
} from "./invitation-link.js";

describe("invitation link contract", () => {
  it("places the token only in the fragment", () => {
    const token = createInvitationToken();
    const link = createInvitationUrl("https://family.example", token);
    const url = new URL(link);
    expect(url.pathname).toBe("/join");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#token=${token}`);
    expect(createInvitationQrPayload("https://family.example", token)).toBe(
      link,
    );
  });

  it("rejects non-canonical origins and malformed tokens", () => {
    const token = createInvitationToken();
    expect(() => createInvitationUrl("http://family.example", token)).toThrow();
    expect(() =>
      createInvitationUrl("https://family.example/path", token),
    ).toThrow();
    expect(() =>
      createInvitationUrl("https://family.example", "invalid"),
    ).toThrow();
  });
});
