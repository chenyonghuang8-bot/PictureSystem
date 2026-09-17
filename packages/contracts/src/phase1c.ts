import { z } from "zod";

import { unsignedBigIntStringSchema } from "./auth.js";

const invitationRoleSchema = z.enum(["MEMBER", "ADMIN"]);

export const familyParamsSchema = z
  .object({ familyId: unsignedBigIntStringSchema })
  .strict();

export const invitationParamsSchema = z
  .object({
    familyId: unsignedBigIntStringSchema,
    invitationId: unsignedBigIntStringSchema,
  })
  .strict();

export const memberParamsSchema = z
  .object({
    familyId: unsignedBigIntStringSchema,
    memberId: unsignedBigIntStringSchema,
  })
  .strict();

export const createInvitationRequestSchema = z
  .object({
    role: invitationRoleSchema.default("MEMBER"),
    expiresInHours: z.number().int().min(1).max(168).default(48),
  })
  .strict();

export const createInvitationResponseSchema = z
  .object({
    id: unsignedBigIntStringSchema,
    role: invitationRoleSchema,
    expiresAt: z.iso.datetime(),
    invitationUrl: z.url(),
  })
  .strict();

export const invitationStatusSchema = z.enum([
  "PENDING",
  "USED",
  "REVOKED",
  "EXPIRED",
  "INVALIDATED",
]);

export const invitationSummarySchema = z
  .object({
    id: unsignedBigIntStringSchema,
    role: invitationRoleSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    usedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    status: invitationStatusSchema,
    creatorMemberId: unsignedBigIntStringSchema,
  })
  .strict();

export const invitationsResponseSchema = z
  .object({ invitations: z.array(invitationSummarySchema).max(100) })
  .strict();

export const invitationTokenRequestSchema = z
  .object({ token: z.string().min(1).max(128) })
  .strict();

export const invitationPreviewResponseSchema = z
  .object({
    familyName: z.string().min(1).max(128),
    role: invitationRoleSchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const consumeInvitationRequestSchema = z
  .object({
    token: z.string().min(1).max(128),
    username: z.string().min(1).max(512),
    password: z.string().min(1).max(1_024),
    displayName: z.string().max(512).optional(),
  })
  .strict();

export const memberSummarySchema = z
  .object({
    id: unsignedBigIntStringSchema,
    userId: unsignedBigIntStringSchema,
    username: z.string(),
    displayName: z.string().nullable(),
    role: z.enum(["SUPER_ADMIN", "ADMIN", "MEMBER"]),
    disabled: z.boolean(),
  })
  .strict();

export const membersResponseSchema = z
  .object({ members: z.array(memberSummarySchema).max(100) })
  .strict();

export const updateMemberRequestSchema = z.union([
  z.object({ role: z.enum(["ADMIN", "MEMBER"]) }).strict(),
  z.object({ disabled: z.boolean() }).strict(),
]);

export type InvitationRole = z.infer<typeof invitationRoleSchema>;
export type CreateInvitationRequest = z.infer<
  typeof createInvitationRequestSchema
>;
export type ConsumeInvitationRequest = z.infer<
  typeof consumeInvitationRequestSchema
>;
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;
