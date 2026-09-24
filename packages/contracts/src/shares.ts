import { z } from "zod";

import { unsignedBigIntStringSchema } from "./auth.js";
import { galleryMediaItemSchema } from "./gallery.js";

export const createShareRequestSchema = z
  .object({
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const createShareResponseSchema = z
  .object({
    shareId: unsignedBigIntStringSchema,
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const listSharesQuerySchema = z
  .object({
    familyId: unsignedBigIntStringSchema,
    afterId: unsignedBigIntStringSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const shareParamsSchema = z
  .object({
    shareId: unsignedBigIntStringSchema,
  })
  .strict();

export const shareManagementItemSchema = z
  .object({
    shareId: unsignedBigIntStringSchema,
    albumId: unsignedBigIntStringSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const shareListResponseSchema = z
  .object({
    shares: z.array(shareManagementItemSchema),
    nextAfterId: unsignedBigIntStringSchema.nullable(),
  })
  .strict();

export const publicSharePageSchema = z
  .object({
    album: z
      .object({
        name: z.string().min(1).max(128),
      })
      .strict(),
    media: z.array(galleryMediaItemSchema).max(100),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export const revokeShareResponseSchema = z
  .object({
    shareId: unsignedBigIntStringSchema,
    albumId: unsignedBigIntStringSchema,
    revokedAt: z.iso.datetime(),
  })
  .strict();
