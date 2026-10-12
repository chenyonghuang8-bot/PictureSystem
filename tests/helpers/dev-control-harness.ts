import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSessionToken,
  hashSessionToken,
} from "../../packages/auth/src/index.js";
import {
  MySqlSystemControlRepository,
  MySqlAuthRepository,
  runCheckedTransaction,
  acquireCheckedConnection,
  type Pool,
  type RowDataPacket,
  type ResultSetHeader,
  type SystemRequestActor,
} from "../../packages/db/src/index.js";
import { OperationGate } from "../../packages/storage/src/index.js";
import { AuthService } from "../../apps/api/src/auth/service.js";
import { verifyRetainedAuditFixtures } from "./retained-audit-fixtures.js";
import { verifyRetiredControlFixtures } from "./retired-control-fixtures.js";

/** Real synthetic DEV control plane for an actual API/worker fixture. The
 * application remains the sole media owner and performs every recovery proof.
 * No mock admission, forced NORMAL, fixture heartbeat or second writer. */
export class DevControlHarness {
  readonly repository: MySqlSystemControlRepository;
  readonly gate: OperationGate;
  readonly env: Record<string, string>;
  private readonly operations: string[] = [];
  private readonly boots = new Set<string>();
  private recordRuntimeEvidence() {
    writeFileSync(
      join(
        process.cwd(),
        ".cache",
        "phase11-current",
        `api-runtime-${this.deploymentId}.json`,
      ),
      JSON.stringify(
        { operations: this.operations, boots: [...this.boots] },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  private constructor(
    private readonly pool: Pool,
    private readonly container: string,
    private readonly deploymentId: string,
    private readonly initial: RowDataPacket,
    private readonly actor: SystemRequestActor,
    private readonly memberId: string,
    private readonly name: string,
    private readonly baselineBoots: ReadonlySet<string>,
    gate: OperationGate,
    private readonly grantOperation = randomUUID(),
  ) {
    this.repository = new MySqlSystemControlRepository(pool);
    this.gate = gate;
    this.env = {
      DEV_CONTROL_PATH: gate.namespace.path,
      DEV_CONTROL_DEPLOYMENT_ID: deploymentId,
      DEV_CONTROL_REQUIRED_ROLES: "API,DERIVATIVE",
    };
  }
  static async create(
    pool: Pool,
    passwordHash: string,
    ownedFamilyIds: readonly string[],
    requiredRoles = "API,DERIVATIVE",
  ) {
    const c = await acquireCheckedConnection(pool);
    let initial: RowDataPacket;
    let baselineBoots: Set<string>;
    try {
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT * FROM system_control WHERE id=1",
      );
      initial = rows[0]!;
      if (
        initial.deployment_id !== "00000000-0000-0000-0000-000000000000" ||
        initial.namespace_identity !== null ||
        initial.reason_code !== "NOT_INITIALIZED" ||
        String(initial.revision) !== "1"
      )
        throw Error("DEV_CONTROL_BASELINE_NOT_OWNED");
      const [others] = await c.query<RowDataPacket[]>(
        "SELECT CAST(id AS CHAR) id FROM families",
      );
      const retained = await verifyRetainedAuditFixtures(c);
      if (
        others.some(
          (r) =>
            !ownedFamilyIds.includes(String(r.id)) &&
            !retained.has(String(r.id)),
        )
      )
        throw Error("DEV_CONTROL_OTHER_FAMILY_PRESENT");
      const [active] = await c.query<RowDataPacket[]>(
        "SELECT (SELECT COUNT(*) FROM admin_runtime_observations WHERE exited_at IS NULL) runtimes,(SELECT COUNT(*) FROM system_control_operations) operations,(SELECT COUNT(*) FROM system_admin_grants) grants",
      );
      const retiredControl = await verifyRetiredControlFixtures(c);
      if (
        String(active[0]!.runtimes) !== "0" ||
        String(active[0]!.grants) !== "0" ||
        String(active[0]!.operations) !== String(retiredControl.operations.size)
      )
        throw Error("DEV_CONTROL_OTHER_RUNTIME_PRESENT");
      const [history] = await c.query<RowDataPacket[]>(
        "SELECT boot_id FROM admin_runtime_observations WHERE exited_at IS NOT NULL",
      );
      baselineBoots = new Set(history.map((r) => String(r.boot_id)));
    } finally {
      c.release();
    }
    const container = mkdtempSync(
        join(realpathSync(tmpdir()), "phase11-api-control-"),
      ),
      deploymentId = randomUUID(),
      name = `phase11_harness_${randomUUID().replaceAll("-", "")}`;
    const path = join(container, "control");
    mkdirSync(path, { mode: 0o700 });
    const gate = OperationGate.provisionDev({ path, deploymentId });
    const seeded = await runCheckedTransaction(pool, async (c) => {
      const [f] = await c.query<ResultSetHeader>(
        "INSERT INTO families(name) VALUES(?)",
        [name],
      );
      const [u] = await c.query<ResultSetHeader>(
        "INSERT INTO users(username,username_normalized,password_hash,password_changed_at) VALUES(?,?,?,CURRENT_TIMESTAMP(3))",
        [name, Buffer.from(name), passwordHash],
      );
      const [m] = await c.query<ResultSetHeader>(
        "INSERT INTO family_members(family_id,user_id,role) VALUES(?,?,'SUPER_ADMIN')",
        [String(f.insertId), String(u.insertId)],
      );
      const tokenHash = hashSessionToken(createSessionToken());
      const [s] = await c.query<ResultSetHeader>(
        "INSERT INTO sessions(user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at) VALUES(?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY))",
        [String(u.insertId), tokenHash],
      );
      return {
        actor: {
          familyId: String(f.insertId),
          userId: String(u.insertId),
          sessionId: String(s.insertId),
          tokenHash,
          expectedClientType: "WEB" as const,
        },
        memberId: String(m.insertId),
      };
    });
    const h = new DevControlHarness(
      pool,
      container,
      deploymentId,
      initial,
      seeded.actor,
      seeded.memberId,
      name,
      baselineBoots,
      gate,
    );
    h.env.DEV_CONTROL_REQUIRED_ROLES = requiredRoles;
    const evidence = join(process.cwd(), ".cache", "phase11-current");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(
      join(evidence, `api-fixture-${deploymentId}.json`),
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          deploymentId,
          container,
          initial,
          baselineBoots: [...baselineBoots],
          ownedFamilyIds,
          requiredRoles,
          familyId: seeded.actor.familyId,
          userId: seeded.actor.userId,
          sessionId: seeded.actor.sessionId,
          memberId: seeded.memberId,
          name,
          grantOperation: h.grantOperation,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await h.repository.localGrant({
      familyId: seeded.actor.familyId,
      userId: seeded.actor.userId,
      enabled: true,
      operationId: h.grantOperation,
    });
    const s = await gate.acquire("S", 0);
    let namespaceIdentity: string;
    try {
      namespaceIdentity = s.identity();
    } finally {
      s.close();
    }
    const operationId = randomUUID();
    h.operations.push(operationId);
    h.recordRuntimeEvidence();
    await h.repository.bootstrap({
      operationId,
      deploymentId,
      namespaceIdentity,
    });
    return h;
  }
  /** Resume only an exactly recorded synthetic fixture, never another run. */
  static async resume(pool: Pool, deploymentId: string) {
    if (!/^[0-9a-f-]{36}$/u.test(deploymentId))
      throw Error("DEV_CONTROL_RUN_ID_INVALID");
    const folder = join(process.cwd(), ".cache", "phase11-current");
    const m = JSON.parse(
      readFileSync(join(folder, `api-fixture-${deploymentId}.json`), "utf8"),
    );
    const recorded = JSON.parse(
      readFileSync(join(folder, `api-runtime-${deploymentId}.json`), "utf8"),
    );
    const c = await acquireCheckedConnection(pool);
    let tokenHash: Buffer;
    try {
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id JOIN family_members fm ON fm.user_id=u.id JOIN families f ON f.id=fm.family_id WHERE s.id=? AND u.id=? AND u.username=? AND fm.id=? AND f.id=? AND f.name=?",
        [m.sessionId, m.userId, m.name, m.memberId, m.familyId, m.name],
      );
      if (
        m.deploymentId !== deploymentId ||
        rows.length !== 1 ||
        !Buffer.isBuffer(rows[0]!.token_hash)
      )
        throw Error("DEV_CONTROL_SAVED_FIXTURE_NOT_OWNED");
      tokenHash = rows[0]!.token_hash;
    } finally {
      c.release();
    }
    const gate = new OperationGate({
      path: join(m.container, "control"),
      deploymentId,
    });
    const h = new DevControlHarness(
      pool,
      m.container,
      deploymentId,
      { ...m.initial, updated_at: new Date(m.initial.updated_at) },
      {
        familyId: m.familyId,
        userId: m.userId,
        sessionId: m.sessionId,
        tokenHash,
        expectedClientType: "WEB",
      },
      m.memberId,
      m.name,
      new Set(m.baselineBoots),
      gate,
      m.grantOperation,
    );
    h.env.DEV_CONTROL_REQUIRED_ROLES = m.requiredRoles ?? "API";
    h.operations.push(...recorded.operations);
    for (const boot of recorded.boots) h.boots.add(boot);
    const current = await h.repository.readCurrent();
    const permit = await gate.acquire("S", 0);
    try {
      if (
        current.deploymentId !== deploymentId ||
        current.namespaceIdentity !== permit.identity()
      )
        throw Error("DEV_CONTROL_SAVED_NAMESPACE_CHANGED");
    } finally {
      permit.close();
    }
    return h;
  }
  async waitStable(mode: "READ_ONLY" | "NORMAL" | "MAINTENANCE") {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const current = await this.repository.readCurrent();
      if (
        current.transitionState === "STABLE" &&
        current.enforcedMode === mode &&
        !current.faultLatched
      )
        return;
      await delay(100);
    }
    throw Error("DEV_CONTROL_APPLICATION_RECOVERY_NOT_READY");
  }
  async request(mode: "NORMAL" | "READ_ONLY" | "MAINTENANCE") {
    const operationId = randomUUID();
    this.operations.push(operationId);
    this.recordRuntimeEvidence();
    await this.repository.requestMode(this.actor, {
      operationId,
      expectedRevision: (await this.repository.readCurrent()).revision,
      targetMode: mode,
      reasonCode:
        mode === "NORMAL"
          ? "MANUAL_RESUME"
          : mode === "READ_ONLY"
            ? "MANUAL_READ_ONLY"
            : "MANUAL_MAINTENANCE",
    });
    await this.waitStable(mode);
  }
  get syntheticIdentity() {
    return {
      username: this.name,
      userId: this.actor.userId,
      familyId: this.actor.familyId,
      memberId: this.memberId,
    };
  }
  /** Capture only browser-created receipts belonging to this exact synthetic actor. */
  async captureBrowserOperation(id: string) {
    const c = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT actor_user_id,actor_family_id FROM system_control_operations WHERE id=?",
        [id],
      );
      if (
        rows.length !== 1 ||
        String(rows[0]!.actor_user_id) !== this.actor.userId ||
        String(rows[0]!.actor_family_id) !== this.actor.familyId
      )
        throw Error("DEV_CONTROL_BROWSER_OPERATION_NOT_OWNED");
      if (!this.operations.includes(id)) this.operations.push(id);
      this.recordRuntimeEvidence();
    } finally {
      c.release();
    }
  }
  async reauthenticate(password: string) {
    const repository = new MySqlAuthRepository(this.pool);
    const identity = await repository.findSession(this.actor.tokenHash);
    if (
      !identity ||
      identity.userId !== this.actor.userId ||
      identity.sessionId !== this.actor.sessionId
    )
      throw Error("DEV_CONTROL_ACTOR_CHANGED");
    const auth = await AuthService.create(repository);
    const issued = await auth.reauthenticate(
      { identity, tokenHash: this.actor.tokenHash, expectedClientType: "WEB" },
      password,
      "127.0.0.1",
    );
    this.actor.tokenHash = hashSessionToken(issued.token);
  }
  async beginRecheck() {
    const operationId = randomUUID();
    this.operations.push(operationId);
    this.recordRuntimeEvidence();
    await this.repository.requestRecheck(this.actor, {
      operationId,
      expectedRevision: (await this.repository.readCurrent()).revision,
    });
    return operationId;
  }
  async recheck() {
    await this.beginRecheck();
    await this.waitStable("READ_ONLY");
  }
  async observeRoles(roles: readonly string[], requireNew = false) {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const c = await acquireCheckedConnection(this.pool);
      try {
        const [rows] = await c.query<RowDataPacket[]>(
          "SELECT role,boot_id bootId FROM admin_runtime_observations WHERE exited_at IS NULL",
        );
        if (
          roles.every(
            (role) =>
              rows.filter(
                (r) =>
                  r.role === role &&
                  (!requireNew || !this.boots.has(String(r.bootId))),
              ).length === 1,
          )
        ) {
          for (const row of rows.filter((r) => roles.includes(String(r.role))))
            this.boots.add(String(row.bootId));
          this.recordRuntimeEvidence();
          return;
        }
      } finally {
        c.release();
      }
      await delay(50);
    }
    throw Error("DEV_CONTROL_EXPECTED_RUNTIME_MISSING");
  }
  /** Call only after all actual fixture API/worker processes have exited. */
  async cleanup(recoveredBootstrapIds: readonly string[] = []) {
    await runCheckedTransaction(this.pool, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
          "SELECT * FROM system_control WHERE id=1 FOR UPDATE",
        ),
        r = rows[0]!;
      if (
        r.deployment_id !== this.deploymentId ||
        r.enforced_mode !== "READ_ONLY" ||
        r.transition_state !== "STABLE" ||
        r.fault_latched
      )
        throw Error("DEV_CONTROL_PROTECTED_CLEANUP_REQUIRED");
      const [ops] = await c.query<RowDataPacket[]>(
        "SELECT id,status,kind,reason_code reason,CAST(expected_revision AS CHAR) expectedRevision,CAST(result_revision AS CHAR) resultRevision,CAST(actor_user_id AS CHAR) actorUserId,CAST(actor_family_id AS CHAR) actorFamilyId FROM system_control_operations",
      );
      const recoveredMode = (o: RowDataPacket) =>
        o.kind === "MODE" &&
        o.status === "RECOVERY_REQUIRED" &&
        o.reason === "STARTUP_RECHECK_REQUIRED" &&
        recoveredBootstrapIds.includes(String(o.id)) &&
        o.actorUserId === this.actor.userId &&
        o.actorFamilyId === this.actor.familyId &&
        ops.some(
          (proof) =>
            this.operations.includes(String(proof.id)) &&
            proof.kind === "RECHECK" &&
            proof.status === "APPLIED" &&
            proof.actorUserId === this.actor.userId &&
            proof.actorFamilyId === this.actor.familyId &&
            BigInt(String(proof.expectedRevision)) >
              BigInt(String(o.expectedRevision)) &&
            BigInt(String(proof.resultRevision)) <= BigInt(String(r.revision)),
        );
      const [terminalRun] = await c.query<RowDataPacket[]>(
        "SELECT phase FROM system_control_runs WHERE id=?",
        [r.current_run_id],
      );
      const recoveredDatabaseRecheck = (o: RowDataPacket) =>
        o.kind === "RECHECK" &&
        o.status === "RECOVERY_REQUIRED" &&
        o.reason === "DB_UNAVAILABLE" &&
        recoveredBootstrapIds.includes(String(o.id)) &&
        r.active_operation_id !== o.id &&
        terminalRun[0]?.phase === "CLEAN" &&
        o.actorUserId === this.actor.userId &&
        o.actorFamilyId === this.actor.familyId &&
        ops.some(
          (proof) =>
            this.operations.includes(String(proof.id)) &&
            proof.kind === "RECHECK" &&
            proof.status === "APPLIED" &&
            proof.actorUserId === this.actor.userId &&
            proof.actorFamilyId === this.actor.familyId &&
            BigInt(String(proof.expectedRevision)) >
              BigInt(String(o.expectedRevision)) &&
            BigInt(String(proof.resultRevision)) <= BigInt(String(r.revision)),
        );
      const retiredControl = await verifyRetiredControlFixtures(c);
      if (
        ops.some(
          (o) =>
            !retiredControl.operations.has(String(o.id)) &&
            (!this.operations.includes(String(o.id)) ||
              (o.status !== "APPLIED" &&
                !recoveredMode(o) &&
                !recoveredDatabaseRecheck(o) &&
                !(
                  ["BOOTSTRAP", "RECHECK"].includes(o.kind) &&
                  o.status === "RECOVERY_REQUIRED" &&
                  [
                    "STORAGE_UNAVAILABLE",
                    "RECOVERY_FAILED",
                    "STARTUP_RECHECK_REQUIRED",
                  ].includes(String(o.reason)) &&
                  recoveredBootstrapIds.includes(String(o.id)) &&
                  r.active_operation_id !== o.id
                ))),
        )
      )
        throw Error("DEV_CONTROL_UNSETTLED_OPERATION_RETAINED");
      const [boots] = await c.query<RowDataPacket[]>(
        "SELECT boot_id bootId,exited_at exitedAt FROM admin_runtime_observations",
      );
      if (boots.some((b) => !b.exitedAt))
        throw Error("DEV_CONTROL_LIVE_RUNTIME_RETAINED");
      // Unknown inactive observations are historical evidence. Preserve them;
      // only explicitly captured fixture boot IDs may be deleted below.
      const [owned] = await c.query<RowDataPacket[]>(
        "SELECT name FROM families WHERE id=?",
        [this.actor.familyId],
      );
      if (owned[0]?.name !== this.name)
        throw Error("DEV_CONTROL_FIXTURE_IDENTITY_CHANGED");
      const [changed] = await c.execute<ResultSetHeader>(
        "UPDATE system_control SET current_run_id=NULL,deployment_id=?,namespace_identity=NULL,requested_mode='READ_ONLY',enforced_mode='READ_ONLY',transition_state='RECOVERY_REQUIRED',revision=1,health_generation=1,fault_latched=1,reason_code='NOT_INITIALIZED',active_operation_id=NULL,updated_at=? WHERE id=1 AND revision=?",
        [
          this.initial.deployment_id,
          this.initial.updated_at,
          String(r.revision),
        ],
      );
      if (changed.affectedRows !== 1)
        throw Error("DEV_CONTROL_BASELINE_CAS_FAILED");
      // Append-only audit history is retained, including this synthetic fixture.
      for (const id of this.operations)
        if (!retiredControl.operations.has(id))
          await c.query("DELETE FROM system_control_operations WHERE id=?", [
            id,
          ]);
      // Run members reference boot history; preserve all observations and monotone epochs.
      await c.query(
        "DELETE FROM system_admin_grants WHERE family_id=? AND member_id=? AND user_id=?",
        [this.actor.familyId, this.memberId, this.actor.userId],
      );
      await c.query("DELETE FROM sessions WHERE user_id=?", [
        this.actor.userId,
      ]);
      await c.query("DELETE FROM family_members WHERE family_id=? AND id=?", [
        this.actor.familyId,
        this.memberId,
      ]);
      await c.query("DELETE FROM users WHERE id=? AND username=?", [
        this.actor.userId,
        this.name,
      ]);
      await c.query("DELETE FROM families WHERE id=? AND name=?", [
        this.actor.familyId,
        this.name,
      ]);
    });
    rmSync(this.container, { recursive: true, force: true });
  }
}
