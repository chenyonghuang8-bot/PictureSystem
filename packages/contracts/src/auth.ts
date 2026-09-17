import { z } from "zod";

const passwordInput = z.string().min(1).max(1_024);

export const loginRequestSchema = z
  .object({
    username: z.string().min(1).max(512),
    password: passwordInput,
    deviceLabel: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const passwordProofRequestSchema = z
  .object({ password: passwordInput })
  .strict();

export const passwordChangeRequestSchema = z
  .object({
    currentPassword: passwordInput,
    newPassword: passwordInput,
  })
  .strict();

export const emptyObjectRequestSchema = z.object({}).strict();

export const unsignedBigIntStringSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => {
    try {
      return BigInt(value) <= 18_446_744_073_709_551_615n;
    } catch {
      return false;
    }
  });

export const sessionParamsSchema = z
  .object({ sessionId: unsignedBigIntStringSchema })
  .strict();

export const familyMembershipSchema = z
  .object({
    id: unsignedBigIntStringSchema,
    familyId: unsignedBigIntStringSchema,
    familyName: z.string(),
    role: z.enum(["SUPER_ADMIN", "ADMIN", "MEMBER"]),
  })
  .strict();

export const meResponseSchema = z
  .object({
    user: z
      .object({
        id: unsignedBigIntStringSchema,
        username: z.string(),
        displayName: z.string().nullable(),
      })
      .strict(),
    memberships: z.array(familyMembershipSchema),
  })
  .strict();

export const sessionSummarySchema = z
  .object({
    id: unsignedBigIntStringSchema,
    clientType: z.enum(["WEB", "ANDROID"]),
    deviceLabel: z.string().nullable(),
    createdAt: z.iso.datetime(),
    authenticatedAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    current: z.boolean(),
  })
  .strict();

export const sessionsResponseSchema = z
  .object({ sessions: z.array(sessionSummarySchema).max(100) })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type PasswordProofRequest = z.infer<typeof passwordProofRequestSchema>;
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
