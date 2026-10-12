import { restartBuiltControlApi } from "../helpers/restart-built-control-api.js";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createDatabase,
  acquireCheckedConnection,
  assertMigrationReadiness,
  MySqlSystemRunRepository,
} from "../../packages/db/src/index.js";
import { ControlAdmissionError } from "../../packages/storage/src/index.js";
import { InProcessControlOwner } from "../helpers/in-process-control-owner.js";
import { NativeControlFaultGate } from "../helpers/native-control-fault-gate.js";

if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");
describe.sequential(
  "Phase11 native control-marker durability and real SQL RECHECK",
  () => {
    const db = createDatabase(process.env.DATABASE_URL!);
    let owner: InProcessControlOwner | undefined;
    let api: Awaited<ReturnType<typeof restartBuiltControlApi>> | undefined;
    const evidence: Record<string, unknown>[] = [];
    beforeAll(async () => {
      const c = await acquireCheckedConnection(db.pool);
      try {
        await assertMigrationReadiness(c);
      } finally {
        c.release();
      }
    });
    afterAll(async () => {
      NativeControlFaultGate.fault("NONE");
      try {
        if (api && owner) {
          const current = await owner.fixture.repository.readCurrent();
          if (current.faultLatched) await owner.fixture.recheck();
          await owner.fixture.request("READ_ONLY");
          await api.stop();
          api = undefined;
        }
        if (owner) {
          if (owner.owner.resources.isAvailable())
            await owner.close({ recheck: true });
          else await owner.cleanupReleasedOwner();
        }
      } finally {
        await api?.stop();
        await db.pool.end();
      }
      writeFileSync(
        ".cache/phase11-current/marker-durability-proof.json",
        JSON.stringify(
          { recordedAt: new Date().toISOString(), evidence },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }, 30_000);
    it("does not export fault controls from the production addon", () => {
      const production = createRequire(import.meta.url)(
        "../../packages/storage/build/storage_native.node",
      ) as Record<string, unknown>;
      expect(production.phase11TestDenyFault).toBeUndefined();
    });
    for (const boundary of [
      "FILE_FSYNC",
      "LATCH_DIR_FSYNC",
      "CLEAR_DIR_FSYNC",
    ] as const)
      it(`${boundary}: uncertain durability denies real HTTP writes across built API restart until fresh owner RECHECK`, async () => {
        owner = await InProcessControlOwner.start(
          db.pool,
          [],
          undefined,
          {},
          undefined,
          (gate) => new NativeControlFaultGate(gate.namespace),
        );
        if (boundary === "CLEAR_DIR_FSYNC") {
          await owner.trip("STORAGE_UNAVAILABLE");
          const before = (await owner.fixture.repository.readCurrent())
            .healthGeneration;
          NativeControlFaultGate.fault(boundary);
          // The clear syscall fails after a known DB completion; the coordinator
          // must recreate deny and latch protection before releasing DRAINED_X.
          await owner.fixture.beginRecheck();
          const deadline = Date.now() + 10_000;
          while (true) {
            const state = await owner.fixture.repository.readCurrent();
            if (
              state.faultLatched &&
              BigInt(state.healthGeneration) > BigInt(before)
            )
              break;
            if (Date.now() >= deadline)
              throw Error("CLEAR_FAILURE_PROTECTION_NOT_LATCHED");
            await delay(20);
          }
        } else {
          NativeControlFaultGate.fault(boundary);
          await expect(owner.trip("STORAGE_UNAVAILABLE")).rejects.toMatchObject(
            { code: "OPERATION_DENY_UNCERTAIN" },
          );
        }
        NativeControlFaultGate.fault("NONE");
        const protectedState = await owner.fixture.repository.readCurrent();
        expect(protectedState.faultLatched).toBe(true);
        expect(protectedState.enforcedMode).toBe("READ_ONLY");
        await expect(
          owner.admission.run("MEDIA_WRITE", async () => true),
        ).rejects.toBeInstanceOf(ControlAdmissionError);
        const child = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "tests/integration/fixtures/phase11-marker-observer.ts",
          ],
          {
            env: { ...process.env, ...owner.fixture.env },
            encoding: "utf8",
            timeout: 15_000,
          },
        );
        expect(child.status).toBe(0);
        expect(child.stdout.trim()).toBe("FRESH_PROCESS_BOOTSTRAP_PROTECTED");
        const media = await owner.withResources(async (resources) => {
          if (resources.capability.state === "UNAVAILABLE")
            throw Error("OWNED_MEDIA_ROOT_REQUIRED");
          return {
            path: resources.capability.root.canonicalPath,
            marker: resources.capability.root.markerId,
          };
        });
        await owner.releaseProtectedForApiRestart();
        expect(
          (await new MySqlSystemRunRepository(db.pool).observeCurrent())?.phase,
        ).not.toBe("CLEAN");
        api = await restartBuiltControlApi(owner.fixture, media);
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
        const write = () =>
          fetch(api!.base + "/api/v1/albums", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              familyId: owner!.fixture.syntheticIdentity.familyId,
              name: `synthetic-${boundary}`,
              visibility: "FAMILY",
            }),
          });
        expect((await write()).status).toBe(503);
        await owner.fixture.recheck();
        const recovered = await owner.fixture.repository.readCurrent();
        expect(recovered.transitionState).toBe("STABLE");
        expect(recovered.enforcedMode).toBe("READ_ONLY");
        const s = await owner.fixture.gate.acquire("S");
        try {
          expect(s.readDeny()).toBeNull();
        } finally {
          s.close();
        }
        expect((await write()).status).toBe(503);
        await owner.fixture.request("NORMAL");
        const created = await write();
        expect(created.status).toBe(201);
        const albumId = (await created.json()).id;
        await owner.fixture.request("READ_ONLY");
        await api.stop();
        api = undefined;
        await db.pool.query("DELETE FROM albums WHERE id=? AND family_id=?", [
          albumId,
          owner.fixture.syntheticIdentity.familyId,
        ]);
        evidence.push({
          boundary,
          uncertainDurabilityProtected: true,
          restartedBuiltApiDenied: true,
          oldOwnerDrainCloseBeforeRestart: true,
          freshProcessBootstrapProtected: true,
          freshOwnerRecheckReadOnly: true,
          explicitResumeRequired: true,
        });
        await owner.cleanupReleasedOwner();
        owner = undefined;
      }, 90_000);
  },
);
