import { describe, expect, it } from "vitest";

import {
  consumeInvitationRequestSchema,
  createInvitationRequestSchema,
  updateMemberRequestSchema,
} from "./phase1c.js";

describe("Phase 1C contracts", () => {
  it("defaults invitations safely and bounds their lifetime", () => {
    expect(createInvitationRequestSchema.parse({})).toEqual({
      role: "MEMBER",
      expiresInHours: 48,
    });
    expect(
      createInvitationRequestSchema.safeParse({ expiresInHours: 1 }).success,
    ).toBe(true);
    expect(
      createInvitationRequestSchema.safeParse({ expiresInHours: 168 }).success,
    ).toBe(true);
    expect(
      createInvitationRequestSchema.safeParse({ expiresInHours: 0 }).success,
    ).toBe(false);
    expect(
      createInvitationRequestSchema.safeParse({ expiresInHours: 169 }).success,
    ).toBe(false);
  });

  it("makes SUPER_ADMIN invitations and mass assignment impossible", () => {
    expect(
      createInvitationRequestSchema.safeParse({ role: "SUPER_ADMIN" }).success,
    ).toBe(false);
    expect(
      consumeInvitationRequestSchema.safeParse({
        token: "x",
        username: "new-user",
        password: "password1",
        role: "SUPER_ADMIN",
        familyId: "1",
      }).success,
    ).toBe(false);
  });

  it("allows exactly one member mutation dimension", () => {
    expect(updateMemberRequestSchema.safeParse({ role: "ADMIN" }).success).toBe(
      true,
    );
    expect(
      updateMemberRequestSchema.safeParse({ disabled: true }).success,
    ).toBe(true);
    expect(
      updateMemberRequestSchema.safeParse({ role: "ADMIN", disabled: true })
        .success,
    ).toBe(false);
    expect(
      updateMemberRequestSchema.safeParse({ role: "SUPER_ADMIN" }).success,
    ).toBe(false);
  });
});
