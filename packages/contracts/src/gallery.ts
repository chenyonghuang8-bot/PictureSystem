import { z } from "zod";

import { unsignedBigIntStringSchema } from "./auth.js";
import { phase4TimelineBases } from "./media-processing.js";

export const galleryMediaQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const galleryMediaParamsSchema = z
  .object({
    albumId: unsignedBigIntStringSchema,
    mediaId: unsignedBigIntStringSchema,
  })
  .strict();

export const galleryCursorSchema = z
  .object({
    timelineKey: z.iso.datetime(),
    mediaId: unsignedBigIntStringSchema,
  })
  .strict();

export const galleryMediaItemSchema = z
  .object({
    mediaId: unsignedBigIntStringSchema,
    timelineKey: z.iso.datetime(),
    timelineBasis: z.enum(phase4TimelineBases),
    displayWidth: z.number().int().positive().nullable(),
    displayHeight: z.number().int().positive().nullable(),
    thumbnail: z.object({ kind: z.literal("thumbnail") }).strict(),
  })
  .strict();

export const galleryMediaPageSchema = z
  .object({
    media: z.array(galleryMediaItemSchema).max(100),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const galleryMediaDetailSchema = galleryMediaItemSchema
  .extend({
    orientation: z.number().int().min(1).max(8).nullable(),
    capturedLocalAt: z.iso.datetime().nullable(),
    cameraMake: z.string().max(128).nullable(),
    cameraModel: z.string().max(128).nullable(),
    preview: z.object({ kind: z.literal("preview") }).strict(),
  })
  .strict();

export const familyTimelineParamsSchema = z
  .object({
    familyId: unsignedBigIntStringSchema,
  })
  .strict();

export const familyTimelineItemSchema = galleryMediaItemSchema
  .extend({
    albumId: unsignedBigIntStringSchema,
  })
  .strict();

export const familyTimelinePageSchema = z
  .object({
    media: z.array(familyTimelineItemSchema).max(100),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type GalleryMediaQuery = z.infer<typeof galleryMediaQuerySchema>;
export type FamilyTimelinePage = z.infer<typeof familyTimelinePageSchema>;
export type GalleryMediaPage = z.infer<typeof galleryMediaPageSchema>;
export type GalleryMediaDetail = z.infer<typeof galleryMediaDetailSchema>;
