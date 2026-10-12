import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import type { FamilyRole } from "@family-album/permissions";
export type FamilyAdminAudit = {
  familyId: string;
  userId: string;
  memberId: string;
  role: FamilyRole;
  action:
    | "MEMBER_DISABLED"
    | "MEMBER_RESTORED"
    | "MEMBER_ROLE_CHANGED"
    | "INVITATION_CREATED"
    | "INVITATION_REVOKED"
    | "INVITATION_CONSUMED";
  targetType: "MEMBER" | "INVITATION";
  targetId: string;
  operationId: string;
};
/** The caller's checked business transaction owns this INSERT. Never best-effort. */
export async function insertFamilyAdminAudit(
  connection: PoolConnection,
  event: FamilyAdminAudit,
) {
  await connection.execute(
    `INSERT INTO admin_audit_events
    (scope,family_id,actor_kind,actor_user_id,actor_member_id,actor_role,action,target_type,target_id,operation_id,transition_token,result_category)
    VALUES ('FAMILY',?,'MEMBER',?,?,?,?,?,?,?,?, 'SUCCESS')`,
    [
      event.familyId,
      event.userId,
      event.memberId,
      event.role,
      event.action,
      event.targetType,
      event.targetId,
      event.operationId,
      `${event.targetType === "MEMBER" ? "M" : "I"}:${event.targetId}`,
    ],
  );
}
export function managementOperationId() {
  return randomUUID();
}
