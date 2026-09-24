import { z } from "zod";

import { unsignedBigIntStringSchema } from "./auth.js";

export const derivedKindSchema = z.enum(["thumbnail", "preview"]);

export const derivedParamsSchema = z
  .object({
    mediaId: unsignedBigIntStringSchema,
    kind: derivedKindSchema,
  })
  .strict();

export type DerivedKindParam = z.infer<typeof derivedKindSchema>;
