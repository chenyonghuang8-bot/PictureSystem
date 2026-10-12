import { z } from "zod";
const maxUint64 = 18446744073709551615n;
export const adminDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/u)
  .refine((v) => BigInt(v) <= maxUint64);
export const adminRevisionSchema = adminDecimalSchema.refine(
  (v) => BigInt(v) > 0n,
);
export const adminOperationIdSchema = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
export const adminModeSchema = z.enum(["NORMAL", "READ_ONLY", "MAINTENANCE"]);
export const adminTransitionSchema = z.enum([
  "STABLE",
  "DRAINING",
  "RESUMING",
  "RECOVERY_REQUIRED",
]);
export const adminReasonSchema = z.enum([
  "NONE",
  "NOT_INITIALIZED",
  "MANUAL_READ_ONLY",
  "MANUAL_MAINTENANCE",
  "MANUAL_RESUME",
  "CONTROL_UNAVAILABLE",
  "CONTROL_NAMESPACE_CHANGED",
  "DB_UNAVAILABLE",
  "COMMIT_UNKNOWN",
  "STORAGE_UNAVAILABLE",
  "STORAGE_IDENTITY_CHANGED",
  "CAPACITY_UNAVAILABLE",
  "CAPACITY_MARGIN",
  "WRITER_NOT_READY",
  "PARTICIPANT_STALE",
  "UNRESOLVED_OPERATION",
  "HEALTH_CHANGED",
  "MARKER_UNAVAILABLE",
  "MARKER_CLEAR_FAILED",
  "REVISION_CONFLICT",
  "AUTHORIZATION_CHANGED",
  "NOT_CONFIGURED",
  "NEVER_RUN",
  "STALE",
  "PAUSED",
  "IDLE",
  "STARTING",
  "STOPPED",
  "DRAIN_TIMEOUT",
  "RECOVERY_FAILED",
  "READINESS_UNAVAILABLE",
  "STARTUP_RECHECK_REQUIRED",
]);
export const adminObservationSchema = z
  .object({
    state: z.enum([
      "HEALTHY",
      "DEGRADED",
      "UNAVAILABLE",
      "UNKNOWN",
      "NOT_CONFIGURED",
      "NEVER_RUN",
    ]),
    observedAt: z.string().datetime().nullable(),
    staleAfter: z.string().datetime().nullable(),
    source: z.enum([
      "API_LIVENESS",
      "CHECKED_DATABASE",
      "STORAGE_OWNER",
      "RUNTIME_HEARTBEAT",
      "BACKUP_PROVIDER",
      "INTEGRITY_PROVIDER",
      "CONTROL_DATABASE",
      "CONTROL_LOCAL_DENY",
    ]),
    reasonCode: adminReasonSchema,
  })
  .strict();
export const adminModeRequestSchema = z
  .object({
    operationId: adminOperationIdSchema,
    expectedRevision: adminRevisionSchema,
    targetMode: adminModeSchema,
    reasonCode: z.enum([
      "MANUAL_READ_ONLY",
      "MANUAL_MAINTENANCE",
      "MANUAL_RESUME",
    ]),
  })
  .strict()
  .superRefine((v, c) => {
    const expected =
      v.targetMode === "NORMAL"
        ? "MANUAL_RESUME"
        : v.targetMode === "READ_ONLY"
          ? "MANUAL_READ_ONLY"
          : "MANUAL_MAINTENANCE";
    if (v.reasonCode !== expected)
      c.addIssue({
        code: "custom",
        path: ["reasonCode"],
        message: "Target reason mismatch",
      });
  });
export const adminRecheckRequestSchema = z
  .object({
    operationId: adminOperationIdSchema,
    expectedRevision: adminRevisionSchema,
  })
  .strict();
export const adminControlStatusSchema = z
  .object({
    requestedMode: adminModeSchema,
    enforcedMode: adminModeSchema,
    transitionState: adminTransitionSchema,
    revision: adminRevisionSchema,
    healthGeneration: adminRevisionSchema,
    faultLatched: z.boolean(),
    reasonCode: adminReasonSchema,
    activeOperationId: adminOperationIdSchema.nullable(),
    observedAt: z.string().datetime(),
    localDeny: z.boolean(),
  })
  .strict();
export const adminOperationResponseSchema = z
  .object({
    operationId: adminOperationIdSchema,
    kind: z.enum(["MODE", "RECHECK", "BOOTSTRAP"]),
    status: z.enum(["PENDING", "APPLIED", "REJECTED", "RECOVERY_REQUIRED"]),
    targetMode: adminModeSchema,
    resultRevision: adminRevisionSchema.nullable(),
    reasonCode: adminReasonSchema,
    createdAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
  })
  .strict();
export const adminPageQuerySchema = z
  .object({
    source: z.enum(["management", "media"]).optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    days: z.coerce.number().int().min(1).max(90).default(7),
  })
  .strict();
export type AdminMode = z.infer<typeof adminModeSchema>;
export type AdminReason = z.infer<typeof adminReasonSchema>;
export type AdminModeRequest = z.infer<typeof adminModeRequestSchema>;
export const familyAdminOverviewSchema = z
  .object({
    familyId: adminDecimalSchema,
    actorMemberId: adminDecimalSchema,
    observedAt: z.string().datetime(),
    scope: z.literal("CURRENT_VISIBLE_MEDIA"),
    photos: adminDecimalSchema,
    videos: adminDecimalSchema,
    trash: adminDecimalSchema,
    visibleLogicalBytes: adminDecimalSchema,
    visibleReferencedStorageBytes: adminDecimalSchema,
    visibleDerivedBytes: adminDecimalSchema,
    uploaders: z.array(
      z
        .object({
          memberId: adminDecimalSchema,
          mediaCount: adminDecimalSchema,
          logicalBytes: adminDecimalSchema,
        })
        .strict(),
    ),
    mediaControl: z.enum(["WRITABLE", "PAUSED", "UNAVAILABLE"]),
    backups: adminObservationSchema,
    integrity: adminObservationSchema,
    lastBackupSuccessAt: z.null(),
    lastIntegritySuccessAt: z.null(),
  })
  .strict();
export const adminAuditResponseSchema = z
  .object({
    source: z.enum(["management", "media"]),
    observedAt: z.string().datetime(),
    events: z.array(
      z
        .object({
          id: adminDecimalSchema,
          createdAt: z.string().datetime(),
          actorKind: z.enum(["SYSTEM", "MEMBER"]),
          actorMemberId: adminDecimalSchema.nullable(),
          action: z.string().max(48),
          targetType: z.enum([
            "MEMBER",
            "INVITATION",
            "CONTROL",
            "GRANT",
            "MEDIA",
          ]),
          targetId: adminDecimalSchema,
          resultCategory: z.string().max(48),
        })
        .strict(),
    ),
    nextCursor: z.string().max(2048).nullable(),
  })
  .strict();

export const systemAdminObservationsSchema = z
  .object({
    observedAt: z.string().datetime(),
    database: adminObservationSchema,
    storage: adminObservationSchema
      .extend({
        totalBytes: adminDecimalSchema.nullable(),
        availableBytes: adminDecimalSchema.nullable(),
      })
      .strict(),
    accounting: z
      .object({
        storedOriginalBytes: adminDecimalSchema,
        reservedFutureBytes: adminDecimalSchema,
        retainedStagingBytes: adminDecimalSchema,
        derivedBytes: adminDecimalSchema,
        unsettledDerivedBytes: adminDecimalSchema,
      })
      .strict(),
    workers: z.array(
      z
        .object({
          role: z.enum(["API", "DERIVATIVE", "METADATA", "PURGE"]),
          state: z.enum([
            "STARTING",
            "IDLE",
            "RUNNING",
            "PAUSED",
            "RECOVERY_REQUIRED",
            "STOPPED",
            "UNKNOWN",
            "NOT_CONFIGURED",
          ]),
          bootId: adminOperationIdSchema.nullable(),
          observation: adminObservationSchema,
          completedUnits: adminDecimalSchema.nullable(),
          lastSuccessfulAt: z.string().datetime().nullable(),
        })
        .strict(),
    ),
    backups: adminObservationSchema,
    integrity: adminObservationSchema,
    lastBackupSuccessAt: z.null(),
    lastIntegritySuccessAt: z.null(),
  })
  .strict();
export const systemAdminStatusSchema = adminControlStatusSchema
  .extend({
    observations: systemAdminObservationsSchema,
  })
  .strict();
export type AdminStorageObservation = z.infer<
  typeof systemAdminObservationsSchema
>["storage"];
