import { sql } from "drizzle-orm";
import {
  phase4CapturedSources,
  phase4CapturedTimeStatuses,
  phase4DerivedKinds,
  phase4DerivedStates,
  phase4FailureCodes,
  phase4JobStates,
  phase4JobTypes,
  phase4MediaTypes,
  phase4ProcessingStates,
  phase4TimelineBases,
  phase4WarningFlags,
} from "@family-album/contracts";
import {
  bigint,
  boolean,
  check,
  customType,
  datetime,
  decimal,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  smallint,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const usernameNormalized = customType<{
  data: Buffer;
  driverData: Buffer | Uint8Array | string;
}>({
  dataType: () => "varbinary(512)",
  toDriver(value) {
    if (
      !Buffer.isBuffer(value) ||
      value.byteLength < 1 ||
      value.byteLength > 512
    ) {
      throw new Error("username_normalized must contain 1–512 bytes");
    }
    return value;
  },
  fromDriver: toBuffer,
});

const tokenHash = customType<{
  data: Buffer;
  driverData: Buffer | Uint8Array | string;
}>({
  dataType: () => "binary(32)",
  toDriver(value) {
    if (!Buffer.isBuffer(value) || value.byteLength !== 32) {
      throw new Error("token_hash must contain exactly 32 bytes");
    }
    return value;
  },
  fromDriver: toBuffer,
});

const tagNameNormalized = customType<{
  data: Buffer;
  driverData: Buffer | Uint8Array | string;
}>({
  dataType: () => "varbinary(256)",
  toDriver(value) {
    if (
      !Buffer.isBuffer(value) ||
      value.byteLength < 1 ||
      value.byteLength > 256
    ) {
      throw new Error("name_normalized must contain 1–256 bytes");
    }
    return value;
  },
  fromDriver: toBuffer,
});

const sha256Digest = customType<{
  data: Buffer;
  driverData: Buffer | Uint8Array | string;
}>({
  dataType: () => "binary(32)",
  toDriver(value) {
    if (!Buffer.isBuffer(value) || value.byteLength !== 32) {
      throw new Error("sha256 must contain exactly 32 bytes");
    }
    return value;
  },
  fromDriver: toBuffer,
});

const uploadPublicId = customType<{
  data: Buffer;
  driverData: Buffer | Uint8Array | string;
}>({
  dataType: () => "binary(16)",
  toDriver(value) {
    if (!Buffer.isBuffer(value) || value.byteLength !== 16) {
      throw new Error("upload public_id must contain exactly 16 bytes");
    }
    return value;
  },
  fromDriver: toBuffer,
});

const workerIdentity = customType<{
  data: Buffer;
  driverData: Buffer | Uint8Array | string;
}>({
  dataType: () => "binary(16)",
  toDriver(value) {
    if (!Buffer.isBuffer(value) || value.byteLength !== 16) {
      throw new Error("worker_id must contain exactly 16 bytes");
    }
    return value;
  },
  fromDriver: toBuffer,
});

const phase4WarningMask = Object.values(phase4WarningFlags).reduce(
  (mask, flag) => mask | flag,
  0n,
);

const asciiPasswordHash = customType<{ data: string; driverData: string }>({
  dataType: () => "varchar(255) CHARACTER SET ascii COLLATE ascii_bin",
});

function toBuffer(value: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "binary");
  return Buffer.from(value);
}

const id = () =>
  bigint({ mode: "bigint", unsigned: true }).autoincrement().primaryKey();
const foreignId = (name: string) =>
  bigint(name, { mode: "bigint", unsigned: true });
const timestamp = (name: string) => datetime(name, { mode: "date", fsp: 3 });

export const users = mysqlTable(
  "users",
  {
    id: id(),
    username: varchar("username", { length: 64 }).notNull(),
    usernameNormalized: usernameNormalized("username_normalized").notNull(),
    passwordHash: asciiPasswordHash("password_hash").notNull(),
    displayName: varchar("display_name", { length: 128 }),
    passwordChangedAt: timestamp("password_changed_at").notNull(),
    disabledAt: timestamp("disabled_at"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_users_username_normalized").on(table.usernameNormalized),
  ],
);

export const families = mysqlTable("families", {
  id: id(),
  name: varchar("name", { length: 128 }).notNull(),
  createdAt: timestamp("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestamp("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdate(() => new Date()),
});

export const familyMembers = mysqlTable(
  "family_members",
  {
    id: id(),
    familyId: foreignId("family_id")
      .notNull()
      .references(() => families.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    userId: foreignId("user_id")
      .notNull()
      .references(() => users.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    role: mysqlEnum("role", ["SUPER_ADMIN", "ADMIN", "MEMBER"])
      .notNull()
      .default("MEMBER"),
    joinedAt: timestamp("joined_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    disabledAt: timestamp("disabled_at"),
    leftAt: timestamp("left_at"),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_family_members_family_user").on(
      table.familyId,
      table.userId,
    ),
    uniqueIndex("uq_family_members_family_id").on(table.familyId, table.id),
    index("idx_family_members_user").on(table.userId),
  ],
);

export const invitations = mysqlTable(
  "invitations",
  {
    id: id(),
    familyId: foreignId("family_id")
      .notNull()
      .references(() => families.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    createdByMemberId: foreignId("created_by_member_id").notNull(),
    role: mysqlEnum("role", ["ADMIN", "MEMBER"]).notNull().default("MEMBER"),
    tokenHash: tokenHash("token_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    usedByMemberId: foreignId("used_by_member_id"),
    revokedAt: timestamp("revoked_at"),
    revokedByMemberId: foreignId("revoked_by_member_id"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("uq_invitations_token_hash").on(table.tokenHash),
    index("idx_invitations_family_created").on(table.familyId, table.createdAt),
    index("idx_invitations_expires").on(table.expiresAt),
    index("idx_invitations_family_creator").on(
      table.familyId,
      table.createdByMemberId,
    ),
    index("idx_invitations_family_used_by").on(
      table.familyId,
      table.usedByMemberId,
    ),
    index("idx_invitations_family_revoked_by").on(
      table.familyId,
      table.revokedByMemberId,
    ),
    foreignKey({
      name: "fk_invitations_creator_member",
      columns: [table.familyId, table.createdByMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_invitations_used_by_member",
      columns: [table.familyId, table.usedByMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_invitations_revoked_by_member",
      columns: [table.familyId, table.revokedByMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "chk_invitations_expiry",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "chk_invitations_used_pair",
      sql`(${table.usedAt} IS NULL AND ${table.usedByMemberId} IS NULL) OR (${table.usedAt} IS NOT NULL AND ${table.usedByMemberId} IS NOT NULL)`,
    ),
    check(
      "chk_invitations_used_or_revoked",
      sql`NOT (${table.usedAt} IS NOT NULL AND ${table.revokedAt} IS NOT NULL)`,
    ),
    check(
      "chk_invitations_revoker_requires_revoked_at",
      sql`${table.revokedByMemberId} IS NULL OR ${table.revokedAt} IS NOT NULL`,
    ),
  ],
);

export const sessions = mysqlTable(
  "sessions",
  {
    id: id(),
    userId: foreignId("user_id")
      .notNull()
      .references(() => users.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    tokenHash: tokenHash("token_hash").notNull(),
    clientType: mysqlEnum("client_type", ["WEB", "ANDROID"]).notNull(),
    deviceLabel: varchar("device_label", { length: 128 }),
    authenticatedAt: timestamp("authenticated_at").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    lastSeenAt: timestamp("last_seen_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    revokeReason: mysqlEnum("revoke_reason", [
      "LOGOUT",
      "USER_REVOKE",
      "LOGOUT_ALL",
      "PASSWORD_CHANGE",
      "USER_DISABLED",
    ]),
  },
  (table) => [
    uniqueIndex("uq_sessions_token_hash").on(table.tokenHash),
    index("idx_sessions_user_revoked_created").on(
      table.userId,
      table.revokedAt,
      table.createdAt,
    ),
    index("idx_sessions_expires").on(table.expiresAt),
    check("chk_sessions_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "chk_sessions_last_seen",
      sql`${table.lastSeenAt} >= ${table.createdAt}`,
    ),
    check(
      "chk_sessions_revoked_pair",
      sql`(${table.revokedAt} IS NULL AND ${table.revokeReason} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokeReason} IS NOT NULL)`,
    ),
  ],
);

export const albums = mysqlTable(
  "albums",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    ownerMemberId: foreignId("owner_member_id").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    description: varchar("description", { length: 2000 }),
    visibility: mysqlEnum("visibility", ["FAMILY", "CUSTOM"])
      .notNull()
      .default("CUSTOM"),
    revision: bigint("revision", { mode: "bigint", unsigned: true })
      .notNull()
      .default(sql`1`),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    uniqueIndex("uq_albums_family_id").on(table.familyId, table.id),
    index("idx_albums_family_deleted_id").on(
      table.familyId,
      table.deletedAt,
      table.id,
    ),
    index("idx_albums_family_owner").on(table.familyId, table.ownerMemberId),
    foreignKey({
      name: "fk_albums_family",
      columns: [table.familyId],
      foreignColumns: [families.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_albums_owner_member",
      columns: [table.familyId, table.ownerMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("chk_albums_revision", sql`${table.revision} >= 1`),
    check(
      "chk_albums_deleted_at",
      sql`${table.deletedAt} IS NULL OR ${table.deletedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const albumMembers = mysqlTable(
  "album_members",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    albumId: foreignId("album_id").notNull(),
    memberId: foreignId("member_id").notNull(),
    canView: boolean("can_view").notNull().default(false),
    canUpload: boolean("can_upload").notNull().default(false),
    canEdit: boolean("can_edit").notNull().default(false),
    canDelete: boolean("can_delete").notNull().default(false),
    canManageMembers: boolean("can_manage_members").notNull().default(false),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_album_members_album_member").on(
      table.albumId,
      table.memberId,
    ),
    index("idx_album_members_family_album").on(table.familyId, table.albumId),
    index("idx_album_members_family_member").on(table.familyId, table.memberId),
    foreignKey({
      name: "fk_album_members_album",
      columns: [table.familyId, table.albumId],
      foreignColumns: [albums.familyId, albums.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_album_members_member",
      columns: [table.familyId, table.memberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("chk_album_members_view_boolean", sql`${table.canView} IN (0,1)`),
    check("chk_album_members_upload_boolean", sql`${table.canUpload} IN (0,1)`),
    check("chk_album_members_edit_boolean", sql`${table.canEdit} IN (0,1)`),
    check("chk_album_members_delete_boolean", sql`${table.canDelete} IN (0,1)`),
    check(
      "chk_album_members_manage_members_boolean",
      sql`${table.canManageMembers} IN (0,1)`,
    ),
    check(
      "chk_album_members_view_required",
      sql`${table.canView} = 1 OR (${table.canUpload} = 0 AND ${table.canEdit} = 0 AND ${table.canDelete} = 0 AND ${table.canManageMembers} = 0)`,
    ),
  ],
);

export const storageObjects = mysqlTable(
  "storage_objects",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    sha256: sha256Digest("sha256").notNull(),
    byteSize: bigint("byte_size", { mode: "bigint", unsigned: true }).notNull(),
    keyVersion: smallint("key_version", { unsigned: true })
      .notNull()
      .default(1),
    state: mysqlEnum("state", [
      "AVAILABLE",
      "MISSING",
      "CORRUPT",
      "PURGING",
    ]).notNull(),
    durableAt: timestamp("durable_at").notNull(),
    verifiedAt: timestamp("verified_at").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_storage_objects_family_id").on(table.familyId, table.id),
    uniqueIndex("uq_storage_objects_family_hash_size").on(
      table.familyId,
      table.sha256,
      table.byteSize,
    ),
    index("idx_storage_objects_state_verified").on(
      table.state,
      table.verifiedAt,
      table.id,
    ),
    foreignKey({
      name: "fk_storage_objects_family",
      columns: [table.familyId],
      foreignColumns: [families.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("chk_storage_objects_size", sql`${table.byteSize} > 0`),
    check("chk_storage_objects_key_version", sql`${table.keyVersion} = 1`),
    check(
      "chk_storage_objects_verified",
      sql`${table.verifiedAt} >= ${table.durableAt}`,
    ),
  ],
);

export const uploadSessions = mysqlTable(
  "upload_sessions",
  {
    id: id(),
    publicId: uploadPublicId("public_id").notNull(),
    familyId: foreignId("family_id").notNull(),
    createdByMemberId: foreignId("created_by_member_id").notNull(),
    originalFilename: varchar("original_filename", { length: 255 }).notNull(),
    reportedMime: varchar("reported_mime", { length: 127 }),
    declaredSize: bigint("declared_size", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    committedOffset: bigint("committed_offset", {
      mode: "bigint",
      unsigned: true,
    })
      .notNull()
      .default(sql`0`),
    state: mysqlEnum("state", [
      "CREATED",
      "UPLOADING",
      "FINALIZING",
      "COMPLETE",
      "RETIRED",
      "FAILED",
      "ABORTED",
      "EXPIRED",
    ])
      .notNull()
      .default("CREATED"),
    computedSha256: sha256Digest("computed_sha256"),
    finalizeStartedAt: timestamp("finalize_started_at"),
    storageObjectId: foreignId("storage_object_id"),
    retiredStorageObjectId: foreignId("retired_storage_object_id"),
    retiredPurgeId: foreignId("retired_purge_id"),
    retiredAt: timestamp("retired_at"),
    completedAt: timestamp("completed_at"),
    terminalAt: timestamp("terminal_at"),
    failureCode: varchar("failure_code", { length: 48 }),
    expiresAt: timestamp("expires_at").notNull(),
    stagingCleanedAt: timestamp("staging_cleaned_at"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_upload_sessions_public_id").on(table.publicId),
    uniqueIndex("uq_upload_sessions_family_id_object").on(
      table.familyId,
      table.id,
      table.storageObjectId,
    ),
    index("idx_upload_sessions_family_creator_state").on(
      table.familyId,
      table.createdByMemberId,
      table.state,
      table.id,
    ),
    index("idx_upload_sessions_state_expiry").on(
      table.state,
      table.expiresAt,
      table.id,
    ),
    index("idx_upload_sessions_family_object").on(
      table.familyId,
      table.storageObjectId,
    ),
    index("idx_upload_sessions_cleanup").on(
      table.state,
      table.stagingCleanedAt,
      table.id,
    ),
    foreignKey({
      name: "fk_upload_sessions_family",
      columns: [table.familyId],
      foreignColumns: [families.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_upload_sessions_creator_member",
      columns: [table.familyId, table.createdByMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_upload_sessions_storage_object",
      columns: [table.familyId, table.storageObjectId],
      foreignColumns: [storageObjects.familyId, storageObjects.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_upload_sessions_retired_purge",
      columns: [table.familyId, table.retiredPurgeId],
      foreignColumns: [purgeIntents.familyId, purgeIntents.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "chk_upload_sessions_size_offset",
      sql`${table.declaredSize} > 0 AND ${table.committedOffset} <= ${table.declaredSize}`,
    ),
    check(
      "chk_upload_sessions_expiry",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "chk_upload_sessions_created",
      sql`${table.state} <> 'CREATED' OR ${table.committedOffset} = 0`,
    ),
    check(
      "chk_upload_sessions_uploading",
      sql`${table.state} <> 'UPLOADING' OR ${table.committedOffset} > 0`,
    ),
    check(
      "chk_upload_sessions_finalize_pair",
      sql`(${table.computedSha256} IS NULL AND ${table.finalizeStartedAt} IS NULL) OR (${table.computedSha256} IS NOT NULL AND ${table.finalizeStartedAt} IS NOT NULL)`,
    ),
    check(
      "chk_upload_sessions_finalize_state",
      sql`(${table.state} IN ('FINALIZING','COMPLETE','RETIRED') AND ${table.computedSha256} IS NOT NULL AND ${table.finalizeStartedAt} IS NOT NULL AND ${table.committedOffset} = ${table.declaredSize}) OR (${table.state} IN ('CREATED','UPLOADING','ABORTED','EXPIRED') AND ${table.computedSha256} IS NULL AND ${table.finalizeStartedAt} IS NULL) OR (${table.state} = 'FAILED' AND ((${table.computedSha256} IS NULL AND ${table.finalizeStartedAt} IS NULL) OR (${table.computedSha256} IS NOT NULL AND ${table.finalizeStartedAt} IS NOT NULL AND ${table.committedOffset} = ${table.declaredSize})))`,
    ),
    check(
      "chk_upload_sessions_complete",
      sql`(${table.state} = 'COMPLETE' AND ${table.storageObjectId} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.terminalAt} IS NULL AND ${table.retiredStorageObjectId} IS NULL AND ${table.retiredPurgeId} IS NULL AND ${table.retiredAt} IS NULL) OR (${table.state} = 'RETIRED' AND ${table.storageObjectId} IS NULL AND ${table.completedAt} IS NOT NULL AND ${table.terminalAt} IS NULL AND ${table.retiredStorageObjectId} IS NOT NULL AND ${table.retiredPurgeId} IS NOT NULL AND ${table.retiredAt} IS NOT NULL) OR (${table.state} NOT IN ('COMPLETE','RETIRED') AND ${table.storageObjectId} IS NULL AND ${table.completedAt} IS NULL AND ${table.retiredStorageObjectId} IS NULL AND ${table.retiredPurgeId} IS NULL AND ${table.retiredAt} IS NULL)`,
    ),
    check(
      "chk_upload_sessions_terminal",
      sql`(${table.state} IN ('FAILED','ABORTED','EXPIRED') AND ${table.terminalAt} IS NOT NULL) OR (${table.state} NOT IN ('FAILED','ABORTED','EXPIRED') AND ${table.terminalAt} IS NULL)`,
    ),
    check(
      "chk_upload_sessions_failure",
      sql`(${table.state} = 'FAILED' AND ${table.failureCode} IS NOT NULL) OR (${table.state} <> 'FAILED' AND ${table.failureCode} IS NULL)`,
    ),
    check(
      "chk_upload_sessions_times",
      sql`(${table.finalizeStartedAt} IS NULL OR ${table.finalizeStartedAt} >= ${table.createdAt}) AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt}) AND (${table.terminalAt} IS NULL OR ${table.terminalAt} >= ${table.createdAt}) AND (${table.stagingCleanedAt} IS NULL OR ${table.stagingCleanedAt} >= ${table.createdAt}) AND (${table.completedAt} IS NULL OR (${table.finalizeStartedAt} IS NOT NULL AND ${table.completedAt} >= ${table.finalizeStartedAt})) AND (${table.retiredAt} IS NULL OR (${table.completedAt} IS NOT NULL AND ${table.retiredAt} >= ${table.completedAt})) AND (${table.stagingCleanedAt} IS NULL OR ${table.state} IN ('COMPLETE','RETIRED','FAILED','ABORTED','EXPIRED'))`,
    ),
  ],
);

export const mediaItems = mysqlTable(
  "media_items",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    storageObjectId: foreignId("storage_object_id").notNull(),
    sourceUploadId: foreignId("source_upload_id").notNull(),
    uploadedAt: timestamp("uploaded_at").notNull(),
    mediaType: mysqlEnum("media_type", phase4MediaTypes)
      .notNull()
      .default("UNKNOWN"),
    detectedMime: varchar("detected_mime", { length: 127 }),
    processingState: mysqlEnum("processing_state", phase4ProcessingStates)
      .notNull()
      .default("PENDING"),
    generation: bigint("generation", { mode: "bigint", unsigned: true })
      .notNull()
      .default(sql`1`),
    recipeId: smallint("recipe_id", { unsigned: true }).notNull().default(1),
    metadataGeneration: foreignId("metadata_generation"),
    rawWidth: int("raw_width", { unsigned: true }),
    rawHeight: int("raw_height", { unsigned: true }),
    displayWidth: int("display_width", { unsigned: true }),
    displayHeight: int("display_height", { unsigned: true }),
    durationMs: foreignId("duration_ms"),
    orientation: tinyint("orientation", { unsigned: true }),
    videoRotationDegrees: smallint("video_rotation_degrees"),
    isAnimated: boolean("is_animated").notNull().default(false),
    motionHint: boolean("motion_hint").notNull().default(false),
    capturedLocalAt: timestamp("captured_local_at"),
    capturedAtUtc: timestamp("captured_at_utc"),
    capturedOffsetMinutes: smallint("captured_offset_minutes"),
    capturedSource: mysqlEnum("captured_source", phase4CapturedSources)
      .notNull()
      .default("NONE"),
    capturedTimeStatus: mysqlEnum(
      "captured_time_status",
      phase4CapturedTimeStatuses,
    )
      .notNull()
      .default("ABSENT"),
    timelineKey: timestamp("timeline_key").notNull(),
    timelineBasis: mysqlEnum("timeline_basis", phase4TimelineBases)
      .notNull()
      .default("UPLOAD_UTC"),
    gpsLatitude: decimal("gps_latitude", { precision: 9, scale: 6 }),
    gpsLongitude: decimal("gps_longitude", { precision: 10, scale: 6 }),
    cameraMake: varchar("camera_make", { length: 128 }),
    cameraModel: varchar("camera_model", { length: 128 }),
    videoCodec: varchar("video_codec", { length: 32 }),
    videoContainer: varchar("video_container", { length: 32 }),
    videoTransfer: varchar("video_transfer", { length: 32 }),
    warningFlags: bigint("warning_flags", { mode: "bigint", unsigned: true })
      .notNull()
      .default(sql`0`),
    lastFailureCode: mysqlEnum("last_failure_code", phase4FailureCodes),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
    description: varchar("description", { length: 4000 }),
    noteRevision: bigint("note_revision", { mode: "bigint", unsigned: true })
      .notNull()
      .default(sql`1`),
    lifecycleRevision: bigint("lifecycle_revision", {
      mode: "bigint",
      unsigned: true,
    })
      .notNull()
      .default(sql`1`),
    trashedAt: timestamp("trashed_at"),
    trashedByMemberId: foreignId("trashed_by_member_id"),
    purgeAfter: timestamp("purge_after"),
    purgeIntentId: foreignId("purge_intent_id"),
  },
  (table) => [
    uniqueIndex("uq_media_items_family_storage_object").on(
      table.familyId,
      table.storageObjectId,
    ),
    uniqueIndex("uq_media_items_family_id").on(table.familyId, table.id),
    index("idx_media_items_family_timeline").on(
      table.familyId,
      table.timelineKey,
      table.id,
    ),
    index("idx_media_items_processing").on(table.processingState, table.id),
    index("idx_media_items_trash_family").on(
      table.familyId,
      table.trashedAt,
      table.id,
    ),
    index("idx_media_items_purge_after").on(table.purgeAfter, table.id),
    foreignKey({
      name: "fk_media_items_trashed_by",
      columns: [table.familyId, table.trashedByMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_media_items_purge_intent",
      columns: [table.familyId, table.purgeIntentId],
      foreignColumns: [purgeIntents.familyId, purgeIntents.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_media_items_storage_object",
      columns: [table.familyId, table.storageObjectId],
      foreignColumns: [storageObjects.familyId, storageObjects.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_media_items_source_upload",
      columns: [table.familyId, table.sourceUploadId, table.storageObjectId],
      foreignColumns: [
        uploadSessions.familyId,
        uploadSessions.id,
        uploadSessions.storageObjectId,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("chk_media_items_generation", sql`${table.generation} >= 1`),
    check(
      "chk_media_items_description",
      sql`${table.description} IS NULL OR (CHAR_LENGTH(${table.description}) BETWEEN 1 AND 4000 AND OCTET_LENGTH(${table.description}) <= 16000)`,
    ),
    check("chk_media_items_note_revision", sql`${table.noteRevision} >= 1`),
    check(
      "chk_media_items_lifecycle_revision",
      sql`${table.lifecycleRevision} >= 1`,
    ),
    check(
      "chk_media_items_trash_state",
      sql`(${table.trashedAt} IS NULL AND ${table.trashedByMemberId} IS NULL AND ${table.purgeAfter} IS NULL AND ${table.purgeIntentId} IS NULL) OR (${table.trashedAt} IS NOT NULL AND ${table.trashedByMemberId} IS NOT NULL AND ${table.purgeAfter} IS NOT NULL AND (${table.trashedAt} + INTERVAL 30 DAY) IS NOT NULL AND ${table.purgeAfter} = ${table.trashedAt} + INTERVAL 30 DAY)`,
    ),
    check("chk_media_items_recipe", sql`${table.recipeId} >= 1`),
    check(
      "chk_media_items_metadata_generation",
      sql`${table.metadataGeneration} IS NULL OR (${table.metadataGeneration} >= 1 AND ${table.metadataGeneration} <= ${table.generation})`,
    ),
    check(
      "chk_media_items_raw_dimensions",
      sql`(${table.rawWidth} IS NULL AND ${table.rawHeight} IS NULL) OR (${table.rawWidth} IS NOT NULL AND ${table.rawHeight} IS NOT NULL AND ${table.rawWidth} > 0 AND ${table.rawHeight} > 0)`,
    ),
    check(
      "chk_media_items_display_dimensions",
      sql`(${table.displayWidth} IS NULL AND ${table.displayHeight} IS NULL) OR (${table.displayWidth} IS NOT NULL AND ${table.displayHeight} IS NOT NULL AND ${table.displayWidth} > 0 AND ${table.displayHeight} > 0)`,
    ),
    check(
      "chk_media_items_duration",
      sql`${table.durationMs} IS NULL OR ${table.durationMs} <= 86400000`,
    ),
    check(
      "chk_media_items_orientation",
      sql`${table.orientation} IS NULL OR ${table.orientation} BETWEEN 1 AND 8`,
    ),
    check(
      "chk_media_items_video_rotation",
      sql`${table.videoRotationDegrees} IS NULL OR ${table.videoRotationDegrees} IN (0,90,180,270)`,
    ),
    check(
      "chk_media_items_animated_boolean",
      sql`${table.isAnimated} IN (0,1)`,
    ),
    check("chk_media_items_motion_boolean", sql`${table.motionHint} IN (0,1)`),
    check(
      "chk_media_items_gps",
      sql`(${table.gpsLatitude} IS NULL AND ${table.gpsLongitude} IS NULL) OR (${table.gpsLatitude} IS NOT NULL AND ${table.gpsLongitude} IS NOT NULL AND ${table.gpsLatitude} BETWEEN -90 AND 90 AND ${table.gpsLongitude} BETWEEN -180 AND 180)`,
    ),
    check(
      "chk_media_items_capture",
      sql`(${table.capturedTimeStatus} = 'ABSENT' AND ${table.capturedSource} = 'NONE' AND ${table.capturedLocalAt} IS NULL AND ${table.capturedAtUtc} IS NULL AND ${table.capturedOffsetMinutes} IS NULL) OR (${table.capturedTimeStatus} = 'OFFSET_UNKNOWN' AND ${table.capturedSource} <> 'NONE' AND ${table.capturedLocalAt} IS NOT NULL AND ${table.capturedAtUtc} IS NULL AND ${table.capturedOffsetMinutes} IS NULL) OR (${table.capturedTimeStatus} = 'OFFSET_KNOWN' AND ${table.capturedSource} <> 'NONE' AND ${table.capturedLocalAt} IS NOT NULL AND ${table.capturedAtUtc} IS NOT NULL AND ${table.capturedOffsetMinutes} IS NOT NULL AND ${table.capturedOffsetMinutes} BETWEEN -840 AND 840 AND (ABS(${table.capturedOffsetMinutes}) < 840 OR MOD(${table.capturedOffsetMinutes},60) = 0))`,
    ),
    check(
      "chk_media_items_timeline",
      sql`(${table.timelineBasis} = 'CAPTURE_LOCAL' AND ${table.capturedLocalAt} IS NOT NULL AND ${table.timelineKey} = ${table.capturedLocalAt}) OR (${table.timelineBasis} = 'UPLOAD_UTC' AND ${table.timelineKey} = ${table.uploadedAt})`,
    ),
    check(
      "chk_media_items_ready_metadata",
      sql`${table.processingState} <> 'READY' OR (${table.metadataGeneration} IS NOT NULL AND ${table.metadataGeneration} = ${table.generation})`,
    ),
    check(
      "chk_media_items_warning_flags",
      sql`${table.warningFlags} <= ${sql.raw(phase4WarningMask.toString())}`,
    ),
    check(
      "chk_media_items_failure",
      sql`(${table.processingState} IN ('FAILED','BLOCKED') AND ${table.lastFailureCode} IS NOT NULL) OR (${table.processingState} NOT IN ('FAILED','BLOCKED') AND (${table.processingState} = 'PARTIAL' OR ${table.lastFailureCode} IS NULL))`,
    ),
  ],
);

// Historical IDs deliberately have no FK to media_items/storage_objects: both
// live rows must eventually be removable while the intent and audit survive.
export const purgeIntents = mysqlTable(
  "purge_intents",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    operationId: varchar("operation_id", { length: 36 }).notNull(),
    mediaId: foreignId("media_id").notNull(),
    storageObjectId: foreignId("storage_object_id").notNull(),
    sourceUploadId: foreignId("source_upload_id").notNull(),
    lifecycleRevision: bigint("lifecycle_revision", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    trashedAt: timestamp("trashed_at").notNull(),
    purgeAfter: timestamp("purge_after").notNull(),
    requestedAt: timestamp("requested_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    requestSource: mysqlEnum("request_source", [
      "MANUAL",
      "SCHEDULED",
    ]).notNull(),
    actorMemberId: foreignId("actor_member_id"),
    progress: mysqlEnum("progress", [
      "REQUESTED",
      "DETACHED",
      "FILES_REMOVED",
      "COMPLETED",
    ])
      .notNull()
      .default("REQUESTED"),
    executionState: mysqlEnum("execution_state", [
      "QUEUED",
      "RUNNING",
      "RETRY_WAIT",
      "BLOCKED",
      "DONE",
    ])
      .notNull()
      .default("QUEUED"),
    workerId: customType<{
      data: Buffer;
      driverData: Buffer | Uint8Array | string;
    }>({ dataType: () => "binary(16)", fromDriver: toBuffer })("worker_id"),
    leaseEpoch: bigint("lease_epoch", { mode: "bigint", unsigned: true })
      .notNull()
      .default(sql`0`),
    lockedAt: timestamp("locked_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    lockedUntil: timestamp("locked_until"),
    availableAt: timestamp("available_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    attempts: int("attempts", { unsigned: true }).notNull().default(0),
    maxAttempts: int("max_attempts", { unsigned: true }).notNull().default(8),
    failureCategory: mysqlEnum("failure_category", [
      "REFERENCE_CONFLICT",
      "FILESYSTEM_UNCERTAIN",
      "CAPACITY_UNAVAILABLE",
      "TRANSIENT_DB",
      "INVARIANT_VIOLATION",
    ]),
    completedAt: timestamp("completed_at"),
    originalBytes: bigint("original_bytes", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    derivedBytes: bigint("derived_bytes", { mode: "bigint", unsigned: true })
      .notNull()
      .default(sql`0`),
    releasedBytes: bigint("released_bytes", { mode: "bigint", unsigned: true })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_purge_intents_family_id").on(table.familyId, table.id),
    uniqueIndex("uq_purge_intents_operation").on(
      table.familyId,
      table.operationId,
    ),
    uniqueIndex("uq_purge_intents_lifecycle").on(
      table.familyId,
      table.mediaId,
      table.lifecycleRevision,
    ),
    index("idx_purge_intents_claim").on(
      table.executionState,
      table.availableAt,
      table.id,
    ),
    index("idx_purge_intents_lease").on(
      table.executionState,
      table.lockedUntil,
      table.id,
    ),
    foreignKey({
      name: "fk_purge_intents_family",
      columns: [table.familyId],
      foreignColumns: [families.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_purge_intents_actor",
      columns: [table.familyId, table.actorMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("chk_purge_intents_revision", sql`${table.lifecycleRevision} >= 1`),
    check(
      "chk_purge_intents_retention",
      sql`(${table.trashedAt} + INTERVAL 30 DAY) IS NOT NULL AND ${table.purgeAfter} = ${table.trashedAt} + INTERVAL 30 DAY`,
    ),
    check(
      "chk_purge_intents_lease",
      sql`(${table.executionState} = 'RUNNING' AND ${table.workerId} IS NOT NULL AND ${table.lockedAt} IS NOT NULL AND ${table.heartbeatAt} IS NOT NULL AND ${table.lockedUntil} IS NOT NULL AND ${table.leaseEpoch} >= 1) OR (${table.executionState} <> 'RUNNING' AND ${table.workerId} IS NULL AND ${table.lockedAt} IS NULL AND ${table.heartbeatAt} IS NULL AND ${table.lockedUntil} IS NULL)`,
    ),
    check(
      "chk_purge_intents_progress",
      sql`(${table.progress} = 'COMPLETED' AND ${table.executionState} = 'DONE' AND ${table.completedAt} IS NOT NULL) OR (${table.progress} <> 'COMPLETED' AND ${table.executionState} <> 'DONE' AND ${table.completedAt} IS NULL)`,
    ),
    check(
      "chk_purge_intents_attempts",
      sql`${table.maxAttempts} >= 1 AND ${table.attempts} <= ${table.maxAttempts}`,
    ),
    check(
      "chk_purge_intents_bytes",
      sql`${table.originalBytes} > 0 AND ${table.releasedBytes} <= ${table.originalBytes} + ${table.derivedBytes}`,
    ),
    check(
      "chk_purge_intents_times",
      sql`${table.requestedAt} >= ${table.trashedAt} AND ${table.availableAt} >= ${table.requestedAt}`,
    ),
  ],
);

export const purgeFiles = mysqlTable(
  "purge_files",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    purgeIntentId: foreignId("purge_intent_id").notNull(),
    fileKind: mysqlEnum("file_kind", ["ORIGINAL", "DERIVED"]).notNull(),
    originalSingletonSlot: tinyint("original_singleton_slot", {
      unsigned: true,
    }),
    // Required, internal canonical identity digest avoids MySQL NULL-unique gaps.
    identityKey: sha256Digest("identity_key").notNull(),
    storageObjectId: foreignId("storage_object_id"),
    mediaId: foreignId("media_id"),
    contentSha256: sha256Digest("content_sha256"),
    byteSize: bigint("byte_size", { mode: "bigint", unsigned: true }).notNull(),
    rootMarkerId: varchar("root_marker_id", { length: 32 }).notNull(),
    rootDevice: bigint("root_device", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    quarantineSlot: customType<{
      data: Buffer;
      driverData: Buffer | Uint8Array | string;
    }>({ dataType: () => "binary(16)", fromDriver: toBuffer })(
      "quarantine_slot",
    ),
    quarantineDevice: bigint("quarantine_device", {
      mode: "bigint",
      unsigned: true,
    }),
    quarantineInode: bigint("quarantine_inode", {
      mode: "bigint",
      unsigned: true,
    }),
    generation: bigint("generation", { mode: "bigint", unsigned: true }),
    recipeId: smallint("recipe_id", { unsigned: true }),
    derivedKind: mysqlEnum("derived_kind", phase4DerivedKinds),
    producerJobId: foreignId("producer_job_id"),
    producerEpoch: bigint("producer_epoch", { mode: "bigint", unsigned: true }),
    stage: mysqlEnum("stage", [
      "CATALOGUED",
      "QUARANTINED",
      "UNLINK_ARMED",
      "REMOVED",
      "ABSENT_DERIVED",
    ])
      .notNull()
      .default("CATALOGUED"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_purge_files_identity").on(
      table.familyId,
      table.purgeIntentId,
      table.identityKey,
    ),
    uniqueIndex("uq_purge_files_original_singleton").on(
      table.familyId,
      table.purgeIntentId,
      table.originalSingletonSlot,
    ),
    index("idx_purge_files_progress").on(
      table.familyId,
      table.purgeIntentId,
      table.stage,
      table.id,
    ),
    foreignKey({
      name: "fk_purge_files_intent",
      columns: [table.familyId, table.purgeIntentId],
      foreignColumns: [purgeIntents.familyId, purgeIntents.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("chk_purge_files_size", sql`${table.byteSize} > 0`),
    check(
      "chk_purge_files_original_singleton",
      sql`(${table.fileKind} = 'ORIGINAL' AND ${table.originalSingletonSlot} IS NOT NULL AND ${table.originalSingletonSlot} = 1) OR (${table.fileKind} = 'DERIVED' AND ${table.originalSingletonSlot} IS NULL)`,
    ),
    check(
      "chk_purge_files_kind",
      sql`(${table.fileKind} = 'ORIGINAL' AND ${table.storageObjectId} IS NOT NULL AND ${table.contentSha256} IS NOT NULL AND ${table.generation} IS NULL AND ${table.recipeId} IS NULL AND ${table.derivedKind} IS NULL AND ${table.producerJobId} IS NULL AND ${table.producerEpoch} IS NULL AND ${table.stage} <> 'ABSENT_DERIVED') OR (${table.fileKind} = 'DERIVED' AND ${table.mediaId} IS NOT NULL AND ${table.generation} IS NOT NULL AND ${table.recipeId} IS NOT NULL AND ${table.derivedKind} IS NOT NULL AND ${table.producerJobId} IS NOT NULL AND ${table.producerEpoch} IS NOT NULL AND ${table.contentSha256} IS NOT NULL AND ${table.storageObjectId} IS NULL)`,
    ),
    check(
      "chk_purge_files_quarantine",
      sql`(${table.stage} IN ('CATALOGUED','ABSENT_DERIVED') AND ${table.quarantineSlot} IS NULL AND ${table.quarantineDevice} IS NULL AND ${table.quarantineInode} IS NULL) OR (${table.stage} IN ('QUARANTINED','UNLINK_ARMED','REMOVED') AND ${table.quarantineSlot} IS NOT NULL AND ${table.quarantineDevice} IS NOT NULL AND ${table.quarantineInode} IS NOT NULL)`,
    ),
  ],
);

export const auditLogs = mysqlTable(
  "audit_logs",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    operationId: varchar("operation_id", { length: 36 }).notNull(),
    purgeIntentId: foreignId("purge_intent_id"),
    mediaId: foreignId("media_id").notNull(),
    storageObjectId: foreignId("storage_object_id").notNull(),
    actorKind: mysqlEnum("actor_kind", ["MEMBER", "SYSTEM"]).notNull(),
    actorMemberId: foreignId("actor_member_id"),
    action: mysqlEnum("action", [
      "TRASH",
      "RESTORE",
      "PERMANENT_DELETE_REQUEST",
      "PURGE_STARTED",
      "PURGE_COMPLETED",
      "PURGE_FAILED",
    ]).notNull(),
    lifecycleRevision: bigint("lifecycle_revision", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    transitionId: varchar("transition_id", { length: 36 }).notNull(),
    resultCategory: mysqlEnum("result_category", [
      "SUCCESS",
      "REFERENCE_CONFLICT",
      "FILESYSTEM_UNCERTAIN",
      "CAPACITY_UNAVAILABLE",
      "TRANSIENT_DB",
      "INVARIANT_VIOLATION",
    ]).notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("uq_audit_logs_transition").on(
      table.familyId,
      table.operationId,
      table.action,
      table.transitionId,
    ),
    index("idx_audit_logs_media_time").on(
      table.familyId,
      table.mediaId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "fk_audit_logs_family",
      columns: [table.familyId],
      foreignColumns: [families.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_audit_logs_purge",
      columns: [table.familyId, table.purgeIntentId],
      foreignColumns: [purgeIntents.familyId, purgeIntents.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_audit_logs_actor",
      columns: [table.familyId, table.actorMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "chk_audit_logs_actor",
      sql`(${table.actorKind} = 'MEMBER' AND ${table.actorMemberId} IS NOT NULL) OR (${table.actorKind} = 'SYSTEM' AND ${table.actorMemberId} IS NULL)`,
    ),
    check("chk_audit_logs_revision", sql`${table.lifecycleRevision} >= 1`),
  ],
);

export const userFavorites = mysqlTable(
  "user_favorites",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    memberId: foreignId("member_id").notNull(),
    mediaId: foreignId("media_id").notNull(),

    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("uq_user_favorites_identity").on(
      table.familyId,
      table.memberId,
      table.mediaId,
    ),
    index("idx_user_favorites_member_time").on(
      table.familyId,
      table.memberId,
      table.createdAt,
      table.id,
    ),
    index("idx_user_favorites_media").on(table.familyId, table.mediaId),
    foreignKey({
      name: "fk_user_favorites_member",
      columns: [table.familyId, table.memberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_user_favorites_media",
      columns: [table.familyId, table.mediaId],
      foreignColumns: [mediaItems.familyId, mediaItems.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
  ],
);

export const familyFeatured = mysqlTable(
  "family_featured",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    mediaId: foreignId("media_id").notNull(),
    featuredByMemberId: foreignId("featured_by_member_id").notNull(),

    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("uq_family_featured_identity").on(
      table.familyId,
      table.mediaId,
    ),
    index("idx_family_featured_time").on(
      table.familyId,
      table.createdAt,
      table.id,
    ),
    index("idx_family_featured_actor").on(
      table.familyId,
      table.featuredByMemberId,
    ),
    foreignKey({
      name: "fk_family_featured_media",
      columns: [table.familyId, table.mediaId],
      foreignColumns: [mediaItems.familyId, mediaItems.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_family_featured_actor",
      columns: [table.familyId, table.featuredByMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
  ],
);

export const tags = mysqlTable(
  "tags",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),

    name: varchar("name", { length: 64 }).notNull(),
    nameNormalized: tagNameNormalized("name_normalized").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("uq_tags_identity").on(table.familyId, table.nameNormalized),
    uniqueIndex("uq_tags_family_id").on(table.familyId, table.id),

    foreignKey({
      name: "fk_tags_family",
      columns: [table.familyId],
      foreignColumns: [families.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "chk_tags_name",
      sql`CHAR_LENGTH(${table.name}) BETWEEN 1 AND 64 AND OCTET_LENGTH(${table.name}) <= 256`,
    ),
    check(
      "chk_tags_normalized",
      sql`OCTET_LENGTH(${table.nameNormalized}) BETWEEN 1 AND 256`,
    ),
  ],
);

export const mediaTags = mysqlTable(
  "media_tags",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    mediaId: foreignId("media_id").notNull(),
    tagId: foreignId("tag_id").notNull(),

    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("uq_media_tags_identity").on(
      table.familyId,
      table.mediaId,
      table.tagId,
    ),
    index("idx_media_tags_tag").on(table.familyId, table.tagId, table.mediaId),
    foreignKey({
      name: "fk_media_tags_media",
      columns: [table.familyId, table.mediaId],
      foreignColumns: [mediaItems.familyId, mediaItems.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_media_tags_tag",
      columns: [table.familyId, table.tagId],
      foreignColumns: [tags.familyId, tags.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
  ],
);

export const comments = mysqlTable(
  "comments",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    mediaId: foreignId("media_id").notNull(),
    authorMemberId: foreignId("author_member_id").notNull(),
    body: varchar("body", { length: 2000 }).notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("idx_comments_media_time").on(
      table.familyId,
      table.mediaId,
      table.createdAt,
      table.id,
    ),
    index("idx_comments_author").on(table.familyId, table.authorMemberId),
    foreignKey({
      name: "fk_comments_media",
      columns: [table.familyId, table.mediaId],
      foreignColumns: [mediaItems.familyId, mediaItems.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_comments_author",
      columns: [table.familyId, table.authorMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "chk_comments_body",
      sql`CHAR_LENGTH(${table.body}) BETWEEN 1 AND 2000 AND OCTET_LENGTH(${table.body}) <= 8000`,
    ),
  ],
);

export const albumMedia = mysqlTable(
  "album_media",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    albumId: foreignId("album_id").notNull(),
    mediaId: foreignId("media_id").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("uq_album_media_placement").on(
      table.familyId,
      table.albumId,
      table.mediaId,
    ),
    index("idx_album_media_media").on(
      table.familyId,
      table.mediaId,
      table.albumId,
    ),
    foreignKey({
      name: "fk_album_media_album",
      columns: [table.familyId, table.albumId],
      foreignColumns: [albums.familyId, albums.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_album_media_media",
      columns: [table.familyId, table.mediaId],
      foreignColumns: [mediaItems.familyId, mediaItems.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
  ],
);

export const shares = mysqlTable(
  "shares",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    albumId: foreignId("album_id").notNull(),
    tokenHash: tokenHash("token_hash").notNull(),
    createdByMemberId: foreignId("created_by_member_id").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    revokedByMemberId: foreignId("revoked_by_member_id"),
  },
  (table) => [
    uniqueIndex("uq_shares_family_id").on(table.familyId, table.id),
    uniqueIndex("uq_shares_token_hash").on(table.tokenHash),
    index("idx_shares_family_album_id").on(
      table.familyId,
      table.albumId,
      table.id,
    ),
    index("idx_shares_expires").on(table.expiresAt, table.id),
    foreignKey({
      name: "fk_shares_family",
      columns: [table.familyId],
      foreignColumns: [families.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_shares_album",
      columns: [table.familyId, table.albumId],
      foreignColumns: [albums.familyId, albums.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_shares_creator",
      columns: [table.familyId, table.createdByMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_shares_revoker",
      columns: [table.familyId, table.revokedByMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("chk_shares_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "chk_shares_revoke_pair",
      sql`(${table.revokedAt} IS NULL AND ${table.revokedByMemberId} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedByMemberId} IS NOT NULL)`,
    ),
    check(
      "chk_shares_revoke_after_create",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const shareEvents = mysqlTable(
  "share_events",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    shareId: foreignId("share_id").notNull(),
    eventType: mysqlEnum("event_type", [
      "CREATE",
      "ACCESS",
      "REVOKE",
    ]).notNull(),
    actorMemberId: foreignId("actor_member_id"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("idx_share_events_share").on(table.familyId, table.shareId, table.id),
    foreignKey({
      name: "fk_share_events_share",
      columns: [table.familyId, table.shareId],
      foreignColumns: [shares.familyId, shares.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_share_events_actor",
      columns: [table.familyId, table.actorMemberId],
      foreignColumns: [familyMembers.familyId, familyMembers.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "chk_share_events_actor",
      sql`(${table.eventType} IN ('CREATE','REVOKE') AND ${table.actorMemberId} IS NOT NULL) OR (${table.eventType} = 'ACCESS' AND ${table.actorMemberId} IS NULL)`,
    ),
  ],
);

export const backgroundJobs = mysqlTable(
  "background_jobs",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    mediaId: foreignId("media_id").notNull(),
    generation: bigint("generation", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    recipeId: smallint("recipe_id", { unsigned: true }).notNull(),
    jobType: mysqlEnum("job_type", phase4JobTypes).notNull(),
    state: mysqlEnum("state", phase4JobStates).notNull().default("QUEUED"),
    attempts: tinyint("attempts", { unsigned: true }).notNull().default(0),
    maxAttempts: tinyint("max_attempts", { unsigned: true })
      .notNull()
      .default(3),
    availableAt: timestamp("available_at").notNull(),
    lockedAt: timestamp("locked_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    lockedUntil: timestamp("locked_until"),
    workerId: workerIdentity("worker_id"),
    leaseEpoch: bigint("lease_epoch", { mode: "bigint", unsigned: true })
      .notNull()
      .default(sql`0`),
    lastFailureCode: mysqlEnum("last_failure_code", phase4FailureCodes),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    uniqueIndex("uq_background_jobs_identity").on(
      table.familyId,
      table.mediaId,
      table.generation,
      table.recipeId,
      table.jobType,
    ),
    uniqueIndex("uq_background_jobs_family_media_id").on(
      table.familyId,
      table.mediaId,
      table.id,
    ),
    index("idx_background_jobs_claim").on(
      table.state,
      table.availableAt,
      table.id,
    ),
    index("idx_background_jobs_lease").on(
      table.state,
      table.lockedUntil,
      table.id,
    ),
    foreignKey({
      name: "fk_background_jobs_media",
      columns: [table.familyId, table.mediaId],
      foreignColumns: [mediaItems.familyId, mediaItems.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("chk_background_jobs_generation", sql`${table.generation} >= 1`),
    check("chk_background_jobs_recipe", sql`${table.recipeId} >= 1`),
    check(
      "chk_background_jobs_attempts",
      sql`${table.attempts} <= ${table.maxAttempts} AND ${table.maxAttempts} BETWEEN 1 AND 3`,
    ),
    check(
      "chk_background_jobs_lease",
      sql`(${table.state} = 'RUNNING' AND ${table.lockedAt} IS NOT NULL AND ${table.heartbeatAt} IS NOT NULL AND ${table.lockedUntil} IS NOT NULL AND ${table.workerId} IS NOT NULL AND ${table.leaseEpoch} > 0 AND ${table.lockedAt} <= ${table.heartbeatAt} AND ${table.heartbeatAt} < ${table.lockedUntil}) OR (${table.state} <> 'RUNNING' AND ${table.lockedAt} IS NULL AND ${table.heartbeatAt} IS NULL AND ${table.lockedUntil} IS NULL AND ${table.workerId} IS NULL)`,
    ),
    check(
      "chk_background_jobs_terminal",
      sql`(${table.state} IN ('SUCCEEDED','FAILED','CANCELLED') AND ${table.finishedAt} IS NOT NULL AND ${table.finishedAt} >= ${table.createdAt}) OR (${table.state} NOT IN ('SUCCEEDED','FAILED','CANCELLED') AND ${table.finishedAt} IS NULL)`,
    ),
    check(
      "chk_background_jobs_failure",
      sql`(${table.state} IN ('FAILED','RETRY_WAIT') AND ${table.lastFailureCode} IS NOT NULL) OR (${table.state} IN ('QUEUED','SUCCEEDED','CANCELLED') AND ${table.lastFailureCode} IS NULL) OR ${table.state} = 'RUNNING'`,
    ),
  ],
);

export const derivedAssets = mysqlTable(
  "derived_assets",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    mediaId: foreignId("media_id").notNull(),
    generation: bigint("generation", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    recipeId: smallint("recipe_id", { unsigned: true }).notNull(),
    kind: mysqlEnum("kind", phase4DerivedKinds).notNull(),
    state: mysqlEnum("state", phase4DerivedStates)
      .notNull()
      .default("RESERVED"),
    reservedBytes: foreignId("reserved_bytes").notNull(),
    byteSize: foreignId("byte_size"),
    sha256: sha256Digest("sha256"),
    width: int("width", { unsigned: true }),
    height: int("height", { unsigned: true }),
    outputMime: varchar("output_mime", { length: 127 }),
    producerJobId: foreignId("producer_job_id").notNull(),
    producerLeaseEpoch: foreignId("producer_lease_epoch"),
    failureCode: mysqlEnum("failure_code", phase4FailureCodes),
    publishedAt: timestamp("published_at"),
    cleanedAt: timestamp("cleaned_at"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_derived_assets_identity").on(
      table.familyId,
      table.mediaId,
      table.generation,
      table.recipeId,
      table.kind,
    ),
    index("idx_derived_assets_state").on(table.state, table.id),
    index("idx_derived_assets_cleanup").on(
      table.familyId,
      table.cleanedAt,
      table.state,
      table.id,
    ),
    foreignKey({
      name: "fk_derived_assets_media",
      columns: [table.familyId, table.mediaId],
      foreignColumns: [mediaItems.familyId, mediaItems.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "fk_derived_assets_producer_job",
      columns: [table.familyId, table.mediaId, table.producerJobId],
      foreignColumns: [
        backgroundJobs.familyId,
        backgroundJobs.mediaId,
        backgroundJobs.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("chk_derived_assets_generation", sql`${table.generation} >= 1`),
    check("chk_derived_assets_recipe", sql`${table.recipeId} >= 1`),
    check(
      "chk_derived_assets_reservation",
      sql`(${table.kind} = 'THUMBNAIL' AND ${table.reservedBytes} BETWEEN 1 AND 524288) OR (${table.kind} = 'PREVIEW' AND ${table.reservedBytes} BETWEEN 1 AND 4194304) OR (${table.kind} = 'VIDEO_POSTER' AND ${table.reservedBytes} BETWEEN 1 AND 1048576)`,
    ),
    check(
      "chk_derived_assets_bytes_digest",
      sql`(${table.byteSize} IS NULL AND ${table.sha256} IS NULL) OR (${table.byteSize} IS NOT NULL AND ${table.sha256} IS NOT NULL AND ${table.byteSize} > 0 AND ${table.byteSize} <= ${table.reservedBytes})`,
    ),
    check(
      "chk_derived_assets_dimensions",
      sql`(${table.width} IS NULL AND ${table.height} IS NULL) OR (${table.width} IS NOT NULL AND ${table.height} IS NOT NULL AND ${table.width} > 0 AND ${table.height} > 0)`,
    ),
    check(
      "chk_derived_assets_published_payload",
      sql`${table.state} NOT IN ('PUBLISHING','READY') OR (${table.byteSize} IS NOT NULL AND ${table.sha256} IS NOT NULL AND ${table.width} IS NOT NULL AND ${table.height} IS NOT NULL AND ${table.outputMime} = 'image/webp' AND ${table.producerLeaseEpoch} IS NOT NULL AND ${table.producerLeaseEpoch} > 0)`,
    ),
    check(
      "chk_derived_assets_ready",
      sql`${table.state} <> 'READY' OR (${table.publishedAt} IS NOT NULL AND ${table.cleanedAt} IS NULL AND ${table.publishedAt} >= ${table.createdAt})`,
    ),
    check(
      "chk_derived_assets_failure",
      sql`(${table.state} IN ('MISSING','FAILED') AND ${table.failureCode} IS NOT NULL) OR (${table.state} NOT IN ('MISSING','FAILED') AND ${table.failureCode} IS NULL)`,
    ),
    check(
      "chk_derived_assets_times",
      sql`(${table.publishedAt} IS NULL OR ${table.publishedAt} >= ${table.createdAt}) AND (${table.cleanedAt} IS NULL OR ${table.cleanedAt} >= ${table.createdAt})`,
    ),
  ],
);

const locationAscii = (length: number) =>
  customType<{ data: string; driverData: string }>({
    dataType: () => `varchar(${length}) CHARACTER SET ascii COLLATE ascii_bin`,
  });
export const mediaLocationProjections = mysqlTable(
  "media_location_projections",
  {
    id: id(),
    familyId: foreignId("family_id").notNull(),
    mediaId: foreignId("media_id").notNull(),
    generation: foreignId("generation").notNull(),
    policyVersion: int("policy_version", { unsigned: true }).notNull(),
    datasetVersion: locationAscii(64)("dataset_version").notNull(),
    h3Cell: locationAscii(15)("h3_cell").notNull(),
    countryCode: locationAscii(2)("country_code"),
    cityGeonameId: foreignId("city_geoname_id"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("uq_location_media_version").on(
      t.familyId,
      t.mediaId,
      t.policyVersion,
      t.datasetVersion,
    ),
    index("idx_location_cell").on(
      t.familyId,
      t.policyVersion,
      t.datasetVersion,
      t.h3Cell,
      t.mediaId,
    ),
    foreignKey({
      name: "fk_location_media",
      columns: [t.familyId, t.mediaId],
      foreignColumns: [mediaItems.familyId, mediaItems.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("chk_location_generation", sql`${t.generation} >= 1`),
    check("chk_location_policy", sql`${t.policyVersion} >= 1`),
    check(
      "chk_location_dataset",
      sql`${t.datasetVersion} REGEXP '^[0-9a-f]{64}$'`,
    ),
    check("chk_location_cell", sql`${t.h3Cell} REGEXP '^[0-9a-f]{15}$'`),
    check(
      "chk_location_country",
      sql`${t.countryCode} IS NULL OR ${t.countryCode} REGEXP '^[A-Z]{2}$'`,
    ),
    check(
      "chk_location_city",
      sql`${t.cityGeonameId} IS NULL OR (${t.countryCode} IS NOT NULL AND ${t.cityGeonameId} > 0)`,
    ),
  ],
);
