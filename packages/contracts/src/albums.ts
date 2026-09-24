import { z } from "zod";

import { unsignedBigIntStringSchema } from "./auth.js";

export const albumVisibilitySchema = z.enum(["FAMILY", "CUSTOM"]);

const albumNameInputSchema = z.string().min(1).max(512);
const albumDescriptionInputSchema = z.string().max(8_000).nullable();

export const albumParamsSchema = z
  .object({ albumId: unsignedBigIntStringSchema })
  .strict();

export const albumMemberParamsSchema = z
  .object({
    albumId: unsignedBigIntStringSchema,
    memberId: unsignedBigIntStringSchema,
  })
  .strict();

export const createAlbumRequestSchema = z
  .object({
    familyId: unsignedBigIntStringSchema,
    name: albumNameInputSchema,
    description: albumDescriptionInputSchema.optional(),
    visibility: albumVisibilitySchema.default("CUSTOM"),
  })
  .strict();

export const listAlbumsQuerySchema = z
  .object({
    familyId: unsignedBigIntStringSchema,
    afterId: unsignedBigIntStringSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const updateAlbumRequestSchema = z
  .object({
    expectedRevision: unsignedBigIntStringSchema,
    name: albumNameInputSchema.optional(),
    description: albumDescriptionInputSchema.optional(),
    visibility: albumVisibilitySchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined ||
      input.description !== undefined ||
      input.visibility !== undefined,
    { message: "At least one album field is required." },
  );

export const deleteAlbumRequestSchema = z
  .object({ expectedRevision: unsignedBigIntStringSchema })
  .strict();

export const albumPermissionsSchema = z
  .object({
    canView: z.boolean(),
    canUpload: z.boolean(),
    canEdit: z.boolean(),
    canDelete: z.boolean(),
    canManageMembers: z.boolean(),
  })
  .strict();

export const albumResponseSchema = z
  .object({
    id: unsignedBigIntStringSchema,
    familyId: unsignedBigIntStringSchema,
    ownerMemberId: unsignedBigIntStringSchema,
    name: z.string().min(1).max(128),
    description: z.string().max(2_000).nullable(),
    visibility: albumVisibilitySchema,
    revision: unsignedBigIntStringSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    effectivePermissions: albumPermissionsSchema,
  })
  .strict();

export const albumsResponseSchema = z
  .object({
    albums: z.array(albumResponseSchema).max(100),
    nextAfterId: unsignedBigIntStringSchema.nullable(),
  })
  .strict();

export const putAlbumMemberRequestSchema = albumPermissionsSchema
  .extend({ expectedRevision: unsignedBigIntStringSchema })
  .strict()
  .superRefine((input, context) => {
    if (
      (input.canUpload ||
        input.canEdit ||
        input.canDelete ||
        input.canManageMembers) &&
      !input.canView
    ) {
      context.addIssue({
        code: "custom",
        message: "View permission is required for every other permission.",
      });
    }
    if (
      !input.canView &&
      !input.canUpload &&
      !input.canEdit &&
      !input.canDelete &&
      !input.canManageMembers
    ) {
      context.addIssue({
        code: "custom",
        message: "Use DELETE to remove an album member grant.",
      });
    }
  });

export const deleteAlbumMemberRequestSchema = z
  .object({ expectedRevision: unsignedBigIntStringSchema })
  .strict();

export const albumMemberResponseSchema = albumPermissionsSchema
  .extend({
    memberId: unsignedBigIntStringSchema,
    displayName: z.string().max(128).nullable(),
    active: z.boolean(),
    isOwner: z.boolean(),
  })
  .strict();

export const albumMembersResponseSchema = z
  .object({ members: z.array(albumMemberResponseSchema).max(100) })
  .strict();

export const albumMemberMutationResponseSchema = z
  .object({ revision: unsignedBigIntStringSchema })
  .strict();

export const albumMediaPlacementRequestSchema = z
  .object({ mediaId: unsignedBigIntStringSchema })
  .strict();

export const albumMediaPlacementSchema = z
  .object({
    albumId: unsignedBigIntStringSchema,
    mediaId: unsignedBigIntStringSchema,
    created: z.boolean(),
  })
  .strict();

export const albumMediaRemovalSchema = z
  .object({
    albumId: unsignedBigIntStringSchema,
    mediaId: unsignedBigIntStringSchema,
    removed: z.boolean(),
  })
  .strict();

export type AlbumVisibility = z.infer<typeof albumVisibilitySchema>;
export type CreateAlbumRequest = z.infer<typeof createAlbumRequestSchema>;
export type UpdateAlbumRequest = z.infer<typeof updateAlbumRequestSchema>;
export type PutAlbumMemberRequest = z.infer<typeof putAlbumMemberRequestSchema>;
