import { describe, expect, it } from "vitest";

import {
  createAlbumRequestSchema,
  deleteAlbumRequestSchema,
  deleteAlbumMemberRequestSchema,
  listAlbumsQuerySchema,
  putAlbumMemberRequestSchema,
  updateAlbumRequestSchema,
} from "./albums.js";

describe("Phase 2 album contracts", () => {
  it("defaults create to CUSTOM and rejects mass assignment", () => {
    expect(
      createAlbumRequestSchema.parse({ familyId: "1", name: "Family" }),
    ).toEqual({
      familyId: "1",
      name: "Family",
      visibility: "CUSTOM",
    });
    expect(
      createAlbumRequestSchema.safeParse({
        familyId: "1",
        name: "Family",
        ownerMemberId: "2",
      }).success,
    ).toBe(false);
    expect(
      createAlbumRequestSchema.safeParse({
        familyId: "1",
        name: "Family",
        visibility: "PUBLIC",
      }).success,
    ).toBe(false);
  });

  it("bounds list pagination and keeps exact decimal cursors", () => {
    expect(
      listAlbumsQuerySchema.parse({
        familyId: "9007199254740993",
        limit: "100",
      }),
    ).toEqual({ familyId: "9007199254740993", limit: 100 });
    expect(
      listAlbumsQuerySchema.safeParse({ familyId: "1", limit: "101" }).success,
    ).toBe(false);
  });

  it("requires an expected revision and at least one mutable field", () => {
    expect(
      updateAlbumRequestSchema.safeParse({
        expectedRevision: "1",
        name: "Updated",
      }).success,
    ).toBe(true);
    expect(
      updateAlbumRequestSchema.safeParse({ expectedRevision: "1" }).success,
    ).toBe(false);
    expect(
      updateAlbumRequestSchema.safeParse({
        expectedRevision: "1",
        name: "Updated",
        revision: "99",
      }).success,
    ).toBe(false);
    expect(
      updateAlbumRequestSchema.safeParse({
        expectedRevision: "1",
        familyId: "2",
        name: "Updated",
      }).success,
    ).toBe(false);
    expect(deleteAlbumRequestSchema.parse({ expectedRevision: "1" })).toEqual({
      expectedRevision: "1",
    });
  });

  it("requires complete grants, view prerequisites and revision", () => {
    const grant = {
      expectedRevision: "5",
      canView: true,
      canUpload: true,
      canEdit: false,
      canDelete: false,
      canManageMembers: false,
    };
    expect(putAlbumMemberRequestSchema.safeParse(grant).success).toBe(true);
    expect(
      putAlbumMemberRequestSchema.safeParse({ ...grant, canView: false })
        .success,
    ).toBe(false);
    expect(
      putAlbumMemberRequestSchema.safeParse({
        ...grant,
        canView: false,
        canUpload: false,
      }).success,
    ).toBe(false);
    expect(
      putAlbumMemberRequestSchema.safeParse({
        ...grant,
        familyId: "9",
      }).success,
    ).toBe(false);
    expect(
      deleteAlbumMemberRequestSchema.parse({ expectedRevision: "5" }),
    ).toEqual({ expectedRevision: "5" });
  });
});
