import { describe, expect, it } from "vitest";

import {
  canIssueInvitation,
  canViewAlbum,
  evaluateAlbumPermissions,
  isPermissionSubset,
  canListInvitations,
  canManageMember,
  canRevokeInvitation,
  type FamilyRole,
} from "./index.js";

describe("Phase 1C family permissions", () => {
  it.each([
    ["MEMBER", "MEMBER", false],
    ["MEMBER", "ADMIN", false],
    ["ADMIN", "MEMBER", true],
    ["ADMIN", "ADMIN", false],
    ["SUPER_ADMIN", "MEMBER", true],
    ["SUPER_ADMIN", "ADMIN", true],
  ] as const)("issue %s -> %s = %s", (actor, role, expected) => {
    expect(canIssueInvitation(actor, role)).toBe(expected);
  });

  it("restricts listing to administrators", () => {
    expect(canListInvitations("MEMBER")).toBe(false);
    expect(canListInvitations("ADMIN")).toBe(true);
    expect(canListInvitations("SUPER_ADMIN")).toBe(true);
  });

  it("lets ADMIN revoke MEMBER but never ADMIN invitations", () => {
    expect(canRevokeInvitation("MEMBER", "MEMBER")).toBe(false);
    expect(canRevokeInvitation("MEMBER", "ADMIN")).toBe(false);
    expect(canRevokeInvitation("ADMIN", "MEMBER")).toBe(true);
    expect(canRevokeInvitation("ADMIN", "ADMIN")).toBe(false);
    expect(canRevokeInvitation("SUPER_ADMIN", "ADMIN")).toBe(true);
  });

  it.each(["MEMBER", "ADMIN", "SUPER_ADMIN"] as const)(
    "never permits %s to operate on a SUPER_ADMIN",
    (actorRole) => {
      expect(
        canManageMember({
          actorRole,
          actorMemberId: "1",
          targetRole: "SUPER_ADMIN",
          targetMemberId: "2",
          mutation: { kind: "DISABLED", disabled: true },
        }),
      ).toBe(false);
      expect(
        canManageMember({
          actorRole,
          actorMemberId: "1",
          targetRole: "SUPER_ADMIN",
          targetMemberId: "2",
          mutation: { kind: "DISABLED", disabled: false },
        }),
      ).toBe(false);
      expect(
        canManageMember({
          actorRole,
          actorMemberId: "1",
          targetRole: "SUPER_ADMIN",
          targetMemberId: "2",
          mutation: { kind: "ROLE", role: "ADMIN" },
        }),
      ).toBe(false);
    },
  );

  it("prevents self-management and ADMIN peer management", () => {
    expect(
      canManageMember({
        actorRole: "ADMIN",
        actorMemberId: "1",
        targetRole: "MEMBER",
        targetMemberId: "1",
        mutation: { kind: "ROLE", role: "ADMIN" },
      }),
    ).toBe(false);
    expect(
      canManageMember({
        actorRole: "ADMIN",
        actorMemberId: "1",
        targetRole: "ADMIN",
        targetMemberId: "2",
        mutation: { kind: "DISABLED", disabled: true },
      }),
    ).toBe(false);
  });

  it.each([
    ["ADMIN", "MEMBER", "DISABLED", true],
    ["ADMIN", "MEMBER", "ROLE", false],
    ["SUPER_ADMIN", "MEMBER", "ROLE", true],
    ["SUPER_ADMIN", "ADMIN", "DISABLED", true],
  ] as const)(
    "%s managing %s with %s = %s",
    (actorRole, targetRole, kind, expected) => {
      const mutation =
        kind === "ROLE"
          ? ({ kind, role: "ADMIN" } as const)
          : ({ kind, disabled: true } as const);
      expect(
        canManageMember({
          actorRole: actorRole as FamilyRole,
          actorMemberId: "1",
          targetRole,
          targetMemberId: "2",
          mutation,
        }),
      ).toBe(expected);
    },
  );
});

describe("Phase 2 album permissions", () => {
  const base = {
    membershipExists: true,
    memberActive: true,
    sameFamily: true,
    albumDeleted: false,
    isOwner: false,
    visibility: "CUSTOM" as const,
    explicitGrant: null,
  };

  it("gives every effective permission only to a valid owner", () => {
    expect(evaluateAlbumPermissions({ ...base, isOwner: true })).toEqual({
      canView: true,
      canUpload: true,
      canEdit: true,
      canDelete: true,
      canManageMembers: true,
    });
    for (const invalid of [
      { membershipExists: false },
      { memberActive: false },
      { sameFamily: false },
      { albumDeleted: true },
    ]) {
      expect(
        evaluateAlbumPermissions({ ...base, isOwner: true, ...invalid }),
      ).toEqual({
        canView: false,
        canUpload: false,
        canEdit: false,
        canDelete: false,
        canManageMembers: false,
      });
    }
  });

  it("makes FAMILY view-only unless an explicit grant adds capabilities", () => {
    expect(evaluateAlbumPermissions({ ...base, visibility: "FAMILY" })).toEqual(
      {
        canView: true,
        canUpload: false,
        canEdit: false,
        canDelete: false,
        canManageMembers: false,
      },
    );
    expect(
      evaluateAlbumPermissions({
        ...base,
        visibility: "FAMILY",
        explicitGrant: {
          canView: true,
          canUpload: true,
          canEdit: false,
          canDelete: false,
          canManageMembers: false,
        },
      }).canUpload,
    ).toBe(true);
  });

  it.each(["MEMBER", "ADMIN", "SUPER_ADMIN"] as const)(
    "does not give %s a CUSTOM album bypass",
    (familyRole) => {
      expect(canViewAlbum({ ...base, familyRole })).toBe(false);
    },
  );

  it("fails closed when a malformed grant has capabilities without view", () => {
    expect(
      evaluateAlbumPermissions({
        ...base,
        explicitGrant: {
          canView: false,
          canUpload: true,
          canEdit: true,
          canDelete: true,
          canManageMembers: true,
        },
      }),
    ).toEqual({
      canView: false,
      canUpload: false,
      canEdit: false,
      canDelete: false,
      canManageMembers: false,
    });
  });

  it("enforces delegated permission subsets across every capability", () => {
    const manager = {
      canView: true,
      canUpload: true,
      canEdit: false,
      canDelete: true,
      canManageMembers: true,
    };
    expect(
      isPermissionSubset(manager, {
        canView: true,
        canUpload: true,
        canEdit: false,
        canDelete: false,
        canManageMembers: false,
      }),
    ).toBe(true);
    expect(
      isPermissionSubset(manager, {
        canView: true,
        canUpload: false,
        canEdit: true,
        canDelete: false,
        canManageMembers: false,
      }),
    ).toBe(false);
    expect(
      isPermissionSubset(manager, {
        canView: true,
        canUpload: false,
        canEdit: false,
        canDelete: false,
        canManageMembers: true,
      }),
    ).toBe(true);
  });
});
