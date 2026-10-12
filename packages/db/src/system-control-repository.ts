import {
  type RunLease,
  activateRecoveredRun,
} from "./system-run-repository.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  Pool,
  PoolConnection,
  RowDataPacket,
  ResultSetHeader,
} from "mysql2/promise";
import {
  adminModeRequestSchema,
  adminRecheckRequestSchema,
  adminReasonSchema,
  adminControlStatusSchema,
  adminOperationResponseSchema,
  type AdminModeRequest,
} from "@family-album/contracts";
import {
  acquireCheckedConnection,
  readServerTime,
  runCheckedTransaction,
} from "./connection.js";
import {
  lockFamilyState,
  assertFamilyManagementActor as assertActor,
  type Phase1CActor,
} from "./phase1c-repository.js";
import { CommitOutcomeUnknownError } from "./transaction.js";
import { boundedCheckedRead } from "./bounded-read.js";
import { withAdminSnapshot, authorizeAdminRead } from "./admin-read-auth.js";
import type {
  DerivedRecoveryFinalFact,
  DerivedRecoveryTempFact,
} from "./derived-recovery.js";

export class SystemControlError extends Error {
  constructor(
    readonly reason:
      | "FORBIDDEN"
      | "CONFLICT"
      | "NOT_FOUND"
      | "CONTROL_UNAVAILABLE"
      | "COMMIT_UNKNOWN"
      | "WRITER_NOT_READY",
  ) {
    super(reason);
    this.name = "SystemControlError";
  }
}
export type SystemRequestActor = Phase1CActor & { familyId: string };
const CONTROL_SELECT = `SELECT deployment_id deploymentId,HEX(namespace_identity) namespaceIdentity,
 requested_mode requestedMode,enforced_mode enforcedMode,transition_state transitionState,
 CAST(revision AS CHAR) revision,CAST(health_generation AS CHAR) healthGeneration,
 current_run_id currentRunId,CAST(run_epoch AS CHAR) runEpoch,
 fault_latched faultLatched,reason_code reasonCode,active_operation_id activeOperationId,updated_at updatedAt
 FROM system_control WHERE id=1`;
const OPERATION_SELECT = `SELECT id operationId,kind,status,requested_mode targetMode,
 CAST(result_revision AS CHAR) resultRevision,reason_code reasonCode,created_at createdAt,finished_at finishedAt,
 fingerprint,CAST(actor_user_id AS CHAR) actorUserId,CAST(actor_member_id AS CHAR) actorMemberId,
 CAST(actor_family_id AS CHAR) actorFamilyId,CAST(session_id AS CHAR) sessionId,client_type clientType,
 CAST(grant_id AS CHAR) grantId,CAST(expected_revision AS CHAR) expectedRevision FROM system_control_operations`;
export async function lockSystemActor(
  c: PoolConnection,
  actor: SystemRequestActor,
  recent: boolean,
) {
  const state = await lockFamilyState(c, actor.familyId, actor);
  const now = await readServerTime(c);
  const member = assertActor(state, actor, now, recent);
  if (member.role !== "SUPER_ADMIN") throw new SystemControlError("FORBIDDEN");
  const [grants] = await c.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) id,CAST(revision AS CHAR) revision FROM system_admin_grants
    WHERE user_id=? AND member_id=? AND family_id=? AND enabled=1 FOR UPDATE`,
    [actor.userId, member.id, actor.familyId],
  );
  if (!grants[0]) throw new SystemControlError("FORBIDDEN");
  const afterGrant = await readServerTime(c);
  assertActor(state, actor, afterGrant, recent);
  return {
    revalidate: async () => {
      const now = await readServerTime(c);
      assertActor(state, actor, now, recent);
      return now;
    },
    member,
    grantId: String(grants[0].id),
    grantRevision: String(grants[0].revision),
    now,
  };
}
export async function insertSystemControlAudit(
  c: PoolConnection,
  input: {
    operationId: string;
    transition: string;
    action:
      | "RUN_STARTED"
      | "RUN_STOPPING"
      | "RUN_CLEAN_CLOSED"
      | "STARTUP_AUTO_CONFIRMED"
      | "STARTUP_RECHECK_REQUIRED"
      | "CONTROL_REQUESTED"
      | "CONTROL_APPLIED"
      | "RECOVERY_REJECTED"
      | "HEALTH_LATCHED"
      | "OUTCOME_OBSERVED"
      | "BOOTSTRAP_APPLIED"
      | "GRANT_PROVISIONED"
      | "GRANT_REVOKED";
    result:
      | "SUCCESS"
      | "REJECTED"
      | "RECOVERY_REQUIRED"
      | "COMMIT_UNKNOWN"
      | "UNAVAILABLE";
    revision: string;
    actor?: { userId: string; memberId: string };
    targetType?: "CONTROL" | "GRANT";
    targetId?: string;
  },
) {
  await c.execute(
    `INSERT INTO admin_audit_events
    (scope,family_id,actor_kind,actor_user_id,actor_member_id,actor_role,action,target_type,target_id,operation_id,transition_token,result_category,revision)
    VALUES ('SYSTEM',NULL,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.actor ? "MEMBER" : "SYSTEM",
      input.actor?.userId ?? null,
      input.actor?.memberId ?? null,
      input.actor ? "SUPER_ADMIN" : null,
      input.action,
      input.targetType ?? "CONTROL",
      input.targetId ?? "1",
      input.operationId,
      input.transition,
      input.result,
      input.revision,
    ],
  );
}
export class MySqlSystemControlRepository {
  constructor(readonly pool: Pool) {}
  async resolveActor(actor: Phase1CActor): Promise<SystemRequestActor> {
    return boundedCheckedRead(this.pool, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        {
          sql: `SELECT CAST(g.family_id AS CHAR) familyId FROM system_admin_grants g
        JOIN family_members fm ON fm.family_id=g.family_id AND fm.id=g.member_id AND fm.user_id=g.user_id
        JOIN users u ON u.id=g.user_id WHERE g.user_id=? AND g.enabled=1 AND u.disabled_at IS NULL
        AND fm.role='SUPER_ADMIN' AND fm.disabled_at IS NULL AND fm.left_at IS NULL ORDER BY g.id LIMIT 1`,
          timeout: 2000,
        },
        [actor.userId],
      );
      if (!rows[0]) throw new SystemControlError("FORBIDDEN");
      return { ...actor, familyId: String(rows[0].familyId) };
    });
  }
  async readCurrent() {
    return boundedCheckedRead(this.pool, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>({
        sql: CONTROL_SELECT,
        timeout: 2000,
      });
      const row = rows[0];
      if (!row) throw new SystemControlError("CONTROL_UNAVAILABLE");
      const now = await readServerTime(c);
      const status = adminControlStatusSchema.parse({
        requestedMode: row.requestedMode,
        enforcedMode: row.enforcedMode,
        transitionState: row.transitionState,
        revision: String(row.revision),
        healthGeneration: String(row.healthGeneration),
        faultLatched: Boolean(row.faultLatched),
        reasonCode: row.reasonCode,
        activeOperationId: row.activeOperationId ?? null,
        observedAt: now.toISOString(),
        localDeny: false,
      });
      return {
        ...status,
        deploymentId: String(row.deploymentId),
        namespaceIdentity: row.namespaceIdentity
          ? String(row.namespaceIdentity).toLowerCase()
          : null,
      };
    });
  }
  async status(actor: SystemRequestActor) {
    return withAdminSnapshot(this.pool, async (c) => {
      await authorizeAdminRead(c, actor, actor.familyId, true);
      const [rows] = await c.query<RowDataPacket[]>(CONTROL_SELECT);
      if (!rows[0]) throw new SystemControlError("CONTROL_UNAVAILABLE");
      const r = rows[0];
      return adminControlStatusSchema.parse({
        requestedMode: r.requestedMode,
        enforcedMode: r.enforcedMode,
        transitionState: r.transitionState,
        revision: String(r.revision),
        healthGeneration: String(r.healthGeneration),
        faultLatched: Boolean(r.faultLatched),
        reasonCode: r.reasonCode,
        activeOperationId: r.activeOperationId ?? null,
        observedAt: (await readServerTime(c)).toISOString(),
        localDeny: false,
      });
    });
  }
  async operation(actor: SystemRequestActor, id: string) {
    return withAdminSnapshot(this.pool, async (c) => {
      await authorizeAdminRead(c, actor, actor.familyId, true);
      const [rows] = await c.query<RowDataPacket[]>(
        `${OPERATION_SELECT} WHERE id=?`,
        [id],
      );
      const r = rows[0];
      if (!r || String(r.actorUserId) !== actor.userId)
        throw new SystemControlError("NOT_FOUND");
      return publicOperation(r);
    });
  }
  async requestMode(actor: SystemRequestActor, raw: AdminModeRequest) {
    return this.request(actor, adminModeRequestSchema.parse(raw), "MODE");
  }
  requestRecheck(actor: SystemRequestActor, raw: unknown) {
    const body = adminRecheckRequestSchema.parse(raw);
    return this.request(
      actor,
      { ...body, targetMode: "READ_ONLY", reasonCode: "MANUAL_READ_ONLY" },
      "RECHECK",
    );
  }
  private async request(
    actor: SystemRequestActor,
    request: AdminModeRequest,
    kind: "MODE" | "RECHECK",
  ) {
    try {
      return await runCheckedTransaction(this.pool, async (c) => {
        const who = await lockSystemActor(c, actor, true);
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              version: 1,
              kind,
              user: actor.userId,
              member: who.member.id,
              family: actor.familyId,
              session: actor.sessionId,
              client: actor.expectedClientType ?? "WEB",
              grant: who.grantId,
              request,
            }),
          )
          .digest();
        const [control] = await c.query<RowDataPacket[]>(
          `${CONTROL_SELECT} FOR UPDATE`,
        );
        const now = await who.revalidate();
        const row = control[0];
        if (!row) throw new SystemControlError("CONTROL_UNAVAILABLE");
        const [previous] = await c.query<RowDataPacket[]>(
          `${OPERATION_SELECT} WHERE id=?`,
          [request.operationId],
        );
        if (previous[0]) {
          if (
            !Buffer.isBuffer(previous[0].fingerprint) ||
            !previous[0].fingerprint.equals(fingerprint)
          )
            throw new SystemControlError("CONFLICT");
          return publicOperation(previous[0]);
        }
        const revision = BigInt(String(row.revision));
        if (
          String(row.revision) !== request.expectedRevision ||
          revision >= 18446744073709551615n ||
          (kind === "MODE"
            ? row.transitionState !== "STABLE"
            : !["STABLE", "RECOVERY_REQUIRED"].includes(row.transitionState))
        )
          throw new SystemControlError("CONFLICT");
        if (row.faultLatched && request.targetMode === "NORMAL")
          throw new SystemControlError("CONFLICT");
        const rank = { NORMAL: 0, READ_ONLY: 1, MAINTENANCE: 2 };
        const current = row.enforcedMode as keyof typeof rank;
        const target = kind === "RECHECK" ? current : request.targetMode;
        const reducing = kind === "RECHECK" || rank[target] < rank[current];
        const enforced = reducing ? current : target;
        const transition = reducing ? "RESUMING" : "DRAINING";
        await c.execute(
          `INSERT INTO system_control_operations
          (id,kind,fingerprint,actor_user_id,actor_member_id,actor_family_id,session_id,client_type,grant_id,expected_revision,requested_mode,status,reason_code)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'PENDING',?)`,
          [
            request.operationId,
            kind,
            fingerprint,
            actor.userId,
            who.member.id,
            actor.familyId,
            actor.sessionId,
            actor.expectedClientType ?? "WEB",
            who.grantId,
            request.expectedRevision,
            target,
            request.reasonCode,
          ],
        );
        await c.execute(
          `UPDATE system_control SET requested_mode=?,enforced_mode=?,transition_state=?,revision=?,reason_code=?,active_operation_id=?,updated_at=? WHERE id=1 AND revision=?`,
          [
            target,
            enforced,
            transition,
            (revision + 1n).toString(),
            request.reasonCode,
            request.operationId,
            now,
            request.expectedRevision,
          ],
        );
        await insertSystemControlAudit(c, {
          operationId: request.operationId,
          transition: "REQUEST",
          action: "CONTROL_REQUESTED",
          result: "SUCCESS",
          revision: (revision + 1n).toString(),
          actor: { userId: actor.userId, memberId: who.member.id },
        });
        const [created] = await c.query<RowDataPacket[]>(
          `${OPERATION_SELECT} WHERE id=?`,
          [request.operationId],
        );
        return publicOperation(created[0]!);
      });
    } catch (error) {
      if (error instanceof CommitOutcomeUnknownError)
        throw new SystemControlError("COMMIT_UNKNOWN");
      throw error;
    }
  }
  /** Explicit trusted local DEV binding only; never enters NORMAL or grants users. */
  async bootstrap(input: {
    operationId: string;
    deploymentId: string;
    namespaceIdentity: string;
  }) {
    if (!/^[0-9a-f]{64}$/u.test(input.namespaceIdentity))
      throw new SystemControlError("CONFLICT");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ version: 1, kind: "BOOTSTRAP", ...input }))
      .digest();
    return runCheckedTransaction(this.pool, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
          `${CONTROL_SELECT} FOR UPDATE`,
        ),
        row = rows[0];
      if (!row) throw new SystemControlError("CONTROL_UNAVAILABLE");
      const [previous] = await c.query<RowDataPacket[]>(
        `${OPERATION_SELECT} WHERE id=?`,
        [input.operationId],
      );
      if (previous[0]) {
        if (
          previous[0].kind !== "BOOTSTRAP" ||
          !Buffer.isBuffer(previous[0].fingerprint) ||
          !previous[0].fingerprint.equals(fingerprint)
        )
          throw new SystemControlError("CONFLICT");
        return publicOperation(previous[0]);
      }
      if (
        row.namespaceIdentity !== null ||
        row.deploymentId !== "00000000-0000-0000-0000-000000000000" ||
        row.reasonCode !== "NOT_INITIALIZED" ||
        String(row.revision) !== "1" ||
        row.enforcedMode !== "READ_ONLY" ||
        !row.faultLatched
      )
        throw new SystemControlError("CONFLICT");
      await c.execute(
        `INSERT INTO system_control_operations(id,kind,fingerprint,expected_revision,requested_mode,status,result_revision,reason_code,finished_at)
        VALUES (?,'BOOTSTRAP',?,1,'READ_ONLY','PENDING',NULL,'NOT_INITIALIZED',NULL)`,
        [input.operationId, fingerprint],
      );
      await c.execute(
        `UPDATE system_control SET deployment_id=?,namespace_identity=?,revision=2,transition_state='RESUMING',active_operation_id=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=1 AND revision=1`,
        [
          input.deploymentId,
          Buffer.from(input.namespaceIdentity, "hex"),
          input.operationId,
        ],
      );
      await insertSystemControlAudit(c, {
        operationId: input.operationId,
        transition: "REQUEST_BOOTSTRAP",
        action: "CONTROL_REQUESTED",
        result: "SUCCESS",
        revision: "2",
      });
      const [created] = await c.query<RowDataPacket[]>(
        `${OPERATION_SELECT} WHERE id=?`,
        [input.operationId],
      );
      return publicOperation(created[0]!);
    });
  }
  async localGrant(input: {
    familyId: string;
    userId: string;
    enabled: boolean;
    operationId: string;
  }) {
    return runCheckedTransaction(this.pool, async (c) => {
      const [family] = await c.query<RowDataPacket[]>(
        "SELECT id FROM families WHERE id=? FOR UPDATE",
        [input.familyId],
      );
      const [user] = await c.query<RowDataPacket[]>(
        "SELECT id,disabled_at disabledAt FROM users WHERE id=? FOR UPDATE",
        [input.userId],
      );
      const [members] = await c.query<RowDataPacket[]>(
        "SELECT CAST(id AS CHAR) id,role,disabled_at disabledAt,left_at leftAt FROM family_members WHERE family_id=? AND user_id=? FOR UPDATE",
        [input.familyId, input.userId],
      );
      const m = members[0];
      if (
        !family[0] ||
        !user[0] ||
        user[0].disabledAt ||
        !m ||
        m.role !== "SUPER_ADMIN" ||
        m.disabledAt ||
        m.leftAt
      )
        throw new SystemControlError("FORBIDDEN");
      const [previous] = await c.query<RowDataPacket[]>(
        `SELECT target_id targetId,action FROM admin_audit_events WHERE operation_id=? AND transition_token='GRANT'`,
        [input.operationId],
      );
      if (previous[0]) {
        const [owned] = await c.query<RowDataPacket[]>(
          "SELECT CAST(id AS CHAR) id,enabled FROM system_admin_grants WHERE id=? AND family_id=? AND user_id=? AND member_id=?",
          [previous[0].targetId, input.familyId, input.userId, m.id],
        );
        if (
          !owned[0] ||
          previous[0].action !==
            (input.enabled ? "GRANT_PROVISIONED" : "GRANT_REVOKED")
        )
          throw new SystemControlError("CONFLICT");
        return { grantId: String(owned[0].id) };
      }
      const [grants] = await c.query<RowDataPacket[]>(
        "SELECT CAST(id AS CHAR) id,CAST(revision AS CHAR) revision FROM system_admin_grants WHERE family_id=? AND user_id=? AND member_id=? FOR UPDATE",
        [input.familyId, input.userId, m.id],
      );
      let id: string;
      if (grants[0]) {
        if (BigInt(String(grants[0].revision)) >= 18446744073709551615n)
          throw new SystemControlError("CONFLICT");
        id = String(grants[0].id);
        await c.execute(
          "UPDATE system_admin_grants SET enabled=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?",
          [input.enabled, id],
        );
      } else {
        if (!input.enabled) throw new SystemControlError("NOT_FOUND");
        const [inserted] = await c.execute<ResultSetHeader>(
          "INSERT INTO system_admin_grants(user_id,member_id,family_id) VALUES (?,?,?)",
          [input.userId, m.id, input.familyId],
        );
        id = String(inserted.insertId);
      }
      await insertSystemControlAudit(c, {
        operationId: input.operationId,
        transition: "GRANT",
        action: input.enabled ? "GRANT_PROVISIONED" : "GRANT_REVOKED",
        result: "SUCCESS",
        revision: grants[0]
          ? (BigInt(String(grants[0].revision)) + 1n).toString()
          : "1",
        targetType: "GRANT",
        targetId: id,
      });
      return { grantId: id };
    });
  }
  /** Owner-only command observation; no actuator runs inside request transactions. */
  async pending() {
    return boundedCheckedRead(this.pool, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>({
        sql: `${CONTROL_SELECT}`,
        timeout: 2000,
      });
      const control = rows[0];
      if (!control) throw new SystemControlError("CONTROL_UNAVAILABLE");
      if (!control.activeOperationId) return null;
      const [operations] = await c.query<RowDataPacket[]>(
        {
          sql: `${OPERATION_SELECT} WHERE id=? AND status='PENDING'`,
          timeout: 2000,
        },
        [control.activeOperationId],
      );
      return operations[0]
        ? {
            control: Object.assign(control, {
              revision: String(control.revision),
              healthGeneration: String(control.healthGeneration),
              namespaceIdentity: control.namespaceIdentity
                ? String(control.namespaceIdentity).toLowerCase()
                : null,
              transitionState: String(control.transitionState),
              activeOperationId: String(control.activeOperationId),
            }),
            operation: Object.assign(operations[0], {
              operationId: String(operations[0].operationId),
            }),
          }
        : null;
    });
  }
  async complete(
    pending: { control: RowDataPacket; operation: RowDataPacket },
    recovery: {
      namespaceIdentity: string;
      healthGeneration: string;
      runLease?: RunLease;
    } | null,
  ) {
    return runCheckedTransaction(this.pool, async (c) => {
      const op = pending.operation;
      let who: Awaited<ReturnType<typeof lockSystemActor>> | undefined;
      const bootstrap = op.kind === "BOOTSTRAP";
      if (pending.control.transitionState === "RESUMING" && !bootstrap) {
        const [sessions] = await c.query<RowDataPacket[]>(
          "SELECT token_hash tokenHash FROM sessions WHERE id=? AND user_id=?",
          [op.sessionId, op.actorUserId],
        );
        if (!sessions[0] || !Buffer.isBuffer(sessions[0].tokenHash))
          throw new SystemControlError("FORBIDDEN");
        who = await lockSystemActor(
          c,
          {
            familyId: String(op.actorFamilyId),
            userId: String(op.actorUserId),
            sessionId: String(op.sessionId),
            tokenHash: sessions[0].tokenHash,
            expectedClientType: op.clientType,
          },
          true,
        );
        if (
          who.grantId !== String(op.grantId) ||
          who.member.id !== String(op.actorMemberId)
        )
          throw new SystemControlError("FORBIDDEN");
      }
      const [rows] = await c.query<RowDataPacket[]>(
        `${CONTROL_SELECT} FOR UPDATE`,
      );
      const now = who ? await who.revalidate() : await readServerTime(c),
        row = rows[0];
      if (
        !row ||
        row.activeOperationId !== op.operationId ||
        String(row.revision) !== String(pending.control.revision) ||
        String(row.healthGeneration) !==
          String(pending.control.healthGeneration) ||
        row.transitionState !== pending.control.transitionState ||
        row.currentRunId !== pending.control.currentRunId ||
        String(row.runEpoch) !== String(pending.control.runEpoch) ||
        BigInt(String(row.revision)) >= 18446744073709551615n
      )
        throw new SystemControlError("CONFLICT");
      const [operations] = await c.query<RowDataPacket[]>(
        `${OPERATION_SELECT} WHERE id=? FOR UPDATE`,
        [op.operationId],
      );
      if (
        !operations[0] ||
        operations[0].kind !== op.kind ||
        operations[0].status !== "PENDING" ||
        !Buffer.isBuffer(op.fingerprint) ||
        !Buffer.isBuffer(operations[0].fingerprint) ||
        !operations[0].fingerprint.equals(op.fingerprint)
      )
        throw new SystemControlError("CONFLICT");
      const resuming = row.transitionState === "RESUMING";
      if (
        bootstrap &&
        (!resuming ||
          row.reasonCode !== "NOT_INITIALIZED" ||
          row.enforcedMode !== "READ_ONLY" ||
          row.requestedMode !== "READ_ONLY" ||
          [
            "actorUserId",
            "actorMemberId",
            "actorFamilyId",
            "sessionId",
            "clientType",
            "grantId",
          ].some((k) => operations[0]![k] !== null))
      )
        throw new SystemControlError("CONFLICT");
      if (
        resuming &&
        (!recovery ||
          recovery.namespaceIdentity !==
            String(row.namespaceIdentity).toLowerCase() ||
          recovery.healthGeneration !== String(row.healthGeneration))
      )
        throw new SystemControlError("WRITER_NOT_READY");
      if (!resuming && row.transitionState !== "DRAINING")
        throw new SystemControlError("CONFLICT");
      if (resuming)
        await activateRecoveredRun(
          c,
          {
            ...row,
            current_run_id: row.currentRunId,
            run_epoch: row.runEpoch,
            namespace_identity: row.namespaceIdentity
              ? Buffer.from(row.namespaceIdentity, "hex")
              : null,
            deployment_id: row.deploymentId,
          },
          recovery?.runLease,
        );
      const revision = (BigInt(String(row.revision)) + 1n).toString();
      await c.execute(
        `UPDATE system_control SET enforced_mode=requested_mode,transition_state='STABLE',revision=?,fault_latched=?,reason_code=?,updated_at=? WHERE id=1 AND revision=?`,
        [
          revision,
          resuming ? false : Boolean(row.faultLatched),
          resuming ? "NONE" : row.reasonCode,
          now,
          String(row.revision),
        ],
      );
      await c.execute(
        `UPDATE system_control_operations SET status='APPLIED',result_revision=?,reason_code=?,finished_at=? WHERE id=? AND status='PENDING'`,
        [revision, resuming ? "NONE" : row.reasonCode, now, op.operationId],
      );
      await insertSystemControlAudit(c, {
        operationId: op.operationId,
        transition: "APPLY",
        action: bootstrap ? "BOOTSTRAP_APPLIED" : "CONTROL_APPLIED",
        result: "SUCCESS",
        revision,
        ...(who
          ? {
              actor: {
                userId: String(op.actorUserId),
                memberId: who.member.id,
              },
            }
          : {}),
      });
      return { revision, healthGeneration: String(row.healthGeneration) };
    });
  }
  /** Protection is monotone. Called only after the native durable deny exists. */
  async latch(reason: unknown, eventId: string = randomUUID()) {
    const code = adminReasonSchema.parse(reason);
    return runCheckedTransaction(this.pool, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
          `${CONTROL_SELECT} FOR UPDATE`,
        ),
        row = rows[0];
      if (
        !row ||
        BigInt(String(row.revision)) >= 18446744073709551615n ||
        BigInt(String(row.healthGeneration)) >= 18446744073709551615n
      )
        throw new SystemControlError("CONTROL_UNAVAILABLE");
      const [duplicate] = await c.query<RowDataPacket[]>(
        `SELECT id FROM admin_audit_events WHERE operation_id=? AND transition_token='LATCH'`,
        [eventId],
      );
      if (duplicate[0]) return;
      const revision = (BigInt(String(row.revision)) + 1n).toString(),
        generation = (BigInt(String(row.healthGeneration)) + 1n).toString();
      await c.execute(
        `UPDATE system_control SET requested_mode=IF(requested_mode='MAINTENANCE','MAINTENANCE','READ_ONLY'),enforced_mode=IF(enforced_mode='MAINTENANCE','MAINTENANCE','READ_ONLY'),transition_state='RECOVERY_REQUIRED',fault_latched=1,revision=?,health_generation=?,reason_code=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=1`,
        [revision, generation, code],
      );
      if (row.activeOperationId)
        await c.execute(
          `UPDATE system_control_operations SET status='RECOVERY_REQUIRED',reason_code=? WHERE id=? AND status='PENDING'`,
          [code, row.activeOperationId],
        );
      await insertSystemControlAudit(c, {
        operationId: eventId,
        transition: "LATCH",
        action: "HEALTH_LATCHED",
        result: "RECOVERY_REQUIRED",
        revision,
      });
    });
  }
  async runtimeRegister(role: RuntimeRole, bootId: string, revision: string) {
    return runCheckedTransaction(this.pool, async (c) => {
      const [control] = await c.query<RowDataPacket[]>(
        "SELECT id FROM system_control WHERE id=1 FOR UPDATE",
      );
      if (!control[0]) throw new SystemControlError("CONTROL_UNAVAILABLE");
      await c.execute(
        `UPDATE admin_runtime_observations SET state='STOPPED',reason_code='STOPPED',exited_at=CURRENT_TIMESTAMP(3) WHERE role=? AND exited_at IS NULL`,
        [role],
      );
      await c.execute(
        `INSERT INTO admin_runtime_observations(role,boot_id,control_revision,state,reason_code) VALUES (?,?,?,'STARTING','STARTING')`,
        [role, bootId, revision],
      );
    });
  }
  async participantsReady(roles: readonly RuntimeRole[], revision: string) {
    if (!roles.length) return false;
    return boundedCheckedRead(this.pool, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>({
        sql: `SELECT role,CAST(control_revision AS CHAR) revision,state,
          received_at>DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 15 SECOND) fresh FROM admin_runtime_observations
          WHERE exited_at IS NULL`,
        timeout: 2000,
      });
      const required = new Set([
        ...roles,
        ...rows.map((r) => r.role as RuntimeRole),
      ]);
      return [...required].every((role) => {
        const live = rows.filter((r) => r.role === role);
        return (
          live.length === 1 &&
          Number(live[0]!.fresh) === 1 &&
          String(live[0]!.revision) === revision &&
          ["IDLE", "RUNNING", "PAUSED"].includes(String(live[0]!.state))
        );
      });
    });
  }
  async storageObservation() {
    return boundedCheckedRead(this.pool, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>({
        sql: `SELECT
        CAST((SELECT COALESCE(SUM(CASE WHEN state IN ('CREATED','UPLOADING') THEN declared_size-committed_offset ELSE 0 END),0) FROM upload_sessions) AS CHAR) reservedFutureBytes,
        CAST((SELECT COALESCE(SUM(CASE WHEN state='READY' OR cleaned_at IS NOT NULL THEN 0 ELSE reserved_bytes END),0) FROM derived_assets) +
          (SELECT COALESCE(SUM(GREATEST(derived_bytes-LEAST(released_bytes,derived_bytes),0)),0) FROM purge_intents WHERE progress IN ('DETACHED','FILES_REMOVED')) AS CHAR) unsettledBytes,
        CAST((SELECT COUNT(*) FROM purge_intents WHERE progress IN ('DETACHED','FILES_REMOVED')) AS CHAR) unsettledPurges`,
        timeout: 2000,
      });
      const r = rows[0]!;
      return {
        reservedFutureBytes: BigInt(String(r.reservedFutureBytes)),
        unsettledBytes: BigInt(String(r.unsettledBytes)),
        unsettledPurges: BigInt(String(r.unsettledPurges)),
      };
    });
  }
  /** Owner-exclusive recovery observation. It does not claim, render, write
   * READY, remove files, or infer completion from an expired lease. */
  async verifyRecoveryInventory(input: {
    complete: boolean;
    temps: readonly DerivedRecoveryTempFact[];
    finals: readonly DerivedRecoveryFinalFact[];
  }) {
    if (
      !input.complete ||
      input.temps.length > 20_000 ||
      input.finals.length > 20_000
    )
      return false;
    return boundedCheckedRead(this.pool, async (c, discard) => {
      let begun = false;
      try {
        await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await c.query("START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT");
        begun = true;
        const [rows] = await c.query<RowDataPacket[]>(`SELECT
          CAST(family_id AS CHAR) familyId,CAST(media_id AS CHAR) mediaId,
          CAST(generation AS CHAR) generation,recipe_id recipeId,kind,state,
          CAST(byte_size AS CHAR) byteSize,LOWER(HEX(sha256)) sha256Hex,
          CAST(producer_job_id AS CHAR) jobId,CAST(producer_lease_epoch AS CHAR) epoch,
          CAST(reserved_bytes AS CHAR) reservedBytes
          FROM derived_assets WHERE cleaned_at IS NULL ORDER BY id LIMIT 20001`);
        const [pending] = await c.query<RowDataPacket[]>(`SELECT
          (SELECT COUNT(*) FROM background_jobs WHERE state='RUNNING') runningJobs,
          (SELECT COUNT(*) FROM purge_intents WHERE progress IN ('DETACHED','FILES_REMOVED')) purges`);
        const key = (r: {
          familyId: string;
          mediaId: string;
          generation: bigint | string;
          recipeId: number;
          kind: string;
        }) =>
          `${r.familyId}:${r.mediaId}:${r.generation}:${r.recipeId}:${r.kind}`;
        const assets = new Map(
          rows.map((r) => [key(r as Parameters<typeof key>[0]), r]),
        );
        let valid =
          rows.length <= 20_000 &&
          Number(pending[0]?.runningJobs) === 0 &&
          Number(pending[0]?.purges) === 0;
        const finals = new Set<string>();
        for (const final of input.finals) {
          const k = key(final),
            row = assets.get(k);
          if (
            finals.has(k) ||
            !row ||
            row.state !== "READY" ||
            final.fileClass !== "REGULAR" ||
            final.mode !== 0o400 ||
            final.nlink !== 1 ||
            row.byteSize !== final.byteSize.toString() ||
            row.sha256Hex !== final.sha256Hex
          )
            valid = false;
          finals.add(k);
        }
        const temps = new Set<string>();
        for (const temp of input.temps) {
          const k = `${temp.jobId}:${temp.epoch}:${temp.kind}`;
          const hits = rows.filter(
            (r) =>
              r.jobId === temp.jobId &&
              r.epoch === temp.epoch.toString() &&
              r.kind === temp.kind,
          );
          const row = hits.length === 1 ? hits[0] : undefined;
          // Sealed or published-but-uncommitted output requires the original
          // recovery protocol; it is never promoted to READY here.
          if (
            temps.has(k) ||
            !row ||
            row.state !== "RESERVED" ||
            row.sha256Hex !== null ||
            row.byteSize !== null ||
            temp.fileClass !== "REGULAR" ||
            temp.mode !== 0o600 ||
            temp.nlink !== 1 ||
            temp.byteSize > BigInt(row.reservedBytes)
          )
            valid = false;
          temps.add(k);
        }
        for (const row of rows) {
          if (
            row.state === "READY" &&
            !finals.has(key(row as Parameters<typeof key>[0]))
          )
            valid = false;
          if (!["READY", "RESERVED"].includes(String(row.state))) valid = false;
        }
        await c.commit();
        begun = false;
        return valid;
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
  async runtimeBeat(
    role: RuntimeRole,
    bootId: string,
    input: {
      revision: string;
      state: RuntimeState;
      reasonCode: string;
      success: boolean;
      completedUnits: string;
    },
  ) {
    const c = await acquireCheckedConnection(this.pool);
    try {
      const [result] = await c.execute<ResultSetHeader>(
        `UPDATE admin_runtime_observations
        SET received_at=CURRENT_TIMESTAMP(3),control_revision=?,state=?,reason_code=?,completed_units=?,
        last_successful_at=IF(?,CURRENT_TIMESTAMP(3),last_successful_at),exited_at=IF(?='STOPPED',CURRENT_TIMESTAMP(3),NULL)
        WHERE role=? AND boot_id=? AND exited_at IS NULL`,
        [
          input.revision,
          input.state,
          adminReasonSchema.parse(input.reasonCode),
          input.completedUnits,
          input.success,
          input.state,
          role,
          bootId,
        ],
      );
      return result.affectedRows === 1;
    } finally {
      c.release();
    }
  }
}
function publicOperation(row: RowDataPacket) {
  return adminOperationResponseSchema.parse({
    operationId: row.operationId,
    kind: row.kind,
    status: row.status,
    targetMode: row.targetMode,
    resultRevision:
      row.resultRevision === null ? null : String(row.resultRevision),
    reasonCode: row.reasonCode,
    createdAt: (row.createdAt as Date).toISOString(),
    finishedAt: row.finishedAt ? (row.finishedAt as Date).toISOString() : null,
  });
}

export type RuntimeRole = "API" | "DERIVATIVE" | "METADATA" | "PURGE";
export type RuntimeState =
  "STARTING" | "IDLE" | "RUNNING" | "PAUSED" | "RECOVERY_REQUIRED" | "STOPPED";
