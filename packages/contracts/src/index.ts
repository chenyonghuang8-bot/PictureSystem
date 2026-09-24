import { z } from "zod";

export * from "./auth-error.js";
export * from "./auth.js";
export * from "./phase1c.js";
export * from "./uploads.js";
export * from "./albums.js";
export * from "./media-processing.js";
export * from "./derived-serving.js";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
