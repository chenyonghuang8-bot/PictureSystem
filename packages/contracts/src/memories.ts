import { z } from "zod";
import {
  familySearchDateSchema,
  familyTimelineItemSchema,
  familySearchCursorSchema,
} from "./gallery.js";
import { MEMORIES_ZONE, MEMORIES_POLICY } from "./memories-calendar.js";

export const memoriesKindSchema = z.enum(["ON_THIS_DAY", "LAST_YEAR_WEEK"]);
export const memoriesQuerySchema = z
  .object({
    kind: memoriesKindSchema.default("ON_THIS_DAY"),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .optional()
      .default(48),
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
export const memoriesContextSchema = z
  .object({
    anchorDate: familySearchDateSchema,
    zone: z.literal(MEMORIES_ZONE),
    policy: z.literal(MEMORIES_POLICY),
    serverNow: z.iso.datetime(),
    nextMidnight: z.iso.datetime(),
    weekStart: familySearchDateSchema,
    weekEnd: familySearchDateSchema,
  })
  .strict()
  .refine(
    (c) => Date.parse(c.nextMidnight) > Date.parse(c.serverNow),
    "Invalid deadline",
  );
export const memoriesItemSchema = familyTimelineItemSchema
  .extend({
    timelineDate: familySearchDateSchema,
    dateBasis: z.enum(["CAPTURE_LOCAL", "UPLOAD_UTC"]),
  })
  .strict();
export const memoriesPageSchema = z
  .object({
    context: memoriesContextSchema,
    kind: memoriesKindSchema,
    media: z.array(memoriesItemSchema).max(100),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const memoriesPreviewSchema = z
  .object({
    context: memoriesContextSchema,
    cards: z.tuple([
      z
        .object({
          kind: z.literal("ON_THIS_DAY"),
          media: z.array(memoriesItemSchema).max(6),
          hasMore: z.boolean(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("LAST_YEAR_WEEK"),
          media: z.array(memoriesItemSchema).max(6),
          hasMore: z.boolean(),
        })
        .strict(),
    ]),
  })
  .strict();
export const memoriesCursorSchema = familySearchCursorSchema
  .extend({
    version: z.literal(1),
    kind: memoriesKindSchema,
    anchorDate: familySearchDateSchema,
    zone: z.literal(MEMORIES_ZONE),
    policy: z.literal(MEMORIES_POLICY),
  })
  .strict();
export type MemoriesQuery = z.output<typeof memoriesQuerySchema>;
export type MemoriesCursor = z.output<typeof memoriesCursorSchema>;
export type MemoriesContext = z.output<typeof memoriesContextSchema>;
export type MemoriesItem = z.output<typeof memoriesItemSchema>;
export type MemoriesPage = z.output<typeof memoriesPageSchema>;
export type MemoriesPreview = z.output<typeof memoriesPreviewSchema>;
