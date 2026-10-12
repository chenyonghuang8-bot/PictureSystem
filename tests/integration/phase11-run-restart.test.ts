import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect } from "vitest";
import {
  createDatabase,
  MySqlSystemRunRepository,
  type RowDataPacket,
  type RunLease,
  type RunRole,
} from "../../packages/db/src/index.js";
import { DeploymentAdmission } from "../../packages/storage/src/index.js";
import { InProcessControlOwner } from "../helpers/in-process-control-owner.js";
import { restartBuiltControlApi } from "../helpers/restart-built-control-api.js";
if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");
describe.sequential("R1 real built API clean restart", () => {
  it.each(["NORMAL", "READ_ONLY", "MAINTENANCE"] as const)(
    "consumes CLEAN once and automatically preserves %s on a new built API",
    async (mode) => {
      const db = createDatabase(process.env.DATABASE_URL!);
      let owner: InProcessControlOwner | undefined,
        api: Awaited<ReturnType<typeof restartBuiltControlApi>> | undefined,
        albumId: string | undefined;
      try {
        owner = await InProcessControlOwner.start(db.pool, []);
        if (mode !== "NORMAL") await owner.fixture.request(mode);
        const runs = new MySqlSystemRunRepository(db.pool),
          before = await runs.observeCurrent();
        expect(before?.phase).toBe("ACTIVE");
        const [oldMembers] = await db.pool.query<RowDataPacket[]>(
          "SELECT role,boot_id FROM system_control_run_members WHERE run_id=? ORDER BY role",
          [before!.id],
        );
        const oldLease: RunLease = {
          id: String(before!.id),
          epoch: String(before!.epoch),
          automatic: Boolean(before!.automatic),
          process: {
            processId: String(before!.coordinator_process_id),
            osBootId: String(before!.coordinator_os_boot_id),
            pid: Number(before!.coordinator_pid),
            startSec: String(before!.coordinator_start_sec),
            startUsec: Number(before!.coordinator_start_usec),
          },
          members: oldMembers.map((m) => ({
            role: m.role as RunRole,
            bootId: String(m.boot_id),
          })),
          configuration: {
            deploymentId: String(before!.deployment_id),
            namespaceIdentity: Buffer.from(before!.namespace_identity).toString(
              "hex",
            ),
            runNamespaceIdentity: Buffer.from(
              before!.run_namespace_identity,
            ).toString("hex"),
            configDigest: Buffer.from(before!.config_digest).toString("hex"),
            expectedRoles: String(before!.expected_roles).split(
              ",",
            ) as RunRole[],
            ownerRole: before!.owner_role,
          },
        };
        const media = await owner.withResources(async (r) => {
          if (r.capability.state === "UNAVAILABLE")
            throw Error("FIXTURE_ROOT_REQUIRED");
          return {
            path: r.capability.root.canonicalPath,
            marker: r.capability.root.markerId,
          };
        });
        // The coordinator can activate between the participant's phase read
        // and READY transaction; exact ACTIVE/READY is a read-only no-op.
        await expect(runs.ready(oldLease)).resolves.toBeUndefined();
        await owner.releaseForApiRestart();
        expect((await runs.observeCurrent())?.phase).toBe("CLEAN");
        api = await restartBuiltControlApi(owner.fixture, media);
        const deadline = Date.now() + 12000;
        while ((await runs.observeCurrent())?.phase !== "ACTIVE") {
          if (Date.now() > deadline) throw Error("AUTOMATIC_RUN_NOT_ACTIVE");
          await delay(100);
        }
        const after = await runs.observeCurrent();
        await expect(runs.ready(oldLease)).rejects.toThrow(
          "CONTROL_UNAVAILABLE",
        );
        expect(after?.id).not.toBe(before?.id);
        expect(String(after?.epoch)).toBe(
          String(BigInt(String(before?.epoch)) + 1n),
        );
        expect(after?.predecessor_id).toBe(before?.id);
        const [previous] = await db.pool.query<RowDataPacket[]>(
          "SELECT phase FROM system_control_runs WHERE id=?",
          [before?.id],
        );
        expect(previous[0]?.phase).toBe("CONSUMED");
        expect(owner.fixture.gate.verifyRunOwner(oldLease.process)).toBe(false);
        let oldUnitStarted = false;
        const oldAdmission = new DeploymentAdmission(owner.fixture.gate, () =>
          runs.readAdmission(oldLease),
        );
        await expect(
          oldAdmission.run("MEDIA_WRITE", async () => {
            oldUnitStarted = true;
          }),
        ).rejects.toThrow("WRITE_PAUSED");
        expect(oldUnitStarted).toBe(false);
        expect(
          await owner.fixture.repository.runtimeBeat(
            "API",
            oldLease.members[0]!.bootId,
            {
              revision: (await owner.fixture.repository.readCurrent()).revision,
              state: "RUNNING",
              reasonCode: "NONE",
              success: false,
              completedUnits: "0",
            },
          ),
        ).toBe(false);
        expect(
          (await owner.fixture.repository.readCurrent()).enforcedMode,
        ).toBe(mode);
        const login = await fetch(api.base + "/api/v1/auth/android/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: owner.fixture.syntheticIdentity.username,
            password: "synthetic-in-process-control-password",
          }),
        });
        expect(login.status).toBe(200);
        const token = (await login.json()).token;
        const response = await fetch(api.base + "/api/v1/albums", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            familyId: owner.fixture.syntheticIdentity.familyId,
            name: "synthetic-clean-run-restart",
            visibility: "FAMILY",
          }),
        });
        expect(response.status).toBe(mode === "NORMAL" ? 201 : 503);
        if (response.status === 201) albumId = (await response.json()).id;
      } finally {
        if (api && owner) {
          await owner.fixture.request("READ_ONLY");
          await api.stop();
        }
        if (albumId && owner)
          await db.pool.query(
            "DELETE FROM albums WHERE id=? AND family_id=? AND name=?",
            [
              albumId,
              owner.fixture.syntheticIdentity.familyId,
              "synthetic-clean-run-restart",
            ],
          );
        if (owner) {
          if (owner.owner.resources.isAvailable())
            await owner.close({ recheck: true });
          else await owner.cleanupReleasedOwner();
        }
        await db.pool.end();
      }
    },
    60000,
  );
});
