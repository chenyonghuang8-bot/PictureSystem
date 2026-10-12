import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { readServerTime } from "./connection.js";
import { boundedCheckedRead } from "./bounded-read.js";
import type { Phase1CActor } from "./phase1c-repository.js";
import { SystemControlError } from "./system-control-repository.js";

export async function withAdminSnapshot<T>(
  pool: Pool,
  operation: (c: PoolConnection) => Promise<T>,
): Promise<T> {
  return boundedCheckedRead(pool, async (c, discard) => {
    let begun = false;
    try {
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await c.query("START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT");
      begun = true;
      const result = await operation(c);
      await c.commit();
      begun = false;
      return result;
    } catch (error) {
      if (begun) {
        try {
          await c.rollback();
        } catch {
          discard();
        }
      }
      throw error;
    }
  });
}
export async function authorizeAdminRead(
  c: PoolConnection,
  actor: Phase1CActor,
  familyId: string,
  system = false,
) {
  const now = await readServerTime(c);
  const [rows] = await c.query<RowDataPacket[]>(
    {
      sql: `SELECT CAST(fm.id AS CHAR) memberId,fm.role FROM family_members fm
    JOIN users u ON u.id=fm.user_id JOIN sessions s ON s.user_id=u.id JOIN families f ON f.id=fm.family_id
    WHERE fm.family_id=? AND fm.user_id=? AND fm.disabled_at IS NULL AND fm.left_at IS NULL
    AND u.disabled_at IS NULL AND s.id=? AND s.token_hash=? AND s.client_type=? AND s.revoked_at IS NULL
    AND s.expires_at>? AND s.last_seen_at>DATE_SUB(?,INTERVAL 7 DAY)
    AND fm.role IN ('ADMIN','SUPER_ADMIN')`,
      timeout: 2000,
    },
    [
      familyId,
      actor.userId,
      actor.sessionId,
      actor.tokenHash,
      actor.expectedClientType ?? "WEB",
      now,
      now,
    ],
  );
  const who = rows[0];
  if (!who) throw new SystemControlError("FORBIDDEN");
  if (system) {
    const [grants] = await c.query<RowDataPacket[]>(
      {
        sql: `SELECT id FROM system_admin_grants
      WHERE family_id=? AND member_id=? AND user_id=? AND enabled=1`,
        timeout: 2000,
      },
      [familyId, who.memberId, actor.userId],
    );
    if (who.role !== "SUPER_ADMIN" || !grants[0])
      throw new SystemControlError("FORBIDDEN");
  }
  return { memberId: String(who.memberId), now };
}
