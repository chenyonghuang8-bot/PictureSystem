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

export const publicGalleryMediaItemSchema = z
  .object({
    mediaId: unsignedBigIntStringSchema,
    timelineKey: z.iso.datetime(),
    timelineBasis: z.enum(phase4TimelineBases),
    displayWidth: z.number().int().positive().nullable(),
    displayHeight: z.number().int().positive().nullable(),
    thumbnail: z.object({ kind: z.literal("thumbnail") }).strict(),
  })
  .strict();

export const galleryMediaItemSchema = publicGalleryMediaItemSchema
  .extend({
    isFavorite: z.boolean(),
    isFamilyFeatured: z.boolean(),
  })
  .strict();

export const favoriteStateSchema = z
  .object({ isFavorite: z.boolean() })
  .strict();

export const featuredStateSchema = z
  .object({ isFamilyFeatured: z.boolean() })
  .strict();

export const mediaTagSchema = z
  .object({
    id: unsignedBigIntStringSchema,
    name: z.string(),
  })
  .strict();

export const createMediaTagSchema = z.object({ name: z.string() }).strict();

export const mediaTagsResponseSchema = z
  .object({ tags: z.array(mediaTagSchema).max(64) })
  .strict();

export const mediaTagResponseSchema = z
  .object({ tag: mediaTagSchema })
  .strict();

export const mediaTagParamsSchema = galleryMediaParamsSchema
  .extend({ tagId: unsignedBigIntStringSchema })
  .strict();

export const mediaTagRemovalSchema = z
  .object({ removed: z.literal(true) })
  .strict();

export const updateMediaNoteSchema = z
  .object({
    note: z.string().nullable(),
    expectedRevision: unsignedBigIntStringSchema,
  })
  .strict();

export const mediaNoteResponseSchema = z
  .object({
    note: z.string().nullable(),
    noteRevision: unsignedBigIntStringSchema,
  })
  .strict();

export const createMediaCommentSchema = z.object({ body: z.string() }).strict();

export const mediaCommentSchema = z
  .object({
    id: unsignedBigIntStringSchema,
    body: z.string(),
    createdAt: z.iso.datetime(),
    author: z
      .object({
        memberId: unsignedBigIntStringSchema,
        displayName: z.string(),
      })
      .strict(),
    canDelete: z.boolean(),
  })
  .strict();

export const mediaCommentResponseSchema = z
  .object({ comment: mediaCommentSchema })
  .strict();

export const mediaCommentPageSchema = z
  .object({
    comments: z.array(mediaCommentSchema).max(50),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const mediaCommentQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const mediaCommentCursorSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    id: unsignedBigIntStringSchema,
  })
  .strict();

export const mediaCommentParamsSchema = galleryMediaParamsSchema
  .extend({ commentId: unsignedBigIntStringSchema })
  .strict();

export const privateMediaCapabilitiesSchema = z
  .object({
    canManageFeatured: z.boolean(),
    canEditTags: z.boolean(),
    canEditNote: z.boolean(),
    canComment: z.boolean(),
    canDownloadOriginal: z.boolean(),
    canDownloadPreview: z.boolean(),
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
    tags: z.array(mediaTagSchema).max(64),
    note: z.string().nullable(),
    noteRevision: unsignedBigIntStringSchema,
    commentCount: z.string().regex(/^(0|[1-9][0-9]*)$/),
    capabilities: privateMediaCapabilitiesSchema,
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
