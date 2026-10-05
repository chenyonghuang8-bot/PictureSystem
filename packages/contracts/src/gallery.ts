import { z } from "zod";

import { unsignedBigIntStringSchema } from "./auth.js";
import { phase4TimelineBases } from "./media-processing.js";

export const galleryMediaQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

// Search dates describe the existing timeline calendar, without viewer timezone conversion.
export const familySearchDateSchema = z
  .string()
  .regex(/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  });

export const familySearchFilenameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1)
      .refine(
        (value) =>
          [...value].length <= 255 &&
          new TextEncoder().encode(value).length <= 1024 &&
          !/[\p{Cc}\p{Cs}]/u.test(value),
      ),
  );

export const familyLocationFilterSchema = z
  .string()
  .max(64)
  .regex(
    /^(located|unknown|no-city|country:[A-Z]{2}|city:[1-9][0-9]{0,19}|cell:[0-6]:[0-9a-f]{15})$/,
  );
export const familySearchQuerySchema = z
  .object({
    location: familyLocationFilterSchema.optional(),
    fromDate: familySearchDateSchema.optional(),
    toDate: familySearchDateSchema.optional(),
    albumId: unsignedBigIntStringSchema.optional(),
    filename: familySearchFilenameSchema.optional(),
    uploaderMemberId: unsignedBigIntStringSchema.optional(),
    tagId: unsignedBigIntStringSchema.optional(),
    favoritesOnly: z
      .literal("true")
      .optional()
      .transform((value) => value === "true"),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .default(20),
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.fromDate || !value.toDate || value.fromDate <= value.toDate,
  );

export const familySearchCursorSchema = z
  .object({
    version: z.literal(2),
    timelineKey: z
      .string()
      .regex(
        /^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/,
      )
      .refine((value) => {
        const date = new Date(value);
        return !Number.isNaN(date.getTime()) && date.toISOString() === value;
      }),
    mediaId: unsignedBigIntStringSchema,
    scope: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type FamilySearchQuery = z.output<typeof familySearchQuerySchema>;
export type FamilySearchFilters = Pick<
  FamilySearchQuery,
  | "fromDate"
  | "toDate"
  | "albumId"
  | "favoritesOnly"
  | "filename"
  | "uploaderMemberId"
  | "tagId"
  | "location"
>;

export const familySearchOptionsQuerySchema = z
  .object({
    kind: z.enum(["tag", "uploader"]),
    limit: z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(50))
      .default(50),
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
export const familySearchOptionsCursorSchema = z
  .object({
    version: z.literal(1),
    afterId: unsignedBigIntStringSchema,
    scope: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const familySearchOptionsPageSchema = z
  .object({
    options: z
      .array(
        z
          .object({
            id: unsignedBigIntStringSchema,
            name: z.string().min(1).max(128),
          })
          .strict(),
      )
      .max(50),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type FamilySearchOptionsQuery = z.output<
  typeof familySearchOptionsQuerySchema
>;

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
    canTrash: z.boolean(),
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
    lifecycleRevision: unsignedBigIntStringSchema,
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

// A bbox addresses fixed res6 cell centers only. It never addresses source GPS.
export const locationBboxSchema = z
  .string()
  .max(100)
  .transform((value, ctx) => {
    if (!/^-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?){3}$/.test(value)) {
      ctx.addIssue({ code: "custom", message: "Invalid bbox" });
      return z.NEVER;
    }
    const coordinates = value.split(",").map(Number);
    const [west, south, east, north] = coordinates as [
      number,
      number,
      number,
      number,
    ];
    if (
      coordinates.some((n) => !Number.isFinite(n)) ||
      Math.abs(west) > 180 ||
      Math.abs(east) > 180 ||
      south < -90 ||
      north > 90 ||
      south > north
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid bbox" });
      return z.NEVER;
    }
    return [west, south, east, north] as [number, number, number, number];
  });
const locationFilterShape = z
  .object(familySearchQuerySchema.shape)
  .omit({ cursor: true, limit: true });
export const familyMapQuerySchema = locationFilterShape
  .extend({
    bbox: locationBboxSchema.default([-180, -90, 180, 90]),
    zoom: z
      .string()
      .regex(/^(0|[1-9][0-9]?)(?:\.[0-9]{1,4})?$/)
      .transform(Number)
      .pipe(z.number().min(0).max(22))
      .default(1),
  })
  .strict()
  .refine(
    (value) =>
      !value.fromDate || !value.toDate || value.fromDate <= value.toDate,
  );
export const familyLocationOptionsQuerySchema = locationFilterShape
  .extend({
    kind: z.enum(["country", "city"]),
    limit: z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number)
      .pipe(z.number().min(1).max(50))
      .default(50),
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.fromDate || !value.toDate || value.fromDate <= value.toDate,
  );
const locationRegionSchema = z
  .object({
    id: familyLocationFilterSchema,
    name: z.string().min(1).max(256),
    count: z.number().int().nonnegative(),
  })
  .strict();
export const familyLocationOptionsPageSchema = z
  .object({
    options: z.array(locationRegionSchema).max(50),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const familyMapPageSchema = z
  .object({
    resolution: z.number().int().min(0).max(6),
    clusters: z
      .array(
        z
          .object({
            cell: z.string().regex(/^[0-9a-f]{15}$/),
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
            count: z.number().int().positive(),
          })
          .strict(),
      )
      .max(500),
    locatedCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    noGpsCount: z.number().int().nonnegative(),
    polarCount: z.number().int().nonnegative(),
  })
  .strict();
export type FamilyMapQuery = z.output<typeof familyMapQuerySchema>;
export type FamilyMapPage = z.output<typeof familyMapPageSchema>;
export type FamilyLocationOptionsQuery = z.output<
  typeof familyLocationOptionsQuerySchema
>;
