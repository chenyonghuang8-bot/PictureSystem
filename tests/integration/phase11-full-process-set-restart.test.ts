import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect } from "vitest";
import {
  createDatabase,
  MySqlSystemRunRepository,
  type RowDataPacket,
} from "../../packages/db/src/index.js";
import { InProcessControlOwner } from "../helpers/in-process-control-owner.js";
import { restartBuiltFullProcessSet } from "../helpers/restart-built-full-process-set.js";
if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");
describe.sequential(
  "R1 actual API DERIVATIVE METADATA complete process-set CLEAN",
  () => {
    for (const mode of ["NORMAL", "READ_ONLY", "MAINTENANCE"] as const)
      it(`all actual members close and a new complete set automatically preserves ${mode}`, async () => {
        const db = createDatabase(process.env.DATABASE_URL!);
        let owner: InProcessControlOwner | undefined,
          set:
            Awaited<ReturnType<typeof restartBuiltFullProcessSet>> | undefined,
          albumId: string | undefined;
        try {
          owner = await InProcessControlOwner.start(db.pool, []);
          const h = owner.fixture,
            runs = new MySqlSystemRunRepository(db.pool);
          const media = await owner.withResources(async (r) => {
            if (r.capability.state === "UNAVAILABLE")
              throw Error("ACTUAL_ROOT_REQUIRED");
            return {
              path: r.capability.root.canonicalPath,
              marker: r.capability.root.markerId,
            };
          });
          await owner.releaseForApiRestart();
          set = await restartBuiltFullProcessSet(h, media);
          await h.recheck();
          if (mode !== "READ_ONLY") await h.request(mode);
          const before = await runs.observeCurrent();
          expect(before?.phase).toBe("ACTIVE");
          await set.stop();
          set = undefined;
          expect((await runs.observeCurrent())?.phase).toBe("CLEAN");
          const [members] = await db.pool.query<RowDataPacket[]>(
            "SELECT role,state,ack_operation_id FROM system_control_run_members WHERE run_id=? ORDER BY role",
            [before!.id],
          );
          expect(members.map((m) => m.role)).toEqual([
            "API",
            "DERIVATIVE",
            "METADATA",
          ]);
          expect(
            members.every(
              (m) => m.state === "CLEAN_CLOSED" && m.ack_operation_id,
            ),
          ).toBe(true);
          set = await restartBuiltFullProcessSet(h, media);
          const end = Date.now() + 15000;
          while ((await runs.observeCurrent())?.phase !== "ACTIVE") {
            if (Date.now() > end)
              throw Error("FULL_SET_AUTOMATIC_ACTIVATION_UNCONFIRMED");
            await delay(100);
          }
          const after = await runs.observeCurrent();
          expect(Boolean(after?.automatic)).toBe(true);
          expect(after?.predecessor_id).toBe(before?.id);
          expect((await h.repository.readCurrent()).enforcedMode).toBe(mode);
          const login = await fetch(set.base + "/api/v1/auth/android/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              username: h.syntheticIdentity.username,
              password: "synthetic-in-process-control-password",
            }),
          });
          expect(login.status).toBe(200);
          const token = (await login.json()).token;
          const response = await fetch(set.base + "/api/v1/albums", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              familyId: h.syntheticIdentity.familyId,
              name: "synthetic-full-set-clean",
              visibility: "FAMILY",
            }),
          });
          expect(response.status).toBe(mode === "NORMAL" ? 201 : 503);
          if (response.status === 201) albumId = (await response.json()).id;
        } finally {
          if (set && owner) {
            try {
              await owner.fixture.request("READ_ONLY");
            } finally {
              await set.stop();
            }
          }
          if (albumId && owner)
            await db.pool.query(
              "DELETE FROM albums WHERE id=? AND family_id=? AND name='synthetic-full-set-clean'",
              [albumId, owner.fixture.syntheticIdentity.familyId],
            );
          if (owner) {
            if (owner.owner.resources.isAvailable())
              await owner.close({ recheck: true });
            else await owner.cleanupReleasedOwner();
          }
          await db.pool.end();
        }
      }, 120000);
    it("settles actual queued metadata READY after STOPPING without a false health latch", async () => {
      const db = createDatabase(process.env.DATABASE_URL!);
      let owner: InProcessControlOwner | undefined,
        set: Awaited<ReturnType<typeof restartBuiltFullProcessSet>> | undefined;
      try {
        owner = await InProcessControlOwner.start(db.pool, []);
        const h = owner.fixture,
          runs = new MySqlSystemRunRepository(db.pool);
        const media = await owner.withResources(async (r) => {
          if (r.capability.state === "UNAVAILABLE")
            throw Error("ACTUAL_ROOT_REQUIRED");
          return {
            path: r.capability.root.canonicalPath,
            marker: r.capability.root.markerId,
          };
        });
        await owner.releaseForApiRestart();
        set = await restartBuiltFullProcessSet(h, media, {
          pauseReadyHeartbeat: true,
        });
        const rechecked = h.recheck();
        void rechecked.catch(() => {});
        await set.waitRecoveryReturnPaused();
        await set.waitReadyHeartbeatPaused();
        set.resumeRecoveryReturn();
        await rechecked;
        expect((await runs.observeCurrent())?.phase).toBe("ACTIVE");
        const stopped = set.stop();
        void stopped.catch(() => {});
        const end = Date.now() + 10000;
        while ((await runs.observeCurrent())?.phase !== "STOPPING") {
          if (Date.now() > end) throw Error("ACTUAL_STOPPING_NOT_OBSERVED");
          await delay(50);
        }
        set.resumeReadyHeartbeat();
        await set.waitStoppingRecordPaused();
        const [unsettled] = await db.pool.query<RowDataPacket[]>(
          "SELECT state,ack_operation_id FROM system_control_run_members WHERE run_id=? AND role='METADATA'",
          [(await runs.observeCurrent())!.id],
        );
        expect(unsettled[0]!.state).toBe("READY");
        expect(unsettled[0]!.ack_operation_id).toBeNull();
        expect((await runs.observeCurrent())?.phase).toBe("STOPPING");
        set.resumeStoppingRecord();
        await stopped;
        set = undefined;
        expect((await runs.observeCurrent())?.phase).toBe("CLEAN");
        expect((await h.repository.readCurrent()).faultLatched).toBe(false);
        const [members] = await db.pool.query<RowDataPacket[]>(
          "SELECT role,state,ack_operation_id FROM system_control_run_members WHERE run_id=? ORDER BY role",
          [(await runs.observeCurrent())!.id],
        );
        expect(members.map((m) => m.role)).toEqual([
          "API",
          "DERIVATIVE",
          "METADATA",
        ]);
        expect(
          members.every(
            (m) => m.state === "CLEAN_CLOSED" && m.ack_operation_id,
          ),
        ).toBe(true);
      } finally {
        if (set) {
          set.resumeRecoveryReturn();
          set.resumeReadyHeartbeat();
          set.resumeStoppingRecord();
          await set.stop();
        }
        if (owner) {
          if (owner.owner.resources.isAvailable())
            await owner.close({ recheck: true });
          else await owner.cleanupReleasedOwner();
        }
        await db.pool.end();
      }
    }, 120000);
  },
);
