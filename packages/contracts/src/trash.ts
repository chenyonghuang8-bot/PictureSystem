import { z } from "zod";
import { unsignedBigIntStringSchema } from "./auth.js";

export const operationIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
export const trashMediaParamsSchema = z
  .object({
    familyId: unsignedBigIntStringSchema,
    mediaId: unsignedBigIntStringSchema,
  })
  .strict();
export const trashRequestSchema = z
  .object({
    selectedAlbumId: unsignedBigIntStringSchema,
    expectedLifecycleRevision: unsignedBigIntStringSchema,
    operationId: operationIdSchema,
  })
  .strict();
export const restoreRequestSchema = trashRequestSchema
  .omit({ selectedAlbumId: true })
  .strict();
export const trashListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict();
export const lifecycleResponseSchema = z
  .object({
    mediaId: unsignedBigIntStringSchema,
    lifecycleRevision: unsignedBigIntStringSchema,
    state: z.enum(["ACTIVE", "TRASHED"]),
    trashedAt: z.iso.datetime().nullable(),
    purgeAfter: z.iso.datetime().nullable(),
  })
  .strict();
export const trashItemSchema = lifecycleResponseSchema
  .omit({ state: true })
  .extend({
    mediaType: z.enum(["UNKNOWN", "IMAGE", "VIDEO", "OTHER"]),
    timelineKey: z.iso.datetime(),
    capabilities: z.object({ canRestore: z.boolean() }).strict(),
  })
  .strict();
export const trashPageSchema = z
  .object({
    items: z.array(trashItemSchema).max(100),
    nextCursor: z.string().nullable(),
  })
  .strict();
