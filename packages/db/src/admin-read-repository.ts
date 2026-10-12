import type { Pool, RowDataPacket } from "mysql2/promise";
import {
  adminPageQuerySchema,
  adminAuditResponseSchema,
  familyAdminOverviewSchema,
  systemAdminStatusSchema,
  type AdminStorageObservation,
} from "@family-album/contracts";
import type { Phase1CActor } from "./phase1c-repository.js";
import { buildFamilySearchQuery } from "./album-repository.js";
import { SystemControlError } from "./system-control-repository.js";
import { withAdminSnapshot, authorizeAdminRead } from "./admin-read-auth.js";
import { readUploadCapacityInventory } from "./capacity-inventory.js";
import { readServerTime } from "./connection.js";
import type { RuntimeRole } from "./system-control-repository.js";

/** Reuse the unfiltered gallery/search FROM/WHERE before distinct/aggregation. */
export function buildAdminVisibleSet(familyId: string, memberId: string) {
  const gallery = buildFamilySearchQuery(familyId, memberId, 1, undefined, {});
  const from = gallery.sql.slice(
    gallery.sql.indexOf("FROM media_items"),
    gallery.sql.indexOf("GROUP BY m.id"),
  );
  return {
    sql: `SELECT DISTINCT m.id,m.family_id,m.storage_object_id,m.source_upload_id,m.media_type,m.generation,m.recipe_id
    ${from} AND m.processing_state='READY' AND m.recipe_id=1
    AND EXISTS (SELECT 1 FROM storage_objects s WHERE s.family_id=m.family_id AND s.id=m.storage_object_id AND s.state='AVAILABLE')
    AND (m.media_type='VIDEO' OR (m.media_type='IMAGE' AND
      (SELECT COUNT(DISTINCT d.kind) FROM derived_assets d WHERE d.family_id=m.family_id AND d.media_id=m.id
        AND d.generation=m.generation AND d.recipe_id=m.recipe_id AND d.kind IN ('THUMBNAIL','PREVIEW')
        AND d.state='READY' AND d.cleaned_at IS NULL AND d.published_at IS NOT NULL)=2))`,
    values: gallery.values.slice(0, -1),
  };
}
const trashVisibility = `EXISTS (SELECT 1 FROM album_media p JOIN albums a ON a.family_id=p.family_id AND a.id=p.album_id
  LEFT JOIN album_members g ON g.family_id=a.family_id AND g.album_id=a.id AND g.member_id=?
  WHERE p.family_id=m.family_id AND p.media_id=m.id AND a.deleted_at IS NULL
    AND (a.owner_member_id=? OR a.visibility='FAMILY' OR g.can_view=1))`;
const noEngine = (source: "BACKUP_PROVIDER" | "INTEGRITY_PROVIDER") => ({
  state: "NOT_CONFIGURED" as const,
  observedAt: null,
  staleAfter: null,
  source,
  reasonCode: "NOT_CONFIGURED" as const,
});
export class MySqlAdminReadRepository {
  constructor(readonly pool: Pool) {}
  systemStatus(
    actor: Phase1CActor & { familyId: string },
    configuredRoles: readonly RuntimeRole[],
    storage: (observedAt: Date) => Promise<AdminStorageObservation>,
  ) {
    return withAdminSnapshot(this.pool, async (c) => {
      await authorizeAdminRead(c, actor, actor.familyId, true);
      const [controls] = await c.query<
        RowDataPacket[]
      >(`SELECT requested_mode requestedMode,enforced_mode enforcedMode,
        transition_state transitionState,CAST(revision AS CHAR) revision,CAST(health_generation AS CHAR) healthGeneration,
        fault_latched faultLatched,reason_code reasonCode,active_operation_id activeOperationId FROM system_control WHERE id=1`);
      if (!controls[0]) throw new SystemControlError("CONTROL_UNAVAILABLE");
      const uploads = await readUploadCapacityInventory(c);
      const [charges] = await c.query<RowDataPacket[]>(`SELECT
        CAST(COALESCE(SUM(CASE WHEN cleaned_at IS NOT NULL THEN 0 WHEN state='READY' THEN byte_size ELSE reserved_bytes END),0) +
          (SELECT COALESCE(SUM(GREATEST(derived_bytes-LEAST(released_bytes,derived_bytes),0)),0) FROM purge_intents WHERE progress IN ('DETACHED','FILES_REMOVED')) AS CHAR) derivedBytes,
        CAST(COALESCE(SUM(CASE WHEN cleaned_at IS NOT NULL OR state='READY' THEN 0 ELSE reserved_bytes END),0) +
          (SELECT COALESCE(SUM(GREATEST(derived_bytes-LEAST(released_bytes,derived_bytes),0)),0) FROM purge_intents WHERE progress IN ('DETACHED','FILES_REMOVED')) AS CHAR) unsettledBytes
        FROM derived_assets`);
      const [runtimes] = await c.query<
        RowDataPacket[]
      >(`SELECT role,boot_id bootId,state,reason_code reasonCode,received_at receivedAt,
        CAST(completed_units AS CHAR) completedUnits,last_successful_at lastSuccessfulAt FROM admin_runtime_observations WHERE exited_at IS NULL ORDER BY role`);
      const now = await readServerTime(c);
      const roles: RuntimeRole[] = ["API", "DERIVATIVE", "METADATA", "PURGE"];
      const workers = roles.map((role) => {
        const matches = runtimes.filter((r) => r.role === role),
          r = matches.length === 1 ? matches[0] : undefined;
        const configured = configuredRoles.includes(role) || matches.length > 0;
        const fresh =
          r?.receivedAt instanceof Date &&
          r.receivedAt.getTime() > now.getTime() - 15000;
        return {
          role,
          state: fresh ? r!.state : configured ? "UNKNOWN" : "NOT_CONFIGURED",
          bootId: r?.bootId ?? null,
          completedUnits: r ? String(r.completedUnits) : null,
          lastSuccessfulAt:
            r?.lastSuccessfulAt instanceof Date
              ? r.lastSuccessfulAt.toISOString()
              : null,
          observation: {
            state: fresh
              ? ["STARTING", "RECOVERY_REQUIRED"].includes(r!.state)
                ? "DEGRADED"
                : "HEALTHY"
              : configured
                ? "UNKNOWN"
                : "NOT_CONFIGURED",
            observedAt:
              r?.receivedAt instanceof Date ? r.receivedAt.toISOString() : null,
            staleAfter:
              r?.receivedAt instanceof Date
                ? new Date(r.receivedAt.getTime() + 15000).toISOString()
                : null,
            source: "RUNTIME_HEARTBEAT",
            reasonCode: fresh
              ? r!.reasonCode
              : configured
                ? "STALE"
                : "NOT_CONFIGURED",
          },
        };
      });
      return systemAdminStatusSchema.parse({
        ...controls[0],
        faultLatched: Boolean(controls[0].faultLatched),
        localDeny: false,
        observedAt: now.toISOString(),
        observations: {
          observedAt: now.toISOString(),
          database: {
            state: "HEALTHY",
            observedAt: now.toISOString(),
            staleAfter: new Date(now.getTime() + 5000).toISOString(),
            source: "CHECKED_DATABASE",
            reasonCode: "NONE",
          },
          storage: await storage(now),
          accounting: {
            storedOriginalBytes: uploads.stored.toString(),
            reservedFutureBytes: uploads.reservedFutureBytes.toString(),
            retainedStagingBytes: uploads.retainedStagingBytes.toString(),
            derivedBytes: String(charges[0]!.derivedBytes),
            unsettledDerivedBytes: String(charges[0]!.unsettledBytes),
          },
          workers,
          backups: noEngine("BACKUP_PROVIDER"),
          integrity: noEngine("INTEGRITY_PROVIDER"),
          lastBackupSuccessAt: null,
          lastIntegritySuccessAt: null,
        },
      });
    });
  }
  overview(actor: Phase1CActor, familyId: string) {
    return withAdminSnapshot(this.pool, async (c) => {
      const who = await authorizeAdminRead(c, actor, familyId),
        visible = buildAdminVisibleSet(familyId, who.memberId);
      const [totals] = await c.query<RowDataPacket[]>(
        {
          sql: `WITH visible AS (${visible.sql})
        SELECT CAST(COALESCE(SUM(v.media_type='IMAGE'),0) AS CHAR) photos,
          CAST(COALESCE(SUM(v.media_type='VIDEO'),0) AS CHAR) videos,
          CAST(COALESCE(SUM(s.byte_size),0) AS CHAR) visibleLogicalBytes,
          CAST(COALESCE((SELECT SUM(o.byte_size) FROM storage_objects o JOIN
            (SELECT DISTINCT storage_object_id FROM visible) referenced ON referenced.storage_object_id=o.id WHERE o.family_id=?),0) AS CHAR) visibleReferencedStorageBytes,
          CAST(COALESCE((SELECT SUM(d.byte_size) FROM derived_assets d JOIN visible dv ON dv.id=d.media_id AND dv.family_id=d.family_id
            WHERE d.generation=dv.generation AND d.recipe_id=dv.recipe_id AND d.state='READY' AND d.cleaned_at IS NULL AND d.published_at IS NOT NULL),0) AS CHAR) visibleDerivedBytes
        FROM visible v JOIN storage_objects s ON s.family_id=v.family_id AND s.id=v.storage_object_id`,
          timeout: 2000,
        },
        [...visible.values, familyId],
      );
      const [trash] = await c.query<RowDataPacket[]>(
        {
          sql: `SELECT CAST(COUNT(*) AS CHAR) count FROM media_items m
        WHERE m.family_id=? AND m.trashed_at IS NOT NULL AND m.purge_intent_id IS NULL AND ${trashVisibility}`,
          timeout: 2000,
        },
        [familyId, who.memberId, who.memberId],
      );
      const [uploaders] = await c.query<RowDataPacket[]>(
        {
          sql: `WITH visible AS (${visible.sql})
        SELECT CAST(source.created_by_member_id AS CHAR) memberId,CAST(COUNT(*) AS CHAR) mediaCount,
          CAST(SUM(s.byte_size) AS CHAR) logicalBytes FROM visible v
        JOIN upload_sessions source ON source.family_id=v.family_id AND source.id=v.source_upload_id
        JOIN storage_objects s ON s.family_id=v.family_id AND s.id=v.storage_object_id
        GROUP BY source.created_by_member_id ORDER BY source.created_by_member_id`,
          timeout: 2000,
        },
        visible.values,
      );
      const [control] = await c.query<RowDataPacket[]>({
        sql: `SELECT requested_mode,enforced_mode,transition_state,fault_latched FROM system_control WHERE id=1`,
        timeout: 2000,
      });
      const row = control[0],
        mediaControl = !row
          ? "UNAVAILABLE"
          : row.requested_mode === "NORMAL" &&
              row.enforced_mode === "NORMAL" &&
              row.transition_state === "STABLE" &&
              !row.fault_latched
            ? "WRITABLE"
            : "PAUSED";
      return familyAdminOverviewSchema.parse({
        familyId,
        actorMemberId: who.memberId,
        observedAt: who.now.toISOString(),
        scope: "CURRENT_VISIBLE_MEDIA",
        ...totals[0],
        trash: String(trash[0]?.count),
        uploaders: uploaders.map((r) => ({
          memberId: String(r.memberId),
          mediaCount: String(r.mediaCount),
          logicalBytes: String(r.logicalBytes),
        })),
        mediaControl,
        backups: noEngine("BACKUP_PROVIDER"),
        integrity: noEngine("INTEGRITY_PROVIDER"),
        lastBackupSuccessAt: null,
        lastIntegritySuccessAt: null,
      });
    });
  }
  audit(actor: Phase1CActor, familyId: string, raw: unknown, system = false) {
    const query = adminPageQuerySchema.parse(raw);
    if (system && query.source === "media")
      throw new SystemControlError("CONFLICT");
    const source = system ? "management" : (query.source ?? "management");
    return withAdminSnapshot(this.pool, async (c) => {
      const who = await authorizeAdminRead(c, actor, familyId, system);
      const scope = {
        user: actor.userId,
        member: who.memberId,
        family: familyId,
        system,
        source,
        days: query.days,
      };
      let beforeId = "18446744073709551615",
        beforeTime = who.now.toISOString(),
        anchor = beforeTime;
      if (query.cursor) {
        let cursor: unknown;
        try {
          cursor = JSON.parse(
            Buffer.from(query.cursor, "base64url").toString("utf8"),
          );
        } catch {
          throw new SystemControlError("CONFLICT");
        }
        if (!cursor || typeof cursor !== "object")
          throw new SystemControlError("CONFLICT");
        const r = cursor as Record<string, unknown>;
        if (
          JSON.stringify(r.scope) !== JSON.stringify(scope) ||
          typeof r.id !== "string" ||
          !/^[1-9]\d{0,19}$/u.test(r.id) ||
          BigInt(r.id) > 18446744073709551615n ||
          typeof r.time !== "string" ||
          typeof r.anchor !== "string" ||
          !Number.isFinite(Date.parse(r.time)) ||
          !Number.isFinite(Date.parse(r.anchor)) ||
          Date.parse(r.anchor) > who.now.getTime()
        )
          throw new SystemControlError("CONFLICT");
        beforeId = r.id;
        beforeTime = r.time;
        anchor = r.anchor;
      }
      const after = new Date(Date.parse(anchor) - query.days * 86400000),
        until = new Date(anchor);
      const base =
        source === "management"
          ? `SELECT CAST(e.id AS CHAR) id,e.created_at createdAt,e.actor_kind actorKind,CAST(e.actor_member_id AS CHAR) actorMemberId,
        e.action,e.target_type targetType,e.target_id targetId,e.result_category resultCategory FROM admin_audit_events e
        WHERE e.scope=? AND ${system ? "e.family_id IS NULL" : "e.family_id=?"}`
          : `SELECT CAST(e.id AS CHAR) id,e.created_at createdAt,e.actor_kind actorKind,CAST(e.actor_member_id AS CHAR) actorMemberId,
         e.action,'MEDIA' targetType,CAST(e.media_id AS CHAR) targetId,e.result_category resultCategory FROM audit_logs e
         JOIN media_items m ON m.family_id=e.family_id AND m.id=e.media_id
         WHERE e.family_id=? AND m.purge_intent_id IS NULL AND ${trashVisibility}`;
      const values =
        source === "management"
          ? system
            ? ["SYSTEM"]
            : ["FAMILY", familyId]
          : [familyId, who.memberId, who.memberId];
      const [rows] = await c.query<RowDataPacket[]>(
        {
          sql: `${base} AND e.created_at>=? AND e.created_at<=?
        AND (e.created_at<? OR (e.created_at=? AND e.id<?)) ORDER BY e.created_at DESC,e.id DESC LIMIT ?`,
          timeout: 2000,
        },
        [
          ...values,
          after,
          until,
          new Date(beforeTime),
          new Date(beforeTime),
          beforeId,
          query.limit + 1,
        ],
      );
      const page = rows.slice(0, query.limit),
        last = page.at(-1);
      return adminAuditResponseSchema.parse({
        source,
        observedAt: who.now.toISOString(),
        events: page.map((r) => ({
          id: String(r.id),
          createdAt: (r.createdAt as Date).toISOString(),
          actorKind: r.actorKind,
          actorMemberId:
            r.actorMemberId === null ? null : String(r.actorMemberId),
          action: r.action,
          targetType: r.targetType,
          targetId: String(r.targetId),
          resultCategory: r.resultCategory,
        })),
        nextCursor:
          rows.length > query.limit && last
            ? Buffer.from(
                JSON.stringify({
                  scope,
                  anchor,
                  id: String(last.id),
                  time: (last.createdAt as Date).toISOString(),
                }),
              ).toString("base64url")
            : null,
      });
    });
  }
}
