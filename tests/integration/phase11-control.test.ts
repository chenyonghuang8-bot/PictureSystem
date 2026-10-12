import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { verifyRetiredControlFixtures } from "../helpers/retired-control-fixtures.js";
import {
  createDatabase,
  acquireCheckedConnection,
  runCheckedTransaction,
  assertMigrationReadiness,
  MySqlSystemControlRepository,
  MySqlSystemRunRepository,
  type RunLease,
  MySqlUploadRepository,
  MySqlAuthRepository,
  MySqlAdminReadRepository,
  type ResultSetHeader,
  type RowDataPacket,
  type SystemRequestActor,
  type Pool,
} from "../../packages/db/src/index.js";
import {
  createSessionToken,
  hashSessionToken,
  hashPassword,
} from "../../packages/auth/src/index.js";
import {
  StorageRoot,
  CapacityGate,
  DerivedStore,
  OriginalReader,
  OperationGate,
  DeploymentAdmission,
  ControlCoordinator,
  type OperationLock,
} from "../../packages/storage/src/index.js";
import { StorageRuntimeOwner } from "../../apps/worker/src/storage-runtime-owner.js";
import { assessStorageStartup } from "../../apps/api/src/uploads/startup.js";
import { UploadMutex } from "../../apps/api/src/uploads/mutex.js";
import { createApp } from "../../apps/api/src/app.js";
import { AuthService } from "../../apps/api/src/auth/service.js";
import { verifyRetainedAuditFixtures } from "../helpers/retained-audit-fixtures.js";
import { assertNoPhase11DevInstances } from "../../packages/db/scripts/phase11-instance-proof.js";

if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");
describe.sequential(
  "Phase11 real MySQL/native owner control transitions",
  () => {
    const db = createDatabase(process.env.DATABASE_URL!),
      repository = new MySqlSystemControlRepository(db.pool),
      runs = new MySqlSystemRunRepository(db.pool),
      suffix = randomUUID().replaceAll("-", ""),
      deploymentId = randomUUID(),
      bootstrapId = randomUUID(),
      bootId = randomUUID();
    const webToken = createSessionToken(),
      nativeToken = createSessionToken(),
      origin = "https://localhost:3000";
    const operationIds: string[] = [bootstrapId],
      auditIds: string[] = [];
    const knownRejected = new Set<string>();
    let container = "",
      familyId = "",
      userId = "",
      memberId = "",
      actor: SystemRequestActor,
      owner: StorageRuntimeOwner | undefined,
      admission: DeploymentAdmission,
      gate: OperationGate,
      coordinator:
        | ControlCoordinator<
            NonNullable<Awaited<ReturnType<typeof repository.pending>>>
          >
        | undefined,
      identity = "",
      initial: RowDataPacket | undefined,
      baselineAuditId = "0",
      cleanupSafe = false;
    let runLease: RunLease | undefined, runLock: OperationLock | undefined;
    let app: ReturnType<typeof createApp> | undefined,
      base = "";
    async function query<T extends RowDataPacket[] | ResultSetHeader>(
      sql: string,
      values: unknown[] = [],
    ) {
      const c = await acquireCheckedConnection(db.pool);
      try {
        return await c.query<T>(sql, values);
      } finally {
        c.release();
      }
    }
    async function insert(sql: string, values: unknown[]) {
      const [r] = await query<ResultSetHeader>(sql, values);
      return String(r.insertId);
    }
    function loseOneCommitResponse() {
      let commits = 0,
        destroys = 0;
      const pool = new Proxy(db.pool, {
        get(target, key) {
          if (key === "getConnection")
            return async () => {
              const c = await target.getConnection();
              return new Proxy(c, {
                get(connection, property) {
                  if (property === "commit")
                    return async () => {
                      await connection.commit();
                      commits++;
                      if (commits === 1)
                        throw Error("SYNTHETIC_COMMIT_REPLY_LOST");
                    };
                  if (property === "destroy")
                    return () => {
                      destroys++;
                      connection.destroy();
                    };
                  const value = Reflect.get(connection, property);
                  return typeof value === "function"
                    ? value.bind(connection)
                    : value;
                },
              });
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Pool;
      return {
        repository: new MySqlSystemControlRepository(pool),
        counts: () => ({ commits, destroys }),
      };
    }
    async function heartbeat() {
      const current = await repository.readCurrent();
      if (runLease && (await runs.phase(runLease)) === "RECOVERY_REQUIRED")
        await runs.ready(runLease);
      await repository.runtimeBeat("API", bootId, {
        revision: current.revision,
        state: "PAUSED",
        reasonCode: "PAUSED",
        success: false,
        completedUnits: "0",
      });
    }
    async function mode(targetMode: "NORMAL" | "READ_ONLY" | "MAINTENANCE") {
      const operationId = randomUUID();
      operationIds.push(operationId);
      return repository.requestMode(actor, {
        operationId,
        expectedRevision: (await repository.readCurrent()).revision,
        targetMode,
        reasonCode:
          targetMode === "NORMAL"
            ? "MANUAL_RESUME"
            : targetMode === "READ_ONLY"
              ? "MANUAL_READ_ONLY"
              : "MANUAL_MAINTENANCE",
      });
    }
    async function recordLatch() {
      const current = await repository.readCurrent();
      const [events] = await query<RowDataPacket[]>(
        "SELECT operation_id operationId FROM admin_audit_events WHERE scope='SYSTEM' AND action='HEALTH_LATCHED' AND revision=? AND id>?",
        [current.revision, baselineAuditId],
      );
      expect(events).toHaveLength(1);
      auditIds.push(String(events[0]!.operationId));
    }
    async function recheck() {
      const operationId = randomUUID();
      operationIds.push(operationId);
      await repository.requestRecheck(actor, {
        operationId,
        expectedRevision: (await repository.readCurrent()).revision,
      });
      await heartbeat();
      await coordinator!.tick();
      expect((await repository.operation(actor, operationId)).status).toBe(
        "APPLIED",
      );
      return operationId;
    }
    beforeAll(async () => {
      const c = await acquireCheckedConnection(db.pool);
      try {
        const [who] = await c.query<RowDataPacket[]>(
          "SELECT DATABASE() db,CURRENT_USER() account",
        );
        expect(who[0]!.db).toBe("family_album_dev");
        expect(String(who[0]!.account).split("@")[0]).not.toBe("root");
        await assertMigrationReadiness(c);
        await assertNoPhase11DevInstances(c, process.cwd());
        const retained = await verifyRetainedAuditFixtures(c);
        const [families] = await c.query<RowDataPacket[]>(
          "SELECT CAST(id AS CHAR) id FROM families",
        );
        expect(families.every((f) => retained.has(String(f.id)))).toBe(true);
        const [rows] = await c.query<RowDataPacket[]>(
          "SELECT * FROM system_control WHERE id=1",
        );
        initial = rows[0];
        const [auditBoundary] = await c.query<RowDataPacket[]>(
          "SELECT CAST(COALESCE(MAX(id),0) AS CHAR) id FROM admin_audit_events",
        );
        baselineAuditId = String(auditBoundary[0]!.id);
        expect(initial).toMatchObject({
          deployment_id: "00000000-0000-0000-0000-000000000000",
          namespace_identity: null,
          reason_code: "NOT_INITIALIZED",
          enforced_mode: "READ_ONLY",
        });
        expect(String(initial!.revision)).toBe("1");
        const [global] = await c.query<RowDataPacket[]>(
          "SELECT (SELECT COUNT(*) FROM media_items) media,(SELECT COUNT(*) FROM upload_sessions) uploads,(SELECT COUNT(*) FROM background_jobs) jobs,(SELECT COUNT(*) FROM purge_intents WHERE progress<>'COMPLETED' OR execution_state<>'DONE') purges,(SELECT COUNT(*) FROM admin_runtime_observations WHERE exited_at IS NULL) runtimes,(SELECT COUNT(*) FROM system_control_operations) operations",
        );
        const retiredControl = await verifyRetiredControlFixtures(c);
        expect(String(global[0]!.operations)).toBe(
          String(retiredControl.operations.size),
        );
        expect(
          Object.entries(global[0]!)
            .filter(([key]) => key !== "operations")
            .every(([, v]) => String(v) === "0"),
        ).toBe(true);
      } finally {
        c.release();
      }
      container = mkdtempSync(
        join(realpathSync(tmpdir()), "phase11-control-mysql-"),
      );
      const namespace = { path: join(container, "control"), deploymentId };
      mkdirSync(namespace.path, { mode: 0o700 });
      gate = OperationGate.provisionDev(namespace);
      runLock = await gate.acquireRun();
      runLock.registerRunOwner(randomUUID());
      const s = await gate.acquire("S", 0);
      identity = s.identity();
      s.close();
      const mediaRoot = join(container, "r"),
        root = StorageRoot.open(mediaRoot, { initialize: true });
      mkdirSync(join(mediaRoot, "derived"), { mode: 0o700 });
      root.provisionDerivedWriterLockForDev();
      root.provisionSharedCapacityLockForDev();
      const capacity = CapacityGate.open({
          mediaRoot,
          expectedMarkerId: root.markerId,
        }),
        store = DerivedStore.open({ state: "READ_WRITE", root }),
        reader = OriginalReader.open({
          mediaRoot,
          expectedMarkerId: root.markerId,
        });
      admission = new DeploymentAdmission(
        gate,
        () => runs.readAdmission(runLease),
        {
          beforeMediaWrite: async () => {
            await owner!.health();
          },
        },
      );
      owner = new StorageRuntimeOwner(
        {
          capability: { state: "READ_WRITE", root },
          gate: capacity,
          store,
          reader,
        },
        db.pool,
        repository,
        { mediaRoot, markerId: root.markerId, roles: ["API"] },
        async (permit, resources) =>
          permit.run("STARTUP_ASSESS", async () => {
            const assessment = await assessStorageStartup(
              new MySqlUploadRepository(db.pool),
              resources.capability,
              new UploadMutex(),
            );
            if (assessment.capability.state !== "READ_WRITE")
              throw Error("STARTUP_ASSESS_FAILED");
            return true;
          }),
      );
      coordinator = new ControlCoordinator<
        NonNullable<Awaited<ReturnType<typeof repository.pending>>>
      >(
        gate,
        admission,
        {
          pending: () => repository.pending(),
          latch: (reason, id) => repository.latch(reason, id),
          complete: (pending, proof) =>
            repository.complete(
              pending,
              proof ? { ...proof, ...(runLease ? { runLease } : {}) } : null,
            ),
        },
        owner,
      );
      const passwordHash = await hashPassword(
          "synthetic-phase11-control-password",
        ),
        tokenHash = hashSessionToken(webToken);
      familyId = await insert("INSERT INTO families(name) VALUES(?)", [
        `phase11_control_${suffix}`,
      ]);
      userId = await insert(
        "INSERT INTO users(username,username_normalized,password_hash,password_changed_at) VALUES(?,?,?,CURRENT_TIMESTAMP(3))",
        [
          `phase11_control_${suffix}`,
          Buffer.from(`phase11_control_${suffix}`),
          passwordHash,
        ],
      );
      memberId = await insert(
        "INSERT INTO family_members(family_id,user_id,role) VALUES(?,?,'SUPER_ADMIN')",
        [familyId, userId],
      );
      const sessionId = await insert(
        "INSERT INTO sessions(user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at) VALUES(?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY))",
        [userId, tokenHash],
      );
      actor = {
        familyId,
        userId,
        sessionId,
        tokenHash,
        expectedClientType: "WEB",
      };
      await insert(
        "INSERT INTO sessions(user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at) VALUES(?,?,'ANDROID',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY))",
        [userId, hashSessionToken(nativeToken)],
      );
      const grantOp = randomUUID();
      auditIds.push(grantOp);
      await repository.localGrant({
        familyId,
        userId,
        enabled: true,
        operationId: grantOp,
      });
      app = createApp({
        authService: await AuthService.create(new MySqlAuthRepository(db.pool)),
        trustedOrigins: new Set([origin]),
        controlAdmission: admission,
        admin: {
          control: repository,
          reads: new MySqlAdminReadRepository(db.pool),
          localDeny: () => admission.isLocallyDenied(),
          configuredRoles: ["API"],
          observeStorage: (now) => owner!.observe(now),
        },
      });
      base = await app.listen({ host: "127.0.0.1", port: 0 });
    }, 20000);
    afterAll(async () => {
      try {
        if (runLease) {
          admission.revoke();
          await runs.stopping(runLease, randomUUID());
        }
        await app?.close();
        coordinator?.stop();
        await coordinator?.drain();
        if (runLease) {
          await repository.runtimeBeat("API", bootId, {
            revision: (await repository.readCurrent()).revision,
            state: "STOPPED",
            reasonCode: "STOPPED",
            success: false,
            completedUnits: "0",
          });
          await owner?.resources.close();
          await runs.acknowledge(runLease, randomUUID());
          const x = await gate.acquire("X", 0);
          try {
            if (x.readDeny() !== null || !(await runs.clean(runLease)))
              throw Error("FIXTURE_CLEAN_UNCONFIRMED");
          } finally {
            x.close();
          }
        }
        if (initial && identity) {
          // Trusted synthetic fixture restoration, never a recovery/NORMAL bypass.
          // Only a known STABLE commit in our exact namespace may restore the
          // original protected NOT_INITIALIZED baseline; unknown outcomes retain it.
          await runCheckedTransaction(db.pool, async (c) => {
            const [rows] = await c.query<RowDataPacket[]>(
                "SELECT * FROM system_control WHERE id=1 FOR UPDATE",
              ),
              r = rows[0]!;
            if (
              r.deployment_id !== deploymentId ||
              !Buffer.isBuffer(r.namespace_identity) ||
              r.namespace_identity.toString("hex") !== identity ||
              r.transition_state !== "STABLE" ||
              r.enforced_mode !== "READ_ONLY" ||
              r.fault_latched
            )
              throw Error("PHASE11_FIXTURE_RESTORATION_NOT_PROVEN");
            const [ops] = await c.query<RowDataPacket[]>(
              "SELECT id,status FROM system_control_operations",
            );
            const retiredControl = await verifyRetiredControlFixtures(c);
            if (
              ops.some(
                (o) =>
                  !retiredControl.operations.has(String(o.id)) &&
                  (!operationIds.includes(String(o.id)) ||
                    (o.status !== "APPLIED" &&
                      !(
                        o.status === "RECOVERY_REQUIRED" &&
                        knownRejected.has(String(o.id))
                      ))),
              )
            )
              throw Error("PHASE11_UNSETTLED_OPERATION_RETAINED");
            const [changed] = await c.execute<ResultSetHeader>(
              "UPDATE system_control SET current_run_id=NULL,deployment_id=?,namespace_identity=NULL,requested_mode='READ_ONLY',enforced_mode='READ_ONLY',transition_state='RECOVERY_REQUIRED',revision=1,health_generation=1,fault_latched=1,reason_code='NOT_INITIALIZED',active_operation_id=NULL,updated_at=? WHERE id=1 AND revision=?",
              [initial!.deployment_id, initial!.updated_at, String(r.revision)],
            );
            expect(changed.affectedRows).toBe(1);
            // Append-only audits and runtime/run/member evidence are preserved.
            for (const id of operationIds)
              await c.query(
                "DELETE FROM system_control_operations WHERE id=?",
                [id],
              );
            await c.query(
              "DELETE FROM system_admin_grants WHERE family_id=? AND user_id=? AND member_id=?",
              [familyId, userId, memberId],
            );
            await c.query("DELETE FROM sessions WHERE user_id=?", [userId]);
            await c.query(
              "DELETE FROM family_members WHERE family_id=? AND id=?",
              [familyId, memberId],
            );
            await c.query("DELETE FROM users WHERE id=? AND username=?", [
              userId,
              `phase11_control_${suffix}`,
            ]);
            await c.query("DELETE FROM families WHERE id=? AND name=?", [
              familyId,
              `phase11_control_${suffix}`,
            ]);
          });
          cleanupSafe = true;
        }
      } finally {
        await owner?.resources.close();
        runLock?.close();
        await db.pool.end();
        if (cleanupSafe && container)
          rmSync(container, { recursive: true, force: true });
      }
    }, 20000);
    it("bootstrap remains protected until fresh participant and real owner recovery complete", async () => {
      expect(
        (
          await repository.bootstrap({
            operationId: bootstrapId,
            deploymentId,
            namespaceIdentity: identity,
          })
        ).status,
      ).toBe("PENDING");
      const x = await gate.acquire("X", 0);
      try {
        runLease = await runs.begin(
          {
            deploymentId,
            namespaceIdentity: identity,
            runNamespaceIdentity: gate.runIdentity(),
            configDigest: createHash("sha256")
              .update("phase11-control-owned-unit")
              .digest("hex"),
            expectedRoles: ["API"],
            ownerRole: "API",
          },
          runLock!.registerRunOwner(randomUUID()),
          [{ role: "API", bootId }],
          x.readDeny() === null,
        );
      } finally {
        x.close();
      }
      await coordinator!.tick();
      expect((await repository.readCurrent()).transitionState).toBe("RESUMING");
      await heartbeat();
      await coordinator!.tick();
      expect(await repository.readCurrent()).toMatchObject({
        enforcedMode: "READ_ONLY",
        transitionState: "STABLE",
        faultLatched: false,
      });
      expect(owner!.resources.generation()).toBe("2");
      await expect(
        admission.run("MEDIA_WRITE", async () => {}),
      ).rejects.toThrow("WRITE_PAUSED");
    });
    it("resume rechecks stored current authorization and fresh native generation before NORMAL", async () => {
      const pending = await mode("NORMAL");
      expect(pending.status).toBe("PENDING");
      await heartbeat();
      await coordinator!.tick();
      expect(
        (await repository.operation(actor, pending.operationId)).status,
      ).toBe("APPLIED");
      expect(owner!.resources.generation()).toBe("3");
      expect(await admission.run("MEDIA_WRITE", async () => "settled")).toBe(
        "settled",
      );
      await expect(
        repository.requestMode(
          { ...actor, expectedClientType: "ANDROID" },
          {
            operationId: randomUUID(),
            expectedRevision: (await repository.readCurrent()).revision,
            targetMode: "READ_ONLY",
            reasonCode: "MANUAL_READ_ONLY",
          },
        ),
      ).rejects.toMatchObject({ reason: "UNAUTHENTICATED" });
    });
    it("a committed restriction stops new units while X waits for the entire admitted callback", async () => {
      let release!: () => void, entered!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const unit = admission.run("MEDIA_WRITE", async () => {
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
      });
      await started;
      const pending = await mode("READ_ONLY");
      const round = coordinator!.tick();
      try {
        await new Promise((r) => setTimeout(r, 25));
        expect(
          (await repository.operation(actor, pending.operationId)).status,
        ).toBe("PENDING");
        expect((await repository.readCurrent()).transitionState).toBe(
          "DRAINING",
        );
        await expect(
          admission.run("MEDIA_WRITE", async () => {}),
        ).rejects.toThrow("WRITE_PAUSED");
      } finally {
        release();
        await unit;
        await round;
      }
      expect(
        (await repository.operation(actor, pending.operationId)).status,
      ).toBe("APPLIED");
    });
    it("immutable operation replay observes its receipt and rejects a conflicting fingerprint", async () => {
      const operationId = randomUUID();
      operationIds.push(operationId);
      const body = {
        operationId,
        expectedRevision: (await repository.readCurrent()).revision,
        targetMode: "MAINTENANCE" as const,
        reasonCode: "MANUAL_MAINTENANCE" as const,
      };
      await repository.requestMode(actor, body);
      await coordinator!.tick();
      expect((await repository.requestMode(actor, body)).status).toBe(
        "APPLIED",
      );
      await expect(
        repository.requestMode(actor, {
          ...body,
          targetMode: "READ_ONLY",
          reasonCode: "MANUAL_READ_ONLY",
        }),
      ).rejects.toMatchObject({ reason: "CONFLICT" });
      await expect(
        admission.run("INVITATION_CREATE", async () => {}),
      ).rejects.toThrow("WRITE_PAUSED");
      expect(await admission.run("MEMBER_REVOKE", async () => true)).toBe(true);
      expect(await admission.run("INVITATION_REVOKE", async () => true)).toBe(
        true,
      );
      await mode("READ_ONLY");
      await heartbeat();
      await coordinator!.tick();
      expect((await repository.readCurrent()).enforcedMode).toBe("READ_ONLY");
    });
    it("a grant revoked after requesting resume blocks completion and requires a new authorized RECHECK", async () => {
      const requested = await mode("NORMAL");
      const revoked = randomUUID();
      auditIds.push(revoked);
      await repository.localGrant({
        familyId,
        userId,
        enabled: false,
        operationId: revoked,
      });
      await heartbeat();
      await expect(coordinator!.tick()).rejects.toMatchObject({
        reason: "FORBIDDEN",
      });
      expect(await repository.readCurrent()).toMatchObject({
        enforcedMode: "READ_ONLY",
        faultLatched: true,
        transitionState: "RECOVERY_REQUIRED",
      });
      const [ops] = await query<RowDataPacket[]>(
        "SELECT status FROM system_control_operations WHERE id=?",
        [requested.operationId],
      );
      expect(ops[0]!.status).toBe("RECOVERY_REQUIRED");
      knownRejected.add(requested.operationId);
      await recordLatch();
      const enabled = randomUUID();
      auditIds.push(enabled);
      await repository.localGrant({
        familyId,
        userId,
        enabled: true,
        operationId: enabled,
      });
      await recheck();
      expect(await repository.readCurrent()).toMatchObject({
        enforcedMode: "READ_ONLY",
        faultLatched: false,
        transitionState: "STABLE",
      });
      const s = await gate.acquire("S", 0);
      try {
        expect(s.readDeny()).toBeNull();
      } finally {
        s.close();
      }
    });
    it("a durable health latch prevents direct NORMAL and only a fresh fenced RECHECK can clear protection", async () => {
      await coordinator!.trip("STORAGE_UNAVAILABLE");
      await recordLatch();
      expect(await repository.readCurrent()).toMatchObject({
        faultLatched: true,
        enforcedMode: "READ_ONLY",
        reasonCode: "STORAGE_UNAVAILABLE",
      });
      await expect(mode("NORMAL")).rejects.toMatchObject({
        reason: "CONFLICT",
      });
      // The rejected request inserted no receipt, so it is not an owned row.
      operationIds.pop();
      const s = await gate.acquire("S", 0);
      try {
        expect(s.readDeny()?.reasonCode).toBe("STORAGE_UNAVAILABLE");
      } finally {
        s.close();
      }
      await expect(
        admission.run("MEDIA_WRITE", async () => {}),
      ).rejects.toThrow("WRITE_PAUSED");
      await recheck();
      expect((await repository.readCurrent()).faultLatched).toBe(false);
      await expect(
        admission.run("MEDIA_WRITE", async () => {}),
      ).rejects.toThrow("WRITE_PAUSED");
    });
    it("a lost request COMMIT response is observed by immutable operation ID without replaying the write", async () => {
      const fault = loseOneCommitResponse(),
        operationId = randomUUID();
      operationIds.push(operationId);
      await expect(
        fault.repository.requestMode(actor, {
          operationId,
          expectedRevision: (await repository.readCurrent()).revision,
          targetMode: "READ_ONLY",
          reasonCode: "MANUAL_READ_ONLY",
        }),
      ).rejects.toMatchObject({ reason: "COMMIT_UNKNOWN" });
      expect(fault.counts()).toEqual({ commits: 1, destroys: 1 });
      expect((await repository.operation(actor, operationId)).status).toBe(
        "PENDING",
      );
      await coordinator!.tick();
      expect((await repository.operation(actor, operationId)).status).toBe(
        "APPLIED",
      );
      const [events] = await query<RowDataPacket[]>(
        "SELECT action,COUNT(*) n FROM admin_audit_events WHERE operation_id=? GROUP BY action",
        [operationId],
      );
      expect(events.map((r) => [r.action, String(r.n)]).sort()).toEqual([
        ["CONTROL_APPLIED", "1"],
        ["CONTROL_REQUESTED", "1"],
      ]);
      expect(fault.counts().commits).toBe(1);
    });
    it("a lost completion COMMIT response retains the native deny and requires a separate observed RECHECK", async () => {
      const requested = await mode("NORMAL"),
        fault = loseOneCommitResponse();
      await heartbeat();
      const unknown = new ControlCoordinator<
        NonNullable<Awaited<ReturnType<typeof repository.pending>>>
      >(
        gate,
        admission,
        {
          pending: () => repository.pending(),
          complete: (pending, proof) =>
            fault.repository.complete(
              pending,
              proof ? { ...proof, ...(runLease ? { runLease } : {}) } : null,
            ),
          latch: (reason, id) => repository.latch(reason, id),
        },
        owner!,
      );
      try {
        await expect(unknown.tick()).rejects.toMatchObject({
          errorCategory: "COMMIT_OUTCOME_UNKNOWN",
        });
      } finally {
        unknown.stop();
        await unknown.drain();
      }
      expect(fault.counts()).toEqual({ commits: 1, destroys: 1 });
      expect(
        (await repository.operation(actor, requested.operationId)).status,
      ).toBe("APPLIED");
      expect(await repository.readCurrent()).toMatchObject({
        enforcedMode: "READ_ONLY",
        faultLatched: true,
        transitionState: "RECOVERY_REQUIRED",
      });
      const s = await gate.acquire("S", 0);
      try {
        expect(s.readDeny()).not.toBeNull();
      } finally {
        s.close();
      }
      await recordLatch();
      await recheck();
      expect((await repository.readCurrent()).faultLatched).toBe(false);
      expect(fault.counts().commits).toBe(1);
    });
    it("serves real Web/Native HTTP observations and mode receipts with unchanged client-type and Origin guards", async () => {
      const web = { cookie: `__Host-family_session=${webToken}` },
        native = { authorization: `Bearer ${nativeToken}` };
      async function request(
        path: string,
        headers: Record<string, string>,
        body?: unknown,
      ) {
        return fetch(base + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...headers,
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(5000),
        });
      }
      for (const headers of [web, native]) {
        const status = await request("/api/v1/admin/system/status", headers);
        expect(status.status).toBe(200);
        const data = await status.json();
        expect(data.enforcedMode).toBe("READ_ONLY");
        expect(data.observations.storage.state).toBe("HEALTHY");
        expect(status.headers.get("cache-control")).toBe("private, no-store");
        const overview = await request(
          `/api/v1/families/${familyId}/admin/overview`,
          headers,
        );
        expect(overview.status).toBe(200);
        expect((await overview.json()).videos).toBe("0");
      }
      expect(
        (await request("/api/v1/admin/system/status", { ...web, ...native }))
          .status,
      ).toBe(401);
      expect(
        (
          await request("/api/v1/admin/system/status", {
            authorization: `Bearer ${webToken}`,
          })
        ).status,
      ).toBe(401);
      const operationId = randomUUID(),
        body = {
          operationId,
          expectedRevision: (await repository.readCurrent()).revision,
          targetMode: "READ_ONLY",
          reasonCode: "MANUAL_READ_ONLY",
        };
      expect(
        (await request("/api/v1/admin/system/mode", web, body)).status,
      ).toBe(403);
      expect(
        (
          await request(
            "/api/v1/admin/system/mode",
            { ...web, origin: "https://untrusted.invalid" },
            body,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            "/api/v1/admin/system/mode",
            { ...native, origin },
            body,
          )
        ).status,
      ).toBe(401);
      const [before] = await query<RowDataPacket[]>(
        "SELECT id FROM system_control_operations WHERE id=?",
        [operationId],
      );
      expect(before).toHaveLength(0);
      const accepted = await request("/api/v1/admin/system/mode", native, body);
      expect(accepted.status).toBe(202);
      operationIds.push(operationId);
      expect((await accepted.json()).operationId).toBe(operationId);
      await coordinator!.tick();
      expect(
        (
          await (
            await request(
              `/api/v1/admin/system/operations/${operationId}`,
              native,
            )
          ).json()
        ).status,
      ).toBe("APPLIED");
    });
  },
);
