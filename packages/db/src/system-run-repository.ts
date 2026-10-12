import { issueRunAdmissionProof } from "@family-album/contracts/internal/run-admission";
import { createHash, randomUUID } from "node:crypto";
import { adminControlStatusSchema } from "@family-album/contracts";
import { boundedCheckedRead } from "./bounded-read.js";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import {
  runCheckedTransaction,
  acquireCheckedConnection,
} from "./connection.js";
import { CommitOutcomeUnknownError } from "./transaction.js";
import {
  insertSystemControlAudit,
  SystemControlError,
} from "./system-control-repository.js";
export type RunRole = "API" | "DERIVATIVE" | "METADATA" | "PURGE";
export type RunProcess = {
  processId: string;
  osBootId: string;
  pid: number;
  startSec: string;
  startUsec: number;
};
export type RunMember = { role: RunRole; bootId: string };
export type RunConfiguration = {
  deploymentId: string;
  namespaceIdentity: string;
  runNamespaceIdentity: string;
  configDigest: string;
  expectedRoles: readonly RunRole[];
  ownerRole: "API" | "PURGE";
};
export type RunLease = {
  id: string;
  epoch: string;
  automatic: boolean;
  process: RunProcess;
  members: readonly RunMember[];
  configuration: RunConfiguration;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest();
const bytes = (value: string) => Buffer.from(value, "hex");
const same = (a: unknown, b: Buffer) => Buffer.isBuffer(a) && a.equals(b);
const failure = () => new SystemControlError("CONTROL_UNAVAILABLE");
async function control(c: PoolConnection) {
  const [rows] = await c.query<RowDataPacket[]>(
    "SELECT * FROM system_control WHERE id=1 FOR UPDATE",
  );
  if (!rows[0]) throw failure();
  return rows[0];
}
async function run(c: PoolConnection, id: string) {
  const [rows] = await c.query<RowDataPacket[]>(
    "SELECT * FROM system_control_runs WHERE id=? FOR UPDATE",
    [id],
  );
  if (!rows[0]) throw failure();
  return rows[0];
}
async function members(c: PoolConnection, id: string) {
  const [rows] = await c.query<RowDataPacket[]>(
    "SELECT * FROM system_control_run_members WHERE run_id=? ORDER BY role FOR UPDATE",
    [id],
  );
  return rows;
}
function current(row: RowDataPacket, lease: RunLease) {
  if (
    row.current_run_id !== lease.id ||
    String(row.run_epoch) !== lease.epoch ||
    row.deployment_id !== lease.configuration.deploymentId ||
    !same(row.namespace_identity, bytes(lease.configuration.namespaceIdentity))
  )
    throw failure();
}
function bootSet(rows: RowDataPacket[], lease: RunLease) {
  for (const m of lease.members)
    if (
      !rows.some(
        (r) =>
          r.role === m.role &&
          r.boot_id === m.bootId &&
          r.process_id === lease.process.processId &&
          String(r.epoch) === lease.epoch,
      )
    )
      throw failure();
}
function matchesConfiguration(r: RowDataPacket, config: RunConfiguration) {
  return (
    r.protocol_version === 1 &&
    r.deployment_id === config.deploymentId &&
    same(r.namespace_identity, bytes(config.namespaceIdentity)) &&
    same(r.run_namespace_identity, bytes(config.runNamespaceIdentity)) &&
    same(r.config_digest, bytes(config.configDigest)) &&
    r.expected_roles === [...config.expectedRoles].sort().join(",") &&
    r.owner_role === config.ownerRole
  );
}
function ackId(operationId: string, role: RunRole) {
  const id = hash([operationId, role]).toString("hex").slice(0, 32);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
function completeSet(
  rows: RowDataPacket[],
  roles: readonly RunRole[],
  state: string,
) {
  return (
    rows.length === roles.length &&
    roles.every((role) =>
      rows.some((r) => r.role === role && r.state === state),
    )
  );
}
async function insertMembers(
  c: PoolConnection,
  lease: RunLease,
  revision: string,
) {
  for (const m of lease.members) {
    await c.query(
      "UPDATE admin_runtime_observations SET state='STOPPED',reason_code='STOPPED',exited_at=CURRENT_TIMESTAMP(3),received_at=CURRENT_TIMESTAMP(3) WHERE role=? AND exited_at IS NULL",
      [m.role],
    );
    await c.query(
      "INSERT INTO admin_runtime_observations(boot_id,role,control_revision,state,reason_code) VALUES(?,?,?,'STARTING','STARTING')",
      [m.bootId, m.role, revision],
    );
    await c.query(
      "INSERT INTO system_control_run_members(run_id,role,boot_id,process_id,epoch,state) VALUES(?,?,?,?,?,'REGISTERED')",
      [lease.id, m.role, m.bootId, lease.process.processId, lease.epoch],
    );
  }
}
/** Internal deployment protocol. Every state mutation locks control -> run -> members.
 * Native run ownership and DRAINED_X are held by the caller, never acquired here. */
export class MySqlSystemRunRepository {
  constructor(private readonly pool: Pool) {}
  async readAdmission(lease: RunLease | undefined) {
    return boundedCheckedRead(this.pool, async (c) => {
      // One statement is the admission linearization, not separate run/control reads.
      const [rows] = await c.query<RowDataPacket[]>(
        {
          sql: `SELECT s.*, r.phase run_phase,r.config_digest,r.protocol_version,r.run_namespace_identity,r.owner_role,r.expected_roles,
        m.role member_role,m.boot_id member_boot,m.process_id member_process,m.epoch member_epoch,m.state member_state, rt.exited_at member_exited_at,rt.state runtime_state,rt.received_at>DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 15 SECOND) member_fresh
        FROM system_control s LEFT JOIN system_control_runs r ON r.id=s.current_run_id AND r.epoch=s.run_epoch
        LEFT JOIN system_control_run_members m ON m.run_id=r.id AND m.process_id=? LEFT JOIN admin_runtime_observations rt ON rt.boot_id=m.boot_id AND rt.role=m.role WHERE s.id=1 ORDER BY m.role`,
          timeout: 2000,
        },
        [lease?.process.processId ?? ""],
      );
      const state = rows[0];
      if (!state) throw failure();
      const active =
        !!lease &&
        state.current_run_id === lease.id &&
        String(state.run_epoch) === lease.epoch &&
        state.run_phase === "ACTIVE" &&
        state.deployment_id === lease.configuration.deploymentId &&
        same(
          state.namespace_identity,
          bytes(lease.configuration.namespaceIdentity),
        ) &&
        same(state.config_digest, bytes(lease.configuration.configDigest)) &&
        same(
          state.run_namespace_identity,
          bytes(lease.configuration.runNamespaceIdentity),
        ) &&
        state.protocol_version === 1 &&
        state.owner_role === lease.configuration.ownerRole &&
        state.expected_roles ===
          [...lease.configuration.expectedRoles].sort().join(",") &&
        rows.length === lease.members.length &&
        lease.members.every((m) =>
          rows.some(
            (r) =>
              r.member_role === m.role &&
              r.member_boot === m.bootId &&
              r.member_process === lease.process.processId &&
              String(r.member_epoch) === lease.epoch &&
              r.member_state === "READY" &&
              r.member_exited_at === null &&
              Number(r.member_fresh) === 1 &&
              ["IDLE", "RUNNING", "PAUSED"].includes(r.runtime_state),
          ),
        );
      const status = adminControlStatusSchema.parse({
        requestedMode: state.requested_mode,
        enforcedMode: state.enforced_mode,
        transitionState: state.transition_state,
        revision: String(state.revision),
        healthGeneration: String(state.health_generation),
        faultLatched: Boolean(state.fault_latched),
        reasonCode: state.reason_code,
        activeOperationId: state.active_operation_id ?? null,
        observedAt: new Date().toISOString(),
        localDeny: false,
      });
      return Object.freeze({
        ...status,
        deploymentId: String(state.deployment_id),
        namespaceIdentity: state.namespace_identity
          ? Buffer.from(state.namespace_identity).toString("hex")
          : null,
        ...(active
          ? {
              runProof: issueRunAdmissionProof({
                runId: lease.id,
                epoch: lease.epoch,
                processId: lease.process.processId,
              }),
            }
          : {}),
      });
    });
  }
  private async observeLease(lease: RunLease) {
    const c = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await c.query<RowDataPacket[]>(
        {
          sql: `SELECT r.* FROM system_control s JOIN system_control_runs r ON s.current_run_id=r.id AND s.run_epoch=r.epoch WHERE s.id=1 AND r.id=?`,
          timeout: 2000,
        },
        [lease.id],
      );
      const r = rows[0];
      if (
        !r ||
        String(r.epoch) !== lease.epoch ||
        !matchesConfiguration(r, lease.configuration)
      )
        throw failure();
      const [memberRows] = await c.query<RowDataPacket[]>(
        {
          sql: "SELECT * FROM system_control_run_members WHERE run_id=? ORDER BY role",
          timeout: 2000,
        },
        [lease.id],
      );
      bootSet(memberRows, lease);
      return { run: r, members: memberRows };
    } finally {
      c.release();
    }
  }
  private async commitOrObserve<T>(
    change: () => Promise<T>,
    observe: () => Promise<T>,
  ): Promise<T> {
    try {
      return await change();
    } catch (error) {
      if (!(error instanceof CommitOutcomeUnknownError)) throw error;
      return observe();
    }
  }
  async observeCurrent() {
    const c = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT r.* FROM system_control c JOIN system_control_runs r ON r.id=c.current_run_id WHERE c.id=1",
      );
      return rows[0] ?? null;
    } finally {
      c.release();
    }
  }
  async begin(
    configuration: RunConfiguration,
    process: RunProcess,
    newMembers: readonly RunMember[],
    markerAbsent: boolean,
    startupOperationId = randomUUID(),
  ): Promise<RunLease> {
    const expected = [...configuration.expectedRoles].sort();
    if (
      expected.length === 0 ||
      new Set(expected).size !== expected.length ||
      !expected.includes(configuration.ownerRole) ||
      !newMembers.some((m) => m.role === configuration.ownerRole) ||
      newMembers.some((m) => !expected.includes(m.role)) ||
      new Set(newMembers.map((m) => m.role)).size !== newMembers.length
    )
      throw failure();
    let lease: RunLease | undefined, expectedFingerprint: Buffer | undefined;
    try {
      return await runCheckedTransaction(this.pool, async (c) => {
        const state = await control(c);
        if (
          state.deployment_id !== configuration.deploymentId ||
          !same(
            state.namespace_identity,
            bytes(configuration.namespaceIdentity),
          )
        )
          throw failure();
        const epoch = BigInt(String(state.run_epoch));
        if (epoch >= 18446744073709551615n) throw failure();
        const prior = state.current_run_id
          ? await run(c, String(state.current_run_id))
          : null;
        const [pending] = await c.query<RowDataPacket[]>(
          "SELECT COUNT(*) n FROM system_control_operations WHERE status='PENDING'",
        );
        let automatic = !!(
          prior &&
          prior.phase === "CLEAN" &&
          markerAbsent &&
          state.transition_state === "STABLE" &&
          !state.fault_latched &&
          String(pending[0]!.n) === "0" &&
          String(prior.epoch) === String(state.run_epoch) &&
          prior.protocol_version === 1 &&
          prior.deployment_id === configuration.deploymentId &&
          same(
            prior.namespace_identity,
            bytes(configuration.namespaceIdentity),
          ) &&
          same(
            prior.run_namespace_identity,
            bytes(configuration.runNamespaceIdentity),
          ) &&
          same(prior.config_digest, bytes(configuration.configDigest)) &&
          prior.expected_roles === expected.join(",") &&
          prior.owner_role === configuration.ownerRole &&
          String(prior.clean_revision) === String(state.revision) &&
          String(prior.clean_health_generation) ===
            String(state.health_generation) &&
          prior.clean_requested_mode === state.requested_mode &&
          prior.clean_enforced_mode === state.enforced_mode &&
          prior.shutdown_operation_id &&
          Buffer.isBuffer(prior.shutdown_fingerprint) &&
          Buffer.isBuffer(prior.member_manifest) &&
          prior.clean_at
        );
        if (automatic) {
          const previousMembers = await members(c, prior!.id);
          if (
            !completeSet(previousMembers, expected, "CLEAN_CLOSED") ||
            !same(
              prior!.member_manifest,
              hash(
                previousMembers.map((m) => [
                  m.role,
                  m.boot_id,
                  m.process_id,
                  m.epoch,
                  m.ack_operation_id,
                  Buffer.from(m.ack_fingerprint).toString("hex"),
                ]),
              ),
            )
          )
            // Invalid terminal evidence cannot authorize an automatic start.
            // Preserve it as history and register a protected successor for
            // the original authorized fresh RECHECK, just as config drift does.
            automatic = false;
          if (automatic)
            await c.query(
              "UPDATE system_control_runs SET phase='CONSUMED' WHERE id=? AND phase='CLEAN'",
              [prior!.id],
            );
        }
        lease = {
          id: randomUUID(),
          epoch: String(epoch + 1n),
          automatic,
          process,
          members: newMembers,
          configuration,
        };
        expectedFingerprint = hash({
          configuration,
          process,
          members: newMembers,
          startupOperationId,
          epoch: lease.epoch,
          predecessor: automatic ? prior!.id : null,
        });
        await c.query(
          `INSERT INTO system_control_runs(id,epoch,predecessor_id,deployment_id,namespace_identity,run_namespace_identity,protocol_version,config_digest,phase,expected_roles,owner_role,coordinator_process_id,coordinator_os_boot_id,coordinator_pid,coordinator_start_sec,coordinator_start_usec,startup_operation_id,startup_fingerprint,automatic)
    VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            lease.id,
            lease.epoch,
            automatic ? prior!.id : null,
            configuration.deploymentId,
            bytes(configuration.namespaceIdentity),
            bytes(configuration.runNamespaceIdentity),
            bytes(configuration.configDigest),
            automatic ? "PREPARING" : "RECOVERY_REQUIRED",
            expected.join(","),
            configuration.ownerRole,
            process.processId,
            process.osBootId,
            process.pid,
            process.startSec,
            process.startUsec,
            startupOperationId,
            expectedFingerprint,
            automatic,
          ],
        );
        await c.query(
          "UPDATE system_control SET current_run_id=?,run_epoch=? WHERE id=1 AND run_epoch=?",
          [lease.id, lease.epoch, String(epoch)],
        );
        await insertMembers(c, lease, String(state.revision));
        await insertSystemControlAudit(c, {
          operationId: startupOperationId,
          transition: "RUN_START",
          action: "RUN_STARTED",
          result: automatic ? "SUCCESS" : "RECOVERY_REQUIRED",
          revision: String(state.revision),
        });
        return lease;
      });
    } catch (error) {
      if (
        !(error instanceof CommitOutcomeUnknownError) ||
        !lease ||
        !expectedFingerprint
      )
        throw error;
      const c = await acquireCheckedConnection(this.pool);
      try {
        const [rows] = await c.query<RowDataPacket[]>(
          "SELECT r.* FROM system_control_runs r JOIN system_control s ON s.current_run_id=r.id AND s.run_epoch=r.epoch WHERE r.startup_operation_id=?",
          [startupOperationId],
        );
        if (
          rows.length !== 1 ||
          rows[0]!.id !== lease.id ||
          !same(rows[0]!.startup_fingerprint, expectedFingerprint)
        )
          throw error;
        return lease;
      } finally {
        c.release();
      }
    }
  }
  async join(
    configuration: RunConfiguration,
    process: RunProcess,
    newMembers: readonly RunMember[],
    expectedRunId: string,
  ): Promise<RunLease> {
    return runCheckedTransaction(this.pool, async (c) => {
      const state = await control(c);
      if (state.current_run_id !== expectedRunId) throw failure();
      const r = await run(c, expectedRunId);
      if (
        !matchesConfiguration(r, configuration) ||
        String(r.epoch) !== String(state.run_epoch) ||
        newMembers.length === 0 ||
        new Set(newMembers.map((m) => m.role)).size !== newMembers.length ||
        !["PREPARING", "RECOVERY_REQUIRED"].includes(r.phase) ||
        r.deployment_id !== configuration.deploymentId ||
        !same(r.config_digest, bytes(configuration.configDigest)) ||
        !same(
          r.run_namespace_identity,
          bytes(configuration.runNamespaceIdentity),
        ) ||
        r.expected_roles !== [...configuration.expectedRoles].sort().join(",")
      )
        throw failure();
      const rows = await members(c, r.id);
      if (
        newMembers.some(
          (m) =>
            !configuration.expectedRoles.includes(m.role) ||
            rows.some((r) => r.role === m.role),
        )
      )
        throw failure();
      const lease = {
        id: String(r.id),
        epoch: String(r.epoch),
        automatic: Boolean(r.automatic),
        process,
        members: newMembers,
        configuration,
      };
      current(state, lease);
      await insertMembers(c, lease, String(state.revision));
      return lease;
    });
  }
  async ready(lease: RunLease) {
    await runCheckedTransaction(this.pool, async (c) => {
      current(await control(c), lease);
      const r = await run(c, lease.id);
      const rows = await members(c, lease.id);
      bootSet(rows, lease);
      if (r.phase === "ACTIVE") {
        // Activation may commit after the heartbeat's PREPARING observation.
        // An exact already-ready boot is an idempotent confirmation, never a
        // late registration or promotion after the process set is activated.
        if (
          lease.members.every((m) =>
            rows.some(
              (row) =>
                row.role === m.role &&
                row.boot_id === m.bootId &&
                row.state === "READY",
            ),
          )
        )
          return;
        throw failure();
      }
      if (!["PREPARING", "RECOVERY_REQUIRED"].includes(r.phase))
        throw failure();
      for (const m of lease.members)
        await c.query(
          "UPDATE system_control_run_members SET state='READY' WHERE run_id=? AND role=? AND boot_id=? AND state='REGISTERED'",
          [lease.id, m.role, m.bootId],
        );
    });
  }
  async activateAutomatic(lease: RunLease) {
    let startupOperationId: string | undefined;
    let startupFingerprint: Buffer | undefined;
    return this.commitOrObserve(
      () =>
        runCheckedTransaction(this.pool, async (c) => {
          const state = await control(c);
          current(state, lease);
          const r = await run(c, lease.id);
          const previous = r.predecessor_id
            ? await run(c, r.predecessor_id)
            : null;
          const rows = await members(c, lease.id);
          bootSet(rows, lease);
          if (r.phase === "ACTIVE") return true;
          if (
            r.phase !== "PREPARING" ||
            !r.automatic ||
            state.fault_latched ||
            state.transition_state !== "STABLE" ||
            !completeSet(rows, lease.configuration.expectedRoles, "READY")
          )
            return false;
          const [pending] = await c.query<RowDataPacket[]>(
            "SELECT COUNT(*) n FROM system_control_operations WHERE status='PENDING'",
          );
          if (String(pending[0]!.n) !== "0") return false;
          if (
            !previous ||
            previous.phase !== "CONSUMED" ||
            String(previous.clean_revision) !== String(state.revision) ||
            String(previous.clean_health_generation) !==
              String(state.health_generation) ||
            previous.clean_requested_mode !== state.requested_mode ||
            previous.clean_enforced_mode !== state.enforced_mode
          )
            throw failure();
          startupOperationId = r.startup_operation_id;
          startupFingerprint = Buffer.from(r.startup_fingerprint);
          await c.query(
            "UPDATE system_control_runs SET phase='ACTIVE' WHERE id=? AND phase='PREPARING'",
            [lease.id],
          );
          await insertSystemControlAudit(c, {
            operationId: r.startup_operation_id,
            transition: "AUTO_ACTIVE",
            action: "STARTUP_AUTO_CONFIRMED",
            result: "SUCCESS",
            revision: String(state.revision),
          });
          return true;
        }),
      async () => {
        const observed = await this.observeLease(lease);
        if (
          !startupOperationId ||
          !startupFingerprint ||
          observed.run.phase !== "ACTIVE" ||
          !observed.run.automatic ||
          observed.run.startup_operation_id !== startupOperationId ||
          !same(observed.run.startup_fingerprint, startupFingerprint) ||
          !completeSet(
            observed.members,
            lease.configuration.expectedRoles,
            "READY",
          )
        )
          throw failure();
        return true;
      },
    );
  }
  async stopping(lease: RunLease, shutdownOperationId: string) {
    const fingerprint = hash({
      runId: lease.id,
      epoch: lease.epoch,
      shutdownOperationId,
    });
    await this.commitOrObserve(
      () =>
        runCheckedTransaction(this.pool, async (c) => {
          const state = await control(c);
          current(state, lease);
          const r = await run(c, lease.id);
          if (r.phase === "STOPPING") {
            if (
              r.shutdown_operation_id !== shutdownOperationId ||
              !same(r.shutdown_fingerprint, fingerprint)
            )
              throw failure();
            return;
          }
          if (r.phase !== "ACTIVE") throw failure();
          await c.query(
            "UPDATE system_control_runs SET phase='STOPPING',shutdown_operation_id=?,shutdown_fingerprint=? WHERE id=? AND phase='ACTIVE'",
            [shutdownOperationId, fingerprint, lease.id],
          );
          await insertSystemControlAudit(c, {
            operationId: shutdownOperationId,
            transition: "RUN_STOPPING",
            action: "RUN_STOPPING",
            result: "SUCCESS",
            revision: String(state.revision),
          });
        }),
      async () => {
        const { run: r } = await this.observeLease(lease);
        if (
          r.phase !== "STOPPING" ||
          r.shutdown_operation_id !== shutdownOperationId ||
          !same(r.shutdown_fingerprint, fingerprint)
        )
          throw failure();
      },
    );
  }
  async phase(lease: RunLease) {
    const r = await this.observeCurrent();
    if (!r || r.id !== lease.id || String(r.epoch) !== lease.epoch)
      throw failure();
    return String(r.phase);
  }
  /** Monotone fault protection only; never consumes a certificate or grants
   * admission. Authorized recovery still uses the original completion tx. */
  async requireRecovery(lease: RunLease) {
    await runCheckedTransaction(this.pool, async (c) => {
      const state = await control(c);
      current(state, lease);
      const r = await run(c, lease.id);
      bootSet(await members(c, lease.id), lease);
      if (!["PREPARING", "ACTIVE"].includes(r.phase)) return;
      await c.query(
        "UPDATE system_control_runs SET phase='RECOVERY_REQUIRED' WHERE id=? AND phase IN ('PREPARING','ACTIVE')",
        [lease.id],
      );
      await insertSystemControlAudit(c, {
        operationId: r.startup_operation_id,
        transition: `RUN_RECOVERY:${String(state.revision)}`,
        action: "STARTUP_RECHECK_REQUIRED",
        result: "RECOVERY_REQUIRED",
        revision: String(state.revision),
      });
    });
  }
  async acknowledge(lease: RunLease, ackOperationId: string) {
    const fingerprint = hash({
      runId: lease.id,
      epoch: lease.epoch,
      processId: lease.process.processId,
      members: lease.members,
    });
    await this.commitOrObserve(
      () =>
        runCheckedTransaction(this.pool, async (c) => {
          const state = await control(c);
          current(state, lease);
          const r = await run(c, lease.id),
            rows = await members(c, lease.id);
          bootSet(rows, lease);
          if (r.phase !== "STOPPING") throw failure();
          for (const m of lease.members) {
            const member = rows.find((r) => r.boot_id === m.bootId)!;
            const uuid = ackId(ackOperationId, m.role);
            if (member.state === "CLEAN_CLOSED") {
              if (
                member.ack_operation_id !== uuid ||
                !same(member.ack_fingerprint, fingerprint)
              )
                throw failure();
              continue;
            }
            if (member.state !== "READY") throw failure();
            await c.query(
              "UPDATE system_control_run_members SET state='CLEAN_CLOSED',ack_operation_id=?,ack_fingerprint=?,closed_at=CURRENT_TIMESTAMP(3) WHERE run_id=? AND boot_id=? AND state='READY'",
              [uuid, fingerprint, lease.id, m.bootId],
            );
          }
        }),
      async () => {
        const { run: r, members: rows } = await this.observeLease(lease);
        if (r.phase !== "STOPPING") throw failure();
        for (const m of lease.members) {
          const member = rows.find((row) => row.boot_id === m.bootId)!;
          if (
            member.state !== "CLEAN_CLOSED" ||
            member.ack_operation_id !== ackId(ackOperationId, m.role) ||
            !same(member.ack_fingerprint, fingerprint)
          )
            throw failure();
        }
      },
    );
  }
  async clean(lease: RunLease) {
    let shutdownId: string | undefined,
      shutdownFingerprint: Buffer | undefined,
      expectedManifest: Buffer | undefined;
    return this.commitOrObserve(
      () =>
        runCheckedTransaction(this.pool, async (c) => {
          const state = await control(c);
          current(state, lease);
          const r = await run(c, lease.id),
            rows = await members(c, lease.id);
          if (r.phase === "CLEAN") return true;
          if (
            r.phase !== "STOPPING" ||
            state.fault_latched ||
            state.transition_state !== "STABLE" ||
            !completeSet(
              rows,
              lease.configuration.expectedRoles,
              "CLEAN_CLOSED",
            )
          )
            return false;
          const [pending] = await c.query<RowDataPacket[]>(
            "SELECT COUNT(*) n FROM system_control_operations WHERE status='PENDING'",
          );
          if (String(pending[0]!.n) !== "0") return false;
          const manifest = hash(
            rows.map((m) => [
              m.role,
              m.boot_id,
              m.process_id,
              m.epoch,
              m.ack_operation_id,
              Buffer.from(m.ack_fingerprint).toString("hex"),
            ]),
          );
          shutdownId = String(r.shutdown_operation_id);
          shutdownFingerprint = r.shutdown_fingerprint;
          expectedManifest = manifest;
          await c.query(
            "UPDATE system_control_runs SET phase='CLEAN',clean_requested_mode=?,clean_enforced_mode=?,clean_revision=?,clean_health_generation=?,member_manifest=?,clean_at=CURRENT_TIMESTAMP(3) WHERE id=? AND phase='STOPPING'",
            [
              state.requested_mode,
              state.enforced_mode,
              String(state.revision),
              String(state.health_generation),
              manifest,
              lease.id,
            ],
          );
          await insertSystemControlAudit(c, {
            operationId: r.shutdown_operation_id,
            transition: "RUN_CLEAN",
            action: "RUN_CLEAN_CLOSED",
            result: "SUCCESS",
            revision: String(state.revision),
          });
          return true;
        }),
      async () => {
        const { run: r, members: rows } = await this.observeLease(lease);
        if (
          !shutdownId ||
          !shutdownFingerprint ||
          !expectedManifest ||
          r.phase !== "CLEAN" ||
          r.shutdown_operation_id !== shutdownId ||
          !same(r.shutdown_fingerprint, shutdownFingerprint) ||
          !same(r.member_manifest, expectedManifest) ||
          !completeSet(rows, lease.configuration.expectedRoles, "CLEAN_CLOSED")
        )
          throw failure();
        return true;
      },
    );
  }
}
/** Called only inside the original authorized, fenced RECHECK/BOOTSTRAP completion transaction. */
export async function activateRecoveredRun(
  c: PoolConnection,
  state: RowDataPacket,
  lease?: RunLease,
) {
  if (!lease) throw failure();
  current(state, lease);
  if (!state.current_run_id) throw failure();
  const r = await run(c, String(state.current_run_id)),
    rows = await members(c, String(state.current_run_id));
  bootSet(rows, lease);
  if (!matchesConfiguration(r, lease.configuration)) throw failure();
  if (
    String(r.epoch) !== String(state.run_epoch) ||
    !["RECOVERY_REQUIRED", "ACTIVE"].includes(r.phase) ||
    !completeSet(
      rows,
      String(r.expected_roles).split(",") as RunRole[],
      "READY",
    )
  )
    throw failure();
  await c.query(
    "UPDATE system_control_runs SET phase='ACTIVE',automatic=0 WHERE id=? AND phase IN ('RECOVERY_REQUIRED','ACTIVE')",
    [r.id],
  );
}
